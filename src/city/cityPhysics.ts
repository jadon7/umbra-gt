import { RAPIER, type PhysicsWorld } from '../drive/PhysicsWorld.ts';
import {
  ARCH_BRIDGE,
  avenueX,
  BLOCK,
  buildBarriers,
  buildBlocks,
  CITY,
  ELEVATED,
  FLAT_BRIDGE,
  HALF_ROAD,
  LAKESHORE,
  LAND,
  LOWER_LEVEL,
  RIVER,
  roadHeight,
  streetZ,
  type Barrier,
  type Block,
} from './cityLayout.ts';

/** 一段直的墙/栏杆（画面和碰撞共用这份数据） */
export interface WallSegment {
  x: number;
  z: number;
  /** 底部高度 */
  y: number;
  /** 朝向（绕 Y 轴，0 = 沿 Z） */
  yaw: number;
  /** 俯仰（拱桥上的栏杆要跟着桥面倾斜） */
  pitch: number;
  length: number;
  kind: 'rail' | 'wall' | 'truss';
}

/** 一根立柱 */
export interface Column {
  x: number;
  z: number;
  height: number;
  size: number;
}

/** 一条不属于任何街区的人行道（河岸、湖岸边） */
export interface Strip {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface CityStructures {
  blocks: Block[];
  barriers: Barrier[];
  /** 河岸、湖岸边的人行道 */
  strips: Strip[];
  /** 河岸、湖滨、桥两侧的栏杆和矮墙 */
  walls: WallSegment[];
  /** 高架铁路的立柱 */
  elevatedColumns: Column[];
  /** 下层街道的立柱 */
  lowerColumns: Column[];
}

/** 沿一条折线生成墙段 */
function wallsAlong(points: [number, number][], kind: WallSegment['kind'], out: WallSegment[], heightAt?: (x: number, z: number) => number): void {
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-3) continue;
    const y0 = heightAt ? heightAt(x0, z0) : 0;
    const y1 = heightAt ? heightAt(x1, z1) : 0;
    out.push({
      x: (x0 + x1) / 2,
      z: (z0 + z1) / 2,
      y: (y0 + y1) / 2,
      yaw: Math.atan2(x1 - x0, z1 - z0),
      pitch: Math.atan2(y1 - y0, len),
      length: Math.hypot(len, y1 - y0),
      kind,
    });
  }
}

function arcPoints(cx: number, cz: number, r: number, a0: number, a1: number, step: number): [number, number][] {
  const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / step));
  const pts: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return pts;
}

function linePoints(x0: number, z0: number, x1: number, z1: number, step: number): [number, number][] {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / step));
  const pts: [number, number][] = [];
  for (let k = 0; k <= n; k++) pts.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  return pts;
}

