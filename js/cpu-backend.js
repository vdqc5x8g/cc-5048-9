// CPU 软件图形后端：与 WebGL 适配器同一接口，可在 Node 无头环境运行。
// 用途：迁移核对、最小重放与翻转诊断都不依赖浏览器/GPU，
// 重投影射线数学与 js/reproject.js 的 GLSL 逐式对应。
//
// 纹理原点约定：CPU 缓冲按图像习惯 top-left 行序（行 0 在顶部），
// 重投影采样时显式换算 v；WebGL 后端为 bottom-left，适配器各自声明，
// 杜绝靠“中心像素碰巧一致”掩盖原点差异。

import { quatRotate, deg2rad } from './math3d.js';
import { stampFrame, readAllMarkers, readSeqStrip, markerIsInvalid } from './markers.js';

export const FLIP = Object.freeze({ NONE: 0, TEX_ORIGIN: 1, MATRIX: 2 });

export class SlotRecycledError extends Error {
  constructor(token, slotGeneration) {
    super(`纹理槽 ${token.slot} 已被帧 #${token.seq} 之后的渲染复用（代际 ${token.generation} → ${slotGeneration}）；不能把当前槽内容当作历史图像`);
    this.name = 'SlotRecycledError';
    this.tokenSeq = token.seq;
    this.slot = token.slot;
  }
}

function makeEyeBuffers(width, height) {
  return {
    0: new Uint8ClampedArray(width * height * 4),
    1: new Uint8ClampedArray(width * height * 4),
  };
}

// 确定性简易场景：射线求交地面网格 + 距离雾，供重投影后的落位肉眼/数值核对。
function shadeScene(pixels, width, height, quat, fovYRad, aspect) {
  const tanHalf = Math.tan(fovYRad / 2);
  const EYE_Y = -1.6;
  for (let py = 0; py < height; py++) {
    const ndcY = 1 - ((py + 0.5) / height) * 2; // top-left 行序 → GL 风格 y 向上
    for (let px = 0; px < width; px++) {
      const ndcX = ((px + 0.5) / width) * 2 - 1;
      const cam = [ndcX * aspect * tanHalf, ndcY * tanHalf, -1];
      const [wx, wy, wz] = quatRotate(quat, cam);
      const o = (py * width + px) * 4;
      // 天空渐变
      let r = 12 + ndcY * 8, g = 18 + ndcY * 10, b = 30 + ndcY * 14;
      if (wy < -1e-6) {
        const t = EYE_Y / wy;
        const gx = wx * t, gz = wz * t;
        if (Math.abs(gx) <= 10 && Math.abs(gz) <= 10) {
          const fx = Math.abs(gx - Math.round(gx));
          const fz = Math.abs(gz - Math.round(gz));
          const lineW = 0.035;
          const onLine = fx < lineW || fz < lineW;
          const fog = Math.min(1, t / 22);
          if (onLine) {
            r = 92 * (1 - fog) + 14 * fog;
            g = 140 * (1 - fog) + 20 * fog;
            b = 184 * (1 - fog) + 28 * fog;
          } else {
            r = 26 * (1 - fog) + 10 * fog;
            g = 30 * (1 - fog) + 12 * fog;
            b = 38 * (1 - fog) + 16 * fog;
          }
        }
      }
      pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = 255;
    }
  }
}

