import { Vector3 } from 'three';
import type { CityTrack, TrackSample } from '../city/cityLayout.ts';

/**
 * 山路赛道「云岭」的布局：纯数据和几何计算，不依赖渲染。画面、物理、自动驾驶、对手 AI 都从这里取数。
 *
 * 坐标：米。+Z 是上山的方向（北），车头朝 +Z 时左手边是 +X。
 * 地形是一面朝南的山坡：南边是湖边的谷底，往北爬到山顶的台地。路从谷底出发，
 * 从东侧的大弯爬上去，在山腰上折两个发卡弯上到山顶，沿山脊往西（中间有一个会飞起来的坡顶），再从西侧一路下来：
 * 一个大回头弯、穿过一道山嘴（隧道）、又一个大回头弯、跨过一条山沟（高架桥）、绕一个大半圈的长弯回到湖边。
 *
 * 路是照着《极品飞车》里山路的感觉定的：双向四车道那么宽，弯大多是能带着速度过的大弧线，
 * 弯道往里倾斜一点；急的地方只有两个发卡弯，也是放宽了的。
 */
export const MOUNTAIN = {
  /** 路面半宽（和城市赛道一样宽：对手的走线、检查点的门都按这个宽度做的） */
  halfRoad: 8,
  /** 护栏离中心线多远：路面外面还有一条硬路肩和一点碎石 */
  rail: 9.8,
  /** 护栏外面这么远以内是平的（路基），再往外才是山坡 */
  bench: 10.8,
  /** 湖面高度 */
  lake: 15.2,
  /** 地形网格覆盖的范围（正方形，中心在原点） */
  extent: 800,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t: number) => {
  const k = clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* 噪声                                                                 */
/* ------------------------------------------------------------------ */

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 平滑的二维噪声，-1..1，每走 1 是一个起伏 */
function noise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

/** 几层噪声叠起来，-1..1 左右 */
export function fbm(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * f, z * f, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* 山的形状                                                             */
/* ------------------------------------------------------------------ */

/** 山嘴：从山坡上伸出来的一道石梁，下山的路从它肚子里穿过去（隧道） */
const SPUR = { x: -455, half: 27, z0: 80, z1: 232, height: 34 };
/** 山沟：山坡上的一道深沟，下山的路架桥跨过去 */
const GORGE = { x: -506, half: 30, z0: -130, z1: 60, depth: 26 };

/**
 * 山坡的大形状（不含山嘴和山沟）：路的高低是照着它定的。
 * 谷底约 22 米，往北爬到约 92 米的台地；西边的台地矮一些。
 */
function slope(x: number, z: number): number {
  const face = 22 + 70 * smooth((z + 255) / 545);
  // 台地往西慢慢低下去；往东略高
  const tilt = (-9 * smooth((-x - 150) / 380) + 4 * smooth((x - 100) / 300)) * smooth((z + 80) / 300);
  // 大起伏：谷底平，越往上越明显
  const roll = fbm(x / 240 + 3.1, z / 240 - 1.7, 3, 11) * 6.5 * (0.25 + 0.75 * smooth((z + 330) / 260));
  return face + tilt + roll;
}

/** 山嘴高出山坡多少（米） */
function spurAt(x: number, z: number): number {
  const across = Math.exp(-(((x - SPUR.x) / SPUR.half) ** 2));
  const along = smooth((z - SPUR.z0) / 70) * (1 - smooth((z - SPUR.z1) / 80));
  return SPUR.height * across * along;
}

/** 山沟比山坡低多少（米） */
function gorgeAt(x: number, z: number): number {
  const across = Math.exp(-(((x - GORGE.x) / GORGE.half) ** 2));
  const along = smooth((z - GORGE.z0) / 60) * (1 - smooth((z - GORGE.z1) / 70));
  return GORGE.depth * across * along;
}

/** 路以外的地形：山坡 + 山嘴 − 山沟 + 小起伏；台地后面是更高的山，谷底南边是湖盆 */
export function baseHeight(x: number, z: number): number {
  // 山沟再深也不低过湖面（不然沟底会冒出一小片水）
  let h = Math.max(slope(x, z) + spurAt(x, z) - gorgeAt(x, z), MOUNTAIN.lake + 1.6);
  // 小起伏和石头的棱角（路附近会被压平，见 terrainHeight）
  h += fbm(x / 70 + 9.2, z / 70 + 4.4, 3, 29) * 3.2;
  h += fbm(x / 23 - 2.2, z / 23 + 7.7, 2, 47) * 0.9;
  // 台地北边：往后是更高的山
  const back = smooth((z - 380) / 420);
  h += back * (70 + fbm(x / 300 + 1.3, z / 300, 3, 61) * 60) + back * back * 60;
  // 东西两头也往上收，像个山坳把赛道围在中间
  const side = smooth((Math.abs(x + 70) - 640) / 300) * smooth((z + 300) / 300);
  h += side * (46 + fbm(x / 260, z / 260 + 5.0, 3, 73) * 34);
  // 谷底南边：往湖里去
  const south = smooth((-z - 408) / 70);
  h = lerp(h, 9.5 + fbm(x / 120, z / 120, 2, 83) * 1.4, south);
  return h;
}

/* ------------------------------------------------------------------ */
/* 路线                                                                 */
/* ------------------------------------------------------------------ */

type Pt = [number, number];

/**
 * 路线的折点和每个折点的转弯半径：相邻折点之间是直线，折点处用圆弧抹成弯。
 * 顺序就是行进方向。
 */
const ROUTE: { p: Pt; r: number }[] = [
  // 湖边的发车直道（朝东）
  { p: [-300, -388], r: 85 },
  // 东头的大弯，开始上山
  { p: [262, -388], r: 150 },
  // 东坡：一个大半径的折弯，再拐上山腰
  { p: [432, -118], r: 160 },
  { p: [402, 30], r: 85 },
  // 两个发卡弯：路在山腰上来回折三段（每段中间有一个很缓的折弯，不是笔直的）。
  // 发卡弯的半径是照着漂移定的：这套手感下一直漂着走，弧线的半径在三十米出头，正好能一把漂过去
  { p: [160, 12], r: 220 },
  { p: [-82, 30], r: 32 },
  { p: [-82, 96], r: 32 },
  { p: [120, 104], r: 240 },
  { p: [322, 90], r: 32 },
  { p: [322, 156], r: 32 },
  // 上到台地，沿山脊往西
  { p: [-52, 162], r: 85 },
  { p: [-176, 318], r: 95 },
  { p: [-350, 332], r: 260 },
  // 西头一个大半径的回头弯，掉头下山：穿隧道
  { p: [-640, 330], r: 80 },
  // 又一个大回头弯
  { p: [-330, 40], r: 75 },
  // 过高架桥，进长弯
  { p: [-532, -34], r: 0 },
  // 长弯出来，一个 S 弯回到湖边
  { p: [-452, -252], r: 80 },
];

/** 西南角的长弯：圆心和半径。从 ROUTE 里半径写 0 的那个折点接进来，沿着圆走一百五十度出去 */
const LOOP = { cx: -548, cz: -148, r: 96 };

/** 把"直线 + 圆弧"连成一圈密集的点 */
function buildPolyline(step: number): Pt[] {
  const pts: Pt[] = [];
  const push = (x: number, z: number) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last[0] - x, last[1] - z) > 1e-6) pts.push([x, z]);
  };
  const line = (a: Pt, b: Pt) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k <= n; k++) push(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
  };
  const arc = (c: Pt, r: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / step));
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      push(c[0] + r * Math.cos(a), c[1] + r * Math.sin(a));
    }
  };
  const unit = (a: Pt, b: Pt): Pt => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };

  /** 从圆外一点到圆的切线：side = -1 是「沿这条切线走到切点，接着绕圆走」的那条，1 是「绕圆走到切点，再沿切线走到这一点」的那条 */
  const tangent = (from: Pt, c: Pt, r: number, side: number): Pt => {
    const dx = c[0] - from[0];
    const dz = c[1] - from[1];
    const d = Math.hypot(dx, dz);
    const base = Math.atan2(dz, dx);
    const off = Math.asin(clamp(r / d, -1, 1));
    const ang = base + side * off;
    const len = Math.sqrt(Math.max(0, d * d - r * r));
    return [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len];
  };

  const n = ROUTE.length;
  // 每个折点抹圆以后的切点、圆心、起止角
  const corners = ROUTE.map((v, k) => {
    if (v.r === 0) return null;
    let prev = ROUTE[(k - 1 + n) % n].p;
    let next = ROUTE[(k + 1) % n].p;
    // 挨着长弯的折点：那一侧的"邻居"换成圆上的切点
    if (ROUTE[(k - 1 + n) % n].r === 0) prev = tangent(v.p, [LOOP.cx, LOOP.cz], LOOP.r, 1);
    if (ROUTE[(k + 1) % n].r === 0) next = tangent(v.p, [LOOP.cx, LOOP.cz], LOOP.r, -1);
    const d1 = unit(prev, v.p);
    const d2 = unit(v.p, next);
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const dot = clamp(d1[0] * d2[0] + d1[1] * d2[1], -1, 1);
    const theta = Math.acos(dot);
    const t = v.r * Math.tan(theta / 2);
    const t1: Pt = [v.p[0] - d1[0] * t, v.p[1] - d1[1] * t];
    const t2: Pt = [v.p[0] + d2[0] * t, v.p[1] + d2[1] * t];
    // 圆心在弯的内侧
    const s = Math.sign(cross) || 1;
    const c: Pt = [t1[0] - d1[1] * v.r * s, t1[1] + d1[0] * v.r * s];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    let a1 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    if (s > 0) while (a1 < a0) a1 += Math.PI * 2;
    else while (a1 > a0) a1 -= Math.PI * 2;
    return { t1, t2, c, a0, a1, r: v.r, t };
  });

  let cursor: Pt | null = null;
  for (let k = 0; k < n; k++) {
    const c = corners[k];
    if (!c) {
      // 长弯：从上一个弯的出口沿切线接进来，绕到通往下一个弯入口的切点出去
      const before = corners[(k - 1 + n) % n]!;
      const after = corners[(k + 1) % n]!;
      const centre: Pt = [LOOP.cx, LOOP.cz];
      const tin = tangent(before.t2, centre, LOOP.r, -1);
      const tout = tangent(after.t1, centre, LOOP.r, 1);
      if (cursor) line(cursor, tin);
      const a0 = Math.atan2(tin[1] - centre[1], tin[0] - centre[0]);
      let a1 = Math.atan2(tout[1] - centre[1], tout[0] - centre[0]);
      while (a1 < a0) a1 += Math.PI * 2;
      arc(centre, LOOP.r, a0, a1);
      cursor = tout;
      continue;
    }
    if (cursor) line(cursor, c.t1);
    else pts.push(c.t1);
    arc(c.c, c.r, c.a0, c.a1);
    cursor = c.t2;
  }
  line(cursor!, pts[0]);
  pts.pop();
  return pts;
}

