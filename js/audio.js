// 空间音：一个固定于世界 +X 方向的周期性声源；
// AudioListener 的前/上向量每帧与最新头部姿态同步（HRTF PannerNode）。

import { quatRotate } from './math3d.js';

export class SpatialAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const ctx = this.ctx;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 20;
    panner.rolloffFactor = 1;
    panner.positionX.value = 5;  // 世界 +X，与 0° 立柱同向
    panner.positionY.value = 0.8;
    panner.positionZ.value = 0;

    // 周期性提示音：0.5 Hz 门控的 440 Hz 正弦 + 二次谐波
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 440;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 880;
    const gain2 = ctx.createGain();
    gain2.gain.value = 0.25;

    const gate = ctx.createGain();
    gate.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    const base = ctx.createConstantSource();
    base.offset.value = 0.5;
    base.connect(lfoGain).connect(gate.gain);
    lfo.connect(lfoGain);

    osc1.connect(gate);
    osc2.connect(gain2).connect(gate);
    gate.connect(panner).connect(ctx.destination);
    osc1.start();
    osc2.start();
    lfo.start();
    base.start();

    this.panner = panner;
    this.started = true;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  stop() {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
      this.started = false;
    }
  }

  // q = 最新头部姿态四元数；听者位于原点
  updateListener(q) {
    if (!this.started) return;
    const ctx = this.ctx;
    const forward = quatRotate(q, [0, 0, -1]);
    const up = quatRotate(q, [0, 1, 0]);
    const l = ctx.listener;
    if (l.orientationX) {
      l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0;
      l.forwardX.value = forward[0];
      l.forwardY.value = forward[1];
      l.forwardZ.value = forward[2];
      l.upX.value = up[0];
      l.upY.value = up[1];
      l.upZ.value = up[2];
    } else {
      l.setPosition(0, 0, 0);
      l.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }
  }
}
