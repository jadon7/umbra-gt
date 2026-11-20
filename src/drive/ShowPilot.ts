import type { DriveInput, Vehicle } from './Vehicle.ts';
import { DEFAULT_CONFIG, type VehicleConfig } from './VehicleConfig.ts';

/** 赛道信息：沿中心线的采样点（和 Autopilot 用的是同一份） */
export interface ShowSample {
  s: number;
  pos: { x: number; y: number; z: number };
  dir: { x: number; z: number };
  left: { x: number; z: number };
  curvature: number;
}

export interface ShowPath {
  samples: ShowSample[];
  length: number;
  /** 每个采样点：车在这里会不会飘起来（坡顶）。不给就按「路面高出地面」算（城市的拱桥） */
  crest?: Uint8Array;
}

/** 赛道上的一个弯 */
interface Turn {
  /** 起止（采样点下标） */
  i0: number;
  i1: number;
  /** 一共转过多少弧度（正 = 左弯） */
  angle: number;
  radius: number;
  /**
   * 从 i0 到「真正开始拐」的地方有多远（米）。城市里的弯是直线直接接圆弧，这个数是 0；
   * 山路的弯前面有一段渐渐弯起来的过渡，长弯要等过了这一段才甩车
   */
  lead: number;
}

type Phase = 'cruise' | 'hand' | 'drift' | 'catch' | 'recover';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const angleDiff = (a: number, b: number) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/**
 * 表演式的自动驾驶：直道给满油门、够长就开氮气，急弯不刹到底、带着方向拉手刹漂过去，出弯再给油。
 * 是给「看一圈、录一段」用的，目标是跑得好看，不是跑得稳——偶尔会蹭到墙。
 * （无头仿真里验证赛道、量基准圈速用的还是 Autopilot 那个老老实实刹车过弯的。）
 *
 * 怎么开：
 *  - 直道：盯着前方一点打方向（纯追踪）。进急弯之前往弯的外侧靠，把弯"拉开"。
 *  - 氮气：前面的直道够长、氮气够多就开；快到刹车点、要上拱桥（会飞得太远）的时候不开。
 *  - 急弯（半径小于六十米）：车速高过入弯车速就先刹一脚；到了入弯点，带着方向拉手刹把车甩起来，
 *    然后一直往弯里带着方向给油。每一步都估一下「现在松手的话，车最后会朝哪走」，
 *    估出来已经对准弯后的路了就松手——收车时车头会回摆、行进方向会再拐一点，这些都算在里面。
 *  - 缓弯（湖滨那个大半圆）：不漂，按抓地极限的车速贴着跑。
 *  - 卡住了（撞墙停下来）：倒一小段再走。
 *
 * 城市里的弯都是又急又短的直角弯，甩进去、方向打到底、对准了就松手。山路上的弯不一样：
 * 发卡弯要转一百八十度，长弯要漂上好几秒。这种又长又大的弯（见 sustained）入弯车速按「这个半径漂得住多快」来定，
 * 漂的时候方向不是打到底，而是盯着前面的路按需要的深浅带着——带深了收紧，带浅了放宽。
 */
export class ShowPilot {
  /** 路面抓地系数（积雪时小于 1） */
  grip = 1;
  /** 当前所在的采样点下标 */
  index = 0;
  /** 累计跑过的距离（跨圈累加） */
  progress = 0;
  /** 离中心线的横向距离，左为正（调试用） */
  offset = 0;
  /** 现在在干什么（调试用） */
  phase: Phase = 'cruise';
  /**
   * 比赛里用（见 RacePilot）：为了让开别的车，这会儿想走的那条线（离中心线多少米，左为正；null = 没有要让的），
   * 以及有多想（0–1）。只在直道和缓弯里管用，漂起来以后不管
   */
  lane: number | null = null;
  laneWeight = 0;
  /** 比赛里用：前面贴着一辆车，车速不要超过这个数（米/秒） */
  follow = Infinity;
  /** 比赛里用：前面不远有车挡着，这会儿不开氮气 */
  crowded = false;
  private laneNow = 0;

