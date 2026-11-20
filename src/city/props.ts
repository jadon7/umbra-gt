import * as THREE from 'three/webgpu';
import { attribute, cos, float, fract, instancedBufferAttribute, length, mix, sin, smoothstep, time, uv, vec3 } from 'three/tsl';
import { fxDepthFade } from '../core/fx.ts';
import { GROUND_FLOOR, SHOP_BAY } from './cityLayout.ts';
import type { WallFace } from './cityDetails.ts';
import { cityUniforms } from './materials.ts';
import { MeshBuilder } from './MeshBuilder.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 街边的杂物：垃圾袋、纸箱、报箱、垃圾桶、木托盘、落水管、窗式空调、消防栓。
 * 街道显得"假"，很大程度上是因为太干净——真实的街上到处是这些没人注意的小东西。
 *
 * 杂物都贴着墙根摆（离墙半米以内），或者立在路缘上和路灯一排；它们没有碰撞，
 * 车贴着墙蹭过去的时候会穿过去。按颜色分成几堆，每堆合并成一块网格。
 */
export class StreetProps {
  /** 深色金属：垃圾桶、落水管、报箱的腿 */
  readonly metal = new MeshBuilder();
  readonly wood = new MeshBuilder();
  /** 黑色垃圾袋 */
  readonly bags = new MeshBuilder();
  readonly cardboard = new MeshBuilder();
  /** 浅灰：空调外机、电表箱 */
  readonly pale = new MeshBuilder();
  /** 彩色的：报箱、消防栓、邮筒 */
  readonly red = new MeshBuilder();
  readonly blue = new MeshBuilder();
  readonly yellow = new MeshBuilder();
  readonly green = new MeshBuilder();