export function createCpuBackend(options = {}) {
  const width = options.width ?? 160;
  const height = options.height ?? 120;
  const slotCount = options.slotCount ?? 3;
  const fovYRad = options.fovYRad ?? deg2rad(72);
  const aspect = width / height;
  const gateMode = { current: options.gateMode ?? 'auto' }; // 'auto' | 'manual'
  const state = {
    slots: [],
    fences: new Map(), // seq -> {signaled}
    nextGeneration: 1,
    flipMode: options.flipMode ?? FLIP.NONE,
    edgeMode: options.edgeMode ?? 0,
  };
  for (let i = 0; i < slotCount; i++) {
    state.slots.push({ index: i, generation: 0, ownerSeq: null, eyes: makeEyeBuffers(width, height) });
  }

  function slotOfToken(token) {
    const slot = state.slots[token.slot];
    if (!slot || slot.generation !== token.generation) throw new SlotRecycledError(token, slot?.generation ?? -1);
    return slot;
  }

  return {
    descriptor: { backend: 'cpu', textureOrigin: 'top-left', width, height, slotCount, fovYRad, aspect },

    setGateMode(mode) { gateMode.current = mode; },
    setFlipMode(mode) { state.flipMode = mode; },
    setEdgeMode(mode) { state.edgeMode = mode; },

    // 渲染一帧（双眼），写入环形槽并返回带代际的帧令牌；手动闸门下栅栏默认不放行
    renderFrame(frameInfo) {
      const seq = frameInfo.seq;
      const slot = state.slots[seq % slotCount];
      slot.generation = state.nextGeneration++;
      slot.ownerSeq = seq;
      for (const eye of [0, 1]) {
        const quat = frameInfo.quats[eye];
        shadeScene(slot.eyes[eye], width, height, quat, fovYRad, aspect);
        stampFrame(slot.eyes[eye], width, height, eye, seq);
      }
      state.fences.set(seq, { signaled: gateMode.current === 'auto', slot: slot.index, generation: slot.generation });
      return {
        backend: 'cpu',
        seq,
        slot: slot.index,
        generation: slot.generation,
        tSampleMs: frameInfo.tSampleMs,
        tRenderMs: frameInfo.tRenderMs,
        quats: { 0: [...frameInfo.quats[0]], 1: [...frameInfo.quats[1]] },
      };
    },

    isFenceSignaled(seq) {
      return state.fences.get(seq)?.signaled ?? false;
    },
    releaseFence(seq) {
      const f = state.fences.get(seq);
      if (f) f.signaled = true;
    },

    // 直接拷贝（未修正延迟画面），flipMode 用于故障注入
    blit(token, eye, flipMode = state.flipMode) {
      const slot = slotOfToken(token);
      const src = slot.eyes[eye];
      const out = new Uint8ClampedArray(src.length);
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          let sx = px, sy = py;
          if (flipMode === FLIP.TEX_ORIGIN) sy = height - 1 - py;
          if (flipMode === FLIP.MATRIX) sx = width - 1 - px;
          const so = (sy * width + sx) * 4;
          const o = (py * width + px) * 4;
          out[o] = src[so]; out[o + 1] = src[so + 1]; out[o + 2] = src[so + 2]; out[o + 3] = src[so + 3];
        }
      }
      return out;
    },

    // 软件重投影：与 reproject.js GLSL 同公式；返回新缓冲，越界 alpha=0
    reproject(token, eye, presentQuat, deltaQuat, opts = {}) {
      const slot = slotOfToken(token);
      const src = slot.eyes[eye];
      const flipMode = opts.flipMode ?? state.flipMode;
      const edgeMode = opts.edgeMode ?? state.edgeMode;
      const tanHalf = Math.tan(fovYRad / 2);
      const eps = 1.5e-3;
      const out = new Uint8ClampedArray(width * height * 4);

      for (let py = 0; py < height; py++) {
        // 缓冲行序为 top-left，而 GLSL vUV 原点在 bottom-left：先还原 GL 风格 vUV
        const vUvY = 1 - ((py + 0.5) / height);
        const ndcY = vUvY * 2 - 1;
        for (let px = 0; px < width; px++) {
          let ndcX = ((px + 0.5) / width) * 2 - 1;
          if (flipMode === FLIP.MATRIX) ndcX = -ndcX; // 矩阵符号翻转注入
          const rayPresent = [ndcX * aspect * tanHalf, ndcY * tanHalf, -1];
          const [rox, roy, roz] = quatRotate(deltaQuat, rayPresent);
          let oldNdcX = rox / (aspect * tanHalf * -roz);
          let oldNdcY = roy / (tanHalf * -roz);
          // 与 GLSL 完全一致：u/v 均为 bottom-left 原点的纹理坐标
          let u = oldNdcX * 0.5 + 0.5;
          let v = oldNdcY * 0.5 + 0.5;
          if (flipMode === FLIP.TEX_ORIGIN) v = 1 - v; // 纹理原点翻转注入

          const inside = u >= eps && u <= 1 - eps && v >= eps && v <= 1 - eps;
          const du = 1 / width, dv = 1 / height;
          let boundary = false;
          for (let ddx = -du; ddx <= du; ddx += du) {
            for (let ddy = -dv; ddy <= dv; ddy += dv) {
              const uu = u + ddx, vv = v + ddy;
              if (uu < 0 || uu > 1 || vv < 0 || vv > 1) boundary = true;
            }
          }
          const o = (py * width + px) * 4;
          if (inside) {
            // top-left 行序：纹理行 = (1-v)*H；floor 与 GL nearest 采样约定一致
            const tx = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
            const ty = Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height)));
            const so = (ty * width + tx) * 4;
            out[o] = src[so]; out[o + 1] = src[so + 1]; out[o + 2] = src[so + 2];
            if (boundary) { out[o] = 232; out[o + 1] = 196; out[o + 2] = 89; }
            out[o + 3] = 255;
            continue;
          }
          if (edgeMode === 1) {
            const cu = Math.min(1, Math.max(0, u));
            const cv = Math.min(1, Math.max(0, v));
            const tx = Math.floor(cu * width), ty = Math.floor((1 - cv) * height);
            const so = (ty * width + tx) * 4;
            out[o] = src[so]; out[o + 1] = src[so + 1]; out[o + 2] = src[so + 2];
            if (boundary) { out[o] = 232; out[o + 1] = 196; out[o + 2] = 89; }
            out[o + 3] = 0;
          } else {
            const gx = Math.floor(px / 8), gy = Math.floor(py / 8);
            const stripe = (gx + gy) % 2;
            out[o] = stripe ? 140 : 31;
            out[o + 1] = stripe ? 41 : 13;
            out[o + 2] = stripe ? 51 : 15;
            if (boundary) { out[o] = 232; out[o + 1] = 196; out[o + 2] = 89; }
            out[o + 3] = 0;
          }
        }
      }
      return out;
    },

    // 读回辅助（全部走标记模块，保证两后端核对口径一致）
    readMarkers(pixels) { return readAllMarkers(pixels, width, height); },
    readSeq(pixels) { return readSeqStrip(pixels, width, height); },
    markerInvalid(pixels, screenCorner) { return markerIsInvalid(pixels, width, height, screenCorner); },
    validateToken(token) { slotOfToken(token); },
  };
}
