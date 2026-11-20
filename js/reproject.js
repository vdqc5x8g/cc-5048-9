// 迟到姿态修正（旋转重投影）着色器与渲染目标。
// 所有变换与主场景共用同一投影矩阵和同一右手坐标系。

import { createProgram, createFullscreenQuad } from './scene.js';

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUV);
}`;

// 重投影：对呈现时刻的每个像素，逆投影求相机空间射线，
// 用 Δq = q(t_s)^-1 · q(t_p) 把射线转回渲染时刻相机空间，再投影回旧纹理。
const REPROJECT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uOldTex;
uniform float uTanHalfFovY;   // tan(fovY/2)
uniform float uAspect;        // width / height
uniform vec4 uDeltaQuat;      // (x, y, z, w)
uniform int uEdgeMode;        // 0 = 斜纹标记, 1 = 边缘钳取
out vec4 outColor;

vec3 rotateVec(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + vec3(q.w * v));
}

void main() {
  // 1) 呈现帧像素 -> NDC(z=1，相机在原点，方向与深度无关) -> 相机空间射线
  vec2 ndc = vUV * 2.0 - 1.0;
  vec3 rayPresent = vec3(ndc.x * uAspect * uTanHalfFovY,
                         ndc.y * uTanHalfFovY,
                         -1.0);

  // 2) 旋转回渲染时刻相机空间
  vec3 rayOld = rotateVec(uDeltaQuat, rayPresent);

  // 3) 投影到旧帧的纹理坐标（透视投影，f/(-z)）
  vec2 oldNdc = vec2(rayOld.x / (uAspect * uTanHalfFovY * (-rayOld.z)),
                     rayOld.y / (uTanHalfFovY * (-rayOld.z)));
  vec2 oldUV = oldNdc * 0.5 + 0.5;

  float eps = 1.5e-3;
  bool inside = all(greaterThanEqual(oldUV, vec2(eps))) &&
                all(lessThanEqual(oldUV, vec2(1.0 - eps)));

  // 4) 边界检测：邻域越界即轮廓线（可用视野边界始终可见）
  vec2 texel = 1.0 / vec2(textureSize(uOldTex, 0));
  bool boundary = false;
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      vec2 sp = oldUV + vec2(float(dx) * texel.x, float(dy) * texel.y);
      if (any(lessThan(sp, vec2(0.0))) || any(greaterThan(sp, vec2(1.0)))) {
        boundary = true;
      }
    }
  }

  if (inside) {
    vec3 col = texture(uOldTex, oldUV).rgb;
    if (boundary) col = vec3(0.91, 0.77, 0.35); // 边界描线
    outColor = vec4(col, 1.0);
    return;
  }

  // 5) 越界区域：原帧没有任何可用样本，不能称为正确重建
  if (uEdgeMode == 1) {
    vec2 clampedUV = clamp(oldUV, vec2(0.0), vec2(1.0));
    vec3 col = texture(uOldTex, clampedUV).rgb;
    if (boundary) col = vec3(0.91, 0.77, 0.35);
    outColor = vec4(col, 0.0); // alpha=0 供指标统计识别越界
  } else {
    // 斜纹标记 + 暗色底
    vec2 g = gl_FragCoord.xy / 8.0;
    float stripe = step(0.5, fract(g.x + g.y));
    vec3 hatch = mix(vec3(0.12, 0.05, 0.06), vec3(0.55, 0.16, 0.20), stripe);
    if (boundary) hatch = vec3(0.91, 0.77, 0.35);
    outColor = vec4(hatch, 0.0);
  }
}`;

function createFBO(gl, width, height) {
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
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('帧缓冲不完整: 0x' + status.toString(16));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, rbo, width, height };
}

export function createReprojectPipeline(gl) {
  const blitProg = createProgram(gl, QUAD_VS, BLIT_FS);
  const reProg = createProgram(gl, QUAD_VS, REPROJECT_FS);
  const quad = createFullscreenQuad(gl);

  const uBlit = gl.getUniformLocation(blitProg, 'uTex');
  const uRep = {
    oldTex: gl.getUniformLocation(reProg, 'uOldTex'),
    tanHalfFovY: gl.getUniformLocation(reProg, 'uTanHalfFovY'),
    aspect: gl.getUniformLocation(reProg, 'uAspect'),
    deltaQuat: gl.getUniformLocation(reProg, 'uDeltaQuat'),
    edgeMode: gl.getUniformLocation(reProg, 'uEdgeMode'),
  };

  return {
    createTarget(width, height) {
      return createFBO(gl, width, height);
    },

    // 直接纹理拷贝（未经修正的延迟画面）
    blit(target, srcTex, viewW, viewH) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, viewW, viewH);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(blitProg);
      gl.bindVertexArray(quad);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(uBlit, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },

    // 迟到修正：旧纹理 + 姿态四元数增量 -> 重投影画面
    reproject(target, frameTex, deltaQuat, cam, edgeMode, viewW, viewH) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, viewW, viewH);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(reProg);
      gl.bindVertexArray(quad);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTex);
      gl.uniform1i(uRep.oldTex, 0);
      gl.uniform1f(uRep.tanHalfFovY, Math.tan(cam.fovYRad * 0.5));
      gl.uniform1f(uRep.aspect, cam.aspect);
      gl.uniform4fv(uRep.deltaQuat, deltaQuat);
      gl.uniform1i(uRep.edgeMode, edgeMode);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
  };
}
