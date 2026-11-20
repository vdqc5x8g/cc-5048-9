// 可重复的头部旋转轨迹：纯函数，浏览器与 CLI 共用同一公式。
// 旧工程参数（legacy，默认）仅产生 yaw（绕 +Y），pitch/roll 恒为 0；
// 新工程可通过 pitch*/roll* 参数启用三轴（后端与着色器本就按四元数处理）。

import { deg2rad, rad2deg, quatYawPitchRoll } from './math3d.js';

// 旧工程默认参数：只有偏航
export const DEFAULT_TRAJECTORY = {
  amplitudeDeg: 45,
  frequencyHz: 0.8,
  phaseDeg: 0,
  pitchAmplitudeDeg: 0,
  pitchFrequencyHz: 0,
  pitchPhaseDeg: 0,
  rollAmplitudeDeg: 0,
  rollFrequencyHz: 0,
  rollPhaseDeg: 0,
};

// 新工程示例参数：偏航 + 俯仰 + 滚转（频率/相位错开，保证三轴可区分）
export const TRIAD_TRAJECTORY = {
  amplitudeDeg: 45,
  frequencyHz: 0.8,
  phaseDeg: 0,
  pitchAmplitudeDeg: 22,
  pitchFrequencyHz: 1.1,
  pitchPhaseDeg: 40,
  rollAmplitudeDeg: 14,
  rollFrequencyHz: 1.4,
  rollPhaseDeg: 80,
};

// yaw(t) = A * sin(2π f t + φ)
export function yawAt(tSec, params = DEFAULT_TRAJECTORY) {
  const A = deg2rad(params.amplitudeDeg);
  const phi = deg2rad(params.phaseDeg);
  return A * Math.sin(2 * Math.PI * params.frequencyHz * tSec + phi);
}

// dyaw/dt
export function yawRateAt(tSec, params = DEFAULT_TRAJECTORY) {
  const A = deg2rad(params.amplitudeDeg);
  const phi = deg2rad(params.phaseDeg);
  return A * 2 * Math.PI * params.frequencyHz *
    Math.cos(2 * Math.PI * params.frequencyHz * tSec + phi);
}

// 单轴正弦角（缺省轴参数时恒为 0，保证旧参数轨迹与历史完全一致）
function axisAngleAt(tSec, ampDeg, freqHz, phaseDeg) {
  if (!ampDeg || !freqHz) return 0;
  const A = deg2rad(ampDeg);
  const phi = deg2rad(phaseDeg || 0);
  return A * Math.sin(2 * Math.PI * freqHz * tSec + phi);
}

export function pitchAt(tSec, params = DEFAULT_TRAJECTORY) {
  return axisAngleAt(tSec, params.pitchAmplitudeDeg, params.pitchFrequencyHz, params.pitchPhaseDeg);
}

export function rollAt(tSec, params = DEFAULT_TRAJECTORY) {
  return axisAngleAt(tSec, params.rollAmplitudeDeg, params.rollFrequencyHz, params.rollPhaseDeg);
}

export function orientationAt(tSec, params = DEFAULT_TRAJECTORY) {
  return quatYawPitchRoll(yawAt(tSec, params), pitchAt(tSec, params), rollAt(tSec, params));
}

export function stateAt(tSec, params = DEFAULT_TRAJECTORY) {
  const pitchDeg = rad2deg(pitchAt(tSec, params));
  const rollDeg = rad2deg(rollAt(tSec, params));
  return {
    t: tSec,
    yawRad: yawAt(tSec, params),
    yawDeg: rad2deg(yawAt(tSec, params)),
    yawRateRad: yawRateAt(tSec, params),
    yawRateDeg: rad2deg(yawRateAt(tSec, params)),
    pitchDeg,
    rollDeg,
    quat: orientationAt(tSec, params),
  };
}

// 角速度扫描实验使用的轨迹：频率随时间线性爬升，振幅固定。
// 由 main.js 在扫描模式下替换参数，CLI 可独立复现数值表。
export function sweepParamsAt(tSec, amplitudeDeg = 45) {
  const freq = 0.2 + 0.5 * tSec; // 0.2 → 5.2 Hz（10 s）
  return { ...DEFAULT_TRAJECTORY, amplitudeDeg, frequencyHz: freq, phaseDeg: 0 };
}

// 给定时刻扫描轨迹的状态（频率随时间变化，需按积分形式求 yaw）
export function sweepStateAt(tSec, amplitudeDeg = 45) {
  const A = deg2rad(amplitudeDeg);
  const f0 = 0.2;
  const k = 0.5;
  // ∫2π(f0 + k t) dt = 2π(f0 t + k t²/2)
  const phase = 2 * Math.PI * (f0 * tSec + 0.5 * k * tSec * tSec);
  const yaw = A * Math.sin(phase);
  const omega = A * 2 * Math.PI * (f0 + k * tSec) * Math.cos(phase);
  return {
    t: tSec,
    yawRad: yaw,
    yawDeg: rad2deg(yaw),
    yawRateRad: omega,
    yawRateDeg: rad2deg(omega),
    pitchDeg: 0,
    rollDeg: 0,
    quat: quatYawPitchRoll(yaw, 0, 0),
  };
}
