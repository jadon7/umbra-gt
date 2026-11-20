/**
 * 宣传片的配乐：全部用代码合成（没有任何录音素材），写成 48 kHz 立体声 WAV。
 *
 * 120 拍/分钟，一拍 0.5 秒 = 视频的 30 帧，所以剪辑点都落在拍子上。D 小调，和弦 Dm – B♭ – F – C 每小节换一个。
 * 段落和剪辑一一对应（时间单位：秒）：
 *   0–8    开场：雨声、低音铺底、心跳一样的底鼓，最后两拍往上推
 *   8      标题：一声重击
 *   10–20  赛前镜头：四拍底鼓、八分音符的低音、踩镲，最后一小节军鼓滚奏 + 引擎轰油门
 *   20     GO：全段落进来（底鼓、军鼓、滚动的低音、琶音），漂移、氮气、三台车
 *   27.5   氮气点火：引擎拉高
 *   34–36  拱桥慢动作：鼓全停，只剩一声重击和铺底
 *   36–46  再进来：雪天、小地图、黄昏、车库
 *   46–48  上推 + 车冲过镜头的呼啸
 *   48     结尾卡：最后一下重击，和弦拖尾到结束
 *
 * 运行：node promo/music.ts [输出.wav]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK } from './browser.ts';

const SR = 48000;
const BPM = 120;
const BEAT = 60 / BPM;
/** 段落（单位：拍，一拍 0.5 秒）和长度（秒），和 edit.ts 的时间线对齐 */
const SECTIONS = {
  title: 12,
  pre: 20,
  go: 36,
  nitro: [50],
  mountain: 56,
  again: 72,
  garage: 86,
  hero: 92,
  /** 车擦过镜头的那一刻（秒） */
  pass: 47.2,
  end: 96,
};
const LENGTH = 55;
const N = Math.round(LENGTH * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);
/** 送进混响的那一路 */
const RL = new Float32Array(N);
const RR = new Float32Array(N);

/* ---------- 小工具 ---------- */
let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const noise = () => rnd() * 2 - 1;
const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** 把一段单声道信号加进总线：增益、声像（-1 左 … 1 右）、送混响多少 */
function put(at: number, buf: Float32Array, gain: number, pan = 0, verb = 0): void {
  const i0 = Math.round(at * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < buf.length; i++) {
    const k = i0 + i;
    if (k < 0 || k >= N) continue;
    L[k] += buf[i] * gl;
    R[k] += buf[i] * gr;
    if (verb) {
      RL[k] += buf[i] * gl * verb;
      RR[k] += buf[i] * gr * verb;
    }
  }
}

/** RBJ 双二阶滤波器，可以逐块改截止频率 */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly type: 'lp' | 'hp' | 'bp';
  private q: number;
  constructor(type: 'lp' | 'hp' | 'bp', f: number, q = 0.707) {
    this.type = type;
    this.q = q;
    this.set(f);
  }
  set(f: number, q = this.q): void {
    const w = (2 * Math.PI * clamp(f, 10, SR * 0.45)) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0: number, b1: number, b2: number;
    if (this.type === 'lp') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else if (this.type === 'hp') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

const buf = (sec: number) => new Float32Array(Math.round(sec * SR));

/* ---------- 乐器 ---------- */

function kick(gain = 1): Float32Array {
  const b = buf(0.5);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t * 7.5);
    const click = i < 200 ? noise() * (1 - i / 200) * 0.35 : 0;
    b[i] = Math.tanh((Math.sin(ph) * env + click) * 1.6) * gain;
  }
  return b;
}

function snare(gain = 1): Float32Array {
  const b = buf(0.35);
  const bp = new Biquad('bp', 1900, 0.9);
  const hp = new Biquad('hp', 900);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (190 + 40 * Math.exp(-t * 40))) / SR;
    const body = Math.sin(ph) * Math.exp(-t * 22) * 0.5;
    const n = hp.run(bp.run(noise())) * Math.exp(-t * 13) * 1.8;
    b[i] = (body + n) * gain;
  }
  return b;
}

function hat(gain = 1, open = false): Float32Array {
  const b = buf(open ? 0.25 : 0.06);
  const hp = new Biquad('hp', 7500);
  const hp2 = new Biquad('hp', 7500);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    b[i] = hp2.run(hp.run(noise())) * Math.exp(-t * (open ? 14 : 70)) * gain;
  }
  return b;
}