/** 检查用：每个折点两边的直线够不够长（不够的话相邻两个弯会叠在一起） */
export function routeProblems(): string[] {
  const out: string[] = [];
  const n = ROUTE.length;
  const tan: number[] = ROUTE.map((v, k) => {
    if (v.r === 0) return 0;
    const prev = ROUTE[(k - 1 + n) % n].p;
    const next = ROUTE[(k + 1) % n].p;
    const a = Math.atan2(v.p[1] - prev[1], v.p[0] - prev[0]);
    const b = Math.atan2(next[1] - v.p[1], next[0] - v.p[0]);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = Math.PI * 2 - d;
    return v.r * Math.tan(d / 2);
  });
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    if (ROUTE[k].r === 0 || ROUTE[j].r === 0) continue;
    const len = Math.hypot(ROUTE[j].p[0] - ROUTE[k].p[0], ROUTE[j].p[1] - ROUTE[k].p[1]);
    if (tan[k] + tan[j] > len + 0.5) out.push(`折点 ${k} → ${j}：直线 ${len.toFixed(0)} 米，两头的弯要占 ${(tan[k] + tan[j]).toFixed(0)} 米`);
  }
  return out;
}

/** 一圈点做几遍滑动平均：弯和直线的交接处变成渐变的（缓和曲线），不是一下子打满方向 */
function relax(pts: Pt[], half: number, passes: number): Pt[] {
  let cur = pts;
  const n = pts.length;
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sz = 0;
      for (let k = -half; k <= half; k++) {
        const q = cur[(i + k + n) % n];
        sx += q[0];
        sz += q[1];
      }
      next[i] = [sx / (half * 2 + 1), sz / (half * 2 + 1)];
    }
    cur = next;
  }
  return cur;
}

