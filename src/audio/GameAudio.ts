/**
 * 游戏里所有的声音。没有用任何录音素材：引擎、胎噪、风、雨、碰撞、提示音全部是用
 * Web Audio 现场合成的（振荡器 + 噪声 + 滤波器）。
 *
 * 结构：各个声源 → 分组音量 → 主音量 → 压限器 → 输出。
 * 持续的声音（引擎、胎噪、风、雨…）一直开着，每帧按车的状态调音量和滤波；
 * 一次性的声音（碰撞、回火、提示音）触发时临时建几个节点，放完自己销毁。
 */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 每帧传进来的状态：持续的声音跟着它变 */
export interface DrivingSound {
  /** 引擎转速（转/分） */
  rpm: number;
  redline: number;
  /** 油门 0–1 */
  throttle: number;
  /** 车速（米/秒） */
  speed: number;
  /** 轮胎打滑的程度 0–1（四个轮子里最大的） */
  skid: number;
  /** 路面有多湿 0–1 */
  wet: number;
  /** 雨有多大 0–1 */
  rain: number;
  nitro: boolean;
  /** 是不是驾驶室视角（外面的声音会闷一些） */
  cockpit: boolean;
  /** 有没有轮子着地 */
  grounded: boolean;
  shifting: boolean;
}

/** 一辆对手车的声音状态 */
export interface RivalSound {
  rpm: number;
  /** 离镜头多远（米） */
  distance: number;
  /** 左右声道：-1 在左边，1 在右边 */
  pan: number;
  /** 正在靠近镜头的速度（米/秒，远离为负） */
  closing: number;
}

export type Cue = 'count' | 'go' | 'gate' | 'lap' | 'bestLap' | 'finalLap' | 'finish' | 'win' | 'click' | 'hover' | 'back' | 'up' | 'down';

interface RivalVoice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

const MAX_RIVAL_VOICES = 7;

/** 给一个参数设目标值，带一点平滑（避免咔哒声） */
function aim(p: AudioParam, value: number, now: number, tau = 0.04): void {
  p.setTargetAtTime(value, now, tau);
}

/**
 * 一次性声音的音量包络：几毫秒内冲到最响，然后自然衰减。
 * seconds 是"听得见的长度"：到那个时候大约已经降了 30 分贝
 */
function envelope(p: AudioParam, gain: number, t: number, seconds: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(gain, t + 0.005);
  p.setTargetAtTime(0, t + 0.005, seconds / 3.5);
}

export class GameAudio {
  /** 主音量 0–1 */
  volume = 0.7;
  muted = false;

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private drive!: GainNode;
  private ui!: GainNode;
  /** 驾驶室视角下，外面的声音过一道低通 */
  private outside!: BiquadFilterNode;

  private noiseWhite!: AudioBuffer;
  private noisePink!: AudioBuffer;
  private noiseBrown!: AudioBuffer;

  /* 引擎 */
  private engOsc!: OscillatorNode;
  private engRasp!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engGain!: GainNode;
  private engRaspGain!: GainNode;
  private engSubGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private engRaspFilter!: BiquadFilterNode;
  private engDrive!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  private intakeGain!: GainNode;
  private load = 0;
  private limiter = 0;

  /* 轮胎、路面、风、雨、氮气 */
  private skidA!: BiquadFilterNode;
  private skidB!: BiquadFilterNode;
  private skidGain!: GainNode;
  private hissGain!: GainNode;
  private roadGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private rainGain!: GainNode;
  private rainLow!: GainNode;
  private nitroGain!: GainNode;
  private nitroFilter!: BiquadFilterNode;

  private readonly rivals: RivalVoice[] = [];
  private driving = false;
  private wasNitro = false;
  private wasShifting = false;