/** 重击：次低音 + 一团带混响的噪声 */
function impact(gain = 1, len = 3.5): Float32Array {
  const b = buf(len);
  const lp = new Biquad('lp', 2400);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const f = 32 + 60 * Math.exp(-t * 6);
    ph += (2 * Math.PI * f) / SR;
    const sub = Math.sin(ph) * Math.exp(-t * 1.3);
    lp.set(300 + 3000 * Math.exp(-t * 3));
    const n = lp.run(noise()) * Math.exp(-t * 3.2) * 0.9;
    b[i] = Math.tanh((sub * 1.2 + n) * 1.3) * gain;
  }
  return b;
}

/** 往上推的噪声和音高（长度 len 秒，结束时最响） */
function riser(len: number, gain = 1): Float32Array {
  const b = buf(len);
  const bp = new Biquad('bp', 400, 2.5);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const k = t / len;
    if (i % 64 === 0) bp.set(300 + 7000 * k * k, 2.5);
    ph += (2 * Math.PI * (110 + 660 * k * k)) / SR;
    const tone = (Math.sin(ph) + 0.5 * Math.sin(ph * 2.01)) * 0.12;
    b[i] = (bp.run(noise()) * 1.6 + tone) * k * k * gain;
  }
  return b;
}

/** 失真的锯齿低音，一个音 */
function bassNote(freq: number, len: number, gain = 1, bright = 1): Float32Array {
  const b = buf(len + 0.05);
  const lp = new Biquad('lp', 300, 1.2);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    if (i % 32 === 0) lp.set(120 + 900 * bright * Math.exp(-t * 9));
    ph += freq / SR;
    const saw = 2 * (ph % 1) - 1;
    const sub = Math.sin(2 * Math.PI * ph * 0.5) * 0.6;
    const env = Math.min(1, t * 400) * (t < len ? 1 : Math.max(0, 1 - (t - len) * 20));
    b[i] = Math.tanh(lp.run(saw) * 1.8 + sub) * env * gain;
  }
  return b;
}

/** 铺底：几根略微跑调的锯齿波，低通，慢起慢收 */
function pad(notes: number[], len: number, gain = 1, cutoff = 900, attack = 0.6, release = 1.2): Float32Array {
  const b = buf(len + release);
  const lp = new Biquad('lp', cutoff, 0.8);
  const phs = notes.flatMap(() => [rnd(), rnd(), rnd()]);
  const det = [0.996, 1, 1.0045];
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    let s = 0;
    notes.forEach((m, n) => {
      const f = midi(m);
      for (let d = 0; d < 3; d++) {
        const k = n * 3 + d;
        phs[k] += (f * det[d]) / SR;
        s += 2 * (phs[k] % 1) - 1;
      }
    });
    if (i % 64 === 0) lp.set(cutoff * (0.75 + 0.25 * Math.sin(t * 1.3)));
    const env = Math.min(1, t / attack) * (t < len ? 1 : Math.max(0, 1 - (t - len) / release));
    b[i] = (lp.run(s) / (notes.length * 3)) * env * gain;
  }
  return b;
}

/** 拨弦一样的琶音音符 */
function pluck(m: number, gain = 1): Float32Array {
  const b = buf(0.4);
  const lp = new Biquad('lp', 3000, 1.5);
  let ph = 0;
  const f = midi(m);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    if (i % 32 === 0) lp.set(400 + 4200 * Math.exp(-t * 18));
    ph += f / SR;
    const sq = (ph % 1 < 0.5 ? 1 : -1) * 0.6 + (2 * (ph % 1) - 1) * 0.4;
    b[i] = lp.run(sq) * Math.exp(-t * 9) * gain;
  }
  return b;
}

/** 雨声：粉一点的噪声，带通 + 零星的雨点 */
function rain(len: number, gain = 1): Float32Array {
  const b = buf(len);
  const bp = new Biquad('bp', 2500, 0.5);
  const lp = new Biquad('lp', 6000);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    let s = bp.run(noise()) * 0.7;
    if (rnd() < 0.0009) s += noise() * 2.5;
    const env = Math.min(1, t / 1.5) * Math.min(1, (len - t) / 2);
    b[i] = lp.run(s) * env * gain;
  }
  return b;
}