  /**
   * 沿一面临街的墙摆杂物。
   * @param dense 赛道沿线摆得密，别处稀疏
   * @param masonry 砖石楼才有落水管和窗式空调
   * @param grid 楼上窗户的排布（开间宽、层高、层数）
   */
  alongWall(f: WallFace, rnd: () => number, dense: boolean, masonry: boolean, wallTop: number, grid: { bay: number; floorH: number; floors: number }): void {
    const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
    const tx = (f.x1 - f.x0) / len;
    const tz = (f.z1 - f.z0) / len;
    const alongX = Math.abs(tx) > 0.5;
    /** 墙面坐标 → 世界坐标：a 沿墙，o 离墙多远 */
    const at = (a: number, o: number): [number, number] => [f.x0 + tx * a + f.nx * o, f.z0 + tz * a + f.nz * o];
    /** 一个贴着墙摆的盒子：along 是沿墙方向的长度，depth 是离墙方向的厚度 */
    const box = (b: MeshBuilder, a: number, y: number, o: number, along: number, h: number, depth: number, bottom = false) => {
      const [x, z] = at(a, o);
      b.box(x, y, z, alongX ? along : depth, h, alongX ? depth : along, bottom);
    };
    const colors = [this.red, this.blue, this.yellow, this.green];

    // 墙垛的位置（两家店之间）：杂物摆在这儿，不挡门
    const piers = Math.floor(len / SHOP_BAY);
    for (let k = 1; k < piers; k++) {
      if (rnd() > (dense ? 0.62 : 0.22)) continue;
      const a = k * SHOP_BAY + (rnd() - 0.5) * 0.5;
      const kind = Math.floor(rnd() * 6);
      if (kind === 0) {
        // 一堆垃圾袋：三四个鼓鼓的黑袋子，顶上扎着口
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
          const [x, z] = at(a + (i - n / 2) * 0.52 + rnd() * 0.2, 0.36 + rnd() * 0.3);
          const r = 0.27 + rnd() * 0.1;
          const h = 0.42 + rnd() * 0.2;
          this.bags.cylinder(x, 0, h * 0.55, z, r * 0.82, r, 7, false);
          this.bags.cylinder(x, h * 0.55, h, z, r, r * 0.42, 7, false);
          this.bags.cylinder(x, h, h + 0.1, z, 0.05, 0.09, 5, true);
        }
      } else if (kind === 1) {
        // 一摞纸箱
        let y = 0;
        const n = 1 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
          const w = 0.5 + rnd() * 0.3;
          const h = 0.3 + rnd() * 0.25;
          box(this.cardboard, a + (rnd() - 0.5) * 0.14, y + h / 2, 0.36 + (rnd() - 0.5) * 0.1, w, h, 0.42 + rnd() * 0.12, true);
          y += h;
        }
        if (rnd() < 0.5) box(this.cardboard, a + 0.7, 0.2, 0.34, 0.5, 0.4, 0.44, true);
      } else if (kind === 2) {
        // 一排报箱：两三个不同颜色的铁皮箱，下面四条腿
        const n = 2 + Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) {
          const aa = a + (i - (n - 1) / 2) * 0.6;
          box(colors[Math.floor(rnd() * 4)], aa, 0.78, 0.36, 0.5, 0.82, 0.44, true);
          box(this.metal, aa, 0.19, 0.36, 0.36, 0.38, 0.3);
          // 取报口：一条深色的窗
          box(this.metal, aa, 0.92, 0.585, 0.36, 0.26, 0.02, true);
        }
      } else if (kind === 3) {
        // 铁皮垃圾桶
        const [x, z] = at(a, 0.48);
        this.metal.cylinder(x, 0, 0.86, z, 0.27, 0.31, 10, false);
        this.metal.cylinder(x, 0.86, 0.9, z, 0.34, 0.34, 10, true);
        if (rnd() < 0.6) {
          const [x2, z2] = at(a + 0.72, 0.5);
          this.metal.cylinder(x2, 0, 0.86, z2, 0.27, 0.31, 10, false);
          this.metal.cylinder(x2, 0.86, 0.93, z2, 0.3, 0.12, 10, true);
        }
      } else if (kind === 4) {
        // 一摞木托盘，有时上面压着一个木箱
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
          box(this.wood, a + (rnd() - 0.5) * 0.08, 0.07 + i * 0.15, 0.6 + (rnd() - 0.5) * 0.06, 1.15, 0.035, 1.0, true);
          for (const d of [-0.42, 0, 0.42]) box(this.wood, a + d, 0.03 + i * 0.15, 0.6, 0.1, 0.07, 1.0);
        }
        if (rnd() < 0.5) box(this.wood, a, n * 0.15 + 0.26, 0.6, 0.62, 0.5, 0.62, true);
      } else {
        // 墙上的电表箱和消防接口
        box(this.pale, a, 1.25, 0.09, 0.42, 0.62, 0.18, true);
        box(this.metal, a, 0.5, 0.05, 0.06, 1.0, 0.06);
        box(this.red, a + 0.55, 0.72, 0.1, 0.2, 0.2, 0.2, true);
      }
    }

    // 路缘上：消防栓、垃圾桶（和路灯站一排）
    const kerb = 3.55;
    for (let a = 9 + rnd() * 14; a < len - 6; a += 24 + rnd() * 26) {
      const [x, z] = at(a, kerb);
      if (rnd() < 0.55) {
        // 消防栓：矮胖的柱子，圆顶，两侧各一个接口
        const b = rnd() < 0.7 ? this.red : this.yellow;
        b.cylinder(x, 0, 0.1, z, 0.17, 0.17, 8, false);
        b.cylinder(x, 0.1, 0.56, z, 0.115, 0.105, 8, false);
        b.cylinder(x, 0.56, 0.62, z, 0.15, 0.15, 8, true);
        b.cylinder(x, 0.62, 0.74, z, 0.11, 0.035, 8, true);
        const [nx, nz] = [f.nx * 0.17, f.nz * 0.17];
        b.box(x + nx, 0.42, z + nz, 0.12, 0.12, 0.12, true);
        b.box(x + tx * 0.16, 0.42, z + tz * 0.16, 0.1, 0.1, 0.1, true);
        b.box(x - tx * 0.16, 0.42, z - tz * 0.16, 0.1, 0.1, 0.1, true);
      } else if (dense) {
        // 街角的网格垃圾桶
        this.metal.cylinder(x, 0, 0.95, z, 0.3, 0.36, 12, false);
        this.metal.cylinder(x, 0.95, 1.0, z, 0.385, 0.385, 12, false);
      }
    }

    if (!masonry) return;
    // 落水管：从屋檐一直通到地面
    for (let a = SHOP_BAY; a < len - 1; a += SHOP_BAY * (2 + Math.floor(rnd() * 3))) {
      if (rnd() < 0.45) continue;
      const [x, z] = at(a - 0.17, 0.1);
      this.metal.cylinder(x, 0.15, wallTop - 0.2, z, 0.06, 0.06, 6, false);
      for (let y = 2.4; y < wallTop - 1; y += 3.4) box(this.metal, a - 0.17, y, 0.07, 0.2, 0.06, 0.16);
    }
    // 窗式空调：从窗户下半截探出来的铁箱子
    const cols = Math.floor(len / grid.bay);
    for (let fl = 0; fl < Math.min(grid.floors, 12); fl++) {
      for (let c = 0; c < cols; c++) {
        if (rnd() > (dense ? 0.085 : 0.04)) continue;
        const a = (c + 0.5) * grid.bay;
        const y = GROUND_FLOOR + fl * grid.floorH + grid.floorH * 0.36;
        box(this.pale, a, y, 0.2, 0.66, 0.4, 0.42, true);
        box(this.metal, a, y, 0.415, 0.56, 0.3, 0.012);
      }
    }
  }

  /** 每种颜色各建一块网格 */
  build(add: (b: MeshBuilder, material: THREE.Material) => void, metal: THREE.Material, wood: THREE.Material): void {
    const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
    add(this.metal, metal);
    add(this.wood, wood);
    add(this.bags, std(0x050506, 0.32, 0.0));
    add(this.cardboard, std(0x6b4a2c, 0.9));
    add(this.pale, std(0x77797a, 0.6, 0.3));
    add(this.red, std(0x8a1410, 0.5, 0.2));
    add(this.blue, std(0x12357a, 0.5, 0.2));
    add(this.yellow, std(0xa87f0e, 0.5, 0.2));
    add(this.green, std(0x1c5a2e, 0.5, 0.2));
  }
}

