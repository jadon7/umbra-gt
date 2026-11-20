import * as THREE from 'three/webgpu';
import { attribute, float, fract, mix, sin, smoothstep, vec3 } from 'three/tsl';
import { cityUniforms, SNOW } from './materials.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 一共留多少节（每节三十来厘米）。满了从最旧的开始覆盖 */
const MAX = 9000;
const SPACING = 0.34;

interface WheelLike {
  grounded: boolean;
  contact: { x: number; y: number; z: number };
}

interface Last {
  ok: boolean;
  x: number;
  y: number;
  z: number;
  lx: number;
  lz: number;
  dist: number;
}

/**
 * 雪地上的车辙：车轮压过的地方，雪被压实、挤开，露出下面发暗的湿路面，两边各堆起一道雪棱。
 * 每个轮子身后拖一条带子（和胎痕一样的做法），玩家的车四个轮子都留，对手的车只留两条后轮的。
 * 用的是受光的材质，接进了城市的灯光：白天有阳光和影子，夜里被路灯照亮，和周围的雪是一体的。
 * 雪化了（换天气）车辙跟着淡掉。
 */
export class SnowTracks {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardNodeMaterial;

  private readonly pos = new Float32Array(MAX * 4 * 3);
  /** 每个顶点：沿着车辙走了多远（米）、有多深（0–1） */
  private readonly info = new Float32Array(MAX * 4 * 2);
  private readonly posAttr: THREE.BufferAttribute;
  private readonly infoAttr: THREE.BufferAttribute;
  private head = 0;
  /** 这一帧新写了几节（从哪一节开始） */
  private fresh = 0;
  private freshFrom = 0;
  /** 每辆车每个轮子上一次落点 */
  private readonly last = new Map<number, Last[]>();

