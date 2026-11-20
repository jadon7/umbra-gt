import * as THREE from 'three/webgpu';

export type V3 = [number, number, number];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * 把大量简单几何（四边形、盒子、梁）攒成一个网格。
 * 城市里的楼、桥、高架都是上千个小件，逐个建 Mesh 会有上千次绘制调用；合并后每种材质只画一次。
 */
export class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uvs: number[] = [];
  private readonly info: number[] = [];
  private readonly size: number[] = [];
  private readonly shop: number[] = [];
  private readonly idx: number[] = [];
  private readonly col: number[] = [];
  private readonly facade: boolean;
  /** 设了颜色之后加进来的面都带这个颜色（顶点色）；要么全程都设，要么都不设 */
  tint: V3 | null = null;

  /** facade = true 时额外带上楼体立面着色器要的几个属性（见 facade.ts） */
  constructor(facade = false) {
    this.facade = facade;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /**
   * 加一个四边形。四个角按顺序给出即可；outward 指定朝外的大致方向，绕序会自动调整。
   * uv = [a 的 u, a 的 v, c 的 u, c 的 v]（a、c 是对角）
   */
  quad(a: V3, b: V3, c: V3, d: V3, outward: V3, uv: [number, number, number, number] = [0, 0, 1, 1], info?: number[], size?: number[], shop = 0): void {
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _b.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    _n.crossVectors(_a, _b).normalize();
    let flip = false;
    if (_n.x * outward[0] + _n.y * outward[1] + _n.z * outward[2] < 0) {
      _n.negate();
      flip = true;
    }
    const base = this.pos.length / 3;
    const corners = [a, b, c, d];
    const cu = [uv[0], uv[2], uv[2], uv[0]];
    const cv = [uv[1], uv[1], uv[3], uv[3]];
    for (let k = 0; k < 4; k++) {
      this.pos.push(corners[k][0], corners[k][1], corners[k][2]);
      this.nor.push(_n.x, _n.y, _n.z);
      this.uvs.push(cu[k], cv[k]);
      if (this.tint) this.col.push(this.tint[0], this.tint[1], this.tint[2]);
      if (this.facade) {
        this.info.push(...(info ?? [1, 0, 3, 3.6]));
        this.size.push(...(size ?? [1000, 1000]));
        this.shop.push(shop);
      }
    }
    if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** 轴对齐的盒子。center 是中心，size 是三个方向的全长 */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, bottom = false): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [0, y0, sz, y1]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [0, y0, sz, y1]);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [0, y0, sx, y1]);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [0, y0, sx, y1]);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [0, 0, sx, sz]);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [0, 0, sx, sz]);
  }

  /** 连接两点的一根梁，截面 w × h */
  beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number): void {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.multiplyScalar(1 / len);
    if (Math.abs(_dir.y) > 0.99) _right.set(1, 0, 0);
    else _right.crossVectors(_dir, _up.set(0, 1, 0)).normalize();
    _up.crossVectors(_right, _dir).normalize();
    const hw = w / 2, hh = h / 2;
    const corner = (p: THREE.Vector3, sr: number, su: number): V3 => [
      p.x + _right.x * hw * sr + _up.x * hh * su,
      p.y + _right.y * hw * sr + _up.y * hh * su,
      p.z + _right.z * hw * sr + _up.z * hh * su,
    ];
    const r: V3 = [_right.x, _right.y, _right.z];
    const u: V3 = [_up.x, _up.y, _up.z];
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
    this.quad(corner(a, 1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(a, 1, 1), r, [0, 0, len, h]);
    this.quad(corner(a, -1, -1), corner(b, -1, -1), corner(b, -1, 1), corner(a, -1, 1), neg(r), [0, 0, len, h]);
    this.quad(corner(a, -1, 1), corner(b, -1, 1), corner(b, 1, 1), corner(a, 1, 1), u, [0, 0, len, w]);
    this.quad(corner(a, -1, -1), corner(b, -1, -1), corner(b, 1, -1), corner(a, 1, -1), neg(u), [0, 0, len, w]);
    const d: V3 = [_dir.x, _dir.y, _dir.z];
    this.quad(corner(b, -1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(b, -1, 1), d, [0, 0, w, h]);
    this.quad(corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1), neg(d), [0, 0, w, h]);
  }

  /** 一面竖直的墙：底边从 (x0,z0) 到 (x1,z1)，高度从 y0 到 y1。outward 是朝外的水平方向 */
  wall(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, outward: V3, info?: number[], size?: number[], shop = 0): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    this.quad([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0], outward, [0, y0, len, y1], info, size, shop);
  }

  /**
   * 竖直的圆台（圆柱、圆锥都是它）：底面半径 r0、顶面半径 r1，用 sides 个平面围成。
   * cap = true 时封上顶面
   */
  cylinder(cx: number, y0: number, y1: number, cz: number, r0: number, r1: number, sides = 10, cap = true): void {
    const ring = (r: number, y: number): V3[] => {
      const out: V3[] = [];
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        out.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
      }
      return out;
    };
    const lo = ring(r0, y0);
    const hi = ring(r1, y1);
    for (let k = 0; k < sides; k++) {
      const a = ((k + 0.5) / sides) * Math.PI * 2;
      this.quad(lo[k], lo[k + 1], hi[k + 1], hi[k], [Math.cos(a), 0, Math.sin(a)], [k / sides, y0, (k + 1) / sides, y1]);
    }
    if (cap && r1 > 0.01) {
      this.fan(
        [cx, cz],
        hi.map((p) => [p[0], p[2]] as [number, number]),
        y1,
      );
    }
  }

  /** 水平的三角扇（做圆盘、半圆盘这类平面）。points 是边界上的点，朝上 */
  fan(center: [number, number], points: [number, number][], y: number): void {
    const base = this.pos.length / 3;
    this.pos.push(center[0], y, center[1]);
    this.nor.push(0, 1, 0);
    this.uvs.push(center[0], center[1]);
    if (this.tint) this.col.push(this.tint[0], this.tint[1], this.tint[2]);
    for (const p of points) {
      this.pos.push(p[0], y, p[1]);
      this.nor.push(0, 1, 0);
      this.uvs.push(p[0], p[1]);
      if (this.tint) this.col.push(this.tint[0], this.tint[1], this.tint[2]);
    }
    for (let k = 0; k < points.length - 1; k++) {
      const a = base + 1 + k;
      const b = base + 2 + k;
      // 保证朝上
      _a.set(points[k][0] - center[0], 0, points[k][1] - center[1]);
      _b.set(points[k + 1][0] - center[0], 0, points[k + 1][1] - center[1]);
      _c.crossVectors(_a, _b);
      if (_c.y > 0) this.idx.push(base, a, b);
      else this.idx.push(base, b, a);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (this.col.length === this.pos.length && this.col.length > 0) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.facade) {
      g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.size, 2));
      g.setAttribute('aShop', new THREE.Float32BufferAttribute(this.shop, 1));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
