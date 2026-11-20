/**
 * 检查山路沿线的景物有没有占道：不开浏览器把景物建一遍，在所有网格的面上每隔一米多取一个点，
 * 凡是落在任何一段路的护栏以内、而且高度在车和镜头会经过的范围里（路面以下 1 米到以上 4.5 米）的，都报出来。
 * 头顶上跨过去的东西（龙门架、彩旗、棚洞顶、缆索、电线）比这高，不算。
 * 运行：node scripts/mountain-scenery-check.ts
 */
import * as THREE from 'three/webgpu';
import type { MeshBuilder } from '../src/city/MeshBuilder.ts';
import { buildMountainTrack, MOUNTAIN, nearestRoad } from '../src/mountain/mountainLayout.ts';
import { buildScenery, type SceneryHost } from '../src/mountain/scenery.ts';

const track = buildMountainTrack();
const S = track.samples;
const n = S.length;
// 和 MountainWorld.findBends 一样的找弯办法（景物里的警告牌、观景台按弯摆）
const bends: { i0: number; i1: number; side: number; radius: number }[] = [];
{
  const bent = (i: number) => Math.abs(S[(i + n) % n].curvature) > 1 / 130;
  let first = 0;
  while (first < n && bent(first)) first++;
  let i = 0;
  while (i < n) {
    if (!bent(first + i)) {
      i++;
      continue;
    }
    const from = i;
    let peak = 0;
    let sum = 0;
    while (i < n && bent(first + i)) {
      const c = S[(first + i) % n].curvature;
      peak = Math.max(peak, Math.abs(c));
      sum += c;
      i++;
    }
    if (i - from > 10) bends.push({ i0: (first + from) % n, i1: (first + i - 1) % n, side: Math.sign(sum), radius: 1 / peak });
  }
}

const geos: THREE.BufferGeometry[] = [];
const group = new THREE.Group();
const fake = {} as THREE.Material;
const host = {
  track,
  group,
  lamps: [],
  glowSpots: [],
  covers: [],
  bends,
  mats: { lamp: fake, rock: fake },
  looks: { paint: fake, boards: fake, roofing: fake, glass: fake, sign: fake, neon: fake, beacon: fake, cascade: fake, mist: fake },
  water: fake,
  add: (b: MeshBuilder) => {
    if (b.triangleCount > 0) geos.push(b.build());
  },
} as unknown as SceneryHost;
const anim = buildScenery(host);
group.traverse((o) => {
  const m = o as THREE.Mesh;
  // 水面、流水、水雾本来就不在路上，风车和缆车是会动的：只查静止的网格
  if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && m.geometry.attributes.position && m.position.lengthSq() === 0 && m.scale.x === 1) geos.push(m.geometry);
});

interface Hit {
  s: number;
  x: number;
  z: number;
  count: number;
  nearest: number;
}
const hits: Hit[] = [];
let checked = 0;
const test = (x: number, y: number, z: number): void => {
  checked++;
  const q = nearestRoad(x, z, 20);
  if (!q || q.dist > MOUNTAIN.rail - 0.3) return;
  if (y < q.y - 1 || y > q.y + 4.5) return;
  const near = hits.find((h) => Math.hypot(h.x - x, h.z - z) < 30);
  if (near) {
    near.count++;
    near.nearest = Math.min(near.nearest, q.dist);
  } else hits.push({ s: S[q.index].s, x, z, count: 1, nearest: q.dist });
};
const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const P = new THREE.Vector3();
for (const g of geos) {
  const p = g.attributes.position;
  const index = g.index;
  const tris = index ? index.count / 3 : p.count / 3;
  for (let t = 0; t < tris; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    A.fromBufferAttribute(p, ia);
    B.fromBufferAttribute(p, ib);
    C.fromBufferAttribute(p, ic);
    // 只看顶点会漏掉又高又细的东西（一根从地下通到十几米高的柱子，顶点全在范围外）：在面上每隔一米多取一个点
    const steps = Math.min(40, Math.max(1, Math.ceil(Math.max(A.distanceTo(B), A.distanceTo(C), B.distanceTo(C)) / 1.4)));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps;
        const v = j / steps;
        P.set(0, 0, 0).addScaledVector(A, 1 - u - v).addScaledVector(B, u).addScaledVector(C, v);
        test(P.x, P.y, P.z);
      }
    }
  }
}
console.log(`景物的网格 ${geos.length} 个，查了 ${checked} 个点，空地 ${anim.clearings.length} 处`);
// 盖了东西的空地：圆心离路太近的也报
for (const c of anim.clearings) {
  const q = nearestRoad(c.x, c.z, 60);
  if (q && q.dist < MOUNTAIN.rail + 1 && c.r > 3) console.log(`  ✗ 一块半径 ${c.r.toFixed(0)} 米的空地的中心在路上：路程 ${S[q.index].s.toFixed(0)} 米处，离中心线 ${q.dist.toFixed(1)} 米（${c.x.toFixed(0)}, ${c.z.toFixed(0)}）`);
}
if (hits.length === 0) console.log('✓ 没有东西占道');
for (const h of hits) console.log(`  ✗ 路程 ${h.s.toFixed(0)} 米附近有东西在护栏以内：${h.count} 个取样点，最近的离中心线 ${h.nearest.toFixed(1)} 米（${h.x.toFixed(0)}, ${h.z.toFixed(0)}）`);
process.exitCode = hits.length ? 1 : 0;
