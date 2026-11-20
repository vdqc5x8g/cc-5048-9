// 迁移核对：角点屏幕落位、边界外无效区、实际呈现帧号、翻转定位与跨后端比对。
// 场景编排同时覆盖：
//   - 标号不同的两帧交叉完成（手动栅栏：帧 A 等待、帧 B 先放行）
//   - 快速转头（大 Δq 产生可见无效区）
//   - 环形槽复用（slotCount < 帧数），验证不把当前槽内容当历史图像

import { stateAt, DEFAULT_TRAJECTORY, TRIAD_TRAJECTORY } from './trajectory.js';
import { quatYawPitchRoll, quatNormalize, quatMul, quatConjugate, deg2rad } from './math3d.js';
import { createCpuBackend, FLIP, SlotRecycledError } from './cpu-backend.js';
import { createFrameRing, FrameNotReadyError, readLegacyRecord } from './frame-pool.js';
import { createReplayRecorder, loadReplay, assertGenerationIntact } from './replay.js';
import { CORNER, EYE, EYE_NAME, CORNER_NAME, diagnoseMarkers } from './markers.js';

const RENDER_INTERVAL_MS = 66;
const SAMPLE_TO_RENDER_MS = 5;
const EYE_YAW_OFFSET = deg2rad(2.2); // 双眼水平视差，保证左右眼纹理不同

function eyeQuats(baseQuat) {
  const qL = quatNormalize(quatMul(baseQuat, quatYawPitchRoll(-EYE_YAW_OFFSET, 0, 0)));
  const qR = quatNormalize(quatMul(baseQuat, quatYawPitchRoll(EYE_YAW_OFFSET, 0, 0)));
  return { 0: qL, 1: qR };
}

function presentQuatsAt(tSec, params) {
  return eyeQuats(stateAt(tSec, params).quat);
}

function submitNFrames(ring, count, startTRenderMs, params) {
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const tRenderMs = startTRenderMs + i * RENDER_INTERVAL_MS;
    const tSampleMs = tRenderMs - SAMPLE_TO_RENDER_MS;
    const base = stateAt(tSampleMs / 1000, params).quat;
    tokens.push(ring.submit({ tSampleMs, tRenderMs, quats: eyeQuats(base) }));
  }
  return tokens;
}

// 单帧双眼四角标记核对：
//   - 落在有效区的角标：眼别/角编号必须与物理角一致，帧号条必须等于呈现帧号
//   - 落在无效区的角标：alpha 必须为 0（边界外无效区核对），不参与身份比对
export function verifyFrameMarkers(backend, token, presentQuats, options = {}) {
  const results = [];
  for (const eye of [EYE.LEFT, EYE.RIGHT]) {
    const dq = quatNormalize(quatMul(quatConjugate(token.quats[eye]), presentQuats[eye]));
    const pixels = options.blit
      ? backend.blit(token, eye, options.flipMode ?? FLIP.NONE)
      : backend.reproject(token, eye, presentQuats[eye], dq, { flipMode: options.flipMode ?? FLIP.NONE });
    const markers = backend.readMarkers(pixels);
    const visible = [];
    const invalidCorners = [];
    for (const m of markers) {
      if (backend.markerInvalid(pixels, m.screenCorner)) invalidCorners.push(m.screenCorner);
      else visible.push(m);
    }
    const diag = diagnoseMarkers(visible, eye);
    const seqRead = backend.readSeq(pixels);
    results.push({
      eye,
      markers,
      visibleCorners: visible.map((m) => m.screenCorner),
      invalidCorners,
      markerOk: diag.ok,
      failures: diag.failures,
      seqRead,
      seqOk: seqRead === token.seq,
    });
  }
  return results;
}

