import * as THREE from 'three/webgpu';
import { attribute, clamp, dot, exp, float, floor, fract, length, max, mix, mx_noise_float, normalize, sin, smoothstep, step, uniform, vec2, vec3 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type RGB = [number, number, number];

export type TimeId = 'day' | 'dusk' | 'night';

/** 一个时段的全部光照参数。切换时段就是在两组参数之间过渡 */
export interface TimePreset {
  id: TimeId;
  name: string;
  /** 主光（太阳或月亮）的方向，从地面指向光源 */
  keyDir: RGB;
  keyColor: RGB;
  keyIntensity: number;
  hemiSky: RGB;
  hemiGround: RGB;
  hemiIntensity: number;
  /** 天空：天顶、地平线、地平线以下的颜色 */
  zenith: RGB;
  horizon: RGB;
  below: RGB;
  /** 日盘 / 月盘的颜色（已乘亮度）和锐度（指数越大盘面越小） */
  disk: RGB;
  diskSharp: number;
  /** 光源周围的大范围光晕 */
  glow: RGB;
  /** 朝向光源那一侧、贴着地平线的霞光 */
  haze: RGB;
  stars: number;
  cloudLit: RGB;
  cloudDark: RGB;
  cloudAmount: number;
  fogColor: RGB;
  fogDensity: number;
  /** 城市灯光：0 全灭，1 全亮 */
  lights: number;
  exposure: number;
  envIntensity: number;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  contrast: number;
  saturation: number;
  /** 分离色调：暗部和亮部各乘一个颜色 */
  shadowTint: RGB;
  highlightTint: RGB;
}

export const TIMES: Record<TimeId, TimePreset> = {
  day: {
    id: 'day',
    name: '白天',
    // 太阳差不多顺着南北向的大道照过来（略偏东）：大道整条是亮的，
    // 高架下面枕木的影子一道道落在路面上；东西向的街在楼的影子里
    keyDir: [0.13, 0.72, 0.68],
    keyColor: [1.0, 0.945, 0.86],
    keyIntensity: 4.0,
    hemiSky: [0.8, 0.86, 0.96],
    hemiGround: [0.36, 0.33, 0.29],
    hemiIntensity: 1.3,
    zenith: [0.15, 0.28, 0.52],
    horizon: [0.68, 0.74, 0.82],
    below: [0.22, 0.22, 0.23],
    disk: [30, 28.5, 25.5],
    diskSharp: 3000,
    glow: [0.22, 0.21, 0.19],
    haze: [0, 0, 0],
    stars: 0,
    cloudLit: [0.95, 0.96, 0.98],
    cloudDark: [0.72, 0.75, 0.82],
    cloudAmount: 0.75,
    fogColor: [0.56, 0.65, 0.76],
    fogDensity: 0.0011,
    lights: 0,
    exposure: 1.0,
    envIntensity: 1.0,
    bloomStrength: 0.24,
    bloomThreshold: 2.2,
    bloomRadius: 0.5,
    contrast: 1.1,
    saturation: 1.02,
    // 背阴处只有天光，天然偏蓝；暗部往暖里拉一点，路面才是灰的而不是蓝的
    shadowTint: [1.06, 1.0, 0.9],
    highlightTint: [1.02, 1.0, 0.97],
  },
  dusk: {
    id: 'dusk',
    name: '黄昏',
    // 太阳压在湖面那一侧的地平线上：开上河岸和湖滨大道时正对着落日
    keyDir: [0.86, 0.15, 0.3],
    keyColor: [1.0, 0.5, 0.24],
    keyIntensity: 3.0,
    hemiSky: [0.5, 0.5, 0.72],
    hemiGround: [0.36, 0.25, 0.2],
    hemiIntensity: 1.1,
    zenith: [0.07, 0.11, 0.34],
    horizon: [0.5, 0.36, 0.5],
    below: [0.16, 0.12, 0.17],
    disk: [26, 13, 5],
    diskSharp: 1400,
    glow: [0.42, 0.17, 0.045],
    haze: [0.75, 0.3, 0.08],
    stars: 0.12,
    cloudLit: [1.25, 0.6, 0.38],
    cloudDark: [0.2, 0.17, 0.3],
    cloudAmount: 0.85,
    fogColor: [0.42, 0.31, 0.4],
    fogDensity: 0.0015,
    lights: 0.85,
    exposure: 1.05,
    envIntensity: 1.0,
    bloomStrength: 0.32,
    bloomThreshold: 1.6,
    bloomRadius: 0.6,
    contrast: 1.1,
    saturation: 1.06,
    shadowTint: [0.9, 0.97, 1.1],
    highlightTint: [1.07, 1.0, 0.93],
  },
  night: {
    id: 'night',
    name: '夜晚',
    keyDir: [-0.38, 0.6, 0.52],
    keyColor: [0.5, 0.64, 1.0],
    keyIntensity: 0.34,
    hemiSky: [0.16, 0.24, 0.46],
    hemiGround: [0.12, 0.09, 0.08],
    hemiIntensity: 0.5,
    // 深蓝的夜空；地平线被城市的钠灯映成发灰的暖色
    zenith: [0.008, 0.014, 0.034],
    horizon: [0.07, 0.062, 0.07],
    below: [0.022, 0.022, 0.028],
    disk: [5, 5.4, 6],
    diskSharp: 1800,
    glow: [0.02, 0.025, 0.04],
    haze: [0.045, 0.03, 0.02],
    stars: 0.4,
    // 云被底下的灯光照着：朝下的一面是暖灰色
    cloudLit: [0.11, 0.09, 0.085],
    cloudDark: [0.018, 0.022, 0.034],
    cloudAmount: 0.75,
    fogColor: [0.026, 0.03, 0.042],
    fogDensity: 0.0021,
    lights: 1,
    exposure: 1.1,
    envIntensity: 1.0,
    bloomStrength: 0.34,
    bloomThreshold: 1.15,
    bloomRadius: 0.7,
    contrast: 1.13,
    saturation: 1.02,
    shadowTint: [0.86, 0.98, 1.12],
    highlightTint: [1.08, 1.0, 0.92],
  },
};

export const TIME_ORDER: TimeId[] = ['day', 'dusk', 'night'];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * 在两个时段之间过渡。t = 0 是 a，t = 1 是 b。
 * 主光的方向不做插值（太阳和月亮不在同一处，中途会扫过整片天）：
 * 前半段把 a 的主光淡出，后半段把 b 的主光淡入，方向在最暗的那一刻切换。
 */
export function blendTime(a: TimePreset, b: TimePreset, t: number): TimePreset {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const first = t < 0.5;
  const fade = first ? 1 - t * 2 : t * 2 - 1;
  const src = first ? a : b;
  return {
    id: first ? a.id : b.id,
    name: b.name,
    keyDir: src.keyDir,
    keyColor: src.keyColor,
    keyIntensity: src.keyIntensity * fade,
    hemiSky: lerp3(a.hemiSky, b.hemiSky, t),
    hemiGround: lerp3(a.hemiGround, b.hemiGround, t),
    hemiIntensity: lerp(a.hemiIntensity, b.hemiIntensity, t),
    zenith: lerp3(a.zenith, b.zenith, t),
    horizon: lerp3(a.horizon, b.horizon, t),
    below: lerp3(a.below, b.below, t),
    disk: [src.disk[0] * fade, src.disk[1] * fade, src.disk[2] * fade],
    diskSharp: src.diskSharp,
    glow: [src.glow[0] * fade, src.glow[1] * fade, src.glow[2] * fade],
    haze: [src.haze[0] * fade, src.haze[1] * fade, src.haze[2] * fade],
    stars: lerp(a.stars, b.stars, t),
    cloudLit: lerp3(a.cloudLit, b.cloudLit, t),
    cloudDark: lerp3(a.cloudDark, b.cloudDark, t),
    cloudAmount: lerp(a.cloudAmount, b.cloudAmount, t),
    fogColor: lerp3(a.fogColor, b.fogColor, t),
    fogDensity: lerp(a.fogDensity, b.fogDensity, t),
    lights: lerp(a.lights, b.lights, t),
    exposure: lerp(a.exposure, b.exposure, t),
    envIntensity: lerp(a.envIntensity, b.envIntensity, t),
    bloomStrength: lerp(a.bloomStrength, b.bloomStrength, t),
    bloomThreshold: lerp(a.bloomThreshold, b.bloomThreshold, t),
    bloomRadius: lerp(a.bloomRadius, b.bloomRadius, t),
    contrast: lerp(a.contrast, b.contrast, t),
    saturation: lerp(a.saturation, b.saturation, t),
    shadowTint: lerp3(a.shadowTint, b.shadowTint, t),
    highlightTint: lerp3(a.highlightTint, b.highlightTint, t),
  };
}

/* ------------------------------------------------------------------ */
/* 天空                                                                 */
/* ------------------------------------------------------------------ */

const v3u = (c: RGB) => uniform(new THREE.Vector3(c[0], c[1], c[2]));

/** 天空着色器读的量。applySky() 每帧把当前时段的值写进来 */
export const skyUniforms = {
  keyDir: uniform(new THREE.Vector3(...TIMES.day.keyDir).normalize()),
  zenith: v3u(TIMES.day.zenith),
  horizon: v3u(TIMES.day.horizon),
  below: v3u(TIMES.day.below),
  disk: v3u(TIMES.day.disk),
  diskSharp: uniform(TIMES.day.diskSharp),
  glow: v3u(TIMES.day.glow),
  haze: v3u(TIMES.day.haze),
  stars: uniform(0),
  cloudLit: v3u(TIMES.day.cloudLit),
  cloudDark: v3u(TIMES.day.cloudDark),
  cloudAmount: uniform(TIMES.day.cloudAmount),
};

const _dir = new THREE.Vector3();

export function applySky(p: TimePreset): void {
  const u = skyUniforms;
  u.keyDir.value.copy(_dir.set(...p.keyDir).normalize());
  u.zenith.value.set(...p.zenith);
  u.horizon.value.set(...p.horizon);
  u.below.value.set(...p.below);
  u.disk.value.set(...p.disk);
  u.diskSharp.value = p.diskSharp;
  u.glow.value.set(...p.glow);
  u.haze.value.set(...p.haze);
  u.stars.value = p.stars;
  u.cloudLit.value.set(...p.cloudLit);
  u.cloudDark.value.set(...p.cloudDark);
  u.cloudAmount.value = p.cloudAmount;
}

/**
 * 天空的颜色：渐变 + 日/月盘和光晕 + 霞光 + 星星 + 云。用在一个跟着镜头走的大球内壁上。
 * 所有量都来自 skyUniforms，所以同一个着色器覆盖白天、黄昏和夜晚。
 */
export function skyColorNode(): N {
  const u = skyUniforms;
  const dir: N = normalize(attribute('position', 'vec3'));
  const h: N = dir.y;
  const up: N = mix(u.horizon, u.zenith, smoothstep(0.0, 0.55, h).pow(0.7));
  let col: N = up;

  const d: N = clamp(dot(dir, u.keyDir), 0, 1);
  // 霞光：只在朝向光源的那半边、贴近地平线的一条
  const flat: N = normalize(vec2(dir.x, dir.z).add(vec2(0.0001, 0.0)));
  const keyFlat: N = normalize(vec2(u.keyDir.x, u.keyDir.z).add(vec2(0.0001, 0.0)));
  const toward: N = clamp(dot(flat, keyFlat).mul(0.5).add(0.5), 0, 1);
  const lowBand: N = exp(max(h, 0).mul(-5.5));
  col = col.add(u.haze.mul(toward.pow(3.0)).mul(lowBand));
  col = col.add(u.glow.mul(d.pow(6.0).add(d.pow(60.0).mul(1.6))));
  col = col.add(u.disk.mul(d.pow(u.diskSharp)));

  // 云：把视线方向投到一个高空平面上取噪声
  const plane: N = vec2(dir.x, dir.z).div(max(h, 0.04)).mul(0.9);
  const c1: N = mx_noise_float(vec3(plane.x, 0.0, plane.y)).mul(0.5).add(0.5);
  const c2: N = mx_noise_float(vec3(plane.x.mul(2.7), 3.0, plane.y.mul(2.7))).mul(0.5).add(0.5);
  const density: N = c1.mul(0.7).add(c2.mul(0.3));
  const cloud: N = smoothstep(0.52, 0.8, density).mul(smoothstep(0.02, 0.25, h)).mul(u.cloudAmount);
  // 朝着光源的云、云的薄边更亮
  const lit: N = clamp(d.pow(2.0).mul(0.75).add(float(1).sub(smoothstep(0.55, 0.85, density)).mul(0.45)), 0, 1);
  const cloudColor: N = mix(u.cloudDark, u.cloudLit, lit);

  // 星星：把方向放大后取整成小格子，随机挑很少的格子点亮
  const sp: N = dir.mul(150.0);
  const cell: N = floor(sp);
  const f: N = fract(sp).sub(0.5);
  const rnd: N = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
  const star: N = step(0.9972, rnd)
    .mul(smoothstep(0.32, 0.05, length(f)))
    .mul(smoothstep(0.03, 0.35, h))
    .mul(fract(rnd.mul(917.0)).mul(1.4).add(0.5))
    .mul(u.stars);
  col = col.add(vec3(0.8, 0.88, 1.0).mul(star).mul(float(1).sub(cloud)));

  col = mix(col, cloudColor, cloud);
  // 地平线以下
  return mix(u.below, col, smoothstep(-0.03, 0.0, h));
}
