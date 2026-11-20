import * as THREE from 'three/webgpu';
import { fitFov } from '../core/fov.ts';
import type { PhysicsWorld } from './PhysicsWorld.ts';
import type { Vehicle } from './Vehicle.ts';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const angleDiff = (a: number, b: number) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** 赛道中心线上的一个采样点（和自动驾驶用的是同一份） */
export interface CineSample {
  pos: { x: number; y: number; z: number };
  dir: { x: number; z: number };
  left: { x: number; z: number };
  curvature: number;
}

/** 电影镜头要从地图那里知道的东西 */
export interface CineStage {
  track?: { samples: CineSample[]; length: number };
  /** 这个位置的地面有多高（镜头不能钻到地下去） */
  groundAt?(x: number, z: number): number;
  /** 这个位置的路面头顶上有没有东西（隧道、棚洞、高架下面）：有的话不能从高处拍 */
  covered?(x: number, z: number): boolean;
  /** 护栏外面是不是开阔的（山路是；城里路边就是楼，机位只能摆在路上） */
  openVerge?: boolean;
}

type Kind = 'trackside' | 'tower' | 'crane' | 'heli' | 'front' | 'side' | 'low' | 'orbit' | 'wheel' | 'chase';

interface Shot {
  kind: Kind;
  name: string;
  /** 最长拍多久（秒）。定点机位通常在车开过去以后自己结束 */
  length: number;
  /** 每帧摆一次镜头；返回 false = 这个镜头拍完了（车开过去了、被挡住了） */
  tick(dt: number, t: number): boolean;
}

const NAMES: Record<Kind, string> = {
  trackside: '路边',
  tower: '摄像塔',
  crane: '摇臂',
  heli: '航拍',
  front: '车头前',
  side: '侧面跟拍',
  low: '贴地追尾',
  orbit: '环绕',
  wheel: '轮边',
  chase: '追尾',
};

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * 自动驾驶时的电影镜头：像转播和电影那样，在一组机位之间切来切去。
 *
 * 机位有十种：
 *  - 路边 / 摄像塔 / 摇臂：镜头立在前面的路边（或路的上方）不动，长焦盯着车，车冲过来、掠过去，然后换下一个；
 *  - 航拍：在车的斜后上方二十多米跟着飞，看得见路的走向和周围的山、楼；
 *  - 车头前：架在车前面的路上倒着走，拍车头冲着镜头来；
 *  - 侧面跟拍、环绕：贴着车走，慢慢往后滑、或者绕着车转；
 *  - 贴地追尾：比平时的追尾低得多、广得多，路面从镜头底下刷过去；
 *  - 轮边：绑在车身侧面贴着地，漂移的时候烟就从镜头前面冒；
 *  - 追尾：平时开车的那个机位，隔一阵用一下，喘口气。
 *
 * 怎么挑：按权重随机，不连着用同一种；车一甩起来就切到看得清车身角度的机位（车头前、航拍、轮边）；
 * 隧道、棚洞、高架下面不用高处的机位；车很慢的时候不用定点机位。
 * 镜头之间是硬切（电影和转播都是这样），一个镜头之内的移动和变焦都是平滑的。
 * 定点机位每隔一会儿用物理世界查一下视线：被山或楼挡住了就换。
 */
export class CineCamera {
  /** 这一帧是不是让给平时的追尾镜头（它自己算好了，这里不动） */
  delegate = false;
  /** 景深：焦点离镜头多远、虚化多强（长焦镜头背景是虚的） */
  focus = 10;
  bokeh = 0;
  /** 刚切了一个镜头（外面想配个声音、闪一下的话用），读完自己清掉 */
  cut = false;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly physics: PhysicsWorld;
  private stage: CineStage = {};
  private index = -1;
  /** 车在赛道上的位置（米，带小数） */
  private along = 0;
  private readonly pos = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private v: Vehicle | null = null;
  /** 行进方向（平滑过的）：贴着车走的机位按它摆，漂移时不跟着车身甩 */
  private heading = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private fov = 50;
  private fovTarget = 50;
  private roll = 0;
  private near = 0.2;
  private shot: Shot | null = null;
  private shotTime = 0;
  private fresh = true;
  private readonly eye = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly history: Kind[] = [];
  private hidden = 0;
  private sightTimer = 0;
  private wasDrifting = false;
  private time = 0;
  private seed = 20261113;

