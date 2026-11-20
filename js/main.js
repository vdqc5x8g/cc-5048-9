// 主编排：固定节奏的原始渲染 + 每显示帧的迟到重投影 + 参考直渲对照。
// 时刻定义（仿真时间，ms）：
//   t_s 姿态采样时刻 = t_r - Δ_SR
//   t_r 原始渲染时刻（按固定渲染间隔触发，不随显示频率加速）
//   t_p 呈现时刻（rAF 显示帧，重投影与参考直渲均在此刻进行）

import {
  perspective, viewMatrix, mul4, toColumnMajor,
  quatMul, quatConjugate, quatNormalize, clamp,
} from './math3d.js';
import {
  DEFAULT_TRAJECTORY, stateAt, sweepStateAt,
} from './trajectory.js';
import { createScene } from './scene.js';
import { createReprojectPipeline } from './reproject.js';
import { SpatialAudio } from './audio.js';
import { initMigrationPanel } from './migration-panel.js';

const FOV_Y = (72 * Math.PI) / 180;
const NEAR = 0.1;
const FAR = 100;
const VIEW_W = 640;
const VIEW_H = 480;
const METRIC_W = 160;
const METRIC_H = 120;
const MAX_FRAMES = 64;
const MAX_LOG = 400;
const METRIC_EVERY = 6; // 每 6 个显示帧回读一次，避免频繁 GPU 同步

const $ = (id) => document.getElementById(id);

const state = {
  playing: true,
  simTimeSec: 0,
  lastWallMs: null,
  params: { ...DEFAULT_TRAJECTORY },
  sweep: false,
  sweepStart: 0,
  latencyMs: 100,
  renderIntervalMs: 66,
  sampleToRenderMs: 5,
  edgeMode: 0, // 0 斜纹标记, 1 边缘钳取
  frames: [],
  nextRenderMs: 0,
  frameSeq: 0,
  displaySeq: 0,
  records: [],
  chartPts: [], // {omega, rmsFix, rmsOld, edge}
  lastRenderWall: [],
  metricCounter: 0,
};

// ---------- WebGL 初始化（每视窗独立上下文，避免纹理跨上下文共享） ----------

function makeContext(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) throw new Error('当前浏览器不支持 WebGL2，无法运行本演示。');
  return gl;
}

const glOld = makeContext($('canvas-old'));
const glFix = makeContext($('canvas-fix'));
const glRef = makeContext($('canvas-ref'));

const cam = { fovYRad: FOV_Y, aspect: VIEW_W / VIEW_H };
const proj = perspective(FOV_Y, cam.aspect, NEAR, FAR);

function mvpFor(quat) {
  const view = viewMatrix(quat);
  return toColumnMajor(mul4(proj, view));
}

// 旧帧渲染上下文：场景 + 可复用离屏纹理池
const oldScene = createScene(glOld);
const oldPipe = createReprojectPipeline(glOld);
const oldTargets = Array.from({ length: 4 }, () => oldPipe.createTarget(VIEW_W, VIEW_H));
let oldTargetIdx = 0;

// 修正帧上下文：重投影（输入旧帧纹理副本，WebGL 纹理按上下文隔离）
const fixPipe = createReprojectPipeline(glFix);
const fixDisplay = fixPipe.createTarget(VIEW_W, VIEW_H);
const fixMetric = fixPipe.createTarget(METRIC_W, METRIC_H);
const sharedOldTex = glFix.createTexture();
glFix.bindTexture(glFix.TEXTURE_2D, sharedOldTex);
glFix.texImage2D(glFix.TEXTURE_2D, 0, glFix.RGBA8, VIEW_W, VIEW_H, 0, glFix.RGBA, glFix.UNSIGNED_BYTE, null);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_MIN_FILTER, glFix.LINEAR);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_MAG_FILTER, glFix.LINEAR);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_WRAP_S, glFix.CLAMP_TO_EDGE);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_WRAP_T, glFix.CLAMP_TO_EDGE);

// 参考帧上下文：以最新姿态直接渲染（诊断用）
const refScene = createScene(glRef);
const refPipe = createReprojectPipeline(glRef);
const refMetric = { target: refPipe.createTarget(METRIC_W, METRIC_H) };

