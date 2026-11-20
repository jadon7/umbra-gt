import { DEFAULT_CONFIG, type VehicleConfig } from '../drive/VehicleConfig.ts';
import { BASE, BASE_SHAPE, Warp, type CarShape } from './warp.ts';

/** 车上加装的空气动力套件：每一项是"装不装"或者装哪一种 */
export interface CarKit {
  /** 尾翼：stock = 原型车自带的鸭尾；gt = 高位大尾翼；low = 贴着车尾的长条低尾翼；none = 不装 */
  wing: 'stock' | 'gt' | 'low' | 'none';
  /** 前铲（车头下沿伸出来的一块板，两端带立板） */
  splitter: boolean;
  /** 车头两角的小翼片 */
  canards: boolean;
  /** 车顶进气口 */
  scoop: boolean;
  /** 发动机盖中线上的鲨鱼鳍 */
  fin: boolean;
  /** 侧裙 */
  skirts: boolean;
  /** 车尾底部的导流片 */
  strakes: boolean;
  /** 敞篷：拆掉车顶板 */
  openTop: boolean;
}

/** 车库里显示的四项能力，0–10 */
export interface CarStats {
  speed: number;
  accel: number;
  grip: number;
  drift: number;
}

/**
 * 一套车身：一个模型文件，加上这台车本来的物理调校。
 * 「gt」是原型车（下面五款变体共用它的车身）；其余每台都是单独建的模型，外形完全不同。
 */
export interface CarBase {
  id: string;
  /** 车库里选车身的按钮上写的名字 */
  name: string;
  /** 是什么车（一句话） */
  kind: string;
  url: string;
  /** 车长、车高（米） */
  length: number;
  height: number;
  /** 这台车的调校（原型车就是 DEFAULT_CONFIG） */
  config: VehicleConfig;
}

export interface CarModel {
  id: string;
  /** 用哪一套车身 */
  base: string;
  /** 型号，例如 GT、RS */
  name: string;
  /** 一句话定位 */
  tagline: string;
  /** 两三句介绍 */
  blurb: string;
  shape: CarShape;
  kit: CarKit;
  stats: CarStats;
  /** 在原型车调校上改哪些参数 */
  tune: Partial<VehicleConfig>;
  /** 发动机扭矩倍率 */
  torque: number;
}

const NO_KIT: CarKit = { wing: 'stock', splitter: false, canards: false, scoop: false, fin: false, skirts: false, strakes: false, openTop: false };
const D = DEFAULT_CONFIG;

/** 按质量和车长估算转动惯量（相对原型车） */
function inertiaFor(mass: number, length: number): [number, number, number] {
  const m = mass / D.mass;
  const l = length / (BASE.nose - BASE.tail);
  return [D.inertia[0] * m * l * l, D.inertia[1] * m * l * l, D.inertia[2] * m];
}
const scaleTorque = (k: number) => D.torqueCurve.map(([rpm, t]) => [rpm, t * k] as [number, number]);
/** 四个轮子的位置：前轮距、后轮距（半宽）、前后轴的位置、轮心高度 */
const wheelsAt = (xf: number, xr: number, zf: number, zr: number, y: number): [number, number, number][] => [
  [xf, y, zf],
  [-xf, y, zf],
  [xr, y, zr],
  [-xr, y, zr],
];

/**
 * BRUTE：前置大排量的美式肌肉车。又长又重，扭矩大得多，尾巴轻、很容易甩；弯里抓地比原型车差一截。
 */
const BRUTE: VehicleConfig = {
  ...D,
  mass: 1780,
  com: [0, 0.42, 0.1],
  inertia: inertiaFor(1780, 4.91),
  bodyCenter: [0, 0.64, 0.0],
  bodyHalf: [0.98, 0.37, 2.42],
  wheelPos: wheelsAt(0.83, 0.835, 1.5, -1.44, 0.382),
  wheelRadius: 0.382,
  suspFreqFront: 2.0,
  suspFreqRear: 1.9,
  muLatFront: 1.42,
  muLatRear: 1.6,
  muLong: 1.5,
  steerRate: 4.4,
  torqueCurve: scaleTorque(1.38),
  redline: 7400,
  shiftUpRpm: 6900,
  finalDrive: 3.3,
  brakeForce: 21500,
  drag: 0.52,
  downforce: 0.75,
  nitroForce: 12500,
  driftAngleHold: 0.56,
  driftAngleMax: 0.95,
  driftScrub: 1.0,
};

/**
 * RONIN：两厢掀背小钢炮。短、轻、四驱，转向灵、弯里稳；车轮小、风阻大，直线末端吃亏。
 */