  /** 是否已经可以出声（浏览器要求先有一次点击或按键） */
  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** 在用户第一次点击或按键时调用：创建并启动音频 */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.build(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 调试、离线分析用：在指定的音频环境里搭一遍（不自动播放提示音） */
  attach(ctx: BaseAudioContext): void {
    this.ctx = ctx as AudioContext;
    this.build(ctx);
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.applyVolume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.ctx) return;
    // 滑块按"听感"走：平方一下，低音量那一段更好调
    aim(this.master.gain, this.muted ? 0 : this.volume * this.volume * 1.4, this.ctx.currentTime, 0.05);
  }

  /** 暂停、切到后台：整个停住；回来再继续 */
  suspend(on: boolean): void {
    if (!this.ctx || !('suspend' in this.ctx)) return;
    if (on && this.ctx.state === 'running') void this.ctx.suspend();
    if (!on && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 进出试驾：驾驶相关的声音整体淡入淡出 */
  setDriving(on: boolean): void {
    this.driving = on;
    if (!this.ctx) return;
    aim(this.drive.gain, on ? 1 : 0, this.ctx.currentTime, on ? 0.25 : 0.12);
  }

  /* ------------------------------ 搭建 ------------------------------ */

  private noise(ctx: BaseAudioContext, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 2.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') {
        d[i] = w * 0.5;
      } else if (kind === 'pink') {
        // Paul Kellet 的粉噪近似
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    // 首尾接上，循环播放时没有接缝
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
    return buf;
  }

  private loop(ctx: BaseAudioContext, buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopEnd = buf.duration - 0.05;
    src.playbackRate.value = rate;
    src.start(0, Math.random() * 2);
    return src;
  }

  /**
   * 引擎的波形：一个工作循环（曲轴转两圈）里八个缸各点一次火。
   * 把它拆成谐波：第 8、16、24… 次（点火频率及其倍频）最强，第 4、12… 次次之（V8 的"咕噜"声），
   * 其余的很弱但不能没有，否则声音太干净、像电子琴。
   */
  private engineWave(ctx: BaseAudioContext, bright: boolean): PeriodicWave {
    const n = 128;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    let seed = bright ? 77 : 13;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let h = 1; h < n; h++) {
      let w = h % 8 === 0 ? 1 : h % 4 === 0 ? 0.5 : h % 2 === 0 ? 0.2 : 0.09;
      const fall = bright ? Math.pow(h, -0.35) : Math.pow(h, -0.85);
      if (bright && h < 16) w *= 0.15;
      if (!bright && h < 4) w *= 0.5;
      const a = w * fall * (0.75 + 0.5 * rnd());
      const ph = rnd() * Math.PI * 2;
      real[h] = a * Math.cos(ph);
      imag[h] = a * Math.sin(ph);
    }
    return ctx.createPeriodicWave(real, imag);
  }

  private build(ctx: BaseAudioContext): void {
    this.noiseWhite = this.noise(ctx, 'white');
    this.noisePink = this.noise(ctx, 'pink');
    this.noiseBrown = this.noise(ctx, 'brown');

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume * this.volume * 1.4;
    this.master.connect(comp);

    this.ui = ctx.createGain();
    this.ui.gain.value = 1.25;
    this.ui.connect(this.master);
    this.drive = ctx.createGain();
    this.drive.gain.value = this.driving ? 1 : 0;
    this.drive.connect(this.master);
    this.outside = ctx.createBiquadFilter();
    this.outside.type = 'lowpass';
    this.outside.frequency.value = 18000;
    this.outside.Q.value = 0.5;
    this.outside.connect(this.drive);

    /* ---- 引擎 ---- */
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engGain.connect(this.drive);
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 700;
    this.engFilter.Q.value = 0.9;
    this.engFilter.connect(this.engGain);
    // 一点点失真：大油门时声音更"炸"
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    shaper.connect(this.engFilter);
    this.engDrive = ctx.createGain();
    this.engDrive.gain.value = 0.5;
    this.engDrive.connect(shaper);
    this.engOsc = ctx.createOscillator();
    this.engOsc.setPeriodicWave(this.engineWave(ctx, false));
    this.engOsc.frequency.value = 8;
    this.engOsc.connect(this.engDrive);
    this.engOsc.start();

    // 高转速时的"嘶吼"：高次谐波单独一路，过带通
    this.engRaspFilter = ctx.createBiquadFilter();
    this.engRaspFilter.type = 'bandpass';
    this.engRaspFilter.frequency.value = 1800;
    this.engRaspFilter.Q.value = 0.7;
    this.engRaspGain = ctx.createGain();
    this.engRaspGain.gain.value = 0;
    this.engRasp = ctx.createOscillator();
    this.engRasp.setPeriodicWave(this.engineWave(ctx, true));
    this.engRasp.frequency.value = 8;
    this.engRasp.connect(this.engRaspFilter);
    this.engRaspFilter.connect(this.engRaspGain);
    this.engRaspGain.connect(this.engGain);
    this.engRasp.start();

    // 低转速时在点火频率上垫一层正弦，怠速更厚
    this.engSub = ctx.createOscillator();
    this.engSub.type = 'sine';
    this.engSub.frequency.value = 64;
    this.engSubGain = ctx.createGain();
    this.engSubGain.gain.value = 0;
    this.engSub.connect(this.engSubGain);
    this.engSubGain.connect(this.engGain);
    this.engSub.start();

    // 进气声：噪声过带通，跟着点火频率走
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 300;
    this.intakeFilter.Q.value = 1.1;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    const intake = this.loop(ctx, this.noisePink);
    intake.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.engGain);

    /* ---- 轮胎尖叫：粉噪过两个窄带通 ---- */
    const squeal = this.loop(ctx, this.noisePink, 1.1);
    this.skidA = ctx.createBiquadFilter();
    this.skidA.type = 'bandpass';
    this.skidA.frequency.value = 950;
    this.skidA.Q.value = 6;
    this.skidB = ctx.createBiquadFilter();
    this.skidB.type = 'bandpass';
    this.skidB.frequency.value = 1700;
    this.skidB.Q.value = 9;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    squeal.connect(this.skidA);
    squeal.connect(this.skidB);
    this.skidA.connect(this.skidGain);
    this.skidB.connect(this.skidGain);
    this.skidGain.connect(this.outside);

    /* ---- 湿地面：轮胎压水的沙沙声 ---- */
    const hiss = this.loop(ctx, this.noiseWhite, 0.9);
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'highpass';
    hissFilter.frequency.value = 2600;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    hiss.connect(hissFilter);
    hissFilter.connect(this.hissGain);
    this.hissGain.connect(this.outside);

    /* ---- 路噪 ---- */
    const road = this.loop(ctx, this.noiseBrown);
    const roadFilter = ctx.createBiquadFilter();
    roadFilter.type = 'lowpass';
    roadFilter.frequency.value = 190;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    road.connect(roadFilter);
    roadFilter.connect(this.roadGain);
    this.roadGain.connect(this.drive);

    /* ---- 风 ---- */
    const wind = this.loop(ctx, this.noisePink, 0.8);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.45;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.outside);

