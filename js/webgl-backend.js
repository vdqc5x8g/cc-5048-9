// WebGL2 图形后端适配器：与 js/cpu-backend.js 同一接口，供帧池/重放/核对模块共用。
// 纹理原点为 bottom-left（GL 约定），与 CPU 后端的 top-left 各自在 descriptor 声明；
// 重投影着色器按 bottom-left UV 工作，原点差异不靠中心像素掩盖。
//
// 关键迁移点：
//   - 颜色纹理（环形槽 FBO）+ 生成朝向 + 呈现新姿态由帧令牌显式关联，令牌带代际
//   - 槽复用时重建 glSync 栅栏并推进代际；旧令牌取纹理被显式拒绝
//   - 手动闸门不阻塞 GPU，只控制 JS 侧是否放行，由重投影视窗单步按钮逐个放行

import { createScene, createProgram, createFullscreenQuad } from './scene.js';
import { readAllMarkers, readSeqStrip, markerIsInvalid, PATCH_CELLS, CELL_PX } from './markers.js';

const MARKER_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 角标覆盖着色器：在已渲染场景帧四角叠加不对称标识。
// 角基色、L 形条纹、数据格（眼别 1 位 + 角编号 2 位）与 markers.js 逐格对应。
const MARKER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uTexel;
uniform int uEye;
uniform int uCorner;
uniform float uPatchPxF;
uniform float uMargin;
out vec4 outColor;
vec3 cornerBase(int c) {
  if (c == 0) return vec3(214, 62, 58) / 255.0;
  if (c == 1) return vec3(224, 168, 38) / 255.0;
  if (c == 2) return vec3(46, 158, 96) / 255.0;
  return vec3(64, 118, 220) / 255.0;
}
void main() {
  vec2 px = vUV / uTexel; // 像素坐标，原点 bottom-left
  vec2 origin;
  if (uCorner == 0) origin = vec2(uMargin, uMargin);
  else if (uCorner == 1) origin = vec2(1.0/uTexel.x - uMargin - uPatchPxF, uMargin);
  else if (uCorner == 2) origin = vec2(1.0/uTexel.x - uMargin - uPatchPxF,
                                       1.0/uTexel.y - uMargin - uPatchPxF);
  else origin = vec2(uMargin, 1.0/uTexel.y - uMargin - uPatchPxF);
  vec2 local = px - origin;
  if (local.x < 0.0 || local.y < 0.0 || local.x >= uPatchPxF || local.y >= uPatchPxF) discard;
  float cell = float(${CELL_PX});
  vec2 grid = floor(local / cell);
  bool topEdge = (uCorner == 0 || uCorner == 1);
  bool leftEdge = (uCorner == 0 || uCorner == 3);
  bool edgeRow = topEdge ? grid.y == float(${PATCH_CELLS - 1}) : grid.y == 0.0;
  bool edgeCol = leftEdge ? grid.x == 0.0 : grid.x == float(${PATCH_CELLS - 1});
  if (edgeRow || edgeCol) { outColor = vec4(vec3(18, 18, 22) / 255.0, 1.0); return; }
  int innerIdx = int(grid.y - 1.0) * 4 + int(grid.x - 1.0);
  vec3 col = cornerBase(uCorner);
  if (innerIdx < 3) {
    int code = (uEye & 1) | ((uCorner & 3) << 1);
    int b = (code >> innerIdx) & 1;
    col = b == 1 ? vec3(245, 245, 245) / 255.0 : vec3(28, 30, 36) / 255.0;
  }
  outColor = vec4(col, 1.0);
}`;

// 帧号条（bottom-left 坐标下位于底边中部）：起始亮格 + 10 位（LSB 在左）+ 结束暗格
const SEQ_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uTexel;
uniform int uSeq;
out vec4 outColor;
void main() {
  float cell = float(${CELL_PX});
  int totalCells = 12;
  float stripW = cell * float(totalCells);
  float x0 = floor((1.0/uTexel.x - stripW) * 0.5);
  float stripH = cell * 2.0;
  float y0 = 2.0;
  vec2 px = vUV / uTexel;
  if (px.x < x0 || px.x >= x0 + stripW || px.y < y0 || px.y >= y0 + stripH) discard;
  int idx = int(floor((px.x - x0) / cell));
  vec3 col;
  if (idx == 0) col = vec3(245, 245, 245) / 255.0;
  else if (idx == 11) col = vec3(28, 30, 36) / 255.0;
  else col = ((uSeq >> (idx - 1)) & 1) == 1 ? vec3(245,245,245)/255.0 : vec3(28,30,36)/255.0;
  outColor = vec4(col, 1.0);
}`;

export class SlotRecycledError extends Error {
  constructor(token, slotGeneration) {
    super(`纹理槽 ${token.slot} 已被帧 #${token.seq} 之后的渲染复用（代际 ${token.generation} → ${slotGeneration}）；不能把当前槽内容当作历史图像`);
    this.name = 'SlotRecycledError';
  }
}