// 旧帧指标纹理（160x120，由旧上下文低分辨率渲染后回读上传）
const oldMetricTex = glFix.createTexture();
glFix.bindTexture(glFix.TEXTURE_2D, oldMetricTex);
glFix.texImage2D(glFix.TEXTURE_2D, 0, glFix.RGBA8, METRIC_W, METRIC_H, 0, glFix.RGBA, glFix.UNSIGNED_BYTE, null);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_MIN_FILTER, glFix.NEAREST);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_MAG_FILTER, glFix.NEAREST);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_WRAP_S, glFix.CLAMP_TO_EDGE);
glFix.texParameteri(glFix.TEXTURE_2D, glFix.TEXTURE_WRAP_T, glFix.CLAMP_TO_EDGE);

// 回读缓冲
const readFix = new Uint8Array(METRIC_W * METRIC_H * 4);
const readRef = new Uint8Array(METRIC_W * METRIC_H * 4);
const readOldMetricBuf = new Uint8Array(METRIC_W * METRIC_H * 4);
const framePixels = new Uint8Array(VIEW_W * VIEW_H * 4);

// 旧帧指标读取用 FBO（复用，不每帧创建）
const oldMetricFbo = glFix.createFramebuffer();
glFix.bindFramebuffer(glFix.FRAMEBUFFER, oldMetricFbo);
glFix.framebufferTexture2D(glFix.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, glFix.TEXTURE_2D, oldMetricTex, 0);
glFix.bindFramebuffer(glFix.FRAMEBUFFER, null);

// ---------- 轨迹查询（支持扫描模式） ----------

function queryState(tSec) {
  return state.sweep ? sweepStateAt(tSec - state.sweepStart, 45) : stateAt(tSec, state.params);
}

// ---------- 固定节奏的原始渲染 ----------

function renderFrame(tRenderMs) {
  const tSampleMs = tRenderMs - state.sampleToRenderMs;
  const s = queryState(tSampleMs / 1000);
  const target = oldTargets[oldTargetIdx];
  oldTargetIdx = (oldTargetIdx + 1) % oldTargets.length;

  glOld.bindFramebuffer(glOld.FRAMEBUFFER, target.fbo);
  glOld.viewport(0, 0, VIEW_W, VIEW_H);
  glOld.enable(glOld.DEPTH_TEST);
  glOld.clearColor(0.02, 0.03, 0.05, 1);
  glOld.clear(glOld.COLOR_BUFFER_BIT | glOld.DEPTH_BUFFER_BIT);
  oldScene.draw(mvpFor(s.quat));

  const rec = {
    seq: state.frameSeq++,
    tSampleMs,
    tRenderMs,
    quat: s.quat,
    yawDeg: s.yawDeg,
    tex: target.tex,
  };
  state.frames.push(rec);
  while (state.frames.length > MAX_FRAMES) state.frames.shift();
  state.lastRenderWall.push(performance.now());
  if (state.lastRenderWall.length > 30) state.lastRenderWall.shift();
  return rec;
}

function frameFor(presentMs) {
  const wanted = presentMs - state.latencyMs;
  let best = null;
  for (const f of state.frames) {
    if (f.tRenderMs <= wanted) best = f;
    else break;
  }
  return best || state.frames[0];
}

// ---------- 指标计算 ----------

// 旧上下文的低分辨率渲染目标（指标路径专用，非显示路径）
const oldMetricTarget = oldPipe.createTarget(METRIC_W, METRIC_H);
const oldMetricPixels = new Uint8Array(METRIC_W * METRIC_H * 4);

// 在旧上下文把 640x480 场景帧缩放到 160x120，回读后上传到修正上下文纹理
function prepareOldMetric(srcTex) {
  oldPipe.blit(oldMetricTarget, srcTex, METRIC_W, METRIC_H);
  glOld.readPixels(0, 0, METRIC_W, METRIC_H, glOld.RGBA, glOld.UNSIGNED_BYTE, oldMetricPixels);
  glFix.bindTexture(glFix.TEXTURE_2D, oldMetricTex);
  glFix.texImage2D(glFix.TEXTURE_2D, 0, glFix.RGBA, METRIC_W, METRIC_H, 0,
    glFix.RGBA, glFix.UNSIGNED_BYTE, oldMetricPixels);
}

