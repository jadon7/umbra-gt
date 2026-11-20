import type { CityTrack } from '../city/cityLayout.ts';
import type { DriveInput } from '../drive/Vehicle.ts';
import { DEFAULT_CONFIG } from '../drive/VehicleConfig.ts';
import type { TrackProgress } from './TrackProgress.ts';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 一个车手的水平 */
export interface AISkill {
  /** 过弯敢用多大的横向加速度（米/秒²） */
  lateral: number;
  /** 规划刹车时按多大的减速度算（米/秒²）：越大刹得越晚 */
  brake: number;
  /** 直道上最高开到多快（米/秒） */
  top: number;
  /** 会不会用氮气 */
  nitro: boolean;
  /** 发车反应时间（秒） */
  reaction: number;
  /** 习惯走的线：离中心线多远（米，正值靠左） */
  line: number;
}

/** 赛道上的另一辆车（超车、避让时看它） */
export interface Traffic {
  /** 累计距离（和 TrackProgress.total 同一把尺子） */
  total: number;
  lateral: number;
  speed: number;
}

/** 车道最多能偏到离中心线多远：路面半宽 8 米，留出车身和路缘的余量 */
const MAX_LINE = 5.2;
/** 并排时两车中心线至少隔多远 */
const SIDE_GAP = 2.7;

/**
 * 对手的驾驶 AI。在自动驾驶（盯着前方一点打方向 + 按弯道曲率倒推车速）的基础上加了：
 *  - 自己的走线：不都挤在中心线上
 *  - 超车和避让：前面有慢车就换到空的一侧，实在过不去就跟着
 *  - 水平差异：过弯敢用的抓地、刹车点、极速、会不会用氮气
 *  - 橡皮筋：pace 由外面按"和玩家的距离"调，领先太多放慢一点，落后太多追一点
 */
export class RivalAI {
  readonly skill: AISkill;
  /** 橡皮筋系数：1 = 正常水平 */
  pace = 1;
  /** 当前实际在走的横向位置（调试、界面用） */
  offset = 0;
  targetSpeed = 0;
  /** 路面抓地系数（积雪时小于 1）：过弯和刹车的预留都按它打折 */
  grip = 1;

  private readonly track: CityTrack;
  private readonly step: number;
  private readonly wheelbase: number;
  private nitroOn = false;
  private readonly blockers: Traffic[] = [];
  private readonly beside: Traffic[] = [];

  constructor(track: CityTrack, skill: AISkill) {
    this.track = track;
    this.skill = skill;
    this.step = track.length / track.samples.length;
    this.wheelbase = DEFAULT_CONFIG.wheelPos[0][2] - DEFAULT_CONFIG.wheelPos[2][2];
    this.offset = skill.line;
  }

  /** 发车前、复位后调用：从当前的横向位置开始走线 */
  reset(lateral: number): void {
    this.offset = clamp(lateral, -MAX_LINE, MAX_LINE);
    this.nitroOn = false;
  }