export function createWebglBackend(gl, options = {}) {
  const width = options.width;
  const height = options.height;
  const slotCount = options.slotCount ?? 3;
  const fovYRad = options.fovYRad;
  const scene = createScene(gl);
  const markerProg = createProgram(gl, MARKER_VS, MARKER_FS);
  const seqProg = createProgram(gl, MARKER_VS, SEQ_FS);
  const quad = createFullscreenQuad(gl);
  const uMarker = {
    texel: gl.getUniformLocation(markerProg, 'uTexel'),
    eye: gl.getUniformLocation(markerProg, 'uEye'),
    corner: gl.getUniformLocation(markerProg, 'uCorner'),
    patch: gl.getUniformLocation(markerProg, 'uPatchPxF'),
    margin: gl.getUniformLocation(markerProg, 'uMargin'),
  };
  const uSeq = {
    texel: gl.getUniformLocation(seqProg, 'uTexel'),
    seq: gl.getUniformLocation(seqProg, 'uSeq'),
  };

  // 每槽含左右眼两个 FBO 纹理（与 CPU 后端 slot.eyes[0|1] 对应）
  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    const eyes = {};
    for (const eye of [0, 1]) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const rbo = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbo);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('WebGL 后端帧缓冲不完整');
      }
      eyes[eye] = { fbo, tex, rbo };
    }
    slots.push({ index: i, generation: 0, eyes, ownerSeq: null });
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  let nextGeneration = 1;
  const fences = new Map();
  const gateMode = { current: options.gateMode ?? 'auto' };
  let flipMode = options.flipMode ?? 0;

  function slotOfToken(token) {
    const slot = slots[token.slot];
    if (!slot || slot.generation !== token.generation) throw new SlotRecycledError(token, slot?.generation ?? -1);
    return slot;
  }

  function drawOverlay(fbo, eye, seq) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.bindVertexArray(quad);
    gl.useProgram(markerProg);
    gl.uniform2f(uMarker.texel, 1 / width, 1 / height);
    gl.uniform1f(uMarker.patch, PATCH_CELLS * CELL_PX);
    gl.uniform1f(uMarker.margin, 2);
    gl.uniform1i(uMarker.eye, eye);
    for (let c = 0; c < 4; c++) {
      gl.uniform1i(uMarker.corner, c);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(seqProg);
    gl.uniform2f(uSeq.texel, 1 / width, 1 / height);
    gl.uniform1i(uSeq.seq, seq & 1023);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  return {
    descriptor: { backend: 'webgl2', textureOrigin: 'bottom-left', width, height, slotCount, fovYRad, aspect: width / height },
    scene,

    setGateMode(mode) { gateMode.current = mode; },
    setFlipMode(mode) { flipMode = mode; },
    setEdgeMode() { /* 边缘模式由重投影管线 uniform 处理 */ },

    // drawScene(fbo, quat, w, h) 由调用方提供（复用现有场景着色器与 MVP 约定）
    renderFrame(frameInfo) {
      const seq = frameInfo.seq;
      const slot = slots[seq % slotCount];
      slot.generation = nextGeneration++;
      slot.ownerSeq = seq;
      for (const eye of [0, 1]) {
        const target = slot.eyes[eye];
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, width, height);
        gl.enable(gl.DEPTH_TEST);
        gl.clearColor(0.02, 0.03, 0.05, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        options.drawScene(target.fbo, frameInfo.quats[eye], width, height);
        drawOverlay(target.fbo, eye, seq);
      }
      gl.flush();
      const glSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      fences.set(seq, {
        glSync,
        manuallyOpen: gateMode.current === 'auto',
        slot: slot.index,
        generation: slot.generation,
      });
      return {
        backend: 'webgl2',
        seq,
        slot: slot.index,
        generation: slot.generation,
        tSampleMs: frameInfo.tSampleMs,
        tRenderMs: frameInfo.tRenderMs,
        quats: { 0: [...frameInfo.quats[0]], 1: [...frameInfo.quats[1]] },
      };
    },

    isFenceSignaled(seq) {
      const f = fences.get(seq);
      if (!f) return false;
      if (f.manuallyOpen) return true;
      const status = gl.clientWaitSync(f.glSync, 0, 0);
      return status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED;
    },

    // 手动闸门单步放行（不阻塞 GPU，只放开 JS 侧等待）
    releaseFence(seq) {
      const f = fences.get(seq);
      if (f) f.manuallyOpen = true;
    },

    // wait 策略真正需要取纹理时阻塞等待 GPU 完成
    waitFence(seq) {
      const f = fences.get(seq);
      if (!f) return;
      gl.clientWaitSync(f.glSync, gl.SYNC_FLUSH_COMMANDS_BIT, 1e7);
      f.manuallyOpen = true;
    },

    textureOf(token, eye) {
      return slotOfToken(token).eyes[eye].tex;
    },

    // 回读 RGBA（bottom-left 行序），代际不符即拒绝
    readPixels(token, eye) {
      const slot = slotOfToken(token);
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.eyes[eye].fbo);
      const buf = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return buf;
    },

    // 回读缓冲是 bottom-left 行序，垂直翻转后复用 markers.js（top-left）读取
    readMarkers(pixels) {
      const flipped = new Uint8ClampedArray(pixels.length);
      for (let y = 0; y < height; y++) {
        flipped.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      }
      return readAllMarkers(flipped, width, height);
    },

    readSeq(pixels) {
      const flipped = new Uint8ClampedArray(pixels.length);
      for (let y = 0; y < height; y++) {
        flipped.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      }
      return readSeqStrip(flipped, width, height);
    },

    markerInvalid(pixels, screenCorner) {
      const flipped = new Uint8ClampedArray(pixels.length);
      for (let y = 0; y < height; y++) {
        flipped.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      }
      return markerIsInvalid(flipped, width, height, screenCorner);
    },

    validateToken(token) { slotOfToken(token); },
    getFlipMode() { return flipMode; },
  };
}
