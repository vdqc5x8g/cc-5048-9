// 帧池：把“提交的颜色纹理、生成时朝向、显示前新姿态”显式绑成帧令牌。
// 环形槽复用同一批纹理时，只凭帧号引用槽是危险的——槽内容会被后续渲染覆盖。
// 因此每个令牌带代际（generation）：槽复用时代际自增，旧令牌再取纹理必被拒绝，
// 而不是静默读到当前槽内容（那会把“现在的画面”当成“历史图像”）。
//
// 栅栏闸门：
//   auto   —— 渲染完成即放行（与实时演示一致）
//   manual —— 栅栏保持等待，由重投影视窗的单步按钮逐个放行迟到栅栏
// 呈现策略：
//   wait    —— 目标帧栅栏未放行则呈现挂起（画面保持上一帧，不换纹理）
//   discard —— 丢弃姿态过时的未就绪帧，回退到最近一个已放行的帧

import { quatNormalize, quatMul, quatConjugate } from './math3d.js';

export class FrameNotReadyError extends Error {
  constructor(seq, policy) {
    super(`帧 #${seq} 的栅栏尚未放行（策略=${policy}）`);
    this.name = 'FrameNotReadyError';
    this.seq = seq;
    this.policy = policy;
  }
}

export function createFrameRing(backend, options = {}) {
  const slots = options.slotCount ?? backend.descriptor.slotCount ?? 3;
  let renderSeq = 0;
  let latestToken = null;
  const bySeq = new Map();

  // 提交一帧：颜色纹理（后端内部槽）+ 采样朝向四元数（双眼）显式关联
  function submit(frameInfo) {
    const token = backend.renderFrame({
      seq: renderSeq,
      tSampleMs: frameInfo.tSampleMs,
      tRenderMs: frameInfo.tRenderMs,
      quats: frameInfo.quats,
    });
    token.slotCount = slots;
    bySeq.set(renderSeq, token);
    latestToken = token;
    renderSeq++;
    return token;
  }

  function isReady(seq) {
    return backend.isFenceSignaled(seq);
  }

  // 单步放行一个迟到栅栏（manual 闸门用）
  function releaseNextFence() {
    for (const seq of bySeq.keys()) {
      if (!backend.isFenceSignaled(seq)) {
        backend.releaseFence(seq);
        return seq;
      }
    }
    return null;
  }

  function pendingSeqs() {
    return [...bySeq.keys()].filter((s) => !backend.isFenceSignaled(s));
  }

  // 按 t_r ≤ t_p − latency 选目标帧，再按策略处理未就绪栅栏
  function acquireForPresent(presentMs, latencyMs, policy = 'wait') {
    const wanted = presentMs - latencyMs;
    let target = null;
    for (const token of bySeq.values()) {
      if (token.tRenderMs <= wanted) target = token;
      else break;
    }
    target = target || [...bySeq.values()][0];
    if (!target) return null;

    if (backend.isFenceSignaled(target.seq)) {
      return { status: 'ready', token: target, waited: false, discarded: [] };
    }

    if (policy === 'discard') {
      const discarded = [target.seq];
      let fallback = target;
      // 向更早的帧找已放行的（姿态更旧，但纹理确实可用）
      const ordered = [...bySeq.values()].filter((t) => t.tRenderMs < target.tRenderMs).reverse();
      for (const t of ordered) {
        if (backend.isFenceSignaled(t.seq)) {
          return { status: 'discarded', token: t, waited: false, discarded };
        }
        discarded.push(t.seq);
      }
      // 一个就绪帧都没有：呈现挂起
      throw new FrameNotReadyError(target.seq, 'discard');
    }

    // wait：显式挂起，调用方保持上一帧，不得用当前槽内容顶替
    throw new FrameNotReadyError(target.seq, 'wait');
  }

  // 显示前的新姿态与生成时朝向显式配对，求 Δq = q_s^-1 · q_p（每只眼）
  function deltaFor(token, presentQuats) {
    const out = {};
    for (const eye of [0, 1]) {
      out[eye] = quatNormalize(quatMul(quatConjugate(token.quats[eye]), presentQuats[eye]));
    }
    return out;
  }

  function getToken(seq) {
    return bySeq.get(seq) ?? null;
  }

  // 令牌是否仍持有其原始槽（代际未被后续渲染推进）
  function isLive(token) {
    try {
      backend.validateToken(token);
      return true;
    } catch {
      return false;
    }
  }

  function reset() {
    renderSeq = 0;
    latestToken = null;
    bySeq.clear();
  }

  return {
    submit, acquireForPresent, deltaFor, releaseNextFence, pendingSeqs,
    isReady, getToken, isLive, reset, get latestToken() { return latestToken; },
    get slotCount() { return slots; },
  };
}

// ---------- 旧记录读取 ----------
// 旧工程记录可能只给帧号（frameNo），没有槽代际与显式纹理关联。
// 读取器把旧帧号映射到当前环形槽，并明确三种情形：
//   1) 令牌仍在且代际未变：补出代际，可安全取纹理
//   2) 令牌仍在表中但槽已被复用：标记 recycled，拒绝取当前槽内容
//   3) 帧已滚出历史：标记 evicted，历史图像不可恢复
export const LEGACY_RECORD_VERSION = 1;

export function readLegacyRecord(raw, ring) {
  const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const warnings = [];
  if (rec.version && rec.version > LEGACY_RECORD_VERSION) {
    throw new Error(`旧记录版本 ${rec.version} 高于读取器支持的 ${LEGACY_RECORD_VERSION}`);
  }
  if (!Number.isInteger(rec.frameNo)) {
    throw new Error('旧记录缺少整数 frameNo 字段');
  }
  const slot = rec.frameNo % ring.slotCount;
  const token = ring.getToken(rec.frameNo);

  if (!token) {
    warnings.push(`帧 #${rec.frameNo} 已滚出环形缓冲历史（槽 ${slot} 至少复用一轮），无法恢复其历史图像`);
    return { frameNo: rec.frameNo, slot, status: 'evicted', token: null, warnings };
  }
  if (token.slot !== slot) {
    warnings.push(`内部一致性错误：帧 #${rec.frameNo} 推算槽 ${slot} 与令牌槽 ${token.slot} 不符`);
  }
  if (!ring.isLive(token)) {
    warnings.push(
      `帧 #${rec.frameNo} 的槽 ${slot} 已被后续渲染复用（代际 ${token.generation} 已过期）；` +
      '当前槽内容是新帧图像，不得当作该帧历史图像'
    );
    return { frameNo: rec.frameNo, slot, status: 'recycled', token, warnings };
  }
  // 代际校验：后端真正取纹理时还会再核对一次代际
  return {
    frameNo: rec.frameNo,
    slot,
    generation: token.generation,
    status: 'mapped',
    token,
    tSampleMs: token.tSampleMs,
    tRenderMs: token.tRenderMs,
    warnings,
  };
}
