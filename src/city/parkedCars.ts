import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { DETAIL_LAYER, groupByCell } from './chunks.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type V3 = [number, number, number];
type RGB = [number, number, number];

/** 一辆停在路边的车：位置、朝向、哪种车身、什么颜色 */
export interface ParkedCar {
  x: number;
  z: number;
  /** 车头朝向（绕 Y 轴，0 = +Z） */
  yaw: number;
  kind: number;
  color: number;
}

/**
 * 车身沿车长方向的一个截面。
 * 截面是左右对称的一圈：车底 → 门槛 → 腰线 → 车窗上沿 → 车顶。没有座舱的地方（引擎盖、后备厢）车顶就贴着腰线。
 */
interface Station {
  z: number;
  /** 半宽 */
  w: number;
  /** 车底、腰线、车顶的高度 */
  y0: number;
  yb: number;
  yr: number;
}

interface BodySpec {
  name: string;
  stations: Station[];
  /** 相邻两个截面之间那一段的上半截是什么：W 前挡 / B 后窗 / R 车顶（两侧是车窗）/ P 全是车漆 */
  tops: string;
  wheelZ: [number, number];
  wheelR: number;
}

const st = (z: number, w: number, y0: number, yb: number, yr = yb): Station => ({ z, w, y0, yb, yr });

/** 四种常见的车身：三厢轿车、两厢小车、SUV、厢式货车。尺寸按真实的街车估的 */
const BODIES: BodySpec[] = [
  {
    name: 'sedan',
    stations: [st(-2.3, 0.74, 0.42, 0.72), st(-2.2, 0.86, 0.3, 0.86), st(-1.55, 0.9, 0.28, 0.93), st(-1.2, 0.9, 0.28, 0.95), st(-0.6, 0.9, 0.28, 0.95, 1.42), st(0.45, 0.9, 0.28, 0.95, 1.42), st(1.15, 0.9, 0.28, 0.93), st(1.95, 0.87, 0.28, 0.82), st(2.25, 0.8, 0.3, 0.7), st(2.33, 0.68, 0.42, 0.6)],
    tops: 'PPPBRWPPP',
    wheelZ: [1.42, -1.38],
    wheelR: 0.33,
  },
  {
    name: 'hatch',
    stations: [st(-1.98, 0.78, 0.42, 0.78), st(-1.9, 0.86, 0.3, 0.92), st(-1.75, 0.87, 0.28, 0.95, 1.2), st(-1.3, 0.88, 0.28, 0.95, 1.46), st(0.3, 0.88, 0.28, 0.95, 1.46), st(0.95, 0.88, 0.28, 0.93), st(1.7, 0.85, 0.28, 0.8), st(1.98, 0.78, 0.3, 0.68), st(2.05, 0.66, 0.42, 0.58)],
    tops: 'PPBRWPPP',
    wheelZ: [1.28, -1.24],
    wheelR: 0.31,
  },
  {
    name: 'suv',
    stations: [st(-2.36, 0.82, 0.5, 0.9), st(-2.28, 0.93, 0.36, 1.06), st(-2.15, 0.94, 0.34, 1.1, 1.45), st(-1.75, 0.95, 0.34, 1.1, 1.72), st(0.35, 0.95, 0.34, 1.1, 1.72), st(1.05, 0.95, 0.34, 1.08), st(1.95, 0.93, 0.34, 0.98), st(2.3, 0.86, 0.36, 0.84), st(2.38, 0.74, 0.5, 0.74)],
    tops: 'PPBRWPPP',
    wheelZ: [1.48, -1.42],
    wheelR: 0.38,
  },
  {
    name: 'van',
    stations: [st(-2.62, 0.9, 0.5, 0.95), st(-2.56, 0.98, 0.36, 1.1, 2.0), st(-2.4, 0.99, 0.34, 1.1, 2.08), st(0.75, 0.99, 0.34, 1.1, 2.08), st(1.0, 0.99, 0.34, 1.1, 2.04), st(1.7, 0.98, 0.34, 1.08), st(2.4, 0.95, 0.34, 0.92), st(2.62, 0.86, 0.38, 0.78), st(2.68, 0.76, 0.5, 0.7)],
    tops: 'PPPRWPPP',
    wheelZ: [1.75, -1.7],
    wheelR: 0.36,
  },
];