function computeMetrics(presentMs, frame, presentQuat, deltaQuat) {
  state.metricCounter++;
  if (state.metricCounter % METRIC_EVERY !== 0) return null;

  // 1) 修正帧低分辨率重投影（alpha=0 标记越界）
  fixPipe.reproject(fixMetric, sharedOldTex, deltaQuat, cam, state.edgeMode, METRIC_W, METRIC_H);
  glFix.readPixels(0, 0, METRIC_W, METRIC_H, glFix.RGBA, glFix.UNSIGNED_BYTE, readFix);

  // 2) 参考帧低分辨率直渲
  glRef.bindFramebuffer(glRef.FRAMEBUFFER, refMetric.target.fbo);
  glRef.viewport(0, 0, METRIC_W, METRIC_H);
  glRef.enable(glRef.DEPTH_TEST);
  glRef.clearColor(0.02, 0.03, 0.05, 1);
  glRef.clear(glRef.COLOR_BUFFER_BIT | glRef.DEPTH_BUFFER_BIT);
  refScene.draw(mvpFor(presentQuat));
  glRef.readPixels(0, 0, METRIC_W, METRIC_H, glRef.RGBA, glRef.UNSIGNED_BYTE, readRef);

  // 3) 旧帧低分辨率拷贝（跨上下文经回读/上传）
  prepareOldMetric(frame.tex);
  glFix.bindFramebuffer(glFix.FRAMEBUFFER, oldMetricFbo);
  glFix.readPixels(0, 0, METRIC_W, METRIC_H, glFix.RGBA, glFix.UNSIGNED_BYTE, readOldMetricBuf);
  glFix.bindFramebuffer(glFix.FRAMEBUFFER, null);

  let sumFix = 0, sumOld = 0, valid = 0, edgePx = 0;
  const n = METRIC_W * METRIC_H;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (readFix[o + 3] === 0) { edgePx++; continue; }
    sumFix +=
      (readFix[o] - readRef[o]) ** 2 +
      (readFix[o + 1] - readRef[o + 1]) ** 2 +
      (readFix[o + 2] - readRef[o + 2]) ** 2;
    valid++;
  }
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sumOld +=
      (readOldMetricBuf[o] - readRef[o]) ** 2 +
      (readOldMetricBuf[o + 1] - readRef[o + 1]) ** 2 +
      (readOldMetricBuf[o + 2] - readRef[o + 2]) ** 2;
  }

  const rmsFix = valid ? Math.sqrt(sumFix / (valid * 3)) / 255 : 1;
  const rmsOld = Math.sqrt(sumOld / (n * 3)) / 255;
  return { rmsFix, rmsOld, edgeFrac: edgePx / n, valid };
}

// ---------- 主循环 ----------

const audio = new SpatialAudio();
let lastMetrics = null;

