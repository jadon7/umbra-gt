import * as THREE from 'three/webgpu';
import { abs, float, floor, fract, mix, smoothstep, step, uv, vec3 } from 'three/tsl';
import { GROUND_FLOOR, SHOP_BAY } from './cityLayout.ts';
import type { MeshBuilder } from './MeshBuilder.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * 楼体上的小构件：防火梯、雨棚、檐口、屋顶水箱、天线。
 * 立面本身是一张平的墙（细节靠着色器画出来），这些是真正凸出墙面的东西：
 * 有了它们，楼的轮廓才不是一个个光溜溜的方盒子，灯光下也有了影子。
 */

/** 一面临街的墙：从 (x0, z0) 到 (x1, z1)，(nx, nz) 朝街 */
export interface WallFace {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
}

/**
 * 防火梯：老式砖楼外墙上的铁梯。每层一个平台，平台之间一段斜梯，左右交替；最下面吊着一截爬梯。
 * @param along 梯子在这面墙上的位置（离墙起点多远，米）
 * @param floors 一共几层平台
 */
export function addFireEscape(b: MeshBuilder, f: WallFace, along: number, floorH: number, floors: number): void {
  const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
  const tx = (f.x1 - f.x0) / len;
  const tz = (f.z1 - f.z0) / len;
  const W = 3.4; // 平台沿墙的宽度
  const D = 1.05; // 平台挑出墙面多远
  /** 墙面坐标 → 世界坐标：a 沿墙，o 离墙多远 */
  const at = (a: number, y: number, o: number) => v3(f.x0 + tx * a + f.nx * o, y, f.z0 + tz * a + f.nz * o);
  const a0 = along - W / 2;
  const a1 = along + W / 2;

  for (let k = 0; k < floors; k++) {
    const y = GROUND_FLOOR + (k + 1) * floorH + 0.1;
    // 平台：四周一圈角钢，中间几根横档当格栅
    b.beam(at(a0, y, 0.05), at(a1, y, 0.05), 0.07, 0.07);
    b.beam(at(a0, y, D), at(a1, y, D), 0.07, 0.07);
    for (let s = 0; s <= 6; s++) {
      const a = a0 + (W * s) / 6;
      b.beam(at(a, y, 0.05), at(a, y, D), 0.04, 0.05);
    }
    // 栏杆：两道横杆 + 立柱
    for (const h of [0.55, 1.0]) {
      b.beam(at(a0, y + h, D), at(a1, y + h, D), 0.035, 0.035);
      b.beam(at(a0, y + h, 0.05), at(a0, y + h, D), 0.035, 0.035);
      b.beam(at(a1, y + h, 0.05), at(a1, y + h, D), 0.035, 0.035);
    }
    for (let s = 0; s <= 4; s++) {
      const a = a0 + (W * s) / 4;
      b.beam(at(a, y, D), at(a, y + 1.0, D), 0.035, 0.035);
    }
    // 平台下面的斜撑
    for (const a of [a0 + 0.2, a1 - 0.2]) b.beam(at(a, y - 0.7, 0.05), at(a, y, D - 0.1), 0.05, 0.05);
    // 通到上一层的斜梯：两根梯梁 + 踏步
    if (k < floors - 1) {
      const up = k % 2 === 0;
      const sa = up ? a0 + 0.35 : a1 - 0.35;
      const ea = up ? a1 - 0.5 : a0 + 0.5;
      for (const o of [0.3, 0.85]) b.beam(at(sa, y, o), at(ea, y + floorH, o), 0.04, 0.1);
      for (let s = 1; s < 8; s++) {
        const t = s / 8;
        b.beam(at(sa + (ea - sa) * t, y + floorH * t, 0.3), at(sa + (ea - sa) * t, y + floorH * t, 0.85), 0.05, 0.03);
      }
    }
  }
  // 最下面吊着的一截爬梯：离地两米多，平时够不着
  const y0 = GROUND_FLOOR + floorH + 0.1;
  const la = a0 + 0.5;
  for (const o of [0.35, 0.75]) b.beam(at(la, y0 - 2.6, o), at(la, y0, o), 0.035, 0.035);
  for (let s = 0; s < 7; s++) b.beam(at(la, y0 - 2.5 + s * 0.36, 0.35), at(la, y0 - 2.5 + s * 0.36, 0.75), 0.03, 0.03);
}

/**
 * 店门口的雨棚：一块斜的布篷加一条垂边。
 * uv 里带着两个量给材质用：u = 沿宽度的位置（画条纹），v = 第几种颜色。
 * @param bayIndex 这面墙上的第几家店
 */
