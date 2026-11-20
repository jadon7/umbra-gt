import type { CityTrack } from '../city/cityLayout.ts';
import type { PhysicsWorld } from '../drive/PhysicsWorld.ts';
import { NO_INPUT, Vehicle, type DriveInput } from '../drive/Vehicle.ts';
import { RaceDirector, type Racer } from './RaceDirector.ts';
import { RivalAI, type AISkill, type Traffic } from './RivalAI.ts';
import { rubberBand, skillFor, type RaceLevel, type RivalDef } from './roster.ts';

/** 场上的一辆车：物理、驾驶 AI、比赛状态 */
export interface FieldCar {
  racer: Racer;
  vehicle: Vehicle;
  /** 每辆车都有 AI。玩家的那个平时不用，冲线之后接手把车开走 */
  ai: RivalAI;
  /** 现在由人来开（输入从外面给） */
  human: boolean;
  /** AI 这一帧的决定 */
  input: DriveInput;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 车身朝上的程度：1 = 正着，0 = 侧躺，-1 = 四轮朝天 */
  upright: number;
  stuck: number;
  flipped: number;
  /** 被放回赛道的次数 */
  respawns: number;
  /** 发车信号之后还要等多久才起步 */
  wait: number;
}

export interface RaceSetup {
  laps: number;
  level: RaceLevel;
  rivals: RivalDef[];
  /** 玩家的名字和界面颜色；不传表示这场没有玩家（全是 AI，仿真用） */
  player?: { name: string; color: string };
  /** 玩家那辆车由 AI 开的时候按这个水平（冲线之后接手，或者仿真里扮演玩家） */
  playerSkill?: AISkill;
}

const COOL_DOWN: Partial<AISkill> = { top: 32, nitro: false };

/**
 * 一场比赛里所有的车：摆发车格、让 AI 开车、把卡住的车放回赛道，并驱动裁判（RaceDirector）。
 * 不碰画面，浏览器里和无头仿真里用的是同一份。
 *
 * 用法：每个物理步之前调 step()，每帧（或每两个物理步）调一次 think()。
 */
export class RaceField {
  readonly director: RaceDirector;
  readonly cars: FieldCar[] = [];
  readonly level: RaceLevel;
  /** 玩家的车（没有玩家的仿真里是 null） */
  readonly player: FieldCar | null;

  private readonly track: CityTrack;
  private readonly traffic: Traffic[] = [];

  /**
   * @param vehicles 预先建好的车辆物理：前面几辆给对手，最后一辆给玩家（有玩家的话）
   */
  constructor(track: CityTrack, vehicles: Vehicle[], setup: RaceSetup) {
    this.track = track;
    this.level = setup.level;
    this.director = new RaceDirector(track, setup.laps);
    const n = setup.rivals.length;
    setup.rivals.forEach((def, slot) => {
      const racer = this.director.addRacer(def.name, def.color, false);
      this.cars.push(this.makeCar(racer, vehicles[slot], skillFor(setup.level, slot), false));
    });
    if (setup.player) {
      const racer = this.director.addRacer(setup.player.name, setup.player.color, true);
      const skill = setup.playerSkill ?? skillFor(setup.level, 1);
      this.player = this.makeCar(racer, vehicles[n], skill, true);
      this.cars.push(this.player);
    } else {
      this.player = null;
    }
    for (let i = 0; i < this.cars.length; i++) this.traffic.push({ total: 0, lateral: 0, speed: 0 });
  }

  /** 路面抓地系数（积雪时小于 1）：所有车的轮胎和 AI 的预判一起改 */
  setGrip(grip: number): void {
    for (const car of this.cars) {
      car.vehicle.surfaceGrip = grip;
      car.ai.grip = grip;
    }
  }

  private makeCar(racer: Racer, vehicle: Vehicle, skill: AISkill, human: boolean): FieldCar {
    return {
      racer,
      vehicle,
      ai: new RivalAI(this.track, skill),
      human,
      input: { ...NO_INPUT },
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      upright: 1,
      stuck: 0,
      flipped: 0,
      respawns: 0,
      wait: skill.reaction,
    };
  }

