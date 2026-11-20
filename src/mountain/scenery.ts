import * as THREE from 'three/webgpu';
import { MeshBuilder, type V3 } from '../city/MeshBuilder.ts';
import type { CityLight, SkyCover } from '../city/cityLights.ts';
import type { GlowSpot } from '../city/LampGlow.ts';
import { MOUNTAIN, nearestRoad, roadHeightAt, spanAt, terrainHeight, type MountainTrack } from './mountainLayout.ts';
import type { SceneryMaterials } from './sceneryMaterials.ts';
import { SIGNS } from './signRects.ts';
import type { MountainMaterials } from './mountainMaterials.ts';

/**
 * 山路沿线的「东西」：路边的设施（电线杆、路牌、棚洞、围栏）和一路上的地标
 * （湖边的加油站和餐馆、码头、看台、山腰的木屋、观景台和缆车、山顶的天文台和风车、伐木场、瀑布）。
 *
 * 全都立在护栏外面，不碰物理：车开不到的地方不需要碰撞体，无头仿真的结果也就不会变。
 * 几何是用小方块、圆柱、斜屋顶这几样搭的，颜色写在顶点上，同一种质感的东西最后合成一个网格。
 */

export interface SceneryHost {
  readonly track: MountainTrack;
  readonly group: THREE.Group;
  readonly lamps: CityLight[];
  readonly glowSpots: GlowSpot[];
  readonly covers: SkyCover[];
  readonly bends: { i0: number; i1: number; side: number; radius: number }[];
  readonly mats: MountainMaterials;
  readonly looks: SceneryMaterials;
  /** 湖水的材质（山沟里的那汪潭也用它） */
  readonly water: THREE.Material;
  add(b: MeshBuilder, material: THREE.Material, cast?: boolean, receive?: boolean, detail?: boolean): void;
}

/** 每帧要动的东西（风车、缆车） */
export interface SceneryAnim {
  update(dt: number): void;
  /** 盖了东西的地方（圆心和半径）：种树、撒石头的时候让开 */
  readonly clearings: { x: number; z: number; r: number }[];
}

/** 电线沿着哪几段路走（起点、终点的路程，在路的哪一侧：1 左、-1 右）。种树的时候要给它让出一条 */
export const POWER_LINES: [number, number, number][] = [
  [400, 1040, 1],
  [1460, 1730, -1],
  [1880, 2620, 1],
  [3270, 3880, -1],
];
/** 电线杆离中心线多远 */
export const POLE_OFFSET = MOUNTAIN.rail + 3.4;
/** 棚洞在哪一段（路程） */
export const GALLERY: [number, number] = [1088, 1198];
/** 山沟里的水：沿着这条线往下淌（x 固定，z 从北到南），种树的时候让开 */
export const CASCADE = { x: -506, z0: 132, z1: -112, pond: 18.4 };

type Tint = V3;
const WHITE: Tint = [0.5, 0.5, 0.48];
const CREAM: Tint = [0.46, 0.4, 0.3];
const CONCRETE: Tint = [0.24, 0.235, 0.22];
const STONE: Tint = [0.2, 0.19, 0.175];
const DARK: Tint = [0.035, 0.037, 0.04];
const GALV: Tint = [0.3, 0.31, 0.32];
const WOOD: Tint = [0.13, 0.085, 0.05];
const WOOD_DARK: Tint = [0.065, 0.042, 0.028];
const WOOD_LIGHT: Tint = [0.3, 0.22, 0.13];
const WOOD_GREY: Tint = [0.16, 0.14, 0.12];
const RED: Tint = [0.42, 0.045, 0.035];
const ORANGE: Tint = [0.5, 0.11, 0.03];
const ROOF_RED: Tint = [0.26, 0.045, 0.035];
const ROOF_GREEN: Tint = [0.05, 0.11, 0.08];
const ROOF_GREY: Tint = [0.09, 0.095, 0.1];
const ASPHALT: Tint = [0.05, 0.05, 0.053];
const YELLOW: Tint = [0.6, 0.4, 0.03];
const BLUE: Tint = [0.05, 0.12, 0.32];
const GLASS_DARK: Tint = [0.02, 0.026, 0.034];
const WARM: Tint = [1.0, 0.62, 0.3];
const COOL: Tint = [0.8, 0.88, 1.0];
const LAMP_WARM: [number, number, number] = [1.0, 0.66, 0.32];
const LAMP_WHITE: [number, number, number] = [0.86, 0.93, 1.0];
const CAR_COLORS: Tint[] = [
  [0.4, 0.04, 0.03],
  [0.03, 0.07, 0.22],
  [0.42, 0.42, 0.42],
  [0.03, 0.03, 0.035],
  [0.36, 0.26, 0.04],
  [0.5, 0.5, 0.5],
  [0.05, 0.16, 0.1],
];

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 摆东西用的局部坐标系：原点 o，水平的「往前」f 和「往左」l */
export class Frame {
  readonly o: THREE.Vector3;
  readonly f: THREE.Vector3;
  readonly l: THREE.Vector3;
  // （不用「构造函数参数直接当属性」的写法：无头脚本是让 Node 直接跑这个文件的，它不认）
  constructor(o: THREE.Vector3, f: THREE.Vector3, l: THREE.Vector3) {
    this.o = o;
    this.f = f;
    this.l = l;
  }
  /** 往前 a 米、往左 b 米、往上 h 米的那一点 */
  p(a: number, b: number, h: number): V3 {
    return [this.o.x + this.f.x * a + this.l.x * b, this.o.y + h, this.o.z + this.f.z * a + this.l.z * b];
  }
  v(a: number, b: number, h: number): THREE.Vector3 {
    return new THREE.Vector3(...this.p(a, b, h));
  }
  /** 局部的方向换成世界的方向 */
  d(a: number, b: number, h = 0): V3 {
    return [this.f.x * a + this.l.x * b, h, this.f.z * a + this.l.z * b];
  }
  /** 挪到 (a, b, h) 再往左转 turn 弧度的新坐标系 */
  at(a: number, b: number, h: number, turn = 0): Frame {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    return new Frame(
      this.v(a, b, h),
      new THREE.Vector3(this.f.x * c + this.l.x * s, 0, this.f.z * c + this.l.z * s),
      new THREE.Vector3(this.l.x * c - this.f.x * s, 0, this.l.z * c - this.f.z * s),
    );
  }
}

/** 长方体：往前 a0–a1，往左 b0–b1，高 h0–h1 */
function box(b: MeshBuilder, F: Frame, a0: number, a1: number, b0: number, b1: number, h0: number, h1: number, bottom = false): void {
  const P = (a: number, bb: number, h: number) => F.p(a, bb, h);
  b.quad(P(a1, b0, h0), P(a1, b1, h0), P(a1, b1, h1), P(a1, b0, h1), F.d(1, 0), [0, h0, b1 - b0, h1]);
  b.quad(P(a0, b0, h0), P(a0, b1, h0), P(a0, b1, h1), P(a0, b0, h1), F.d(-1, 0), [0, h0, b1 - b0, h1]);
  b.quad(P(a0, b1, h0), P(a1, b1, h0), P(a1, b1, h1), P(a0, b1, h1), F.d(0, 1), [0, h0, a1 - a0, h1]);
  b.quad(P(a0, b0, h0), P(a1, b0, h0), P(a1, b0, h1), P(a0, b0, h1), F.d(0, -1), [0, h0, a1 - a0, h1]);
  b.quad(P(a0, b0, h1), P(a1, b0, h1), P(a1, b1, h1), P(a0, b1, h1), [0, 1, 0], [0, 0, a1 - a0, b1 - b0]);
  if (bottom) b.quad(P(a0, b0, h0), P(a1, b0, h0), P(a1, b1, h0), P(a0, b1, h0), [0, -1, 0], [0, 0, a1 - a0, b1 - b0]);
}

/** 竖着的圆柱（圆台） */
function cyl(b: MeshBuilder, F: Frame, a: number, bb: number, h0: number, h1: number, r0: number, r1: number, sides = 8, cap = true): void {
  const c = F.p(a, bb, 0);
  b.cylinder(c[0], c[1] + h0, c[1] + h1, c[2], r0, r1, sides, cap);
}

/** 两面坡的屋顶：屋脊顺着「往前」的方向，檐口高 eave，屋脊再高出 rise，四周挑出 over */
function gableRoof(b: MeshBuilder, F: Frame, a0: number, a1: number, b0: number, b1: number, eave: number, rise: number, over = 0.6): void {
  const bm = (b0 + b1) / 2;
  const half = (b1 - b0) / 2;
  const drop = (over * rise) / half;
  const run = Math.hypot(half + over, rise + drop);
  for (const s of [-1, 1]) {
    const be = s < 0 ? b0 - over : b1 + over;
    const out = F.d(0, s * 0.5, 1);
    b.quad(F.p(a0 - over, be, eave - drop), F.p(a1 + over, be, eave - drop), F.p(a1 + over, bm, eave + rise), F.p(a0 - over, bm, eave + rise), out, [0, 0, a1 - a0 + over * 2, run]);
  }
}

/** 山墙上面的那个三角 */
function gableEnd(b: MeshBuilder, F: Frame, a: number, b0: number, b1: number, eave: number, rise: number, face: number): void {
  const top = F.p(a, (b0 + b1) / 2, eave + rise);
  b.quad(F.p(a, b0, eave), F.p(a, b1, eave), top, top, F.d(face, 0), [0, eave, b1 - b0, eave + rise]);
}

/** 躺着的圆木：轴顺着「往前」的方向 */
function log(b: MeshBuilder, F: Frame, a0: number, a1: number, bb: number, h: number, r: number, bark: Tint, cut: Tint, sides = 7): void {
  const ring = (a: number): V3[] => {
    const out: V3[] = [];
    for (let k = 0; k <= sides; k++) {
      const t = (k / sides) * Math.PI * 2;
      out.push(F.p(a, bb + Math.cos(t) * r, h + Math.sin(t) * r));
    }
    return out;
  };
  const A = ring(a0);
  const B = ring(a1);
  b.tint = bark;
  for (let k = 0; k < sides; k++) {
    const t = ((k + 0.5) / sides) * Math.PI * 2;
    b.quad(A[k], B[k], B[k + 1], A[k + 1], F.d(0, Math.cos(t), Math.sin(t)), [0, 0, a1 - a0, 1]);
  }
  b.tint = cut;
  for (const [R, a, face] of [[A, a0, -1], [B, a1, 1]] as const) {
    const c = F.p(a, bb, h);
    for (let k = 0; k < sides; k++) b.quad(c, R[k], R[k + 1], R[k + 1], F.d(face, 0));
  }
}