function frame(nowMs) {
  if (state.playing) {
    if (state.lastWallMs == null) state.lastWallMs = nowMs;
    const dt = Math.min(nowMs - state.lastWallMs, 100);
    state.lastWallMs = nowMs;
    state.simTimeSec += dt / 1000;
  } else {
    state.lastWallMs = nowMs;
  }

  const tPresentMs = state.simTimeSec * 1000;

  // 扫描实验 10 s 后自动结束
  if (state.sweep && state.simTimeSec - state.sweepStart >= 10) {
    state.sweep = false;
    $('btn-sweep-cancel').disabled = true;
  }

  // 固定渲染节奏：追赶所有到期的渲染时刻（不提高频率，仅补帧）
  while (state.nextRenderMs <= tPresentMs) {
    renderFrame(state.nextRenderMs);
    state.nextRenderMs += state.renderIntervalMs;
  }
  if (state.frames.length === 0) renderFrame(tPresentMs);

  const presentState = queryState(state.simTimeSec);
  const oldFrame = frameFor(tPresentMs);
  // v_world = q_p · v_present；v_old = q_s^-1 · v_world = (q_s^-1 · q_p) · v_present
  const deltaQuat = quatNormalize(quatMul(quatConjugate(oldFrame.quat), presentState.quat));

  // 纹理跨上下文传递（仅显示路径所需的一次回读/上传）
  glOld.bindTexture(glOld.TEXTURE_2D, oldFrame.tex);
  glOld.readPixels(0, 0, VIEW_W, VIEW_H, glOld.RGBA, glOld.UNSIGNED_BYTE, framePixels);
  glFix.bindTexture(glFix.TEXTURE_2D, sharedOldTex);
  glFix.texImage2D(glFix.TEXTURE_2D, 0, glFix.RGBA, VIEW_W, VIEW_H, 0, glFix.RGBA, glFix.UNSIGNED_BYTE, framePixels);

  // ① 旧帧直显
  oldPipe.blit(null, oldFrame.tex, VIEW_W, VIEW_H);
  // ② 迟到修正
  fixPipe.reproject(fixDisplay, sharedOldTex, deltaQuat, cam, state.edgeMode, VIEW_W, VIEW_H);
  fixPipe.blit(null, fixDisplay.tex, VIEW_W, VIEW_H);
  // ③ 参考直渲
  glRef.bindFramebuffer(glRef.FRAMEBUFFER, null);
  glRef.viewport(0, 0, VIEW_W, VIEW_H);
  glRef.enable(glRef.DEPTH_TEST);
  glRef.clearColor(0.02, 0.03, 0.05, 1);
  glRef.clear(glRef.COLOR_BUFFER_BIT | glRef.DEPTH_BUFFER_BIT);
  refScene.draw(mvpFor(presentState.quat));

  const metrics = computeMetrics(tPresentMs, oldFrame, presentState.quat, deltaQuat);
  if (metrics) lastMetrics = metrics;

  // 时间记录
  const rec = {
    displaySeq: state.displaySeq++,
    tSampleMs: oldFrame.tSampleMs,
    tRenderMs: oldFrame.tRenderMs,
    tPresentMs,
    e2eMs: tPresentMs - oldFrame.tSampleMs,
    yawOld: oldFrame.yawDeg,
    yawNow: presentState.yawDeg,
    deltaYawDeg: presentState.yawDeg - oldFrame.yawDeg,
    omega: presentState.yawRateDeg,
    rmsFix: lastMetrics ? lastMetrics.rmsFix : null,
    rmsOld: lastMetrics ? lastMetrics.rmsOld : null,
    edgeFrac: lastMetrics ? lastMetrics.edgeFrac : null,
  };
  state.records.push(rec);
  if (state.records.length > MAX_LOG) state.records.shift();
  if (metrics) {
    state.chartPts.push({
      omega: Math.abs(rec.omega),
      rmsFix: metrics.rmsFix,
      rmsOld: metrics.rmsOld,
      edge: metrics.edgeFrac,
    });
    if (state.chartPts.length > 220) state.chartPts.shift();
  }

  audio.updateListener(presentState.quat);
  updateHud(rec, presentState, oldFrame);
  requestAnimationFrame(frame);
}

// ---------- HUD ----------

function fmt(x, d = 1) { return x == null ? '—' : x.toFixed(d); }

function updateHud(rec, presentState, oldFrame) {
  $('meta-old').textContent =
    `姿态 t_s=${fmt(oldFrame.tSampleMs)} ms · 渲染 t_r=${fmt(oldFrame.tRenderMs)} ms · yaw(t_s)=${fmt(oldFrame.yawDeg, 2)}°`;
  $('meta-fix').textContent =
    `呈现 t_p=${fmt(rec.tPresentMs)} ms · Δyaw=${fmt(rec.deltaYawDeg, 2)}° · 延迟=${fmt(rec.e2eMs)} ms`;
  $('meta-ref').textContent =
    `呈现 t_p=${fmt(rec.tPresentMs)} ms · yaw(t_p)=${fmt(presentState.yawDeg, 2)}° · 离线诊断直渲`;

  $('overlay-old').textContent =
    `未修正：画面仍朝向 ${fmt(oldFrame.yawDeg, 1)}°\n当前朝向 ${fmt(presentState.yawDeg, 1)}°`;
  $('overlay-fix').textContent =
    `重投影 Δq: yaw ${fmt(rec.deltaYawDeg, 2)}°\n越界 ${rec.edgeFrac != null ? (rec.edgeFrac * 100).toFixed(1) : '—'}% · 模式 ${state.edgeMode === 0 ? '斜纹标记' : '边缘钳取'}`;
  $('overlay-ref').textContent =
    `参考：以 t_p 最新姿态直接渲染\n（不参与演示渲染管线）`;

  if (lastMetrics) {
    $('m-omega').textContent = `${fmt(Math.abs(rec.omega), 1)} °/s`;
    $('m-rms-fix').textContent = fmt(lastMetrics.rmsFix, 4);
    $('m-rms-old').textContent = fmt(lastMetrics.rmsOld, 4);
    $('m-edge').textContent = `${(lastMetrics.edgeFrac * 100).toFixed(1)} %`;
    $('m-resid').textContent = `${fmt(Math.abs(rec.deltaYawDeg), 2)} °`;
  }
  const rw = state.lastRenderWall;
  if (rw.length >= 2) {
    const span = rw[rw.length - 1] - rw[0];
    const hz = (1000 * (rw.length - 1)) / span;
    $('m-fps').textContent = `${fmt(hz, 1)} Hz（目标 ${(1000 / state.renderIntervalMs).toFixed(1)} Hz）`;
  }

  renderTimeTable();
  drawTimeline(rec);
  drawChart();
}

