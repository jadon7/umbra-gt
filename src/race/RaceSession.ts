import * as THREE from 'three/webgpu';
import type { Car } from '../car/Car';
import { PAINTS } from '../car/paint';
import type { CityTrack } from '../city/cityLayout.ts';
import type { RivalLighting } from '../drive/DriveWorld.ts';
import type { PhysicsWorld } from '../drive/PhysicsWorld.ts';
import { Vehicle } from '../drive/Vehicle.ts';
import type { RaceDirector, RaceEvent, Racer } from './RaceDirector.ts';
import { RaceField, type FieldCar } from './RaceField.ts';
import { RaceMarkers, type MarkerHost } from './RaceMarkers.ts';
import { prepareRivalTemplates, RivalCar } from './RivalCar.ts';
import { CAR_MODELS, shellConfig } from '../car/models.ts';
import { DEFAULT_CONFIG } from '../drive/VehicleConfig.ts';
import { MAX_RIVALS, pickRivals, type RaceLevel } from './roster.ts';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface RaceOptions {
  laps: number;
  /** 对手数量 1–7 */
  rivals: number;
  level: RaceLevel;
  /** 开赛前放不放特写镜头（默认放） */
  intro?: boolean;
}

/** 屏幕上一辆对手车头顶的名牌该画在哪 */
export interface RivalTag {
  racer: Racer;
  /** 屏幕坐标 0–1（左上角为原点） */
  x: number;
  y: number;
  /** 离镜头多远（米） */
  distance: number;
  visible: boolean;
}

/** 一辆对手车：物理 + 画面，以及两个物理状态之间插值用的量 */
interface Rival {
  vehicle: Vehicle;
  visual: RivalCar;
  car: FieldCar | null;
  prevPos: THREE.Vector3;
  currPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currQuat: THREE.Quaternion;
  roll: number;
  pitch: number;
  groundY: number;
  tailGlow: number;
  light: RivalLighting;
  tag: RivalTag;
}

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();

/**
 * 对手车的"车队"：最多七辆，物理和画面都提前建好，不比赛的时候停用并藏起来。
 * 一场比赛用其中的前几辆。
 */
export class RivalPool {
  readonly rivals: Rival[] = [];
  readonly group = new THREE.Group();

  constructor(physics: PhysicsWorld, source: Car) {
    // 对手开的车型轮着来，场上五款都能见到
    const models = Array.from({ length: MAX_RIVALS }, (_, i) => CAR_MODELS[(i + 1) % CAR_MODELS.length]);
    prepareRivalTemplates(source, models);
    for (let i = 0; i < MAX_RIVALS; i++) {
      // 物理上只换碰撞外形（长尾车更长、宽体车更宽）；调校和车轮位置保持原型车的 —— AI 是按它练的
      // （单独建模的那几台车轮大小、底盘高度都不一样，这些几何上的东西也要跟着换，不然车轮会陷进地里）
      const shell = shellConfig(models[i]);
      const vehicle = new Vehicle(physics, models[i].base === 'gt' ? { ...DEFAULT_CONFIG, bodyCenter: shell.bodyCenter, bodyHalf: shell.bodyHalf } : shell);
      vehicle.body.setEnabled(false);
      const visual = new RivalCar(source, PAINTS[(i + 1) % PAINTS.length], models[i]);
      this.group.add(visual.root);
      this.rivals.push({
        vehicle,
        visual,
        car: null,
        prevPos: new THREE.Vector3(),
        currPos: new THREE.Vector3(),
        prevQuat: new THREE.Quaternion(),
        currQuat: new THREE.Quaternion(),
        roll: 0,
        pitch: 0,
        groundY: 0,
        tailGlow: 0,
        light: { x: 0, y: -100, z: 0, dirX: 0, dirZ: 1, shadow: 0, tailGlow: 0 },
        tag: { racer: null as unknown as Racer, x: 0, y: 0, distance: 0, visible: false },
      });
    }
  }
}