/** 引擎：按 V8 的点火频率合成的一串谐波，转速从 r0 走到 r1（线性），带失真 */
function engine(len: number, r0: number, r1: number, gain = 1, curve: (k: number) => number = (k) => k): Float32Array {
  const b = buf(len);
  const lp = new Biquad('lp', 1200, 0.9);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const k = curve(t / len);
    const rpm = r0 + (r1 - r0) * k;
    const fire = (rpm / 60) * 4; // V8 每转点火 4 次
    ph += fire / SR;
    const p = ph % 1;
    // 点火脉冲 + 一点抖动，像排气
    let s = Math.exp(-p * 7) * 2 - 0.3 + Math.sin(2 * Math.PI * ph * 0.5) * 0.4;
    s += noise() * 0.15;
    if (i % 64 === 0) lp.set(500 + rpm * 0.35);
    const env = Math.min(1, t / 0.08) * Math.min(1, (len - t) / 0.15);
    b[i] = Math.tanh(lp.run(s) * 1.5) * env * gain;
  }
  return b;
}

/** 倒数的提示音：一个干净的正弦音，带一点点泛音 */
function beep(freq: number, len: number, gain = 1): Float32Array {
  const b = buf(len);
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t * 300) * Math.exp(-t * (3 / len));
    b[i] = (Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(4 * Math.PI * freq * t)) * env * gain;
  }
  return b;
}

/* ---------- 编排 ---------- */
const at = (beat: number) => beat * BEAT;
const CHORDS = [
  { root: 38, pad: [50, 53, 57, 62] }, // Dm
  { root: 34, pad: [46, 50, 53, 58] }, // Bb
  { root: 41, pad: [45, 48, 53, 57] }, // F
  { root: 36, pad: [48, 52, 55, 60] }, // C
];
const chordAt = (bar: number) => CHORDS[((bar % 4) + 4) % 4];

// 段落的起点（拍）：和 edit.ts 的时间线对齐
const TITLE = SECTIONS.title;
const PRE = SECTIONS.pre;
const GO = SECTIONS.go;
const MTN = SECTIONS.mountain;
const AGAIN = SECTIONS.again;
const BREAK = SECTIONS.garage;
const HERO = SECTIONS.hero;
const END = SECTIONS.end;

// 开场：雨声、低音铺底、心跳
put(0, rain(at(TITLE) + 3, 0.16), 1, 0, 0.1);
put(0, pad([26, 33, 38], at(TITLE) + 0.2, 0.55, 260, 2.5, 2), 1, 0, 0.3);
put(1.5, pad([50, 57, 62], at(TITLE) - 1.3, 0.18, 700, 3, 1.5), 1, 0, 0.5);
for (let b = 0; b < TITLE; b += 4) {
  put(at(b), kick(0.9), 0.9, 0, 0.15);
  put(at(b + 0.75), kick(0.5), 0.6, 0, 0.15);
}
put(at(TITLE - 4), riser(2, 0.5), 1, 0, 0.2);
// 标题：一声重击，铺底拖着
put(at(TITLE), impact(1, 4), 1, 0, 0.4);
put(at(TITLE), pad([38, 45, 50, 53, 57], at(PRE - TITLE) - 0.4, 0.32, 1100, 0.05, 1.2), 1, 0, 0.5);
for (let s = TITLE + 4; s < PRE; s += 0.5) put(at(s), hat(0.18), 1, 0.3, 0.1);

// 赛前镜头和倒数：四拍底鼓、八分音符的低音、踩镲，最后一小节军鼓滚奏 + 轰油门
const preBars = (GO - PRE) / 4;
for (let bar = 0; bar < preBars; bar++) {
  const b0 = PRE + bar * 4;
  const ch = chordAt(bar);
  put(at(b0), pad(ch.pad, 2.0, 0.3, 900, 0.3, 0.6), 1, 0, 0.4);
  for (let k = 0; k < 4; k++) {
    put(at(b0 + k), kick(0.75), 0.85, 0, 0.1);
    put(at(b0 + k + 0.5), hat(0.32), 1, 0.25, 0.05);
    put(at(b0 + k + 0.25), hat(0.12), 1, -0.25, 0.05);
    put(at(b0 + k + 0.75), hat(0.12), 1, -0.25, 0.05);
    put(at(b0 + k + 0.5), bassNote(midi(ch.root), 0.22, 0.55, 0.6), 1, 0, 0);
  }
  if (bar === preBars - 1) {
    for (let s = 0; s < 4; s += s < 2 ? 0.5 : s < 3 ? 0.25 : 0.125) put(at(b0 + s), snare(0.25 + 0.12 * s), 1, 0, 0.2);
  } else {
    put(at(b0 + 1), snare(0.45), 1, 0, 0.25);
    put(at(b0 + 3), snare(0.45), 1, 0, 0.25);
  }
}
put(at(GO - 4), riser(2, 0.6), 1, 0, 0.2);
// 画面上的倒数 3、2、1（GO 前三、二、一秒）和 GO
for (const k of [6, 4, 2]) put(at(GO - k), beep(880, 0.32, 0.22), 1, 0, 0.25);
put(at(GO), beep(1760, 0.6, 0.24), 1, 0, 0.3);
put(at(GO - 5.6), engine(0.7, 1200, 5200, 0.22, (k) => Math.sin(k * Math.PI)), 1, -0.2, 0.1);
put(at(GO - 3.2), engine(0.8, 1200, 6200, 0.25, (k) => Math.sin(k * Math.PI)), 1, 0.2, 0.1);

