import { Quaternion, Vector3 } from 'three';
import type { PhysicsWorld } from '../drive/PhysicsWorld.ts';
import { buildMountainTrack, MOUNTAIN, roadHeightAt, spanAt, terrainHeight } from './mountainLayout.ts';

/** 路外的地面碰撞体铺到离中心线多远（和画面上贴着路的那几圈地形是同一组距离，见 MountainWorld） */
export const VERGE_RINGS = [MOUNTAIN.bench, 13.4, 17.5, 23, 30, 38];

const _q = new Quaternion();
const _qp = new Quaternion();
const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);

/** 弯的内侧：往圆心方向最多只能伸这么远，再远就越过圆心、和对面的路基叠在一起了 */
export function ringOffset(base: number, curvature: number, side: number): number {
  const inside = Math.sign(curvature) === side && Math.abs(curvature) > 1e-4;
  if (!inside) return base;
  return Math.min(base, Math.max(MOUNTAIN.bench + 0.4, 0.86 / Math.abs(curvature)));
}

/**
 * 山路的碰撞体：路面和路肩（一圈三角网格）、两侧的护栏（一段段盒子）、路外三十几米以内的地面。
 * 画面上的护栏只有半人高，碰撞体要高得多（四米）：车被撞得弹起来、底盘高的皮卡蹭上护栏时，不会翻到外面去。
 */
export function addMountainColliders(physics: PhysicsWorld): void {
  const track = buildMountainTrack();
  const S = track.samples;
  const n = S.length;

  /* ---- 路面 + 路肩 ---- */
  {
    const w = MOUNTAIN.bench;
    const verts = new Float32Array(n * 2 * 3);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const p = S[i];
      verts.set([p.pos.x - p.left.x * w, roadHeightAt(i, -w), p.pos.z - p.left.z * w, p.pos.x + p.left.x * w, roadHeightAt(i, w), p.pos.z + p.left.z * w], i * 6);
      const a = i * 2;
      const b = ((i + 1) % n) * 2;
      idx.set([a, b, a + 1, a + 1, b, b + 1], i * 6);
    }
    physics.addTrimesh(verts, idx, 1.0);
  }

  /* ---- 护栏 ---- */
  for (const side of [1, -1]) {
    let i = 0;
    while (i < n) {
      const k = Math.abs(S[i].curvature);
      const j = Math.min(n, i + (k < 0.004 ? 3 : k < 0.02 ? 2 : 1));
      const a = S[i];
      const b = S[j % n];
      const ax = a.pos.x + a.left.x * MOUNTAIN.rail * side;
      const az = a.pos.z + a.left.z * MOUNTAIN.rail * side;
      const bx = b.pos.x + b.left.x * MOUNTAIN.rail * side;
      const bz = b.pos.z + b.left.z * MOUNTAIN.rail * side;
      const dx = bx - ax;
      const dz = bz - az;
      const ay = roadHeightAt(i, MOUNTAIN.rail * side);
      const by = roadHeightAt(j % n, MOUNTAIN.rail * side);
      const dy = by - ay;
      const flat = Math.hypot(dx, dz);
      const len = Math.hypot(flat, dy);
      _q.setFromAxisAngle(Y_AXIS, Math.atan2(dx, dz)).multiply(_qp.setFromAxisAngle(X_AXIS, -Math.atan2(dy, flat)));
      physics.addBox(
        { x: (ax + bx) / 2, y: (ay + by) / 2 + 2.0, z: (az + bz) / 2 },
        { x: 0.3, y: 2.2, z: len / 2 + 0.08 },
        { x: _q.x, y: _q.y, z: _q.z, w: _q.w },
        0.15,
        0.15,
      );
      i = j;
    }
  }

  /* ---- 路外的地面：护栏外面到三十几米。隧道上面、桥下面不铺 ---- */
  for (const side of [1, -1]) {
    const rings = VERGE_RINGS.length;
    const verts: number[] = [];
    const idx: number[] = [];
    let prev = -1;
    for (let i = 0; i <= n; i += 2) {
      const p = S[i % n];
      if (spanAt(i % n)) {
        prev = -1;
        continue;
      }
      const base = verts.length / 3;
      for (let r = 0; r < rings; r++) {
        const off = ringOffset(VERGE_RINGS[r], p.curvature, side) * side;
        const x = p.pos.x + p.left.x * off;
        const z = p.pos.z + p.left.z * off;
        verts.push(x, r === 0 ? roadHeightAt(i % n, off) - 0.06 : terrainHeight(x, z), z);
      }
      if (prev >= 0) {
        for (let r = 0; r < rings - 1; r++) {
          const a = prev + r;
          const b = base + r;
          // 左侧和右侧的绕向相反，都让面朝上
          if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
          else idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
      prev = base;
    }
    physics.addTrimesh(new Float32Array(verts), new Uint32Array(idx), 0.9);
  }
}
