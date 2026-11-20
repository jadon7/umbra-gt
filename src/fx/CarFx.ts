import * as THREE from 'three/webgpu';
import type { Car } from '../car/Car';
import { carLength } from '../car/models.ts';
import type { Vehicle } from '../drive/Vehicle.ts';
import { SkidMarks } from './SkidMarks.ts';
import { SmokeBatch } from './smoke.ts';
import { TailTrails } from './TailTrails.ts';
import { tailLampsFor } from './tailLamps.ts';
import type { CarModel } from '../car/models.ts';
import { SpeedLines } from './SpeedLines.ts';
import { SpriteBatch } from './SpriteBatch.ts';
import { FX_THEMES, type FxTheme } from './themes.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const MAX_PUFFS = 560;
const MAX_SPARKS = 200;
/** 每个排气口的喷焰由几个发光面片叠成 */
const FLAME_PARTS = 5;

interface Puff {
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  /** 涨到多大（相对初始大小的倍数） */
  grow: number;
  /** 0–1 的随机数：这一片取烟雾纹理上的哪一块，也用来错开各片的飘动 */
  seed: number;
  rot: number;
  spin: number;
  alpha: number;
  r: number;
  g: number;
  b: number;
}

/** 特效触发的事件：回火、碰撞、落地 */
export interface FxEvent {
  type: 'backfire' | 'collision' | 'landing';
  strength: number;
}

interface Spark {
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 0 = 拖着尾巴的火花；> 0 = 一团光（回火、闪光），数值是直径 */
  blob: number;
  floor: number;
  r: number;
  g: number;
  b: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
/** 落地、压过路肩扬起来的尘土的颜色 */
const DUST = new THREE.Color(0.6, 0.58, 0.55);

/**
 * 车的全部特效，按驾驶状态自动触发，没有按键。
 *
 * 画风是写实的：只做真车上会有的东西，颜色跟着特效配色走（themes.ts）的只有烟和喷焰。
 *
 * - 轮胎烟：轮胎打滑时从接地的地方冒出来，贴着地往后卷、再慢慢升起来散开。
 *   是几十上百片没有轮廓的软片叠成的一股，被太阳、路灯照亮，刹车时车尾那一截被尾灯染红。
 *   轮胎要滑一会儿烧热了烟才浓，蹭一下只有一点
 * - 尾灯拖光：猛加速、开氮气时，尾灯在身后拉出长长的红光，形状跟着这台车尾灯的形状走
 * - 氮气：点燃的一瞬间排气口一闪，然后喷出带亮芯的长焰；画面四周是往外飞的流光
 * - 落地：四个轮子压出一圈尘土，落得重的话底盘蹭出火花
 * - 碰撞：一下闪光，加上沿着被蹭的面飞溅的火花
 * - 胎痕、换挡和收油时的排气回火、重刹后刹车盘发红
 */
export class CarFx {
  /** 放进引擎的特效叠加层 */
  readonly fxGroup = new THREE.Group();
  /** 放进主场景（胎痕要贴着路面、被车挡住） */
  readonly sceneGroup = new THREE.Group();
  /** 喷焰的颜色 */
  readonly line = new THREE.Color(0.25, 0.7, 1.0);
  /** 烟的受光面颜色 */
  readonly smoke = new THREE.Color(0.9, 0.92, 0.96);
  /** 这一帧触发了哪些特效（声音跟着它们响）。使用方读完自己清空 */
  readonly events: FxEvent[] = [];

  readonly skid = new SkidMarks();
  readonly speedLines = new SpeedLines();
  /** 加速时尾灯在身后拖出的红光（每台车按自己尾灯的形状） */
  readonly trails = new TailTrails();

  private readonly smokeBatch: SmokeBatch;
  private readonly glowBatch: SpriteBatch;

  private readonly puffs: Puff[] = [];
  private readonly sparks: Spark[] = [];
  private readonly carry = [0, 0, 0, 0];
  /** 四个轮胎的温度 0–1：打滑时升温，不滑了慢慢凉。烟的多少跟着它 */
  private readonly tyreHeat = [0, 0, 0, 0];