/** 主段落：底鼓、军鼓、滚动的低音、琶音。half = 半速的律动（山路那段，开阔一点） */
const groove = (fromBeat: number, toBeat: number, opts: { arp?: boolean; snareGain?: number; half?: boolean } = {}) => {
  for (let b = fromBeat; b < toBeat; b += 4) {
    const bar = Math.floor((b - fromBeat) / 4);
    const ch = chordAt(bar);
    put(at(b), pad(ch.pad, 2.0, opts.half ? 0.36 : 0.26, opts.half ? 2200 : 1500, 0.02, 0.5), 1, 0, 0.35);
    for (let k = 0; k < 4 && b + k < toBeat; k++) {
      const bt = b + k;
      if (opts.half) {
        if (k === 0) put(at(bt), kick(1), 1, 0, 0.1);
        if (k === 1) put(at(bt + 0.5), kick(0.7), 1, 0, 0.1);
        if (k === 2) put(at(bt), snare(opts.snareGain ?? 0.75), 1, 0, 0.45);
        for (let s = 0; s < 2; s++) put(at(bt + s * 0.5), hat(s ? 0.3 : 0.14, s === 1 && k === 3), 1, s ? -0.3 : 0.3, 0.06);
        put(at(bt), bassNote(midi(ch.root), 0.45, 0.6, 0.5), 1, 0, 0);
      } else {
        put(at(bt), kick(1), 1, 0, 0.08);
        if (k === 1 || k === 3) put(at(bt), snare(opts.snareGain ?? 0.7), 1, 0, 0.3);
        for (let s = 0; s < 4; s++) put(at(bt + s * 0.25), hat(s === 2 ? 0.34 : 0.16), 1, s % 2 ? -0.3 : 0.3, 0.04);
        for (const s of [0.25, 0.5, 0.75]) put(at(bt + s), bassNote(midi(ch.root + (s === 0.75 && k === 3 ? 12 : 0)), 0.11, 0.62, 1), 1, 0, 0);
      }
      if (opts.arp !== false) {
        const tones = [ch.pad[0] + 12, ch.pad[1] + 12, ch.pad[2] + 12, ch.pad[3] + 12];
        for (let s = 0; s < 4; s++) put(at(bt + s * 0.25), pluck(tones[(k * 4 + s) % 4], opts.half ? 0.16 : 0.13), 1, s % 2 ? 0.45 : -0.45, 0.4);
      }
    }
  }
};
// GO：全段落进来（城里漂移、氮气）
put(at(GO), impact(0.9, 2.5), 1, 0, 0.3);
put(at(GO), engine(1.8, 3500, 7600, 0.25), 1, 0, 0.1);
groove(GO, MTN);
for (const b of SECTIONS.nitro) {
  put(at(b), engine(1.6, 5200, 8200, 0.3, (k) => Math.sqrt(k)), 1, 0, 0.15);
  put(at(b), riser(0.5, 0.35).reverse(), 1, 0, 0.3);
}
// 山路：一声重击，换成半速的律动
put(at(MTN - 2), riser(1, 0.45), 1, 0, 0.25);
put(at(MTN), impact(1, 4), 1, 0, 0.5);
groove(MTN, AGAIN, { half: true });
// 再进来：多车比赛、天气
put(at(AGAIN - 2), riser(1, 0.5), 1, 0, 0.25);
put(at(AGAIN), impact(0.6, 1.5), 1, 0, 0.2);
groove(AGAIN, BREAK);
// 车库：鼓停，铺底和琶音
put(at(BREAK), pad([38, 45, 50, 53, 57, 62], at(HERO - BREAK), 0.3, 900, 0.05, 0.6), 1, 0, 0.6);
for (let s = 0; s < HERO - BREAK; s += 0.25) put(at(BREAK + s), pluck([62, 65, 69, 74][(s * 4) % 4], 0.12), 1, (s * 4) % 2 ? 0.45 : -0.45, 0.5);
put(at(BREAK), impact(0.7, 2.5), 1, 0, 0.4);
// 上推，车冲过镜头
put(at(HERO), riser(at(END - HERO), 0.7), 1, 0, 0.25);
for (let s = 0; s < END - HERO; s += 0.25) put(at(HERO + s), snare(0.2 + 0.1 * s), 1, 0, 0.2);
{
  // 呼啸而过：音高往下掉，声像从左甩到右
  const len = 1.0;
  const e = engine(len, 7800, 5200, 0.45, (k) => 1 / (1 + Math.exp(-(k - 0.5) * 12)));
  const t0 = SECTIONS.pass - 0.5;
  for (let i = 0; i < e.length; i++) {
    const k = i / e.length;
    const pan = clamp((k - 0.5) * 2.4, -1, 1);
    const amp = Math.exp(-Math.pow((k - 0.5) * 3.2, 2));
    const j = Math.round(t0 * SR) + i;
    if (j >= N) break;
    L[j] += e[i] * amp * Math.cos(((pan + 1) * Math.PI) / 4);
    R[j] += e[i] * amp * Math.sin(((pan + 1) * Math.PI) / 4);
  }
}
// 结尾卡：最后一下重击，和弦拖尾到结束
put(at(END), impact(1.1, 5), 1, 0, 0.5);
put(at(END), pad([26, 38, 45, 50, 53, 57], LENGTH - at(END) - 1.6, 0.42, 1000, 0.02, 1.4), 1, 0, 0.6);
put(at(END), bassNote(midi(26), 3.5, 0.4, 0.3), 1, 0, 0);