  /** @param open 着色器节点：这个位置头顶是不是露天的（1 = 露天，会积雪；0 = 高架下面，没有雪也就没有车辙） */
  constructor(open: N) {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.infoAttr = new THREE.BufferAttribute(this.info, 2);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.infoAttr.setUsage(THREE.DynamicDrawUsage);
    const normal = new Float32Array(MAX * 4 * 3);
    for (let i = 1; i < normal.length; i += 3) normal[i] = 1;
    const side = new Float32Array(MAX * 4);
    const index = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      side.set([1, -1, -1, 1], i * 4);
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('aTrack', this.infoAttr);
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const across: N = (attribute('aSide', 'float') as N).abs();
    const track: N = attribute('aTrack', 'vec2');
    const along: N = track.x;
    const depth: N = track.y;
    // 边缘不是尺子画的：沿着车辙一路忽宽忽窄
    const wob: N = sin(along.mul(2.3)).mul(0.05).add(sin(along.mul(6.1).add(across.mul(2.0))).mul(0.035)).add(sin(along.mul(13.7)).mul(0.02));
    const edge: N = across.add(wob);
    // 胎纹：人字形的花纹块，压进雪里是一格格深浅相间的印子
    const cell: N = fract(along.mul(6.5).add(across.mul(1.6)));
    const tread: N = smoothstep(0.3, 0.5, cell).mul(smoothstep(1.0, 0.8, cell));
    // 有的地方压得实、露出湿路面，有的地方还剩一层脏雪
    const patchy: N = sin(along.mul(0.9)).mul(0.5).add(0.5).mul(sin(along.mul(3.7).add(1.3)).mul(0.5).add(0.5));
    // 中间是压实的车辙：发暗的湿雪，花纹块压得深的地方露出路面
    const packed: N = mix(vec3(0.04, 0.043, 0.05), (SNOW as N).mul(0.46), tread.mul(0.42).add(patchy.mul(0.26)).add(0.06));
    // 两边被挤出来的雪棱：比周围的雪亮一点点
    const ridge: N = smoothstep(0.7, 0.86, edge);
    m.colorNode = mix(packed, (SNOW as N).mul(1.05), ridge);
    m.roughnessNode = mix(float(0.42), float(0.9), ridge);
    m.metalnessNode = float(0);
    // 中间实、雪棱半透、最外沿淡出；雪越薄车辙越浅
    const body: N = mix(float(0.84), float(0.4), ridge).mul(smoothstep(1.02, 0.86, edge));
    m.opacityNode = body.mul(depth).mul(smoothstep(0.22, 0.6, cityUniforms.snow.mul(open)));
    m.alphaTest = 0.02;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -4;
    m.polygonOffsetUnits = -4;
    this.material = m;
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  /**
   * 记下一辆车这一帧的车轮落点。
   * @param slot 哪辆车（0 = 玩家，对手从 1 起）
   * @param wheels 车轮的物理状态；from 之前的轮子不留痕（对手只留后轮：传 2）
   * @param lx,lz 车身朝左的方向（世界坐标，水平）
   * @param half 车辙半宽（米）
   * @param cover 这里的积雪有多厚 0–1
   */
  mark(slot: number, wheels: WheelLike[], from: number, lx: number, lz: number, half: number, cover: number): void {
    let lasts = this.last.get(slot);
    if (!lasts) {
      lasts = [0, 1, 2, 3].map(() => ({ ok: false, x: 0, y: 0, z: 0, lx: 0, lz: 0, dist: 0 }));
      this.last.set(slot, lasts);
    }
    const deep = Math.min(1, Math.max(0, (cover - 0.2) / 0.5));
    for (let k = from; k < 4 && k < wheels.length; k++) {
      const w = wheels[k];
      const last = lasts[k];
      if (!w.grounded || deep < 0.05) {
        last.ok = false;
        continue;
      }
      const x = w.contact.x;
      const y = w.contact.y + 0.025;
      const z = w.contact.z;
      if (!last.ok) {
        Object.assign(last, { ok: true, x, y, z, lx, lz });
        continue;
      }
      const d = Math.hypot(x - last.x, z - last.z);
      if (d < SPACING) continue;
      // 一下子跳出去很远（复位、放回赛道）就断开，不连成一条长线
      if (d < 5) {
        const o = this.head * 12;
        const p = this.pos;
        p[o] = last.x + last.lx * half;
        p[o + 1] = last.y;
        p[o + 2] = last.z + last.lz * half;
        p[o + 3] = last.x - last.lx * half;
        p[o + 4] = last.y;
        p[o + 5] = last.z - last.lz * half;
        p[o + 6] = x - lx * half;
        p[o + 7] = y;
        p[o + 8] = z - lz * half;
        p[o + 9] = x + lx * half;
        p[o + 10] = y;
        p[o + 11] = z + lz * half;
        const q = this.head * 8;
        const t = this.info;
        t[q] = t[q + 2] = last.dist;
        t[q + 4] = t[q + 6] = last.dist + d;
        t[q + 1] = t[q + 3] = t[q + 5] = t[q + 7] = deep;
        if (this.fresh === 0) this.freshFrom = this.head;
        this.fresh++;
        this.head = (this.head + 1) % MAX;
      }
      // 沿车辙的里程只用来排胎纹，绕回去免得数字越来越大、精度变差
      Object.assign(last, { x, y, z, lx, lz, dist: (last.dist + d) % 64 });
    }
  }

  /** 这一帧所有车都记完之后调用：有新的车辙就传给显卡 */
  commit(): void {
    if (this.fresh === 0) return;
    // 只把新写的那几节传给显卡（整块有几百 KB，不值得每帧全传）；正好绕回开头的那一帧全传一次
    if (this.freshFrom + this.fresh <= MAX) {
      this.posAttr.addUpdateRange(this.freshFrom * 12, this.fresh * 12);
      this.infoAttr.addUpdateRange(this.freshFrom * 8, this.fresh * 8);
    }
    this.fresh = 0;
    this.posAttr.needsUpdate = true;
    this.infoAttr.needsUpdate = true;
    this.mesh.visible = true;
  }

  /** 断开所有车的车辙（复位、重新发车时用），已经留下的不动 */
  lift(): void {
    for (const lasts of this.last.values()) for (const l of lasts) l.ok = false;
  }

  /** 擦掉所有车辙 */
  clear(): void {
    this.info.fill(0);
    this.infoAttr.needsUpdate = true;
    this.lift();
    this.mesh.visible = false;
  }
}