  private time = 0;
  private lines = 0;
  private heat = 0;
  private wasNitro = false;
  private wasShifting = false;
  private lastThrottle = 0;
  private popCooldown = 0;
  private hitCooldown = 0;
  private landCooldown = 0;
  private trailLevel = 0;
  private trailGain = 1;
  /** 尾灯拖光现在用的是哪款车的尾灯形状 */
  private lampModel: CarModel | null = null;
  /** 氮气开了多久的平滑值 0–1：喷焰跟着它 */
  private boost = 0;
  private pendingPop = 0;
  private readonly tailPos = [new THREE.Vector3(), new THREE.Vector3()];

  /** @param airLight 地图提供的"空中一点被灯照到多亮"（着色器节点）：烟会被路灯照亮 */
  constructor(
    private readonly car: Car,
    airLight?: (p: N) => N,
  ) {
    this.smokeBatch = new SmokeBatch(MAX_PUFFS, airLight);
    this.glowBatch = new SpriteBatch(MAX_SPARKS + FLAME_PARTS * 2);

    // 画的先后：尾灯拖光 → 烟 → 发光的火花和喷焰 → 速度流光
    this.trails.mesh.renderOrder = 0;
    this.smokeBatch.object.renderOrder = 2;
    this.glowBatch.object.renderOrder = 5;
    this.fxGroup.add(this.trails.mesh, this.smokeBatch.object, this.glowBatch.object, this.speedLines.mesh);
    this.sceneGroup.add(this.skid.mesh);
    this.setTheme(FX_THEMES[0]);
  }

  /** 换一套特效配色 */
  setTheme(theme: FxTheme): void {
    this.smoke.setRGB(...theme.smoke);
    this.smokeBatch.shade.value.setRGB(...theme.smokeShade);
    this.line.setRGB(...theme.line);
    this.speedLines.tint.value.setRGB(...theme.line);
  }

  /**
   * 环境有多亮：烟是不发光的实体，白天亮、夜里暗（靠路灯和一点自发光撑着）。
   * @param night 0 白天，1 夜晚
   * @param keyDir 从地面指向太阳（月亮）的方向；keyColor 它的颜色乘亮度。没有主光的地图不给
   */
  setLighting(ambient: THREE.Color, night: number, keyDir?: THREE.Vector3, keyColor?: THREE.Color): void {
    this.smokeBatch.ambient.value.copy(ambient);
    this.smokeBatch.glow.value = 0.03 + 0.1 * night;
    this.trailGain = 0.5 + 0.5 * night;
    if (keyDir && keyColor) {
      this.smokeBatch.keyDir.value.copy(keyDir);
      this.smokeBatch.keyColor.value.copy(keyColor);
    }
  }

  /** 尾灯这会儿有多亮（刹车时最亮）：车尾的烟被它染红 */
  setTailGlow(glow: number): void {
    this.smokeBatch.tailGlow.value = glow;
  }

  /* ------------------------------ 生成 ------------------------------ */

  private puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, alpha = 0.4, grow = 5, color: THREE.Color = this.smoke): void {
    if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
    // 每一片的亮度略有不同，叠在一起才有深浅
    const k = rand(0.86, 1.06);
    this.puffs.push({
      age: 0,
      life,
      x,
      y,
      z,
      vx,
      vy,
      vz,
      size,
      grow,
      seed: Math.random(),
      rot: rand(0, Math.PI * 2),
      spin: rand(-0.35, 0.35),
      alpha,
      r: color.r * k,
      g: color.g * k,
      b: color.b * k,
    });
  }