/** 车漆颜色：街上的车大多是黑白灰，偶尔一辆彩色的 */
const PAINTS: RGB[] = [
  [0.72, 0.72, 0.7],
  [0.72, 0.72, 0.7],
  [0.42, 0.43, 0.45],
  [0.42, 0.43, 0.45],
  [0.17, 0.18, 0.19],
  [0.03, 0.03, 0.035],
  [0.03, 0.03, 0.035],
  [0.05, 0.09, 0.2],
  [0.34, 0.03, 0.03],
  [0.46, 0.4, 0.3],
  [0.05, 0.14, 0.09],
  [0.55, 0.2, 0.04],
];

/** 攒三角形：车漆一堆（颜色按每辆车给），其余零件一堆（颜色和粗糙度写在顶点上） */
class Parts {
  readonly paint: number[] = [];
  readonly detail: number[] = [];
  readonly color: number[] = [];
  readonly pbr: number[] = [];

  tri(a: V3, b: V3, c: V3, out: V3, style?: [RGB, number, number]): void {
    const n: V3 = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ];
    const flip = n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0;
    const target = style ? this.detail : this.paint;
    if (flip) target.push(...a, ...c, ...b);
    else target.push(...a, ...b, ...c);
    if (style) {
      for (let k = 0; k < 3; k++) {
        this.color.push(...style[0]);
        this.pbr.push(style[1], style[2]);
      }
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, out: V3, style?: [RGB, number, number]): void {
    this.tri(a, b, c, out, style);
    this.tri(a, c, d, out, style);
  }

  /** 朝左或朝右的一个圆片（轮拱的黑影、轮毂） */
  disc(x: number, y: number, z: number, r: number, side: number, style: [RGB, number, number], sides = 9): void {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      this.tri([x, y, z], [x, y + Math.sin(a0) * r, z + Math.cos(a0) * r], [x, y + Math.sin(a1) * r, z + Math.cos(a1) * r], [side, 0, 0], style);
    }
  }

  /** 横躺着的一圈胎面 */
  tread(x0: number, x1: number, y: number, z: number, r: number, style: [RGB, number, number], sides = 9): void {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      const p0: V3 = [x0, y + Math.sin(a0) * r, z + Math.cos(a0) * r];
      const p1: V3 = [x0, y + Math.sin(a1) * r, z + Math.cos(a1) * r];
      const p2: V3 = [x1, y + Math.sin(a1) * r, z + Math.cos(a1) * r];
      const p3: V3 = [x1, y + Math.sin(a0) * r, z + Math.cos(a0) * r];
      const am = (a0 + a1) / 2;
      this.quad(p0, p1, p2, p3, [0, Math.sin(am), Math.cos(am)], style);
    }
  }
}

const GLASS: [RGB, number, number] = [[0.012, 0.014, 0.018], 0.08, 0.3];
const RUBBER: [RGB, number, number] = [[0.012, 0.012, 0.013], 0.9, 0];
const SHADOW: [RGB, number, number] = [[0.004, 0.004, 0.004], 1, 0];
const RIM: [RGB, number, number] = [[0.2, 0.205, 0.215], 0.4, 0.7];
const HUB: [RGB, number, number] = [[0.03, 0.03, 0.032], 0.5, 0.5];
const HEAD: [RGB, number, number] = [[0.75, 0.76, 0.72], 0.15, 0.2];
const TAIL: [RGB, number, number] = [[0.4, 0.015, 0.012], 0.2, 0.1];
const TRIM: [RGB, number, number] = [[0.02, 0.02, 0.022], 0.6, 0.1];
const PLATE: [RGB, number, number] = [[0.6, 0.6, 0.56], 0.5, 0];

