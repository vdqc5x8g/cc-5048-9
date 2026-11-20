// 浏览器迁移面板：在重投影视窗中手动单步放行迟到栅栏，
// 用 CPU 软件后端（与 CLI 同一份代码）驱动一个小型 2D 画布，
// 让“等待该帧”与“丢弃过时姿态”的不同可见结果直接可见。
// 现有三视窗 WebGL 演示保持不变；本面板是后端迁移的交互式核对入口。

import { createCpuBackend, FLIP } from './cpu-backend.js';
import { createFrameRing, FrameNotReadyError, readLegacyRecord } from './frame-pool.js';
import { stateAt, DEFAULT_TRAJECTORY, TRIAD_TRAJECTORY } from './trajectory.js';
import { quatYawPitchRoll, quatNormalize, quatMul } from './math3d.js';
import { EYE, CORNER, EYE_NAME, CORNER_NAME, diagnoseMarkers } from './markers.js';
import { createReplayRecorder, assertGenerationIntact } from './replay.js';

const RENDER_INTERVAL_MS = 66;
const SAMPLE_TO_RENDER_MS = 5;
const EYE_YAW = (2.2 * Math.PI) / 180;

function eyeQuats(base) {
  return {
    0: quatNormalize(quatMul(base, quatYawPitchRoll(-EYE_YAW, 0, 0))),
    1: quatNormalize(quatMul(base, quatYawPitchRoll(EYE_YAW, 0, 0))),
  };
}

const $ = (id) => document.getElementById(id);

