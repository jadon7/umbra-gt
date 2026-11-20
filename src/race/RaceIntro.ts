import * as THREE from 'three/webgpu';

/** 开场镜头里的一辆车：停在发车格上的位置、朝向和大致尺寸 */
export interface IntroCar {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** 车长、车高（米） */
  length: number;
  height: number;
  /** 前轮：离车身中线多远、轮心高度（= 轮胎半径）、在车身中心前方多远 */
  wheelX: number;
  wheelR: number;
  wheelZ: number;
  /** 这辆车哪一侧是空的（+1 左、-1 右）：镜头架在这一侧，不会钻进旁边那辆车里 */
  side: 1 | -1;
  /** 名牌上写的：发车位、名字、车型、代表色 */
  slot: number;
  name: string;
  model: string;
  color: string;
}

/** 画面上此刻该显示的字 */
export interface IntroCaption {
  kind: 'event' | 'racer' | 'player';
  title: string;
  sub: string;
  color: string;
  /** 发车位（赛事标题没有） */
  slot: number;
  /** 这块字已经显示了多久、还剩多久（秒）：界面按它做进出场 */
  age: number;
  left: number;
}

interface Shot {
  duration: number;
  /** 这个镜头拍的是哪辆车（全景没有）：补光围着它打 */
  subject: IntroCar | null;
  caption: Omit<IntroCaption, 'age' | 'left'> | null;
  /** 虚化程度：特写大、全景小 */
  bokeh: number;
  /** 写入这一刻的机位：镜头位置、看向哪里；返回视野（度） */
  pose(t: number, pos: THREE.Vector3, target: THREE.Vector3): number;
  /** 这个镜头里什么时候轰油门（0–1 的起止），没有就不轰 */
  rev?: [number, number];
  /** 这个镜头里前轮打多少方向（-1..1，正值向左）：拍车轮的时候把轮毂正面转向镜头 */
  steer?: number;
  /** 松油门的那一下排气管回火（0–1 的时刻） */
  pop?: number;
  /** 最后一个镜头：从什么时候开始把机位交给追尾镜头 */
  handoff?: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * 比赛开始前的一组特写镜头：发车线全景 → 两个对手 → 自己的车头 → 前轮 → 车尾 → 绕到车尾，交给追尾镜头，然后才开始倒数。
 *
 * 参考的是《极品飞车》几代的做法：开赛前先用几个快切的镜头带一遍场上的车，再甩回玩家的车尾、倒计时出现；
 * 镜头之间直接硬切，不做淡入淡出。
 *
 * 这个类只管"此刻镜头该在哪、该显示什么字、该不该轰油门"，不碰画面和声音。
 */
export class RaceIntro {
  /** 这一帧的结果 */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  fov = 40;
  focus = 6;
  bokeh = 0;
  /** 该给玩家的车多少油门（轰油门的声音和转速表跟着它） */
  throttle = 0;
  /** 该给玩家的车打多少方向 */
  steer = 0;
  /** 这一帧要不要来一下排气回火 */
  pop = false;
  /** 这一帧是不是刚切到下一个镜头 */
  cut = false;
  /** 把机位交给追尾镜头的比例：0 全听开场镜头，1 全听追尾镜头 */
  handoff = 0;
  /** 整段开场的进度 0–1 */
  progress = 0;
  caption: IntroCaption | null = null;
  /** 这个镜头拍的那辆车的中心（全景镜头是整个发车格的中心）：补光围着它打 */
  readonly subject = new THREE.Vector3();
  done = false;

  private readonly shots: Shot[] = [];
  private index = 0;
  private time = 0;
  private popped = false;
  private readonly total: number;

  constructor(player: IntroCar, rivals: IntroCar[], event: { title: string; sub: string }) {
    const cars = [...rivals, player];
    // 发车格的中心和朝向（所有车朝同一个方向）
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quat).setY(0).normalize();
    const left = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const front = cars.reduce((best, c) => (c.pos.dot(fwd) > best.pos.dot(fwd) ? c : best), cars[0]);
    const mid = new THREE.Vector3();
    for (const c of cars) mid.add(c.pos);
    mid.multiplyScalar(1 / cars.length);
    const span = Math.max(8, front.pos.clone().sub(player.pos).dot(fwd));

    /** 车身坐标（x 左、y 上、z 前）→ 世界坐标 */
    const local = (car: IntroCar, x: number, y: number, z: number, out: THREE.Vector3) => out.set(x, y, z).applyQuaternion(car.quat).add(car.pos);