  /** 把所有车摆上发车格，开始走流程。玩家排最后一位 */
  lineUp(): void {
    this.cars.forEach((car, slot) => {
      const g = this.director.gridSlot(slot);
      car.vehicle.reset(g.x, g.y + 0.06, g.z, g.yaw);
      car.vehicle.nitro = 1;
      car.vehicle.hold = true;
      car.racer.progress.reset(g.x, g.z);
      car.ai.reset(car.racer.progress.lateral);
      car.input = { ...NO_INPUT };
      car.stuck = 0;
      car.flipped = 0;
      this.read(car);
    });
    this.director.begin();
  }

  private read(car: FieldCar): void {
    const t = car.vehicle.body.translation();
    const r = car.vehicle.body.rotation();
    car.x = t.x;
    car.y = t.y;
    car.z = t.z;
    car.yaw = Math.atan2(2 * (r.x * r.z + r.w * r.y), 1 - 2 * (r.x * r.x + r.y * r.y));
    car.upright = 1 - 2 * (r.x * r.x + r.z * r.z);
  }

  /** 每个物理步之前调用：把 AI 的输入交给它们的车。人开的那辆由外面自己推进 */
  step(dt: number): void {
    for (const car of this.cars) {
      if (car.human) continue;
      car.vehicle.step(car.input, dt);
    }
  }

  /** 把一辆车放回赛道：它现在所在的那一段的路中间（旁边有车就错开），车头朝前、停住 */
  respawn(car: FieldCar): void {
    const p = this.track.samples[car.racer.progress.index];
    let lateral = 0;
    for (const side of [0, 2.8, -2.8, 5, -5]) {
      const x = p.pos.x + p.left.x * side;
      const z = p.pos.z + p.left.z * side;
      const free = this.cars.every((o) => o === car || (o.x - x) ** 2 + (o.z - z) ** 2 > 36);
      if (free) {
        lateral = side;
        break;
      }
    }
    const x = p.pos.x + p.left.x * lateral;
    const z = p.pos.z + p.left.z * lateral;
    car.vehicle.reset(x, p.pos.y + 0.1, z, Math.atan2(p.dir.x, p.dir.z));
    car.vehicle.collisionImpact = 0;
    car.vehicle.landingImpact = 0;
    car.racer.progress.update(x, z);
    car.ai.reset(lateral);
    car.stuck = 0;
    car.flipped = 0;
    car.respawns++;
    this.read(car);
  }

  /** 玩家冲线之后：把车交给 AI 慢慢开 */
  private retire(car: FieldCar): void {
    car.human = false;
    Object.assign(car.ai.skill, COOL_DOWN);
    car.ai.reset(car.racer.progress.lateral);
  }

  /** 每帧调用：更新进度和裁判，让 AI 决定下一步怎么开，处理卡住的车 */
  think(dt: number): void {
    const d = this.director;
    for (const car of this.cars) {
      this.read(car);
      car.racer.progress.update(car.x, car.z);
    }
    d.update(dt);
    const live = d.live;
    const playerTotal = this.player && !this.player.racer.finished ? this.player.racer.progress.total : null;

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const t = this.traffic[i];
      t.total = c.racer.progress.total;
      t.lateral = c.racer.progress.lateral;
      t.speed = c.vehicle.forwardSpeed;
    }

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const v = car.vehicle;
      v.hold = !live;
      if (car.racer.finished && car.human) this.retire(car);
      if (car.racer.finished && car.ai.skill.top > 32) Object.assign(car.ai.skill, COOL_DOWN);

      if (!live) {
        car.input = { ...NO_INPUT };
        car.wait = car.ai.skill.reaction;
        continue;
      }
      if (car.human) continue;

      // 发车反应时间
      if (car.wait > 0) {
        car.wait -= dt;
        car.input = { ...NO_INPUT };
        continue;
      }

      car.ai.pace = playerTotal === null || car.racer.finished ? 1 : rubberBand(this.level, car.racer.progress.total - playerTotal);
      const others = this.traffic.filter((_, k) => k !== i);
      car.input = car.ai.update(dt, car.x, car.z, car.yaw, v.forwardSpeed, car.racer.progress, others, v.nitro);

      // 卡住（顶着墙、被别的车别住）、翻了、掉下去了：放回赛道
      car.stuck = v.speed < 1.5 ? car.stuck + dt : 0;
      car.flipped = car.upright < 0.3 ? car.flipped + dt : 0;
      if (car.stuck > 2.5 || car.flipped > 2 || car.y < -4 || car.racer.progress.offTrack) this.respawn(car);
    }
  }
}
