import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mix, uniform, vec3 } from 'three/tsl';
import { createPaintMaterial, PAINTS, SECONDARY, type PaintMaterial, type PaintPreset } from './paint';
import { createCarbonMaterial } from './carbon';
import { DashDisplay } from './dash';
import { DriverArms } from './driverArms.ts';
import { makePlateTexture } from './plate';
import { buildKit } from './kit.ts';
import { CAR_BASES, CAR_MODELS, warpOf, type CarModel } from './models.ts';
import type { Warp } from './warp.ts';
import type { CarLook } from './looks.ts';

export interface ColorOption {
  id: string;
  name: string;
  color: string;
  roughness?: number;
}

export const RIMS: ColorOption[] = [
  { id: 'black', name: '亮黑', color: '#0c0c0d', roughness: 0.3 },
  { id: 'gunmetal', name: '枪灰', color: '#3c3f45', roughness: 0.3 },
  { id: 'silver', name: '银色', color: '#c9cdd3', roughness: 0.2 },
  { id: 'bronze', name: '古铜', color: '#a06a2a', roughness: 0.3 },
];

export const CALIPERS: ColorOption[] = [
  { id: 'red', name: '红', color: '#d40a14' },
  { id: 'yellow', name: '黄', color: '#ffd500' },
  { id: 'cyan', name: '青', color: '#00c4f2' },
  { id: 'green', name: '绿', color: '#4be000' },
  { id: 'orange', name: '橙', color: '#ff6a00' },
];

interface Wheel {
  steer: THREE.Object3D;
  spin: THREE.Object3D;
  front: boolean;
  /** 轮心的静止高度（相对整车根节点） */
  restY: number;
  /** 在原型车上的位置 */
  rest: THREE.Vector3;
}

/** 一块会跟着车型变形的网格：记着它在原型车上的样子 */
interface Morph {
  mesh: THREE.Mesh;
  /** 网格自己的坐标 → 整车坐标，以及反过来 */
  toCar: THREE.Matrix4;
  toLocal: THREE.Matrix4;
  pos: Float32Array;
  nor: Float32Array;
}

type StdMat = THREE.MeshStandardMaterial;

/**
 * 主角车。负责加载模型、把各部件换成游戏内材质，
 * 并提供后续阶段要用的接口：车轮转向/滚动、车灯、车身节点、特效挂点。
 */
/**
 * 一套车身（一个模型文件）装好之后的全部零件。几台外形完全不同的车各有一套，
 * 换车的时候整套摘下来、换上另一套；车漆、车灯、仪表这些是共用的。
 */
interface Rig {
  base: string;
  /** 模型文件里的整车节点 */
  node: THREE.Object3D;
  body: THREE.Object3D;
  wheels: Wheel[];
  anchors: Map<string, THREE.Object3D>;
  morphs: Morph[];
  anchorRest: Map<THREE.Object3D, THREE.Vector3>;
  pivotRest: { local: THREE.Vector3; car: THREE.Vector3; toParent: THREE.Matrix3 } | null;
  steeringPivot: THREE.Object3D | null;
  rimRadius: number;
  wing: THREE.Object3D | null;
  roofPanel: THREE.Object3D | null;
  secondaryMeshes: THREE.Mesh[];
  accentMeshes: THREE.Mesh[];
  /** 车漆用的烘焙 AO（只有原型车的模型带） */
  paintAO: THREE.Texture | null;
  secondaryAO: THREE.Texture | null;
}

export class Car {
  /** 整车根节点（位置、朝向）。里面装着当前这套车身 */
  readonly root: THREE.Object3D = new THREE.Group();
  /** 车身节点（后续做侧倾、俯仰） */
  body!: THREE.Object3D;
  readonly wheels: Wheel[] = [];
  /** 特效挂点：FX_Exhaust_L/R、FX_Headlight_L/R、FX_Taillight_L/R */
  readonly anchors = new Map<string, THREE.Object3D>();