/** 一个截面右半边的七个点，从车底中线到车顶中线 */
function ring(s: Station): V3[] {
  const cabin = s.yr - s.yb > 0.12;
  // 座舱往里收（车窗是斜的），车顶比腰线窄
  const wr = s.w * 0.8;
  return [
    [0, s.y0, s.z],
    [s.w * 0.86, s.y0, s.z],
    [s.w, s.y0 + 0.17, s.z],
    [s.w, s.yb - 0.1, s.z],
    [s.w * 0.95, s.yb, s.z],
    cabin ? [wr, s.yr - 0.06, s.z] : [s.w * 0.72, s.yb + 0.02, s.z],
    cabin ? [wr * 0.84, s.yr, s.z] : [s.w * 0.4, s.yb + 0.035, s.z],
    [0, cabin ? s.yr + 0.025 : s.yb + 0.045, s.z],
  ];
}

function buildBody(spec: BodySpec): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const p = new Parts();
  const rings = spec.stations.map(ring);
  const mirror = (v: V3): V3 => [-v[0], v[1], v[2]];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    const top = spec.tops[i];
    for (let k = 0; k < 7; k++) {
      // 这一条是不是玻璃：车顶那一段只有侧窗是，前后挡那一段从腰线往上全是
      const glass = (top === 'R' && k === 4) || ((top === 'W' || top === 'B') && k >= 4);
      const style = glass ? GLASS : undefined;
      // 朝外的大致方向：下半截朝侧面，上半截朝上
      const out: V3 = k === 0 ? [0, -1, 0] : k <= 3 ? [1, 0, 0] : k === 4 ? [1, 0.4, 0] : [0.2, 1, 0];
      p.quad(a[k], a[k + 1], b[k + 1], b[k], out, style);
      p.quad(mirror(a[k]), mirror(a[k + 1]), mirror(b[k + 1]), mirror(b[k]), [-out[0], out[1], out[2]], style);
    }
  }
  // 车头、车尾两个端面
  for (const [r, dir] of [
    [rings[0], -1],
    [rings[rings.length - 1], 1],
  ] as const) {
    const centre: V3 = [0, (r[0][1] + r[7][1]) / 2, r[0][2]];
    for (let k = 0; k < 7; k++) {
      p.tri(centre, r[k], r[k + 1], [0, 0, dir]);
      p.tri(centre, mirror(r[k]), mirror(r[k + 1]), [0, 0, dir]);
    }
  }

  // 车灯、进气格栅、车牌：贴在端面外面一点点的小片
  const first = spec.stations[0];
  const last = spec.stations[spec.stations.length - 1];
  const front = spec.stations[spec.stations.length - 2];
  const rear = spec.stations[1];
  const face = (z: number, dir: number, x0: number, x1: number, y0: number, y1: number, style: [RGB, number, number]) => {
    p.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, dir], style);
  };
  {
    const z = last.z + 0.012;
    const y = last.yb - 0.02;
    for (const s of [-1, 1]) face(z, 1, s * last.w * 0.42, s * last.w * 0.96, y - 0.13, y, HEAD);
    face(z, 1, -last.w * 0.36, last.w * 0.36, last.y0 + 0.02, y - 0.03, TRIM);
    void front;
  }
  {
    const z = first.z - 0.012;
    const y = first.yb - 0.02;
    for (const s of [-1, 1]) face(z, -1, s * first.w * 0.5, s * first.w * 0.98, y - 0.14, y, TAIL);
    face(z, -1, -0.25, 0.25, first.y0 + 0.04, first.y0 + 0.17, PLATE);
    void rear;
  }

  // 车轮：轮拱的黑影、轮胎、轮毂
  for (const z of spec.wheelZ) {
    // 车身在这个位置有多宽
    let w = spec.stations[0].w;
    for (let i = 0; i < spec.stations.length - 1; i++) {
      const a = spec.stations[i];
      const b = spec.stations[i + 1];
      if (z >= a.z && z <= b.z) w = a.w + ((b.w - a.w) * (z - a.z)) / (b.z - a.z);
    }
    const r = spec.wheelR;
    for (const s of [-1, 1]) {
      p.disc(s * (w + 0.004), r + 0.02, z, r + 0.085, s, SHADOW, 10);
      p.tread(s * (w - 0.2), s * (w + 0.02), r, z, r, RUBBER);
      p.disc(s * (w + 0.021), r, z, r, s, RUBBER);
      p.disc(s * (w + 0.026), r, z, r * 0.56, s, RIM, 8);
      p.disc(s * (w + 0.03), r, z, r * 0.16, s, HUB, 5);
    }
  }

  const make = (pos: number[], color?: number[], pbr?: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (color && pbr) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
      g.setAttribute('aPbr', new THREE.Float32BufferAttribute(pbr, 2));
    }
    // 相邻两个面夹角不大就抹平：车身侧面是圆滑的，腰线、端面留棱
    const out = toCreasedNormals(g, 0.62);
    out.computeBoundingSphere();
    return out;
  };
  return { paint: make(p.paint), detail: make(p.detail, p.color, p.pbr) };
}

