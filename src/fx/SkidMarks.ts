import * as THREE from 'three/webgpu';
import { attribute, smoothstep, uniform, vec3 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const MAX = 1600;
const HALF_WIDTH = 0.115;
/** 最浓的胎痕有多不透明。太高会变成两条纯黑的带子，盖住路面的质感 */
const MAX_ALPHA = 0.55;

interface WheelLike {
  grounded: boolean;
  contact: { x: number; y: number; z: number };
  skid: number;
}

/**
 * 胎痕：轮胎打滑时在路面上留下的黑色橡胶印。
 * 四个轮子各拖一条带子，每隔一小段加一节；总共保留最近的 1600 节，再多就从最旧的开始覆盖。
 * 画在主场景里（贴着路面、被车挡住），不是特效叠加层。
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  /** 整体浓度。路面湿了以后胎痕会被冲淡 */
  readonly strength = uniform(1);

  private readonly pos = new Float32Array(MAX * 4 * 3);
  private readonly alpha = new Float32Array(MAX * 4);
  private readonly posAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private head = 0;
  private readonly last = [0, 1, 2, 3].map(() => ({ ok: false, x: 0, y: 0, z: 0, lx: 0, lz: 0, a: 0 }));

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    const normal = new Float32Array(MAX * 4 * 3);
    for (let i = 1; i < normal.length; i += 3) normal[i] = 1;
    const index = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('aAlpha', this.alphaAttr);
    // 每一节四个顶点分别在带子的左、右、右、左边缘：用来把两侧边缘淡出去
    const side = new Float32Array(MAX * 4);
    for (let i = 0; i < MAX; i++) side.set([1, -1, -1, 1], i * 4);
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.colorNode = vec3(0.02, 0.02, 0.022);
    const edge: N = smoothstep(1.0, 0.5, (attribute('aSide', 'float') as N).abs());
    mat.opacityNode = (attribute('aAlpha', 'float') as N).mul(this.strength).mul(edge);
    // 完全透明的地方直接不画：否则会把这块路面的反射信息也盖掉
    mat.alphaTest = 0.02;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -3;
    mat.polygonOffsetUnits = -3;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /**
   * @param wheels 四个车轮的物理状态
   * @param left 车身朝左的方向（世界坐标），胎痕的宽度沿着它
   * @param dryness 路面有多干 0–1：湿路面留不下胎痕
   */
  update(wheels: WheelLike[], left: THREE.Vector3, dryness: number): void {
    let dirty = false;
    for (let k = 0; k < 4 && k < wheels.length; k++) {
      const w = wheels[k];
      const last = this.last[k];
      const t = Math.min(1, Math.max(0, (w.skid - 0.3) / 0.45));
      const a = t * t * (3 - 2 * t) * dryness * MAX_ALPHA;
      if (!w.grounded || a < 0.04) {
        last.ok = false;
        continue;
      }
      const x = w.contact.x;
      const y = w.contact.y + 0.02;
      const z = w.contact.z;
      if (!last.ok) {
        Object.assign(last, { ok: true, x, y, z, lx: left.x, lz: left.z, a: 0 });
        continue;
      }
      const d = Math.hypot(x - last.x, z - last.z);
      if (d < 0.28) continue;
      // 一下子跳出去很远（复位、瞬移）就断开，不连成一条长线
      if (d < 6) {
        const o = this.head * 12;
        const p = this.pos;
        p[o] = last.x + last.lx * HALF_WIDTH;
        p[o + 1] = last.y;
        p[o + 2] = last.z + last.lz * HALF_WIDTH;
        p[o + 3] = last.x - last.lx * HALF_WIDTH;
        p[o + 4] = last.y;
        p[o + 5] = last.z - last.lz * HALF_WIDTH;
        p[o + 6] = x - left.x * HALF_WIDTH;
        p[o + 7] = y;
        p[o + 8] = z - left.z * HALF_WIDTH;
        p[o + 9] = x + left.x * HALF_WIDTH;
        p[o + 10] = y;
        p[o + 11] = z + left.z * HALF_WIDTH;
        const q = this.head * 4;
        this.alpha[q] = last.a;
        this.alpha[q + 1] = last.a;
        this.alpha[q + 2] = a;
        this.alpha[q + 3] = a;
        this.head = (this.head + 1) % MAX;
        dirty = true;
      }
      Object.assign(last, { x, y, z, lx: left.x, lz: left.z, a });
    }
    if (dirty) {
      this.posAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
    }
  }

  /** 断开四条带子（复位时用），已经留下的胎痕不动 */
  lift(): void {
    for (const l of this.last) l.ok = false;
  }

  /** 擦掉所有胎痕 */
  clear(): void {
    this.alpha.fill(0);
    this.alphaAttr.needsUpdate = true;
    this.lift();
  }
}