function renderTimeTable() {
  const tbody = $('time-rows');
  const recent = state.records.slice(-12).reverse();
  tbody.innerHTML = recent.map((r) => `<tr>
    <td>#${r.displaySeq}</td>
    <td>${fmt(r.tSampleMs)}</td>
    <td>${fmt(r.tRenderMs)}</td>
    <td>${fmt(r.tPresentMs)}</td>
    <td>${fmt(r.e2eMs)}</td>
    <td>${fmt(r.deltaYawDeg, 2)}</td>
    <td>${fmt(r.omega)}</td>
  </tr>`).join('');
}

function drawTimeline(rec) {
  const c = $('timeline-canvas');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1c232d';
  ctx.fillRect(0, 0, W, H);
  const windowMs = 400;
  const t0 = rec.tPresentMs - windowMs;
  const xOf = (t) => 12 + ((t - t0) / windowMs) * (W - 24);
  // 网格
  ctx.strokeStyle = '#2b3543';
  ctx.fillStyle = '#8b97a5';
  ctx.font = '10px monospace';
  for (let t = Math.ceil(t0 / 50) * 50; t <= rec.tPresentMs; t += 50) {
    const x = xOf(t);
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, H - 14); ctx.stroke();
    ctx.fillText(t.toFixed(0), x - 12, H - 4);
  }
  const rows = [
    { key: 'tSampleMs', color: '#d97a5c', label: 't_s 采样', y: 30 },
    { key: 'tRenderMs', color: '#e8c45a', label: 't_r 渲染', y: 52 },
    { key: 'tPresentMs', color: '#5cc8a6', label: 't_p 呈现', y: 74 },
  ];
  const recent = state.records.slice(-40);
  for (const row of rows) {
    ctx.fillStyle = row.color;
    ctx.fillText(row.label, 0, row.y + 4);
    for (const r of recent) {
      const x = xOf(r[row.key]);
      if (x < 0 || x > W) continue;
      ctx.fillRect(x - 1.5, row.y - 5, 3, 10);
    }
  }
}

function drawChart() {
  const c = $('chart-canvas');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1c232d';
  ctx.fillRect(0, 0, W, H);
  const pts = state.chartPts;
  if (pts.length < 2) {
    ctx.fillStyle = '#8b97a5';
    ctx.font = '12px sans-serif';
    ctx.fillText('等待数据…（运行扫描实验观察误差随角速度变化）', 16, H / 2);
    return;
  }
  const maxOmega = Math.max(...pts.map((p) => p.omega), 50);
  const xOf = (i) => 30 + (i / (pts.length - 1)) * (W - 40);
  const yOf = (v) => H - 24 - v * (H - 44);
  // 轴
  ctx.strokeStyle = '#3a4655';
  ctx.beginPath(); ctx.moveTo(30, 10); ctx.lineTo(30, H - 24); ctx.lineTo(W - 10, H - 24); ctx.stroke();
  ctx.fillStyle = '#8b97a5';
  ctx.font = '10px monospace';
  ctx.fillText('RMS', 4, 14);
  ctx.fillText('|ω|→', W - 48, H - 8);
  const series = [
    { key: 'rmsFix', color: '#5cc8a6' },
    { key: 'rmsOld', color: '#d97a5c' },
    { key: 'edge', color: '#e8c45a' },
  ];
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(i);
      const y = yOf(clamp(p[s.key], 0, 1));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.fillStyle = '#8b97a5';
  ctx.fillText(`max|ω|=${maxOmega.toFixed(0)}°/s`, W - 120, 14);
}

// ---------- 控件 ----------

function bindRange(id, outId, apply, fmtFn = (v) => v) {
  const sl = $(id);
  sl.addEventListener('input', () => {
    $(outId).textContent = fmtFn(sl.value);
    apply(parseFloat(sl.value));
  });
}

