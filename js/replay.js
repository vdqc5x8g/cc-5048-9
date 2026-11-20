// 含纹理复用的最小重放：只记录确定性事件与角标/帧号读回，不保存整幅纹理。
// 关键约束：重放时重新提交渲染、重新走环形槽与栅栏；旧令牌引用被复用槽时，
// 后端凭代际拒绝（SlotRecycledError），绝不把当前槽内容当作历史图像。
//
// 记录格式（version 2，旧版只含 frameNo 的记录由 frame-pool.readLegacyRecord 读取）：
// {
//   version: 2, backend, textureOrigin, width, height, slotCount, fovYDeg,
//   params: 轨迹参数, gateMode, policy,
//   renders:  [{seq, slot, generation, tSampleMs, tRenderMs, quats:{0,1}, markers:{0,1}, seqRead:{0,1}}],
//   presents: [{tPresentMs, targetSeq, status, eye, presentQuat, expectedSeq, edgeCorners:[...]}]
// }

export const REPLAY_VERSION = 2;

export function createReplayRecorder(backend, meta = {}) {
  const d = backend.descriptor;
  const replay = {
    version: REPLAY_VERSION,
    backend: d.backend,
    textureOrigin: d.textureOrigin,
    width: d.width,
    height: d.height,
    slotCount: d.slotCount,
    fovYDeg: Math.round((d.fovYRad * 180) / Math.PI),
    params: meta.params ?? null,
    gateMode: meta.gateMode ?? 'auto',
    policy: meta.policy ?? 'wait',
    renders: [],
    presents: [],
  };

  function recordRender(token, markerReadback) {
    replay.renders.push({
      seq: token.seq,
      slot: token.slot,
      generation: token.generation,
      tSampleMs: token.tSampleMs,
      tRenderMs: token.tRenderMs,
      quats: token.quats,
      markers: markerReadback?.markers ?? null,
      seqRead: markerReadback?.seqRead ?? null,
    });
  }

  function recordPresent(entry) {
    replay.presents.push(entry);
  }

  return {
    replay,
    recordRender,
    recordPresent,
    toJSON() { return JSON.stringify(replay, null, 2); },
  };
}

// 从 JSON 文本载入重放（做基本结构校验）
export function loadReplay(text) {
  const replay = typeof text === 'string' ? JSON.parse(text) : text;
  if (replay.version !== REPLAY_VERSION) {
    throw new Error(`重放版本 ${replay.version} 不被支持（期望 ${REPLAY_VERSION}）`);
  }
  if (!Array.isArray(replay.renders) || !Array.isArray(replay.presents)) {
    throw new Error('重放记录缺少 renders/presents 事件数组');
  }
  return replay;
}

// 代际断言：复放中引用的帧必须仍持有其原始槽代际
export function assertGenerationIntact(replay) {
  const lastOwner = new Map();
  for (const r of replay.renders) {
    const prev = lastOwner.get(r.slot);
    if (prev !== undefined && prev.generation >= r.generation) {
      throw new Error(`重放数据异常：槽 ${r.slot} 代际未随复用自增`);
    }
    lastOwner.set(r.slot, r);
  }
  for (const p of replay.presents) {
    if (p.targetSeq == null) continue;
    const render = replay.renders.find((r) => r.seq === p.targetSeq);
    if (!render) {
      throw new Error(`呈现事件引用了不存在的渲染帧 #${p.targetSeq}`);
    }
    const lastOnSlot = lastOwner.get(render.slot);
    if (lastOnSlot && lastOnSlot.seq !== render.seq) {
      throw new Error(
        `帧 #${render.seq} 的槽 ${render.slot} 已被帧 #${lastOnSlot.seq} 复用；` +
        '重放必须拒绝读取当前槽内容，不能把它当成该帧的历史图像'
      );
    }
  }
  return true;
}
