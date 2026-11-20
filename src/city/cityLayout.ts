import { Vector3 } from 'three';

/**
 * 城市布局：纯数据和几何计算，不依赖渲染，物理、画面、自动驾驶都从这里取数。
 *
 * 坐标：米。街区是规则网格——南北向的叫"大道"（avenue，沿 Z），东西向的叫"街"（street，沿 X）。
 * 车头朝 +Z 时左手边是 +X。
 */
export const CITY = {
  /** 相邻两条路中心线的间距 */
  pitch: 110,
  /** 路面宽度（路缘到路缘） */
  road: 16,
  /** 人行道宽度 */
  sidewalk: 4.5,
  /** 路缘高度 */
  curb: 0.15,
  /** 大道条数（i = 0..6） */
  ni: 7,
  /** 街条数（j = 0..7） */
  nj: 8,
  /** 第几排街区是河（街 4 和街 5 之间） */
  riverRow: 4,
};

export const HALF_ROAD = CITY.road / 2;
/** 街区（含人行道）的边长 */
export const BLOCK = CITY.pitch - CITY.road;

export const avenueX = (i: number) => (i - 3) * CITY.pitch;
export const streetZ = (j: number) => (j - 3.5) * CITY.pitch;

/** 河面范围（Z 方向）：两岸人行道外沿之间 */
export const RIVER = {
  z0: streetZ(CITY.riverRow) + HALF_ROAD + CITY.sidewalk,
  z1: streetZ(CITY.riverRow + 1) - HALF_ROAD - CITY.sidewalk,
};

/** 陆地范围 */
export const LAND = {
  west: avenueX(0) - HALF_ROAD - BLOCK - 30,
  /** 东岸（湖岸线）：最东一条大道的人行道外沿 */
  east: avenueX(CITY.ni - 1) + HALF_ROAD + CITY.sidewalk,
  south: streetZ(0) - HALF_ROAD - BLOCK - 30,
  north: streetZ(CITY.nj - 1) + HALF_ROAD + BLOCK + 30,
};

/** 湖滨半岛：一个大半圆，湖滨大道沿着它的边缘 */
export const LAKESHORE = {
  cx: avenueX(6) + 30,
  cz: (streetZ(4) + streetZ(1)) / 2,
  /** 湖滨大道中心线的半径 */
  radius: (streetZ(4) - streetZ(1)) / 2,
  /** 外侧步道宽度 */
  promenade: 6,
};

/** 拱桥（大道 2 过河）：桥面中间拱起的高度 */
export const ARCH_BRIDGE = { avenue: 2, rise: 3.6 };
/** 平桥（大道 5 过河） */
export const FLAT_BRIDGE = { avenue: 5 };
/** 高架铁路：沿大道 2，从街 1 到街 4 */
export const ELEVATED = { avenue: 2, j0: 1, j1: 4, height: 7.2 };
/** 下层街道：街 7 上从大道 3 到大道 5 的一段，上方压着一层路面 */
export const LOWER_LEVEL = { street: 7, i0: 3, i1: 5, clearance: 5.6 };

/** 路面高度：只有拱桥上不是 0 */
export function roadHeight(x: number, z: number): number {
  if (Math.abs(x - avenueX(ARCH_BRIDGE.avenue)) > HALF_ROAD + 3) return 0;
  if (z <= RIVER.z0 || z >= RIVER.z1) return 0;
  const t = (z - RIVER.z0) / (RIVER.z1 - RIVER.z0);
  const s = Math.sin(Math.PI * t);
  return ARCH_BRIDGE.rise * s * s;
}

/* ------------------------------------------------------------------ */
/* 赛道路线                                                             */
/* ------------------------------------------------------------------ */

export interface TrackSample {
  /** 沿赛道的累计距离 */
  s: number;
  pos: Vector3;
  /** 行进方向（水平单位向量） */
  dir: Vector3;
  /** 左侧方向 */
  left: Vector3;
  /** 曲率（1/半径，带符号：正 = 左弯） */
  curvature: number;
}