    /** 一个围着某辆车的镜头：机位和目标各从一处滑到另一处（都用车身坐标写） */
    const around = (
      car: IntroCar,
      from: [number, number, number],
      to: [number, number, number],
      lookFrom: [number, number, number],
      lookTo: [number, number, number],
      fov: [number, number],
    ) => {
      return (t: number, pos: THREE.Vector3, target: THREE.Vector3): number => {
        // 慢而匀速的推移：特写镜头里车是主角，镜头不抢戏
        const k = t;
        local(car, lerp(from[0], to[0], k), lerp(from[1], to[1], k), lerp(from[2], to[2], k), pos);
        local(car, lerp(lookFrom[0], lookTo[0], k), lerp(lookFrom[1], lookTo[1], k), lerp(lookFrom[2], lookTo[2], k), target);
        return lerp(fov[0], fov[1], k);
      };
    };
    const card = (c: IntroCar, kind: 'racer' | 'player') => ({ kind, title: c.name, sub: c.model, color: c.color, slot: c.slot });

    /* 1. 全景：贴近路面，从发车线前面慢慢横移着推向车阵。镜头压得低，湿路面上的倒影和远处虚化的灯都在画面里 */
    this.shots.push({
      duration: 2.6,
      subject: null,
      caption: { kind: 'event', title: event.title, sub: event.sub, color: '#f4f4f2', slot: 0 },
      bokeh: 1.5,
      pose: (t, pos, target) => {
        pos.copy(front.pos).addScaledVector(fwd, lerp(15.5, 12.5, t)).addScaledVector(left, lerp(-3.4, 2.2, t));
        pos.y += lerp(1.05, 0.7, t);
        target.copy(mid).addScaledVector(fwd, span * 0.3);
        target.y += 0.6;
        return lerp(30, 27, t);
      },
    });

    /* 2、3. 两个对手：排头的那辆从车头斜前方贴地推近；另一辆从车尾斜后方滑过。长焦、慢推，背景压成一片光斑 */
    const pole = rivals.find((r) => r.slot === 1) ?? rivals[0];
    if (pole) {
      const s = pole.side;
      const L = pole.length / 2;
      const h = pole.height;
      this.shots.push({
        duration: 1.5,
        subject: pole,
        caption: card(pole, 'racer'),
        bokeh: 3.4,
        pose: around(pole, [s * 3.3, 0.42, L + 3.6], [s * 2.7, 0.46, L + 3.0], [0, h * 0.5, L - 0.9], [0, h * 0.5, L - 1.0], [26, 25]),
      });
    }
    const other = rivals.filter((r) => r !== pole).sort((a, b) => b.slot - a.slot)[0];
    if (other) {
      const s = other.side;
      const L = other.length / 2;
      const h = other.height;
      this.shots.push({
        duration: 1.4,
        subject: other,
        caption: card(other, 'racer'),
        bokeh: 3.2,
        pose: around(other, [s * 2.4, h * 0.5, -L - 3.9], [s * 3.1, h * 0.46, -L - 3.2], [0, h * 0.5, -L + 0.9], [0, h * 0.5, -L + 0.7], [27, 26]),
      });
    }

    /* 4. 自己的车：车头斜前方的低机位，慢慢往车头滑。大灯、车漆上的街灯倒影、湿路面，都在这一个镜头里 */
    {
      const s = player.side;
      const L = player.length / 2;
      const h = player.height;
      const k = Math.max(1, h / 1.2);
      this.shots.push({
        duration: 1.7,
        subject: player,
        caption: null,
        bokeh: 3.0,
        rev: [0.3, 0.7],
        pose: around(player, [s * 3.4 * k, 0.34 * k, L + 2.2 * k], [s * 2.5 * k, 0.4 * k, L + 2.9 * k], [0, h * 0.46, L - 1.1], [0, h * 0.46, L - 0.8], [28, 27]),
      });
    }

    /* 5. 自己的前轮：贴着地面，从车头外侧滑到车轮正侧面，同时轰一脚油门 */
    {
      const s = player.side;
      const r = player.wheelR;
      const wx = player.wheelX;
      const wz = player.wheelZ;
      this.shots.push({
        duration: 1.3,
        subject: player,
        caption: null,
        bokeh: 4.2,
        rev: [0.18, 0.62],
        // 前轮往里打一把：轮毂的正面就朝向架在车头外侧的镜头了
        steer: -s * 0.7,
        pose: around(player, [s * (wx + 1.5 + r), r * 0.72, wz + 1.8], [s * (wx + 1.3 + r), r * 0.8, wz + 0.8], [s * wx, r * 1.02, wz - 0.1], [s * wx, r * 1.05, wz - 0.2], [28, 27]),
      });
    }

