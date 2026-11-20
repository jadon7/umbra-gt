import { Quaternion, Vector3 } from 'three';
import { RAPIER, type PhysicsWorld } from './PhysicsWorld.ts';
import { DEFAULT_CONFIG, type VehicleConfig } from './VehicleConfig.ts';

/** 一帧的驾驶输入。steer：+1 向左打满，-1 向右打满 */
export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  nitro: boolean;
}

export const NO_INPUT: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };

export interface WheelState {
  grounded: boolean;
  /** 轮心相对静止位置的上下偏移（正值 = 向上压缩） */
  travel: number;
  /** 法向载荷（牛） */
  load: number;
  slipAngle: number;
  /** 打滑强度 0–1：胎烟、胎痕、胎噪都读这个值 */
  skid: number;
  /** 累计滚动角（弧度） */
  spin: number;
  omega: number;
  steer: number;
  /** 接地点（世界坐标） */
  contact: Vector3;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const moveToward = (v: number, target: number, maxDelta: number) =>
  Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta;

/**
 * 侧向力曲线（按"侧偏角 / 峰值侧偏角"归一化）：
 * 先平滑升到峰值 1，过峰后回落到 slideRatio。过峰后的回落就是车能甩起来的原因。
 */
function lateralCurve(x: number, slideRatio: number): number {
  const a = Math.abs(x);
  const s = Math.sign(x);
  if (a <= 1) return s * (1.5 * a - 0.5 * a * a * a);
  return s * (slideRatio + (1 - slideRatio) * Math.exp(-(a - 1) * 1.1));
}

const QUERY_FLAGS = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;

// 复用的临时量，避免每步分配
const _pos = new Vector3();
const _quat = new Quaternion();
const _fwd = new Vector3();
const _up = new Vector3();
const _left = new Vector3();
const _vel = new Vector3();
const _ang = new Vector3();
const _mount = new Vector3();
const _n = new Vector3();
const _f = new Vector3();
const _s = new Vector3();
const _vc = new Vector3();
const _force = new Vector3();
const _point = new Vector3();
const _tmp = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * 街机取向的车辆物理。
 *
 * 车身是一个 Rapier 刚体（负责碰撞和积分）；悬挂是四根射线弹簧，
 * 轮胎力按侧偏角曲线 + 摩擦椭圆自己算，再作为外力加到刚体上。
 * 在此之上叠了几层辅助：偏航稳定、漂移状态（自动反打、角度限制）、腾空姿态稳定。
 */
export class Vehicle {
  cfg: VehicleConfig;
  readonly body: RAPIER.RigidBody;
  readonly wheels: WheelState[] = [];

  /* 对外状态 */
  speed = 0; // 米/秒
  forwardSpeed = 0;
  rpm = 1000;
  /** 1..n 前进挡，-1 倒挡 */
  gear = 1;
  nitro = 1;
  nitroActive = false;
  drifting = false;
  /** 车身侧滑角（弧度，正值 = 车头指向行进方向的右侧） */
  sideSlip = 0;
  lateralG = 0;
  longG = 0;
  groundedCount = 4;
  airTime = 0;
  braking = false;
  reversing = false;
  shifting = false;
  /** 落地冲击 0–1（镜头震动读取后清零） */
  landingImpact = 0;
  /** 碰撞冲击 0–1（同上） */
  collisionImpact = 0;
  /** 最近一次碰撞让车速突变了多少（世界坐标）。撞到的东西在它的反方向，火花从那一侧冒出来 */
  readonly collisionDelta = new Vector3();
  steerAngle = 0;
  /**
   * 发车前的状态：踩住刹车、离合分离。油门只带动转速（可以轰油门），车不会动。
   * 比赛倒计时的时候打开
   */
  hold = false;
  /** 路面抓地系数：干地、湿地是 1，积雪时小于 1。由外面按天气设置 */
  surfaceGrip = 1;

  private readonly world: RAPIER.World;
  private readonly mounts: Vector3[] = [];
  private readonly springK: number[] = [];
  private readonly dampBump: number[] = [];
  private readonly dampRebound: number[] = [];
  private readonly xFree: number[] = [];
  private readonly staticLoad: number[] = [];
  private travelTotal = 0;
  private wheelbase = 0;
  private collider: RAPIER.Collider | null = null;

  private steerInput = 0;
  private shiftTimer = 0;
  private kickTimer = 0;
  /** 漂移意图的有效期：手刹或点刹后的一小段时间内，侧滑才会被认定为漂移 */
  private driftArm = 0;
  /** 漂移方向：+1 向左，-1 向右 */
  private driftDir = 1;
  /** "往弯里打多少"的平滑值，-1..1 */
  private driftLine = 0;
  /** 目标侧滑角（带符号） */
  private driftTarget = 0;
  /** 进入/退出漂移的过渡系数 0..1 */
  private driftBlend = 0;
  private driftOff = 0;
  private driftNeutral = 0;
  private prevBeta = 0;
  private betaRate = 0;
  private prevBrake = false;
  private prevForward = 0;
  private upsideDownTime = 0;
  private readonly prevVel = new Vector3();