/** 一条赛道（名字是历史原因：最早只有城市这一条，山路的赛道也是这个形状） */
export interface CityTrack {
  samples: TrackSample[];
  length: number;
  /** 起点；y 是那里的路面高度（不写就是 0） */
  start: { x: number; y?: number; z: number; yaw: number };
  /**
   * 每个采样点一个标记：车在这里可能离地（拱桥、坡顶）。自动驾驶在它前面不开氮气，检查点也不放在这里。
   * 不给的话按「路面高出地面」来判断（城市赛道只有拱桥那一处）。
   */
  crest?: Uint8Array;
}

type Pt = [number, number];

/** 路线的折点（网格路口），以及每个折点的转弯半径 */
function routeCorners(): { p: Pt; r: number }[] {
  const X = avenueX;
  const Z = streetZ;
  return [
    // 过了拱桥之后再往北两个街区才转弯：高速冲桥会腾空，落地后要留足刹车距离
    { p: [X(2), Z(7)], r: 18 },
    { p: [X(5), Z(7)], r: 18 },
    { p: [X(5), Z(4)], r: 16 },
    // 这里接湖滨大道的大半圆（单独处理）
    { p: [X(4), Z(1)], r: 16 },
    { p: [X(4), Z(0)], r: 14 },
    { p: [X(3), Z(0)], r: 14 },
    { p: [X(3), Z(1)], r: 14 },
    { p: [X(2), Z(1)], r: 18 },
  ];
}

/** 把"直线 + 圆角 + 湖滨半圆"连成一圈密集的点 */
function buildPolyline(step: number): Pt[] {
  const c = routeCorners();
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
  const arc = (cx: number, cz: number, r: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / step));
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      push(cx + r * Math.cos(a), cz + r * Math.sin(a));
    }
  };
  /** 直角圆角：从 prev 方向进、往 next 方向出，返回切点 */
  const fillet = (prev: Pt, v: Pt, next: Pt, r: number) => {
    const d1: Pt = [Math.sign(v[0] - prev[0]), Math.sign(v[1] - prev[1])];
    const d2: Pt = [Math.sign(next[0] - v[0]), Math.sign(next[1] - v[1])];
    const t1: Pt = [v[0] - d1[0] * r, v[1] - d1[1] * r];
    const t2: Pt = [v[0] + d2[0] * r, v[1] + d2[1] * r];
    const center: Pt = [t1[0] + d2[0] * r, t1[1] + d2[1] * r];
    const a0 = Math.atan2(t1[1] - center[1], t1[0] - center[0]);
    let a1 = Math.atan2(t2[1] - center[1], t2[0] - center[0]);
    // 走短的那一侧
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
    return { t1, t2, center, a0, a1 };
  };

  const L = LAKESHORE;
  // 顺序：c0 c1 c2 → 湖滨 → c3 ... c7 → 回到 c0
  const lakeIn: Pt = [L.cx, streetZ(4)];
  const lakeOut: Pt = [L.cx, streetZ(1)];
  const order: Pt[] = [c[0].p, c[1].p, c[2].p, lakeIn, lakeOut, c[3].p, c[4].p, c[5].p, c[6].p, c[7].p];
  const radius = [c[0].r, c[1].r, c[2].r, 0, 0, c[3].r, c[4].r, c[5].r, c[6].r, c[7].r];
  const n = order.length;

  let cursor: Pt | null = null;
  for (let k = 0; k < n; k++) {
    const prev = order[(k - 1 + n) % n];
    const v = order[k];
    const next = order[(k + 1) % n];
    if (k === 3) {
      // 进入湖滨：直线接到半圆起点，然后整段半圆
      if (cursor) line(cursor, lakeIn);
      arc(L.cx, L.cz, L.radius, Math.PI / 2, -Math.PI / 2);
      cursor = lakeOut;
      continue;
    }
    if (k === 4) continue;
    const f = fillet(prev, v, next, radius[k]);
    if (cursor) line(cursor, f.t1);
    else pts.push(f.t1);
    arc(f.center[0], f.center[1], radius[k], f.a0, f.a1);
    cursor = f.t2;
  }
  // 闭合：最后一个圆角的出口接回第一个圆角的入口
  line(cursor!, pts[0]);
  pts.pop();
  return pts;
}