export function initMigrationPanel() {
  const canvas = $('mig-canvas');
  const ctx = canvas.getContext('2d');
  const W = 160, H = 120;
  canvas.width = W;
  canvas.height = H;

  const ui = {
    gate: $('mig-gate'),
    policy: $('mig-policy'),
    eye: $('mig-eye'),
    flip: $('mig-flip'),
    project: $('mig-project'),
    status: $('mig-status'),
    corners: $('mig-corners'),
    log: $('mig-log'),
  };

  let backend = createBackend();
  let ring = createFrameRing(backend, { slotCount: backend.descriptor.slotCount });
  let simMs = 0;
  let renderCursor = 0; // 下一个渲染时刻
  let frameCounter = 0;
  let heldPixels = null; // wait 挂起时保持的上一帧画面
  let heldSeq = null;
  const recorder = createReplayRecorder(backend, { params: currentParams(), gateMode: 'manual', policy: 'wait' });
  const logLines = [];

  function currentParams() {
    return ui.project.value === 'triad' ? TRIAD_TRAJECTORY : DEFAULT_TRAJECTORY;
  }

  function createBackend() {
    return createCpuBackend({
      width: W, height: H, slotCount: 2,
      gateMode: ui.gate.value,
      flipMode: Number(ui.flip.value),
    });
  }

  function log(msg) {
    logLines.push(`t=${simMs.toFixed(0)}ms ${msg}`);
    if (logLines.length > 8) logLines.shift();
    ui.log.textContent = logLines.join('\n');
  }

  function reset() {
    backend = createBackend();
    ring = createFrameRing(backend, { slotCount: backend.descriptor.slotCount });
    simMs = 0;
    renderCursor = 0;
    frameCounter = 0;
    heldPixels = null;
    heldSeq = null;
    logLines.length = 0;
    render();
  }

  // 提交所有到期的固定节奏渲染帧
  function catchUpRenders() {
    while (renderCursor <= simMs) {
      const tRenderMs = renderCursor;
      const tSampleMs = tRenderMs - SAMPLE_TO_RENDER_MS;
      const base = stateAt(tSampleMs / 1000, currentParams()).quat;
      const token = ring.submit({ tSampleMs, tRenderMs, quats: eyeQuats(base) });
      recorder.recordRender(token, snapshotMarkers(token));
      frameCounter++;
      renderCursor += RENDER_INTERVAL_MS;
    }
  }

  function snapshotMarkers(token) {
    const markers = {}, seqRead = {};
    for (const eye of [0, 1]) {
      const px = backend.blit(token, eye, FLIP.NONE);
      markers[eye] = backend.readMarkers(px);
      seqRead[eye] = backend.readSeq(px);
    }
    return { markers, seqRead };
  }

  function presentQuats() {
    return eyeQuats(stateAt(simMs / 1000, currentParams()).quat);
  }

  function render() {
    catchUpRenders();
    const eye = Number(ui.eye.value);
    const flip = Number(ui.flip.value);
    backend.setFlipMode(flip);
    let pixels;
    let status;
    let token;
    try {
      const acquired = ring.acquireForPresent(simMs, 100, ui.policy.value);
      token = acquired.token;
      const pq = presentQuats();
      const dq = ring.deltaFor(token, pq);
      pixels = backend.reproject(token, eye, pq[eye], dq[eye], { flipMode: flip });
      heldPixels = pixels;
      heldSeq = token.seq;
      status = `呈现帧 #${token.seq}（槽 ${token.slot}，代际 ${token.generation}）· 策略=${ui.policy.value} · ${EYE_NAME[eye]}`;
      recorder.recordPresent({
        tPresentMs: simMs, targetSeq: token.seq, status: acquired.status,
        eye, expectedSeq: token.seq,
      });
    } catch (e) {
      if (e instanceof FrameNotReadyError) {
        pixels = heldPixels;
        status = heldSeq == null
          ? `等待：帧 #${e.seq} 栅栏未放行，尚无画面可显示（不读取当前槽内容）`
          : `等待：帧 #${e.seq} 栅栏未放行，保持上一帧 #${heldSeq}（策略=wait）`;
      } else {
        status = `错误：${e.message}`;
        log(status);
      }
    }

    drawPixels(pixels);
    ui.status.textContent = status;
    ui.status.dataset.pending = ring.pendingSeqs().length ? '1' : '0';
    renderCornerReport(pixels, eye);
  }

  function drawPixels(pixels) {
    if (!pixels) {
      ctx.fillStyle = '#05070b';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#8b97a5';
      ctx.font = '10px monospace';
      ctx.fillText('等待首帧栅栏…', 8, H / 2);
      return;
    }
    const img = ctx.createImageData(W, H);
    img.data.set(pixels);
    ctx.putImageData(img, 0, 0);
  }

  function renderCornerReport(pixels, eye) {
    if (!pixels) { ui.corners.textContent = '—'; return; }
    const markers = backend.readMarkers(pixels);
    const lines = [];
    for (const m of markers) {
      const invalid = backend.markerInvalid(pixels, m.screenCorner);
      if (invalid) {
        lines.push(`${CORNER_NAME[m.screenCorner]}：无效区（alpha=0，原帧视野外）`);
      } else {
        const ok = m.eye === eye && m.corner === m.screenCorner;
        lines.push(`${CORNER_NAME[m.screenCorner]}：${ok ? '✓' : '✗'} 读到${EYE_NAME[m.eye]}${CORNER_NAME[m.corner]}标识`);
      }
    }
    const seq = backend.readSeq(pixels);
    lines.push(`帧号条：${seq == null ? '落入无效区' : '#' + seq}`);
    ui.corners.textContent = lines.join('\n');
  }

  // 控件
  $('mig-step-time').addEventListener('click', () => { simMs += 33; render(); });
  $('mig-step-fence').addEventListener('click', () => {
    const seq = ring.releaseNextFence();
    log(seq == null ? '没有等待中的栅栏' : `单步放行帧 #${seq} 的迟到栅栏`);
    render();
  });
  $('mig-reset').addEventListener('click', reset);
  $('mig-check-legacy').addEventListener('click', () => {
    // 旧记录只给帧号：取最早帧，其槽在 2 槽环中已被复用
    const frameNo = Math.max(0, frameCounter - ring.slotCount);
    const rec = readLegacyRecord({ frameNo }, ring);
    log(`旧记录 frameNo=${frameNo} → ${rec.status}${rec.warnings[0] ? '：' + rec.warnings[0] : ''}`);
  });
  $('mig-export-replay').addEventListener('click', () => {
    const text = recorder.toJSON();
    let guard = '通过';
    try { assertGenerationIntact(JSON.parse(text)); }
    catch (e) { guard = '代际守卫触发：' + e.message; }
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `migration-replay-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    log(`导出最小重放（${text.length} B），代际检查：${guard}`);
  });
  ui.gate.addEventListener('change', reset);
  ui.project.addEventListener('change', reset);
  ui.policy.addEventListener('change', render);
  ui.eye.addEventListener('change', render);
  ui.flip.addEventListener('change', render);

  reset();
  return { render, reset };
}
