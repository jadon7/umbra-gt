import * as THREE from 'three/webgpu';
import { cameraViewMatrix, dot, float, instancedBufferAttribute, length, mix, normalize, positionView, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { fxDepthFade } from '../core/fx.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const NOISE_SIZE = 256;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 烟的质感贴图：一张能无缝平铺的云雾噪声，启动时算出来，没有外部图片。
 *  - 红：这里的烟有多浓（五层由粗到细的噪声叠起来，像云）
 *  - 绿、蓝：浓度往左右、上下变化得有多快。着色器拿它当表面的起伏，算每一小团的受光面和背光面
 *
 * 每团烟各取这张图上的一小块（位置随机、还会随时间慢慢挪），所以没有两团是一样的，
 * 也看不出是"同一张贴图贴了很多次"。
 */
function createSmokeNoise(): THREE.DataTexture {
  const S = NOISE_SIZE;
  const h = new Float32Array(S * S);
  const rnd = rng(31337);
  let amp = 1;
  let total = 0;
  for (const period of [4, 8, 16, 32, 64]) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
    const cell = S / period;
    for (let y = 0; y < S; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % period) * period;
      const yb = ((y0 + 1) % period) * period;
      for (let x = 0; x < S; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % period;
        const xb = (x0 + 1) % period;
        const top = lattice[ya + xa] + (lattice[ya + xb] - lattice[ya + xa]) * sx;
        const bot = lattice[yb + xa] + (lattice[yb + xb] - lattice[yb + xa]) * sx;
        h[y * S + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.56;
  }
  // 拉开对比：浓的地方更浓、稀的地方更稀，烟才有一缕一缕的层次
  for (let i = 0; i < h.length; i++) {
    const v = (h[i] / total - 0.5) * 2.3 + 0.5;
    h[i] = Math.min(1, Math.max(0, v));
  }
  const data = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const gx = (at(x + 2, y) - at(x - 2, y)) * 2.2;
      const gy = (at(x, y + 2) - at(x, y - 2)) * 2.2;
      const o = (y * S + x) * 4;
      data[o] = Math.round(h[y * S + x] * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + gx)) * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + gy)) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let noise: THREE.DataTexture | null = null;
function smokeNoise(): THREE.DataTexture {
  if (!noise) noise = createSmokeNoise();
  return noise;
}

/**
 * 一批烟：朝着镜头的软边面片，一次画完，画在特效叠加层里。
 *
 * 追求的是真烟的样子，不是一团团的棉花球：
 *  - 每一片没有清楚的轮廓：边缘是按云雾噪声一点点淡出去的，几十片叠在一起才成一股烟
 *  - 有受光面和背光面：被太阳（月亮）照到的一侧亮，另一侧暗；路灯从上面照下来；贴近车尾的地方被尾灯染红
 *  - 越散越薄：消散是从稀的地方先没，留下几缕浓的，而不是整片均匀变透明
 */
export class SmokeBatch {
  readonly object: THREE.Sprite;
  readonly capacity: number;
  /** 背光面的颜色（相对受光面） */
  readonly shade = uniform(new THREE.Color(0.2, 0.2, 0.3));
  /** 环境光（跟着时段和天气） */
  readonly ambient = uniform(new THREE.Color(0.5, 0.5, 0.5));
  /** 主光（太阳或月亮）：从烟指向光源的方向（世界坐标）、颜色乘亮度 */
  readonly keyDir = uniform(new THREE.Vector3(0.3, 0.8, 0.5).normalize());
  readonly keyColor = uniform(new THREE.Color(0, 0, 0));
  /** 夜里烟自己带的一点亮度：没有它，离路灯远的烟是纯黑的一片 */
  readonly glow = uniform(0.3);
  /** 尾灯：位置和亮度。刹车时车尾的烟被染红 */
  readonly tailPos = uniform(new THREE.Vector3(0, -100, 0));
  readonly tailGlow = uniform(0);