// 交叉完成：帧 0 与帧 1（标号不同）在手动栅栏下乱序放行，
// 核对 wait / discard 两种策略给出不同且各自正确的可见结果。
// 调度机制本身用恒等重投影（Δq=0）核对四角身份与帧号，
// 避免把“转头导致的视野外无效区”与“栅栏等待/丢弃”两类问题混在一起。
export function scenarioInterleave(backendOptions = {}) {
  const backend = createCpuBackend({ ...backendOptions, gateMode: 'manual', slotCount: backendOptions.slotCount ?? 2 });
  const ring = createFrameRing(backend, { slotCount: backend.descriptor.slotCount });
  const params = DEFAULT_TRAJECTORY;
  const tokens = submitNFrames(ring, 3, 0, params);
  const tPresentMs = tokens[1].tRenderMs + 20;
  // 恒等呈现姿态 = 目标帧生成姿态：重投影应原样还原四个角标与帧号
  const identityQuats = { 0: [...tokens[1].quats[0]], 1: [...tokens[1].quats[1]] };

  const log = [];
  let waitOutcome;
  try {
    ring.acquireForPresent(tPresentMs, 0, 'wait');
    waitOutcome = '意外拿到帧';
  } catch (e) {
    log.push(`wait 策略：${e.message}`);
    waitOutcome = e instanceof FrameNotReadyError ? 'pending' : 'error';
  }

  // 先放行更晚的帧 1（交叉完成），帧 0 仍等待
  backend.releaseFence(tokens[1].seq);
  const discard = ring.acquireForPresent(tPresentMs, 0, 'discard');
  log.push(`discard 策略：目标帧 #${tokens[1].seq} 已放行，呈现帧 #${discard.token.seq}`);

  backend.releaseFence(tokens[0].seq);
  const afterRelease = ring.acquireForPresent(tPresentMs, 0, 'wait');
  const markers = verifyFrameMarkers(backend, afterRelease.token, identityQuats);
  log.push(`放行后 wait 策略：呈现帧 #${afterRelease.token.seq}，四角标识${markers.every((r) => r.markerOk) ? '全部正确' : '有误'}`);

  return {
    name: '交叉完成与迟到栅栏单步放行',
    waitOutcome,
    discardedFirst: discard.status === 'ready' || discard.status === 'discarded',
    presentedSeq: afterRelease.token.seq,
    markerResults: markers,
    log,
    pass: waitOutcome === 'pending'
      && discard.token.seq === tokens[1].seq
      && afterRelease.token.seq === tokens[1].seq
      && markers.every((r) => r.markerOk && r.seqOk && r.invalidCorners.length === 0),
  };
}

// 快速转头：选大角速度时刻呈现，核对无效区扩大、边界外标记 alpha=0、呈现帧号正确
export function scenarioFastTurn(backendOptions = {}, params = TRIAD_TRAJECTORY) {
  const backend = createCpuBackend({ ...backendOptions, gateMode: 'auto' });
  const ring = createFrameRing(backend, { slotCount: backend.descriptor.slotCount });
  // 渲染若干帧制造槽复用
  const tokens = submitNFrames(ring, backend.descriptor.slotCount + 3, 0, params);
  // 选一个角速度较大的呈现时刻（取扫描区间内 |ω| 最大点附近）
  let bestT = 0.3, bestOmega = -1;
  for (let t = 0.1; t < 2.5; t += 0.02) {
    const w = Math.abs(stateAt(t, params).yawRateDeg);
    if (w > bestOmega) { bestOmega = w; bestT = t; }
  }
  const tPresentMs = bestT * 1000;
  const pq = presentQuatsAt(bestT, params);
  const acquired = ring.acquireForPresent(tPresentMs, 100, 'wait');
  const token = acquired.token;
  const results = verifyFrameMarkers(backend, token, pq);
  const anyInvalid = results.some((r) => r.invalidCorners.length > 0);
  // 大角度转头后，呈现帧物理角的射线回查到源帧另一区域是重投影的正确行为，
  // 因此这里不要求角标“原角身份”，而要求：
  //   1) 无效区角标必须 alpha=0（边界外无效区核对）
  //   2) 可见角标读到的必须是真实编码（眼别/角编号取值合法，不是垃圾值）
  //   3) 帧号条可见时必须等于实际呈现帧号，落无效区时读 null
  const codesLegal = results.every((r) =>
    r.markers.every((m) => Number.isInteger(m.eye) && m.eye >= 0 && m.eye <= 1
      && Number.isInteger(m.corner) && m.corner >= 0 && m.corner <= 3));
  const seqChecks = results.map((r) => r.seqRead === null || r.seqRead === token.seq);
  return {
    name: '快速转头（无效区 + 帧号核对）',
    presentedSeq: token.seq,
    maxOmegaDegPerSec: bestOmega,
    markerResults: results,
    anyInvalidRegion: anyInvalid,
    codesLegal,
    pass: anyInvalid && codesLegal && seqChecks.every(Boolean),
  };
}