  private readonly path: ShowPath;
  private readonly step: number;
  private readonly turns: Turn[] = [];
  private started = false;
  private phaseTime = 0;
  /** 正在漂的是哪个弯 */
  private turn: Turn | null = null;
  private stuck = 0;
  private recoverSteer = 0;
  /** 抓地过弯时允许用到的横向加速度（米/秒²）、刹车时假设的减速度 */
  private lateralLimit = 12.5;
  private brakeLimit = 11;
  /** 漂移入弯的车速（米/秒）：比这快就先刹一脚 */
  private entrySpeed = 36.5;
  /** 上一次漂移结束到现在过了多久（秒） */
  private sinceDrift = 99;
  /** 松手之后行进方向还会再拐多少（占当时侧滑角的比例）。又重又长的车收得慢，拐得更多，要更早松手 */
  private lead = 0.56;
  /** 这台车的调校：长弯里按它算「方向带多深能拐多快」 */
  private cfg: VehicleConfig = DEFAULT_CONFIG;
  /**
   * 长弯（发卡弯、回头弯、大半径的长弯）怎么漂。
   * 一甩起来行进方向马上就开始拐，而且拐多急基本只看车速（车速越高弧线越大），方向带得深浅能调的余地很小。
   * 所以关键是入弯车速要和弯的半径对上：太快会滑到外侧的护栏上，太慢会越拐越紧、蹭内侧的护栏。
   *  hold  入弯车速占「漂移的弧线正好贴着弯的外侧走」那个车速的几成；
   *  lead  到弯口前多少秒甩车（很短：甩早了还没进弯就拐到内侧去了）；
   *  bias  入弯前往外侧靠多少米。
   */
  readonly longTurn = { hold: 1.0, lead: 0.1, bias: 3.5 };
  /** 长弯里方向已经带到最浅、弧线还是比弯紧（车速掉得太多了）的时间：久了就不漂了，老老实实拐出去 */
  private tooTight = 0;
  /** 已经在里面漂过一次的弯：收了车以后，剩下的半个弯按抓地的车速走 */
  private spent: Turn | null = null;
  /** 上一帧在弯的内侧多少米（算往内侧靠得有多快） */
  private lastInside = 0;

  constructor(path: ShowPath) {
    this.path = path;
    this.step = path.length / path.samples.length;
    this.findTurns();
  }

  /** 按这台车的能耐调整：抓地差、刹车弱的车早一点刹、入弯慢一点 */
  tuneFor(cfg: VehicleConfig): void {
    const D = DEFAULT_CONFIG;
    this.cfg = cfg;
    const lat = (cfg.muLatFront + cfg.muLatRear) / (D.muLatFront + D.muLatRear);
    const brake = Math.min(cfg.muLong / D.muLong, cfg.brakeForce / cfg.mass / (D.brakeForce / D.mass));
    this.lateralLimit = 12.5 * Math.min(1, lat);
    this.brakeLimit = 11 * Math.min(1, brake);
    // 重车转得慢、掉速也慢：入弯车速按重量往下调一点
    // 漂移时掉速慢的车（敞篷那款）弯里车速高、跑得宽：入弯也要慢一点
    this.lead = 0.56 + 0.2 * clamp((cfg.inertia[1] / D.inertia[1] - 1) / 1.6, 0, 1);
    const scrub = clamp(0.8 + 0.2 * (cfg.driftScrub / D.driftScrub), 0.85, 1.02);
    this.entrySpeed = 36.5 * clamp(Math.sqrt(D.mass / cfg.mass) * 0.5 + 0.5, 0.86, 1.02) * scrub;
  }

  private findTurns(): void {
    const S = this.path.samples;
    const n = S.length;
    const bent = (i: number) => Math.abs(S[(i + n) % n].curvature) > 0.004;
    let first = 0;
    while (first < n && bent(first)) first++;
    let i = 0;
    while (i < n) {
      if (!bent(first + i)) {
        i++;
        continue;
      }
      const from = i;
      let angle = 0;
      let peak = 0;
      while (i < n && bent(first + i)) {
        const c = S[(first + i) % n].curvature;
        angle += c * this.step;
        peak = Math.max(peak, Math.abs(c));
        i++;
      }
      if (Math.abs(angle) > 0.3) {
        // 弯度到了最急处的一半，算是真正开始拐了
        let real = from;
        while (real < i && Math.abs(S[(first + real) % n].curvature) < peak * 0.5) real++;
        this.turns.push({ i0: (first + from) % n, i1: (first + i - 1) % n, angle, radius: ((i - from) * this.step) / Math.abs(angle), lead: (real - from) * this.step });
      }
    }
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
    this.phase = 'cruise';
    this.phaseTime = 0;
    this.turn = null;
    this.stuck = 0;
    this.laneNow = 0;
  }