  constructor(physics: PhysicsWorld, cfg: VehicleConfig = DEFAULT_CONFIG) {
    this.cfg = cfg;
    this.world = physics.world;

    this.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true));
    for (let i = 0; i < 4; i++) {
      this.wheels.push({ grounded: true, travel: 0, load: 0, slipAngle: 0, skid: 0, spin: 0, omega: 0, steer: 0, contact: new Vector3() });
    }
    this.configure(cfg);
  }

  /**
   * 换一套调校（换车型的时候用）：质量、碰撞外形、车轮位置、悬挂全部按新参数重算。
   * 不改变车现在的位置和速度。
   */
  configure(cfg: VehicleConfig): void {
    this.cfg = cfg;
    this.body.setAdditionalMassProperties(
      cfg.mass,
      { x: cfg.com[0], y: cfg.com[1], z: cfg.com[2] },
      { x: cfg.inertia[0], y: cfg.inertia[1], z: cfg.inertia[2] },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    if (this.collider) this.world.removeCollider(this.collider, true);
    const round = 0.12;
    const colDesc = RAPIER.ColliderDesc.roundCuboid(cfg.bodyHalf[0] - round, cfg.bodyHalf[1] - round, cfg.bodyHalf[2] - round, round)
      .setTranslation(cfg.bodyCenter[0], cfg.bodyCenter[1], cfg.bodyCenter[2])
      .setDensity(0)
      .setFriction(0.08)
      .setRestitution(0.12)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    this.collider = this.world.createCollider(colDesc, this.body);

    // 悬挂参数由固有频率和静载荷推出，保证静止时车身正好落在模型的原始高度
    this.travelTotal = cfg.suspBump + cfg.suspDroop;
    const zFront = cfg.wheelPos[0][2];
    const zRear = cfg.wheelPos[2][2];
    this.wheelbase = zFront - zRear;
    const frontShare = (cfg.com[2] - zRear) / this.wheelbase;
    this.mounts.length = 0;
    this.springK.length = 0;
    this.dampBump.length = 0;
    this.dampRebound.length = 0;
    this.xFree.length = 0;
    this.staticLoad.length = 0;
    for (let i = 0; i < 4; i++) {
      const p = cfg.wheelPos[i];
      const front = i < 2;
      const load = (cfg.mass * 9.81 * (front ? frontShare : 1 - frontShare)) / 2;
      const cornerMass = load / 9.81;
      const w = 2 * Math.PI * (front ? cfg.suspFreqFront : cfg.suspFreqRear);
      const k = w * w * cornerMass;
      const crit = 2 * Math.sqrt(k * cornerMass);
      this.mounts.push(new Vector3(p[0], p[1] + cfg.suspBump, p[2]));
      this.springK.push(k);
      this.dampBump.push(crit * cfg.suspDampBump);
      this.dampRebound.push(crit * cfg.suspDampRebound);
      this.xFree.push(cfg.suspDroop - load / k);
      this.staticLoad.push(load);
      this.wheels[i].load = load;
    }
  }

  /** 把车放到指定位置，车头朝向 yaw（绕 Y 轴，0 = +Z） */
  reset(x: number, y: number, z: number, yaw: number): void {
    const q = new Quaternion().setFromAxisAngle(WORLD_UP, yaw);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.gear = 1;
    this.rpm = this.cfg.idleRpm;
    this.steerInput = 0;
    this.steerAngle = 0;
    this.drifting = false;
    this.reversing = false;
    this.shiftTimer = 0;
    this.kickTimer = 0;
    this.driftArm = 0;
    this.driftBlend = 0;
    this.driftLine = 0;
    this.driftTarget = 0;
    this.prevBeta = 0;
    this.betaRate = 0;
    this.airTime = 0;
    this.upsideDownTime = 0;
    this.prevForward = 0;
    this.prevVel.set(0, 0, 0);
    for (const w of this.wheels) {
      w.omega = 0;
      w.skid = 0;
      w.travel = 0;
    }
  }

  /** 是否翻车超过 2 秒（调用方据此自动复位） */
  get stuckUpsideDown(): boolean {
    return this.upsideDownTime > 2;
  }

  private torqueAt(rpm: number): number {
    const c = this.cfg.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
      }
    }
    return c[c.length - 1][1];
  }

  /** 推进一个物理步：计算并施加这一步的所有外力。调用后由外部执行 world.step() */
  step(input: DriveInput, dt: number): void {
    const c = this.cfg;
    const body = this.body;
    const R = c.wheelRadius;

    /* ---------- 当前状态 ---------- */
    const t = body.translation();
    const r = body.rotation();
    _pos.set(t.x, t.y, t.z);
    _quat.set(r.x, r.y, r.z, r.w);
    _fwd.set(0, 0, 1).applyQuaternion(_quat);
    _up.set(0, 1, 0).applyQuaternion(_quat);
    _left.set(1, 0, 0).applyQuaternion(_quat);
    const lv = body.linvel();
    _vel.set(lv.x, lv.y, lv.z);
    const av = body.angvel();
    _ang.set(av.x, av.y, av.z);

    // 上一步的碰撞冲击：速度突变超出轮胎和引擎能给的量，就是撞到东西了
    const dv = _tmp.copy(_vel).sub(this.prevVel).length();
    if (dv > 0.7) {
      const impact = clamp((dv - 0.7) / 7, 0, 1);
      if (impact >= this.collisionImpact) {
        this.collisionImpact = impact;
        this.collisionDelta.copy(_tmp);
      }
    }

    const vF = _vel.dot(_fwd);
    const vL = _vel.dot(_left);
    const planar = Math.hypot(vF, vL);
    const yawRate = _ang.dot(_up);
    this.speed = _vel.length();
    this.forwardSpeed = vF;

    /* ---------- 油门 / 刹车 / 倒车 ---------- */
    const throttleIn = clamp(input.throttle, 0, 1);
    const brakeIn = clamp(input.brake, 0, 1);
    if (this.reversing) {
      if (throttleIn > 0.1 && brakeIn < 0.1 && vF > -1.5) {
        this.reversing = false;
        this.gear = 1;
      }
    } else if (brakeIn > 0.1 && throttleIn < 0.1 && vF < 0.8 && this.groundedCount > 0) {
      this.reversing = true;
    }
    let driveCmd = this.reversing ? brakeIn * 0.55 : throttleIn;
    let brakeCmd = this.reversing ? throttleIn : brakeIn;
    this.braking = brakeIn > 0.05 && !this.reversing;
    if (this.hold) {
      this.reversing = false;
      driveCmd = throttleIn;
      brakeCmd = 1;
    }

    /* ---------- 漂移状态 ---------- */
    const beta = vF > 2 ? Math.atan2(vL, vF) : 0;
    this.sideSlip = beta;
    const betaRateRaw = (beta - this.prevBeta) / dt;
    this.betaRate += (betaRateRaw - this.betaRate) * (1 - Math.exp(-dt * 30));
    this.prevBeta = beta;

    // 漂移必须由玩家明确发起（手刹，或带方向点一脚刹车）。
    // 没有意图时出现的侧滑一律当成失控，由后面的辅助救回来。
    const steerIn = clamp(input.steer, -1, 1);
    const brakePressed = brakeCmd > 0.5;
    if (brakePressed && !this.prevBrake && Math.abs(steerIn) > 0.35 && vF > 14) {
      this.kickTimer = 0.35;
      this.driftArm = 0.8;
    }
    this.prevBrake = brakePressed;
    this.kickTimer = Math.max(0, this.kickTimer - dt);
    if (input.handbrake && vF > 8) this.driftArm = 0.8;
    this.driftArm = Math.max(0, this.driftArm - dt);

    const onPower = driveCmd > 0.15 || input.handbrake || (input.nitro && this.nitro > 0.01);
    if (!this.drifting) {
      // 两种进法：带着方向拉手刹，立刻开始漂（不等车身先滑出角度）；或者点刹之后车身滑出了角度
      const yank = input.handbrake && Math.abs(steerIn) > 0.3 && vF > 9;
      const slid = this.driftArm > 0 && Math.abs(beta) > c.driftEnter && planar > 11;
      if ((yank || slid) && this.groundedCount >= 2) {
        this.drifting = true;
        // 侧滑角为负 = 车头指向行进方向左侧 = 向左漂
        this.driftDir = yank ? Math.sign(steerIn) : beta < 0 ? 1 : -1;
        this.driftLine = clamp(steerIn * this.driftDir, 0, 1) * 0.6;
        this.driftOff = 0;
        this.driftNeutral = 0;
      }
    } else {
      // 方向盘在漂移里的含义："往弯里打多少"。+1 = 打满收紧，-1 = 反打到底放宽
      const into = clamp(steerIn * this.driftDir, -1, 1);
      // 平滑一下，键盘点按也能得到中间值，线路才调得细
      // 收紧（往弯里打）响应得柔一些，放宽（反打）响应得快一些：前者要细腻，后者要救得回来
      // 松开方向、反打都是"我要收车了"：这时候跟得很快，不拖泥带水
      const letGo = Math.abs(steerIn) < 0.15 || into < 0;
      const lineRate = into > this.driftLine ? c.driftLineRate : letGo ? c.driftLineRate * 5 : c.driftLineRate * 2;
      this.driftLine += (into - this.driftLine) * (1 - Math.exp(-dt * lineRate));
      this.driftOff = onPower ? 0 : this.driftOff + dt;
      this.driftNeutral = Math.abs(steerIn) < 0.15 ? this.driftNeutral + dt : 0;

      if (input.handbrake && into < -0.3 && planar > 9) {
        // 漂移中反着方向再拉一把手刹：甩到另一侧去（连续的 S 弯）。
        // 只反打不拉手刹不会甩过去——反打就是收车，按住不放也只是正常地往那边拐
        this.driftDir = -this.driftDir;
        this.driftLine = 0.6;
        this.driftNeutral = 0;
      } else if (planar < 7) {
        this.drifting = false;
      } else if (Math.abs(beta) < c.driftExit && Math.abs(this.driftTarget) < c.driftExit * 1.5) {
        // 角度已经收到零附近：漂移结束，轮胎重新抓地
        this.drifting = false;
      }
    }

    // 漂移分三层：
    //   方向盘决定车身甩出多大的角度——松开方向保持中等角度，往弯里打角度更大，反打角度收小；拉着手刹角度最大。
    //   车身实际甩出了多大角度，决定行进路线每秒往弯里拐多少——拐多快和车速无关，高速进弯一样拐得动。
    //   角度要收小的时候（反打、松油、松开方向），不是把车头摆回去，而是让路线追上车头：车头指到哪，车就往哪走。
    // 松油超过半秒，或者长时间不碰方向盘，车会自己慢慢收直。
    let driftLat = 0;
    /** 行进路线正常往弯里拐的角速度（弧度/秒）、为了追上车头额外加的角速度 */
    let driftTurn = 0;
    let driftCatch = 0;
    if (this.drifting) {
      const p = this.driftLine;
      // 松开方向马上开始收车、大半秒收完：想接着漂就得一直往弯里带着方向（键盘点按也算），
      // 一松手车就顺着车头指的方向走直
      // 反打不用打到底：只要往反方向带了四分之一以上，目标角度就是零（手柄轻轻反推一下也能收车，
      // 不会留着十几度的小角度一直漂）。想放宽弧线，把往弯里打的方向收小就行。
      // 踩刹车（不带手刹）也是收车：立刻把目标角度放到零
      const fade = this.driftOff > 0.3 || (brakeCmd > 0.3 && !input.handbrake) ? 0 : 1 - smoothstep(0.0, 0.25, this.driftNeutral);
      const hold = c.driftAngleHold * fade;
      let ang = p >= 0 ? hold + (c.driftAngleMax - hold) * p * (fade > 0 || Math.abs(steerIn) > 0.15 ? 1 : 0) : hold * clamp(1 + p * 4, 0, 1);
      if (input.handbrake && p > -0.3) ang = Math.max(ang, c.driftAngleBrake);
      this.driftTarget = -this.driftDir * ang;
      // 只算朝着漂移方向甩出去的角度；甩反了（正在换向）不给向心力。
      // 车身甩到位要三四分之一秒，这段时间里路线不能等着：先按目标角度的一部分给，
      // 一拉手刹路线就开始往弯里走，而不是先横着往前滑一段
      const out = Math.max(clamp(-beta * this.driftDir, 0, 1.4), ang * c.driftLead);
      const k = clamp(Math.sin(out) / Math.sin(c.driftAngleMax), 0, 1.15);
      const cap = (c.driftLatMax * 9.81 * this.surfaceGrip) / Math.max(planar, 6);
      // 车身甩过了目标角度多少：这部分要靠路线追上来消掉
      const over = clamp(-beta * this.driftDir - ang, 0, 1.2);
      const closing = smoothstep(0.0, 0.1, over);
      // 收车时角度是两头一起收的：行进方向往车头那边追（driftNoseShare 那么多），车头同时往回摆（剩下的）
      driftCatch = Math.min(over * c.driftAlign * c.driftNoseShare, cap * 1.6);
      // 收车的时候不再接着往弯里拐：松手就是「别再转了」
      driftTurn = Math.min(c.driftTurnMax * Math.pow(k, c.driftLatCurve), cap) * (1 - closing);
      driftLat = (driftTurn + driftCatch) * planar;
    } else {
      this.driftTarget = 0;
    }
    this.driftBlend += ((this.drifting ? 1 : 0) - this.driftBlend) * (1 - Math.exp(-dt * (this.drifting ? 6 : 4)));

    let rearGrip = 1;
    if (this.drifting) rearGrip = c.driftRearGrip;
    else if (this.driftArm <= 0) rearGrip = 1 + 0.35 * clamp(Math.abs(beta) / 0.3, 0, 1);
    if (this.kickTimer > 0) rearGrip *= 0.55;

    /* ---------- 转向 ---------- */
    const returning = Math.abs(steerIn) < Math.abs(this.steerInput) || steerIn * this.steerInput < 0;
    this.steerInput = moveToward(this.steerInput, steerIn, (returning ? c.steerReturn : c.steerRate) * dt);
    const maxSteer = c.steerMin + (c.steerMax - c.steerMin) / (1 + Math.pow(Math.abs(vF) / c.steerSpeedRef, 1.7));
    let steer = this.steerInput * maxSteer;
    if (this.drifting) {
      // 漂移中方向盘给得更多，并自动把前轮朝行进方向反打一部分
      steer = this.steerInput * Math.max(maxSteer, 0.3) + beta * c.driftCounterSteer;
    }
    steer = clamp(steer, -c.steerMax, c.steerMax);
    this.steerAngle = steer;

    /* ---------- 引擎与变速箱 ---------- */
    if (!this.reversing && this.gear < 1) this.gear = 1;
    const ratio = this.reversing ? -c.reverseGear : c.gears[this.gear - 1];
    const rawRpm = Math.abs((vF / R) * 9.5493 * ratio * c.finalDrive);
    // 一挡 / 倒挡起步时离合打滑：转速不跟车速，按油门拉起来
    // 被刹在发车格上的时候（离合分离）可以把转速轰得更高；起步之后还是原来的数
    const launch = c.idleRpm + driveCmd * (this.hold ? 4900 : 3400);
    const engineRpm = this.gear === 1 || this.reversing ? Math.max(rawRpm, launch) : Math.max(rawRpm, c.idleRpm);

    this.nitroActive = input.nitro && this.nitro > 0.01 && !this.reversing && !this.hold;
    if (this.nitroActive) driveCmd = 1;

    let torque = this.torqueAt(engineRpm) * driveCmd;
    if (engineRpm >= c.redline) torque = 0;
    if (this.shiftTimer > 0) {
      torque *= 0.1;
      this.shiftTimer -= dt;
    }
    this.shifting = this.shiftTimer > 0;
    if (this.nitroActive) torque *= 1 + c.nitroTorqueBoost;

    let driveForce = (torque * ratio * c.finalDrive * c.driveEfficiency) / R;
    if (this.nitroActive) driveForce += c.nitroForce;
    if (this.reversing && vF < -15) driveForce = 0;
    // 收油时的发动机制动
    if (driveCmd < 0.05 && Math.abs(vF) > 1) driveForce -= Math.sign(vF) * c.engineBrake * clamp(engineRpm / c.redline, 0, 1);
    // 漂移中后轮在横着滑，能用来往前推的抓地要打折
    driveForce *= 1 - (1 - c.driftDrive) * this.driftBlend;
    if (this.hold) driveForce = 0;

    // 自动换挡
    if (!this.reversing && this.shiftTimer <= 0 && this.groundedCount >= 2) {
      const n = c.gears.length;
      if (rawRpm > c.shiftUpRpm && this.gear < n && driveCmd > 0.2) {
        this.gear++;
        this.shiftTimer = c.shiftTime;
      } else if (this.gear > 1) {
        const lowerRpm = (rawRpm * c.gears[this.gear - 2]) / c.gears[this.gear - 1];
        const kickdown = driveCmd > 0.85 && lowerRpm < c.shiftUpRpm - 900;
        if (rawRpm < c.shiftDownRpm || kickdown) {
          this.gear--;
          this.shiftTimer = c.shiftTime * 0.7;
        }
      }
    }
    if (this.reversing) this.gear = -1;
    this.rpm += (Math.min(engineRpm, c.redline) - this.rpm) * (1 - Math.exp(-dt * 16));

    // 氮气：用掉 / 回充
    if (this.nitroActive) {
      this.nitro = Math.max(0, this.nitro - dt / c.nitroDuration);
    } else {
      let regen = c.nitroRegen;
      if (this.drifting) regen += c.nitroDriftRegen * clamp(Math.abs(beta) / 0.5, 0.3, 1);
      if (this.groundedCount === 0 && this.airTime > 0.2) regen += c.nitroAirRegen;
      this.nitro = Math.min(1, this.nitro + regen * dt);
    }

    /* ---------- 四个车轮 ---------- */
    body.resetForces(true);
    body.resetTorques(true);

    const forceLift = c.com[1] * c.forceHeight;
    const quarterMass = c.mass / 4;
    let grounded = 0;
    let appliedDrive = 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const front = i < 2;
      _mount.copy(this.mounts[i]).applyQuaternion(_quat).add(_pos);
      const ray = new RAPIER.Ray({ x: _mount.x, y: _mount.y, z: _mount.z }, { x: -_up.x, y: -_up.y, z: -_up.z });
      const hit = this.world.castRayAndGetNormal(ray, this.travelTotal + R, true, QUERY_FLAGS);
      w.steer = front ? steer : 0;

      if (!hit) {
        w.grounded = false;
        w.load = 0;
        w.travel += (-c.suspDroop - w.travel) * (1 - Math.exp(-dt * 20));
        w.skid = 0;
        w.slipAngle = 0;
        // 腾空：驱动轮踩油门会空转，其余慢慢减速
        const driven = front ? c.driveSplitFront > 0 : c.driveSplitFront < 1;
        const target = driven && driveCmd > 0.1 ? w.omega + 60 * dt * driveCmd : w.omega * (1 - 0.4 * dt);
        w.omega = clamp(target, -250, 250);
        w.spin += w.omega * dt;
        continue;
      }

      grounded++;
      w.grounded = true;
      const d = hit.timeOfImpact;
      _n.set(hit.normal.x, hit.normal.y, hit.normal.z);
      const sLen = clamp(d - R, 0, this.travelTotal);
      const x = this.travelTotal - sLen;
      w.travel = c.suspBump - sLen;
      w.contact.copy(_mount).addScaledVector(_up, -d);

      const pv = body.velocityAtPoint({ x: w.contact.x, y: w.contact.y, z: w.contact.z });
      _vc.set(pv.x, pv.y, pv.z);

      // 悬挂：弹簧 + 压缩/回弹分开的阻尼 + 触底限位
      const compRate = -_vc.dot(_n);
      let N = this.springK[i] * Math.max(0, x - this.xFree[i]);
      N += (compRate > 0 ? this.dampBump[i] : this.dampRebound[i]) * compRate;
      if (d < R) N += this.springK[i] * 6 * (R - d);
      N = clamp(N, 0, this.staticLoad[i] * 8);
      w.load = N;

      // 接地平面内的车轮朝向
      const cs = Math.cos(w.steer);
      const sn = Math.sin(w.steer);
      _f.copy(_fwd).multiplyScalar(cs).addScaledVector(_left, sn);
      _f.addScaledVector(_n, -_f.dot(_n)).normalize();
      _s.crossVectors(_n, _f);
      const vx = _vc.dot(_f);
      const vy = _vc.dot(_s);
      const wheelPlanar = Math.hypot(vx, vy);

      const loadScale = clamp(1 - c.loadSensitivity * (N / this.staticLoad[i] - 1), 0.7, 1.15);
      const muLat = (front ? c.muLatFront : c.muLatRear * rearGrip) * loadScale * this.surfaceGrip;
      const muLong = c.muLong * loadScale * this.surfaceGrip;

      let Fx = 0;
      let Fy = 0;
      let locked = false;
      let spinning = false;

      if (input.handbrake && !front && wheelPlanar > 0.5) {
        // 手刹：后轮抱死，摩擦力整体反向于滑动方向，侧向抓地基本丢掉
        const mu = c.muLatRear * c.slideRatio * 0.85 * loadScale * this.surfaceGrip;
        Fx = (-mu * N * vx) / wheelPlanar;
        Fy = (-mu * N * vy) / wheelPlanar;
        locked = true;
        w.slipAngle = Math.atan2(vy, Math.abs(vx) + 0.6);
      } else {
        // 侧向：高速用侧偏角曲线，低速退化成按侧向速度的阻尼（避免原地抖动）
        const alpha = Math.atan2(vy, Math.abs(vx) + 0.6);
        w.slipAngle = alpha;
        const peak = front ? c.slipPeakFront : c.slipPeakRear;
        const fySlip = -muLat * N * lateralCurve(alpha / peak, c.slideRatio);
        const fyLow = -clamp(vy * 1.4, -1, 1) * muLat * N;
        Fy = fyLow + (fySlip - fyLow) * smoothstep(1.5, 5, wheelPlanar);

        // 纵向：驱动 + 制动 + 滚阻
        const share = front ? c.driveSplitFront / 2 : (1 - c.driveSplitFront) / 2;
        Fx = driveForce * share;
        let brakeF = brakeCmd * c.brakeForce * (front ? c.brakeBiasFront : 1 - c.brakeBiasFront) * 0.5;
        if (input.handbrake && !front) brakeF += c.handbrakeForce * 0.5;
        if (brakeF > 0) {
          if (Math.abs(vx) > 0.4) Fx -= Math.sign(vx) * brakeF;
          else Fx -= clamp((vx * quarterMass) / dt, -brakeF, brakeF);
        }
        if (Math.abs(vx) > 0.2) Fx -= Math.sign(vx) * c.rollingResistance * 0.25;

        // 摩擦椭圆：纵向力顶到极限时削掉一部分侧向抓地。
        // 漂移中削得更少，否则一脚油门后轮就彻底没有侧向力了
        const maxX = muLong * N;
        spinning = Math.abs(Fx) > maxX && share > 0;
        Fx = clamp(Fx, -maxX, maxX);
        const u = maxX > 1 ? Fx / maxX : 0;
        const coupling = this.drifting ? c.frictionCoupling * 0.4 : c.frictionCoupling;
        Fy *= Math.sqrt(Math.max(0, 1 - coupling * u * u));
        // 漂移中轮胎侧向力大部分让位给下面的"漂移线路"控制（否则滑动的后轮侧向力是饱和的，弧线松紧调不动）
        Fy *= 1 - c.driftTireCut * this.driftBlend;
        if (!front) appliedDrive += Fx;
      }

      // 法向力作用在接地点；轮胎力作用点略微抬高，减小点头和侧倾
      _force.copy(_n).multiplyScalar(N);
      body.addForceAtPoint({ x: _force.x, y: _force.y, z: _force.z }, { x: w.contact.x, y: w.contact.y, z: w.contact.z }, true);
      _force.copy(_f).multiplyScalar(Fx).addScaledVector(_s, Fy);
      _point.copy(w.contact).addScaledVector(_n, forceLift);
      body.addForceAtPoint({ x: _force.x, y: _force.y, z: _force.z }, { x: _point.x, y: _point.y, z: _point.z }, true);

      // 车轮转速（只用于画面和后续的声音/特效）
      let omegaTarget = vx / R;
      if (locked) omegaTarget = 0;
      else if (spinning) omegaTarget += Math.sign(driveForce) * 18;
      w.omega += (omegaTarget - w.omega) * (1 - Math.exp(-dt * 25));
      w.spin += w.omega * dt;

      const peakA = front ? c.slipPeakFront : c.slipPeakRear;
      let skid = clamp((Math.abs(w.slipAngle) / peakA - 0.9) / 1.6, 0, 1) * smoothstep(3, 9, wheelPlanar);
      if (locked) skid = Math.max(skid, smoothstep(2, 8, wheelPlanar));
      if (spinning) skid = Math.max(skid, 0.7);
      w.skid = skid;
    }

    /* ---------- 空气动力 ---------- */
    const sp = this.speed;
    if (sp > 0.1) {
      body.addForce({ x: -_vel.x * sp * c.drag, y: -_vel.y * sp * c.drag * 0.3, z: -_vel.z * sp * c.drag }, true);
    }
    if (grounded > 0) {
      const down = c.downforce * vF * vF;
      body.addForce({ x: -_up.x * down, y: -_up.y * down, z: -_up.z * down }, true);
    }

    /* ---------- 辅助 ---------- */
    let yawTorque = 0;
    if (grounded >= 3 && vF > 3 && !input.handbrake) {
      // 偏航稳定：把角速度拉向"按当前方向盘和车速应有的值"，上限受抓地力约束
      const grip = ((c.muLatFront + c.muLatRear) * 0.5 * 9.81 * this.surfaceGrip) / Math.max(vF, 4);
      const target = clamp((vF * Math.tan(this.steerInput * maxSteer)) / this.wheelbase, -grip, grip);
      const blend = this.drifting ? 0.0 : this.driftArm > 0 ? 0.3 : 1;
      yawTorque += (target - yawRate) * c.yawAssist * c.inertia[1] * blend;
      // 没有漂移意图时的侧滑：直接给回正力矩把车头拉回行进方向
      if (!this.drifting && this.driftArm <= 0) yawTorque += beta * c.slideRecover * c.inertia[1];
      // 点刹入弯的那一下：顺着方向盘推一把车尾，保证能甩进漂移
      if (!this.drifting && this.kickTimer > 0) yawTorque += Math.sign(steerIn) * c.kickYaw * c.inertia[1];
    }
    if (this.drifting && grounded >= 2) {
      // 漂移角度控制：角度不够的时候，用比例-微分控制把车头甩过去；
      // 角度过了头（要收车）的时候不把车头摆回来——那样车头刚指到的方向就白指了——
      // 只让车头按路线正常拐弯的快慢继续转，等行进方向追上来（见上面的 driftCatch）
      const err = beta - this.driftTarget;
      const over = clamp(-beta * this.driftDir - Math.abs(this.driftTarget), 0, 1.2);
      const catching = smoothstep(0.0, 0.1, over);
      const swing = (err * c.driftKp + this.betaRate * c.driftKd) * c.inertia[1];
      // 收车时车头该怎么转：跟着路线正常的拐弯（这时已经是零了），再按自己那一份往回摆
      const noseRate = this.driftDir * (driftTurn - over * c.driftAlign * (1 - c.driftNoseShare));
      const hold = (noseRate - yawRate) * c.driftNoseHold * c.inertia[1];
      yawTorque += swing * (1 - catching) + hold * catching;

      // 漂移线路控制：直接给一个指向弯心的向心力，大小就是上面算出的目标横向加速度。
      // 这样弧线的松紧完全听方向盘的，大弧度弯道也能一直漂下去。
      if (planar > 1) {
        _tmp.copy(_vel).addScaledVector(_up, -_vel.dot(_up)).normalize(); // 行进方向
        _point.crossVectors(_up, _tmp).multiplyScalar(this.driftDir); // 指向弯心
        // 驱动力顺着车头方向，车头又指向弯内，所以它本身已经贡献了一部分向心力，要扣掉
        const fromDrive = Math.max(0, appliedDrive * _fwd.dot(_point));
        // 车速很低时向心力按车速收小，免得原地打转越转越快
        const centripetal = Math.max(0, c.mass * driftLat * smoothstep(3, 12, planar) - fromDrive);
        // 横着滑会掉速：角度越大掉得越多。
        // 车速越高掉得越快（按车速的平方涨）：两百进弯头一秒能掉四五十，车速很快落到能拐过去的范围，
        // 弧线跟着收紧；掉到一百出头就基本不掉了，踩着油门可以一直漂下去
        const scrub = c.mass * 9.81 * c.driftScrub * Math.sin(Math.min(Math.abs(beta), 1.2)) * this.driftBlend * (0.25 + (planar / 38) * (planar / 38));
        // 车头方向的推力：漂移中踩着油门，车被往车头指的方向推。车头是指向弯内的，
        // 所以给油 = 路线往弯里收、车速不掉；松油 = 只剩上面那股向心力，车横着滑出去、慢下来。
        // 车身还没甩出角度时不给（否则成了直线上白捡的加速），车速很高时逐渐收掉
        const nose = clamp(-beta * this.driftDir, 0, 1.4);
        // 推力在 driftPushFade 给的车速区间里逐渐收掉：高速入弯时车是横着滑、明显掉速的（越慢拐得越紧），
        // 掉到一百出头推力才顶上来，之后踩着油门就能一直漂着走
        const push =
          c.mass * 9.81 * c.driftPush * driveCmd * this.driftBlend * this.surfaceGrip * smoothstep(0.08, 0.4, nose) * smoothstep(3, 12, planar) * (1 - smoothstep(c.driftPushFade[0], c.driftPushFade[1], planar));
        _force.copy(_fwd).addScaledVector(_up, -_fwd.dot(_up)).normalize();
        body.addForce(
          {
            x: _point.x * centripetal - _tmp.x * scrub + _force.x * push,
            y: _point.y * centripetal - _tmp.y * scrub + _force.y * push,
            z: _point.z * centripetal - _tmp.z * scrub + _force.z * push,
          },
          true,
        );
      }
    }
    if (yawTorque !== 0) {
      yawTorque = clamp(yawTorque, -26000, 26000);
      body.addTorque({ x: _up.x * yawTorque, y: _up.y * yawTorque, z: _up.z * yawTorque }, true);
    }

    if (grounded === 0) {
      // 腾空：阻尼翻滚并缓慢回正，落地姿态可控
      this.airTime += dt;
      const inertia = (c.inertia[0] + c.inertia[2]) * 0.5;
      _tmp.crossVectors(_up, WORLD_UP).multiplyScalar(c.airStabilize * inertia);
      _tmp.addScaledVector(_ang, -1.6 * inertia);
      body.addTorque({ x: _tmp.x, y: _tmp.y, z: _tmp.z }, true);
    } else {
      if (this.airTime > 0.25) {
        this.landingImpact = Math.max(this.landingImpact, clamp(this.airTime * 0.7 + Math.abs(_vel.y) / 9, 0, 1));
      }
      this.airTime = 0;
    }

    this.upsideDownTime = _up.y < 0.15 && this.speed < 3 ? this.upsideDownTime + dt : 0;

    /* ---------- 遥测 ---------- */
    this.groundedCount = grounded;
    const k = 1 - Math.exp(-dt * 10);
    this.longG += ((vF - this.prevForward) / dt / 9.81 - this.longG) * k;
    this.lateralG += ((vF * yawRate) / 9.81 - this.lateralG) * k;
    this.prevForward = vF;
    this.prevVel.copy(_vel);
  }
}