  readonly paint: PaintMaterial;
  readonly secondary: PaintMaterial;
  /** 副色是否跟随主色 */
  secondaryFollows = false;
  private readonly carbon: THREE.MeshPhysicalNodeMaterial;
  /** 使用副色的面板（车顶、下包围、后视镜壳等），切换碳纤维时整体换材质 */
  private secondaryMeshes: THREE.Mesh[] = [];
  /**
   * 后加的部件（尾翼、车尾饰板）也跟随副色，但它们没有烘焙 AO 用的第二套 UV，
   * 所以单独用一份不带 AO 贴图的材质
   */
  private readonly accent: PaintMaterial;
  private readonly accentCarbon: THREE.MeshPhysicalNodeMaterial;
  private accentMeshes: THREE.Mesh[] = [];
  private wing: THREE.Object3D | null = null;
  private roofPanel: THREE.Object3D | null = null;
  /** 尾翼装没装着 */
  wingOn = true;
  private secondaryMode: 'paint' | 'carbon' = 'paint';
  /** 现在是哪款车 */
  model: CarModel = CAR_MODELS[0];
  private warp: Warp = warpOf(CAR_MODELS[0]);
  private morphs: Morph[] = [];
  /** 特效挂点在原型车上的位置 */
  private anchorRest = new Map<THREE.Object3D, THREE.Vector3>();
  /** 已经装好的几套车身，和现在用的是哪一套 */
  private readonly rigs = new Map<string, Rig>();
  private rig: Rig | null = null;
  /** 方向盘转轴在原型车上的位置（自己的坐标、整车坐标），和把整车坐标里的位移换算回去的矩阵 */
  private pivotRest: { local: THREE.Vector3; car: THREE.Vector3; toParent: THREE.Matrix3 } | null = null;
  /** 当前车型的空气动力套件 */
  private readonly kit = new THREE.Group();
  private readonly kitBlack = new THREE.MeshStandardMaterial({ color: '#070708', roughness: 0.42, metalness: 0.3, name: 'Trim_Black' });
  private rake = 0;

  lightsOn = true;
  /** 试驾模式：车轮和车身姿态交给物理，不再由展厅逻辑控制 */
  driven = false;
  private braking = false;

  private readonly uHead = uniform(9.0);
  private readonly uTail = uniform(2.6);
  private readonly uSignal = uniform(0.9);
  private readonly uBadge = uniform(1.4);
  /** 刹车盘的温度 0–1：重刹之后发红，慢慢冷下来 */
  private readonly uBrakeHeat = uniform(0);
  /**
   * 尾灯颜色。带一点点蓝：ACES 色调映射会把高亮的纯红推向橙色，
   * 大面积的灯带上很明显，加一点蓝正好抵消
   */
  readonly tailColor = uniform(new THREE.Color(1.0, 0.0, 0.03));
  private headTarget = 9.0;
  private tailTarget = 2.6;

  private readonly glass = this.makeGlass();
  private readonly dash = new DashDisplay();
  /** 方向盘的转轴节点（绕本地 Z 轴转，正值 = 驾驶员看到的逆时针 = 向左打） */
  private steeringPivot: THREE.Object3D | null = null;
  /** 方向盘轮圈的半径 */
  private rimRadius = 0.18;
  /** 驾驶员的手臂（只在驾驶室视角里显示） */
  private readonly arms = new DriverArms();
  /** 车内的补光：驾驶室视角下把仪表台、方向盘、手臂照亮，不然车里是一片黑 */
  private readonly cabinLight = new THREE.PointLight(0xfff0e2, 0, 2.6, 1.4);
  private cabinTarget = 0;
  private readonly rimMats = new Set<StdMat>();
  private readonly caliperMats = new Set<StdMat>();
  private steerAngle = 0;
  private steerTarget = 0;

  /**
   * 加载所有车身的模型文件。第一套（原型车）用来建车漆等共用材质。
   * 全部提前装好，之后换车是瞬间的事，不用再等加载。
   */
  static async load(onProgress?: (ratio: number) => void): Promise<Car> {
    const loader = new GLTFLoader();
    const bases = Object.values(CAR_BASES);
    const scenes: THREE.Object3D[] = [];
    for (let i = 0; i < bases.length; i++) {
      const gltf = await loader.loadAsync(bases[i].url, (e) => {
        if (onProgress && e.total > 0) onProgress((i + e.loaded / e.total) / bases.length);
      });
      scenes.push(gltf.scene);
    }
    const car = new Car(scenes[0]);
    for (let i = 1; i < bases.length; i++) car.install(bases[i].id, scenes[i]);
    car.useBase(bases[0].id);
    return car;
  }