/**
 * 一场比赛在画面这一侧的全部内容：对手车的画面、赛道上的标记、车底阴影，
 * 并把 RaceField（比赛逻辑）接到试驾模式的物理循环里。
 */
export class RaceSession {
  readonly field: RaceField;
  readonly director: RaceDirector;
  readonly options: RaceOptions;
  readonly rivals: Rival[];
  /** 这一帧发生的比赛事件（倒数、过检查点、完成一圈、冲线…） */
  events: RaceEvent[] = [];
  readonly tags: RivalTag[] = [];

  private readonly markers: RaceMarkers;
  private readonly lights: RivalLighting[] = [];
  private gateShown = -1;

  constructor(track: CityTrack, pool: RivalPool, markers: RaceMarkers, playerVehicle: Vehicle, playerCar: Car, options: RaceOptions) {
    this.options = options;
    this.markers = markers;
    const defs = pickRivals(options.rivals, playerCar.paint.current.id);
    this.rivals = pool.rivals.slice(0, defs.length);
    const vehicles = [...this.rivals.map((r) => r.vehicle), playerVehicle];
    this.field = new RaceField(track, vehicles, {
      laps: options.laps,
      level: options.level,
      rivals: defs,
      player: { name: '你', color: '#ff3b2f' },
    });
    this.director = this.field.director;

    this.rivals.forEach((r, i) => {
      r.car = this.field.cars[i];
      const paint = PAINTS.find((p) => p.id === defs[i].paint) ?? PAINTS[0];
      r.visual.paint.apply(paint, true);
      r.visual.root.visible = true;
      r.vehicle.body.setEnabled(true);
      r.tag.racer = r.car.racer;
      this.tags.push(r.tag);
    });
    // 这一场没用上的车：停用、藏起来
    for (const r of pool.rivals.slice(defs.length)) {
      r.vehicle.body.setEnabled(false);
      r.visual.root.visible = false;
      r.car = null;
    }
    this.markers.setVisible(true);
  }

  /** 玩家那辆车现在是不是由 AI 在开（冲线之后） */
  get playerOnAuto(): boolean {
    return !!this.field.player && !this.field.player.human;
  }

  /** 所有车摆上发车格。调用后试驾模式要自己把玩家车的画面状态同步一下 */
  lineUp(): void {
    this.field.lineUp();
    for (const r of this.rivals) {
      this.read(r);
      r.prevPos.copy(r.currPos);
      r.prevQuat.copy(r.currQuat);
      r.roll = 0;
      r.pitch = 0;
    }
    this.gateShown = -1;
    this.events = [];
  }

  private read(r: Rival): void {
    const t = r.vehicle.body.translation();
    const q = r.vehicle.body.rotation();
    r.currPos.set(t.x, t.y, t.z);
    r.currQuat.set(q.x, q.y, q.z, q.w);
  }

  /** 每个物理步之前：对手的车各走一步（玩家冲线后他的车也在这里走） */
  prePhysics(dt: number): void {
    for (const r of this.rivals) {
      r.prevPos.copy(r.currPos);
      r.prevQuat.copy(r.currQuat);
    }
    this.field.step(dt);
  }

  /** 每个物理步之后：读回对手车的新位置 */
  postPhysics(): void {
    for (const r of this.rivals) this.read(r);
  }

  /** 把玩家的车放回赛道（比赛中按复位键） */
  respawnPlayer(): void {
    if (this.field.player) this.field.respawn(this.field.player);
  }

