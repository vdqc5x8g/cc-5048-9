#!/usr/bin/env node
// 辅助 CLI（仅辅助，重投影画面由浏览器着色器实时生成）：
//   node cli/atw-cli.js trajectory-csv [--duration 10] [--sweep] [--amp 45] [--freq 0.8]
//       输出可重复头部轨迹的数值表（t, yaw, yawRate, quat）
//   node cli/atw-cli.js error-table [--duration 10] [--latency 100]
//       [--render-interval 66] [--sr 5] [--width 640] [--height 480] [--fovy 72]
//       按与页面相同的时刻定义，数值化统计越界/边界占比随角速度的变化。
//       这是边界几何的独立数值核算，不产出、不替代浏览器中的重投影画面。

import { writeFileSync } from 'node:fs';
import { stateAt, sweepStateAt, DEFAULT_TRAJECTORY } from '../js/trajectory.js';
import { deg2rad, rad2deg, quatMul, quatConjugate } from '../js/math3d.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = Number.isNaN(Number(next)) ? next : Number(next);
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function queryState(tSec, args) {
  if (args.sweep) return sweepStateAt(tSec, args.amp ?? 45);
  const params = {
    ...DEFAULT_TRAJECTORY,
    amplitudeDeg: args.amp ?? DEFAULT_TRAJECTORY.amplitudeDeg,
    frequencyHz: args.freq ?? DEFAULT_TRAJECTORY.frequencyHz,
    phaseDeg: args.phase ?? DEFAULT_TRAJECTORY.phaseDeg,
  };
  return stateAt(tSec, params);
}

function cmdTrajectoryCsv(args) {
  const duration = args.duration ?? 10;
  const dt = 1 / (args.rate ?? 100);
  const rows = ['tSec,yawDeg,yawRateDegPerSec,quatX,quatY,quatZ,quatW'];
  for (let t = 0; t <= duration + 1e-9; t += dt) {
    const s = queryState(t, args);
    rows.push([
      t.toFixed(4), s.yawDeg.toFixed(4), s.yawRateDeg.toFixed(4),
      s.quat[0].toFixed(6), s.quat[1].toFixed(6), s.quat[2].toFixed(6), s.quat[3].toFixed(6),
    ].join(','));
  }
  const csv = rows.join('\n') + '\n';
  if (args.out) writeFileSync(args.out, csv);
  process.stdout.write(csv);
}

// 与 reproject.js 片段着色器完全一致的射线投影（纯 yaw 下 Δq 仅含 y 分量）
function edgeStats(deltaYawRad, width, height, fovYDeg) {
  const tanHalf = Math.tan(deg2rad(fovYDeg) / 2);
  const aspect = width / height;
  const sin = Math.sin(deltaYawRad);
  const cos = Math.cos(deltaYawRad);
  let inside = 0, edge = 0, boundary = 0;
  const eps = 1.5e-3;
  for (let py = 0; py < height; py++) {
    const ndcY = ((py + 0.5) / height) * 2 - 1;
    const ry = ndcY * tanHalf;
    for (let px = 0; px < width; px++) {
      const ndcX = ((px + 0.5) / width) * 2 - 1;
      const rx = ndcX * aspect * tanHalf;
      // 呈现相机空间射线 (rx, ry, -1) 绕 +Y 旋转 δ
      const ox = cos * rx + sin * -1;
      const oz = -sin * rx + cos * -1;
      const oldNdcX = ox / (aspect * tanHalf * -oz);
      const oldNdcY = ry / (tanHalf * -oz);
      const u = oldNdcX * 0.5 + 0.5;
      const v = oldNdcY * 0.5 + 0.5;
      const isInside = u >= eps && u <= 1 - eps && v >= eps && v <= 1 - eps;
      if (isInside) {
        inside++;
      } else {
        edge++;
      }
      // 边界：邻域任一采样越出 [0,1]
      const du = 1 / width, dv = 1 / height;
      let isBoundary = false;
      for (const ddx of [-du, 0, du]) {
        for (const ddy of [-dv, 0, dv]) {
          const uu = u + ddx, vv = v + ddy;
          if (uu < 0 || uu > 1 || vv < 0 || vv > 1) isBoundary = true;
        }
      }
      if (isBoundary) boundary++;
    }
  }
  const n = width * height;
  return {
    edgeFrac: edge / n,
    boundaryFrac: boundary / n,
    insideFrac: inside / n,
  };
}

function cmdErrorTable(args) {
  const duration = args.duration ?? 10;
  const latency = args.latency ?? 100;
  const renderInterval = args['render-interval'] ?? 66;
  const sr = args.sr ?? 5;
  const width = args.width ?? 640;
  const height = args.height ?? 480;
  const fovy = args.fovy ?? 72;
  const stepMs = args.step ?? 33;

  // 预生成渲染帧表（t_s, t_r, quat），规则与 main.js renderFrame 相同
  const frames = [];
  for (let tr = 0; tr <= duration * 1000; tr += renderInterval) {
    const ts = tr - sr;
    frames.push({ tRenderMs: tr, tSampleMs: ts, state: queryState(ts / 1000, args) });
  }
  const pickFrame = (tp) => {
    const wanted = tp - latency;
    let best = frames[0];
    for (const f of frames) {
      if (f.tRenderMs <= wanted) best = f;
      else break;
    }
    return best;
  };

  const rows = ['tPresentMs,omegaDegPerSec,deltaYawDeg,edgeFrac,boundaryFrac,insideFrac,tSampleMs,tRenderMs,e2eMs'];
  for (let tp = 0; tp <= duration * 1000; tp += stepMs) {
    const present = queryState(tp / 1000, args);
    const f = pickFrame(tp);
    // Δq = q_s^-1 · q_p；纯 yaw 时其旋转角等于 yaw 差
    const dq = quatMul(quatConjugate(f.state.quat), present.quat);
    const deltaYawRad = 2 * Math.asin(Math.max(-1, Math.min(1, dq[1])));
    const stats = edgeStats(deltaYawRad, width, height, fovy);
    rows.push([
      tp.toFixed(1),
      present.yawRateDeg.toFixed(3),
      rad2deg(deltaYawRad).toFixed(4),
      stats.edgeFrac.toFixed(5),
      stats.boundaryFrac.toFixed(5),
      stats.insideFrac.toFixed(5),
      f.tSampleMs.toFixed(1),
      f.tRenderMs.toFixed(1),
      (tp - f.tSampleMs).toFixed(1),
    ].join(','));
  }
  const csv = rows.join('\n') + '\n';
  if (args.out) writeFileSync(args.out, csv);
  process.stdout.write(csv);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (cmd === 'trajectory-csv') {
  cmdTrajectoryCsv(args);
} else if (cmd === 'error-table') {
  cmdErrorTable(args);
} else {
  process.stderr.write([
    '用法：',
    '  node cli/atw-cli.js trajectory-csv [--duration 10] [--rate 100] [--sweep] [--amp 45] [--freq 0.8] [--phase 0] [--out file.csv]',
    '  node cli/atw-cli.js error-table [--duration 10] [--latency 100] [--render-interval 66] [--sr 5]',
    '                         [--width 640] [--height 480] [--fovy 72] [--step 33] [--out file.csv]',
    '',
    'CLI 仅输出数值表；重投影画面与边界由 index.html 中的 WebGL2 着色器实时生成。',
  ].join('\n') + '\n');
  process.exit(1);
}