/** 算出所有需要碰撞的构筑物（不含楼体和护栏，那两样直接来自布局） */
export function buildStructures(): CityStructures {
  const walls: WallSegment[] = [];
  const L = LAKESHORE;
  const edge = HALF_ROAD + CITY.sidewalk; // 路中心到人行道外沿
  const z4 = streetZ(4);
  const z1 = streetZ(1);
  const shore = LAND.east;

  // --- 湖滨半岛 ---
  const rOuter = L.radius + HALF_ROAD + L.promenade - 0.5;
  const rInner = L.radius - edge;
  // 外侧栏杆：北连接段（河岸）→ 半圆 → 南连接段
  wallsAlong(
    [
      ...linePoints(avenueX(FLAT_BRIDGE.avenue) + edge, RIVER.z0 - 0.5, L.cx, RIVER.z0 - 0.5, 6),
      ...arcPoints(L.cx, L.cz, rOuter, Math.PI / 2, -Math.PI / 2, 6),
      ...linePoints(L.cx, z1 - edge + 0.5, shore, z1 - edge + 0.5, 6),
      [shore, z1 - HALF_ROAD - 13],
    ],
    'rail',
    walls,
  );
  // 内侧矮墙：把公园围起来
  wallsAlong(
    [
      [shore, z4 - HALF_ROAD - 13],
      [shore, z4 - edge],
      ...linePoints(shore, z4 - edge, L.cx, z4 - edge, 6),
      ...arcPoints(L.cx, L.cz, rInner, Math.PI / 2, -Math.PI / 2, 6),
      ...linePoints(L.cx, z1 + edge, shore, z1 + edge, 6),
      [shore, z1 + HALF_ROAD + 13],
    ],
    'wall',
    walls,
  );

  // --- 河岸栏杆：两岸通长，桥头处断开。南岸平桥以东那段已经算在湖滨外侧栏杆里 ---
  for (const bank of [RIVER.z0 - 0.5, RIVER.z1 + 0.5]) {
    const south = bank < (RIVER.z0 + RIVER.z1) / 2;
    let x = LAND.west;
    for (let i = 0; i <= CITY.ni; i++) {
      const gapStart = i < CITY.ni ? avenueX(i) - edge : shore;
      const end = south ? Math.min(gapStart, avenueX(FLAT_BRIDGE.avenue) - edge) : gapStart;
      if (end - x > 1) wallsAlong(linePoints(x, bank, end, bank, 6), 'rail', walls);
      if (i < CITY.ni) x = avenueX(i) + edge;
      if (south && i >= FLAT_BRIDGE.avenue) break;
    }
  }

  // --- 两座赛道用的桥：两侧桁架 ---
  for (const av of [ARCH_BRIDGE.avenue, FLAT_BRIDGE.avenue]) {
    const x = avenueX(av);
    for (const s of [-1, 1]) {
      wallsAlong(linePoints(x + s * (edge - 0.4), RIVER.z0, x + s * (edge - 0.4), RIVER.z1, 5), 'truss', walls, roadHeight);
    }
  }

  // --- 高架铁路立柱：立在两侧人行道靠路缘的位置，路口处空开 ---
  const elevatedColumns: Column[] = [];
  {
    const x = avenueX(ELEVATED.avenue);
    const zStart = streetZ(ELEVATED.j0) + 16;
    const zEnd = streetZ(ELEVATED.j1) - 16;
    for (let z = zStart; z <= zEnd + 0.01; z += 13.75) {
      let nearCross = false;
      for (let j = ELEVATED.j0; j <= ELEVATED.j1; j++) if (Math.abs(z - streetZ(j)) < 13) nearCross = true;
      if (nearCross) continue;
      for (const s of [-1, 1]) elevatedColumns.push({ x: x + s * (HALF_ROAD + 1.3), z, height: ELEVATED.height, size: 0.6 });
    }
  }

  // --- 下层街道立柱 ---
  const lowerColumns: Column[] = [];
  {
    const z = streetZ(LOWER_LEVEL.street);
    const x0 = avenueX(LOWER_LEVEL.i0) + 16;
    const x1 = avenueX(LOWER_LEVEL.i1) - 16;
    for (let x = x0; x <= x1 + 0.01; x += 11) {
      let nearCross = false;
      for (let i = LOWER_LEVEL.i0; i <= LOWER_LEVEL.i1; i++) if (Math.abs(x - avenueX(i)) < 13) nearCross = true;
      if (nearCross) continue;
      for (const s of [-1, 1]) lowerColumns.push({ x, z: z + s * (HALF_ROAD + 1.1), height: LOWER_LEVEL.clearance, size: 0.9 });
    }
  }

  // --- 不属于街区的人行道：河两岸、最东一条大道的东侧、湖滨南连接段外侧 ---
  const strips: Strip[] = [];
  const sw = CITY.sidewalk;
  const alongX = (z0: number, z1s: number, xEnd: number) => {
    let x = LAND.west;
    for (let i = 0; i < CITY.ni; i++) {
      const stop = avenueX(i) - HALF_ROAD;
      if (stop - x > 0.5) strips.push({ x0: x, x1: stop, z0, z1: z1s });
      x = avenueX(i) + HALF_ROAD;
    }
    if (xEnd - x > 0.5) strips.push({ x0: x, x1: xEnd, z0, z1: z1s });
  };
  alongX(RIVER.z0 - sw, RIVER.z0, L.cx);
  alongX(RIVER.z1, RIVER.z1 + sw, shore);
  const eastSide = (za: number, zb: number) => {
    if (zb - za > 0.5) strips.push({ x0: shore - sw, x1: shore, z0: za, z1: zb });
  };
  eastSide(LAND.south, streetZ(0) - HALF_ROAD);
  eastSide(streetZ(0) + HALF_ROAD, z1 - HALF_ROAD);
  eastSide(RIVER.z1 + sw, streetZ(5) - HALF_ROAD + 0); // 北岸路口东南角
  for (let j = 5; j < CITY.nj; j++) eastSide(streetZ(j) + HALF_ROAD, j + 1 < CITY.nj ? streetZ(j + 1) - HALF_ROAD : LAND.north);
  strips.push({ x0: shore, x1: L.cx, z0: z1 - edge, z1: z1 - HALF_ROAD });

  return { blocks: buildBlocks(), barriers: buildBarriers(), strips, walls, elevatedColumns, lowerColumns };
}