export const PARKED_KINDS = BODIES.length;
export const PARKED_COLORS = PAINTS.length;

/**
 * 路边停着的车。街道看起来"没人住"，最大的原因就是路边一辆车都没有。
 *
 * 四种车身（轿车、两厢、SUV、货车）都是用十来个截面连起来的低面数模型，每辆四五百个三角形，
 * 远看是车、近看是玩具——所以只停在赛道旁边的岔路里（隔着护栏，开不到跟前）。
 * 同一种车身、同一个格子里的车一次画完；镜头外的格子整组跳过。
 */
export function createParkedCars(cars: ParkedCar[]): THREE.Group {
  const group = new THREE.Group();
  if (cars.length === 0) return group;
  // 颜色都明确写成材质的颜色节点：城市的灯光是按"材质颜色 × 地面光照图"加上去的，
  // 靠实例颜色或者顶点颜色开关的话它读不到，夜里所有车都会变成一个颜色
  const paint = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.5 });
  paint.name = 'ParkedPaint';
  paint.colorNode = attribute('aTint', 'vec3');
  const detail = new THREE.MeshStandardNodeMaterial();
  detail.name = 'ParkedDetail';
  detail.colorNode = attribute('color', 'vec3');
  const pbr: N = attribute('aPbr', 'vec2');
  detail.roughnessNode = pbr.x;
  detail.metalnessNode = pbr.y;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  BODIES.forEach((spec, kind) => {
    const all = cars.filter((car) => car.kind === kind);
    if (all.length === 0) return;
    const geo = buildBody(spec);
    for (const list of groupByCell(all)) {
      // 每组有自己的颜色表，所以车漆的几何体每组要单独一份（顶点数据是共用的）
      const paintGeo = geo.paint.clone();
      const tint = new Float32Array(list.length * 3);
      paintGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      const body = new THREE.InstancedMesh(paintGeo, paint, list.length);
      const parts = new THREE.InstancedMesh(geo.detail, detail, list.length);
      list.forEach((car, i) => {
        q.setFromAxisAngle(up, car.yaw);
        m.compose(new THREE.Vector3(car.x, 0, car.z), q, new THREE.Vector3(1, 1, 1));
        body.setMatrixAt(i, m);
        parts.setMatrixAt(i, m);
        tint.set(PAINTS[car.color % PAINTS.length], i * 3);
      });
      for (const mesh of [body, parts]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.layers.set(DETAIL_LAYER);
        group.add(mesh);
      }
    }
  });
  return group;
}
