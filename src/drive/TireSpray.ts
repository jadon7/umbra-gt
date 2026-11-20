import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, length, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { fxDepthFade } from '../core/fx.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const MAX = 320;

interface WheelLike {
  grounded: boolean;
  contact: { x: number; y: number; z: number };
  skid: number;
}

/**
 * 轮胎水雾：湿地面上车轮把水卷起来，甩成一团团往后飘的雾。
 * 粒子在 CPU 上模拟（几百个），画成朝着镜头的软边圆片，放在特效叠加层里。
 * 水雾会被路灯、车头大灯照亮，贴近车尾的部分被尾灯染红。
 */
export class TireSpray {
  readonly group = new THREE.Group();

  private readonly pos = new Float32Array(MAX * 3);
  /** 每个粒子：大小、不透明度 */
  private readonly info = new Float32Array(MAX * 2);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly age = new Float32Array(MAX).fill(1e9);
  private readonly life = new Float32Array(MAX).fill(1);
  private readonly size0 = new Float32Array(MAX);
  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly infoAttr: THREE.InstancedBufferAttribute;
  private readonly ambient = uniform(new THREE.Color(0.3, 0.3, 0.32));
  private readonly tail = uniform(0);
  private readonly carry = [0, 0, 0, 0];
  private next = 0;
  private alive = 0;
  private density = 1;

  /**
   * @param airLight 地图提供的"空中一点有多亮"；没有的话水雾只用环境色
   * @param open 地图提供的"这个位置头顶是不是露天"（1 = 露天）：高架下面、下层街道淋不到雨也积不了雪，那里没有水雾
   */
  constructor(airLight?: (p: N) => N, open?: (p: N) => N) {
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 2);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.infoAttr.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
    const p: N = instancedBufferAttribute(this.posAttr);
    const info: N = instancedBufferAttribute(this.infoAttr);
    mat.positionNode = p;
    mat.scaleNode = info.x;
    const d: N = length(uv().sub(0.5)).mul(2.0);
    const soft: N = smoothstep(1.0, 0.15, d);
    const lit: N = airLight ? this.ambient.add(airLight(p).mul(0.18)) : this.ambient;
    mat.colorNode = lit.add(vec3(1.0, 0.06, 0.03).mul(this.tail));
    const sky: N = open ? open(p) : 1;
    mat.opacityNode = soft.mul(info.y).mul(sky).mul(fxDepthFade(0.7));
    mat.fog = false;

    const sprite = new THREE.Sprite(mat);
    sprite.count = MAX;
    sprite.frustumCulled = false;
    this.group.add(sprite);
    this.group.visible = false;
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size;
  }

  /**
   * @param wheels 四个车轮的物理状态（前左、前右、后左、后右）
   * @param carVel 车的速度（世界坐标，米/秒）
   * @param wetness 地面有多湿 0–1
   * @param ambient 水雾的底色（跟着天光）
   * @param tailGlow 尾灯亮度（刹车时更红）
   * @param density 浓度倍率：水雾是 1，雪粉更浓
   */
  update(dt: number, wheels: WheelLike[], carVel: THREE.Vector3, wetness: number, ambient: THREE.Color, tailGlow: number, density = 1): void {
    this.density = density;
    const speed = Math.hypot(carVel.x, carVel.z);
    this.ambient.value.copy(ambient);
    this.tail.value = tailGlow * 0.22;

    // 车速越快、地越湿，卷起来的水越多；后轮比前轮多（前轮的水大半打在轮拱里）
    const amount = wetness > 0.12 ? Math.min(1, (wetness - 0.12) / 0.5) * Math.min(1, Math.max(0, (speed - 4) / 32)) : 0;
    if (amount > 0 && dt > 0) {
      const inv = speed > 0.1 ? 1 / speed : 0;
      const fx = carVel.x * inv;
      const fz = carVel.z * inv;
      for (let k = 0; k < wheels.length && k < 4; k++) {
        const w = wheels[k];
        if (!w.grounded) continue;
        const rate = (k >= 2 ? 60 : 22) * amount * (1 + w.skid * 0.8);
        this.carry[k] += rate * dt;
        while (this.carry[k] >= 1) {
          this.carry[k] -= 1;
          const side = (Math.random() - 0.5) * 2;
          // 水被轮胎往后上方甩出去；在地面坐标系里看，它带着车一部分的速度往前飘
          const keep = 0.18 + Math.random() * 0.3;
          const up = 1.4 + Math.random() * 2.6 + speed * 0.035;
          this.emit(
            w.contact.x - fx * 0.25 - fz * side * 0.12,
            w.contact.y + 0.12,
            w.contact.z - fz * 0.25 + fx * side * 0.12,
            carVel.x * keep - fz * side * 1.3,
            up,
            carVel.z * keep + fx * side * 1.3,
            0.45 + Math.random() * 0.5,
            0.28 + Math.random() * 0.25,
          );
        }
      }
    }

    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      const a = this.age[i] + dt;
      this.age[i] = a;
      const t = a / this.life[i];
      if (t >= 1) {
        this.info[i * 2] = 0;
        this.info[i * 2 + 1] = 0;
        continue;
      }
      alive++;
      // 空气阻力很大：水雾很快就慢下来，悬在原地散开
      const drag = Math.exp(-dt * 2.6);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 2] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * Math.exp(-dt * 1.8) - 2.2 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt, 0.05);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.info[i * 2] = this.size0[i] * (1 + t * 3.6);
      this.info[i * 2 + 1] = Math.min(1, t * 9) * (1 - t) * (1 - t) * 0.13 * this.density;
    }
    this.alive = alive;
    this.group.visible = alive > 0;
    if (alive > 0 || amount > 0) {
      this.posAttr.needsUpdate = true;
      this.infoAttr.needsUpdate = true;
    }
  }

  /** 清掉所有粒子（复位、离开试驾时） */
  clear(): void {
    this.age.fill(1e9);
    this.info.fill(0);
    this.infoAttr.needsUpdate = true;
    this.group.visible = false;
    this.alive = 0;
  }

  get count(): number {
    return this.alive;
  }
}