  private readonly pos: Float32Array;
  /** 大小、旋转、不透明度、消散程度 */
  private readonly xf: Float32Array;
  /** 颜色 rgb + 这一片取噪声图上哪一块（0–1 的随机数） */
  private readonly tint: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];

  /** @param airLight 地图提供的"空中一点被灯照到多亮"；没有的话只用环境光和主光 */
  constructor(capacity: number, airLight?: (p: N) => N) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.xf = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 4);
    const posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
    const xfAttr = new THREE.InstancedBufferAttribute(this.xf, 4);
    const tintAttr = new THREE.InstancedBufferAttribute(this.tint, 4);
    this.attrs = [posAttr, xfAttr, tintAttr];
    for (const a of this.attrs) a.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
    const p: N = instancedBufferAttribute(posAttr);
    const xf: N = instancedBufferAttribute(xfAttr);
    const tint: N = instancedBufferAttribute(tintAttr);
    mat.positionNode = p;
    mat.scaleNode = xf.x;
    mat.rotationNode = xf.y;
    mat.fog = false;

    const erode: N = xf.w;
    const seed: N = tint.w;
    // 面片上的位置：中心是 0，边缘是 1
    const c: N = uv().sub(0.5).mul(2.0);
    const fall: N = float(1).sub(dot(c, c)).clamp(0, 1);
    // 各取噪声图上的一小块；随着消散慢慢挪，烟的纹理是在流动的
    const at: N = c.mul(0.15).add(vec2(seed.mul(7.31), seed.mul(3.17))).add(vec2(erode.mul(0.1), erode.mul(-0.06)));
    const n: N = texture(smokeNoise(), at);
    // 第二层更细的纹理，烟的边缘才是丝丝缕缕的
    const fine: N = texture(smokeNoise(), c.mul(0.36).add(vec2(seed.mul(2.9), seed.mul(5.3)))).r;
    const dens: N = n.r.mul(0.84).add(fine.mul(0.16));
    // 浓度：中间厚、边上薄，乘上云雾纹理
    const body: N = fall.mul(fall).mul(dens.mul(1.7).add(0.22));
    // 消散：门槛越来越高，稀的地方先没。门槛带很宽，所以任何时候都没有硬边
    const shape: N = smoothstep(erode, erode.add(0.62), body);

    // 受光：把面片当成一个鼓起来的球面，再按纹理的起伏扰动
    const bump: N = n.gb.sub(0.5).mul(0.9);
    const normal: N = normalize(vec3(c.x.mul(0.8).add(bump.x), c.y.mul(0.8).add(bump.y), sqrt(fall).add(0.3)));
    const toKey: N = normalize((cameraViewMatrix as N).mul(vec4(this.keyDir as N, 0.0)).xyz);
    const facing: N = dot(normal, toKey).mul(0.5).add(0.5);
    const key: N = (this.keyColor as N).mul(facing.mul(facing));
    // 逆光：光源在烟后面时，烟的薄边被照得发亮
    const rim: N = (this.keyColor as N).mul(toKey.z.negate().max(0.0)).mul(float(1).sub(fall).pow(1.5)).mul(0.6);
    // 路灯在上面：朝上的一面亮
    const top: N = normal.y.mul(0.35).add(0.65);
    const lamp: N = airLight ? airLight(p).mul(0.22).mul(top) : vec3(0.0);
    const tailDist: N = length(p.sub(this.tailPos as N));
    const tail: N = vec3(1.0, 0.07, 0.03).mul(this.tailGlow).div(tailDist.mul(tailDist).mul(0.55).add(1.0));
    const light: N = (this.ambient as N).mul(top).add(key).add(rim).add(lamp).add(this.glow).add(tail);
    // 背光的一面、烟厚的地方（光透不进去）往暗色偏
    const shadeAmount: N = smoothstep(0.7, 0.2, facing).mul(0.55).add(shape.mul(dens).mul(0.3)).clamp(0, 1);
    mat.colorNode = mix(tint.rgb, (this.shade as N).mul(tint.rgb.add(0.35)), shadeAmount).mul(light);
    // 贴着镜头的烟淡掉，不然一片白挡住整个画面
    const near: N = smoothstep(0.8, 3.4, length(positionView));
    mat.opacityNode = shape.mul(xf.z).mul(near).mul(fxDepthFade(0.7));

    this.object = new THREE.Sprite(mat);
    this.object.count = capacity;
    this.object.frustumCulled = false;
  }

  set(i: number, x: number, y: number, z: number, size: number, rotation: number, alpha: number, erode: number, r: number, g: number, b: number, seed: number): void {
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.xf[i * 4] = size;
    this.xf[i * 4 + 1] = rotation;
    this.xf[i * 4 + 2] = alpha;
    this.xf[i * 4 + 3] = erode;
    this.tint[i * 4] = r;
    this.tint[i * 4 + 1] = g;
    this.tint[i * 4 + 2] = b;
    this.tint[i * 4 + 3] = seed;
  }

  hide(i: number): void {
    this.xf[i * 4] = 0;
    this.xf[i * 4 + 2] = 0;
  }

  hideAll(): void {
    this.xf.fill(0);
  }

  commit(): void {
    for (const a of this.attrs) a.needsUpdate = true;
  }
}
