import * as THREE from 'three/webgpu';
import { attribute, uniform, vec3 } from 'three/tsl';
import type { Car } from '../car/Car';
import { createPaintMaterial, type PaintMaterial, type PaintPreset } from '../car/paint';
import type { CarModel } from '../car/models.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 把很多块网格合并成一块：位置、法线，可选每个顶点的颜色和（粗糙度、金属度） */
class Merger {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly pbr: number[] = [];
  private readonly idx: number[] = [];
  private count = 0;
  private readonly styled: boolean;

  constructor(styled: boolean) {
    this.styled = styled;
  }

  get empty(): boolean {
    return this.count === 0;
  }

  /**
   * @param toLocal 把世界坐标变到合并后这块网格的局部坐标
   */
  add(mesh: THREE.Mesh, toLocal: THREE.Matrix4, color?: THREE.Color, roughness = 0.5, metalness = 0): void {
    const g = mesh.geometry;
    const p = g.attributes.position;
    const n = g.attributes.normal;
    if (!p || !n) return;
    const m = new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    // 镜像过的部件（负缩放）三角形的绕向是反的，要翻回来
    const flip = m.determinant() < 0;
    const v = new THREE.Vector3();
    const base = this.count;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      this.nor.push(v.x, v.y, v.z);
      if (this.styled) {
        this.col.push(color?.r ?? 1, color?.g ?? 1, color?.b ?? 1);
        this.pbr.push(roughness, metalness);
      }
    }
    this.count += p.count;
    const index = g.index;
    const tris = (index ? index.count : p.count) / 3;
    for (let t = 0; t < tris; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      if (flip) this.idx.push(base + a, base + c, base + b);
      else this.idx.push(base + a, base + b, base + c);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (this.styled) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute('aPbr', new THREE.Float32BufferAttribute(this.pbr, 2));
    }
    g.setIndex(new THREE.Uint32BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

interface WheelTemplate {
  geometry: THREE.BufferGeometry;
  /** 转向节点相对整车的位置、大小（有的车型后轮更大更宽） */
  position: THREE.Vector3;
  scale: THREE.Vector3;
  /** 滚动节点相对转向节点的变换 */
  spinMatrix: THREE.Matrix4;
}

/** 从主角车上拆出来、按材质合并好的几何体。同一款车型的对手共用一份 */
interface Template {
  paint: THREE.BufferGeometry;
  misc: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  wheels: WheelTemplate[];
  /** 车身节点相对整车的位置 */
  bodyPosition: THREE.Vector3;
  /** 车身静止时的前倾角 */
  rake: number;
}

/** 这些部件在车里面，对手的车窗是不透明的黑玻璃，看不到，直接不要 */
const INTERIOR = new Set(['Interior_Dark', 'Interior_Accent', 'Hardware', 'Floormat', 'Interior_Panel', 'Interior_Seat', 'Dashboard']);
const TAIL = new Set(['Light_Tail', 'Light_TailBar', 'Light_TailBadge']);
/** 这些部件在主角车上用的是特殊材质，对手车上换成一个固定的颜色：[颜色, 粗糙度, 金属度] */
const FIXED: Record<string, [string, number, number]> = {
  Paint_Secondary: ['#050506', 0.3, 0.5],
  Paint_Accent: ['#050506', 0.3, 0.5],
  Light_Signal: ['#6b3206', 0.35, 0.1],
  LicensePlate: ['#d9d9d4', 0.5, 0],
};

const templates = new Map<string, Template>();

function buildTemplate(car: Car): Template {
  const root = car.root;
  root.updateMatrixWorld(true);
  const bodyInv = new THREE.Matrix4().copy(car.body.matrixWorld).invert();
  const paint = new Merger(false);
  const misc = new Merger(true);
  const glass = new Merger(false);
  const head = new Merger(false);
  const tail = new Merger(false);

  const style = (mesh: THREE.Mesh): [THREE.Color, number, number] => {
    const part = mesh.userData.part as string;
    const fixed = FIXED[part];
    if (fixed) return [new THREE.Color(fixed[0]), fixed[1], fixed[2]];
    const m = mesh.material as THREE.MeshStandardMaterial;
    return [m.color ? m.color.clone() : new THREE.Color(0.02, 0.02, 0.02), m.roughness ?? 0.5, m.metalness ?? 0];
  };

  car.body.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // 藏起来的部件不要（这款车型没装的原厂尾翼、敞篷车拆掉的车顶）
    if (!mesh.isMesh || !mesh.visible) return;
    const part = (mesh.userData.part as string) ?? '';
    if (INTERIOR.has(part)) return;
    if (part === 'Paint_Primary') paint.add(mesh, bodyInv);
    else if (part === 'Glass') glass.add(mesh, bodyInv);
    else if (part === 'Light_Head') head.add(mesh, bodyInv);
    else if (TAIL.has(part)) tail.add(mesh, bodyInv);
    else misc.add(mesh, bodyInv, ...style(mesh));
  });

  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const wheels: WheelTemplate[] = car.wheels.map((w) => {
    const merged = new Merger(true);
    const spinInv = new THREE.Matrix4().copy(w.spin.matrixWorld).invert();
    w.spin.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) merged.add(mesh, spinInv, ...style(mesh));
    });
    // 转向节点可能正打着方向、压着悬挂：位置用静止高度，朝向不要
    const position = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(rootInv, w.steer.matrixWorld));
    position.y = w.restY;
    const spinMatrix = new THREE.Matrix4().compose(w.spin.position, new THREE.Quaternion(), w.spin.scale);
    return { geometry: merged.build(), position, scale: w.steer.scale.clone(), spinMatrix };
  });

  return {
    paint: paint.build(),
    misc: misc.build(),
    glass: glass.build(),
    head: head.build(),
    tail: tail.build(),
    wheels,
    bodyPosition: car.body.position.clone(),
    rake: car.model.shape.rake,
  };
}