/* ---------- 混响（几组梳状 + 全通，够用就行） ---------- */
function reverb(src: Float32Array, offset: number): Float32Array {
  const out = new Float32Array(N);
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ d: Math.round((d + offset) * 1.6), buf: new Float32Array(Math.round((d + offset) * 1.6)), i: 0, lp: 0 }));
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.75 + c.lp * 0.25;
      c.buf[c.i] = src[n] + c.lp * 0.86;
      c.i = (c.i + 1) % c.d;
      s += y;
    }
    out[n] = s / combs.length;
  }
  for (const d of [556, 441, 341]) {
    const len = Math.round((d + offset) * 1.6);
    const b = new Float32Array(len);
    let i = 0;
    for (let n = 0; n < N; n++) {
      const x = out[n];
      const y = b[i] - 0.5 * x;
      b[i] = x + 0.5 * y;
      i = (i + 1) % len;
      out[n] = y;
    }
  }
  return out;
}
const vl = reverb(RL, 0);
const vr = reverb(RR, 23);

/* ---------- 总线：加混响、压一下、限幅、首尾淡入淡出 ---------- */
let peak = 0;
for (let n = 0; n < N; n++) {
  L[n] += vl[n] * 0.9;
  R[n] += vr[n] * 0.9;
  peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]));
}
const pre = 1.15 / peak;
const out = Buffer.alloc(44 + N * 2 * 2);
for (let n = 0; n < N; n++) {
  const t = n / SR;
  const fade = Math.min(1, t / 0.05) * Math.min(1, (LENGTH - t) / 1.5);
  const l = Math.tanh(L[n] * pre * 1.2) * 0.89 * fade;
  const r = Math.tanh(R[n] * pre * 1.2) * 0.89 * fade;
  out.writeInt16LE(Math.round(clamp(l, -1, 1) * 32767), 44 + n * 4);
  out.writeInt16LE(Math.round(clamp(r, -1, 1) * 32767), 46 + n * 4);
}
// WAV 头
out.write('RIFF', 0);
out.writeUInt32LE(36 + N * 4, 4);
out.write('WAVE', 8);
out.write('fmt ', 12);
out.writeUInt32LE(16, 16);
out.writeUInt16LE(1, 20);
out.writeUInt16LE(2, 22);
out.writeUInt32LE(SR, 24);
out.writeUInt32LE(SR * 4, 28);
out.writeUInt16LE(4, 32);
out.writeUInt16LE(16, 34);
out.write('data', 36);
out.writeUInt32LE(N * 4, 40);
mkdirSync(WORK, { recursive: true });
const file = process.argv[2] ?? join(WORK, 'music.wav');
writeFileSync(file, out);
console.log(`配乐：${LENGTH} 秒，${file}`);