// 环形槽复用：旧令牌指向的槽被新帧占用后，再取纹理必须抛 SlotRecycledError
export function scenarioSlotReuse(backendOptions = {}) {
  const slotCount = backendOptions.slotCount ?? 2;
  const backend = createCpuBackend({ ...backendOptions, slotCount, gateMode: 'auto' });
  const ring = createFrameRing(backend, { slotCount });
  const tokens = submitNFrames(ring, slotCount + 2, 0, DEFAULT_TRAJECTORY);
  const stale = tokens[0]; // 其槽已被帧 slotCount 复用
  let rejected = false;
  let errorName = null;
  try {
    backend.blit(stale, EYE.LEFT);
  } catch (e) {
    rejected = true;
    errorName = e.name;
  }
  // 旧记录读取：只给 frameNo；令牌还在表中但槽已被复用，必须标 recycled
  const legacy = readLegacyRecord({ frameNo: stale.seq }, ring);
  return {
    name: '环形槽复用不读当前槽内容',
    staleSeq: stale.seq,
    rejected,
    errorName,
    legacyStatus: legacy.status,
    legacySafe: legacy.status === 'recycled' && legacy.token != null,
    pass: rejected && errorName === 'SlotRecycledError' && legacy.status === 'recycled',
  };
}

// 翻转注入：矩阵/纹理原点翻转时，报告必须指出哪只眼的哪个角先错。
// 用恒等姿态差做重投影，保证四个角标全部在有效区内——
// 这样翻转一定表现为角标身份错位，而不是被视野外无效区掩盖；
// 中心像素在恒等重投影下恰好不变，正说明不能靠中心像素核对。
export function scenarioFlipDiagnosis(flipMode, params = TRIAD_TRAJECTORY) {
  const backend = createCpuBackend({ gateMode: 'auto', flipMode: FLIP.NONE });
  const ring = createFrameRing(backend, { slotCount: backend.descriptor.slotCount });
  const tokens = submitNFrames(ring, 2, 0, params);
  const token = tokens[tokens.length - 1];
  const identityQuats = { 0: [...token.quats[0]], 1: [...token.quats[1]] };
  const results = verifyFrameMarkers(backend, token, identityQuats, { flipMode });
  const firstFailures = results
    .filter((r) => !r.markerOk)
    .map((r) => ({ eye: r.eye, first: r.failures[0]?.message ?? null }));
  return {
    name: flipMode === FLIP.TEX_ORIGIN ? '纹理原点翻转定位' : '矩阵翻转定位',
    flipMode,
    detected: firstFailures.length > 0,
    firstFailures,
    // 无翻转对照组必须通过，确保不是标记本身恒错
    controlPass: verifyFrameMarkers(backend, token, identityQuats, { flipMode: FLIP.NONE })
      .every((r) => r.markerOk && r.seqOk && r.invalidCorners.length === 0),
    pass: firstFailures.length > 0 && firstFailures.every((f) => f.first),
  };
}