/** 沿一圈点按固定间隔重新取样 */
function resample(pts: Pt[], step: number): Pt[] {
  const n = pts.length;
  let total = 0;
  const seg: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(l);
    total += l;
  }
  const count = Math.round(total / step);
  const ds = total / count;
  const out: Pt[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const target = k * ds;
    while (acc + seg[i] < target && i < n - 1) {
      acc += seg[i];
      i++;
    }
    const t = seg[i] > 0 ? (target - acc) / seg[i] : 0;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** 一圈数做滑动平均 */
function blur(v: Float64Array, half: number, passes: number): Float64Array {
  let cur: Float64Array = v;
  const n = v.length;
  for (let p = 0; p < passes; p++) {
    const next = new Float64Array(n);
    // 前缀和：窗口很宽也只扫一遍
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += cur[(k + n) % n];
    for (let i = 0; i < n; i++) {
      next[i] = sum / (half * 2 + 1);
      sum += cur[(i + half + 1) % n] - cur[(i - half + n) % n];
    }
    cur = next;
  }
  return cur;
}

/** 山路上的一段特殊路段：隧道或者高架桥（按采样点下标，含两头） */
export interface Span {
  kind: 'tunnel' | 'bridge';
  i0: number;
  i1: number;
}

export interface MountainTrack extends CityTrack {
  /** 车在这里可能离地（坡顶）：自动驾驶不在这里开氮气，检查点也不放在这里 */
  crest: Uint8Array;
  /**
   * 每个采样点的路面横坡：弯道往弯里倾斜（内侧低、外侧高）。
   * 离中心线 l 米（左为正）处的路面高度 = 中心线高度 − bank × l
   */
  bank: Float32Array;
  /** 隧道和高架桥 */
  spans: Span[];
  /** 每个采样点的坡度（上坡为正） */
  grade: Float32Array;
  start: { x: number; y: number; z: number; yaw: number };
}

/**
 * 山脊直道上的坡顶：在哪、鼓起来多高、上去的一侧和下去的一侧各多长。
 * 上去的一侧短而陡（车被往上送），下去的一侧又长又缓：车飞过坡顶以后落在一段缓下坡上，落地是轻的。
 * 两侧一样长的话，落点正好在坡脚往上翘的地方，高速过去会被狠狠颠起来
 */
const JUMP = { x: -262, z: 326, height: 1.5, rise: 22, fall: 46 };
/** 弯道最多往里倾斜多少（横坡，0.06 约三度半） */
const MAX_BANK = 0.06;
/** 路面最陡允许多少 */
const MAX_GRADE = 0.08;
const STEP = 2;

let cached: MountainTrack | null = null;

export function buildMountainTrack(): MountainTrack {
  if (cached) return cached;
  const raw = resample(relax(buildPolyline(STEP), 4, 2), STEP);
  const n = raw.length;

  // 起点：湖边直道上，过了 S 弯一小段
  let startIdx = 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(raw[i][0] + 170, raw[i][1] + 388);
    if (d < best) {
      best = d;
      startIdx = i;
    }
  }
  const pts: Pt[] = [];
  for (let k = 0; k < n; k++) pts.push(raw[(startIdx + k) % n]);

  /* ---- 高低：照着山坡走，再把太陡、太颠的地方抹平 ---- */
  let y: Float64Array = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = slope(pts[i][0], pts[i][1]);
  y = blur(y, 14, 2);
  // 限制坡度：往前、往后各扫一遍（每一步最多升降这么多），取平均，再抹一下；反复几次就收敛了
  const lim = MAX_GRADE * STEP;
  for (let pass = 0; pass < 8; pass++) {
    const fwd = Float64Array.from(y);
    for (let r = 0; r < 2; r++) for (let i = 0; i < n; i++) {
      const p = fwd[(i - 1 + n) % n];
      fwd[i] = clamp(fwd[i], p - lim, p + lim);
    }
    const back = Float64Array.from(y);
    for (let r = 0; r < 2; r++) for (let i = n - 1; i >= 0; i--) {
      const p = back[(i + 1) % n];
      back[i] = clamp(back[i], p - lim, p + lim);
    }
    for (let i = 0; i < n; i++) y[i] = (fwd[i] + back[i]) / 2;
    y = blur(y, 9, 2);
  }

  /* ---- 山脊上的一个坡顶：直道中间鼓起来一下，开快了四个轮子会离地 ---- */
  {
    let at = 0;
    let best2 = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pts[i][0] - JUMP.x, pts[i][1] - JUMP.z);
      if (d < best2) {
        best2 = d;
        at = i;
      }
    }
    for (let k = -60; k <= 90; k++) {
      const i = (at + k + n) % n;
      y[i] += JUMP.height * Math.exp(-(((k * STEP) / (k < 0 ? JUMP.rise : JUMP.fall)) ** 2));
    }
  }

  /* ---- 采样点 ---- */
  const samples: TrackSample[] = [];
  let s = 0;
  for (let k = 0; k < n; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % n];
    const p = pts[(k - 1 + n) % n];
    const dx = b[0] - p[0];
    const dz = b[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    const dir = new Vector3(dx / len, 0, dz / len);
    const left = new Vector3(dir.z, 0, -dir.x);
    const h0 = Math.atan2(a[0] - p[0], a[1] - p[1]);
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const seg = (Math.hypot(a[0] - p[0], a[1] - p[1]) + Math.hypot(b[0] - a[0], b[1] - a[1])) / 2 || 1;
    samples.push({ s, pos: new Vector3(a[0], y[k], a[1]), dir, left, curvature: dh / seg });
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  // 曲率抹一下：三点算出来的值有毛刺，AI 按它定车速
  {
    let c: Float64Array = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = samples[i].curvature;
    c = blur(c, 2, 1);
    for (let i = 0; i < n; i++) samples[i].curvature = c[i];
  }

  /* ---- 弯道的内倾：跟着曲率走，最多三度半；进弯出弯是渐变的 ---- */
  let bankRaw: Float64Array = new Float64Array(n);
  for (let i = 0; i < n; i++) bankRaw[i] = clamp(samples[i].curvature * 4.6, -MAX_BANK, MAX_BANK);
  bankRaw = blur(bankRaw, 7, 2);
  const bank = Float32Array.from(bankRaw);

  /* ---- 坡度、坡顶 ---- */
  const grade = new Float32Array(n);
  const crest = new Uint8Array(n);
  const ds = s / n;
  for (let i = 0; i < n; i++) {
    const a = y[(i - 2 + n) % n];
    const b = y[(i + 2) % n];
    grade[i] = (b - a) / (4 * ds);
  }
  for (let i = 0; i < n; i++) {
    // 竖向的弯曲：往下弯得厉害的地方（坡顶），开快了车会飘起来
    const bend = (y[(i + 6) % n] - 2 * y[i] + y[(i - 6 + n) % n]) / (36 * ds * ds);
    if (bend < -0.0032) crest[i] = 1;
  }

  /* ---- 隧道和高架桥：山嘴高出路面足够多的那一段是隧道，山沟低于路面足够多的那一段是桥 ---- */
  const spans: Span[] = [];
  const mark = (kind: Span['kind'], test: (i: number) => boolean) => {
    let from = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && test(i);
      if (on && from < 0) from = i;
      if (!on && from >= 0) {
        if (i - from > 12) spans.push({ kind, i0: from, i1: i - 1 });
        from = -1;
      }
    }
  };
  mark('tunnel', (i) => baseHeight(pts[i][0], pts[i][1]) - y[i] > 10.5 && spurAt(pts[i][0], pts[i][1]) > 8);
  mark('bridge', (i) => y[i] - baseHeight(pts[i][0], pts[i][1]) > 4.5 && gorgeAt(pts[i][0], pts[i][1]) > 4);

  const s0 = samples[0];
  cached = {
    samples,
    length: s,
    start: { x: s0.pos.x, y: s0.pos.y, z: s0.pos.z, yaw: Math.atan2(s0.dir.x, s0.dir.z) },
    crest,
    bank,
    spans,
    grade,
  };
  return cached;
}