const RONIN: VehicleConfig = {
  ...D,
  mass: 1290,
  com: [0, 0.4, 0.05],
  inertia: inertiaFor(1290, 4.07),
  bodyCenter: [0, 0.7, 0.0],
  bodyHalf: [0.93, 0.43, 2.0],
  wheelPos: wheelsAt(0.79, 0.79, 1.27, -1.33, 0.335),
  wheelRadius: 0.335,
  suspFreqFront: 2.5,
  suspFreqRear: 2.4,
  muLatFront: 1.64,
  muLatRear: 1.84,
  muLong: 1.62,
  steerMax: 0.6,
  steerRate: 6.0,
  driveSplitFront: 0.38,
  torqueCurve: scaleTorque(0.86),
  finalDrive: 3.7,
  brakeForce: 20000,
  drag: 0.5,
  downforce: 1.25,
  nitroForce: 9200,
  yawAssist: 3.4,
  driftAngleHold: 0.44,
  driftAngleMax: 0.8,
};

/**
 * NOMAD：越野皮卡。比原型车重一半多，轮子大一圈，底盘离地半米，悬挂又长又软：
 * 飞跳、压路肩都稳，撞上别的车吃亏的是对方；加速慢、极速低、弯里要早刹车。
 */
const NOMAD: VehicleConfig = {
  ...D,
  mass: 2250,
  com: [0, 0.78, 0.05],
  inertia: inertiaFor(2250, 5.27),
  bodyCenter: [0, 1.14, 0.0],
  bodyHalf: [1.0, 0.5, 2.6],
  wheelPos: wheelsAt(0.9, 0.9, 1.62, -1.66, 0.47),
  wheelRadius: 0.47,
  suspBump: 0.2,
  suspDroop: 0.24,
  suspFreqFront: 1.55,
  suspFreqRear: 1.5,
  suspDampBump: 0.5,
  suspDampRebound: 0.78,
  muLatFront: 1.32,
  muLatRear: 1.52,
  muLong: 1.5,
  forceHeight: 0.62,
  steerMax: 0.56,
  steerRate: 4.0,
  driveSplitFront: 0.45,
  torqueCurve: scaleTorque(1.22),
  // 轮子大了，传动比跟着加大，各挡的车速范围才和别的车差不多
  finalDrive: 4.35,
  brakeForce: 27000,
  handbrakeForce: 12000,
  drag: 0.78,
  downforce: 0.4,
  rollingResistance: 320,
  nitroForce: 14500,
  driftAngleHold: 0.5,
  driftAngleMax: 0.85,
  airStabilize: 5.5,
};

/** 所有车身。第一套必须是原型车 */
export const CAR_BASES: Record<string, CarBase> = {
  gt: { id: 'gt', name: 'UMBRA', kind: '中置概念跑车', url: '/models/car.glb', length: BASE.nose - BASE.tail, height: 1.15, config: D },
  brute: { id: 'brute', name: 'BRUTE', kind: '美式肌肉车', url: '/models/brute.glb', length: 4.91, height: 1.33, config: BRUTE },
  ronin: { id: 'ronin', name: 'RONIN', kind: '掀背小钢炮', url: '/models/ronin.glb', length: 4.07, height: 1.45, config: RONIN },
  nomad: { id: 'nomad', name: 'NOMAD', kind: '越野皮卡', url: '/models/nomad.glb', length: 5.27, height: 1.9, config: NOMAD },
};

/**
 * 可选的车型。五款车是同一个平台（同一个车身模型）上的五种取向：
 * 比例、空气动力套件、车轮和调校不同。车身比例的差别见 warp.ts，套件见 kit.ts。
 */
