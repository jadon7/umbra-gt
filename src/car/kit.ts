import * as THREE from 'three/webgpu';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarKit } from './models.ts';
import { BASE, type Warp } from './warp.ts';

/**
 * 空气动力套件：尾翼、前铲、小翼片、车顶进气口、鲨鱼鳍、侧裙、导流片。
 * 这些部件原型车的模型里没有，在这里用代码搭出来：每一件都是几块板或者一段翼型。
 *
 * 位置按原型车的车身来写（+X 向左、+Y 向上、+Z 向前），再跟着车身一起变形，
 * 所以宽体车上的前铲会自动变宽、长尾车上的鳍会自动拉长。
 * 只有尾翼例外：它是整块挪过去的，不然翼型会被拉歪。
 */

export interface KitPart {
  geometry: THREE.BufferGeometry;
  /** accent = 跟随副色（可以换成碳纤维）；black = 黑色饰件 */
  role: 'accent' | 'black';
  /** 是不是尾翼的一部分（车库里可以把尾翼关掉） */
  wing: boolean;
}

type P2 = [number, number];
type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 一堆三角形。每个三角形都指定"朝外是哪边"，绕向不对就自动翻过来 */
class Soup {
  readonly pos: number[] = [];

  /** @param out 这个面朝外的大致方向 */
  tri(a: V3, b: V3, c: V3, out: V3): void {
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, out) >= 0) this.pos.push(...a, ...b, ...c);
    else this.pos.push(...a, ...c, ...b);
  }

  quad(a: V3, b: V3, c: V3, d: V3, out: V3): void {
    this.tri(a, b, c, out);
    this.tri(a, c, d, out);
  }

  /** 凸的实心块：给一个内部的点，每个面都朝离开它的方向 */
  triFrom(a: V3, b: V3, c: V3, inside: V3): void {
    const mid: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    this.tri(a, b, c, sub(mid, inside));
  }

  quadFrom(a: V3, b: V3, c: V3, d: V3, inside: V3): void {
    this.triFrom(a, b, c, inside);
    this.triFrom(a, c, d, inside);
  }

  /**
   * 把一个平面轮廓拉成一块有厚度的板。
   * @param profile 轮廓上的点（u, v）
   * @param place 把（沿厚度方向的位置, u, v）变成空间坐标
   */
  extrude(profile: P2[], a0: number, a1: number, place: (a: number, u: number, v: number) => V3): void {
    let area = 0;
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i];
      const q = profile[(i + 1) % profile.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    const ccw = area > 0 ? 1 : -1;
    const origin = place(0, 0, 0);
    const dir = (a: number, u: number, v: number): V3 => sub(place(a, u, v), origin);
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i];
      const q = profile[(i + 1) % profile.length];
      const out = dir(0, (q[1] - p[1]) * ccw, -(q[0] - p[0]) * ccw);
      this.quad(place(a0, p[0], p[1]), place(a0, q[0], q[1]), place(a1, q[0], q[1]), place(a1, p[0], p[1]), out);
    }
    const faces = THREE.ShapeUtils.triangulateShape(
      profile.map((p) => new THREE.Vector2(p[0], p[1])),
      [],
    );
    for (const [a, k] of [
      [a0, -1],
      [a1, 1],
    ] as const) {
      const out = dir(k * Math.sign(a1 - a0), 0, 0);
      for (const f of faces) this.tri(place(a, ...profile[f[0]]), place(a, ...profile[f[1]]), place(a, ...profile[f[2]]), out);
    }
  }

  /** 侧面轮廓（z, y）沿左右方向拉成一块竖着的板 */
  plateX(profile: P2[], x0: number, x1: number): void {
    this.extrude(profile, x0, x1, (a, u, v) => [a, v, u]);
  }

  /** 俯视轮廓（x, z）沿上下方向拉成一块平放的板 */
  plateY(profile: P2[], y0: number, y1: number): void {
    this.extrude(profile, y0, y1, (a, u, v) => [u, a, v]);
  }

  /** 一块任意四边形的薄板：四个角 + 厚度（沿 up 方向） */
  slab(a: V3, b: V3, c: V3, d: V3, thickness: number, up: V3 = [0, 1, 0]): void {
    const lift = (p: V3): V3 => [p[0] + up[0] * thickness, p[1] + up[1] * thickness, p[2] + up[2] * thickness];
    const top = [a, b, c, d].map(lift);
    const bottom = [a, b, c, d];
    const inside: V3 = [0, 0, 0];
    for (const p of [...top, ...bottom]) for (let k = 0; k < 3; k++) inside[k] += p[k] / 8;
    this.quadFrom(top[0], top[1], top[2], top[3], inside);
    this.quadFrom(bottom[0], bottom[1], bottom[2], bottom[3], inside);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quadFrom(bottom[i], bottom[j], top[j], top[i], inside);
    }
  }

  /**
   * @param map 每个顶点过一遍的变形（跟着车身走）；不给就原样
   * @param crease 相邻两个面夹角小于它就抹平成圆滑的，大于它留一道棱
   */
  build(map: ((p: THREE.Vector3) => void) | null, crease = 0.5): THREE.BufferGeometry {
    const pos = new Float32Array(this.pos);
    if (map) {
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.length; i += 3) {
        v.set(pos[i], pos[i + 1], pos[i + 2]);
        map(v);
        pos[i] = v.x;
        pos[i + 1] = v.y;
        pos[i + 2] = v.z;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const out = toCreasedNormals(g, crease);
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }
}