/** 一块牌子：立在局部的 a 处，牌面朝着「往后」（开过来的人看得见），中心往左 bb、下沿离地 h0 */
function plate(b: MeshBuilder, F: Frame, a: number, bb: number, h0: number, w: number, h: number, name: string): void {
  const r = SIGNS[name];
  if (!r) return;
  b.quad(F.p(a, bb + w / 2, h0), F.p(a, bb - w / 2, h0), F.p(a, bb - w / 2, h0 + h), F.p(a, bb + w / 2, h0 + h), F.d(-1, 0), [r[0], r[1], r[2], r[3]]);
}

/** 所有东西共用的一套网格：一种质感一个 */
class Kit {
  readonly paint = new MeshBuilder();
  readonly boards = new MeshBuilder();
  readonly roofing = new MeshBuilder();
  readonly glass = new MeshBuilder();
  readonly sign = new MeshBuilder();
  readonly neon = new MeshBuilder();
  readonly beacon = new MeshBuilder();
  readonly bulbs = new MeshBuilder();
  readonly wires = new MeshBuilder();
  readonly small = new MeshBuilder();
  /** 回填的土石（用山石的材质） */
  readonly fill = new MeshBuilder();
  constructor() {
    for (const b of [this.paint, this.boards, this.roofing, this.glass, this.small, this.wires]) b.tint = WHITE;
  }
}