export const CAR_MODELS: CarModel[] = [
  {
    id: 'gt',
    base: 'gt',
    name: 'GT',
    tagline: '原型 · 均衡',
    blurb: '中置后驱的原型车。各项都不偏科，漂移容易上手。',
    shape: BASE_SHAPE,
    kit: NO_KIT,
    stats: { speed: 7, accel: 7, grip: 7, drift: 7 },
    tune: {},
    torque: 1,
  },
  {
    id: 'rs',
    base: 'gt',
    name: 'RS',
    tagline: '赛道 · 抓地',
    blurb: '宽体、低趴、大尾翼。下压力是原型车的两倍，弯里快得多；风阻大，直线末端吃亏。',
    shape: { ...BASE_SHAPE, flare: 0.055, roof: -0.012, ride: -0.022 },
    kit: { wing: 'gt', splitter: true, canards: true, scoop: true, fin: false, skirts: true, strakes: true, openTop: false },
    stats: { speed: 6, accel: 8, grip: 10, drift: 4 },
    tune: {
      mass: 1370,
      drag: D.drag * 1.13,
      downforce: D.downforce * 2.0,
      muLatFront: D.muLatFront * 1.1,
      muLatRear: D.muLatRear * 1.1,
      muLong: D.muLong * 1.07,
      brakeForce: D.brakeForce * 1.14,
      finalDrive: D.finalDrive * 1.05,
      steerRate: D.steerRate * 1.12,
      driftEnter: 0.25,
      driftRearGrip: 0.86,
      driftScrub: 1.2,
    },
    torque: 1.0,
  },
  {
    id: 'lm',
    base: 'gt',
    name: 'LM',
    tagline: '长尾 · 极速',
    blurb: '车尾加长三十厘米、车顶压低，换来最小的风阻。极速最高，但车身长、转向慢半拍。',
    shape: {
      ...BASE_SHAPE,
      stretch: [
        { z0: BASE.zoneTail[0], z1: BASE.zoneTail[1], add: 0.3 },
        { z0: BASE.zoneNose[0], z1: BASE.zoneNose[1], add: 0.09 },
      ],
      roof: -0.034,
      ride: -0.012,
      width: 1.012,
    },
    kit: { wing: 'low', splitter: false, canards: false, scoop: false, fin: true, skirts: false, strakes: true, openTop: false },
    stats: { speed: 10, accel: 7, grip: 6, drift: 5 },
    tune: {
      mass: 1490,
      drag: D.drag * 0.8,
      downforce: D.downforce * 0.95,
      muLatFront: D.muLatFront * 0.97,
      finalDrive: D.finalDrive * 0.93,
      steerRate: D.steerRate * 0.9,
      nitroForce: D.nitroForce * 1.06,
    },
    torque: 1.08,
  },
  {
    id: 'st',
    base: 'gt',
    name: 'ST',
    tagline: '敞篷 · 漂移',
    blurb: '拆掉车顶、缩短轴距。车尾很活，一点就甩，漂移时氮气回得最快；抓地和极速都让了一步。',
    shape: {
      ...BASE_SHAPE,
      stretch: [{ z0: BASE.zoneDoor[0], z1: BASE.zoneDoor[1], add: -0.1 }],
      width: 0.985,
      ride: 0.008,
    },
    kit: { ...NO_KIT, openTop: true, skirts: true },
    stats: { speed: 6, accel: 7, grip: 6, drift: 10 },
    tune: {
      mass: 1330,
      drag: D.drag * 1.06,
      muLatFront: D.muLatFront * 1.03,
      muLatRear: D.muLatRear * 0.94,
      steerMax: 0.64,
      steerRate: D.steerRate * 1.2,
      driftEnter: 0.16,
      driftRearGrip: 0.75,
      driftAngleHold: 0.5,
      driftAngleMax: 0.95,
      driftScrub: 0.8,
      driftDrive: 0.72,
      kickYaw: 6.6,
      nitroDriftRegen: 0.3,
    },
    torque: 0.95,
  },
  {
    id: 'xr',
    base: 'gt',
    name: 'XR',
    tagline: '直线 · 暴力',
    blurb: '后轮加大加宽、车头压低，马力多出近三成，氮气也更猛。起步和直线没有对手，进弯要早收油。',
    shape: { ...BASE_SHAPE, flareRear: 0.07, rake: 0.013, wheelFront: 0.965, wheelRear: 1.07, tireRear: 1.22, roof: 0.0 },
    kit: { wing: 'stock', splitter: true, canards: false, scoop: true, fin: false, skirts: false, strakes: true, openTop: false },
    stats: { speed: 9, accel: 10, grip: 4, drift: 6 },
    tune: {
      mass: 1560,
      drag: D.drag * 0.97,
      downforce: D.downforce * 0.8,
      muLong: D.muLong * 1.12,
      muLatFront: D.muLatFront * 0.93,
      muLatRear: D.muLatRear * 0.97,
      brakeForce: D.brakeForce * 0.96,
      finalDrive: D.finalDrive * 0.97,
      steerRate: D.steerRate * 0.86,
      nitroForce: D.nitroForce * 1.25,
      nitroDuration: 3.0,
    },
    torque: 1.28,
  },
  {
    id: 'brute',
    base: 'brute',
    name: 'BRUTE',
    tagline: '肌肉车 · 大扭矩',
    blurb: '前置大排量、长车头、溜背。马力比原型车多出近四成，直线和起步凶猛；车重、尾巴轻，一脚油门就横着走。',
    shape: BASE_SHAPE,
    kit: { ...NO_KIT, wing: 'none' },
    stats: { speed: 8, accel: 9, grip: 4, drift: 9 },
    tune: {},
    torque: 1,
  },
  {
    id: 'ronin',
    base: 'ronin',
    name: 'RONIN',
    tagline: '小钢炮 · 灵活',
    blurb: '两厢掀背、四驱。比原型车短半米、轻一百多公斤，转向快、弯里稳，连续弯和回头弯是它的主场；直线拼不过大排量。',
    shape: BASE_SHAPE,
    kit: { ...NO_KIT, wing: 'none' },
    stats: { speed: 5, accel: 7, grip: 9, drift: 5 },
    tune: {},
    torque: 1,
  },
  {
    id: 'nomad',
    base: 'nomad',
    name: 'NOMAD',
    tagline: '越野皮卡 · 皮实',
    blurb: '两吨多的越野皮卡：大轮子、长悬挂、防撞杠。飞桥落地、压路肩都不当回事，撞上谁谁让路；加速和极速垫底，弯前要早刹车。',
    shape: BASE_SHAPE,
    kit: { ...NO_KIT, wing: 'none' },
    stats: { speed: 4, accel: 5, grip: 5, drift: 6 },
    tune: {},
    torque: 1,
  },
];