// 旧工程（纯 yaw）与新工程（yaw+pitch+roll）各跑一遍，双眼四角共 8 组标识。
// 用恒等重投影核对标识完整性（任何角标身份错误都来自后端/原点问题，而非视野外无效区）。
export function scenarioLegacyAndTriad(backendOptions = {}) {
  const cases = [
    { label: '旧工程-纯偏航', params: DEFAULT_TRAJECTORY },
    { label: '新工程-俯仰滚转', params: TRIAD_TRAJECTORY },
  ];
  const reports = cases.map((c) => {
    const backend = createCpuBackend({ ...backendOptions, gateMode: 'auto' });
    const ring = createFrameRing(backend, { slotCount: backend.descriptor.slotCount });
    const tokens = submitNFrames(ring, 4, 0, c.params);
    const token = tokens[tokens.length - 1];
    const identityQuats = { 0: [...token.quats[0]], 1: [...token.quats[1]] };
    const results = verifyFrameMarkers(backend, token, identityQuats);
    return {
      label: c.label,
      seq: token.seq,
      hasPitch: (c.params.pitchAmplitudeDeg ?? 0) > 0,
      hasRoll: (c.params.rollAmplitudeDeg ?? 0) > 0,
      results,
      pass: results.every((r) => r.markerOk && r.seqOk && r.invalidCorners.length === 0),
    };
  });
  return { name: '旧/新工程双眼四角核对', reports, pass: reports.every((r) => r.pass) };
}

// 录制并重放一个含槽复用的最小场景，验证重放拒绝读取被复用槽
export function scenarioReplay(backendOptions = {}) {
  const slotCount = backendOptions.slotCount ?? 2;
  const backend = createCpuBackend({ ...backendOptions, slotCount, gateMode: 'manual' });
  const ring = createFrameRing(backend, { slotCount });
  const recorder = createReplayRecorder(backend, { params: DEFAULT_TRAJECTORY, gateMode: 'manual', policy: 'wait' });
  // 边提交边抓取：每个令牌在其槽被下一帧复用前留下角标/帧号快照
  const total = slotCount + 2;
  const tokens = [];
  for (let i = 0; i < total; i++) {
    const tRenderMs = i * 66;
    const tSampleMs = tRenderMs - 5;
    const base = stateAt(tSampleMs / 1000, DEFAULT_TRAJECTORY).quat;
    const token = ring.submit({ tSampleMs, tRenderMs, quats: eyeQuats(base) });
    const left = backend.blit(token, EYE.LEFT);
    const right = backend.blit(token, EYE.RIGHT);
    recorder.recordRender(token, {
      markers: { 0: backend.readMarkers(left), 1: backend.readMarkers(right) },
      seqRead: { 0: backend.readSeq(left), 1: backend.readSeq(right) },
    });
    tokens.push(token);
  }
  // 呈现事件引用最早的帧（其槽已被复用）
  const stale = tokens[0];
  recorder.recordPresent({
    tPresentMs: tokens[tokens.length - 1].tRenderMs + 10,
    targetSeq: stale.seq,
    status: 'rejected-recycled',
    eye: EYE.LEFT,
    expectedSeq: stale.seq,
  });
  const text = recorder.toJSON();
  const replay = loadReplay(text);
  let generationGuard = false;
  try {
    assertGenerationIntact(replay);
  } catch (e) {
    generationGuard = e.message.includes('复用');
  }
  // 实跑一次：旧令牌取纹理必须被后端拒绝
  let backendGuard = false;
  try {
    backend.blit(stale, EYE.LEFT);
  } catch (e) {
    backendGuard = e instanceof SlotRecycledError;
  }
  return {
    name: '含纹理复用的最小重放',
    replayText: text,
    replayBytes: text.length,
    events: replay.renders.length + replay.presents.length,
    generationGuard,
    backendGuard,
    pass: generationGuard && backendGuard,
  };
}

export function runAll(backendOptions = {}) {
  const suites = [
    scenarioInterleave(backendOptions),
    scenarioFastTurn(backendOptions),
    scenarioSlotReuse(backendOptions),
    scenarioFlipDiagnosis(FLIP.TEX_ORIGIN),
    scenarioFlipDiagnosis(FLIP.MATRIX),
    scenarioLegacyAndTriad(backendOptions),
    scenarioReplay(backendOptions),
  ];
  return { suites, pass: suites.every((s) => s.pass) };
}

export { CORNER, EYE, EYE_NAME, CORNER_NAME };