    /* ---- 雨：高频的沙沙声 + 低频的一片 ---- */
    const rain = this.loop(ctx, this.noiseWhite);
    const rainHi = ctx.createBiquadFilter();
    rainHi.type = 'highpass';
    rainHi.frequency.value = 1900;
    const rainLo = ctx.createBiquadFilter();
    rainLo.type = 'lowpass';
    rainLo.frequency.value = 8500;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(rainHi);
    rainHi.connect(rainLo);
    rainLo.connect(this.rainGain);
    this.rainGain.connect(this.outside);
    const rumble = this.loop(ctx, this.noisePink, 0.6);
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 420;
    this.rainLow = ctx.createGain();
    this.rainLow.gain.value = 0;
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(this.rainLow);
    this.rainLow.connect(this.drive);

    /* ---- 氮气：一股持续的喷气声 ---- */
    const jet = this.loop(ctx, this.noiseWhite, 1.2);
    this.nitroFilter = ctx.createBiquadFilter();
    this.nitroFilter.type = 'bandpass';
    this.nitroFilter.frequency.value = 1500;
    this.nitroFilter.Q.value = 0.7;
    this.nitroGain = ctx.createGain();
    this.nitroGain.gain.value = 0;
    jet.connect(this.nitroFilter);
    this.nitroFilter.connect(this.nitroGain);
    this.nitroGain.connect(this.drive);