/**
 * 翼型截面（z, y）：前缘圆、后缘尖，下表面比上表面鼓（倒过来的机翼，产生下压力），后缘翘起。
 * @param chord 弦长 @param thick 最大厚度 @param tilt 后缘翘起的角度（弧度）
 */
function airfoil(chord: number, thick: number, tilt: number): P2[] {
  const N = 12;
  const upper: P2[] = [];
  const lower: P2[] = [];
  for (let i = 0; i <= N; i++) {
    // s：从前缘 0 到后缘 1，前缘附近取密一点
    const s = (1 - Math.cos((i / N) * Math.PI)) / 2;
    const t = thick * 5 * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1015 * s ** 4);
    const camber = -thick * 0.55 * 4 * s * (1 - s);
    upper.push([chord * (0.5 - s), camber + t * 0.75]);
    lower.push([chord * (0.5 - s), camber - t * 1.25]);
  }
  const pts = [...upper, ...lower.reverse().slice(1, -1)];
  const c = Math.cos(tilt);
  const sn = Math.sin(tilt);
  // 绕弦的中点转：后缘（z 更小的那头）往上翘
  return pts.map(([z, y]) => [z * c + y * sn, y * c - z * sn] as P2);
}

/** 原型车车顶中线的高度（米）：按车长方向的位置查 */
const ROOF: P2[] = [
  [0.25, 1.125],
  [0.15, 1.135],
  [0.05, 1.142],
  [-0.05, 1.147],
  [-0.25, 1.149],
  [-0.45, 1.146],
  [-0.65, 1.135],
  [-0.85, 1.123],
  [-1.05, 1.103],
  [-1.25, 1.073],
  [-1.45, 1.036],
  [-1.6, 1.02],
  [-1.75, 1.03],
  [-1.94, 1.05],
];

function roofY(z: number): number {
  if (z >= ROOF[0][0]) return ROOF[0][1];
  for (let i = 1; i < ROOF.length; i++) {
    if (z >= ROOF[i][0]) {
      const t = (z - ROOF[i][0]) / (ROOF[i - 1][0] - ROOF[i][0]);
      return ROOF[i][1] + (ROOF[i - 1][1] - ROOF[i][1]) * t;
    }
  }
  return ROOF[ROOF.length - 1][1];
}

/** 车头的俯视轮廓：离车头多远的地方，车身半宽是多少（米） */
const NOSE: P2[] = [
  [2.417, 0.3],
  [2.35, 0.59],
  [2.25, 0.8],
  [2.15, 0.885],
  [2.05, 0.96],
  [1.95, 1.036],
];