/**
 * 给这几款车型各准备一份对手车的几何体。
 * 做法是让主角车临时变成那款车型、拆一遍，最后变回来 —— 所以只能在不显示主角车变化的时候调用（进城市之前的加载阶段）。
 */
export function prepareRivalTemplates(source: Car, models: CarModel[]): void {
  const original = source.model;
  const wing = source.wingOn;
  const pitch = source.body.rotation.x;
  const roll = source.body.rotation.z;
  let changed = false;
  for (const m of models) {
    if (templates.has(m.id)) continue;
    source.setModel(m);
    source.setWing(true);
    source.setBodyLean(0, 0);
    // 合并的时候车身要摆正：前倾角单独记着，之后加回去
    source.body.rotation.x = 0;
    templates.set(m.id, buildTemplate(source));
    changed = true;
  }
  if (changed) {
    source.setModel(original);
    source.setWing(wing);
    source.body.rotation.x = pitch;
    source.body.rotation.z = roll;
  }
}

/* 所有对手共用的材质 */
let miscMaterial: THREE.MeshStandardNodeMaterial | null = null;
let glassMaterial: THREE.MeshStandardNodeMaterial | null = null;
let headMaterial: THREE.MeshBasicNodeMaterial | null = null;
const headLevel = uniform(9.0);

function sharedMaterials(): { misc: THREE.MeshStandardNodeMaterial; glass: THREE.MeshStandardNodeMaterial; head: THREE.MeshBasicNodeMaterial } {
  if (!miscMaterial) {
    miscMaterial = new THREE.MeshStandardNodeMaterial();
    miscMaterial.name = 'RivalMisc';
    miscMaterial.vertexColors = true;
    const pbr: N = attribute('aPbr', 'vec2');
    miscMaterial.roughnessNode = pbr.x;
    miscMaterial.metalnessNode = pbr.y;
  }
  if (!glassMaterial) {
    // 不透明的深色玻璃：对手的车不做内饰，也省掉半透明排序
    glassMaterial = new THREE.MeshStandardNodeMaterial();
    glassMaterial.name = 'RivalGlass';
    glassMaterial.color.set('#020304');
    glassMaterial.roughness = 0.05;
    glassMaterial.metalness = 0.35;
  }
  if (!headMaterial) {
    headMaterial = new THREE.MeshBasicNodeMaterial();
    headMaterial.colorNode = vec3(0.78, 0.88, 1.0).mul(headLevel);
    headMaterial.fog = false;
  }
  return { misc: miscMaterial, glass: glassMaterial, head: headMaterial };
}