const yawQuat = (yaw: number, pitch = 0) => {
  // 先俯仰（绕 X）再偏航（绕 Y）
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
};

/** 把整座城市的碰撞体加进物理世界 */
export function addCityColliders(physics: PhysicsWorld, st: CityStructures): void {
  const L = LAKESHORE;

  // 陆地：河南、河北两大块 + 半岛（圆柱）。顶面都在 y = 0
  const landX = (LAND.west + LAND.east) / 2;
  const landHX = (LAND.east - LAND.west) / 2;
  physics.addBox({ x: landX, y: -2, z: (LAND.south + RIVER.z0) / 2 }, { x: landHX, y: 2, z: (RIVER.z0 - LAND.south) / 2 }, undefined, 1.0, 0);
  physics.addBox({ x: landX, y: -2, z: (RIVER.z1 + LAND.north) / 2 }, { x: landHX, y: 2, z: (LAND.north - RIVER.z1) / 2 }, undefined, 1.0, 0);
  const rLand = L.radius + HALF_ROAD + L.promenade;
  physics.addCylinder({ x: L.cx, y: -2, z: L.cz }, 2, rLand, 1.0);
  // 半岛内的公园：比路面高一个路缘。只取湖岸线以东的部分（凸包），不压到最东那条大道上
  {
    const r = L.radius - HALF_ROAD;
    const am = Math.acos((LAND.east - CITY.sidewalk - L.cx) / r);
    const pts: number[] = [];
    for (let k = 0; k <= 40; k++) {
      const a = -am + (2 * am * k) / 40;
      const x = L.cx + r * Math.cos(a);
      const z = L.cz + r * Math.sin(a);
      pts.push(x, CITY.curb, z, x, CITY.curb - 2, z);
    }
    physics.addConvex(new Float32Array(pts), 1.0);
  }

  // 街区人行道板 + 楼
  for (const b of st.blocks) {
    physics.addBox({ x: b.x, y: CITY.curb - 0.5, z: b.z }, { x: b.w / 2, y: 0.5, z: b.d / 2 }, undefined, 1.0, 0);
    for (const g of b.buildings) {
      physics.addBox({ x: g.x, y: g.h / 2, z: g.z }, { x: g.w / 2, y: g.h / 2, z: g.d / 2 }, undefined, 0.25, 0.1);
    }
  }

  // 河岸、湖岸边的人行道
  for (const s of st.strips) {
    physics.addBox(
      { x: (s.x0 + s.x1) / 2, y: CITY.curb - 0.5, z: (s.z0 + s.z1) / 2 },
      { x: (s.x1 - s.x0) / 2, y: 0.5, z: (s.z1 - s.z0) / 2 },
      undefined,
      1.0,
      0,
    );
  }
  // 湖滨大道外侧的步道：一圈弧形的抬高带，用一段段小凸包拼
  {
    const r0 = L.radius + HALF_ROAD;
    const r1 = r0 + L.promenade;
    const n = 30;
    for (let k = 0; k < n; k++) {
      const a0 = -Math.PI / 2 + (Math.PI * k) / n;
      const a1 = -Math.PI / 2 + (Math.PI * (k + 1)) / n;
      const pts: number[] = [];
      for (const a of [a0, a1]) {
        for (const r of [r0, r1]) {
          const x = L.cx + r * Math.cos(a);
          const z = L.cz + r * Math.sin(a);
          pts.push(x, CITY.curb, z, x, CITY.curb - 1, z);
        }
      }
      physics.addConvex(new Float32Array(pts), 1.0);
    }
  }

  // 路口护栏。弯道路口的两道上面立着 LED 屏，碰撞体跟着屏一样高
  for (const b of st.barriers) {
    const hx = b.alongX ? b.length / 2 : 0.45;
    const hz = b.alongX ? 0.45 : b.length / 2;
    const hy = b.kind === 'ahead' ? 2.0 : b.kind === 'wrong' ? 1.3 : 0.75;
    physics.addBox({ x: b.x, y: hy, z: b.z }, { x: hx, y: hy, z: hz }, undefined, 0.2, 0.15);
  }

  // 栏杆、矮墙、桁架
  for (const w of st.walls) {
    const h = w.kind === 'truss' ? 2.4 : 0.7;
    physics.addBox({ x: w.x, y: w.y + h, z: w.z }, { x: 0.22, y: h, z: w.length / 2 + 0.05 }, yawQuat(w.yaw, w.pitch), 0.15, 0.15);
  }

  // 立柱
  for (const c of [...st.elevatedColumns, ...st.lowerColumns]) {
    physics.addBox({ x: c.x, y: c.height / 2, z: c.z }, { x: c.size / 2, y: c.height / 2, z: c.size / 2 }, undefined, 0.2, 0.1);
  }

  // 下层街道的顶板
  {
    const z = streetZ(LOWER_LEVEL.street);
    const x0 = avenueX(LOWER_LEVEL.i0) + 14;
    const x1 = avenueX(LOWER_LEVEL.i1) - 14;
    physics.addBox({ x: (x0 + x1) / 2, y: LOWER_LEVEL.clearance + 0.5, z }, { x: (x1 - x0) / 2, y: 0.5, z: HALF_ROAD + CITY.sidewalk }, undefined, 0.3, 0);
  }

  // 平桥桥面
  {
    const x = avenueX(FLAT_BRIDGE.avenue);
    physics.addBox({ x, y: -0.5, z: (RIVER.z0 + RIVER.z1) / 2 }, { x: HALF_ROAD + CITY.sidewalk, y: 0.5, z: (RIVER.z1 - RIVER.z0) / 2 + 0.2 }, undefined, 1.0, 0);
  }

  // 拱桥桥面：三角网格，顶面跟着拱形
  {
    const x = avenueX(ARCH_BRIDGE.avenue);
    const half = HALF_ROAD + CITY.sidewalk;
    const n = 48;
    const verts = new Float32Array((n + 1) * 2 * 3);
    const idx = new Uint32Array(n * 6);
    for (let k = 0; k <= n; k++) {
      // 两端各多伸出一点，和陆地搭接
      const z = RIVER.z0 - 0.3 + ((RIVER.z1 - RIVER.z0 + 0.6) * k) / n;
      const y = roadHeight(x, Math.min(Math.max(z, RIVER.z0), RIVER.z1));
      verts.set([x - half, y, z, x + half, y, z], k * 6);
      if (k < n) {
        const a = k * 2;
        // 顶面朝上
        idx.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], k * 6);
      }
    }
    physics.addTrimesh(verts, idx, 1.0);
  }
}

export { BLOCK };