export function addAwning(b: MeshBuilder, f: WallFace, bayIndex: number, color: number, reversed: boolean): void {
  const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
  const tx = (f.x1 - f.x0) / len;
  const tz = (f.z1 - f.z0) / len;
  const mid = (bayIndex + 0.5) * SHOP_BAY;
  const centre = reversed ? len - mid : mid;
  const half = SHOP_BAY * 0.43;
  if (centre - half < 0.4 || centre + half > len - 0.4) return;
  const at = (a: number, y: number, o: number): [number, number, number] => [f.x0 + tx * a + f.nx * o, y, f.z0 + tz * a + f.nz * o];
  const a0 = centre - half;
  const a1 = centre + half;
  const top = 3.56;
  const lip = 2.95;
  const out = 1.35;
  // 斜面（朝上朝外）和垂边
  b.quad(at(a0, top, 0.04), at(a1, top, 0.04), at(a1, lip, out), at(a0, lip, out), [f.nx * 0.4, 1, f.nz * 0.4], [0, color, half * 2, color]);
  b.quad(at(a0, lip, out), at(a1, lip, out), at(a1, lip - 0.26, out), at(a0, lip - 0.26, out), [f.nx, 0, f.nz], [0, color, half * 2, color]);
  // 两头的三角形侧片（用很窄的四边形代替）
  for (const a of [a0, a1]) {
    b.quad(at(a, top, 0.04), at(a, lip, out), at(a, lip - 0.26, out), at(a, top - 0.3, 0.04), [tx * (a === a0 ? -1 : 1), 0, tz * (a === a0 ? -1 : 1)], [0, color, 1, color]);
  }
}

/** 雨棚的布：几种耐脏的颜色，有的带宽条纹；晒久了发白、有水渍 */
export function createAwningMaterial(): THREE.MeshStandardNodeMaterial {
  const u: N = uv().x;
  const kind: N = floor(uv().y.add(0.5));
  const pick = (k: number) => step(k - 0.5, kind).mul(float(1).sub(step(k + 0.5, kind)));
  const base: N = vec3(0.3, 0.04, 0.035)
    .mul(pick(0))
    .add(vec3(0.03, 0.14, 0.08).mul(pick(1)))
    .add(vec3(0.035, 0.06, 0.16).mul(pick(2)))
    .add(vec3(0.36, 0.3, 0.2).mul(pick(3)))
    .add(vec3(0.05, 0.05, 0.055).mul(pick(4)))
    .add(vec3(0.34, 0.16, 0.03).mul(pick(5)));
  // 奇数号的颜色带白条纹
  const striped: N = step(0.5, fract(kind.mul(0.5)));
  const stripe: N = smoothstep(0.42, 0.5, abs(fract(u.div(0.7)).sub(0.5))).mul(striped);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  m.colorNode = mix(base, vec3(0.5, 0.48, 0.42), stripe.mul(0.85));
  return m;
}

/** 屋顶水箱：木板箍的圆桶，架在钢架上，戴一顶锥形的帽子。老楼的天际线全靠它 */
export function addWaterTower(wood: MeshBuilder, steel: MeshBuilder, x: number, y: number, z: number, scale: number): void {
  const r = 1.55 * scale;
  const legs = 2.4 * scale;
  const tank = 3.0 * scale;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    steel.beam(v3(x + sx * r * 0.7, y, z + sz * r * 0.7), v3(x + sx * r * 0.62, y + legs, z + sz * r * 0.62), 0.12, 0.12);
  }
  // 腿之间的交叉拉杆
  for (const s of [-1, 1]) {
    steel.beam(v3(x - r * 0.7, y + 0.2, z + s * r * 0.7), v3(x + r * 0.64, y + legs - 0.2, z + s * r * 0.64), 0.05, 0.05);
    steel.beam(v3(x + s * r * 0.7, y + 0.2, z - r * 0.7), v3(x + s * r * 0.64, y + legs - 0.2, z + r * 0.64), 0.05, 0.05);
  }
  steel.box(x, y + legs, z, r * 1.5, 0.14, r * 1.5, true);
  wood.cylinder(x, y + legs + 0.07, y + legs + tank, z, r, r * 0.96, 12, false);
  wood.cylinder(x, y + legs + tank, y + legs + tank + r * 0.75, z, r * 1.08, 0.04, 12, false);
  // 铁箍
  for (const h of [0.2, 0.5, 0.8]) steel.cylinder(x, y + legs + tank * h, y + legs + tank * h + 0.07, z, r * 1.015, r * 1.015, 12, false);
}

/** 高楼顶上的天线桅杆，顶端一盏红色的航空障碍灯。返回灯的位置 */
export function addMast(steel: MeshBuilder, lamp: MeshBuilder, x: number, y: number, z: number, height: number): [number, number, number] {
  steel.beam(v3(x, y, z), v3(x, y + height, z), 0.22, 0.22);
  steel.beam(v3(x, y + height * 0.55, z), v3(x, y + height, z), 0.1, 0.1);
  for (const h of [0.35, 0.6, 0.8]) steel.box(x, y + height * h, z, 0.9, 0.08, 0.08, true);
  lamp.box(x, y + height + 0.15, z, 0.34, 0.34, 0.34, true);
  return [x, y + height + 0.15, z];
}
