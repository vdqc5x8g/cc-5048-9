#!/usr/bin/env node
// 图形后端迁移核对（无头，纯 CPU 软件后端，零依赖）：
//   node cli/migrate-verify.js run        跑全部迁移场景并输出报告
//   node cli/migrate-verify.js replay     生成含纹理复用的最小重放 JSON
//   node cli/migrate-verify.js flip --mode origin|matrix  翻转定位（报告哪只眼的哪个角先错）
//   node cli/migrate-verify.js corners    旧工程(纯yaw)/新工程(三轴) 双眼四角读取
//   node cli/migrate-verify.js interleave 标号不同两帧交叉完成 + 栅栏单步放行
//
// 浏览器中的 WebGL 后端走同一套帧池/标记/重放模块（js/main.js），
// 本 CLI 用同接口的 CPU 后端做可重复的独立核对。

import { writeFileSync } from 'node:fs';
import {
  runAll, scenarioInterleave, scenarioFastTurn, scenarioSlotReuse,
  scenarioFlipDiagnosis, scenarioLegacyAndTriad, scenarioReplay,
} from '../js/verifier.js';
import { FLIP } from '../js/cpu-backend.js';
import { EYE_NAME, CORNER_NAME } from '../js/markers.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = Number.isNaN(Number(next)) ? next : Number(next); i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const opts = (args) => ({
  width: args.width ?? 160,
  height: args.height ?? 120,
  slotCount: args.slots ?? 2,
});

function printMarkerResults(results, { identity = false } = {}) {
  for (const r of results) {
    const vis = r.visibleCorners.map((c) => CORNER_NAME[c]).join('、') || '无（全在无效区）';
    const inv = r.invalidCorners.map((c) => CORNER_NAME[c]).join('、') || '无';
    process.stdout.write(
      `    ${EYE_NAME[r.eye]}：可见角[${vis}] ${identity ? `标识${r.markerOk ? '正确' : '错误'}` : '（重投影回查，身份随源位置变化）'}；` +
      `无效区角[${inv}]；帧号条=${r.seqRead}${r.seqRead === null ? '（落入无效区）' : r.seqOk ? '（与呈现帧一致）' : '（帧号不符）'}\n`
    );
    if (identity) for (const f of r.failures) process.stdout.write(`      ✗ ${f.message}\n`);
  }
}

function passTag(ok) { return ok ? 'PASS' : 'FAIL'; }

function cmdRun(args) {
  const report = runAll(opts(args));
  let fails = 0;
  const identitySuites = new Set(['交叉完成与迟到栅栏单步放行', '旧/新工程双眼四角核对', '纹理原点翻转定位', '矩阵翻转定位']);
  for (const s of report.suites) {
    process.stdout.write(`[${passTag(s.pass)}] ${s.name}\n`);
    if (s.markerResults) printMarkerResults(s.markerResults, { identity: identitySuites.has(s.name) || s.name.includes('交叉') });
    if (s.firstFailures) {
      for (const f of s.firstFailures) process.stdout.write(`    ${EYE_NAME[f.eye]} 先错：${f.first}\n`);
    }
    if (s.reports) {
      for (const c of s.reports) {
        process.stdout.write(`    - ${c.label}（pitch=${c.hasPitch} roll=${c.hasRoll}）帧 #${c.seq}\n`);
        printMarkerResults(c.results, { identity: true });
      }
    }
    if (s.log) for (const l of s.log) process.stdout.write(`    · ${l}\n`);
    if (s.errorName) process.stdout.write(`    · 后端拒绝读取：${s.errorName}；旧记录状态=${s.legacyStatus}\n`);
    if (s.replayBytes != null) {
      process.stdout.write(`    · 重放 ${s.events} 个事件、${s.replayBytes} 字节；代际守卫=${s.generationGuard} 后端守卫=${s.backendGuard}\n`);
    }
    if (s.maxOmegaDegPerSec != null) process.stdout.write(`    · 峰值角速度 |ω|=${s.maxOmegaDegPerSec.toFixed(1)} °/s\n`);
    if (!s.pass) fails++;
  }
  process.stdout.write(`\n汇总：${report.suites.length - fails}/${report.suites.length} 个场景通过\n`);
  if (!report.pass) process.exit(1);
}

function cmdReplay(args) {
  const r = scenarioReplay(opts(args));
  process.stdout.write(`[${passTag(r.pass)}] ${r.name}（${r.events} 事件 / ${r.replayBytes} B）\n`);
  if (args.out) {
    writeFileSync(args.out, r.replayText);
    process.stdout.write(`已写入最小重放：${args.out}\n`);
  } else {
    process.stdout.write(r.replayText + '\n');
  }
  if (!r.pass) process.exit(1);
}

function cmdFlip(args) {
  const mode = args.mode === 'matrix' ? FLIP.MATRIX : FLIP.TEX_ORIGIN;
  const r = scenarioFlipDiagnosis(mode);
  process.stdout.write(`[${passTag(r.pass)}] ${r.name}（对照组通过=${r.controlPass}）\n`);
  for (const f of r.firstFailures) process.stdout.write(`  ${EYE_NAME[f.eye]} 先错：${f.first}\n`);
  if (!r.pass || !r.controlPass) process.exit(1);
}

function cmdCorners(args) {
  const r = scenarioLegacyAndTriad(opts(args));
  process.stdout.write(`[${passTag(r.pass)}] ${r.name}\n`);
  for (const c of r.reports) {
    process.stdout.write(`  ${c.label}（帧 #${c.seq}）\n`);
    printMarkerResults(c.results, { identity: true });
  }
  if (!r.pass) process.exit(1);
}

function cmdInterleave(args) {
  const r = scenarioInterleave(opts(args));
  process.stdout.write(`[${passTag(r.pass)}] ${r.name}\n`);
  for (const l of r.log) process.stdout.write(`  · ${l}\n`);
  printMarkerResults(r.markerResults);
  if (!r.pass) process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const commands = {
  run: cmdRun,
  replay: cmdReplay,
  flip: cmdFlip,
  corners: cmdCorners,
  interleave: cmdInterleave,
};
if (commands[cmd]) {
  commands[cmd](args);
} else {
  process.stderr.write([
    '用法：node cli/migrate-verify.js <command> [--width 160] [--height 120] [--slots 2] [--out file.json]',
    '  run         全部迁移场景（交叉完成/快速转头/槽复用/翻转/旧新工程/重放）',
    '  interleave  标号不同的两帧交叉完成，手动单步放行迟到栅栏，对比 wait/discard',
    '  corners     纯偏航旧工程与三轴新工程，双眼各读四个不对称角标',
    '  flip        翻转定位：--mode origin（纹理原点）或 --mode matrix（矩阵）',
    '  replay      含纹理复用的最小重放（--out 写入 JSON）',
  ].join('\n') + '\n');
  process.exit(1);
}