  /**
   * @param blob 0 = 一粒拖着尾巴的火花；> 0 = 一团光，数值是直径
   * @param color 不给就是烧红的铁屑的颜色（白黄到橙）
   */
  private spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, floor: number, blob = 0, color: THREE.Color | null = null, gain = 1): void {
    if (this.sparks.length >= MAX_SPARKS) this.sparks.shift();
    if (color) {
      this.sparks.push({ age: 0, life, x, y, z, vx, vy, vz, blob, floor, r: color.r * gain, g: color.g * gain, b: color.b * gain });
      return;
    }
    // 火花刚蹦出来偏白黄，回火的光团偏橙
    const hot = blob > 0 ? 0.55 : rand(0.5, 1);
    this.sparks.push({ age: 0, life, x, y, z, vx, vy, vz, blob, floor, r: 4.5, g: 1.4 + hot * 1.8, b: 0.3 + hot * 0.7 });
  }

  /** 排气回火：排气口喷出一小团火光和几粒火星 */
  private backfire(carVel: THREE.Vector3, strength: number): void {
    this.events.push({ type: 'backfire', strength });
    for (const name of ['FX_Exhaust_L', 'FX_Exhaust_R']) {
      const a = this.car.anchors.get(name);
      if (!a) continue;
      a.getWorldPosition(_p);
      const bx = -_fwd.x;
      const bz = -_fwd.z;
      this.spark(_p.x + bx * 0.15, _p.y, _p.z + bz * 0.15, carVel.x + bx * 1.5, carVel.y, carVel.z + bz * 1.5, 0.11 + strength * 0.05, _p.y - 1, 0.45 + strength * 0.35);
      const n = 2 + Math.floor(strength * 4);
      for (let k = 0; k < n; k++) {
        this.spark(
          _p.x + bx * 0.2,
          _p.y,
          _p.z + bz * 0.2,
          carVel.x * 0.8 + bx * rand(2, 6) + rand(-1, 1),
          rand(-0.5, 1.5),
          carVel.z * 0.8 + bz * rand(2, 6) + rand(-1, 1),
          rand(0.15, 0.35),
          this.car.root.position.y + 0.03,
        );
      }
    }
  }

  private onCollision(v: Vehicle, carVel: THREE.Vector3): void {
    const impact = v.collisionImpact;
    this.events.push({ type: 'collision', strength: impact });
    const root = this.car.root;
    // 车速是往哪边突变的，撞上的东西就在反方向
    _d.copy(v.collisionDelta).setY(0);
    if (_d.lengthSq() < 1e-6) _d.copy(_fwd);
    _d.normalize().negate();
    const cl = _d.dot(_left);
    const cf = _d.dot(_fwd);
    // 把方向延伸到车身的外轮廓上：那就是蹭到的位置
    const reach = Math.min(1.02 / Math.max(Math.abs(cl), 1e-3), 2.3 / Math.max(Math.abs(cf), 1e-3));
    const x = root.position.x + (_left.x * cl + _fwd.x * cf) * reach;
    const y = root.position.y + 0.42;
    const z = root.position.z + (_left.z * cl + _fwd.z * cf) * reach;
    const n = Math.round(14 + impact * 36);
    // 火花贴着被蹭的那个面飞：沿着面往两头散开、往上蹦，只带一小部分车速
    // （墙是不动的，所以从车上看火花是往后甩的）。不能往车这一侧飞，否则全被车身挡住
    const tx = -_d.z;
    const tz = _d.x;
    for (let k = 0; k < n; k++) {
      const keep = rand(0.1, 0.55);
      const along = rand(-4.5, 4.5);
      const out = rand(-0.2, 0.9);
      this.spark(
        x + _d.x * 0.08 + tx * rand(-0.3, 0.3),
        y + rand(-0.3, 0.3),
        z + _d.z * 0.08 + tz * rand(-0.3, 0.3),
        carVel.x * keep + tx * along - _d.x * out,
        rand(0.5, 4.5) + impact * 2,
        carVel.z * keep + tz * along - _d.z * out,
        rand(0.45, 0.95),
        root.position.y + 0.03,
      );
    }
    // 撞上的那一下：一团很亮、一闪就没的光
    this.spark(x + _d.x * 0.1, y + 0.1, z + _d.z * 0.1, carVel.x * 0.6, 0, carVel.z * 0.6, 0.1 + impact * 0.06, y - 2, 1.6 + impact * 2.4);
  }

  private onLanding(v: Vehicle, carVel: THREE.Vector3): void {
    const impact = v.landingImpact;
    this.events.push({ type: 'landing', strength: impact });
    const root = this.car.root;
    // 四个轮子各压出一圈尘土，贴着地面往外翻
    for (const w of v.wheels) {
      for (let k = 0; k < 7; k++) {
        const a = rand(0, Math.PI * 2);
        const out = rand(1.5, 4.5) * (0.6 + impact);
        this.puff(w.contact.x, w.contact.y + 0.18, w.contact.z, carVel.x * 0.3 + Math.cos(a) * out, rand(0.2, 0.9), carVel.z * 0.3 + Math.sin(a) * out, rand(0.5, 0.8), rand(0.9, 1.5), 0.2 + impact * 0.1, 3.4, DUST);
      }
    }
    // 落得重的话底盘蹭地，冒一串火花
    if (impact > 0.5) {
      for (let k = 0; k < 26; k++) {
        this.spark(
          root.position.x + rand(-0.8, 0.8),
          root.position.y + 0.12,
          root.position.z + rand(-1.8, 1.8),
          carVel.x * rand(0.3, 0.8) + rand(-2.5, 2.5),
          rand(0.5, 3),
          carVel.z * rand(0.3, 0.8) + rand(-2.5, 2.5),
          rand(0.25, 0.6),
          root.position.y + 0.03,
        );
      }
    }
  }

  private onNitroStart(carVel: THREE.Vector3): void {
    // 点燃的一瞬间：车尾一下闪光，排气口喷出一团火和火星
    const root = this.car.root;
    _p.set(0, 0.45, -carLength(this.car.model) * 0.5 - 0.15).applyMatrix4(root.matrixWorld);
    this.spark(_p.x, _p.y, _p.z, carVel.x, carVel.y, carVel.z, 0.14, _p.y - 2, 2.2, this.line, 2.6);
    this.backfire(carVel, 1);
  }

  /** 下一帧来一下排气回火（赛前镜头里轰完油门松开的那一下） */
  pop(strength = 1): void {
    this.pendingPop = strength;
  }

  /* ------------------------------ 每帧 ------------------------------ */

  /**
   * @param throttle 油门 0–1（收油时触发回火）
   * @param wetness 路面有多湿（或者积了多少雪）0–1：湿了以后没有轮胎烟，也留不下胎痕
   */
  update(dt: number, v: Vehicle, throttle: number, camera: THREE.Camera, wetness: number): void {
    const root = this.car.root;
    root.updateMatrixWorld(true);
    this.time += dt;
    const now = this.time;
    _fwd.set(0, 0, 1).applyQuaternion(root.quaternion);
    _left.set(1, 0, 0).applyQuaternion(root.quaternion);
    _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const lv = v.body.linvel();
    const carVel = _vel.set(lv.x, lv.y, lv.z);
    const speed = Math.hypot(lv.x, lv.z);
    const dryness = 1 - clamp(wetness * 1.4, 0, 1);

    /* ---- 触发 ---- */
    if (this.pendingPop > 0) {
      this.backfire(carVel, this.pendingPop);
      this.pendingPop = 0;
    }
    this.hitCooldown -= dt;
    this.landCooldown -= dt;
    this.popCooldown -= dt;
    if (v.collisionImpact > 0.1 && this.hitCooldown <= 0) {
      this.onCollision(v, carVel);
      this.hitCooldown = 0.12;
    }
    if (v.landingImpact > 0.2 && this.landCooldown <= 0) {
      this.onLanding(v, carVel);
      this.landCooldown = 0.4;
    }
    if (v.nitroActive && !this.wasNitro) this.onNitroStart(carVel);
    this.wasNitro = v.nitroActive;
    this.boost += ((v.nitroActive ? 1 : 0) - this.boost) * (1 - Math.exp(-dt * (v.nitroActive ? 12 : 5)));
    const revs = v.rpm / v.cfg.redline;
    // 回火：高转速升挡的一瞬间，或者高转速突然收油
    if (v.shifting && !this.wasShifting && v.gear >= 2 && revs > 0.55 && this.popCooldown <= 0) {
      this.backfire(carVel, 0.6);
      this.popCooldown = 0.25;
    }
    this.wasShifting = v.shifting;
    if (throttle < 0.1 && this.lastThrottle > 0.6 && revs > 0.78 && this.popCooldown <= 0) {
      this.backfire(carVel, 0.9);
      this.popCooldown = 0.35;
    }
    this.lastThrottle = throttle;

    /* ---- 轮胎烟 ---- */
    // 打滑的轮子连续地冒烟（后轮为主，前轮要滑得很厉害才冒）。
    // 轮胎得先烧热：刚开始滑只有淡淡一点，持续滑上半秒烟才浓起来；不滑了胎温慢慢降下去
    for (let k = 0; k < 4; k++) {
      const w = v.wheels[k];
      const need = k >= 2 ? 0.3 : 0.55;
      let burn = 0;
      if (w.grounded && w.skid >= need) {
        // 横着滑才是大烟；轮子只是在原地空转（起步、高速时猛给油）的话，车速越高烟越少
        const sideways = smooth(0.08, 0.28, Math.abs(w.slipAngle));
        const launch = 1 - smooth(6, 24, speed);
        burn = ((w.skid - need) / (1 - need)) * Math.max(sideways, launch);
      }
      const heat = this.tyreHeat[k] + (burn - this.tyreHeat[k]) * (1 - Math.exp(-dt * (burn > this.tyreHeat[k] ? 3.2 : 1.1)));
      this.tyreHeat[k] = heat;
      const amount = Math.min(burn, heat * 1.15);
      if (dryness < 0.15 || amount < 0.05 || dt <= 0) {
        this.carry[k] = 0;
        continue;
      }
      this.carry[k] += (k >= 2 ? 62 : 30) * (0.25 + 0.75 * amount) * dryness * dt;
      // 驱动轮空转时，轮胎表面在往后刨：烟先被往后甩出去一段
      const flung = clamp(w.omega * v.cfg.wheelRadius - v.forwardSpeed, 0, 14) * 0.16;
      while (this.carry[k] >= 1) {
        this.carry[k] -= 1;
        // 烟从轮胎接地的地方出来：先贴着地往后、往两边卷，再升起来
        const side = rand(-1, 1);
        this.puff(
          w.contact.x + rand(-0.16, 0.16) - _fwd.x * 0.2,
          w.contact.y + rand(0.1, 0.24),
          w.contact.z + rand(-0.16, 0.16) - _fwd.z * 0.2,
          carVel.x * 0.14 + _left.x * side * 0.9 - _fwd.x * flung + rand(-0.4, 0.4),
          rand(0.25, 1.0),
          carVel.z * 0.14 + _left.z * side * 0.9 - _fwd.z * flung + rand(-0.4, 0.4),
          rand(0.42, 0.62) + amount * 0.22,
          rand(2.3, 3.6),
          0.34 + 0.24 * amount,
          rand(4.6, 6.4),
        );
      }
    }
    const smoke = this.smokeBatch;
    let n = 0;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.puffs.splice(i, 1);
        continue;
      }
      // 空气阻力很大：很快慢下来，悬在原地一边涨大一边往上飘；被一点侧风带着走，还有些乱流
      const drag = Math.exp(-dt * 2.6);
      p.vx *= drag;
      p.vz *= drag;
      p.vy += (0.5 - p.vy) * (1 - Math.exp(-dt * 1.2));
      const swirl = p.seed * 40;
      p.x += (p.vx + 0.35 + Math.sin(now * 1.3 + swirl) * 0.22) * dt;
      p.y += p.vy * dt;
      p.z += (p.vz + 0.2 + Math.cos(now * 1.1 + swirl * 1.7) * 0.22) * dt;
      p.rot += p.spin * dt;
    }
    for (const p of this.puffs) {
      const t = p.age / p.life;
      const swell = 1 + p.grow * (1 - Math.pow(1 - t, 2.4));
      // 同样多的烟摊到越来越大的一片里，自然越来越薄；最后一小段再整体淡出去
      const alpha = Math.min(1, p.age / 0.09) * (p.alpha / (1 + 1.5 * (swell - 1) * 0.42)) * (1 - smooth(0.72, 1, t));
      const erode = 0.02 + 0.5 * Math.pow(t, 1.5);
      smoke.set(n++, p.x, p.y, p.z, p.size * swell, p.rot, alpha, erode, p.r, p.g, p.b, p.seed);
    }
    for (let i = n; i < smoke.capacity; i++) smoke.hide(i);
    smoke.commit();

    /* ---- 氮气喷焰 ---- */
    const glow = this.glowBatch;
    const boost = this.boost;
    const lc = this.line;
    ['FX_Exhaust_L', 'FX_Exhaust_R'].forEach((name, k) => {
      const base = MAX_SPARKS + k * FLAME_PARTS;
      const a = this.car.anchors.get(name);
      if (!a || boost < 0.02) {
        for (let i = 0; i < FLAME_PARTS; i++) glow.hide(base + i);
        return;
      }
      a.getWorldPosition(_p);
      // 火焰朝车尾喷。它在画面上有多长，取决于车尾方向和视线的夹角：正后方看过去只剩一小截
      const bx = -_fwd.dot(_camRight);
      const by = -_fwd.dot(_camUp);
      const beta = Math.atan2(by, bx);
      const seen = Math.hypot(bx, by);
      const ux = _camRight.x * Math.cos(beta) + _camUp.x * Math.sin(beta);
      const uy = _camRight.y * Math.cos(beta) + _camUp.y * Math.sin(beta);
      const uz = _camRight.z * Math.cos(beta) + _camUp.z * Math.sin(beta);
      // 抖动：几个不成倍数的频率叠起来，看不出循环
      const flick = 0.86 + 0.09 * Math.sin(now * 53 + k * 2.1) + 0.07 * Math.sin(now * 31.7 + k) + 0.05 * Math.sin(now * 97.3);
      const len = 2.6 * (0.28 + 0.72 * seen) * flick * boost;
      // 外焰：一道长的、带颜色的光
      glow.set(base, _p.x + ux * len * 0.46, _p.y + uy * len * 0.46, _p.z + uz * len * 0.46, len, 0.5 * boost, beta, 1, lc.r * 2.4, lc.g * 2.4, lc.b * 2.4);
      // 内焰：短一截、细得多、接近白色
      const inner = len * 0.55;
      glow.set(base + 1, _p.x + ux * inner * 0.46, _p.y + uy * inner * 0.46, _p.z + uz * inner * 0.46, inner, 0.2 * boost, beta, 1, 2.2 + lc.r * 1.6, 2.2 + lc.g * 1.6, 2.2 + lc.b * 1.6);
      // 喷口的一团光：从正后方看，火焰缩成一小截，靠它撑住
      const mouth = (0.75 + 0.5 * seen) * flick * boost;
      glow.set(base + 2, _p.x, _p.y, _p.z, mouth, mouth, 0, 1, lc.r * 2.2 + 0.2, lc.g * 2.2 + 0.2, lc.b * 2.2 + 0.2);
      // 焰里的两个亮节（高速气流里一明一暗的那种纹）
      for (let j = 0; j < 2; j++) {
        const at = len * (0.26 + j * 0.24) * (1 + 0.06 * Math.sin(now * 40 + j * 3 + k));
        glow.set(base + 3 + j, _p.x + ux * at, _p.y + uy * at, _p.z + uz * at, 0.34 * boost, 0.26 * boost, beta, 1, 2.4, 2.4, 2.6);
      }
    });

    /* ---- 火花 ---- */
    n = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.sparks.splice(i, 1);
        continue;
      }
      if (s.blob === 0) s.vy -= 9.8 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      // 落地弹一下
      if (s.blob === 0 && s.y < s.floor && s.vy < 0) {
        s.y = s.floor;
        s.vy *= -0.35;
        s.vx *= 0.7;
        s.vz *= 0.7;
      }
    }
    for (const s of this.sparks) {
      const t = s.age / s.life;
      const fade = 1 - t * t;
      if (s.blob > 0) {
        const size = s.blob * (0.9 + t * 1.35);
        glow.set(n++, s.x, s.y, s.z, size, size, 0, fade, s.r, s.g, s.b);
      } else {
        // 火花相对镜头在往哪飞，就沿那个方向拉成一道
        const rx = s.vx - carVel.x * 0.9;
        const ry = s.vy;
        const rz = s.vz - carVel.z * 0.9;
        const px = rx * _camRight.x + ry * _camRight.y + rz * _camRight.z;
        const py = rx * _camUp.x + ry * _camUp.y + rz * _camUp.z;
        // 细长的一道（宽度只有两三厘米）：粗了就成了一粒粒发光的米
        const len = clamp(Math.hypot(px, py) * 0.07, 0.16, 1.5);
        glow.set(n++, s.x, s.y, s.z, len, 0.034, Math.atan2(py, px), fade * 1.6, s.r, s.g * (1 - t * 0.5), s.b * (1 - t));
      }
    }
    for (let i = n; i < MAX_SPARKS; i++) glow.hide(i);
    glow.commit();

    /* ---- 尾灯拖光 ---- */
    // 只在加速的时候有：开氮气最亮，猛踩油门往前窜的时候拉出来；匀速跑、刹车时没有
    if (this.car.model !== this.lampModel) {
      // 换了车：换上这台车自己的尾灯形状
      this.lampModel = this.car.model;
      this.trails.setLamps(tailLampsFor(this.car));
      this.trails.clear();
    }
    const accel = smooth(0.3, 0.62, v.longG) * smooth(6, 16, speed) * 0.85;
    const trailTarget = v.nitroActive ? 1 : accel;
    this.trailLevel += (trailTarget - this.trailLevel) * (1 - Math.exp(-dt * (trailTarget > this.trailLevel ? 9 : 3.5)));
    // 白天尾灯在阳光下不显眼，拖出来的光也淡一些
    this.trails.update(root, this.trailLevel * this.trailGain);
    const tl = this.car.anchors.get('FX_Taillight_L');
    const tr = this.car.anchors.get('FX_Taillight_R');
    if (tl && tr) {
      tl.getWorldPosition(this.tailPos[0]);
      tr.getWorldPosition(this.tailPos[1]);
      this.smokeBatch.tailPos.value.copy(this.tailPos[0]).add(this.tailPos[1]).multiplyScalar(0.5);
    }

    /* ---- 速度流光、胎痕、刹车盘 ---- */
    const target = Math.max(v.nitroActive ? 1 : 0, smooth(46, 70, speed) * 0.55);
    this.lines += (target - this.lines) * (1 - Math.exp(-dt * 7));
    this.speedLines.set(this.lines);

    this.skid.strength.value = 0.25 + 0.75 * dryness;
    this.skid.update(v.wheels, _left, dryness);

    const braking = v.braking ? Math.min(1, speed / 38) : 0;
    // 重刹大约两秒烧到最红，松开后七八秒凉下来
    this.heat = clamp(this.heat + (braking * 0.75 - this.heat * 0.2 - 0.03) * dt, 0, 1);
    this.car.setBrakeHeat(this.heat);
  }

  /** 复位、离开试驾时：清掉飞在空中的特效，断开胎痕（已经留在地上的不动） */
  reset(): void {
    this.puffs.length = 0;
    this.sparks.length = 0;
    this.carry.fill(0);
    this.tyreHeat.fill(0);
    this.lines = 0;
    this.trailLevel = 0;
    this.boost = 0;
    this.trails.clear();
    this.speedLines.set(0);
    this.smokeBatch.hideAll();
    this.glowBatch.hideAll();
    this.smokeBatch.commit();
    this.glowBatch.commit();
    this.skid.lift();
    this.wasNitro = false;
  }

  /** 离开试驾：连刹车盘的余温也清掉 */
  off(): void {
    this.reset();
    this.heat = 0;
    this.car.setBrakeHeat(0);
  }
}