export function buildScenery(host: SceneryHost): SceneryAnim {
  const S = host.track.samples;
  const n = S.length;
  const K = new Kit();
  const rnd = seeded(8121);
  const clearings: { x: number; z: number; r: number }[] = [];
  const clear = (F: Frame, a: number, bb: number, r: number): void => {
    const q = F.p(a, bb, 0);
    clearings.push({ x: q[0], z: q[2], r });
  };
  const idx = (s: number): number => ((Math.round(s / 2) % n) + n) % n;
  /** 这个点是不是在某一段路的护栏以内（再加 margin 米）。隧道顶上不算 */
  const onRoad = (x: number, z: number, margin: number): boolean => {
    const q = nearestRoad(x, z, 30);
    return !!q && q.span !== 'tunnel' && q.dist < MOUNTAIN.rail + margin;
  };

  /** 路上第 s 米处、离中心线 lateral 米（左为正）的坐标系，原点落在地面上（路基范围内是路面） */
  const frameAt = (s: number, lateral: number): Frame => {
    const i = idx(s);
    const p = S[i];
    const o = new THREE.Vector3(p.pos.x + p.left.x * lateral, 0, p.pos.z + p.left.z * lateral);
    o.y = Math.abs(lateral) <= MOUNTAIN.bench ? roadHeightAt(i, lateral) : terrainHeight(o.x, o.z);
    return new Frame(o, new THREE.Vector3(p.dir.x, 0, p.dir.z).normalize(), new THREE.Vector3(p.left.x, 0, p.left.z).normalize());
  };
  /** 路边的一块地：坐标系的「左」朝着路（房子的正面朝路） */
  const site = (s: number, lateral: number, turn = 0): Frame => {
    const F = frameAt(s, lateral);
    return F.at(0, 0, 0, (lateral > 0 ? Math.PI : 0) + turn);
  };
  /** 把一块地垫平：原点抬到这块地最高的地方，下面垫一圈基础 */
  const level = (F: Frame, a0: number, a1: number, b0: number, b1: number, tint: Tint = CONCRETE): void => {
    let top = -1e9;
    let low = 1e9;
    for (const [a, bb] of [[a0, b0], [a1, b0], [a0, b1], [a1, b1], [(a0 + a1) / 2, (b0 + b1) / 2]]) {
      const q = F.p(a, bb, 0);
      const y = terrainHeight(q[0], q[2]);
      top = Math.max(top, y);
      low = Math.min(low, y);
    }
    F.o.y = top + 0.12;
    clear(F, (a0 + a1) / 2, (b0 + b1) / 2, Math.hypot(a1 - a0, b1 - b0) / 2 + 2.5);
    K.paint.tint = tint;
    box(K.paint, F, a0, a1, b0, b1, low - top - 1.5, 0);
  };
  const lamp = (F: Frame, a: number, bb: number, h: number, color: [number, number, number], power: number, radius: number, glow = 0, pool: 0 | 1 = 0): void => {
    const q = F.p(a, bb, h);
    host.lamps.push({ x: q[0], y: q[1], z: q[2], color, power, radius, pool, ground: F.o.y });
    if (glow > 0) host.glowSpots.push({ x: q[0], y: q[1], z: q[2], color, size: glow, cone: 0, ground: F.o.y });
  };
  /** 一盏立杆的灯（停车场、码头、观景台）：杆高 h，灯头朝局部的 (da, db) 伸出去 */
  const post = (F: Frame, a: number, bb: number, h: number, da = 0, db = 0, color = LAMP_WARM, power = 2.2): void => {
    K.paint.tint = DARK;
    cyl(K.paint, F, a, bb, 0, h, 0.09, 0.07, 6);
    if (da || db) K.paint.beam(F.v(a, bb, h - 0.1), F.v(a + da, bb + db, h), 0.08, 0.08);
    box(K.bulbs, F, a + da - 0.28, a + da + 0.28, bb + db - 0.28, bb + db + 0.28, h - 0.12, h + 0.02, true);
    lamp(F, a + da, bb + db, h - 0.2, color, power, 20, 2.0, 1);
  };
  /** 停着的一辆车（示意：车身、座舱、四个轮子） */
  const car = (F: Frame, a: number, bb: number, turn: number, color: Tint, long = 4.4): void => {
    const C = F.at(a, bb, 0, turn);
    K.paint.tint = color;
    box(K.paint, C, -long / 2, long / 2, -0.9, 0.9, 0.32, 0.98, true);
    K.paint.tint = GLASS_DARK;
    box(K.paint, C, -long * 0.28, long * 0.2, -0.8, 0.8, 0.98, 1.46);
    K.paint.tint = DARK;
    for (const wa of [-long * 0.32, long * 0.32]) for (const wb of [-0.82, 0.82]) box(K.paint, C, wa - 0.33, wa + 0.33, wb - 0.14, wb + 0.14, 0, 0.66);
  };
  /** 旗杆和旗 */
  const flag = (F: Frame, a: number, bb: number, h: number, color: Tint): void => {
    K.paint.tint = GALV;
    cyl(K.paint, F, a, bb, 0, h, 0.06, 0.045, 6);
    K.paint.tint = color;
    K.paint.quad(F.p(a, bb, h - 1.3), F.p(a + 1.9, bb, h - 1.45), F.p(a + 1.9, bb, h - 0.35), F.p(a, bb, h - 0.1), F.d(0, 1));
  };

  interface HouseSpec {
    len: number;
    wid: number;
    /** 檐口高 */
    h: number;
    rise: number;
    wall: Tint;
    roof: Tint;
    /** 墙脚石砌的一圈有多高（0 = 没有） */
    base?: number;
    /** 窗里灯光的颜色 */
    light?: Tint;
    chimney?: boolean;
    plain?: boolean;
  }
  /** 一栋坡顶的房子：原点在平面中心、地面上；长边顺着「往前」，正面朝「左」 */
  const house = (F: Frame, sp: HouseSpec): void => {
    const L = sp.len / 2;
    const W = sp.wid / 2;
    const base = sp.base ?? 0;
    // 路是盘着山绕的，「离这一段路四十米」的地方可能正好是另一段路：盖之前看一眼四个角和门口
    for (const [a, bb] of [[-L - 1, -W - 1], [L + 1, -W - 1], [-L - 1, W + 2], [L + 1, W + 2], [0, 0]]) {
      const q = F.p(a, bb, 0);
      if (onRoad(q[0], q[2], 2)) {
        console.warn(`山路景物：一栋房子离路太近，没有盖（${q[0].toFixed(0)}, ${q[2].toFixed(0)}）`);
        return;
      }
    }
    level(F, -L - 0.4, L + 0.4, -W - 0.4, W + 0.4, STONE);
    if (base > 0) {
      K.paint.tint = STONE;
      box(K.paint, F, -L - 0.08, L + 0.08, -W - 0.08, W + 0.08, 0, base);
    }
    const walls = sp.plain ? K.paint : K.boards;
    walls.tint = sp.wall;
    box(walls, F, -L, L, -W, W, base, sp.h);
    gableEnd(walls, F, -L, -W, W, sp.h, sp.rise, -1);
    gableEnd(walls, F, L, -W, W, sp.h, sp.rise, 1);
    K.roofing.tint = sp.roof;
    gableRoof(K.roofing, F, -L, L, -W, W, sp.h, sp.rise, 0.7);
    // 窗：正面和背面各一排（楼高的话两排），山墙上各一扇
    K.glass.tint = sp.light ?? WARM;
    const rows = sp.h - base > 5 ? 2 : 1;
    const count = Math.max(1, Math.floor((sp.len - 2.4) / 3.1));
    for (let r = 0; r < rows; r++) {
      const y = base + 0.95 + r * 2.9;
      for (let k = 0; k < count; k++) {
        const a = ((k + 0.5) / count - 0.5) * (sp.len - 2.4);
        // 正面正中留给门
        if (r === 0 && Math.abs(a) < 1.2) continue;
        for (const s of [1, -1]) {
          K.glass.quad(F.p(a - 0.62, s * (W + 0.04), y), F.p(a + 0.62, s * (W + 0.04), y), F.p(a + 0.62, s * (W + 0.04), y + 1.6), F.p(a - 0.62, s * (W + 0.04), y + 1.6), F.d(0, s), [k * 1.25, r * 1.6, (k + 1) * 1.25, (r + 1) * 1.6]);
        }
      }
    }
    for (const s of [1, -1]) {
      const y = sp.h - 0.6;
      K.glass.quad(F.p(s * (L + 0.04), -0.62, y), F.p(s * (L + 0.04), 0.62, y), F.p(s * (L + 0.04), 0.62, y + 1.6), F.p(s * (L + 0.04), -0.62, y + 1.6), F.d(s, 0), [7.5, 0, 8.75, 1.6]);
    }
    // 门、门口的台阶和一盏灯
    K.paint.tint = WOOD_DARK;
    box(K.paint, F, -0.55, 0.55, W, W + 0.06, base, base + 2.1);
    K.paint.tint = STONE;
    box(K.paint, F, -1.1, 1.1, W, W + 1.3, 0, Math.max(0.18, base));
    lamp(F, 0, W + 0.5, base + 2.5, LAMP_WARM, 1.4, 11, 0.9);
    if (sp.chimney) {
      K.paint.tint = STONE;
      box(K.paint, F, L * 0.45 - 0.4, L * 0.45 + 0.4, -0.4, 0.4, sp.h, sp.h + sp.rise + 1.1);
    }
  };

  /* ================================================================== */
  /* 路边的设施                                                          */
  /* ================================================================== */

  /* ---- 电线杆和电线 ---- */
  for (const [s0, s1, side] of POWER_LINES) {
    let prev: THREE.Vector3[] | null = null;
    for (let s = s0; s <= s1; s += 40) {
      if (spanAt(idx(s))) {
        prev = null;
        continue;
      }
      const F = frameAt(s, POLE_OFFSET * side);
      clear(F, 0, 0, 2.2);
      K.small.tint = WOOD_DARK;
      cyl(K.small, F, 0, 0, -0.5, 9.7, 0.17, 0.11, 6);
      K.small.beam(F.v(0, -1.3, 9.0), F.v(0, 1.3, 9.0), 0.11, 0.13);
      K.small.tint = GALV;
      const tops: THREE.Vector3[] = [];
      for (const off of [-1.15, 0, 1.15]) {
        box(K.small, F, -0.06, 0.06, off - 0.06, off + 0.06, 9.06, 9.28);
        tops.push(F.v(0, off, 9.3));
      }
      // 杆上挂着一个变压器（隔几根一个）
      if (Math.round(s / 40) % 4 === 1) {
        K.small.tint = GALV;
        cyl(K.small, F, 0.32, 0, 7.2, 8.2, 0.26, 0.26, 7);
      }
      tops.push(F.v(0, 0, 7.4));
      if (prev) {
        // 电线：两根杆之间往下坠一点
        K.wires.tint = DARK;
        for (let w = 0; w < tops.length; w++) {
          const sag = w === 3 ? 0.7 : 1.0;
          let from = prev[w];
          for (let k = 1; k <= 6; k++) {
            const t = k / 6;
            const to = new THREE.Vector3().lerpVectors(prev[w], tops[w], t);
            to.y -= sag * 4 * t * (1 - t);
            K.wires.beam(from, to, 0.045, 0.045);
            from = to;
          }
        }
      }
      prev = tops;
    }
  }

  /* ---- 路牌 ---- */
  /** 路右边的一块牌子：size 是牌子的宽；菱形牌、限速牌的高宽比按图集里的来 */
  const roadSign = (s: number, name: string, w: number, h: number, side = -1, bottom = 1.9, off = 1.5): void => {
    if (spanAt(idx(s))) return;
    const F = frameAt(s, (MOUNTAIN.rail + off) * side);
    K.small.tint = GALV;
    box(K.small, F, 0.02, 0.09, -0.04, 0.04, 0, bottom + h * 0.6);
    // 背面的灰板
    box(K.small, F, 0.0, 0.02, -w / 2, w / 2, bottom, bottom + h);
    plate(K.sign, F, -0.012, 0, bottom, w, h, name);
  };
  for (const b of host.bends) {
    const s0 = S[b.i0].s;
    const hair = b.radius < 45;
    // 进弯前七十米：警告牌；急弯再加一块限速
    roadSign(s0 - 70, hair ? (b.side > 0 ? 'hairpinL' : 'hairpinR') : b.side > 0 ? 'curveL' : 'curveR', 1.5, 1.5);
    if (b.radius < 100) roadSign(s0 - 36, hair ? 'speed30' : 'speed50', 0.95, 1.27);
  }
  roadSign(52, 'speed80', 0.95, 1.27);
  roadSign(2244, 'speed80', 0.95, 1.27);
  roadSign(540, 'grade', 1.5, 1.5);
  roadSign(590, 'deer', 1.5, 1.5);
  roadSign(2590, 'rocks', 1.5, 1.5);
  roadSign(960, 'rocks', 1.5, 1.5);
  roadSign(3530, 'deer', 1.5, 1.5);
  roadSign(GALLERY[0] - 60, 'gallery', 3.0, 1.03, -1, 2.2, 2.2);
  roadSign(1700, 'overlook', 2.6, 1.3, -1, 2.2, 2.2);
  roadSign(3800, 'service', 2.6, 1.3, -1, 2.2, 2.2);
  for (const km of ['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5']) roadSign(Number(km) * 1000, `km${km}`, 0.5, 0.69, 1, 1.0, 1.0);

  /* ---- 头顶的绿色路牌：两根立柱架一根桁架，牌子朝着来车 ---- */
  const overhead = (s: number, names: [string, string]): void => {
    const F = frameAt(s, 0);
    const span = MOUNTAIN.rail + 1.2;
    K.paint.tint = GALV;
    for (const side of [1, -1]) box(K.paint, F, -0.22, 0.22, side * span - 0.22, side * span + 0.22, 0, 8.6);
    for (const h of [6.9, 8.4]) K.paint.beam(F.v(0, -span, h), F.v(0, span, h), 0.2, 0.2);
    for (let bb = -span + 1; bb < span; bb += 2) K.paint.beam(F.v(0, bb, 6.9), F.v(0, bb + 1, 8.4), 0.09, 0.09);
    names.forEach((name, k) => {
      const c = (k === 0 ? 1 : -1) * 4.4;
      plate(K.sign, F, -0.2, c, 6.3, 7.4, 2.31, name);
      K.paint.tint = GALV;
      box(K.paint, F, -0.19, -0.12, c - 3.7, c + 3.7, 6.3, 8.61);
    });
  };
  overhead(486, ['guidePass', 'guidePass']);
  overhead(3566, ['guideLake', 'guideLake']);

  /* ---- 发车区的彩旗：路两边各立一根杆，中间拉一串三角旗 ---- */
  for (const s0 of [3838, 3888, 58, 108]) {
    const F = frameAt(s0, 0);
    const span = MOUNTAIN.rail + 1.6;
    K.small.tint = GALV;
    for (const side of [1, -1]) cyl(K.small, F, 0, side * span, 0, 8.6, 0.08, 0.06, 6);
    const flags = 26;
    for (let k = 0; k < flags; k++) {
      const t0 = k / flags;
      const t1 = (k + 0.82) / flags;
      // 绳子中间往下坠一米多
      const at = (t: number, drop: number): V3 => F.p(0, (t * 2 - 1) * span, 8.5 - 1.5 * 4 * t * (1 - t) - drop);
      K.small.tint = k % 3 === 0 ? RED : k % 3 === 1 ? WHITE : [0.04, 0.04, 0.045];
      const tip = at((t0 + t1) / 2, 0.85);
      K.small.quad(at(t0, 0), at(t1, 0), tip, tip, F.d(-1, 0));
    }
  }

  /* ---- 山脊上的木围栏：两侧草甸的边 ---- */
  for (const side of [1, -1]) {
    for (let s = 2292; s < 2630; s += 3) {
      const F = frameAt(s, (MOUNTAIN.rail + 2.5) * side);
      const G = frameAt(s + 3, (MOUNTAIN.rail + 2.5) * side);
      K.small.tint = WOOD_GREY;
      box(K.small, F, -0.07, 0.07, -0.07, 0.07, -0.2, 1.25);
      for (const h of [0.55, 1.02]) K.small.beam(F.v(0, 0, h), G.v(0, 0, h), 0.06, 0.13);
    }
  }

  /* ---- 棚洞：山坡一侧是实墙，山谷一侧是一排柱子，顶上盖着板，阳光从柱子之间一格一格打进来 ---- */
  {
    const i0 = idx(GALLERY[0]);
    const i1 = idx(GALLERY[1]);
    const hill = 1;
    const wallAt = MOUNTAIN.bench + 0.7;
    const top = 6.4;
    for (let i = i0; i < i1; i++) {
      const p = S[i];
      const q = S[i + 1];
      const at = (smp: typeof p, lateral: number, h: number): V3 => [smp.pos.x + smp.left.x * lateral, smp.pos.y + h, smp.pos.z + smp.left.z * lateral];
      const up: V3 = [0, 1, 0];
      const dn: V3 = [0, -1, 0];
      const toHill: V3 = [p.left.x * hill, 0, p.left.z * hill];
      const toValley: V3 = [-toHill[0], 0, -toHill[2]];
      K.paint.tint = CONCRETE;
      // 顶板的下面和上面
      K.paint.quad(at(p, -hill * (wallAt + 0.5), top), at(q, -hill * (wallAt + 0.5), top), at(q, hill * wallAt, top + 0.5), at(p, hill * wallAt, top + 0.5), dn);
      K.paint.quad(at(p, -hill * (wallAt + 0.9), top + 0.75), at(q, -hill * (wallAt + 0.9), top + 0.75), at(q, hill * (wallAt + 0.7), top + 1.3), at(p, hill * (wallAt + 0.7), top + 1.3), up);
      // 山谷一侧的檐口
      K.paint.quad(at(p, -hill * (wallAt + 0.9), top - 0.35), at(q, -hill * (wallAt + 0.9), top - 0.35), at(q, -hill * (wallAt + 0.9), top + 0.75), at(p, -hill * (wallAt + 0.9), top + 0.75), toValley);
      K.paint.quad(at(p, -hill * (wallAt + 0.1), top - 0.35), at(q, -hill * (wallAt + 0.1), top - 0.35), at(q, -hill * (wallAt + 0.1), top), at(p, -hill * (wallAt + 0.1), top), toHill);
      K.paint.quad(at(p, -hill * (wallAt + 0.9), top - 0.35), at(q, -hill * (wallAt + 0.9), top - 0.35), at(q, -hill * (wallAt + 0.1), top - 0.35), at(p, -hill * (wallAt + 0.1), top - 0.35), dn);
      // 山坡一侧的实墙（里面那一面）
      K.paint.quad(at(p, hill * wallAt, -1), at(q, hill * wallAt, -1), at(q, hill * wallAt, top + 0.5), at(p, hill * wallAt, top + 0.5), toValley);
      // 墙后面回填的土石：从顶板的边一直铺到山坡上
      const far = (smp: typeof p): V3 => {
        const x = smp.pos.x + smp.left.x * hill * 34;
        const z = smp.pos.z + smp.left.z * hill * 34;
        return [x, terrainHeight(x, z) + 0.2, z];
      };
      K.fill.quad(at(p, hill * (wallAt + 0.7), top + 1.3), at(q, hill * (wallAt + 0.7), top + 1.3), far(q), far(p), up);
      // 柱子：六米一根，中间一道矮墙
      if ((i - i0) % 3 === 0) {
        const F = new Frame(new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), new THREE.Vector3(p.dir.x, 0, p.dir.z).normalize(), new THREE.Vector3(p.left.x, 0, p.left.z).normalize());
        box(K.paint, F, -0.4, 0.4, -hill * (wallAt + 0.85), -hill * (wallAt + 0.15), -2.5, top - 0.35);
      }
      K.paint.quad(at(p, -hill * (wallAt + 0.3), -2), at(q, -hill * (wallAt + 0.3), -2), at(q, -hill * (wallAt + 0.3), 0.95), at(p, -hill * (wallAt + 0.3), 0.95), toHill);
      K.paint.quad(at(p, -hill * (wallAt + 0.7), -2), at(q, -hill * (wallAt + 0.7), -2), at(q, -hill * (wallAt + 0.7), 0.95), at(p, -hill * (wallAt + 0.7), 0.95), toValley);
      K.paint.quad(at(p, -hill * (wallAt + 0.7), 0.95), at(q, -hill * (wallAt + 0.7), 0.95), at(q, -hill * (wallAt + 0.3), 0.95), at(p, -hill * (wallAt + 0.3), 0.95), up);
      // 头顶有遮挡：棚洞里不下雨、不积雪；灯白天也亮着
      if ((i - i0) % 2 === 0) host.covers.push({ x0: p.pos.x - 9, x1: p.pos.x + 9, z0: p.pos.z - 9, z1: p.pos.z + 9, visibility: 0.25 });
      if ((i - i0) % 7 === 3) {
        const c = at(p, hill * (wallAt - 0.3), top - 0.5);
        K.bulbs.box(c[0], c[1], c[2], 0.5, 0.14, 0.5, true);
        host.lamps.push({ x: c[0], y: c[1] - 0.1, z: c[2], color: LAMP_WARM, power: 1.6, radius: 16, pool: 1, ground: p.pos.y });
      }
    }
    // 两头的门脸：一道横梁，上面写着名字的牌子在进口那一头
    for (const [i, face] of [[i0, -1], [i1, 1]] as const) {
      const p = S[i];
      const F = new Frame(new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), new THREE.Vector3(p.dir.x, 0, p.dir.z).normalize(), new THREE.Vector3(p.left.x, 0, p.left.z).normalize());
      K.paint.tint = CONCRETE;
      box(K.paint, F, face * 0.1 - 0.5, face * 0.1 + 0.5, -(wallAt + 0.95), wallAt + 0.8, top - 0.35, top + 1.9);
      box(K.paint, F, face * 0.1 - 0.5, face * 0.1 + 0.5, hill * wallAt, hill * (wallAt + 0.8), -1.5, top + 1.9);
      if (face < 0) plate(K.sign, F, -0.43, hill * (wallAt + 0.4), 1.0, 1.4, 1.87, 'portal');
    }
  }

  /* ---- 隧道口：两边的红白导向板，拱上面的名牌 ---- */
  for (const sp of host.track.spans) {
    if (sp.kind !== 'tunnel') continue;
    const ia = Math.floor((sp.i0 - 1) / 2) * 2;
    const ib = Math.ceil((sp.i1 + 1) / 2) * 2;
    for (const [i, face] of [[ia, -1], [ib, 1]] as const) {
      const p = S[((i % n) + n) % n];
      // 牌面朝外：进口那头朝着来车，出口那头朝着后面
      const base = new Frame(new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), new THREE.Vector3(p.dir.x, 0, p.dir.z).normalize(), new THREE.Vector3(p.left.x, 0, p.left.z).normalize());
      const F = base.at(face * 0.42, 0, 0, face < 0 ? 0 : Math.PI);
      for (const side of [1, -1]) plate(K.sign, F, 0, side * 12.6, 0.6, 2.2, 2.93, 'portal');
      if (face < 0) plate(K.sign, F, 0, 0, 9.2, 11, 1.89, 'tunnelName');
      K.beacon.box(F.p(-0.1, 0, 13.4)[0], F.p(-0.1, 0, 13.4)[1], F.p(-0.1, 0, 13.4)[2], 0.5, 0.5, 0.5, true);
    }
  }

  /* ---- 高架桥：桥面两侧各一道橙红色的钢拱，吊杆吊着桥面，拱顶之间有横撑 ---- */
  for (const sp of host.track.spans) {
    if (sp.kind !== 'bridge') continue;
    const m = sp.i1 - sp.i0;
    const lateral = MOUNTAIN.bench + 1.7;
    const rib = (i: number, side: number): THREE.Vector3 => {
      const t = (i - sp.i0) / m;
      const p = S[((i % n) + n) % n];
      return new THREE.Vector3(p.pos.x + p.left.x * lateral * side, p.pos.y - 2.5 + 19.5 * 4 * t * (1 - t), p.pos.z + p.left.z * lateral * side);
    };
    K.paint.tint = ORANGE;
    for (const side of [1, -1]) {
      for (let i = sp.i0; i < sp.i1; i += 2) K.paint.beam(rib(i, side), rib(Math.min(sp.i1, i + 2), side), 1.0, 1.3);
      // 吊杆
      for (let i = sp.i0 + 4; i < sp.i1; i += 4) {
        const top = rib(i, side);
        const p = S[((i % n) + n) % n];
        if (top.y < p.pos.y + 2.2) continue;
        K.paint.beam(new THREE.Vector3(top.x, p.pos.y + 0.2, top.z), top, 0.16, 0.16);
      }
    }
    // 横撑：只在拱高出桥面七米以上的那一段（车从下面过）
    let last: [THREE.Vector3, THREE.Vector3] | null = null;
    for (let i = sp.i0 + 4; i < sp.i1; i += 4) {
      const a = rib(i, 1);
      const b = rib(i, -1);
      const p = S[((i % n) + n) % n];
      if (a.y < p.pos.y + 7.5) {
        last = null;
        continue;
      }
      K.paint.beam(a, b, 0.5, 0.6);
      if (last) {
        K.paint.beam(last[0], b, 0.22, 0.22);
        K.paint.beam(last[1], a, 0.22, 0.22);
      }
      last = [a, b];
    }
    const mid = rib(Math.round((sp.i0 + sp.i1) / 2), 1);
    const mid2 = rib(Math.round((sp.i0 + sp.i1) / 2), -1);
    K.beacon.box(mid.x, mid.y + 1.0, mid.z, 0.5, 0.5, 0.5, true);
    K.beacon.box(mid2.x, mid2.y + 1.0, mid2.z, 0.5, 0.5, 0.5, true);
  }

  /* ================================================================== */
  /* 地标                                                                */
  /* ================================================================== */

  /* ---- 起点旁边的看台：五级台阶，顶上一个棚，两头插着旗 ---- */
  {
    const F = site(6, -(MOUNTAIN.rail + 4.2));
    level(F, -21, 21, -7.5, 0.5);
    const B = K.boards;
    for (let k = 0; k < 6; k++) {
      B.tint = k % 2 === 0 ? [0.2, 0.2, 0.21] : [0.26, 0.26, 0.27];
      box(B, F, -20, 20, -1 - k * 1.05, -k * 1.05, 0, 0.6 + k * 0.5);
      // 座椅：一条条彩色的
      K.paint.tint = k % 2 === 0 ? RED : WHITE;
      box(K.paint, F, -19.6, 19.6, -0.75 - k * 1.05, -0.3 - k * 1.05, 0.6 + k * 0.5, 0.78 + k * 0.5);
    }
    K.paint.tint = DARK;
    for (const a of [-19.5, -6.5, 6.5, 19.5]) {
      box(K.paint, F, a - 0.15, a + 0.15, -7.1, -6.8, 0, 8.4);
      K.paint.beam(F.v(a, -6.95, 8.2), F.v(a, 0.6, 7.2), 0.18, 0.24);
    }
    K.roofing.tint = ROOF_GREY;
    K.roofing.quad(F.p(-20.5, -7.4, 8.5), F.p(20.5, -7.4, 8.5), F.p(20.5, 1.0, 7.4), F.p(-20.5, 1.0, 7.4), [0, 1, 0], [0, 0, 41, 8.4]);
    K.roofing.quad(F.p(-20.5, -7.4, 8.35), F.p(20.5, -7.4, 8.35), F.p(20.5, 1.0, 7.25), F.p(-20.5, 1.0, 7.25), [0, -1, 0], [0, 0, 41, 8.4]);
    // 棚檐上的横幅，朝着赛道
    plate(K.neon, F.at(0, 1.02, 0, -Math.PI / 2), 0, 0, 6.5, 18, 2.25, 'grandstand');
    for (const a of [-12, 0, 12]) lamp(F, a, -1, 7.0, LAMP_WHITE, 2.4, 22, 0, 1);
    flag(F, -23, -1, 9.5, RED);
    flag(F, 23, -1, 9.5, [0.5, 0.5, 0.5]);
    flag(F, -23, -4, 9.5, DARK);
    flag(F, 23, -4, 9.5, RED);
  }

  /* ---- 湖边的加油站：一个大顶棚、三排油机、便利店、高高的价目牌 ---- */
  {
    const F = site(168, -(MOUNTAIN.rail + 27));
    level(F, -26, 26, -15, 15, ASPHALT);
    // 顶棚
    K.paint.tint = WHITE;
    box(K.paint, F, -11, 11, 2, 12.5, 5.3, 5.95, true);
    for (const a of [-8, 8]) for (const bb of [4.2, 10.3]) box(K.paint, F, a - 0.28, a + 0.28, bb - 0.28, bb + 0.28, 0, 5.3);
    K.paint.tint = RED;
    box(K.paint, F, -11.06, 11.06, 1.94, 12.56, 5.42, 5.8);
    plate(K.neon, F.at(0, 12.58, 0, -Math.PI / 2), 0, 0, 5.36, 8, 1.0, 'fuelBand');
    plate(K.neon, F.at(-11.08, 7.2, 0, 0), 0, 0, 5.36, 8, 1.0, 'fuelBand');
    // 顶棚下面的灯
    for (const a of [-7, 0, 7]) {
      for (const bb of [4.6, 9.8]) {
        box(K.bulbs, F, a - 0.5, a + 0.5, bb - 0.3, bb + 0.3, 5.22, 5.3, true);
        lamp(F, a, bb, 5.1, LAMP_WHITE, 2.6, 15, 0, 1);
      }
    }
    host.glowSpots.push({ x: F.p(0, 7.2, 4.6)[0], y: F.p(0, 7.2, 4.6)[1], z: F.p(0, 7.2, 4.6)[2], color: LAMP_WHITE, size: 4.5, cone: 0, ground: F.o.y });
    // 油机和岛台
    for (const a of [-7, 0, 7]) {
      K.paint.tint = CONCRETE;
      box(K.paint, F, a - 0.7, a + 0.7, 3.6, 10.9, 0, 0.2);
      for (const bb of [5.4, 9.1]) {
        K.paint.tint = RED;
        box(K.paint, F, a - 0.32, a + 0.32, bb - 0.55, bb + 0.55, 0.2, 1.75);
        K.paint.tint = WHITE;
        box(K.paint, F, a - 0.34, a + 0.34, bb - 0.57, bb + 0.57, 1.75, 2.05);
      }
    }
    // 便利店：平顶，正面一排落地窗
    K.paint.tint = WHITE;
    box(K.paint, F, -10, 10, -13, -4.5, 0, 4.1);
    K.paint.tint = RED;
    box(K.paint, F, -10.3, 10.3, -13.3, -4.2, 4.1, 4.5);
    K.glass.tint = COOL;
    K.glass.quad(F.p(-9, -4.45, 0.5), F.p(9, -4.45, 0.5), F.p(9, -4.45, 3.1), F.p(-9, -4.45, 3.1), F.d(0, 1), [0, 0, 18, 2.6]);
    plate(K.neon, F.at(0, -4.18, 0, -Math.PI / 2), 0, 0, 3.25, 6.4, 1.6, 'mart');
    lamp(F, 0, -2.5, 3.4, LAMP_WHITE, 2.0, 14);
    // 价目牌
    K.paint.tint = DARK;
    box(K.paint, F, -23.2, -22.8, 12.3, 12.7, 0, 9.4);
    plate(K.neon, F.at(-23, 12.5, 0, 0), -0.22, 0, 5.2, 2.6, 4.55, 'fuelPrice');
    plate(K.neon, F.at(-23, 12.5, 0, Math.PI), -0.22, 0, 5.2, 2.6, 4.55, 'fuelPrice');
    // 加油的、停着的车
    car(F, -7, 7.3, 0, CAR_COLORS[1]);
    car(F, 7, 7.3, Math.PI, CAR_COLORS[4], 4.9);
    car(F, -14, -2.4, Math.PI / 2, CAR_COLORS[2]);
    car(F, 13.5, -2.4, Math.PI / 2, CAR_COLORS[0]);
    post(F, 22, 11, 7.5, -1.6, 0, LAMP_WHITE, 2.4);
  }

  /* ---- 路边餐馆：一长排大窗，屋顶上立着霓虹招牌，门口是停车场 ---- */
  {
    const F = site(262, -(MOUNTAIN.rail + 25));
    level(F, -19, 19, -11, 12, ASPHALT);
    K.boards.tint = CREAM;
    box(K.boards, F, -12, 12, -10, -2, 0, 3.9);
    K.paint.tint = ROOF_RED;
    box(K.paint, F, -12.5, 12.5, -10.5, -1.2, 3.9, 4.45);
    K.paint.tint = [0.42, 0.42, 0.44];
    box(K.paint, F, -12.05, 12.05, -2.0, -1.94, 0.0, 0.9);
    K.glass.tint = WARM;
    K.glass.quad(F.p(-11.2, -1.95, 1.0), F.p(11.2, -1.95, 1.0), F.p(11.2, -1.95, 3.1), F.p(-11.2, -1.95, 3.1), F.d(0, 1), [0, 0, 22.4, 2.1]);
    for (const s of [1, -1]) K.glass.quad(F.p(s * 12.04, -9, 1.0), F.p(s * 12.04, -3, 1.0), F.p(s * 12.04, -3, 3.1), F.p(s * 12.04, -9, 3.1), F.d(s, 0), [30, 0, 36, 2.1]);
    // 屋顶上的招牌：两根立柱撑着
    K.paint.tint = DARK;
    for (const a of [-5.5, 5.5]) box(K.paint, F, a - 0.1, a + 0.1, -5.6, -5.4, 4.45, 5.2);
    box(K.paint, F, -6.6, 6.6, -5.62, -5.5, 5.0, 8.85);
    plate(K.neon, F.at(0, -5.48, 0, -Math.PI / 2), 0, 0, 5.05, 13, 3.79, 'diner');
    lamp(F, 0, -4.5, 6.8, [1.0, 0.35, 0.25], 2.2, 20, 5.0);
    lamp(F, -6, -0.6, 3.2, LAMP_WARM, 2.0, 13);
    lamp(F, 6, -0.6, 3.2, LAMP_WARM, 2.0, 13);
    const lot = [-13, -9.4, -5.8, 2.4, 6, 13.2];
    lot.forEach((a, k) => {
      if (k === 3) return;
      car(F, a, 6.5, Math.PI / 2 + (rnd() - 0.5) * 0.08, CAR_COLORS[(k * 3 + 2) % CAR_COLORS.length], k === 5 ? 5.1 : 4.4);
    });
    post(F, -17, 10, 7.5, 1.6, 0);
    post(F, 17, 10, 7.5, -1.6, 0);
  }

  /* ---- 湖边旅馆：两层的大木屋，石砌的墙脚 ---- */
  {
    const F = site(66, -(MOUNTAIN.rail + 38));
    house(F, { len: 28, wid: 12, h: 6.6, rise: 4.4, wall: WOOD, roof: ROOF_GREY, base: 1.2, chimney: true });
    // 二楼的阳台
    K.boards.tint = WOOD_DARK;
    box(K.boards, F, -13, 13, 6, 7.6, 3.4, 3.6);
    for (let a = -13; a <= 13; a += 2.6) box(K.boards, F, a - 0.07, a + 0.07, 7.5, 7.64, 0, 4.5);
    K.boards.beam(F.v(-13, 7.57, 4.5), F.v(13, 7.57, 4.5), 0.1, 0.12);
    plate(K.neon, F.at(0, 7.7, 0, -Math.PI / 2), 0, 0, 4.7, 9, 2.06, 'lodge');
    for (const a of [-9, 9]) lamp(F, a, 7, 3.2, LAMP_WARM, 1.6, 12, 0.9);
    car(F, -9, 12, 0.1, CAR_COLORS[3], 4.8);
    car(F, -3, 12.3, -0.05, CAR_COLORS[5]);
    car(F, 8, 12, 0.03, CAR_COLORS[6]);
  }

  /* ---- 小木屋：湖边三栋，山腰上四栋 ---- */
  const cabins: [number, number, number, Tint, Tint][] = [
    [318, -(MOUNTAIN.rail + 30), 0.2, WOOD, ROOF_GREEN],
    [338, -(MOUNTAIN.rail + 52), -0.3, WOOD_DARK, ROOF_RED],
    [372, -(MOUNTAIN.rail + 36), 0.5, WOOD, ROOF_GREY],
    // 山腰这四栋夹在之字路的两段之间：两段路的护栏只隔三十多米，房子要摆在正中间那一条里
    [1474, -(MOUNTAIN.rail + 17), 0.15, WOOD_DARK, ROOF_GREEN],
    [1548, -(MOUNTAIN.rail + 19), -0.2, WOOD, ROOF_RED],
    [1626, -(MOUNTAIN.rail + 16), 0.1, WOOD, ROOF_GREY],
    [1694, -(MOUNTAIN.rail + 19), -0.1, WOOD_DARK, ROOF_GREEN],
    [3608, -(MOUNTAIN.rail + 34), 0.3, WOOD, ROOF_RED],
  ];
  for (const [s, lateral, turn, wall, roof] of cabins) {
    house(site(s, lateral, turn), { len: 9 + rnd() * 3, wid: 6.5 + rnd() * 1.5, h: 3.3, rise: 3.2 + rnd() * 0.8, wall, roof, base: 0.5, chimney: rnd() < 0.7 });
  }

  /* ---- 码头：一条伸进湖里的木栈桥，尽头横着一段，拴着几条船；岸上一个船屋 ---- */
  {
    const base = frameAt(214, MOUNTAIN.rail + 20);
    // 沿着「往左」（朝湖）找水边
    let shore = 20;
    for (let d = 20; d < 160; d += 2) {
      const q = base.p(0, d - 20, 0);
      if (terrainHeight(q[0], q[2]) < MOUNTAIN.lake + 0.25) {
        shore = d;
        break;
      }
    }
    // 坐标系：原点在水边，「往前」朝着湖里
    const P = base.at(0, shore - 20, 0, Math.PI / 2);
    P.o.y = MOUNTAIN.lake;
    const deck = 1.0;
    K.boards.tint = WOOD_GREY;
    box(K.boards, P, -9, 38, -1.7, 1.7, deck - 0.18, deck, true);
    box(K.boards, P, 38, 41.4, -11, 11, deck - 0.18, deck, true);
    K.paint.tint = WOOD_DARK;
    for (let k = 0; k <= 11; k++) for (const bb of [-1.55, 1.55]) cyl(K.paint, P, -8 + k * 4.2, bb, -2.5, deck + (k % 2 === 0 ? 0.9 : 0), 0.14, 0.14, 6);
    clear(P, -17, 9, 12);
    clear(P, -4, 0, 7);
    for (const bb of [-10.6, -5.3, 5.3, 10.6]) for (const a of [38.3, 41.1]) cyl(K.paint, P, a, bb, -2.5, deck + 0.7, 0.14, 0.14, 6);
    // 船
    const boat = (a: number, bb: number, turn: number, len: number, hull: Tint, sail: boolean): void => {
      const C = P.at(a, bb, 0.0, turn);
      const w = len * 0.17;
      const q = (x: number, y: number, h: number): V3 => C.p(x, y, h);
      K.paint.tint = hull;
      const bow = q(len / 2, 0, 0.95);
      // 两舷、船尾、甲板
      for (const s of [1, -1]) {
        K.paint.quad(q(-len / 2, s * w * 0.8, -0.3), q(len * 0.2, s * w, -0.3), q(len * 0.2, s * w, 0.85), q(-len / 2, s * w * 0.8, 0.8), C.d(0, s));
        K.paint.quad(q(len * 0.2, s * w, -0.3), bow, bow, q(len * 0.2, s * w, 0.85), C.d(0.4, s));
      }
      K.paint.quad(q(-len / 2, -w * 0.8, -0.3), q(-len / 2, w * 0.8, -0.3), q(-len / 2, w * 0.8, 0.8), q(-len / 2, -w * 0.8, 0.8), C.d(-1, 0));
      K.paint.tint = WOOD_LIGHT;
      K.paint.quad(q(-len / 2, -w * 0.8, 0.8), q(len * 0.2, -w, 0.85), q(len * 0.2, w, 0.85), q(-len / 2, w * 0.8, 0.8), [0, 1, 0]);
      K.paint.quad(q(len * 0.2, -w, 0.85), bow, bow, q(len * 0.2, w, 0.85), [0, 1, 0]);
      K.paint.tint = WHITE;
      box(K.paint, C, -len * 0.22, len * 0.12, -w * 0.6, w * 0.6, 0.85, sail ? 1.35 : 1.9);
      if (sail) {
        K.paint.tint = GALV;
        cyl(K.paint, C, len * 0.08, 0, 0.85, len * 1.15, 0.07, 0.05, 6);
        K.paint.beam(C.v(len * 0.06, 0, 1.9), C.v(-len * 0.4, 0, 1.95), 0.07, 0.07);
        // 收起来的帆
        K.paint.tint = [0.42, 0.4, 0.34];
        K.paint.beam(C.v(len * 0.04, 0, 2.05), C.v(-len * 0.38, 0, 2.1), 0.22, 0.26);
      } else {
        K.paint.tint = GLASS_DARK;
        box(K.paint, C, -len * 0.05, len * 0.13, -w * 0.55, w * 0.55, 1.35, 1.82);
      }
    };
    boat(42.5, -8, Math.PI / 2 + 0.05, 9.5, WHITE, true);
    boat(42.6, 7.5, -Math.PI / 2, 8.2, [0.05, 0.1, 0.26], true);
    boat(14, 4.4, 0.04, 6.4, WHITE, false);
    boat(25, -4.5, Math.PI, 7.0, [0.36, 0.05, 0.04], false);
    boat(30, 4.6, 0, 10.5, WHITE, true);
    // 栈桥上的灯
    for (const a of [2, 20, 38]) post(P, a, 1.5, 4.6, 0, -0.6, LAMP_WARM, 1.8);
    // 船屋：立在水边的桩子上
    const H = P.at(-17, 9, 0, 0);
    H.o.y = Math.max(terrainHeight(H.o.x, H.o.z), MOUNTAIN.lake) + 1.2;
    K.boards.tint = [0.34, 0.07, 0.05];
    box(K.boards, H, -6, 6, -4, 4, 0, 3.4, true);
    gableEnd(K.boards, H, -6, -4, 4, 3.4, 2.6, -1);
    gableEnd(K.boards, H, 6, -4, 4, 3.4, 2.6, 1);
    K.roofing.tint = ROOF_GREY;
    gableRoof(K.roofing, H, -6, 6, -4, 4, 3.4, 2.6, 0.6);
    K.paint.tint = WOOD_DARK;
    for (const a of [-5.5, 0, 5.5]) for (const bb of [-3.6, 3.6]) cyl(K.paint, H, a, bb, -5, 0, 0.16, 0.16, 6);
    K.glass.tint = WARM;
    for (const a of [-3.2, 3.2]) K.glass.quad(H.p(a - 0.62, -4.04, 1.0), H.p(a + 0.62, -4.04, 1.0), H.p(a + 0.62, -4.04, 2.6), H.p(a - 0.62, -4.04, 2.6), H.d(0, -1), [0, 0, 1.25, 1.6]);
    lamp(H, 6.4, 0, 3.0, LAMP_WARM, 1.6, 12, 1.0);
  }

  /* ---- 观景台：第二个发卡弯的外侧。一圈石栏杆、望远镜、旗、一个小卖部，缆车的下站也在这儿 ---- */
  const apex = host.bends.filter((b) => b.radius < 45).sort((a, b) => S[a.i0].s - S[b.i0].s)[1];
  let station: Frame | null = null;
  if (apex) {
    const mid = S[Math.round((apex.i0 + ((apex.i1 - apex.i0 + n) % n) / 2)) % n].s;
    const F = site(mid, -apex.side * (MOUNTAIN.rail + 13));
    level(F, -19, 19, -10.5, 10.5, [0.2, 0.19, 0.17]);
    // 外沿的石栏杆
    K.paint.tint = STONE;
    box(K.paint, F, -19, 19, -10.5, -9.9, 0, 1.05);
    for (const s of [1, -1]) box(K.paint, F, s * 19 - 0.3, s * 19 + 0.3, -10.5, 2, 0, 1.05);
    // 望远镜
    for (const a of [-8, 8]) {
      K.paint.tint = GALV;
      cyl(K.paint, F, a, -9, 0, 1.25, 0.09, 0.07, 6);
      K.paint.tint = BLUE;
      box(K.paint, F, a - 0.16, a + 0.16, -9.4, -8.6, 1.25, 1.6, true);
    }
    // 长椅
    K.boards.tint = WOOD_LIGHT;
    for (const a of [-13, -3, 3, 13]) {
      box(K.boards, F, a - 1.1, a + 1.1, -7.6, -7.0, 0.42, 0.5, true);
      box(K.boards, F, a - 1.1, a + 1.1, -7.0, -6.92, 0.5, 0.95, true);
    }
    flag(F, -17.5, -8.6, 8.5, RED);
    flag(F, -15.5, -8.6, 8.5, [0.5, 0.5, 0.5]);
    flag(F, 15.5, -8.6, 8.5, BLUE);
    // 小卖部
    const shop = F.at(11, 3.5, 0, 0);
    K.boards.tint = WOOD;
    box(K.boards, shop, -3.4, 3.4, -2.4, 2.4, 0, 2.9);
    gableEnd(K.boards, shop, -3.4, -2.4, 2.4, 2.9, 1.7, -1);
    gableEnd(K.boards, shop, 3.4, -2.4, 2.4, 2.9, 1.7, 1);
    K.roofing.tint = ROOF_GREEN;
    gableRoof(K.roofing, shop, -3.4, 3.4, -2.4, 2.4, 2.9, 1.7, 0.9);
    K.glass.tint = WARM;
    K.glass.quad(shop.p(-2.6, -2.44, 1.0), shop.p(2.6, -2.44, 1.0), shop.p(2.6, -2.44, 2.4), shop.p(-2.6, -2.44, 2.4), shop.d(0, -1), [0, 0, 5.2, 1.4]);
    lamp(shop, 0, -3.2, 2.6, LAMP_WARM, 1.8, 12, 1.2);
    car(F, -12, 5.5, 0.05, CAR_COLORS[2]);
    car(F, -6, 5.6, 0, CAR_COLORS[0]);
    car(F, 0.5, 5.4, Math.PI, CAR_COLORS[6], 4.8);
    post(F, -18, 8, 7, 1.4, -1.0);
    post(F, 18, -2, 7, -1.4, -0.6);
    station = F.at(-9, -22, 0, 0);
  }

  /* ---- 伐木场：西边湖滨的平地上。几垛原木、一个敞着的锯木棚、一台抓木机 ---- */
  {
    const F = site(3690, MOUNTAIN.rail + 30);
    level(F, -34, 34, -17, 17, [0.12, 0.1, 0.075]);
    // 原木垛
    const pile = (a: number, bb: number, turn: number, len: number, rows: number): void => {
      const C = F.at(a, bb, 0, turn);
      const r = 0.36;
      for (let row = 0; row < rows; row++) {
        for (let k = 0; k < rows - row + 3; k++) {
          const off = (k - (rows - row + 2) / 2) * r * 2.02;
          const jig = (rnd() - 0.5) * 0.7;
          log(K.boards, C, -len / 2 + jig, len / 2 + jig, off, r + row * r * 1.76, r * (0.9 + rnd() * 0.16), [0.085, 0.06, 0.04], WOOD_LIGHT);
        }
      }
      K.paint.tint = DARK;
      for (const s of [1, -1]) for (const e of [-len * 0.3, len * 0.3]) box(K.paint, C, e - 0.07, e + 0.07, s * (rows + 3) * r * 1.02, s * (rows + 3) * r * 1.02 + s * 0.12, 0, rows * r * 1.8 + 0.5);
    };
    pile(-22, 6, 0.06, 9, 4);
    pile(-22, -4.5, -0.04, 9, 5);
    pile(-9, 7, 0.02, 7, 3);
    pile(24, 8, Math.PI / 2 + 0.1, 8, 4);
    // 锯木棚：六根柱子撑一个绿铁皮顶，四面敞着
    const M = F.at(6, -7, 0, 0);
    K.paint.tint = WOOD_DARK;
    for (const a of [-11, 0, 11]) for (const bb of [-5.5, 5.5]) box(K.paint, M, a - 0.2, a + 0.2, bb - 0.2, bb + 0.2, 0, 5.6);
    K.roofing.tint = ROOF_GREEN;
    gableRoof(K.roofing, M, -11.5, 11.5, -5.8, 5.8, 5.6, 2.4, 0.8);
    K.boards.tint = WOOD_GREY;
    gableEnd(K.boards, M, -11.5, -5.8, 5.8, 5.6, 2.4, -1);
    gableEnd(K.boards, M, 11.5, -5.8, 5.8, 5.6, 2.4, 1);
    box(K.boards, M, -11.3, 11.3, -5.75, -5.6, 0, 5.6);
    // 棚里：锯台、码好的板材
    K.paint.tint = [0.1, 0.16, 0.12];
    box(K.paint, M, -4, 2.5, -1.3, 1.3, 0, 1.1);
    K.boards.tint = WOOD_LIGHT;
    box(K.boards, M, 4.5, 9.5, -3.6, -1.2, 0.1, 1.5);
    box(K.boards, M, 4.5, 9.5, 0.8, 3.2, 0.1, 1.0);
    box(K.boards, M, -10, -6, 1.5, 4, 0.1, 1.9);
    lamp(M, 0, 0, 5.2, LAMP_WHITE, 2.4, 20, 0, 1);
    box(K.bulbs, M, -0.6, 0.6, -0.2, 0.2, 5.3, 5.42, true);
    // 抓木机：黄色的履带车，一条折起来的臂，前头一只爪
    const X = F.at(-6, -2, 0, 0.5);
    K.paint.tint = DARK;
    for (const bb of [-1.3, 1.3]) box(K.paint, X, -2.4, 2.4, bb - 0.35, bb + 0.35, 0, 0.9);
    K.paint.tint = YELLOW;
    box(K.paint, X, -1.9, 1.7, -1.4, 1.4, 0.9, 2.3);
    K.paint.tint = GLASS_DARK;
    box(K.paint, X, 0.2, 1.6, 0.2, 1.35, 2.3, 3.9);
    K.paint.tint = YELLOW;
    K.paint.beam(X.v(0.4, -0.6, 2.3), X.v(3.4, -0.6, 7.6), 0.5, 0.6);
    K.paint.beam(X.v(3.4, -0.6, 7.6), X.v(7.6, -0.6, 4.4), 0.4, 0.5);
    K.paint.tint = DARK;
    for (const s of [-0.5, 0.5]) K.paint.beam(X.v(7.6, -0.6, 4.4), X.v(7.6 + s, -0.6, 3.0), 0.16, 0.5);
    log(K.boards, X.at(7.6, -0.6, 0, Math.PI / 2), -4, 4, 0, 2.7, 0.34, [0.085, 0.06, 0.04], WOOD_LIGHT);
    // 朝着路的招牌
    K.paint.tint = WOOD_DARK;
    for (const a of [-3.6, 3.6]) box(K.paint, F, a - 0.12, a + 0.12, 15.5, 15.74, 0, 5.2);
    plate(K.sign, F.at(0, 15.8, 0, -Math.PI / 2), 0, 0, 2.6, 8.4, 2.8, 'lumber');
    post(F, -30, 12, 8, 1.6, -1.2, LAMP_WHITE, 2.6);
    post(F, 30, 12, 8, -1.6, -1.2, LAMP_WHITE, 2.6);
    car(F, 16, -8, 0.4, CAR_COLORS[4], 5.2);
    car(F, 20.5, -9, 0.3, CAR_COLORS[3], 4.8);
  }

  /* ---- 山顶：天文台的白色圆顶、红白相间的通信塔 ---- */
  let summit: Frame | null = null;
  {
    const F = site(2516, MOUNTAIN.rail + 56);
    level(F, -14, 14, -11, 11, STONE);
    // 圆柱形的基座和半球顶
    K.paint.tint = WHITE;
    cyl(K.paint, F, 0, 0, 0, 7, 8.4, 8.4, 20, false);
    const R = 8.6;
    const rings = 7;
    for (let k = 0; k < rings; k++) {
      const t0 = (k / rings) * (Math.PI / 2);
      const t1 = ((k + 1) / rings) * (Math.PI / 2);
      cyl(K.paint, F, 0, 0, 7 + Math.sin(t0) * R, 7 + Math.sin(t1) * R, Math.cos(t0) * R, Math.max(0.01, Math.cos(t1) * R), 20, false);
    }
    // 圆顶上那道开口（深色的一条）
    K.paint.tint = DARK;
    box(K.paint, F, -1.2, 1.2, 0.5, 8.9, 7.3, 15.5);
    // 旁边的附属楼
    K.paint.tint = [0.42, 0.42, 0.4];
    box(K.paint, F, -13, -7, -6, 6, 0, 4.2);
    K.glass.tint = COOL;
    K.glass.quad(F.p(-12.4, 6.05, 1.2), F.p(-7.6, 6.05, 1.2), F.p(-7.6, 6.05, 2.8), F.p(-12.4, 6.05, 2.8), F.d(0, 1), [0, 0, 4.8, 1.6]);
    lamp(F, -10, 7.5, 3.4, LAMP_WHITE, 1.8, 14, 1.2);
    K.beacon.box(F.p(0, 0, 16.2)[0], F.p(0, 0, 16.2)[1], F.p(0, 0, 16.2)[2], 0.6, 0.6, 0.6, true);
    summit = F;

    // 通信塔：四条腿往上收，一截红一截白
    const T = site(2408, MOUNTAIN.rail + 52);
    level(T, -5, 5, -5, 5, CONCRETE);
    const H = 52;
    const seg = 8;
    const corner = (k: number, c: number): THREE.Vector3 => {
      const half = 4.2 * (1 - k / seg) + 0.5;
      const sx = c === 0 || c === 3 ? -1 : 1;
      const sy = c < 2 ? -1 : 1;
      return T.v(sx * half, sy * half, (k / seg) * H);
    };
    for (let k = 0; k < seg; k++) {
      K.small.tint = k % 2 === 0 ? RED : WHITE;
      for (let c = 0; c < 4; c++) {
        K.small.beam(corner(k, c), corner(k + 1, c), 0.22, 0.22);
        K.small.beam(corner(k + 1, c), corner(k + 1, (c + 1) % 4), 0.14, 0.14);
        K.small.beam(corner(k, c), corner(k + 1, (c + 1) % 4), 0.1, 0.1);
      }
    }
    K.small.tint = WHITE;
    cyl(K.small, T, 0, 0, H, H + 7, 0.12, 0.05, 6);
    for (const [h, r] of [[H * 0.7, 1.6], [H * 0.82, 1.3]] as const) cyl(K.small, T, 1.6, 0, h, h + 0.5, r, r, 10);
    for (const h of [H + 6.8, H * 0.5]) {
      const q = T.p(0, 0, h);
      K.beacon.box(q[0], q[1], q[2], 0.6, 0.6, 0.6, true);
    }
    K.paint.tint = [0.3, 0.31, 0.3];
    box(K.paint, T, 5.5, 9.5, -2, 2, 0, 2.8);
  }

  /* ---- 山沟里的水：从沟头一路淌下来，汇进桥下的一汪潭 ---- */
  {
    const water = new MeshBuilder();
    const wide = 3.6;
    let dist = 0;
    let prevL: V3 | null = null;
    let prevR: V3 | null = null;
    let last = 0;
    const wig = (z: number) => Math.sin(z * 0.045) * 5 + Math.sin(z * 0.13) * 1.6;
    for (let z = CASCADE.z0; z >= CASCADE.z1; z -= 3) {
      const x = CASCADE.x + wig(z);
      const y = terrainHeight(x, z) + 0.45;
      if (y < CASCADE.pond + 0.3) {
        last = z;
        break;
      }
      const dx = wig(z - 1.5) - wig(z + 1.5);
      const len = Math.hypot(dx, 3);
      // 水流方向朝南（-z）：它的左边是 +x
      const lx = 3 / len;
      const lz = dx / len;
      const L: V3 = [x + lx * wide, terrainHeight(x + lx * wide, z + lz * wide) + 0.4, z + lz * wide];
      const R: V3 = [x - lx * wide, terrainHeight(x - lx * wide, z - lz * wide) + 0.4, z - lz * wide];
      L[1] = Math.min(L[1], y + 0.5);
      R[1] = Math.min(R[1], y + 0.5);
      if (prevL && prevR) water.quad(prevL, prevR, R, L, [0, 1, 0], [1, dist - 3, 0, dist]);
      prevL = L;
      prevR = R;
      dist += 3;
      last = z;
    }
    // 桥下的那汪潭：沟底比它低的地方都是水
    const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 40), host.water);
    pond.rotation.x = -Math.PI / 2;
    pond.scale.set(46, 110, 1);
    pond.position.set(CASCADE.x, CASCADE.pond, -40);
    pond.receiveShadow = true;
    host.group.add(pond);
    const mesh = new THREE.Mesh(water.build(), host.looks.cascade);
    mesh.receiveShadow = true;
    mesh.renderOrder = 3;
    host.group.add(mesh);
    // 水雾：水冲进潭里的地方
    const fog = new MeshBuilder();
    const fx = CASCADE.x + wig(last);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI;
      const r = 13 + (k % 2) * 4;
      const cx = fx + (rnd() - 0.5) * 6;
      const cz = last - 4 + (rnd() - 0.5) * 8;
      fog.quad([cx - Math.cos(a) * r, CASCADE.pond - 1, cz - Math.sin(a) * r], [cx + Math.cos(a) * r, CASCADE.pond - 1, cz + Math.sin(a) * r], [cx + Math.cos(a) * r, CASCADE.pond + r * 1.3, cz + Math.sin(a) * r], [cx - Math.cos(a) * r, CASCADE.pond + r * 1.3, cz - Math.sin(a) * r], [0, 0, 1]);
    }
    const haze = new THREE.Mesh(fog.build(), host.looks.mist);
    haze.renderOrder = 4;
    host.group.add(haze);
  }

  /* ================================================================== */
  /* 会动的：风车、缆车                                                   */
  /* ================================================================== */
  const spinners: { mesh: THREE.Mesh; face: THREE.Quaternion; angle: number; speed: number }[] = [];
  {
    // 风车：台地北边更高的山梁上一排，从湖边就看得见
    const tower = new MeshBuilder();
    tower.tint = WHITE;
    const blades = new MeshBuilder();
    blades.tint = WHITE;
    const origin = new Frame(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
    // 三片叶子：在局部的「左–上」平面里（转轴是「往前」）
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const ax = new THREE.Vector3(0, Math.sin(a), Math.cos(a));
      const from = ax.clone().multiplyScalar(1.6);
      const mid = ax.clone().multiplyScalar(13);
      const tip = ax.clone().multiplyScalar(33);
      blades.beam(from, mid, 0.5, 2.5);
      blades.beam(mid, tip, 0.3, 1.5);
    }
    box(blades, origin, -1.2, 1.4, -1.5, 1.5, -1.5, 1.5, true);
    const rotor = blades.build();
    const sites: [number, number][] = [
      [-40, 505],
      [70, 520],
      [180, 498],
      [290, 512],
      [400, 480],
    ];
    // 都朝着西南（湖和主风的方向）
    const facing = new THREE.Vector3(-0.35, 0, -0.94).normalize();
    const face = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), facing);
    sites.forEach(([x, z], k) => {
      const y = terrainHeight(x, z);
      const hub = 62;
      tower.cylinder(x, y - 2, y + hub, z, 2.3, 1.3, 12, false);
      // 机舱
      const N = new Frame(new THREE.Vector3(x, y + hub, z), facing.clone(), new THREE.Vector3(-facing.z, 0, facing.x));
      box(tower, N, -5.5, 2.2, -1.5, 1.5, -1.4, 1.6, true);
      const mesh = new THREE.Mesh(rotor, host.looks.paint);
      mesh.position.set(x + facing.x * 3.4, y + hub, z + facing.z * 3.4);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      host.group.add(mesh);
      spinners.push({ mesh, face, angle: k * 1.3, speed: 0.75 + (k % 3) * 0.09 });
      const top = N.p(-3, 0, 2.0);
      K.beacon.box(top[0], top[1], top[2], 0.7, 0.7, 0.7, true);
      clearings.push({ x, z, r: 7 });
    });
    host.add(tower, host.looks.paint, false, true);
  }

  // 缆车：从观景台旁边的下站一直拉到山顶天文台旁边，中间隔几十米一座塔
  let gondolas: THREE.InstancedMesh | null = null;
  const lineUp: THREE.Vector3[] = [];
  const lineDown: THREE.Vector3[] = [];
  if (station && summit) {
    const a = station.v(0, 0, 0);
    const b = summit.v(16, -6, 0);
    const span = new THREE.Vector3().subVectors(b, a);
    const total = Math.hypot(span.x, span.z);
    const f = new THREE.Vector3(span.x, 0, span.z).normalize();
    const l = new THREE.Vector3(f.z, 0, -f.x).negate();
    const towers = Math.round(total / 62);
    const kit = new MeshBuilder();
    kit.tint = GALV;
    const cable = new MeshBuilder();
    cable.tint = DARK;
    const arm = 3.2;
    const station2 = (o: THREE.Vector3, tint: Tint): void => {
      const F = new Frame(new THREE.Vector3(o.x, terrainHeight(o.x, o.z) + 0.1, o.z), f, l);
      kit.tint = CONCRETE;
      box(kit, F, -6, 6, -5.5, 5.5, -3, 0.3);
      kit.tint = tint;
      box(kit, F, -6, 6, -5.5, -5.1, 0.3, 6.5);
      box(kit, F, -6, 6, 5.1, 5.5, 0.3, 6.5);
      box(kit, F, -6, 6, -5.8, 5.8, 6.5, 7.2, true);
      box(kit, F, -6, -5.6, -5.5, 5.5, 3.6, 6.5);
      kit.tint = DARK;
      cyl(kit, F, 0, 0, 5.6, 6.0, 3.4, 3.4, 14);
    };
    station2(a, RED);
    station2(b, [0.42, 0.42, 0.4]);
    clearings.push({ x: a.x, z: a.z, r: 11 }, { x: b.x, z: b.z, r: 11 });
    for (let k = 0; k <= towers; k++) {
      let t = k / towers;
      // 缆索要跨过发卡弯出口的那段路：塔不能立在路上，落在路上的话顺着缆索前后挪几米
      if (k > 0 && k < towers) {
        for (const shift of [0, 9, -9, 18, -18, 27, -27]) {
          const tt = t + shift / total;
          if (!onRoad(a.x + span.x * tt, a.z + span.z * tt, 3.5)) {
            t = tt;
            break;
          }
        }
      }
      const x = a.x + span.x * t;
      const z = a.z + span.z * t;
      const ground = terrainHeight(x, z);
      const top = ground + (k === 0 || k === towers ? 6.2 : 15.5);
      if (k > 0 && k < towers) {
        const F = new Frame(new THREE.Vector3(x, ground, z), f, l);
        kit.tint = GALV;
        box(kit, F, -0.45, 0.45, -0.45, 0.45, -2, top - ground);
        box(kit, F, -0.3, 0.3, -arm - 0.4, arm + 0.4, top - ground - 0.3, top - ground + 0.3);
        clearings.push({ x, z, r: 4.5 });
      }
      lineUp.push(new THREE.Vector3(x + l.x * arm, top, z + l.z * arm));
      lineDown.push(new THREE.Vector3(x - l.x * arm, top, z - l.z * arm));
    }
    for (const line of [lineUp, lineDown]) {
      for (let k = 0; k < line.length - 1; k++) {
        let from = line[k];
        for (let j = 1; j <= 5; j++) {
          const t = j / 5;
          const to = new THREE.Vector3().lerpVectors(line[k], line[k + 1], t);
          to.y -= 1.6 * 4 * t * (1 - t);
          cable.beam(from, to, 0.07, 0.07);
          from = to;
        }
      }
    }
    host.add(kit, host.looks.paint, true, true);
    host.add(cable, host.looks.paint, false, false, true);
    plate(K.neon, new Frame(new THREE.Vector3(a.x, terrainHeight(a.x, a.z) + 0.1, a.z), f, l).at(-6.05, 0, 0, 0), 0, 0, 4.4, 6, 2.06, 'cablecar');
    // 车厢：一个红白的小箱子，上面一根吊臂
    const cabin = new MeshBuilder();
    const O = new Frame(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
    cabin.tint = RED;
    box(cabin, O, -1.3, 1.3, -1.1, 1.1, -5.2, -4.2, true);
    cabin.tint = GLASS_DARK;
    box(cabin, O, -1.25, 1.25, -1.05, 1.05, -4.2, -3.2);
    cabin.tint = WHITE;
    box(cabin, O, -1.35, 1.35, -1.15, 1.15, -3.2, -2.9, true);
    cabin.tint = DARK;
    box(cabin, O, -0.08, 0.08, -0.08, 0.08, -2.9, 0);
    gondolas = new THREE.InstancedMesh(cabin.build(), host.looks.paint, 12);
    gondolas.castShadow = true;
    gondolas.frustumCulled = false;
    host.group.add(gondolas);
  }
  /* ---- 把攒好的网格放进场景 ---- */
  host.add(K.paint, host.looks.paint, true, true);
  host.add(K.boards, host.looks.boards, true, true);
  host.add(K.roofing, host.looks.roofing, true, true);
  host.add(K.glass, host.looks.glass, false, true);
  host.add(K.small, host.looks.paint, true, true, true);
  host.add(K.wires, host.looks.paint, false, false, true);
  host.add(K.sign, host.looks.sign, false, true, true);
  host.add(K.neon, host.looks.neon, false, false);
  host.add(K.beacon, host.looks.beacon, false, false);
  host.add(K.bulbs, host.mats.lamp, false, false, true);
  host.add(K.fill, host.mats.rock, false, true);


  /** 缆索上走了 u（0–1：上行线从下到上，再沿下行线回来）的位置和朝向 */
  const along = (u: number, out: THREE.Vector3): number => {
    const loop = u % 1;
    const up = loop < 0.5;
    const line = up ? lineUp : lineDown;
    const t = (up ? loop * 2 : 1 - (loop - 0.5) * 2) * (line.length - 1);
    const k = Math.min(line.length - 2, Math.floor(t));
    const q = t - k;
    out.lerpVectors(line[k], line[k + 1], q);
    out.y -= 1.6 * 4 * q * (1 - q);
    return Math.atan2(line[k + 1].x - line[k].x, line[k + 1].z - line[k].z);
  };
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _one = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  const _spin = new THREE.Quaternion();
  const _axis = new THREE.Vector3(1, 0, 0);
  let ride = 0;
  const anim: SceneryAnim = {
    clearings,
    update(dt: number): void {
      for (const s of spinners) {
        s.angle += s.speed * dt;
        s.mesh.quaternion.copy(s.face).multiply(_spin.setFromAxisAngle(_axis, s.angle));
      }
      if (gondolas && lineUp.length > 1) {
        // 一圈大约四分钟
        ride = (ride + dt / 240) % 1;
        for (let k = 0; k < gondolas.count; k++) {
          const yaw = along(ride + k / gondolas.count, _p);
          _m.compose(_p, _q.setFromAxisAngle(_up, yaw - Math.PI / 2), _one);
          gondolas.setMatrixAt(k, _m);
        }
        gondolas.instanceMatrix.needsUpdate = true;
      }
    },
  };
  anim.update(0);
  return anim;
}