  /**
   * @param yaw 车头朝向（绕 Y 轴，0 = +Z）
   * @param speed 前进速度（米/秒）
   * @param prog 这辆车的赛道进度（已经用当前位置更新过）
   * @param traffic 其他车
   * @param nitro 氮气余量 0–1
   */
  update(dt: number, x: number, z: number, yaw: number, speed: number, prog: TrackProgress, traffic: Traffic[], nitro: number): DriveInput {
    const S = this.track.samples;
    const n = S.length;
    const L = this.track.length;
    const sk = this.skill;
    const v = Math.max(speed, 0);
    const bi = prog.index;

    /* ---------- 选线：默认走自己习惯的线，那条线上有车就换一条空的 ---------- */
    // 先把别的车分成两类：前面要追上的（blockers）、已经并排的（beside）
    const blockers = this.blockers;
    const beside = this.beside;
    blockers.length = 0;
    beside.length = 0;
    let follow = Infinity; // 被前车压住时的限速
    for (const t of traffic) {
      let gap = t.total - prog.total;
      // 套圈的情况：按赛道上的实际前后算
      gap -= Math.round(gap / L) * L;
      if (Math.abs(gap) < 6) {
        beside.push(t);
        continue;
      }
      const closing = Math.max(0, v - t.speed);
      if (gap <= 0 || gap > 16 + closing * 2.2) continue;
      blockers.push(t);
      // 这辆车就在正前方、还没错开：留出距离，追得越快留得越多（前车刹车比自己早的时候尤其要紧）
      if (Math.abs(t.lateral - prog.lateral) < SIDE_GAP - 0.4) {
        const safe = 6 + closing * 0.9;
        if (gap < safe) follow = Math.min(follow, t.speed - (safe - gap) * 0.6);
      }
    }
    const clear = (lane: number) => {
      for (const t of blockers) if (Math.abs(lane - t.lateral) < SIDE_GAP) return false;
      for (const t of beside) if (Math.abs(lane - t.lateral) < SIDE_GAP - 0.2) return false;
      return true;
    };
    let want = sk.line;
    if (v < 11) {
      // 刚起步、车速还很低的时候不变线：发车格上左右前后都是车，一动就蹭
      want = this.offset;
    } else if (!clear(want)) {
      // 在每辆碍事的车的左右两边各找一条线，挑一条没人、又离自己现在位置最近的
      let best = this.offset;
      let bestCost = Infinity;
      const consider = (lane: number) => {
        if (Math.abs(lane) > MAX_LINE || !clear(lane)) return;
        const cost = Math.abs(lane - prog.lateral) + Math.abs(lane - sk.line) * 0.15;
        if (cost < bestCost) {
          bestCost = cost;
          best = lane;
        }
      };
      consider(this.offset);
      for (const t of blockers) {
        consider(t.lateral + SIDE_GAP + 0.4);
        consider(t.lateral - SIDE_GAP - 0.4);
      }
      for (const t of beside) {
        consider(t.lateral + SIDE_GAP + 0.2);
        consider(t.lateral - SIDE_GAP - 0.2);
      }
      want = best;
    }
    want = clamp(want, -MAX_LINE, MAX_LINE);
    // 横向挪动要慢：变线太急，大油门下车尾会甩出去
    const rate = clamp(v * 0.09, 0.4, 2.6);
    const shifting = Math.abs(want - this.offset) > 0.3 || Math.abs(prog.lateral - this.offset) > 1.2;
    this.offset += clamp(want - this.offset, -rate * dt, rate * dt);

    /* ---------- 转向：盯着前方一段距离外、自己那条线上的点 ---------- */
    const look = clamp(7 + v * 0.42, 9, 42);
    const ti = (bi + Math.round(look / this.step)) % n;
    const tp = S[ti];
    const tx = tp.pos.x + tp.left.x * this.offset - x;
    const tz = tp.pos.z + tp.left.z * this.offset - z;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const localZ = tx * fx + tz * fz;
    const localX = tx * fz - tz * fx;
    const alpha = Math.atan2(localX, localZ);
    const dist = Math.hypot(tx, tz);
    const delta = Math.atan2(2 * this.wheelbase * Math.sin(alpha), dist);
    const c = DEFAULT_CONFIG;
    const maxSteer = c.steerMin + (c.steerMax - c.steerMin) / (1 + Math.pow(v / c.steerSpeedRef, 1.7));
    const steer = clamp(delta / maxSteer, -1, 1);

    /* ---------- 车速：往前看一段，倒推现在最多能开多快 ---------- */
    const pace = this.pace;
    const lat = sk.lateral * pace * pace * this.grip;
    const decel = sk.brake * this.grip;
    let allowed = sk.top * pace;
    const horizon = clamp((v * v) / (2 * decel) + 40, 60, 320);
    const count = Math.round(horizon / this.step);
    for (let k = 0; k <= count; k += 2) {
      const p = S[(bi + k) % n];
      const kappa = p.curvature;
      if (Math.abs(kappa) < 1e-4) continue;
      // 走在弯内侧，实际半径比中心线小；走外侧则大
      const radius = Math.max(6, 1 / Math.abs(kappa) - Math.sign(kappa) * this.offset);
      const corner = Math.sqrt(lat * radius);
      const d = k * this.step;
      allowed = Math.min(allowed, Math.sqrt(corner * corner + 2 * decel * Math.max(0, d - 4)));
    }
    allowed = Math.min(allowed, Math.max(follow, 4));
    this.targetSpeed = allowed;

    let throttle = 0;
    let brake = 0;
    if (v < allowed - 0.5) throttle = clamp((allowed - v) / 4, 0.25, 1);
    else if (v > allowed + 1.0) brake = clamp((v - allowed) / 5, 0.15, 1);
    if (Math.abs(steer) > 0.85 && v > 12) throttle *= 0.6;
    // 正在变线、或者被挤得离自己的线很远：收一点油，先把车摆正
    if (shifting && v > 15) throttle = Math.min(throttle, 0.7);
    // 已经压上路缘了：慢下来回到路上
    if (Math.abs(prog.lateral) > 7 && v > 14) {
      throttle = 0;
      brake = Math.max(brake, 0.3);
    }

    /* ---------- 氮气：前面是长直道、车是正的、离目标车速还差得远 ---------- */
    if (sk.nitro) {
      const room = allowed - v;
      if (this.nitroOn) {
        if (nitro < 0.04 || room < 3 || Math.abs(steer) > 0.2 || shifting) this.nitroOn = false;
      } else if (nitro > 0.45 && room > 10 && Math.abs(steer) < 0.08 && v > 22 && !shifting) {
        this.nitroOn = true;
      }
    } else {
      this.nitroOn = false;
    }

    return { throttle, brake, steer, handbrake: false, nitro: this.nitroOn && throttle > 0.5 };
  }
}