  /**
   * 这个弯是不是要「一直漂着走」的那种：转得多（发卡弯、回头弯）或者半径大（漂上好几秒的长弯）。
   * 城市里的直角弯不是。
   */
  private sustained(t: Turn): boolean {
    return Math.abs(t.angle) > 2.0 || t.radius > 40;
  }

  /**
   * 半径大的长弯：没法从头漂到尾。高速漂移掉速很快，车速一掉弧线就收紧，会一头扎向内侧。
   * 这种弯的开法是「甩进去」——带着高车速漂着入弯，等车速降下来、快贴到内侧了就收车，剩下的抓地走完。
   * 发卡弯这样又急又小的弯不算（那种能一把漂到底）。
   */
  private entryOnly(t: Turn): boolean {
    return this.sustained(t) && t.radius > 40;
  }

  /** 漂着的时候，方向带到 amount（0–1）这么深，行进方向每秒能拐多少弧度（和 Vehicle 里漂移的算法是同一套数） */
  private driftRate(amount: number, planar: number): number {
    const c = this.cfg;
    const ang = c.driftAngleHold + (c.driftAngleMax - c.driftAngleHold) * amount;
    const k = clamp(Math.sin(ang) / Math.sin(c.driftAngleMax), 0, 1.15);
    const cap = (c.driftLatMax * 9.81 * this.grip) / Math.max(planar, 6);
    return Math.min(c.driftTurnMax * Math.pow(k, c.driftLatCurve), cap);
  }

  /** 漂移的弧线半径正好是 arc 米时的车速：车速不高时弧线半径大约等于车速（米/秒），再快就按横向加速度的上限算 */
  private matchSpeed(arc: number): number {
    const cap = this.cfg.driftLatMax * 9.81 * this.grip;
    return arc < cap ? arc : Math.sqrt(cap * arc);
  }

  /** 前方最近的一个弯，以及离它的入口还有多远（米；已经在弯里是负数） */
  private nextTurn(): { turn: Turn; dist: number } | null {
    const n = this.path.samples.length;
    let best: { turn: Turn; dist: number } | null = null;
    for (const t of this.turns) {
      const span = (t.i1 - t.i0 + n) % n;
      let ahead = (t.i0 - this.index + n) % n;
      // 已经进了这个弯：入口在身后
      if (ahead > n - span - 1) ahead -= n;
      // 长弯的「入口」算在真正开始拐的地方
      const dist = ahead * this.step + (this.sustained(t) ? t.lead : 0);
      if (!best || dist < best.dist) best = { turn: t, dist };
    }
    return best;
  }