/* ------------------------------------------------------------------ */
/* 离路最近的点                                                         */
/* ------------------------------------------------------------------ */

const CELL = 24;
let grid: Map<number, number[]> | null = null;
const cellKey = (cx: number, cz: number) => (cx + 2048) * 4096 + (cz + 2048);

function roadGrid(): Map<number, number[]> {
  if (grid) return grid;
  const g = new Map<number, number[]>();
  const S = buildMountainTrack().samples;
  for (let i = 0; i < S.length; i++) {
    const k = cellKey(Math.floor(S[i].pos.x / CELL), Math.floor(S[i].pos.z / CELL));
    let list = g.get(k);
    if (!list) g.set(k, (list = []));
    list.push(i);
  }
  grid = g;
  return g;
}

export interface RoadHit {
  /** 最近的采样点 */
  index: number;
  /** 离中心线多远（米） */
  dist: number;
  /** 在中心线的哪一侧：正 = 左 */
  lateral: number;
  /** 那一处的路面高度（算上了弯道的横坡；路基以外是路基边上的高度） */
  y: number;
  /** 那一处是隧道、桥，还是普通路段 */
  span: Span['kind'] | null;
}

const _hit: RoadHit = { index: 0, dist: 0, lateral: 0, y: 0, span: null };

/** 找离 (x, z) 最近的那一段路。超过 reach 米以外的不管，返回 null。返回的对象是复用的，用完就别留着 */
export function nearestRoad(x: number, z: number, reach = 48): RoadHit | null {
  const track = buildMountainTrack();
  const S = track.samples;
  const g = roadGrid();
  const r = Math.ceil(reach / CELL);
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let best = reach * reach;
  let bi = -1;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const list = g.get(cellKey(cx + dx, cz + dz));
      if (!list) continue;
      for (const i of list) {
        const p = S[i].pos;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
    }
  }
  if (bi < 0) return null;
  // 在最近点前后两段上投影，取更近的
  const n = S.length;
  const p = S[bi];
  const along = (x - p.pos.x) * p.dir.x + (z - p.pos.z) * p.dir.z;
  const other = S[(bi + (along >= 0 ? 1 : -1) + n) % n];
  const t = clamp(Math.abs(along) / STEP, 0, 1);
  const px = lerp(p.pos.x, other.pos.x, t);
  const pz = lerp(p.pos.z, other.pos.z, t);
  _hit.index = bi;
  _hit.dist = Math.hypot(x - px, z - pz);
  _hit.lateral = (x - p.pos.x) * p.left.x + (z - p.pos.z) * p.left.z;
  // 路面是带横坡的：路基范围内按横坡算，路基以外按路基边上的高度算
  _hit.y = lerp(p.pos.y, other.pos.y, t) - track.bank[bi] * clamp(_hit.lateral, -MOUNTAIN.bench, MOUNTAIN.bench);
  _hit.span = spanAt(bi);
  return _hit;
}