  constructor(camera: THREE.PerspectiveCamera, physics: PhysicsWorld) {
    this.camera = camera;
    this.physics = physics;
  }

  /** 现在是哪个机位（界面上显示用） */
  get shotName(): string {
    return this.shot ? this.shot.name : '';
  }

  /** 重新开始（刚打开电影镜头、车被挪了位置）：下一帧重新挑机位 */
  reset(): void {
    this.shot = null;
    this.index = -1;
    this.history.length = 0;
    this.wasDrifting = false;
  }

  private rnd(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* ------------------------------ 赛道上的位置 ------------------------------ */

  private get step(): number {
    const tr = this.stage.track!;
    return tr.length / tr.samples.length;
  }

  /** 车现在在赛道的哪儿 */
  private locate(): void {
    const S = this.stage.track!.samples;
    const n = S.length;
    const p = this.pos;
    let best = Infinity;
    let bi = Math.max(0, this.index);
    const from = this.index < 0 ? 0 : -6;
    const to = this.index < 0 ? n - 1 : 40;
    for (let k = from; k <= to; k++) {
      const i = (bi + k + n) % n;
      const d = (S[i].pos.x - p.x) ** 2 + (S[i].pos.z - p.z) ** 2;
      if (d < best) {
        best = d;
        this.index = i;
      }
    }
    const s = S[this.index];
    this.along = this.index * this.step + (p.x - s.pos.x) * s.dir.x + (p.z - s.pos.z) * s.dir.z;
  }

  /** 赛道上第 s 米处、离中心线 lateral 米（左为正）、离路面 up 米高的点 */
  private pointAt(s: number, lateral: number, up: number, out: THREE.Vector3): THREE.Vector3 {
    const tr = this.stage.track!;
    const S = tr.samples;
    const n = S.length;
    const f = (((s % tr.length) + tr.length) % tr.length) / this.step;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const q = f - Math.floor(f);
    const a = S[i];
    const b = S[j];
    return out.set(lerp(a.pos.x, b.pos.x, q) + lerp(a.left.x, b.left.x, q) * lateral, lerp(a.pos.y, b.pos.y, q) + up, lerp(a.pos.z, b.pos.z, q) + lerp(a.left.z, b.left.z, q) * lateral);
  }

  private curvatureAt(s: number): number {
    const tr = this.stage.track!;
    const n = tr.samples.length;
    return tr.samples[((Math.round(s / this.step) % n) + n) % n].curvature;
  }

  /** 车比赛道上第 s 米处超前多少米（负的 = 还没到） */
  private pastBy(s: number): number {
    const L = this.stage.track!.length;
    let d = (this.along - s) % L;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    return d;
  }

  /** 把一个贴着车走的机位收回到路的范围里（不然会钻进护栏、墙里） */
  private keepInside(p: THREE.Vector3, half: number): void {
    const S = this.stage.track!.samples;
    const n = S.length;
    let best = Infinity;
    let bi = this.index;
    for (let k = -12; k <= 16; k++) {
      const i = (this.index + k + n) % n;
      const d = (S[i].pos.x - p.x) ** 2 + (S[i].pos.z - p.z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    const s = S[bi];
    const lat = (p.x - s.pos.x) * s.left.x + (p.z - s.pos.z) * s.left.z;
    if (Math.abs(lat) > half) {
      const over = lat - Math.sign(lat) * half;
      p.x -= s.left.x * over;
      p.z -= s.left.z * over;
    }
  }

  /** 镜头不能低于地面以上 min 米 */
  private floor(p: THREE.Vector3, min: number): void {
    const g = this.stage.groundAt?.(p.x, p.z);
    if (g !== undefined && p.y < g + min) p.y = g + min;
  }

  private covered(p: THREE.Vector3): boolean {
    return this.stage.covered?.(p.x, p.z) ?? false;
  }

  /** 从 p 看得见车吗（中间有没有山、墙、楼挡着） */
  private sees(p: THREE.Vector3): boolean {
    return !this.physics.blocked(p, this.center, 3.5);
  }

  /* ------------------------------ 摆镜头 ------------------------------ */

  /** 把镜头摆到 eye、看向 look。fresh 的第一帧直接到位，之后按 rate 跟过去 */
  private aim(eye: THREE.Vector3, look: THREE.Vector3, dt: number, eyeRate: number, lookRate: number): void {
    if (this.fresh) {
      this.eye.copy(eye);
      this.look.copy(look);
    } else {
      this.eye.lerp(eye, damp(eyeRate, dt));
      this.look.lerp(look, damp(lookRate, dt));
    }
  }

  /** 定点机位：镜头不动，盯着车，按距离变焦。frame = 画面里要装下多高的一块（米） */
  private fixed(kind: Kind, p: THREE.Vector3, sCam: number, frame: number, minFov: number, maxFov: number, pass: number): Shot {
    const spot = p.clone();
    return {
      kind,
      name: NAMES[kind],
      length: 10,
      tick: (dt) => {
        // 盯着车前面一点：车冲过来的时候不会掉到画面外面去
        _a.copy(this.center).addScaledVector(this.fwd, clamp(this.v!.speed * 0.1, 0, 4));
        this.aim(spot, _a, dt, 30, 9);
        this.eye.copy(spot);
        const dist = Math.max(spot.distanceTo(this.center), 2);
        this.fovTarget = clamp((2 * Math.atan(frame / 2 / dist) * 180) / Math.PI, minFov, maxFov);
        this.focus = dist;
        this.bokeh = this.fovTarget < 30 ? 0.55 : 0.3;
        this.roll = 0;
        return this.pastBy(sCam) < pass && this.hidden < 0.4;
      },
    };
  }

  private build(kind: Kind): Shot | null {
    const v = this.v!;
    const speed = Math.max(v.speed, 6);
    const side = this.rnd() < 0.5 ? 1 : -1;
    const span = (lo: number, hi: number) => lo + this.rnd() * (hi - lo);

    if (kind === 'trackside' || kind === 'tower' || kind === 'crane') {
      const lead = kind === 'crane' ? clamp(speed * 2.0, 45, 110) : clamp(speed * 2.3, 45, 135);
      const sCam = this.along + lead;
      const k = this.curvatureAt(sCam);
      // 弯里站在外侧：车是冲着镜头来的
      const out = Math.abs(k) > 1 / 220 ? -Math.sign(k) : side;
      const p = new THREE.Vector3();
      if (kind === 'trackside') {
        this.pointAt(sCam, out * 8.5, span(0.8, 1.7), p);
        this.floor(p, 0.5);
      } else if (kind === 'tower') {
        this.pointAt(sCam, out * 12, 7.5, p);
        this.floor(p, 3);
        if (this.covered(p) || this.covered(this.pos)) return null;
      } else {
        this.pointAt(sCam, out * 4.5, 9.5, p);
        if (this.covered(p) || this.covered(this.pos)) return null;
      }
      if (!this.sees(p)) return null;
      return kind === 'crane' ? this.fixed(kind, p, sCam, 12, 22, 66, 32) : this.fixed(kind, p, sCam, kind === 'tower' ? 11 : 9.5, 13, 58, 28);
    }

    if (kind === 'heli') {
      if (this.covered(this.pos)) return null;
      const back = span(16, 22);
      const high = span(22, 30);
      return {
        kind,
        name: NAMES[kind],
        length: span(5, 7),
        tick: (dt) => {
          _a.copy(this.pos).addScaledVector(this.fwd, -back).addScaledVector(this.left, side * 10);
          _a.y += high;
          _b.copy(this.pos).addScaledVector(this.fwd, 7);
          this.aim(_a, _b, dt, 2.2, 6);
          this.fovTarget = 38;
          this.bokeh = 0;
          this.roll = 0;
          return !this.covered(this.pos) && this.hidden < 0.6;
        },
      };
    }

    if (kind === 'front') {
      return {
        kind,
        name: NAMES[kind],
        length: span(4, 5.5),
        tick: (dt, t) => {
          this.pointAt(this.along + Math.max(8.5, 12.5 - 0.8 * t), side * 2.4, 0.8, _a);
          this.floor(_a, 0.35);
          this.aim(_a, this.center, dt, 9, 12);
          this.fovTarget = 36 - t * 0.6;
          this.focus = this.eye.distanceTo(this.center);
          this.bokeh = 0.4;
          this.roll = 0;
          return true;
        },
      };
    }

    if (kind === 'side') {
      // 站在路宽的那一侧
      const S = this.stage.track!.samples[this.index];
      const lat = (this.pos.x - S.pos.x) * S.left.x + (this.pos.z - S.pos.z) * S.left.z;
      const s = lat > 1 ? -1 : lat < -1 ? 1 : side;
      return {
        kind,
        name: NAMES[kind],
        length: span(3.5, 5),
        tick: (dt, t) => {
          _a.copy(this.pos).addScaledVector(this.fwd, 2.6 - 0.8 * t).addScaledVector(this.left, s * 6);
          _a.y += 1.0;
          this.keepInside(_a, 8.2);
          this.floor(_a, 0.4);
          _b.copy(this.pos).addScaledVector(this.fwd, 0.6);
          _b.y += 0.55;
          this.aim(_a, _b, dt, 10, 14);
          this.fovTarget = 42;
          this.focus = this.eye.distanceTo(this.center);
          this.bokeh = 0.35;
          this.roll = 0;
          return true;
        },
      };
    }

    if (kind === 'low') {
      return {
        kind,
        name: NAMES[kind],
        length: span(3.5, 5),
        tick: (dt) => {
          const fast = clamp(v.speed / 80, 0, 1);
          _a.copy(this.pos).addScaledVector(this.fwd, -(5.4 + fast)).addScaledVector(this.left, side * 1.3);
          _a.y += 0.42;
          this.floor(_a, 0.25);
          _b.copy(this.pos).addScaledVector(this.fwd, 7);
          _b.y += 0.8;
          this.aim(_a, _b, dt, 12, 10);
          this.fovTarget = 74 + fast * 8 + (v.nitroActive ? 6 : 0);
          this.bokeh = 0;
          this.roll += (clamp(v.lateralG * 0.05, -0.12, 0.12) - this.roll) * damp(4, dt);
          return true;
        },
      };
    }

    if (kind === 'orbit') {
      const from = Math.PI + side * 0.7;
      const turn = -side * 0.5;
      return {
        kind,
        name: NAMES[kind],
        length: span(5, 6.5),
        tick: (dt, t) => {
          const a = this.heading + from + turn * t;
          _a.set(this.pos.x + Math.sin(a) * 6.6, this.pos.y + 1.3 + 0.5 * Math.sin(t * 0.6), this.pos.z + Math.cos(a) * 6.6);
          this.keepInside(_a, 8.0);
          this.floor(_a, 0.4);
          this.aim(_a, this.center, dt, 8, 14);
          this.fovTarget = 44;
          this.focus = this.eye.distanceTo(this.center);
          this.bokeh = 0.3;
          this.roll = 0;
          return true;
        },
      };
    }

    if (kind === 'wheel') {
      return {
        kind,
        name: NAMES[kind],
        length: span(2.6, 3.6),
        tick: (dt) => {
          // 绑在车身上：跟着车身一起甩
          _a.set(side * 1.7, 0.4, -2.7).applyQuaternion(this.quat).add(this.pos);
          this.floor(_a, 0.2);
          _b.set(side * 0.75, 0.5, 4.0).applyQuaternion(this.quat).add(this.pos);
          this.aim(_a, _b, dt, 40, 40);
          this.fovTarget = 62;
          this.bokeh = 0;
          this.near = 0.08;
          this.roll = 0;
          return true;
        },
      };
    }

    return { kind: 'chase', name: NAMES.chase, length: span(4, 6), tick: () => true };
  }

  /** 挑下一个镜头 */
  private next(): void {
    const v = this.v!;
    const drifting = v.drifting;
    const slow = v.speed < 10;
    const under = this.covered(this.pos);
    const open = this.stage.openVerge ?? false;
    const weights: [Kind, number][] = [
      ['trackside', slow ? 0 : 3.2 * (drifting ? 1.3 : 1)],
      ['tower', slow || under || !open ? 0 : 1.8 * (drifting ? 1.5 : 1)],
      ['crane', slow || under ? 0 : 1.5],
      ['heli', under ? 0 : 2.0 * (drifting ? 1.8 : 1)],
      ['front', 2.2 * (drifting ? 2 : 1)],
      ['side', 1.8 * (drifting ? 0.6 : 1) * (slow ? 1.5 : 1)],
      ['low', 2.0],
      ['orbit', 1.0 * (drifting ? 0.5 : 1) * (slow ? 2 : 1)],
      ['wheel', 1.2 * (drifting ? 1.8 : 1)],
      ['chase', 1.4],
    ];
    const h = this.history;
    let shot: Shot | null = null;
    for (let attempt = 0; attempt < 7 && !shot; attempt++) {
      let total = 0;
      for (const w of weights) {
        // 不连着用同一种；再往前一个的也少用
        if (w[0] === h[h.length - 1] || w[0] === h[h.length - 2]) continue;
        total += w[0] === h[h.length - 3] ? w[1] * 0.4 : w[1];
      }
      let r = this.rnd() * total;
      let kind: Kind = 'low';
      for (const w of weights) {
        if (w[0] === h[h.length - 1] || w[0] === h[h.length - 2]) continue;
        r -= w[0] === h[h.length - 3] ? w[1] * 0.4 : w[1];
        if (r <= 0) {
          kind = w[0];
          break;
        }
      }
      shot = this.build(kind);
      // 这个机位这会儿摆不了（头顶有遮挡、看不见车）：这一轮别再挑它
      if (!shot) for (const w of weights) if (w[0] === kind) w[1] = 0;
    }
    this.shot = shot ?? this.build('low')!;
    h.push(this.shot.kind);
    if (h.length > 4) h.shift();
    this.shotTime = 0;
    this.fresh = true;
    this.hidden = 0;
    this.sightTimer = 0;
    this.roll = 0;
    this.cut = true;
  }

  /**
   * 每帧调用，在平时的追尾镜头算完之后。
   * @param pos,quat 车这一帧画在哪儿
   */
  update(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion, v: Vehicle, stage: CineStage): void {
    this.delegate = true;
    if (!stage.track) return;
    this.stage = stage;
    this.v = v;
    this.time += dt;
    this.pos.copy(pos);
    this.quat.copy(quat);
    this.center.copy(pos);
    this.center.y += 0.6;
    this.locate();

    // 行进方向：车速够的话按速度方向，不然按车头
    const lv = v.body.linvel();
    _c.set(0, 0, 1).applyQuaternion(quat);
    const want = Math.hypot(lv.x, lv.z) > 5 && v.forwardSpeed > 0 ? Math.atan2(lv.x, lv.z) : Math.atan2(_c.x, _c.z);
    if (!this.shot) this.heading = want;
    this.heading += angleDiff(want, this.heading) * damp(5, dt);
    this.fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.left.set(Math.cos(this.heading), 0, -Math.sin(this.heading));

    // 刚甩起来：贴着车身侧面的那几个机位看不清车身的角度，换一个
    const started = v.drifting && !this.wasDrifting;
    this.wasDrifting = v.drifting;
    const soft = this.shot && (this.shot.kind === 'side' || this.shot.kind === 'orbit' || this.shot.kind === 'chase' || this.shot.kind === 'low');
    if (!this.shot || this.shotTime >= this.shot.length || (started && soft && this.shotTime > 1.4)) this.next();

    this.near = 0.2;
    let alive = this.shot!.tick(dt, this.shotTime);
    if (!alive) {
      this.next();
      alive = this.shot!.tick(dt, 0);
    }
    this.shotTime += dt;
    this.delegate = this.shot!.kind === 'chase';
    if (this.delegate) {
      this.bokeh = 0;
      this.fresh = false;
      return;
    }

    // 隔一会儿查一次视线（不动的和飞在天上的机位才会被挡）
    const kind = this.shot!.kind;
    if (kind === 'trackside' || kind === 'tower' || kind === 'crane' || kind === 'heli') {
      this.sightTimer -= dt;
      if (this.sightTimer <= 0) {
        this.sightTimer = 0.12;
        this.hidden = this.sees(this.eye) ? 0 : this.hidden + 0.12;
      }
    }

    const cam = this.camera;
    // 一点点手持的晃动：完全不动的画面像是游戏里的固定机位，不像有人在拍
    const t = this.time;
    const sway = kind === 'wheel' ? 0 : 0.012;
    cam.position.set(this.eye.x + Math.sin(t * 1.7) * sway, this.eye.y + Math.sin(t * 2.3 + 1.1) * sway, this.eye.z + Math.cos(t * 1.9) * sway);
    cam.up.copy(UP);
    cam.lookAt(this.look);
    if (this.roll) cam.rotateZ(this.roll);
    this.fov = this.fresh ? this.fovTarget : this.fov + (this.fovTarget - this.fov) * damp(7, dt);
    const fov = fitFov(this.fov, cam.aspect);
    if (Math.abs(cam.fov - fov) > 0.01 || cam.near !== this.near) {
      cam.fov = fov;
      cam.near = this.near;
      cam.updateProjectionMatrix();
    }
    this.fresh = false;
  }
}