export function buildKit(kit: CarKit, warp: Warp): KitPart[] {
  const parts: KitPart[] = [];
  const follow = (p: THREE.Vector3): void => {
    warp.apply(p.x, p.y, p.z);
    p.set(warp.x, warp.y, warp.z);
  };
  const add = (soup: Soup, role: KitPart['role'], wing = false, map: ((p: THREE.Vector3) => void) | null = follow, crease = 0.5): void => {
    if (soup.pos.length) parts.push({ geometry: soup.build(map, crease), role, wing });
  };
  /** 整块平移：把按原型车位置搭好的部件挪到新车型上对应的位置（anchor 是它在原型车上的参考点） */
  const carry = (anchor: V3) => {
    warp.apply(...anchor);
    const dx = warp.x - anchor[0];
    const dy = warp.y - anchor[1];
    const dz = warp.z - anchor[2];
    return (p: THREE.Vector3): void => {
      p.set(p.x + dx, p.y + dy, p.z + dz);
    };
  };

  /* ---- 尾翼 ---- */
  if (kit.wing === 'gt') {
    // 高位大尾翼：翼面架在车尾上方，两块"天鹅颈"支架从上面吊着它，两头各一块端板
    const move = carry([0, 1.03, -1.6]);
    const y = 1.385;
    const z = -1.83;
    const span = 0.93;
    const plane = new Soup();
    const section = airfoil(0.34, 0.042, 0.17).map(([pz, py]) => [pz + z, py + y] as P2);
    plane.plateX(section, -span, span);
    // 后缘上的一条小扰流条
    plane.plateX(
      [
        [z - 0.172, y + 0.022],
        [z - 0.186, y + 0.058],
        [z - 0.178, y + 0.058],
        [z - 0.162, y + 0.024],
      ],
      -span,
      span,
    );
    add(plane, 'accent', true, move, 0.7);
    const black = new Soup();
    for (const s of [-1, 1]) {
      const x = s * span;
      black.plateX(
        [
          [z + 0.21, y - 0.075],
          [z + 0.23, y + 0.05],
          [z + 0.13, y + 0.115],
          [z - 0.23, y + 0.135],
          [z - 0.24, y - 0.045],
          [z - 0.1, y - 0.095],
        ],
        x - 0.007,
        x + 0.007,
      );
      const px = s * 0.4;
      black.plateX(
        [
          [-1.47, 1.012],
          [-1.66, 1.0],
          [-1.735, 1.2],
          [z + 0.03, y + 0.022],
          [z - 0.07, y + 0.016],
          [z - 0.07, y + 0.05],
          [z + 0.04, y + 0.095],
          [-1.69, 1.37],
          [-1.6, 1.17],
        ],
        px - 0.008,
        px + 0.008,
      );
    }
    add(black, 'black', true, move);
  } else if (kit.wing === 'low') {
    // 贴着车尾的长条低尾翼：长尾车用，尽量不添风阻
    const move = carry([0, 1.04, -1.9]);
    const y = 1.19;
    const z = -1.86;
    const span = 0.9;
    const plane = new Soup();
    plane.plateX(
      airfoil(0.3, 0.034, 0.1).map(([pz, py]) => [pz + z, py + y] as P2),
      -span,
      span,
    );
    add(plane, 'accent', true, move, 0.7);
    const black = new Soup();
    for (const s of [-1, 1]) {
      const x = s * span;
      black.plateX(
        [
          [z + 0.19, y - 0.2],
          [z + 0.2, y + 0.03],
          [z + 0.08, y + 0.075],
          [z - 0.19, y + 0.085],
          [z - 0.2, y - 0.2],
        ],
        x - 0.007,
        x + 0.007,
      );
      const px = s * 0.45;
      black.plateX(
        [
          [z + 0.1, y - 0.17],
          [z + 0.07, y - 0.01],
          [z - 0.07, y - 0.012],
          [z - 0.1, y - 0.17],
        ],
        px - 0.007,
        px + 0.007,
      );
    }
    add(black, 'black', true, move);
  }

  /* ---- 鲨鱼鳍：车顶的线条平着往后延，一直到车尾；越往后露出来的越高 ---- */
  if (kit.fin) {
    const top: P2[] = [
      [-0.5, 1.146],
      [-0.95, 1.157],
      [-1.45, 1.168],
      [-1.74, 1.174],
      [-1.93, 1.176],
    ];
    const bottom: P2[] = [-1.93, -1.74, -1.55, -1.35, -1.15, -0.95, -0.75].map((z) => [z, roofY(z) - 0.02] as P2);
    const fin = new Soup();
    fin.plateX([...top, ...bottom], -0.008, 0.008);
    add(fin, 'accent');
  }

  /* ---- 车顶进气口 ---- */
  if (kit.scoop) {
    // 几个截面连成一个前高后低的鼓包；最前面是敞开的进气口
    const rings: { z: number; w: number; h: number }[] = [
      { z: 0.13, w: 0.175, h: 0.082 },
      { z: -0.08, w: 0.172, h: 0.09 },
      { z: -0.34, w: 0.15, h: 0.07 },
      { z: -0.58, w: 0.11, h: 0.036 },
      { z: -0.74, w: 0.07, h: 0.004 },
    ];
    const SEG = 10;
    const ring = (r: { z: number; w: number; h: number }, inset = 0): V3[] => {
      const base = roofY(r.z) - 0.012;
      const pts: V3[] = [];
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI;
        // 截面是压扁的半圆，两侧近乎直上直下
        const cx = Math.cos(a);
        const sy = Math.sin(a);
        pts.push([(r.w - inset) * Math.sign(cx) * Math.abs(cx) ** 0.6, base + (r.h - inset) * sy ** 0.6 + (inset ? 0.012 : 0), r.z]);
      }
      return pts;
    };
    const shell = new Soup();
    const inside: V3 = [0, roofY(-0.2), -0.2];
    for (let i = 0; i < rings.length - 1; i++) {
      const a = ring(rings[i]);
      const b = ring(rings[i + 1]);
      for (let k = 0; k < SEG; k++) shell.quadFrom(a[k], a[k + 1], b[k + 1], b[k], inside);
    }
    // 进气口的唇边：外圈到内圈的一圈窄面
    const outer = ring(rings[0]);
    const inner = ring({ ...rings[0], z: rings[0].z - 0.006 }, 0.016);
    for (let k = 0; k < SEG; k++) shell.quad(outer[k], outer[k + 1], inner[k + 1], inner[k], [0, 0, 1]);
    add(shell, 'accent', false, follow, 0.9);
    // 进气口里面：一块黑的
    const mouth = new Soup();
    const deep = ring({ ...rings[0], z: rings[0].z - 0.05 }, 0.016);
    for (let k = 0; k < SEG; k++) {
      mouth.quad(inner[k], inner[k + 1], deep[k + 1], deep[k], [0, -Math.sin(((k + 0.5) / SEG) * Math.PI), 0.2]);
    }
    const centre: V3 = [0, roofY(rings[0].z), rings[0].z - 0.05];
    for (let k = 0; k < SEG; k++) mouth.tri(centre, deep[k], deep[k + 1], [0, 0, 1]);
    add(mouth, 'black');
  }

  /* ---- 前铲：车头下沿往前伸出的一块板，两端各一块立板 ---- */
  if (kit.splitter) {
    const edge: P2[] = [];
    // 沿着车头的俯视轮廓往外放出一圈
    const reach = 0.075;
    edge.push([0, BASE.nose + reach]);
    for (const [z, half] of NOSE) edge.push([half + reach * 0.75, z + reach * 0.45]);
    edge.push([1.085, 1.9]);
    const outline: P2[] = [...edge, [0.6, 1.86], [0, 1.86]];
    const mirrored = outline
      .slice(1, -1)
      .reverse()
      .map(([x, z]) => [-x, z] as P2);
    const plate = new Soup();
    plate.plateY([...outline, ...mirrored], 0.098, 0.116);
    for (const s of [-1, 1]) {
      const x = s * 1.078;
      plate.plateX(
        [
          [1.9, 0.098],
          [2.07, 0.098],
          [2.05, 0.2],
          [1.9, 0.245],
        ],
        x - 0.006,
        x + 0.006,
      );
    }
    add(plate, 'black');
  }

  /* ---- 车头两角的小翼片：每边上下两片，往后往上翘 ---- */
  if (kit.canards) {
    const fins = new Soup();
    for (const s of [-1, 1]) {
      for (const [y, grow] of [
        [0.37, 1],
        [0.52, 0.8],
      ] as const) {
        const out = 0.1 * grow;
        fins.slab([s * 0.85, y, 2.2], [s * (0.87 + out * 0.5), y, 2.235], [s * (1.03 + out), y + 0.075, 1.99], [s * 1.0, y + 0.075, 1.985], 0.009);
      }
    }
    add(fins, 'accent');
  }

  /* ---- 侧裙：门槛下面往外伸的一条板，尾端一块小立板 ---- */
  if (kit.skirts) {
    const skirt = new Soup();
    for (const s of [-1, 1]) {
      const x0 = s * 1.06;
      const x1 = s * 1.165;
      skirt.slab([x0, 0.1, 1.0], [x1, 0.1, 0.96], [x1, 0.1, -0.84], [x0, 0.1, -0.86], 0.02);
      skirt.plateX(
        [
          [-0.86, 0.1],
          [-0.62, 0.1],
          [-0.7, 0.185],
          [-0.86, 0.215],
        ],
        x1 - s * 0.012,
        x1,
      );
    }
    add(skirt, 'black');
  }

  /* ---- 车尾底部的导流片 ---- */
  if (kit.strakes) {
    const fins = new Soup();
    for (const x of [-0.62, -0.31, 0, 0.31, 0.62]) {
      fins.plateX(
        [
          [-1.975, 0.05],
          [-1.975, 0.225],
          [-1.9, 0.235],
          [-1.5, 0.15],
          [-1.5, 0.1],
        ],
        x - 0.007,
        x + 0.007,
      );
    }
    add(fins, 'black');
  }

  return parts;
}