/** 第 i 个采样点处、离中心线 lateral 米（左为正）的路面高度 */
export function roadHeightAt(i: number, lateral: number): number {
  const track = buildMountainTrack();
  return track.samples[i].pos.y - track.bank[i] * lateral;
}

let spanOf: Int8Array | null = null;

/** 第 i 个采样点是不是在隧道里 / 桥上 */
export function spanAt(i: number): Span['kind'] | null {
  if (!spanOf) {
    const track = buildMountainTrack();
    spanOf = new Int8Array(track.samples.length);
    for (const sp of track.spans) for (let k = sp.i0; k <= sp.i1; k++) spanOf[k] = sp.kind === 'tunnel' ? 1 : 2;
  }
  const v = spanOf[i];
  return v === 1 ? 'tunnel' : v === 2 ? 'bridge' : null;
}

/* ------------------------------------------------------------------ */
/* 地形                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 地面的高度：离路远的地方是山本来的样子；靠近路的地方被挖开（路堑）或者垫高（路堤），和路基接上。
 * 隧道上面、桥下面不受路的影响。
 */
export function terrainHeight(x: number, z: number): number {
  const h = baseHeight(x, z);
  const q = nearestRoad(x, z, 36);
  if (!q || q.span) return h;
  const e = q.dist - MOUNTAIN.bench;
  if (e <= 0) return q.y - 0.06;
  const delta = h - q.y;
  // 往上是挖出来的石壁（陡），往下是填出来的路堤（缓）
  const w = delta > 0 ? clamp(3.5 + 0.8 * delta, 5, 22) : clamp(6 + 1.6 * -delta, 6, 22);
  return q.y - 0.06 + (delta + 0.06) * smooth(e / w);
}

/** 地面的法线（朝上的单位向量），按高度差分出来 */
export function terrainNormal(x: number, z: number, out: Vector3, eps = 1.2): Vector3 {
  const hx = terrainHeight(x + eps, z) - terrainHeight(x - eps, z);
  const hz = terrainHeight(x, z + eps) - terrainHeight(x, z - eps);
  return out.set(-hx, 2 * eps, -hz).normalize();
}

/** 车能落脚的高度：路上（含桥面、隧道里）是路面，路外是地面。把车放到某个位置时用 */
export function surfaceHeight(x: number, z: number): number {
  const q = nearestRoad(x, z, 30);
  if (q && q.dist < MOUNTAIN.bench) return q.y;
  return terrainHeight(x, z);
}
