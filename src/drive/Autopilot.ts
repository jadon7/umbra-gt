import type { DriveInput } from './Vehicle.ts';
import { DEFAULT_CONFIG, type VehicleConfig } from './VehicleConfig.ts';

/** 自动驾驶需要的赛道信息：沿中心线的采样点 */
export interface PathSample {
  s: number;
  pos: { x: number; y: number; z: number };
  curvature: number;
}

export interface PathInfo {
  samples: PathSample[];
  length: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 沿赛道中心线跑的自动驾驶。
 *  - 转向：纯追踪（盯着前方一段距离外的点打方向）
 *  - 速度：看前方一段路的弯道曲率，按"过弯极限 + 刹得住"倒推当前允许的最高车速
 *
 * 现在用来验证赛道能完整跑通；阶段 7 的 AI 对手在这个基础上加超车、失误和橡皮筋。
 */
export class Autopilot {
  /** 过弯时允许用到的横向加速度（米/秒²） */
  lateralLimit = 12.5;
  /** 路面抓地系数（积雪时小于 1）：过弯和刹车的预留都按它打折 */
  grip = 1;
  /** 规划刹车时假设的减速度（米/秒²） */
  brakeLimit = 10.5;
  /** 最高车速（米/秒） */
  topSpeed = 78;
  /** 当前所在的采样点下标 */
  index = 0;

  /**
   * 按这台车的能耐收紧过弯和刹车的预留：抓地差、刹车弱的车（比如皮卡）要早刹车、慢过弯。
   * 原型车的数不变（无头仿真的基准圈速靠它）。
   */
  tuneFor(cfg: VehicleConfig): void {
    const D = DEFAULT_CONFIG;
    const lat = (cfg.muLatFront + cfg.muLatRear) / (D.muLatFront + D.muLatRear);
    const brake = Math.min(cfg.muLong / D.muLong, cfg.brakeForce / cfg.mass / (D.brakeForce / D.mass));
    // 下压力小的车高速弯也吃亏
    const aero = 0.9 + 0.1 * Math.min(1, cfg.downforce / cfg.mass / (D.downforce / D.mass));
    this.lateralLimit = 12.5 * Math.min(1, lat * aero);
    this.brakeLimit = 10.5 * Math.min(1, brake);
  }

  /** 累计跑过的距离（跨圈累加，用来判断是否完成一圈） */
  progress = 0;
  /** 离中心线的横向距离（调试用） */
  offset = 0;
  targetSpeed = 0;

  private readonly path: PathInfo;
  private readonly step: number;
  private started = false;

  constructor(path: PathInfo) {
    this.path = path;
    this.step = path.length / path.samples.length;
  }

  reset(x: number, z: number): void {
    const S = this.path.samples;
    let best = Infinity;
    for (let i = 0; i < S.length; i++) {
      const d = (S[i].pos.x - x) ** 2 + (S[i].pos.z - z) ** 2;
      if (d < best) {
        best = d;
        this.index = i;
      }
    }
    this.progress = 0;
    this.started = true;
  }

  /**
   * @param x,z 车的位置
   * @param yaw 车头朝向（绕 Y 轴，0 = +Z）
   * @param speed 前进速度（米/秒）
   */
  update(x: number, z: number, yaw: number, speed: number): DriveInput {
    const S = this.path.samples;
    const n = S.length;
    if (!this.started) this.reset(x, z);

    // 在上一次位置附近找最近的采样点
    let best = Infinity;
    let bi = this.index;
    for (let k = -5; k <= 40; k++) {
      const i = (this.index + k + n) % n;
      const d = (S[i].pos.x - x) ** 2 + (S[i].pos.z - z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    let adv = bi - this.index;
    if (adv < -n / 2) adv += n;
    if (adv > n / 2) adv -= n;
    this.progress += adv * this.step;
    this.index = bi;
    this.offset = Math.sqrt(best);

    // --- 转向：纯追踪 ---
    const v = Math.max(speed, 0);
    const look = clamp(7 + v * 0.42, 9, 42);
    const ti = (bi + Math.round(look / this.step)) % n;
    const tx = S[ti].pos.x - x;
    const tz = S[ti].pos.z - z;
    // 目标点在车身坐标里的方位角（左为正）
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const localZ = tx * fx + tz * fz;
    const localX = tx * fz - tz * fx;
    const alpha = Math.atan2(localX, localZ);
    const dist = Math.hypot(tx, tz);
    const wheelbase = DEFAULT_CONFIG.wheelPos[0][2] - DEFAULT_CONFIG.wheelPos[2][2];
    const delta = Math.atan2(2 * wheelbase * Math.sin(alpha), dist);
    const c = DEFAULT_CONFIG;
    const maxSteer = c.steerMin + (c.steerMax - c.steerMin) / (1 + Math.pow(v / c.steerSpeedRef, 1.7));
    const steer = clamp(delta / maxSteer, -1, 1);

    // --- 速度规划：往前看一段，倒推现在最多能开多快 ---
    let allowed = this.topSpeed;
    const lateralLimit = this.lateralLimit * this.grip;
    const brakeLimit = this.brakeLimit * this.grip;
    const horizon = clamp((v * v) / (2 * brakeLimit) + 40, 60, 320);
    const count = Math.round(horizon / this.step);
    for (let k = 0; k <= count; k += 2) {
      const i = (bi + k) % n;
      const kappa = Math.abs(S[i].curvature);
      if (kappa < 1e-4) continue;
      const corner = Math.sqrt(lateralLimit / kappa);
      const d = k * this.step;
      allowed = Math.min(allowed, Math.sqrt(corner * corner + 2 * brakeLimit * Math.max(0, d - 4)));
    }
    this.targetSpeed = allowed;

    let throttle = 0;
    let brake = 0;
    if (v < allowed - 0.5) throttle = clamp((allowed - v) / 4, 0.25, 1);
    else if (v > allowed + 1.0) brake = clamp((v - allowed) / 5, 0.15, 1);
    // 方向打得大时收一点油，避免推头
    if (Math.abs(steer) > 0.85 && v > 12) throttle *= 0.6;

    return { throttle, brake, steer, handbrake: false, nitro: false };
  }
}
