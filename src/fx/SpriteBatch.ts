import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, length, uv } from 'three/tsl';
import { fxDepthFade } from '../core/fx.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 一批朝着镜头的发光面片（火花、回火的火团、氮气喷焰、碰撞的闪光），一次绘制画完。
 * 每个面片有自己的位置、宽高、旋转、亮度和颜色；拉长的面片看起来是一道细亮线，圆的是一团有亮心的光。
 * 粒子在 CPU 上算，每帧把结果写进来。只往画面上加亮、不遮挡，放在引擎的特效叠加层里。
 */
export class SpriteBatch {
  readonly object: THREE.Sprite;
  readonly capacity: number;

  private readonly pos: Float32Array;
  /** 宽、高、旋转（弧度）、亮度 */
  private readonly xf: Float32Array;
  private readonly tint: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];

  /** @param soft 贴近遮挡物多少米以内开始变淡 */
  constructor(capacity: number, soft = 0.15) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.xf = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 3);
    const posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
    const xfAttr = new THREE.InstancedBufferAttribute(this.xf, 4);
    const tintAttr = new THREE.InstancedBufferAttribute(this.tint, 3);
    this.attrs = [posAttr, xfAttr, tintAttr];
    for (const a of this.attrs) a.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
    const xf: N = instancedBufferAttribute(xfAttr);
    const tint: N = instancedBufferAttribute(tintAttr);
    mat.positionNode = instancedBufferAttribute(posAttr);
    mat.scaleNode = xf.xy;
    mat.rotationNode = xf.z;
    mat.fog = false;
    // 只加亮、不动透明度通道（特效层的透明度表示"遮住了多少底图"，光不遮东西）
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    const d: N = length(uv().sub(0.5)).mul(2.0);
    // 中心亮、往外很快暗下去
    const core: N = d.oneMinus().max(0.0);
    mat.colorNode = tint.mul(core.mul(core)).mul(xf.w).mul(fxDepthFade(soft));

    this.object = new THREE.Sprite(mat);
    this.object.count = capacity;
    this.object.frustumCulled = false;
  }

  /** 写入第 i 个面片 */
  set(i: number, x: number, y: number, z: number, w: number, h: number, rotation: number, alpha: number, r: number, g: number, b: number): void {
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.xf[i * 4] = w;
    this.xf[i * 4 + 1] = h;
    this.xf[i * 4 + 2] = rotation;
    this.xf[i * 4 + 3] = alpha;
    this.tint[i * 3] = r;
    this.tint[i * 3 + 1] = g;
    this.tint[i * 3 + 2] = b;
  }

  hide(i: number): void {
    this.xf[i * 4] = 0;
    this.xf[i * 4 + 1] = 0;
    this.xf[i * 4 + 3] = 0;
  }

  hideAll(): void {
    this.xf.fill(0);
  }

  /** 这一帧写完之后调用，把数据传给显卡 */
  commit(): void {
    for (const a of this.attrs) a.needsUpdate = true;
  }
}