bindRange('sl-amp', 'out-amp', (v) => { state.params.amplitudeDeg = v; state.sweep = false; });
bindRange('sl-freq', 'out-freq', (v) => { state.params.frequencyHz = v; state.sweep = false; }, (v) => Number(v).toFixed(1));
bindRange('sl-phase', 'out-phase', (v) => { state.params.phaseDeg = v; state.sweep = false; });
bindRange('sl-latency', 'out-latency', (v) => { state.latencyMs = v; });
bindRange('sl-rinterval', 'out-rinterval', (v) => {
  state.renderIntervalMs = v;
  $('out-rhz').textContent = (1000 / v).toFixed(1);
});
bindRange('sl-sr', 'out-sr', (v) => { state.sampleToRenderMs = v; });

$('btn-play').addEventListener('click', () => {
  state.playing = !state.playing;
  $('btn-play').textContent = state.playing ? '暂停' : '继续';
});
$('btn-step').addEventListener('click', () => {
  state.playing = false;
  $('btn-play').textContent = '继续';
  state.simTimeSec += 0.033;
  state.lastWallMs = null; // 下一帧 rAF 仅校准墙上时钟，不再次推进仿真时间
});
$('btn-reset').addEventListener('click', () => {
  state.simTimeSec = 0;
  state.nextRenderMs = 0;
  state.frames = [];
  state.records = [];
  state.chartPts = [];
  state.frameSeq = 0;
  state.displaySeq = 0;
  state.sweep = false;
  $('btn-sweep-cancel').disabled = true;
});
$('btn-sweep').addEventListener('click', () => {
  state.sweep = true;
  state.sweepStart = state.simTimeSec;
  state.chartPts = [];
  $('btn-sweep-cancel').disabled = false;
});
$('btn-sweep-cancel').addEventListener('click', () => {
  state.sweep = false;
  $('btn-sweep-cancel').disabled = true;
});
document.querySelectorAll('#latency-presets button').forEach((b) => {
  b.addEventListener('click', () => {
    const v = parseFloat(b.dataset.lat);
    state.latencyMs = v;
    $('sl-latency').value = v;
    $('out-latency').textContent = v;
  });
});
$('btn-edge-hatch').addEventListener('click', () => setEdgeMode(0));
$('btn-edge-clamp').addEventListener('click', () => setEdgeMode(1));
function setEdgeMode(m) {
  state.edgeMode = m;
  $('btn-edge-hatch').classList.toggle('active', m === 0);
  $('btn-edge-clamp').classList.toggle('active', m === 1);
  $('btn-edge-hatch').setAttribute('aria-pressed', String(m === 0));
  $('btn-edge-clamp').setAttribute('aria-pressed', String(m === 1));
}

$('btn-audio').addEventListener('click', async () => {
  if (audio.started) {
    audio.stop();
    $('btn-audio').textContent = '开启空间音';
  } else {
    await audio.start();
    $('btn-audio').textContent = '关闭空间音';
  }
});

$('btn-export-csv').addEventListener('click', () => {
  const header = 'displaySeq,tSampleMs,tRenderMs,tPresentMs,e2eMs,yawOldDeg,yawNowDeg,deltaYawDeg,omegaDegPerSec,rmsFix,rmsOld,edgeFrac';
  const lines = state.records.map((r) => [
    r.displaySeq, r.tSampleMs.toFixed(2), r.tRenderMs.toFixed(2), r.tPresentMs.toFixed(2),
    r.e2eMs.toFixed(2), r.yawOld.toFixed(3), r.yawNow.toFixed(3), r.deltaYawDeg.toFixed(3),
    r.omega.toFixed(2),
    r.rmsFix == null ? '' : r.rmsFix.toFixed(5),
    r.rmsOld == null ? '' : r.rmsOld.toFixed(5),
    r.edgeFrac == null ? '' : r.edgeFrac.toFixed(5),
  ].join(','));
  const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `reproject-log-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('btn-clear-log').addEventListener('click', () => {
  state.records = [];
  state.chartPts = [];
});

// ---------- 启动 ----------

try {
  initMigrationPanel();
  requestAnimationFrame((t) => { state.lastWallMs = t; frame(t); });
} catch (err) {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="color:#f88;padding:16px">初始化失败：${err.message}</div>`);
  throw err;
}
