// 可重复的头部旋转轨迹：纯函数，浏览器与 CLI 共用同一公式。
// 初版仅产生 yaw（绕 +Y）；pitch/roll 恒为 0，数学管线本身支持三轴。

import { deg2rad, rad2deg, quatYawPitchRoll } from './math3d.js';

export const DEFAULT_TRAJECTORY = {
  amplitudeDeg: 45,
  frequencyHz: 0.8,
  phaseDeg: 0,
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

export function orientationAt(tSec, params = DEFAULT_TRAJECTORY) {
  return quatYawPitchRoll(yawAt(tSec, params), 0, 0);
}

export function stateAt(tSec, params = DEFAULT_TRAJECTORY) {
  return {
    t: tSec,
    yawRad: yawAt(tSec, params),
    yawDeg: rad2deg(yawAt(tSec, params)),
    yawRateRad: yawRateAt(tSec, params),
    yawRateDeg: rad2deg(yawRateAt(tSec, params)),
    quat: orientationAt(tSec, params),
  };
}

// 角速度扫描实验使用的轨迹：频率随时间线性爬升，振幅固定。
// 由 main.js 在扫描模式下替换参数，CLI 可独立复现数值表。
export function sweepParamsAt(tSec, amplitudeDeg = 45) {
  const freq = 0.2 + 0.5 * tSec; // 0.2 → 5.2 Hz（10 s）
  return { amplitudeDeg, frequencyHz: freq, phaseDeg: 0 };
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
    quat: quatYawPitchRoll(yaw, 0, 0),
  };
}