  /**
   * @param v 车（读车速、侧滑角、氮气这些）
   * @param x,z 车的位置；yaw 车头朝向（绕 Y 轴，0 = +Z）
   */
  update(v: Vehicle, x: number, z: number, yaw: number, dt: number): DriveInput {
    const S = this.path.samples;
    const n = S.length;
    if (!this.started) this.reset(x, z);

    /* ---- 在赛道上的位置 ---- */
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
    const here = S[bi];
    this.offset = (x - here.pos.x) * here.left.x + (z - here.pos.z) * here.left.z;

    const speed = Math.max(v.forwardSpeed, 0);
    const lv = v.body.linvel();
    const planar = Math.hypot(lv.x, lv.z);
    const velYaw = planar > 3 ? Math.atan2(lv.x, lv.z) : yaw;
    const next = this.nextTurn();
    this.phaseTime += dt;
    this.sinceDrift = v.drifting ? 0 : this.sinceDrift + dt;

    /* ---- 卡住了：倒一小段 ---- */
    if (this.phase !== 'recover') {
      this.stuck = planar < 2 && this.progress > 5 ? this.stuck + dt : 0;
      if (this.stuck > 1.2) {
        this.phase = 'recover';
        this.phaseTime = 0;
        this.stuck = 0;
        // 倒车时方向往赛道那边打：车头就会摆向该去的方向
        this.recoverSteer = -Math.sign(angleDiff(Math.atan2(here.dir.x, here.dir.z), yaw)) || 1;
      }
    } else {
      // 一边倒一边把车头摆向赛道的方向：摆得差不多了（或者倒了两秒半）就往前走
      const off = Math.abs(angleDiff(Math.atan2(here.dir.x, here.dir.z), yaw));
      if (this.phaseTime > 2.5 || (this.phaseTime > 0.9 && off < 0.45)) {
        this.phase = 'cruise';
        this.phaseTime = 0;
      }
      return { throttle: 0, brake: 1, steer: this.recoverSteer, handbrake: false, nitro: false };
    }

    /* ---- 纯追踪：盯着前方一点打方向。target 往路的哪一侧偏多少米（左为正） ---- */
    const pursue = (lateral: number): number => {
      const look = clamp(7 + speed * 0.42, 9, 42);
      const t = S[(bi + Math.round(look / this.step)) % n];
      const tx = t.pos.x + t.left.x * lateral - x;
      const tz = t.pos.z + t.left.z * lateral - z;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const alpha = Math.atan2(tx * fz - tz * fx, tx * fx + tz * fz);
      const c = DEFAULT_CONFIG;
      const wheelbase = c.wheelPos[0][2] - c.wheelPos[2][2];
      const delta = Math.atan2(2 * wheelbase * Math.sin(alpha), Math.hypot(tx, tz));
      const maxSteer = c.steerMin + (c.steerMax - c.steerMin) / (1 + Math.pow(speed / c.steerSpeedRef, 1.7));
      return clamp(delta / maxSteer, -1, 1);
    };

    // 半径小于六十米的都漂；六十到一百米之间的，要转上一百多度的长弯才漂——半径大、转得又不多的弯，
    // 漂移的弧线比弯紧得多，一甩就蹭内侧，不如抓地过
    // 又重又长的车（肌肉车、皮卡）收车慢，大半径的弯甩进去收不住，就抓地过
    const nimble = (this.lead - 0.56) / 0.2 <= 0.25;
    const sharp = next && (next.turn.radius < 60 || (nimble && next.turn.radius < 100 && Math.abs(next.turn.angle) > 2.0)) ? next : null;
    const side = sharp ? Math.sign(sharp.turn.angle) : 0;

    /* ---- 漂移中 ---- */
    if (this.phase === 'hand' && this.turn) {
      const s = Math.sign(this.turn.angle);
      // 车速高就多拉一会儿手刹：角度更大、掉速更快
      const hold = 0.26 + clamp((speed - 34) / 12, 0, 1) * 0.4;
      if (this.phaseTime >= hold) {
        this.phase = 'drift';
        this.phaseTime = 0;
      }
      return { throttle: 1, brake: 0, steer: s, handbrake: true, nitro: false };
    }
    if (this.phase === 'drift' && this.turn) {
      const t = this.turn;
      const s = Math.sign(t.angle);
      const slip = Math.abs(v.sideSlip);
      // 弯后的路朝哪：取出弯点再往前一点的方向
      const exit = S[(t.i1 + 4) % n];
      const exitYaw = Math.atan2(exit.dir.x, exit.dir.z);
      // 现在松手的话，行进方向还会再拐大约半个侧滑角
      const after = velYaw + s * slip * this.lead;
      let need = angleDiff(exitYaw, after) * s;
      // 人在弯的外侧（跑宽了）就多拐一点，在内侧就少拐一点
      const outside = -this.offset * s;
      need += clamp(outside - 1.5, -5, 6) * 0.03;
      const past = ((bi - t.i1 + n) % n) * this.step;
      const beyond = past < n * this.step * 0.5 && past > 14;
      const long = this.sustained(t);
      // 转一百八十度的弯，刚甩进去的时候「还差多少」正好在正负一百八十度的交界上，算出来可能是负的：
      // 长弯要走过一半以后才认「已经对准了」
      const span = ((t.i1 - t.i0 + n) % n) + 1;
      const done = ((bi - t.i0 + n) % n) / span;
      const aligned = need < 0.05 && (!long || (done > 0.5 && done < 1.5));
      const limit = long ? 4 + 3 * Math.max(0, Math.abs(t.angle) - 2) + (t.radius > 40 ? 3 : 0) : 4;
      // 大半径的弯：照现在往内侧靠的速度，再过半秒就贴上内侧了——收车要花零点几秒，得提前
      const inside = this.offset * s;
      const inRate = dt > 0 ? (inside - this.lastInside) / dt : 0;
      this.lastInside = inside;
      // 又重又长的车收得慢：看得更远、更早收
      const heavy = clamp((this.lead - 0.56) / 0.2, 0, 1);
      const closing = this.entryOnly(t) && this.phaseTime > 0.3 && inside + Math.max(inRate, 0) * (0.7 + 0.6 * heavy) > 2.0 - 2.0 * heavy;
      if (aligned || beyond || !v.drifting || this.phaseTime > limit || this.tooTight > 0.25 || closing) {
        this.phase = 'catch';
        this.phaseTime = 0;
        this.tooTight = 0;
      } else if (long) {
        // 长弯：盯着前面二十来米处的路，算出行进方向每秒该拐多少，再按「方向带多深能拐多快」反推方向的深浅。
        // 不硬往路中间凑：车现在在哪条线上就沿着哪条线走，只有太靠里或者太靠外才往回带
        const lane = clamp(this.offset * s, -3, 4.5);
        const look = clamp(planar * 0.75, 14, 32);
        const tp = S[(bi + Math.round(look / this.step)) % n];
        const tx = tp.pos.x + tp.left.x * lane * s - x;
        const tz = tp.pos.z + tp.left.z * lane * s - z;
        const alpha = angleDiff(Math.atan2(tx, tz), velYaw) * s;
        const want = (planar * 2 * Math.sin(alpha)) / Math.max(Math.hypot(tx, tz), 1);
        const w0 = this.driftRate(0, planar);
        const w1 = this.driftRate(1, planar);
        const amount = w1 > w0 + 1e-3 ? (want - w0) / (w1 - w0) : want > w0 ? 1 : 0;
        // 弧线比弯还紧（车速掉下来了）、人已经贴到内侧：补一脚氮气把车速提起来，弧线就放大了；
        // 提不起来就不漂了。带得太浅会被当成松手收车，所以方向留个底
        const tight = want < w0 * 0.8 && this.offset * s > 4.2;
        this.tooTight = tight ? this.tooTight + dt : 0;
        // 方向打到底也拐不过来：车速太高了，收一点油让它掉速
        const throttle = want > w1 * 1.04 ? 0.3 : 1;
        // 发卡弯：车速比「弧线和弯对得上」的车速低，也补氮气——车速上去弧线才撑得开。
        // 大半径的弯不补：那种本来就是借漂移把车速降下来
        const slow = !this.entryOnly(t) && planar < this.matchSpeed(t.radius + 1) * 0.97 && want < w1;
        return { throttle, brake: 0, steer: s * clamp(amount, 0.24, 1), handbrake: false, nitro: (tight || slow) && v.nitro > 0.08 };
      } else {
        return { throttle: 1, brake: 0, steer: s, handbrake: false, nitro: false };
      }
    }
    if (this.phase === 'catch') {
      // 松手收车：方向回到跟着路走，油门不松
      if (!v.drifting || this.phaseTime > 1.0) {
        this.phase = 'cruise';
        this.phaseTime = 0;
        this.turn = null;
      } else {
        // 大半径的弯甩到一半收车：车速还高过抓地能过的车速，就带一脚刹车（踩刹车本身也会让漂移收得更快）
        const t = this.turn;
        if (t && this.entryOnly(t) && planar > Math.sqrt(this.lateralLimit * this.grip * t.radius) * 1.06) {
          return { throttle: 0, brake: 0.7, steer: 0, handbrake: false, nitro: false };
        }
        return { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
      }
    }

    /* ---- 直道和缓弯 ---- */
    // 进急弯之前往外侧靠
    let lateral = 0;
    if (sharp && sharp.dist > 0 && sharp.dist < 130) {
      const bias = this.sustained(sharp.turn) ? this.longTurn.bias : 4.2;
      lateral = -side * bias * clamp(sharp.dist / 25, 0, 1) * clamp((130 - sharp.dist) / 40, 0, 1);
    }
    // 比赛里要让开别的车：往要走的那条线上靠（慢慢靠过去，不猛打方向）
    const laneTarget = this.lane === null ? 0 : (this.lane - lateral) * this.laneWeight;
    this.laneNow += (laneTarget - this.laneNow) * (1 - Math.exp(-dt * 3.5));
    lateral = clamp(lateral + this.laneNow, -6.3, 6.3);
    const steer = pursue(lateral);

    // 车速上限：缓弯按抓地极限；拱桥前不要冲得太快（飞得太远，落地离下一个弯太近）
    let allowed = 90;
    const lateralLimit = this.lateralLimit * this.grip;
    const brakeLimit = this.brakeLimit * this.grip;
    const horizon = clamp((speed * speed) / (2 * brakeLimit) + 40, 60, 320);
    const count = Math.round(horizon / this.step);
    let crest = false;
    // 前面要漂的长弯（还没漂过）：它的车速由入弯车速管，不按抓地极限算
    const drifted = sharp && this.sustained(sharp.turn) && this.spent !== sharp.turn ? sharp.turn : null;
    const driftedSpan = drifted ? (drifted.i1 - drifted.i0 + n) % n : 0;
    for (let k = 0; k <= count; k += 2) {
      const p = S[(bi + k) % n];
      if (this.path.crest ? this.path.crest[(bi + k) % n] : p.pos.y > 0.4) crest = true;
      const kappa = Math.abs(p.curvature);
      // 急弯交给漂移，这里只管缓弯
      if (kappa < 1e-4 || kappa > 1 / 60) continue;
      if (drifted && (bi + k - drifted.i0 + n) % n <= driftedSpan) continue;
      const corner = Math.sqrt(lateralLimit / kappa);
      allowed = Math.min(allowed, Math.sqrt(corner * corner + 2 * brakeLimit * Math.max(0, k * this.step - 4)));
    }
    if (crest) allowed = Math.min(allowed, 57);
    allowed = Math.min(allowed, this.follow);
    // 长弯漂到一半收了车（车速掉得太多、弧线比弯还紧）：剩下的半个弯按抓地的车速拐出去，别一脚油门冲到外侧的护栏上
    if (sharp && sharp.dist < 0 && this.spent === sharp.turn) allowed = Math.min(allowed, 0.93 * Math.sqrt(lateralLimit * sharp.turn.radius));

    let throttle = 1;
    let brake = 0;
    let nitro = false;
    /** 前面这个弯打算多快进：算氮气还能喷多久时用 */
    let entryNext = this.entrySpeed;

    if (sharp) {
      // 人在弯的内侧多少米（连续弯里，上一个弯出来往往正好在下一个弯的内侧）：
      // 内侧没有空间把弯拉开，只能慢一点进、晚一点甩
      const inside = clamp(this.offset * side + 1.5, 0, 10);
      // 入弯车速按抓地打折（雪地）；入弯点跟着车速往前挪
      // 弯越急入弯越慢（入弯车速是按半径十九米的弯定的）
      const tight = clamp(Math.pow(sharp.turn.radius / 19, 0.9), 0.7, 1.05);
      // 刚从上一个弯里出来（连续弯）：车还没完全走直，再慢一成
      const chained = this.sinceDrift < 2.2 ? 0.92 : 1;
      let entry = (this.entrySpeed * tight * chained - inside * 1.25) * Math.sqrt(this.grip);
      if (this.sustained(sharp.turn)) {
        // 入弯车速：漂移的弧线正好贴着弯的外侧走的那个车速。
        // 发卡弯不能比它快（也不超过直角弯的入弯车速）；半径大的弯就按它来，比直角弯快得多
        // 漂移的弧线半径：车速不高时大约等于车速（米/秒），再快就按横向加速度的上限算
        const hold = this.longTurn.hold * this.matchSpeed(sharp.turn.radius + this.longTurn.bias) - inside * 0.6;
        // 又重又长的车甩进大弯慢一点
        entry = this.entryOnly(sharp.turn) ? hold * (1 - 0.1 * clamp((this.lead - 0.56) / 0.2, 0, 1)) : Math.min(entry, hold);
        entryNext = entry;
      }
      let trigger = clamp(13 + (speed - 33) * 0.75 - inside * 0.9, 3, 30);
      if (this.sustained(sharp.turn)) {
        trigger = clamp(1 + speed * this.longTurn.lead, 2, 30);
        // 车速比「弧线和弯对得上」的车速低：漂移的弧线比弯紧，甩早了会一头扎到内侧。
        // 先沿着外侧多走一段，等弯过去一截再甩（差得越多等得越久）
        const short = clamp(1 - speed / this.matchSpeed(sharp.turn.radius + this.longTurn.bias), 0, 0.5);
        trigger -= short * 1.6 * sharp.turn.radius;
      }
      const brakeDist = Math.max(0, (speed * speed - entry * entry) / (2 * brakeLimit));
      if (sharp.dist > trigger && sharp.dist < trigger + brakeDist + 6 && speed > entry) {
        throttle = 0;
        brake = 1;
      }
      // 长弯漂到一半收过车（弧线比弯紧，贴到内侧了）：等车回到路中间、前面还有不少弯要拐，就再甩一次
      let again = false;
      if (sharp.dist <= -4 && this.sustained(sharp.turn)) {
        const span = ((sharp.turn.i1 - sharp.turn.i0 + n) % n) + 1;
        const done = ((bi - sharp.turn.i0 + n) % n) / span;
        again = !this.entryOnly(sharp.turn) && done < 1 && Math.abs(sharp.turn.angle) * (1 - done) > 0.6 && this.offset * side < 2 && this.sinceDrift > 0.25;
      }
      // 到入弯点了：车还算正、车速够，就甩起来
      const late = this.sustained(sharp.turn) && this.spent !== sharp.turn && sharp.dist > trigger - 8;
      if (sharp.dist <= trigger && (sharp.dist > -4 || again || late) && speed > 17 && v.groundedCount >= 3) {
        this.phase = 'hand';
        this.phaseTime = 0;
        this.tooTight = 0;
        this.lastInside = this.offset * side;
        this.turn = sharp.turn;
        this.spent = sharp.turn;
        return { throttle: 1, brake: 0, steer: side, handbrake: true, nitro: false };
      }
      // 车速太低漂不起来（刚倒完车、刚起步）：就老老实实拐过去
      if (sharp.dist <= trigger && speed <= 17) {
        const corner = Math.sqrt(lateralLimit * sharp.turn.radius);
        if (speed > corner + 1) {
          throttle = 0;
          brake = 0.6;
        } else {
          throttle = 0.7;
        }
      }
    }
    if (speed > allowed + 1) {
      throttle = 0;
      brake = clamp((speed - allowed) / 5, 0.15, 1);
    } else if (speed > allowed - 0.5) {
      throttle = Math.min(throttle, 0.4);
    }

    // 氮气：前面够长一段不用刹车，而且不在拱桥前
    const clear = sharp ? sharp.dist : 400;
    if (throttle >= 1 && !crest && !this.crowded && v.nitro > 0.12 && speed > 18 && speed < 78 && Math.abs(steer) < 0.35 && v.groundedCount >= 3) {
      // 刚开的时候要求氮气多一些、路长一些；已经在喷了就一直喷到快到刹车点
      const room = clear - (speed * speed - entryNext * entryNext) / (2 * brakeLimit) - 30;
      if (v.nitroActive ? room > 10 : room > 110 && v.nitro > 0.45) nitro = true;
      // 前面三百米内有发卡弯：留四成氮气，漂的时候要靠它把车速撑住
      if (sharp && this.sustained(sharp.turn) && !this.entryOnly(sharp.turn) && sharp.dist < 320 && v.nitro < 0.42) nitro = false;
    }
    return { throttle, brake, steer, handbrake: false, nitro };
  }
}
