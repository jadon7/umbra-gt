import type { ShowPilot } from '../drive/ShowPilot.ts';
import { NO_INPUT, type DriveInput } from '../drive/Vehicle.ts';
import type { RaceField } from './RaceField.ts';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 比赛里的自动驾驶：让表演式的那个自动驾驶（ShowPilot，直道开氮气、急弯漂过去）替玩家开，
 * 再加上它自己没有的两样——看着点别的车，卡死了放回赛道。
 *
 *  - 前面有车挡着：从对方偏着的另一侧换线过去；贴得太近、还在往上追，就按前车的车速收油，这时不开氮气。
 *  - 并排：往外让半个车身。
 *  - 漂起来以后不管别的车（甩到一半没法改主意），所以弯里偶尔会碰到——它是开给人看的，不是开得最稳的。
 *  - 倒车也脱不了困、翻了、开出赛道了：和对手一样放回赛道中间。
 *
 * 不碰画面，浏览器里和无头仿真（scripts/race-sim.ts）用的是同一份。
 */
export class RacePilot {
  /** 这一步里把车放回过赛道（外面要跟着把镜头、特效同步一下），读完自己清掉 */
  respawned = false;

  private readonly pilot: ShowPilot;
  private readonly field: RaceField;
  private readonly length: number;
  private still = 0;
  private flipped = 0;
  private wait = 0.22;

  constructor(pilot: ShowPilot, field: RaceField, length: number) {
    this.pilot = pilot;
    this.field = field;
    this.length = length;
  }

  /** 每个物理步之前调用，返回玩家那辆车这一步的输入 */
  drive(dt: number): DriveInput {
    const me = this.field.player;
    const pilot = this.pilot;
    if (!me || !me.human) return NO_INPUT;
    if (!this.field.director.live) {
      this.wait = 0.22;
      pilot.lane = null;
      return NO_INPUT;
    }
    // 发车的反应时间
    if (this.wait > 0) {
      this.wait -= dt;
      return NO_INPUT;
    }
    const v = me.vehicle;
    const t = v.body.translation();
    const r = v.body.rotation();
    const yaw = Math.atan2(2 * (r.x * r.z + r.w * r.y), 1 - 2 * (r.x * r.x + r.y * r.y));
    const upright = 1 - 2 * (r.x * r.x + r.z * r.z);

    this.watch();
    const input = pilot.update(v, t.x, t.z, yaw, dt);

    this.still = v.speed < 1.5 ? this.still + dt : 0;
    this.flipped = upright < 0.3 ? this.flipped + dt : 0;
    if (this.still > 4.5 || this.flipped > 2 || t.y < -4 || me.racer.progress.offTrack) {
      this.field.respawn(me);
      const p = v.body.translation();
      pilot.reset(p.x, p.z);
      this.still = 0;
      this.flipped = 0;
      this.respawned = true;
      return NO_INPUT;
    }
    return input;
  }

  /** 看一眼周围的车，告诉自动驾驶该走哪条线、车速上限是多少 */
  private watch(): void {
    const me = this.field.player!;
    const pilot = this.pilot;
    const L = this.length;
    const mine = me.racer.progress;
    const speed = me.vehicle.forwardSpeed;
    let lane: number | null = null;
    let weight = 0;
    let follow = Infinity;
    let crowded = false;
    for (const c of this.field.cars) {
      if (c === me) continue;
      let gap = (c.racer.progress.total - mine.total) % L;
      if (gap > L / 2) gap -= L;
      if (gap < -L / 2) gap += L;
      const theirs = c.racer.progress.lateral;
      const dl = theirs - mine.lateral;
      const closing = speed - c.vehicle.forwardSpeed;
      const reach = 10 + Math.max(closing, 0) * 1.6 + speed * 0.32;
      if (gap > 1.5 && gap < reach && Math.abs(dl) < 3.0) {
        // 从哪边过：对方偏哪边就走另一边；正对着就挑路宽的那一边
        const side = Math.abs(dl) > 0.6 ? -Math.sign(dl) : theirs > 0 ? -1 : 1;
        const w = clamp((1 - gap / reach) * 2.4, 0, 1);
        if (w > weight) {
          weight = w;
          lane = clamp(theirs + side * 3.2, -6.2, 6.2);
        }
        if (gap < 30) crowded = true;
        if (closing > 0 && gap < 5 + closing * 0.7) follow = Math.min(follow, c.vehicle.forwardSpeed + gap * 0.9);
      } else if (Math.abs(gap) <= 4.8 && Math.abs(dl) < 2.7) {
        // 并排：往外让一点
        const w = 0.7;
        if (w > weight) {
          weight = w;
          lane = clamp(mine.lateral - Math.sign(dl || 1) * (2.9 - Math.abs(dl)), -6.2, 6.2);
        }
      }
    }
    pilot.lane = lane;
    pilot.laneWeight = weight;
    pilot.follow = follow;
    pilot.crowded = crowded;
  }
}