  /**
   * 每帧一次：比赛逻辑走一步，然后更新对手车的画面。
   * @param alpha 这一帧落在两个物理状态之间的什么位置 0–1
   * @param night 入夜程度（车灯、阴影浓度跟着它）
   */
  frame(dt: number, alpha: number, camera: THREE.PerspectiveCamera, night: number): void {
    this.field.think(dt);
    this.events = this.director.drain();

    const headlight = clamp((night - 0.25) / 0.45, 0, 1);
    RivalCar.setHeadlights(night);
    this.lights.length = 0;
    const k = 1 - Math.exp(-dt * 7);
    for (const r of this.rivals) {
      const v = r.vehicle;
      const root = r.visual.root;
      root.position.lerpVectors(r.prevPos, r.currPos, alpha);
      root.quaternion.slerpQuaternions(r.prevQuat, r.currQuat, alpha);
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        r.visual.setWheelPose(i, w.travel, w.steer, w.spin);
      }
      r.roll += (clamp(v.lateralG, -2, 2) * 0.02 - r.roll) * k;
      r.pitch += (clamp(-v.longG, -1.6, 1.6) * 0.014 - r.pitch) * k;
      r.visual.setBodyLean(r.roll, r.pitch);
      const braking = v.braking || v.hold;
      r.visual.setBraking(braking);
      r.visual.update(dt);

      // 车底阴影和尾灯洒在地上的光
      if (v.groundedCount > 0) r.groundY = root.position.y;
      const lift = Math.max(0, root.position.y - r.groundY);
      _f.set(0, 0, 1).applyQuaternion(root.quaternion);
      const len = Math.hypot(_f.x, _f.z) || 1;
      const glowTarget = headlight * (braking ? 0.42 : 0.1);
      r.tailGlow += (glowTarget - r.tailGlow) * (1 - Math.exp(-dt * (braking ? 30 : 6)));
      const l = r.light;
      l.x = root.position.x;
      l.y = r.groundY;
      l.z = root.position.z;
      l.dirX = _f.x / len;
      l.dirZ = _f.z / len;
      l.shadow = (0.3 + 0.4 * night) / (1 + lift * 1.2);
      l.tailGlow = r.tailGlow / (1 + lift * 0.5);
      this.lights.push(l);

      // 头顶的名牌
      const tag = r.tag;
      _p.copy(root.position);
      _p.y += 1.75;
      tag.distance = _p.distanceTo(camera.position);
      _p.project(camera);
      tag.x = _p.x * 0.5 + 0.5;
      tag.y = 0.5 - _p.y * 0.5;
      tag.visible = _p.z > -1 && _p.z < 1 && tag.distance < 110 && tag.distance > 9 && tag.x > -0.05 && tag.x < 1.05 && tag.y > -0.05 && tag.y < 1.05;
    }

    /* 检查点的光门：只画玩家下一道该过的和再下一道 */
    const player = this.director.player;
    if (player) {
      const done = player.finished || this.director.phase === 'over';
      if (done) {
        if (this.gateShown !== -2) {
          this.markers.setGates(null, null);
          this.gateShown = -2;
        }
      } else if (player.gates !== this.gateShown) {
        if (this.gateShown >= 0) this.markers.flash();
        this.gateShown = player.gates;
        this.markers.setGates(this.director.nextGate(player), this.director.gateAfter(player));
      }
    }
    this.markers.update(dt, night);
  }

  /** 离镜头最近的几辆排前面（地面材质里只算前几辆的阴影） */
  lighting(camera: THREE.PerspectiveCamera): RivalLighting[] {
    const c = camera.position;
    return this.lights.sort((a, b) => (a.x - c.x) ** 2 + (a.z - c.z) ** 2 - ((b.x - c.x) ** 2 + (b.z - c.z) ** 2));
  }

  /** 比赛结束、退出：对手的车停用并藏起来 */
  dispose(): void {
    for (const r of this.rivals) {
      r.vehicle.body.setEnabled(false);
      r.vehicle.hold = false;
      r.visual.root.visible = false;
      r.car = null;
    }
    if (this.field.player) this.field.player.vehicle.hold = false;
    this.markers.setVisible(false);
  }
}

export type { MarkerHost };