export const carModel = (id: string | null | undefined): CarModel => CAR_MODELS.find((m) => m.id === id) ?? CAR_MODELS[0];

const warps = new Map<string, Warp>();

/** 这款车的车身变形（同一款车只建一次） */
export function warpOf(model: CarModel): Warp {
  let w = warps.get(model.id);
  if (!w) {
    w = new Warp(model.shape);
    warps.set(model.id, w);
  }
  return w;
}

/** 车长（米） */
export const carLength = (model: CarModel): number => {
  if (model.base !== 'gt') return CAR_BASES[model.base].length;
  const w = warpOf(model);
  return w.nose - w.tail;
};

/**
 * 这款车的碰撞外形和车轮位置：从车身比例算出来。
 * 对手车只用这一部分（调校保持原型车的，AI 是按它练的）。
 */
export function shellConfig(model: CarModel, base: VehicleConfig = DEFAULT_CONFIG): VehicleConfig {
  if (model.base !== 'gt') {
    // 单独建模的车：外形、车轮大小和位置、悬挂行程、重心都用它自己的
    const own = CAR_BASES[model.base].config;
    return {
      ...base,
      wheelPos: own.wheelPos,
      wheelRadius: own.wheelRadius,
      bodyCenter: own.bodyCenter,
      bodyHalf: own.bodyHalf,
      com: own.com,
      suspBump: own.suspBump,
      suspDroop: own.suspDroop,
    };
  }
  const w = warpOf(model);
  // 原型车：一个数都不改（无头仿真的基准圈速靠它）
  if (w.identity && model.shape.ride === 0) return base;
  // 物理上四个轮子一样大：轮心高度统一用原型车的
  const wheelPos = base.wheelPos.map((p) => [p[0] * w.widthAt(BASE.wheelY, p[2]), p[1], w.mapZ(p[2])] as [number, number, number]);
  const grow = w.nose - w.tail - (BASE.nose - BASE.tail);
  const shift = (w.nose + w.tail) / 2 - (BASE.nose + BASE.tail) / 2;
  return {
    ...base,
    wheelPos,
    bodyCenter: [0, base.bodyCenter[1] + model.shape.ride, base.bodyCenter[2] + shift],
    bodyHalf: [base.bodyHalf[0] * w.widthAt(0.4, 0), base.bodyHalf[1], base.bodyHalf[2] + grow / 2],
  };
}

/** 这款车完整的物理调校 */
export function vehicleConfig(model: CarModel): VehicleConfig {
  if (model.base !== 'gt') return { ...CAR_BASES[model.base].config, ...model.tune };
  const shell = shellConfig(model);
  if (shell === DEFAULT_CONFIG && Object.keys(model.tune).length === 0 && model.torque === 1) return DEFAULT_CONFIG;
  const tuned: VehicleConfig = { ...shell, ...model.tune };
  // 转动惯量跟着质量和车长走
  const m = tuned.mass / D.mass;
  const l = carLength(model) / (BASE.nose - BASE.tail);
  tuned.inertia = [D.inertia[0] * m * l * l, D.inertia[1] * m * l * l, D.inertia[2] * m];
  tuned.torqueCurve = D.torqueCurve.map(([rpm, t]) => [rpm, t * model.torque] as [number, number]);
  return tuned;
}