let cached: CityTrack | null = null;

export function buildCityTrack(step = 2): CityTrack {
  if (cached && step === 2) return cached;
  const raw = buildPolyline(step);
  const n = raw.length;

  // 起点：大道 2 上、街 1 往北 55 米处，车头朝 +Z
  const start = { x: avenueX(2), z: streetZ(1) + 55, yaw: 0 };
  let startIdx = 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(raw[i][0] - start.x, raw[i][1] - start.z);
    if (d < best) {
      best = d;
      startIdx = i;
    }
  }

  const samples: TrackSample[] = [];
  let s = 0;
  for (let k = 0; k < n; k++) {
    const a = raw[(startIdx + k) % n];
    const b = raw[(startIdx + k + 1) % n];
    const p = raw[(startIdx + k - 1 + n) % n];
    const dx = b[0] - p[0];
    const dz = b[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    const dir = new Vector3(dx / len, 0, dz / len);
    const left = new Vector3(dir.z, 0, -dir.x);
    // 曲率：前后两段方向角之差 / 弧长
    const h0 = Math.atan2(a[0] - p[0], a[1] - p[1]);
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const seg = (Math.hypot(a[0] - p[0], a[1] - p[1]) + Math.hypot(b[0] - a[0], b[1] - a[1])) / 2 || 1;
    samples.push({ s, pos: new Vector3(a[0], roadHeight(a[0], a[1]), a[1]), dir, left, curvature: dh / seg });
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const track = { samples, length: s, start };
  if (step === 2) cached = track;
  return track;
}

/* ------------------------------------------------------------------ */
/* 路口封堵                                                             */
/* ------------------------------------------------------------------ */

export interface Barrier {
  /** 护栏中心 */
  x: number;
  z: number;
  /** 护栏走向与 X 轴的夹角：0 = 沿 X 横着摆（封南北向的路），π/2 = 沿 Z */
  alongX: boolean;
  /** 长度 */
  length: number;
  /** 朝向赛道一侧的法线（指向路口） */
  nx: number;
  nz: number;
  /**
   * 这道护栏在赛道上是什么角色：
   * side = 直道经过的路口，封的是两边的岔路；
   * ahead = 弯道路口里正对着来车的那一道（车要在它前面拐弯），上面是一排指着出弯方向的箭头；
   * wrong = 弯道路口里不该拐过去的那一侧
   */
  kind: 'side' | 'ahead' | 'wrong';
  /** ahead：出弯的方向（沿着护栏的单位向量）；其余是 0 */
  tx: number;
  tz: number;
}

/** 路口的四条臂：从路口中心往外的方向。顺序就是地面箭头那张小图的四个通道 */
const ARMS: [string, number, number][] = [
  ['+x', 1, 0],
  ['-x', -1, 0],
  ['+z', 0, 1],
  ['-z', 0, -1],
];

interface Junction {
  i: number;
  j: number;
  /** 赛道用到的臂 */
  arms: Set<string>;
  /** 赛道从哪条臂进来、从哪条臂出去 */
  entry: string;
  exit: string;
}

/** 沿路线走一遍，记下赛道经过的每个路口用了哪几条臂、从哪进从哪出 */
function routeJunctions(): Junction[] {
  const track = buildCityTrack();
  const used = new Map<string, Junction>();
  const P = CITY.pitch;
  const reach = HALF_ROAD + 10; // 离路口中心这么近就算"在路口里"
  for (const smp of track.samples) {
    const p = smp.pos;
    const i = Math.round(p.x / P + 3);
    const j = Math.round(p.z / P + 3.5);
    if (i < 0 || j < 0 || i >= CITY.ni || j >= CITY.nj) continue;
    const ox = p.x - avenueX(i);
    const oz = p.z - streetZ(j);
    if (Math.abs(ox) > reach + 14 || Math.abs(oz) > reach + 14) continue;
    // 路线在这个路口的哪条"臂"上
    let arm = '';
    if (Math.abs(ox) > reach && Math.abs(oz) < HALF_ROAD + 2) arm = ox > 0 ? '+x' : '-x';
    else if (Math.abs(oz) > reach && Math.abs(ox) < HALF_ROAD + 2) arm = oz > 0 ? '+z' : '-z';
    if (!arm) continue;
    const key = `${i},${j}`;
    let jn = used.get(key);
    if (!jn) used.set(key, (jn = { i, j, arms: new Set(), entry: '', exit: '' }));
    jn.arms.add(arm);
    // 车头朝着路口中心开 = 从这条臂进来
    const [, ax, az] = ARMS.find((a) => a[0] === arm)!;
    if (smp.dir.x * ax + smp.dir.z * az < 0) jn.entry = arm;
    else jn.exit = arm;
  }
  return [...used.values()];
}

/** 一个弯道路口：从哪条臂进来（ARMS 里的序号）、进来和出去时的车头方向、往左还是往右拐 */
export interface TurnHint {
  i: number;
  j: number;
  arm: number;
  /** 进弯时的车头方向 */
  inX: number;
  inZ: number;
  /** 出弯后的车头方向 */
  outX: number;
  outZ: number;
  left: boolean;
}

/** 赛道上所有在路口拐直角弯的地方 */
export function buildTurnHints(): TurnHint[] {
  const out: TurnHint[] = [];
  for (const jn of routeJunctions()) {
    const a = ARMS.findIndex((v) => v[0] === jn.entry);
    const b = ARMS.findIndex((v) => v[0] === jn.exit);
    if (a < 0 || b < 0) continue;
    const inX = -ARMS[a][1];
    const inZ = -ARMS[a][2];
    const outX = ARMS[b][1];
    const outZ = ARMS[b][2];
    // 进出同一条线上：直行
    if (inX * outX + inZ * outZ !== 0) continue;
    // 车头朝 (x, z) 时左手边是 (z, -x)
    out.push({ i: jn.i, j: jn.j, arm: a, inX, inZ, outX, outZ, left: outX * inZ - outZ * inX > 0 });
  }
  return out;
}

/**
 * 赛道经过的每个路口，把不属于赛道的岔路用护栏封住。
 * 做法：沿路线走一遍，记录每个路口实际用到的进出方向，剩下的方向都封。
 *
 * 直道经过的路口，护栏退到岔路里面十几米；弯道路口的两道（见 Barrier.kind）则贴着楼的外墙线摆，
 * 把路口围成一个直角弯：来车隔着老远就能从街角看到哪边是封死的，
 * 两边楼的橱窗也照不到箭头屏（玻璃里映出来的箭头是反的，会指错方向）。
 */
export function buildBarriers(): Barrier[] {
  const turns = new Map(buildTurnHints().map((t) => [`${t.i},${t.j}`, t]));
  const out: Barrier[] = [];
  const span = CITY.road + CITY.sidewalk * 2; // 连人行道一起封
  const dist = HALF_ROAD + 13; // 护栏离路口中心的距离（在斑马线外侧）
  const flush = HALF_ROAD + CITY.sidewalk + 0.4; // 贴着楼的外墙线
  for (const jn of routeJunctions()) {
    const { i, j } = jn;
    const cx = avenueX(i);
    const cz = streetZ(j);
    const turn = turns.get(`${i},${j}`);
    for (const [name, di, dj] of ARMS) {
      if (jn.arms.has(name)) continue;
      // 最东一条大道往东是湖：湖滨大道的两个接口由路线占用，其余没有路
      if (di === 1 && i === CITY.ni - 1) continue;
      const ahead = !!turn && di === turn.inX && dj === turn.inZ;
      const wrong = !!turn && di === -turn.outX && dj === -turn.outZ;
      // 通向（非赛道）桥面的岔路：护栏直接摆在岸边桥头，不摆到桥上去
      const ontoBridge = (j === CITY.riverRow && dj === 1) || (j === CITY.riverRow + 1 && dj === -1);
      const d = ontoBridge ? HALF_ROAD + CITY.sidewalk + 0.8 : wrong || ahead ? flush : dist;
      out.push({
        x: cx + di * d,
        z: cz + dj * d,
        alongX: dj !== 0,
        length: span,
        nx: -di,
        nz: -dj,
        kind: ahead ? 'ahead' : wrong ? 'wrong' : 'side',
        tx: ahead ? turn!.outX : 0,
        tz: ahead ? turn!.outZ : 0,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 街区与楼体                                                           */
/* ------------------------------------------------------------------ */

export interface Building {
  /** 占地中心与尺寸 */
  x: number;
  z: number;
  w: number;
  d: number;
  /** 总高度 */
  h: number;
  /** 裙楼高度（0 = 没有裙楼，上下一样粗） */
  podium: number;
  /** 塔楼相对裙楼向内收的距离 */
  setback: number;
  /** 立面风格：0 玻璃幕墙，1 石材，2 砖，3 深色现代 */
  style: number;
  seed: number;
}

export interface Block {
  i: number;
  j: number;
  /** 人行道板的中心与尺寸 */
  x: number;
  z: number;
  w: number;
  d: number;
  buildings: Building[];
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成所有街区和楼体。外圈多生成一圈，让边缘的路两侧也有楼 */
export function buildBlocks(): Block[] {
  const blocks: Block[] = [];
  const rnd = rng(20261110);
  // 两个高楼核心：河北岸的金融区、河南岸的老城区
  const cores: [number, number, number][] = [
    [-20, 290, 1.0],
    [-130, -90, 0.75],
    [150, -200, 0.45],
  ];

  for (let j = -1; j < CITY.nj; j++) {
    if (j === CITY.riverRow) continue; // 河
    for (let i = -1; i < CITY.ni - 1; i++) {
      const outerX = i === -1;
      const outerZ = j === -1 || j === CITY.nj - 1;
      const x0 = outerX ? avenueX(0) - HALF_ROAD - BLOCK : avenueX(i) + HALF_ROAD;
      const z0 = j === -1 ? streetZ(0) - HALF_ROAD - BLOCK : streetZ(j) + HALF_ROAD;
      const block: Block = { i, j, x: x0 + BLOCK / 2, z: z0 + BLOCK / 2, w: BLOCK, d: BLOCK, buildings: [] };

      // 可建范围：退进人行道宽度
      const bw = BLOCK - CITY.sidewalk * 2;
      const pattern = rnd();
      // 地块划分：2×2、1×2、2×1、整块。楼与楼之间不留缝，车钻不进街区内部
      const nx = pattern < 0.55 ? 2 : pattern < 0.72 ? 1 : pattern < 0.9 ? 2 : 1;
      const nz = pattern < 0.55 ? 2 : pattern < 0.72 ? 2 : pattern < 0.9 ? 1 : 1;
      // 不等分，街景更自然
      const splitX = nx === 2 ? 0.38 + rnd() * 0.24 : 1;
      const splitZ = nz === 2 ? 0.38 + rnd() * 0.24 : 1;

      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < nz; b++) {
          const w = nx === 2 ? (a === 0 ? splitX : 1 - splitX) * bw : bw;
          const d = nz === 2 ? (b === 0 ? splitZ : 1 - splitZ) * bw : bw;
          const lx = block.x - bw / 2 + (nx === 2 && a === 1 ? splitX * bw : 0) + w / 2;
          const lz = block.z - bw / 2 + (nz === 2 && b === 1 ? splitZ * bw : 0) + d / 2;

          // 高度：离核心越近越高，外圈和湖边偏矮
          let tall = 0;
          for (const [cx, cz, k] of cores) tall = Math.max(tall, k * Math.exp(-(((lx - cx) / 190) ** 2 + ((lz - cz) / 190) ** 2)));
          const edge = outerX || outerZ ? 0.55 : 1;
          const r = rnd();
          let h = (16 + r * r * 30 + tall * (60 + rnd() * 130)) * edge;
          if (rnd() < 0.12) h *= 0.45; // 偶尔一栋矮楼，打破天际线
          h = Math.max(12, Math.round(h / 3.6) * 3.6);

          const style = h > 90 ? (rnd() < 0.7 ? 0 : 3) : h > 45 ? Math.floor(rnd() * 4) : rnd() < 0.5 ? 2 : 1;
          const hasPodium = h > 50 && rnd() < 0.7;
          block.buildings.push({
            x: lx,
            z: lz,
            w,
            d,
            h,
            podium: hasPodium ? 14.4 + Math.floor(rnd() * 3) * 3.6 : 0,
            setback: hasPodium ? 3 + rnd() * 5 : 0,
            style,
            seed: Math.floor(rnd() * 1e6),
          });
        }
      }
      blocks.push(block);
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* 底层店面                                                             */
/* ------------------------------------------------------------------ */

/** 每家店的开间（米）。立面着色器、店面灯光都按它切 */
export const SHOP_BAY = 5.5;

/**
 * 入夜后这家店亮不亮灯。seed 是楼的随机种子，face 是哪一面墙（0 东、1 西、2 北、3 南），k 是这面墙上的第几家。
 * 立面着色器（橱窗里亮不亮）和地面光照图（店门口地上有没有光）都问它，两边才对得上。
 */
export function shopLit(seed: number, face: number, k: number): boolean {
  let h = Math.imul(seed | 0, 73856093) ^ Math.imul(face + 1, 19349663) ^ Math.imul(k + 1, 83492791);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) % 100 < 46;
}

/** 一面墙上各家店亮不亮，压成一个数（第 k 位 = 第 k 家），当顶点属性传给着色器。最多 24 家 */
export function shopMask(seed: number, face: number, wallLength: number): number {
  const n = Math.min(24, Math.ceil(wallLength / SHOP_BAY));
  let mask = 0;
  for (let k = 0; k < n; k++) if (shopLit(seed, face, k)) mask += 2 ** k;
  return mask;
}

/* ------------------------------------------------------------------ */
/* 立面的开间和层高                                                     */
/* ------------------------------------------------------------------ */

/** 底层店面的高度（米）：往上才是一层层的标准层 */
export const GROUND_FLOOR = 5.0;

/**
 * 一面墙的窗格怎么排：按立面风格给出理想的开间和层高，再微调到正好排满整面墙。
 * 立面着色器（画窗）和立面上的小构件（防火梯、檐口）都用它，位置才对得上。
 * @param top 这一段楼体的顶高
 */
export function facadeGrid(style: number, wallLength: number, top: number): { bay: number; floorH: number; floors: number } {
  const bayTarget = [1.6, 3.6, 3.1, 2.4][style];
  const floorTarget = [4.0, 3.7, 3.4, 3.8][style];
  const bay = wallLength / Math.max(1, Math.round(wallLength / bayTarget));
  const usable = Math.max(floorTarget, top - GROUND_FLOOR - 1.3);
  const floors = Math.max(1, Math.round(usable / floorTarget));
  return { bay, floorH: usable / floors, floors };
}