    /* 6. 自己的车尾：贴着地面从一侧滑到正后方，再轰一脚，松油门的时候排气管回火 */
    {
      const s = player.side;
      const L = player.length / 2;
      const h = player.height;
      // 车越高离得越远：皮卡的车尾比跑车高出一大截，同样的距离只拍得到一块尾门
      const k = Math.max(1, h / 1.2);
      this.shots.push({
        duration: 1.5,
        subject: player,
        caption: null,
        bokeh: 3.2,
        rev: [0.12, 0.58],
        pop: 0.6,
        pose: around(player, [s * 1.6 * k, h * 0.3, -L - 3.0 * k], [-s * 0.3 * k, h * 0.36, -L - 2.8 * k], [0, h * 0.42, -L + 0.4], [0, h * 0.42, -L + 0.2], [29, 28]),
      });
    }

    /* 7. 绕着自己的车从斜前方转到车尾，最后交给追尾镜头 */
    {
      const s = player.side;
      const k = Math.max(1, player.length / 4.4);
      const h = player.height;
      this.shots.push({
        duration: 2.1,
        subject: player,
        caption: card(player, 'player'),
        bokeh: 2.0,
        handoff: 0.62,
        pose: (t, pos, target) => {
          const e = ease(t);
          // 从车头外侧 40° 的位置转到正后方
          const angle = lerp(0.72, Math.PI, e) * s;
          const radius = lerp(4.6, 6.4, e) * k;
          local(player, Math.sin(angle) * radius, lerp(0.55, 1.5, e) * Math.max(1, h / 1.25), Math.cos(angle) * radius, pos);
          local(player, 0, h * 0.5, lerp(0.3, 1.6, e), target);
          return lerp(34, 50, e);
        },
      });
    }

    this.total = this.shots.reduce((sum, s) => sum + s.duration, 0);
  }

  /** 整段多长（秒） */
  get duration(): number {
    return this.total;
  }

  /** 跳过剩下的镜头 */
  skip(): void {
    this.done = true;
    this.handoff = 1;
    this.caption = null;
    this.throttle = 0;
    this.steer = 0;
    this.progress = 1;
  }

  update(dt: number): void {
    this.pop = false;
    this.cut = false;
    if (this.done) return;
    this.time += dt;
    while (this.index < this.shots.length && this.time >= this.shots[this.index].duration) {
      this.time -= this.shots[this.index].duration;
      this.index++;
      this.popped = false;
      this.cut = true;
    }
    if (this.index >= this.shots.length) {
      this.skip();
      return;
    }
    const shot = this.shots[this.index];
    const t = this.time / shot.duration;
    this.fov = shot.pose(t, _a, _b);
    this.position.copy(_a);
    _m.lookAt(_a, _b, UP);
    this.quaternion.setFromRotationMatrix(_m);
    // 镜头整体带一点点手持的晃动，不是架在三脚架上的死机位
    const elapsed = this.shots.slice(0, this.index).reduce((sum, s) => sum + s.duration, 0) + this.time;
    _q.setFromEuler(new THREE.Euler(Math.sin(elapsed * 2.3) * 0.0035, Math.sin(elapsed * 1.7 + 1.3) * 0.0045, Math.sin(elapsed * 1.1 + 0.5) * 0.003));
    this.quaternion.multiply(_q);
    this.focus = _a.distanceTo(_b);
    if (shot.subject) this.subject.copy(shot.subject.pos).setY(shot.subject.pos.y + shot.subject.height * 0.45);
    else this.subject.copy(_b);
    this.bokeh = shot.bokeh;
    this.throttle = shot.rev && t >= shot.rev[0] && t < shot.rev[1] ? 1 : 0;
    this.steer = shot.steer ?? 0;
    if (shot.pop !== undefined && t >= shot.pop && !this.popped) {
      this.popped = true;
      this.pop = true;
    }
    this.handoff = shot.handoff !== undefined ? ease(Math.min(1, Math.max(0, (t - shot.handoff) / (1 - shot.handoff)))) : 0;
    this.progress = elapsed / this.total;
    this.caption = shot.caption ? { ...shot.caption, age: this.time, left: shot.duration - this.time } : null;
  }
}