/**
 * 对手的车。外形和主角车一样，但为了同屏七八辆不掉帧做了简化：
 * 整车一百多块网格按材质合并成 9 块（车漆、其他外饰、玻璃、大灯、尾灯、四个车轮），不带内饰和卡钳。
 */
export class RivalCar {
  readonly root = new THREE.Group();
  readonly paint: PaintMaterial;

  private readonly body = new THREE.Group();
  private readonly wheels: { steer: THREE.Group; spin: THREE.Object3D; restY: number }[] = [];
  private readonly tailLevel = uniform(2.6);
  private braking = false;
  private lightsOn = true;
  private readonly rake: number;
  /** 这辆车是哪一款 */
  readonly model: CarModel;

  constructor(source: Car, preset: PaintPreset, model: CarModel) {
    this.model = model;
    prepareRivalTemplates(source, [model]);
    const t = templates.get(model.id)!;
    this.rake = t.rake;
    const shared = sharedMaterials();
    this.paint = createPaintMaterial(preset, null);

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, cast: boolean) => {
      const o = new THREE.Mesh(g, m);
      o.castShadow = cast;
      o.receiveShadow = cast;
      return o;
    };
    this.body.position.copy(t.bodyPosition);
    this.body.rotation.x = this.rake;
    this.body.add(mesh(t.paint, this.paint.material, true));
    this.body.add(mesh(t.misc, shared.misc, true));
    this.body.add(mesh(t.glass, shared.glass, false));
    this.body.add(mesh(t.head, shared.head, false));
    const tail = new THREE.MeshBasicNodeMaterial();
    tail.colorNode = (source.tailColor as N).mul(this.tailLevel);
    tail.fog = false;
    this.body.add(mesh(t.tail, tail, false));
    this.root.add(this.body);

    for (const w of t.wheels) {
      const steer = new THREE.Group();
      steer.position.copy(w.position);
      steer.scale.copy(w.scale);
      const spin = new THREE.Group();
      w.spinMatrix.decompose(spin.position, spin.quaternion, spin.scale);
      spin.add(mesh(w.geometry, shared.misc, false));
      steer.add(spin);
      this.root.add(steer);
      this.wheels.push({ steer, spin, restY: w.position.y });
    }
    this.root.visible = false;
  }

  /** 大灯亮度跟着天色走（所有对手共用） */
  static setHeadlights(night: number): void {
    headLevel.value = 1.2 + 7.8 * Math.min(1, Math.max(0, (night - 0.25) / 0.45));
  }

  setWheelPose(index: number, travel: number, steer: number, spin: number): void {
    const w = this.wheels[index];
    w.steer.position.y = w.restY + travel;
    w.steer.rotation.y = steer;
    w.spin.rotation.x = spin;
  }

  setBodyLean(roll: number, pitch: number): void {
    this.body.rotation.z = roll;
    this.body.rotation.x = pitch + this.rake;
  }

  setBraking(on: boolean): void {
    this.braking = on;
  }

  setLights(on: boolean): void {
    this.lightsOn = on;
  }

  update(dt: number): void {
    const target = this.braking ? 8 : this.lightsOn ? 2.6 : 0.12;
    this.tailLevel.value += (target - this.tailLevel.value) * (1 - Math.exp(-dt * (this.braking ? 30 : 8)));
  }
}
