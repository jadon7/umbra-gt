/**
 * 车身变形：把原型车的车身"捏"成别的比例。
 *
 * 几款车共用同一个车身模型，区别在比例上：尾巴拉长、车顶压低、下半身加宽、轮拱放大……
 * 这里把这些改动写成一个空间变形 —— 给车身上任意一点的原始位置，算出它在新车型上的位置。
 * 加载车的时候把每个顶点都过一遍。
 *
 * 坐标约定同 VehicleConfig：+X 向左、+Y 向上、+Z 向前，原点在车辆中心正下方的地面上。
 * 这个文件只有数学，不依赖渲染库：无头仿真算轮距、轴距时也用它。
 */

/** 一段沿车长方向的拉伸：z0–z1 之间加长 add 米（负数是缩短） */
export interface Stretch {
  z0: number;
  z1: number;
  add: number;
}

export interface CarShape {
  /** 沿车长方向的拉伸。轮拱所在的两段不能拉（拉了轮拱就不圆了） */
  stretch: Stretch[];
  /** 整车宽度倍率 */
  width: number;
  /** 下半身（腰线以下）额外加宽的比例：宽体 */
  flare: number;
  /** 只加在后半截的额外加宽：后翼子板外扩 */
  flareRear: number;
  /** 车顶升高多少米（负数是压低） */
  roof: number;
  /** 车身相对车轮升高多少米（负数是降低车身） */
  ride: number;
  /** 车身前倾角（弧度，正值车头低） */
  rake: number;
  /** 前后轮的大小倍率、宽度倍率 */
  wheelFront: number;
  wheelRear: number;
  tireFront: number;
  tireRear: number;
}

export const BASE_SHAPE: CarShape = {
  stretch: [],
  width: 1,
  flare: 0,
  flareRear: 0,
  roof: 0,
  ride: 0,
  rake: 0,
  wheelFront: 1,
  wheelRear: 1,
  tireFront: 1,
  tireRear: 1,
};

/** 原型车的尺寸（米）。能拉伸的几段、轮拱的位置都按它来定 */
export const BASE = {
  /** 车尾、车头 */
  tail: -1.94,
  nose: 2.417,
  /** 前后轴 */
  axleFront: 1.485,
  axleRear: -1.314,
  /** 轮心离地、离车身中线 */
  wheelY: 0.384,
  wheelX: 0.979,
  /** 可以拉伸的四段：车尾（后轮拱后面那一小截）、后翼子板（座舱和后轮拱之间）、车门、车头（前轮拱前面） */
  zoneTail: [-1.81, -1.762] as [number, number],
  zoneQuarter: [-0.86, -0.47] as [number, number],
  zoneDoor: [-0.42, 0.98] as [number, number],
  zoneNose: [1.95, 2.4] as [number, number],
};

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 前后轴的中点：拉伸以它为不动点，这样物理上的车身中心不会跑偏 */
const REF = (BASE.axleFront + BASE.axleRear) / 2;

export class Warp {
  readonly shape: CarShape;
  /** apply() 的结果 */
  x = 0;
  y = 0;
  z = 0;
  /** 是不是完全没变形（原型车）：可以跳过所有计算 */
  readonly identity: boolean;

  /** 四个轮拱：轴的位置和放大倍率 */
  private readonly arches: { z: number; scale: number }[];
  /** 拉伸之后整体挪回去的量，保证前后轴的中点还在原处 */
  private readonly recentre: number;

  constructor(shape: CarShape) {
    this.shape = shape;
    this.arches = [
      { z: BASE.axleFront, scale: shape.wheelFront },
      { z: BASE.axleRear, scale: shape.wheelRear },
    ];
    this.identity =
      shape.stretch.length === 0 &&
      shape.width === 1 &&
      shape.flare === 0 &&
      shape.flareRear === 0 &&
      shape.roof === 0 &&
      shape.wheelFront === 1 &&
      shape.wheelRear === 1;
    this.recentre = 0;
    const mid = (this.mapZ(BASE.axleFront) + this.mapZ(BASE.axleRear)) / 2;
    this.recentre = REF - mid;
  }

  /** 沿车长方向的位置变化（只看 z） */
  mapZ(z: number): number {
    let out = z;
    for (const s of this.shape.stretch) out += s.add * (smooth(s.z0, s.z1, z) - smooth(s.z0, s.z1, REF));
    return out + this.recentre;
  }

  /** 这个位置上，下半身被加宽到原来的多少倍（车轮的轮距也按它走） */
  widthAt(y: number, z: number): number {
    const s = this.shape;
    const lower = 1 - smooth(0.66, 0.92, y);
    const rear = 1 - smooth(-0.5, 0.3, z);
    return s.width * (1 + (s.flare + s.flareRear * rear) * lower);
  }

  /** 车身上一点的原始位置 → 新位置。结果放在 this.x / y / z */
  apply(x: number, y: number, z: number): void {
    if (this.identity) {
      this.x = x;
      this.y = y;
      this.z = z;
      return;
    }
    const s = this.shape;
    let py = y;
    let pz = z;
    // 轮拱跟着车轮放大：以轮心为中心往外推，离轮拱越远推得越少；只动车身外侧（翼子板），不动中间
    const side = smooth(0.45, 0.72, Math.abs(x));
    if (side > 0) {
      for (const a of this.arches) {
        if (a.scale === 1) continue;
        const dy = y - BASE.wheelY;
        const dz = z - a.z;
        const w = (1 - smooth(0.5, 0.95, Math.hypot(dy, dz))) * side;
        if (w <= 0) continue;
        const k = (a.scale - 1) * w;
        // 轮子变大以后轮心也抬高了，轮拱跟着抬
        py += dy * k + BASE.wheelY * k;
        pz += dz * k;
      }
    }
    this.x = x * this.widthAt(y, z);
    this.y = py + s.roof * smooth(0.8, 1.12, y);
    this.z = this.mapZ(pz);
  }

  /** 车轮的位置：左前、右前、左后、右后（+X 向左） */
  wheelPositions(): [number, number, number][] {
    const s = this.shape;
    const out: [number, number, number][] = [];
    for (const [z, scale] of [
      [BASE.axleFront, s.wheelFront],
      [BASE.axleRear, s.wheelRear],
    ] as const) {
      const x = BASE.wheelX * this.widthAt(BASE.wheelY, z);
      const zz = this.mapZ(z);
      out.push([x, BASE.wheelY * scale, zz], [-x, BASE.wheelY * scale, zz]);
    }
    return out;
  }

  /** 新车型的车尾、车头位置 */
  get tail(): number {
    return this.mapZ(BASE.tail);
  }

  get nose(): number {
    return this.mapZ(BASE.nose);
  }
}