/**
 * 井盖冒出来的蒸汽：一股一股往上飘、越飘越散的白气。夜里被路灯染成橘色，白天是灰白的。
 * 每个出气口是八九团朝着镜头的软边圆片，位置和大小全在着色器里按时间算，不用每帧更新。
 * 画在特效叠加层里。
 */
export function createSteamVents(vents: { x: number; y: number; z: number }[]): THREE.Sprite | null {
  if (vents.length === 0) return null;
  const PUFFS = 9;
  const count = vents.length * PUFFS;
  const base = new Float32Array(count * 3);
  const seed = new Float32Array(count * 2);
  vents.forEach((v, i) => {
    for (let k = 0; k < PUFFS; k++) {
      const n = i * PUFFS + k;
      base.set([v.x, v.y, v.z], n * 3);
      seed.set([k / PUFFS + Math.random() * 0.08, Math.random()], n * 2);
    }
  });
  const p: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(base, 3));
  const s: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(seed, 2));
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  m.fog = false;
  // t：这一团从冒出来到散掉走到了哪一步（0–1），各团错开
  const t: N = fract(time.mul(0.11).add(s.x));
  const sway: N = s.y.mul(6.28);
  const rise: N = t.mul(t.mul(-0.35).add(1.35)).mul(5.2);
  // 一边升一边左右晃，再被风往一侧带
  const driftX: N = (sin(sway.add(t.mul(3.0))) as N).mul(t).mul(0.7).add(t.mul(t).mul(1.3));
  const driftZ: N = (cos(sway.add(t.mul(2.3))) as N).mul(t).mul(0.7);
  m.positionNode = p.add(vec3(driftX, rise, driftZ));
  m.scaleNode = mix(float(0.7), float(3.6), t).mul(s.y.mul(0.4).add(0.8));
  m.rotationNode = sway.add(t.mul(0.8));
  const d: N = length(uv().sub(0.5)).mul(2.0);
  const soft: N = smoothstep(1.0, 0.25, d);
  const lights: N = cityUniforms.lights;
  m.colorNode = mix(vec3(0.8, 0.82, 0.86) as N, vec3(0.62, 0.4, 0.22) as N, smoothstep(0.1, 0.6, lights));
  m.opacityNode = soft
    .mul(smoothstep(0.0, 0.1, t))
    .mul(float(1).sub(t).pow(1.6))
    .mul(mix(float(0.3), float(0.42), lights))
    .mul(fxDepthFade(0.8));
  const sprite = new THREE.Sprite(m);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = -1;
  return sprite;
}

/** 一片垃圾：位置、朝向、大小、颜色 */
export interface LitterPiece {
  x: number;
  y: number;
  z: number;
  yaw: number;
  size: number;
  color: [number, number, number];
}

/** 垃圾的几种颜色：废纸、报纸、纸袋、红蓝两色的纸杯和包装 */
export const LITTER_COLORS: [number, number, number][] = [
  [0.62, 0.61, 0.57],
  [0.62, 0.61, 0.57],
  [0.4, 0.4, 0.38],
  [0.36, 0.26, 0.15],
  [0.45, 0.07, 0.05],
  [0.08, 0.16, 0.4],
  [0.5, 0.42, 0.1],
];

/**
 * 路缘和墙根的碎垃圾：废纸、纸杯、包装袋。每片是贴着地面的一小块平面，全部一次画完。
 * 单看一片什么都不是，但排水沟里隔几米就有一两片，路面就不再像刚铺好的。
 */
export function createLitter(pieces: LitterPiece[]): THREE.InstancedMesh | null {
  if (pieces.length === 0) return null;
  const g = new THREE.PlaneGeometry(1, 0.72);
  g.rotateX(-Math.PI / 2);
  const tint = new Float32Array(pieces.length * 3);
  g.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, side: THREE.DoubleSide });
  m.colorNode = attribute('aTint', 'vec3');
  const mesh = new THREE.InstancedMesh(g, m, pieces.length);
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  pieces.forEach((p, i) => {
    // 不是完全平躺：一头翘起来一点
    q.setFromEuler(e.set((Math.sin(p.yaw * 7.3) * 0.5 + 0.5) * 0.22, p.yaw, Math.sin(p.yaw * 3.1) * 0.12, 'YXZ'));
    mat.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.size, 1, p.size));
    mesh.setMatrixAt(i, mat);
    tint.set(p.color, i * 3);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}