    /* ---- 对手的引擎：每辆一个振荡器，带左右声像 ---- */
    const wave = this.engineWave(ctx, false);
    for (let i = 0; i < MAX_RIVAL_VOICES; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = 10;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(pan);
      pan.connect(this.outside);
      osc.start();
      this.rivals.push({ osc, filter, gain, pan });
    }
  }

  /* ------------------------------ 每帧 ------------------------------ */

  /** 每帧调用：持续的声音跟着车的状态变 */
  update(dt: number, s: DrivingSound, rivals: RivalSound[] = []): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const rpmN = clamp(s.rpm / s.redline, 0.08, 1.02);
    // 引擎负荷：踩油门立刻上来，松油门慢一点下去
    const target = s.throttle;
    this.load += (target - this.load) * (1 - Math.exp(-dt * (target > this.load ? 14 : 6)));
    const load = this.load;

    // 断油：顶到红线时声音一顿一顿的
    let cut = 1;
    if (rpmN > 0.985 && s.throttle > 0.5) {
      this.limiter += dt * 17;
      cut = Math.sin(this.limiter * Math.PI * 2) > 0 ? 1 : 0.35;
    }

    // 一个工作循环的频率 = 转速 / 120；氮气时音调略微拔高
    const f0 = (s.rpm / 120) * (s.nitro ? 1.03 : 1) * (1 + (Math.random() - 0.5) * 0.004);
    aim(this.engOsc.frequency, f0, now, 0.03);
    aim(this.engRasp.frequency, f0, now, 0.03);
    aim(this.engSub.frequency, f0 * 8, now, 0.03);

    const open = 0.3 + 0.7 * load;
    aim(this.engDrive.gain, 0.35 + 0.9 * load, now);
    aim(this.engFilter.frequency, 260 + 5200 * Math.pow(rpmN, 1.25) * open, now);
    aim(this.engGain.gain, (0.13 + 0.2 * load + 0.12 * rpmN) * cut * (s.shifting ? 0.55 : 1), now, 0.02);
    aim(this.engRaspFilter.frequency, 900 + 3200 * rpmN, now);
    aim(this.engRaspGain.gain, 0.5 * rpmN * rpmN * (0.25 + 0.75 * load), now);
    aim(this.engSubGain.gain, 0.6 * (1 - rpmN) * (0.5 + 0.5 * load), now);
    aim(this.intakeFilter.frequency, clamp(f0 * 16, 120, 2400), now);
    aim(this.intakeGain.gain, 0.5 * load * (0.3 + 0.7 * rpmN), now);

    // 轮胎：干地尖叫，湿地是压水的沙沙声
    const dry = 1 - clamp(s.wet * 1.4, 0, 1);
    const skid = s.grounded ? s.skid : 0;
    aim(this.skidA.frequency, 820 + s.speed * 9, now, 0.08);
    aim(this.skidB.frequency, 1500 + s.speed * 14, now, 0.08);
    aim(this.skidGain.gain, Math.pow(skid, 1.4) * 0.42 * dry, now, 0.05);
    const rolling = s.grounded ? clamp(s.speed / 45, 0, 1) : 0;
    aim(this.hissGain.gain, (rolling * 0.055 + skid * 0.1) * (1 - dry), now, 0.08);
    aim(this.roadGain.gain, rolling * 0.34, now, 0.1);

    const vN = clamp(s.speed / 75, 0, 1.2);
    aim(this.windFilter.frequency, 380 + s.speed * 20, now, 0.1);
    aim(this.windGain.gain, vN * vN * (s.cockpit ? 0.45 : 0.7), now, 0.1);

    aim(this.rainGain.gain, s.rain * 0.2, now, 0.3);
    aim(this.rainLow.gain, s.rain * 0.24, now, 0.3);

    aim(this.nitroGain.gain, s.nitro ? 0.2 : 0, now, s.nitro ? 0.04 : 0.18);
    aim(this.nitroFilter.frequency, 1300 + s.speed * 12, now, 0.1);
    if (s.nitro && !this.wasNitro) this.burst(0.35, 0.3, 2400, 'highpass');
    this.wasNitro = s.nitro;
    if (s.shifting && !this.wasShifting) this.burst(0.1, 0.03, 1800, 'highpass');
    this.wasShifting = s.shifting;

    // 驾驶室里：外面的声音隔了一层玻璃
    aim(this.outside.frequency, s.cockpit ? 1500 : 18000, now, 0.15);

    for (let i = 0; i < this.rivals.length; i++) {
      const v = this.rivals[i];
      const r = rivals[i];
      if (!r) {
        aim(v.gain.gain, 0, now, 0.1);
        continue;
      }
      const doppler = 1 + clamp(r.closing / 343, -0.12, 0.12);
      aim(v.osc.frequency, (r.rpm / 120) * doppler, now, 0.05);
      const near = 9 / (9 + r.distance);
      aim(v.gain.gain, r.distance > 160 ? 0 : 0.55 * near, now, 0.08);
      aim(v.filter.frequency, 500 + 2600 * near, now, 0.1);
      aim(v.pan.pan, clamp(r.pan, -0.9, 0.9), now, 0.08);
    }
  }

  /* ------------------------------ 一次性的声音 ------------------------------ */

  /** 一小段噪声：音量、时长、滤波频率 */
  private burst(gain: number, seconds: number, freq: number, type: BiquadFilterType, bus?: AudioNode, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseWhite;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    envelope(g.gain, gain, t, seconds);
    src.connect(f);
    f.connect(g);
    g.connect(bus ?? this.drive);
    src.start(t, Math.random() * 2);
    src.stop(t + seconds * 1.7 + 0.05);
  }

  /** 一声从 from 滑到 to 的音：闷响、提示音都用它 */
  private tone(from: number, to: number, seconds: number, gain: number, type: OscillatorType, bus?: AudioNode, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + seconds);
    const g = ctx.createGain();
    envelope(g.gain, gain, t, seconds);
    o.connect(g);
    g.connect(bus ?? this.drive);
    o.start(t);
    o.stop(t + seconds * 1.7 + 0.05);
  }

  /** 撞到东西：一声闷响 + 一把碎响，越重越响 */
  impact(strength: number): void {
    const s = clamp(strength, 0, 1);
    this.tone(95 + 40 * s, 42, 0.16 + 0.12 * s, 0.5 + 0.5 * s, 'sine');
    this.burst(0.25 + 0.5 * s, 0.1 + 0.16 * s, 700 + 600 * s, 'bandpass');
    if (s > 0.25) this.burst(0.12 * s, 0.22, 3200, 'highpass');
  }

  /** 蹭墙、火花：短促的刮擦声 */
  scrape(strength: number): void {
    this.burst(0.5 + 0.8 * clamp(strength, 0, 1), 0.12, 2600, 'bandpass');
    this.burst(0.25, 0.1, 500, 'lowpass');
  }

  /** 腾空落地 */
  landing(strength: number): void {
    const s = clamp(strength, 0, 1);
    this.tone(72, 34, 0.28, 0.5 + 0.5 * s, 'sine');
    this.burst(0.3 * s + 0.1, 0.14, 260, 'lowpass');
  }

  /** 排气回火："啪"的一声 */
  backfire(strength: number): void {
    const s = clamp(strength, 0, 1);
    this.burst(0.8 + 0.6 * s, 0.06 + 0.03 * s, 1300 + Math.random() * 500, 'lowpass');
    this.tone(150 + Math.random() * 40, 70, 0.07, 0.6 + 0.4 * s, 'triangle');
    // 偶尔连着响两下
    if (Math.random() < 0.4) this.burst(0.5 + 0.4 * s, 0.05, 1500, 'lowpass', undefined, 0.07 + Math.random() * 0.05);
  }

  /** 镜头切换的一声：低沉的一下撞击，带一点"嗖"的气流声（赛前的特写镜头每切一次响一下） */
  whoosh(strength = 1): void {
    const s = clamp(strength, 0, 1);
    this.tone(58, 30, 0.34, 0.5 * s, 'sine');
    this.burst(0.3 * s, 0.22, 900, 'bandpass');
    this.burst(0.16 * s, 0.3, 240, 'lowpass');
  }

  /** 打雷：闪电之后隔一会儿，一阵由强到弱的低频滚动 */
  thunder(delay = 0.5): void {
    const ctx = this.ctx;
    if (!ctx || !this.driving) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBrown;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
    src.connect(f);
    f.connect(g);
    g.connect(this.drive);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 4.4);
  }

  /** 界面和比赛的提示音 */
  cue(kind: Cue): void {
    if (!this.ctx) return;
    const ui = this.ui;
    const note = (f: number, at: number, len: number, gain = 0.3, type: OscillatorType = 'triangle') => this.tone(f, f, len, gain, type, ui, at);
    switch (kind) {
      case 'count':
        note(520, 0, 0.16, 0.35, 'square');
        break;
      case 'go':
        note(1040, 0, 0.5, 0.35, 'square');
        note(1560, 0, 0.5, 0.12, 'sine');
        break;
      case 'gate':
        note(880, 0, 0.09, 0.4);
        note(1320, 0.07, 0.14, 0.4);
        break;
      case 'lap':
        note(660, 0, 0.1);
        note(880, 0.09, 0.1);
        note(1320, 0.18, 0.2);
        break;
      case 'bestLap':
        note(784, 0, 0.09);
        note(988, 0.08, 0.09);
        note(1175, 0.16, 0.09);
        note(1568, 0.24, 0.26);
        break;
      case 'finalLap':
        note(988, 0, 0.12, 0.3, 'square');
        note(988, 0.18, 0.12, 0.3, 'square');
        note(1319, 0.36, 0.3, 0.3, 'square');
        break;
      case 'finish':
        note(523, 0, 0.14);
        note(659, 0.13, 0.14);
        note(784, 0.26, 0.14);
        note(1047, 0.39, 0.5, 0.35);
        break;
      case 'win':
        note(523, 0, 0.12);
        note(659, 0.11, 0.12);
        note(784, 0.22, 0.12);
        note(1047, 0.33, 0.18);
        note(784, 0.5, 0.1);
        note(1047, 0.6, 0.7, 0.38);
        note(1319, 0.6, 0.7, 0.2, 'sine');
        break;
      case 'up':
        note(740, 0, 0.07, 0.3);
        note(1110, 0.06, 0.12, 0.3);
        break;
      case 'down':
        note(520, 0, 0.07, 0.3);
        note(390, 0.06, 0.14, 0.3);
        break;
      case 'hover':
        this.tone(1500, 1500, 0.03, 0.14, 'sine', ui);
        break;
      case 'click':
        this.tone(620, 930, 0.07, 0.34, 'triangle', ui);
        break;
      case 'back':
        this.tone(700, 440, 0.08, 0.3, 'triangle', ui);
        break;
    }
  }
}