  private constructor(scene: THREE.Object3D) {
    this.root.name = 'CarRoot';
    // 取出原材质上的烘焙 AO（第二套 UV），新车漆继续使用
    let paintAO: THREE.Texture | null = null;
    let secondaryAO: THREE.Texture | null = null;
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as StdMat | undefined;
      if (!m) return;
      if (m.name === 'Paint_Primary' && m.aoMap) paintAO = m.aoMap;
      if (m.name === 'Paint_Secondary' && m.aoMap) secondaryAO = m.aoMap;
    });

    this.paint = createPaintMaterial(PAINTS[0], paintAO);
    this.secondary = createPaintMaterial(SECONDARY[0], secondaryAO);
    this.carbon = createCarbonMaterial(secondaryAO);
    this.accent = createPaintMaterial(SECONDARY[0], null);
    this.accentCarbon = createCarbonMaterial(null);

    this.install(CAR_MODELS[0].base, scene, paintAO, secondaryAO);
    this.fitDriver();
  }

  /**
   * 把一个模型文件装成一套车身：换材质、找车轮和挂点、记下变形用的原始形状。
   * 装完先留在车上（调用方接着用，或者再调 useBase 换回别的）。
   */
  private install(base: string, scene: THREE.Object3D, paintAO: THREE.Texture | null = null, secondaryAO: THREE.Texture | null = null): void {
    const node = scene.getObjectByName('Car');
    const body = scene.getObjectByName('Body');
    if (!node || !body) throw new Error(`${base} 的模型缺少 Car / Body 节点`);
    // 车上只留这一套：下面几步都是从根节点往下找零件
    if (this.rig) this.root.remove(this.rig.node);
    this.root.add(node);
    this.body = body;
    this.wheels.length = 0;
    this.anchors.clear();
    this.secondaryMeshes = [];
    this.accentMeshes = [];
    this.morphs = [];
    this.anchorRest = new Map();
    this.pivotRest = null;
    this.steeringPivot = null;
    this.rimRadius = 0.18;

    this.setupMaterials();
    this.setupRig();
    this.setupMorphs();
    this.rig = {
      base,
      node,
      body,
      wheels: [...this.wheels],
      anchors: new Map(this.anchors),
      morphs: this.morphs,
      anchorRest: this.anchorRest,
      pivotRest: this.pivotRest,
      steeringPivot: this.steeringPivot,
      rimRadius: this.rimRadius,
      wing: this.wing,
      roofPanel: this.roofPanel,
      secondaryMeshes: this.secondaryMeshes,
      accentMeshes: this.accentMeshes,
      paintAO,
      secondaryAO,
    };
    this.rigs.set(base, this.rig);
  }

  /** 换上另一套车身（必须是已经装好的） */
  private useBase(base: string): void {
    const rig = this.rigs.get(base);
    if (!rig || rig === this.rig) return;
    if (this.rig) this.root.remove(this.rig.node);
    this.rig = rig;
    this.root.add(rig.node);
    this.body = rig.body;
    this.wheels.length = 0;
    this.wheels.push(...rig.wheels);
    this.anchors.clear();
    for (const [k, v] of rig.anchors) this.anchors.set(k, v);
    this.morphs = rig.morphs;
    this.anchorRest = rig.anchorRest;
    this.pivotRest = rig.pivotRest;
    this.steeringPivot = rig.steeringPivot;
    this.rimRadius = rig.rimRadius;
    this.wing = rig.wing;
    this.roofPanel = rig.roofPanel;
    this.secondaryMeshes = rig.secondaryMeshes;
    this.accentMeshes = rig.accentMeshes;
    // 烘焙 AO 是按原型车的第二套 UV 画的，别的车身没有：换车时跟着开关
    for (const [m, ao] of [
      [this.paint.material, rig.paintAO],
      [this.secondary.material, rig.secondaryAO],
      [this.carbon, rig.secondaryAO],
    ] as unknown as [THREE.MeshStandardMaterial, THREE.Texture | null][]) {
      if (m.aoMap !== ao) {
        m.aoMap = ao;
        m.needsUpdate = true;
      }
    }
    // 套件、手臂、车内补光跟着挂到新车身上；副色面板按当前的选择（车漆 / 碳纤维）重新上材质
    this.body.add(this.kit);
    if (this.steeringPivot?.parent) {
      this.steeringPivot.parent.add(this.arms.group);
      this.steeringPivot.parent.add(this.cabinLight);
    }
    const carbon = this.secondaryMode === 'carbon';
    for (const mesh of this.secondaryMeshes) mesh.material = carbon ? this.carbon : this.secondary.material;
    for (const mesh of this.accentMeshes) mesh.material = carbon ? this.accentCarbon : this.accent.material;
  }

  /* ---------------------------- 材质 ---------------------------- */

  /** 节点材质只有自带 envMap 时才读自己的 envMapIntensity，所以需要单独强度的材质在这里指定 */
  setEnvironment(env: THREE.Texture): void {
    this.glass.envMap = env;
    this.glass.envMapIntensity = 1.3;
    this.glass.needsUpdate = true;
  }

  /**
   * 给整车所有材质指定一个环境光节点（实时反射探针），传 null 恢复成跟随场景的环境贴图。
   * 试驾时用探针，回车库时恢复。
   */
  setEnvNode(node: THREE.Node | null): void {
    const seen = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        // 只有基于物理的材质才吃环境反射；车灯、仪表这些自发光材质不动
        const nm = m as THREE.MeshStandardNodeMaterial;
        if (seen.has(m) || !nm.isMeshStandardNodeMaterial) continue;
        seen.add(m);
        if (nm.envNode === node) continue;
        nm.envNode = node;
        nm.needsUpdate = true;
      }
    });
  }

  private setupMaterials(): void {
    const glass = this.glass;
    const head = this.makeLight(new THREE.Color(0.78, 0.88, 1.0), this.uHead);
    const tail = this.makeLight(this.tailColor, this.uTail);
    const signal = this.makeLight(new THREE.Color(1.0, 0.38, 0.0), this.uSignal);
    const badge = this.makeLight(this.tailColor, this.uBadge);
    const plateTex = makePlateTexture();
    const done = new Set<THREE.Material>();

    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 内饰不投影：它们在车壳里面，影子本来就被车壳的影子盖住，却要在每级阴影里多画几十次
      mesh.castShadow = !mesh.name.startsWith('Interior');
      mesh.receiveShadow = true;
      const m = mesh.material as StdMat;
      // 记下这块网格原本是什么部件：对手的车要按部件把网格合并成几大块（见 race/RivalCar.ts）
      mesh.userData.part = m.name;
      // 别的车身没有原型车那套烘焙 AO 用的第二套 UV，材质上带着的 AO 贴图要摘掉
      if (!mesh.geometry.attributes.uv1 && m.aoMap) {
        m.aoMap = null;
        m.needsUpdate = true;
      }

      switch (m.name) {
        case 'Paint_Primary':
          mesh.material = this.paint.material;
          return;
        case 'Paint_Secondary':
          mesh.material = this.secondary.material;
          this.secondaryMeshes.push(mesh);
          return;
        case 'Paint_Accent':
          mesh.material = this.accent.material;
          this.accentMeshes.push(mesh);
          return;
        case 'Light_TailBar':
          // 贯穿式尾灯带和雨灯：和原有尾灯同步亮灭、同步刹车加亮
          mesh.material = tail;
          mesh.castShadow = false;
          return;
        case 'Light_TailBadge':
          // 发光字标：比灯带暗一档
          mesh.material = badge;
          mesh.castShadow = false;
          return;
        case 'Glass':
          mesh.material = glass;
          mesh.castShadow = false;
          mesh.renderOrder = 3;
          return;
        case 'Light_Head':
          mesh.material = head;
          mesh.castShadow = false;
          return;
        case 'Light_Tail':
          mesh.material = tail;
          mesh.castShadow = false;
          return;
        case 'Light_Signal':
          mesh.material = signal;
          mesh.castShadow = false;
          return;
      }

      if (done.has(m)) return;
      done.add(m);

      switch (m.name) {
        case 'Rim_Dark':
          m.metalness = 1;
          this.rimMats.add(m);
          break;
        case 'Rim_Bright':
          // 切削面：拉丝铝，不要镜面铬（镜面会把灯带反射成一片碎光）
          m.color.set('#aeb2b9');
          m.metalness = 1;
          m.roughness = 0.3;
          break;
        case 'Caliper':
          m.metalness = 0.55;
          m.roughness = 0.32;
          this.caliperMats.add(m);
          break;
        case 'BrakeDisc': {
          m.color.set('#6a6d72');
          m.metalness = 0.9;
          m.roughness = 0.55;
          // 烧红：先是暗红，越热越偏橙黄、越亮
          const heat = this.uBrakeHeat;
          m.emissiveNode = mix(vec3(0.9, 0.03, 0.0), vec3(1.0, 0.3, 0.03), heat).mul(heat.mul(heat)).mul(3.2);
          break;
        }
        case 'Tire_Side':
          m.color.set('#0d0d0e');
          m.roughness = 0.72;
          break;
        case 'Tire_Tread':
          m.color.set('#0a0a0b');
          m.roughness = 0.82;
          break;
        case 'Trim_Black':
          m.color.set('#060607');
          m.roughness = 0.58;
          break;
        case 'Exhaust_Tip':
          m.color.set('#b9bcc6');
          m.roughness = 0.16;
          break;
        case 'Dashboard':
          // 仪表屏换成实时绘制的画布
          m.emissiveMap = this.dash.texture;
          m.emissive.set('#ffffff');
          m.emissiveIntensity = 1.5;
          m.needsUpdate = true;
          break;
        case 'LicensePlate':
          m.map = plateTex;
          m.color.set('#ffffff');
          m.roughness = 0.45;
          m.needsUpdate = true;
          break;
      }
    });

    this.setRim(RIMS[0]);
    this.setCaliper(CALIPERS[0]);
  }

  /**
   * 车窗玻璃：深色隐私玻璃。
   * 用"预乘"式混合（源 ×1 + 背景 ×(1-α)），反射保持全强度，α 只负责压暗车内。
   */
  private makeGlass(): THREE.MeshPhysicalNodeMaterial {
    const g = new THREE.MeshPhysicalNodeMaterial();
    g.name = 'CarGlass';
    g.color.set('#020304');
    g.metalness = 0;
    g.roughness = 0.045;
    g.ior = 1.75;
    g.transparent = true;
    g.opacity = 0.68;
    g.depthWrite = false;
    g.side = THREE.FrontSide;
    g.blending = THREE.CustomBlending;
    g.blendEquation = THREE.AddEquation;
    g.blendSrc = THREE.OneFactor;
    g.blendDst = THREE.OneMinusSrcAlphaFactor;
    return g;
  }

  private makeLight(c: THREE.Color | ReturnType<typeof uniform>, intensity: ReturnType<typeof uniform>): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const color: any = c instanceof THREE.Color ? vec3(c.r, c.g, c.b) : c;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m.colorNode = color.mul(intensity as any);
    m.fog = false;
    return m;
  }

  /* ---------------------------- 骨架 ---------------------------- */

  private setupRig(): void {
    for (const tag of ['FL', 'FR', 'RL', 'RR']) {
      const steer = this.root.getObjectByName(`Wheel_${tag}`);
      const spin = this.root.getObjectByName(`Wheel_${tag}_Spin`);
      if (!steer || !spin) throw new Error(`car.glb 缺少车轮节点 Wheel_${tag}`);
      this.wheels.push({ steer, spin, front: tag[0] === 'F', restY: steer.position.y, rest: steer.position.clone() });
    }
    this.root.traverse((o) => {
      if (o.name.startsWith('FX_') || o.name.startsWith('Cam_')) this.anchors.set(o.name, o);
    });
    this.wing = this.root.getObjectByName('BodyWing') ?? null;
    this.roofPanel = this.root.getObjectByName('BodyRoofPanel') ?? null;
    this.setupSteeringWheel();
  }

  /* ---------------------------- 车型 ---------------------------- */

  /**
   * 记下车身每一块网格在原型车上的样子，换车型的时候从它出发重新算。
   * 车轮不在这里（车轮是整个挪位置、放大缩小，不变形）；方向盘也不变形，只跟着座舱平移。
   */
  private setupMorphs(): void {
    this.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const rigid = new Set<THREE.Object3D>();
    this.steeringPivot?.traverse((o) => rigid.add(o));
    const seen = new Set<THREE.BufferGeometry>();
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || rigid.has(mesh)) return;
      // 两块网格共用一份几何数据的话，各自拿一份：它们在车上的位置不同，变形结果也不同
      if (seen.has(mesh.geometry)) mesh.geometry = mesh.geometry.clone();
      seen.add(mesh.geometry);
      const g = mesh.geometry;
      const p = g.attributes.position;
      const n = g.attributes.normal;
      if (!p || !n) return;
      const pos = new Float32Array(p.count * 3);
      const nor = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        pos[i * 3] = p.getX(i);
        pos[i * 3 + 1] = p.getY(i);
        pos[i * 3 + 2] = p.getZ(i);
        nor[i * 3] = n.getX(i);
        nor[i * 3 + 1] = n.getY(i);
        nor[i * 3 + 2] = n.getZ(i);
      }
      // 换成自己的缓冲区（模型文件里位置和法线可能挤在同一块内存里，不方便改写）
      g.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor.slice(), 3));
      const toCar = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
      this.morphs.push({ mesh, toCar, toLocal: toCar.clone().invert(), pos, nor });
    });
    for (const a of this.anchors.values()) this.anchorRest.set(a, a.position.clone());
    const pivot = this.steeringPivot;
    if (pivot?.parent) {
      const parentToCar = new THREE.Matrix4().multiplyMatrices(rootInv, pivot.parent.matrixWorld);
      this.pivotRest = {
        local: pivot.position.clone(),
        car: pivot.position.clone().applyMatrix4(parentToCar),
        toParent: new THREE.Matrix3().setFromMatrix4(parentToCar).invert(),
      };
    }
    this.kit.name = 'Kit';
    this.body.add(this.kit);
  }

  /**
   * 换车型：车身按新比例变形，车轮挪到新的位置、换大小，装上这款车的空气动力套件。
   * 外观选项（车漆、轮毂……）保持不变。
   */
  setModel(model: CarModel): void {
    this.useBase(model.base);
    const warp = warpOf(model);
    this.model = model;
    this.warp = warp;
    const shape = model.shape;

    /* 车身 */
    const E = 1e-3;
    const a = new THREE.Vector3();
    const jx = new THREE.Vector3();
    const jy = new THREE.Vector3();
    const jz = new THREE.Vector3();
    const n = new THREE.Vector3();
    const c = new THREE.Vector3();
    const normalToCar = new THREE.Matrix3();
    const normalToLocal = new THREE.Matrix3();
    for (const m of this.morphs) {
      const g = m.mesh.geometry;
      const pos = g.attributes.position.array as Float32Array;
      const nor = g.attributes.normal.array as Float32Array;
      if (warp.identity) {
        pos.set(m.pos);
        nor.set(m.nor);
      } else {
        normalToCar.getNormalMatrix(m.toCar);
        // 法线从整车坐标变回网格坐标，用的是"网格→整车"矩阵的转置
        normalToLocal.setFromMatrix4(m.toCar).transpose();
        for (let i = 0; i < m.pos.length; i += 3) {
          a.set(m.pos[i], m.pos[i + 1], m.pos[i + 2]).applyMatrix4(m.toCar);
          warp.apply(a.x, a.y, a.z);
          const x = warp.x;
          const y = warp.y;
          const z = warp.z;
          // 法线：变形在这一点附近把空间怎么拉扯了（三个方向各挪一点点看结果），法线按它的"逆转置"变
          warp.apply(a.x + E, a.y, a.z);
          jx.set(warp.x - x, warp.y - y, warp.z - z);
          warp.apply(a.x, a.y + E, a.z);
          jy.set(warp.x - x, warp.y - y, warp.z - z);
          warp.apply(a.x, a.y, a.z + E);
          jz.set(warp.x - x, warp.y - y, warp.z - z);
          n.set(m.nor[i], m.nor[i + 1], m.nor[i + 2]).applyMatrix3(normalToCar);
          const nx = n.x;
          const ny = n.y;
          const nz = n.z;
          n.set(0, 0, 0);
          n.addScaledVector(c.crossVectors(jy, jz), nx);
          n.addScaledVector(c.crossVectors(jz, jx), ny);
          n.addScaledVector(c.crossVectors(jx, jy), nz);
          n.applyMatrix3(normalToLocal).normalize();
          nor[i] = n.x;
          nor[i + 1] = n.y;
          nor[i + 2] = n.z;
          a.set(x, y, z).applyMatrix4(m.toLocal);
          pos[i] = a.x;
          pos[i + 1] = a.y;
          pos[i + 2] = a.z;
        }
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.normal.needsUpdate = true;
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }

    /* 方向盘：整个跟着座舱挪 */
    if (this.steeringPivot && this.pivotRest) {
      const r = this.pivotRest;
      warp.apply(r.car.x, r.car.y, r.car.z);
      a.set(warp.x - r.car.x, warp.y - r.car.y, warp.z - r.car.z).applyMatrix3(r.toParent);
      this.steeringPivot.position.copy(r.local).add(a);
    }

    /* 特效挂点（排气口、车灯） */
    for (const [node, rest] of this.anchorRest) {
      warp.apply(rest.x, rest.y, rest.z);
      node.position.set(warp.x, warp.y, warp.z);
    }

    /* 车身高度和前倾 */
    this.body.position.y = shape.ride;
    this.rake = shape.rake;
    this.body.rotation.x = this.rake;
    this.fitDriver();

    /* 车轮 */
    for (const w of this.wheels) {
      const scale = w.front ? shape.wheelFront : shape.wheelRear;
      w.restY = w.rest.y * scale;
      w.steer.position.set(w.rest.x * warp.widthAt(w.rest.y, w.rest.z), w.restY, warp.mapZ(w.rest.z));
      w.steer.scale.set(w.front ? shape.tireFront : shape.tireRear, scale, scale);
    }

    /* 空气动力套件 */
    for (const child of [...this.kit.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      const k = this.accentMeshes.indexOf(mesh);
      if (k >= 0) this.accentMeshes.splice(k, 1);
      this.kit.remove(mesh);
    }
    for (const part of buildKit(model.kit, warp)) {
      const accent = part.role === 'accent';
      const mesh = new THREE.Mesh(part.geometry, accent ? (this.secondaryMode === 'carbon' ? this.accentCarbon : this.accent.material) : this.kitBlack);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.part = accent ? 'Paint_Accent' : 'Trim_Black';
      mesh.userData.wing = part.wing;
      if (accent) this.accentMeshes.push(mesh);
      this.kit.add(mesh);
    }
    if (this.roofPanel) this.roofPanel.visible = !model.kit.openTop;
    this.setWing(this.wingOn);
  }

  /** 原型车上的一个位置（整车坐标），在当前车型上跑到哪儿去了。镜头的机位、特效的位置用它换算 */
  /**
   * 镜头的机位（整车坐标）：驾驶员的眼睛、车头机位。
   * 单独建模的车在模型里用空节点标好了；原型车没有，用固定的位置按车型换算。
   */
  cameraPoint(kind: 'cockpit' | 'hood', out: THREE.Vector3): THREE.Vector3 {
    const node = this.anchors.get(kind === 'cockpit' ? 'Cam_Cockpit' : 'Cam_Hood');
    if (node) return out.copy(node.position).setY(node.position.y + this.model.shape.ride);
    return this.mapPoint(kind === 'cockpit' ? out.set(0, 1.0, 0.5) : out.set(0, 0.93, 1.62));
  }

  mapPoint(p: THREE.Vector3): THREE.Vector3 {
    this.warp.apply(p.x, p.y, p.z);
    return p.set(this.warp.x, this.warp.y + this.model.shape.ride, this.warp.z);
  }

  /**
   * 给方向盘建一个转轴。模型里方向盘节点的原点和朝向都不在转轴上，
   * 所以用轮圈的顶点拟合出它所在的平面：平面中心就是转轴位置，平面法线就是转轴方向。
   */
  private setupSteeringWheel(): void {
    const column = this.root.getObjectByName('InteriorSteeringCylinder');
    const rim = this.root.getObjectByName('InteriorSteeringWheel01') as THREE.Mesh | undefined;
    if (!column || !rim || !rim.isMesh || !column.parent) return;
    this.root.updateMatrixWorld(true);

    const pos = rim.geometry.attributes.position;
    const pts: THREE.Vector3[] = [];
    const center = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(rim.matrixWorld);
      pts.push(v);
      center.add(v);
    }
    center.multiplyScalar(1 / pts.length);

    // 协方差矩阵最小特征值对应的方向就是平面法线（反幂迭代）
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const v of pts) {
      const dx = v.x - center.x, dy = v.y - center.y, dz = v.z - center.z;
      xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }
    const inv = new THREE.Matrix3().set(xx, xy, xz, xy, yy, yz, xz, yz, zz).invert();
    const axis = new THREE.Vector3(0.1, 0.4, -0.9).normalize();
    for (let i = 0; i < 40; i++) axis.applyMatrix3(inv).normalize();

    // 转轴指向驾驶员一侧（车尾方向）
    const back = new THREE.Vector3(0, 0, -1).transformDirection(this.root.matrixWorld);
    if (axis.dot(back) < 0) axis.negate();

    // 轮圈半径：所有顶点到中心的平均距离（只算落在方向盘平面里的那部分）
    let sum = 0;
    for (const v of pts) {
      const dx = v.x - center.x, dy = v.y - center.y, dz = v.z - center.z;
      const along = dx * axis.x + dy * axis.y + dz * axis.z;
      sum += Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
    }
    this.rimRadius = sum / pts.length;

    const pivot = new THREE.Object3D();
    pivot.name = 'SteeringPivot';
    pivot.position.copy(center);
    pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    column.parent.attach(pivot); // 保持世界坐标不变地挂到车身下
    pivot.attach(column);
    this.steeringPivot = pivot;
    pivot.parent!.add(this.arms.group);
    pivot.parent!.add(this.cabinLight);
  }

  /**
   * 按当前车型的座舱摆好驾驶员的肩膀和双手，以及车内补光的位置。
   * 车型一换（座舱跟着挪了）就要重新摆一次
   */
  private fitDriver(): void {
    const pivot = this.steeringPivot;
    if (!pivot?.parent) return;
    this.root.updateMatrixWorld(true);
    const toParent = new THREE.Matrix4().copy(pivot.parent.matrixWorld).invert().multiply(this.root.matrixWorld);
    const eye = this.cameraPoint('cockpit', new THREE.Vector3()).applyMatrix4(toParent);
    const left = new THREE.Vector3(1, 0, 0).transformDirection(toParent);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(toParent);
    // 握点是按"方向盘回正时"的朝向定的
    const angle = pivot.rotation.z;
    pivot.rotation.z = 0;
    this.arms.fit(eye, left, up, pivot.quaternion);
    pivot.rotation.z = angle;
    // 补光在眼睛前上方一点：照亮仪表台和手，自己不在画面里
    this.cabinLight.position.copy(eye).addScaledVector(up, 0.16).addScaledVector(new THREE.Vector3().crossVectors(left, up), 0.12);
    this.arms.update(pivot.position, pivot.quaternion, this.rimRadius);
  }

  /**
   * 驾驶室视角开关：显示手臂、打开车内补光。
   * @param night 0 白天，1 夜晚。白天外面亮，车里要补得多一些才不显得黑
   */
  setCockpit(on: boolean, night = 0): void {
    this.arms.group.visible = on;
    this.cabinTarget = on ? 1.6 - 1.05 * night : 0;
  }

  /** 方向盘转角（弧度，正值向左打） */
  setSteeringWheel(angle: number): void {
    if (!this.steeringPivot) return;
    this.steeringPivot.rotation.z = angle;
    this.arms.update(this.steeringPivot.position, this.steeringPivot.quaternion, this.rimRadius, angle);
  }

  /** 刷新仪表屏 */
  setDash(kmh: number, gear: string, rpm: number, nitro: number): void {
    this.dash.draw(kmh, gear, rpm, nitro);
  }

  /** 前轮转向角（弧度，正值向左打） */
  setSteer(angle: number, immediate = false): void {
    this.steerTarget = angle;
    if (immediate) this.steerAngle = angle;
  }

  /** 四轮滚动（弧度增量，正值向前滚） */
  spinWheels(delta: number): void {
    for (const w of this.wheels) w.spin.rotation.x += delta;
  }

  /* ---------------------------- 试驾模式的姿态接口 ---------------------------- */

  /**
   * 由物理驱动单个车轮：index 顺序为 左前、右前、左后、右后。
   * travel 是悬挂相对静止位置的位移（米，向上为正），steer 是转向角，spin 是累计滚动角。
   */
  setWheelPose(index: number, travel: number, steer: number, spin: number): void {
    const w = this.wheels[index];
    w.steer.position.y = w.restY + travel;
    w.steer.rotation.y = steer;
    w.spin.rotation.x = spin;
  }

  /** 车身相对底盘的额外侧倾 / 俯仰（弧度）。roll 正值向右倾，pitch 正值车头下沉 */
  setBodyLean(roll: number, pitch: number): void {
    this.body.rotation.z = roll;
    this.body.rotation.x = pitch + this.rake;
  }

  setBraking(on: boolean): void {
    this.braking = on;
  }

  /** 回到展厅姿态：车轮归位、车身摆正 */
  resetPose(): void {
    this.driven = false;
    this.braking = false;
    for (const w of this.wheels) {
      w.steer.position.y = w.restY;
      w.spin.rotation.x = 0;
    }
    this.setBodyLean(0, 0);
    this.setDash(0, 'P', 0.12, 1);
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
  }

  /* ---------------------------- 外观 ---------------------------- */

  /**
   * 一次换上整套外观（换车时用）。
   * @param immediate 不走颜色过渡，直接换好：新车一出现就是它自己的颜色
   */
  applyLook(look: CarLook, immediate = false): void {
    const paint = PAINTS.find((p) => p.id === look.paint) ?? PAINTS[0];
    this.setPaint(paint, immediate);
    const second = SECONDARY.find((s) => s.id === look.secondary);
    this.setSecondary(look.secondary === 'carbon' ? 'carbon' : look.secondary === 'follow' ? 'follow' : (second ?? SECONDARY[0]), immediate);
    this.setRim(RIMS.find((r) => r.id === look.rim) ?? RIMS[0]);
    this.setCaliper(CALIPERS.find((c) => c.id === look.caliper) ?? CALIPERS[0]);
    this.setWing(look.wing);
  }

  /** 这款车有没有能装能拆的尾翼 */
  get hasWing(): boolean {
    if (this.wing && this.model.kit.wing === 'stock') return true;
    return this.kit.children.some((c) => c.userData.wing);
  }

  setPaint(p: PaintPreset, immediate = false): void {
    this.paint.apply(p, immediate);
    if (this.secondaryFollows) {
      this.secondary.apply(p, immediate);
      this.accent.apply(p, immediate);
    }
  }

  setSecondary(p: PaintPreset | 'follow' | 'carbon', immediate = false): void {
    const mat = p === 'carbon' ? this.carbon : this.secondary.material;
    for (const mesh of this.secondaryMeshes) mesh.material = mat;
    const accentMat = p === 'carbon' ? this.accentCarbon : this.accent.material;
    for (const mesh of this.accentMeshes) mesh.material = accentMat;
    this.secondaryMode = p === 'carbon' ? 'carbon' : 'paint';
    if (p === 'carbon') {
      this.secondaryFollows = false;
    } else if (p === 'follow') {
      this.secondaryFollows = true;
      this.secondary.apply(this.paint.current, immediate);
      this.accent.apply(this.paint.current, immediate);
    } else {
      this.secondaryFollows = false;
      this.secondary.apply(p, immediate);
      this.accent.apply(p, immediate);
    }
  }

  setRim(o: ColorOption): void {
    for (const m of this.rimMats) {
      m.color.set(o.color);
      m.roughness = o.roughness ?? 0.3;
    }
  }

  /** 显示 / 隐藏尾翼 */
  setWing(visible: boolean): void {
    this.wingOn = visible;
    // 原型车自带的鸭尾只在这款车用它的时候才显示；其他车型的尾翼在套件里
    if (this.wing) this.wing.visible = visible && this.model.kit.wing === 'stock';
    for (const part of this.kit.children) if (part.userData.wing) part.visible = visible;
  }

  /** 刹车盘温度 0–1 */
  setBrakeHeat(heat: number): void {
    this.uBrakeHeat.value = heat;
  }

  setCaliper(o: ColorOption): void {
    for (const m of this.caliperMats) m.color.set(o.color);
  }

  setLights(on: boolean): void {
    this.lightsOn = on;
    this.headTarget = on ? 9.0 : 0.06;
    this.tailTarget = on ? 2.6 : 0.12;
  }

  update(dt: number): void {
    this.paint.update(dt);
    this.secondary.update(dt);
    this.accent.update(dt);

    const k = 1 - Math.exp(-dt * 8);
    this.uHead.value += (this.headTarget - this.uHead.value) * k;
    // 刹车灯：踩刹车时比示廓灯亮得多，而且亮灭要快
    const tail = this.braking ? 8 : this.tailTarget;
    this.uTail.value += (tail - this.uTail.value) * (this.braking ? 1 - Math.exp(-dt * 30) : k);
    this.uBadge.value = this.uTail.value * 0.45;
    this.cabinLight.intensity += (this.cabinTarget - this.cabinLight.intensity) * (1 - Math.exp(-dt * 6));

    if (this.driven) return; // 试驾模式下车轮由物理驱动
    this.steerAngle += (this.steerTarget - this.steerAngle) * (1 - Math.exp(-dt * 5));
    for (const w of this.wheels) if (w.front) w.steer.rotation.y = this.steerAngle;
    this.setSteeringWheel(this.steerAngle * 6);
  }
}
