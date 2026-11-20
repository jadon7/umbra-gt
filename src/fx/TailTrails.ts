import * as THREE from 'three/webgpu';
import { abs, attribute, float, length, mix, positionView, smoothstep, uniform, vec3 } from 'three/tsl';
import { fxDepthFade } from '../core/fx.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 每条光带由多少节组成 */
const SEGMENTS = 30;
/** 车每走这么远记一个点（米） */
const SPACING = 0.45;
/** 最多同时拖多少条光带 */
const MAX_RIBBONS = 18;

/**
 * 一盏尾灯（或者尾灯上的一段）：它在车尾的位置和大小。
 * 坐标是整车坐标（x 左、y 上、z 前，车尾是负的 z）。
 */
export interface TailLamp {
  x: number;
  y: number;
  z: number;
  /** 宽、高（米）。很扁的灯（一条灯带）只拖一片横着的光；有高度的灯（竖条、圆环）再加一片竖着的，从哪个角度看都是一道光 */
  w: number;
  h: number;
  /** 亮度倍率，默认 1 */
  gain?: number;
  /** 圆环形的灯：拖出来的是一根空心的光管（两边亮、中间暗） */
  hollow?: boolean;
}

/** 历史上的一个位置：车在那里，以及当时车身朝左、朝上、朝前的方向 */
interface Frame {
  px: number;
  py: number;
  pz: number;
  lx: number;
  ly: number;
  lz: number;
  ux: number;
  uy: number;
  uz: number;
  fx: number;
  fy: number;
  fz: number;
}

interface Ribbon {
  lamp: TailLamp;
  /** true = 竖着的一片（宽度沿车身的"上"），false = 横着的一片（宽度沿车身的"左"） */
  vertical: boolean;
  half: number;
}

const _m = new THREE.Matrix4();

/**
 * 尾灯拖光：猛加速、开氮气时，尾灯在身后拖出长长的红光（长曝光照片里车灯拉出的光轨）。
 *
 * 拖出来的形状就是这台车尾灯的形状：贯穿式灯带拖出一整片薄薄的光幕，三联竖条拖出三道并排的光，
 * 圆环灯拖出空心的光管，立式尾灯拖出两道竖着的光刃。每盏灯记在 TailLamp 里，换车时换一套。
 *
 * 做法：记住车最近经过的三十个位置和当时的朝向，每盏灯沿着这串位置连成带子，越靠后越淡、越细。
 * 只往画面上加亮，画在特效叠加层里。
 */
export class TailTrails {
  readonly mesh: THREE.Mesh;
  /** 整体亮度 0–1 */
  readonly level = uniform(0);
  readonly color = uniform(new THREE.Color(1.0, 0.07, 0.05));

  private readonly frames: Frame[] = [];
  private ribbons: Ribbon[] = [];
  private readonly pos: Float32Array;
  /** 每个顶点：亮度倍率、是不是空心 */
  private readonly style: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly styleAttr: THREE.BufferAttribute;
  private readonly geometry: THREE.BufferGeometry;

  constructor() {
    const perRibbon = (SEGMENTS + 1) * 2;
    const verts = perRibbon * MAX_RIBBONS;
    this.pos = new Float32Array(verts * 3);
    this.style = new Float32Array(verts * 2);
    const along = new Float32Array(verts);
    const side = new Float32Array(verts);
    const index: number[] = [];
    for (let r = 0; r < MAX_RIBBONS; r++) {
      const base = r * perRibbon;
      for (let i = 0; i <= SEGMENTS; i++) {
        along[base + i * 2] = along[base + i * 2 + 1] = i / SEGMENTS;
        side[base + i * 2] = -1;
        side[base + i * 2 + 1] = 1;
        if (i < SEGMENTS) {
          const a = base + i * 2;
          index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.styleAttr = new THREE.BufferAttribute(this.style, 2);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aStyle', this.styleAttr);
    g.setIndex(index);
    g.setDrawRange(0, 0);
    this.geometry = g;

    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    m.fog = false;
    const t: N = attribute('aAlong', 'float');
    const s: N = abs(attribute('aSide', 'float') as N);
    const style: N = attribute('aStyle', 'vec2');
    // 横截面：实心的灯是中间一道很亮的细线、两边一片淡淡的红；
    // 圆环灯是空心的——两边各一道亮边、中间只有一点点
    const solidCore: N = smoothstep(0.22, 0.0, s);
    const solidBody: N = smoothstep(1.0, 0.25, s);
    const rim: N = smoothstep(0.42, 0.74, s).mul(smoothstep(1.0, 0.82, s));
    const core: N = mix(solidCore, rim.mul(0.55), style.y);
    const body: N = mix(solidBody, rim.add(0.12), style.y);
    const fade: N = float(1).sub(t).pow(1.6);
    m.colorNode = (this.color as N)
      .mul(body.mul(0.55).add(core.mul(2.2)))
      .add(vec3(1.0, 0.6, 0.45).mul(core).mul(0.8))
      .mul(fade)
      .mul(style.x)
      .mul(this.level)
      // 氮气把镜头甩到了车后十来米，光带的尾巴会从镜头底下穿过去：贴近镜头的一段淡掉，不然是糊在画面上的两大片红
      .mul(smoothstep(0.6, 2.6, length(positionView)))
      .mul(fxDepthFade(0.25));
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** 换一套尾灯（换车时调用）：每盏灯拖一道自己形状的光 */
  setLamps(lamps: TailLamp[]): void {
    this.ribbons = [];
    for (const lamp of lamps) {
      // 光带比灯本身宽一圈：中间是灯的亮芯，外面是晕开的光
      if (lamp.w >= 0.03) this.ribbons.push({ lamp, vertical: false, half: lamp.w * 0.5 + 0.035 });
      if (lamp.h >= 0.06) this.ribbons.push({ lamp, vertical: true, half: lamp.h * 0.5 + 0.035 });
    }
    this.ribbons.length = Math.min(this.ribbons.length, MAX_RIBBONS);
    const perRibbon = (SEGMENTS + 1) * 2;
    this.ribbons.forEach((r, k) => {
      for (let i = 0; i < perRibbon; i++) {
        const o = (k * perRibbon + i) * 2;
        this.style[o] = r.lamp.gain ?? 1;
        this.style[o + 1] = r.lamp.hollow ? 1 : 0;
      }
    });
    this.styleAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, this.ribbons.length * SEGMENTS * 6);
  }

  /**
   * @param root 整车的根节点（位置和朝向）
   * @param level 这一帧的亮度 0–1
   */
  update(root: THREE.Object3D, level: number): void {
    this.level.value = level;
    this.mesh.visible = level > 0.01 && this.ribbons.length > 0;
    const e = _m.copy(root.matrixWorld).elements;
    const now: Frame = { px: e[12], py: e[13], pz: e[14], lx: e[0], ly: e[1], lz: e[2], ux: e[4], uy: e[5], uz: e[6], fx: e[8], fy: e[9], fz: e[10] };
    const F = this.frames;
    // 最前面那个点始终跟着车；走够一段距离就在它后面记下一个新的点
    if (F.length === 0) {
      for (let i = 0; i <= SEGMENTS; i++) F.push({ ...now });
    } else {
      const second = F[1];
      if (Math.hypot(now.px - second.px, now.py - second.py, now.pz - second.pz) > SPACING) {
        F.pop();
        F.splice(1, 0, { ...F[0] });
      }
      Object.assign(F[0], now);
    }
    if (!this.mesh.visible) return;
    const perRibbon = (SEGMENTS + 1) * 2;
    const P = this.pos;
    this.ribbons.forEach((r, k) => {
      const { x, y, z } = r.lamp;
      for (let i = 0; i <= SEGMENTS; i++) {
        const f = F[i];
        const cx = f.px + f.lx * x + f.ux * y + f.fx * z;
        const cy = f.py + f.ly * x + f.uy * y + f.fy * z;
        const cz = f.pz + f.lz * x + f.uz * y + f.fz * z;
        // 越往后越窄
        const half = r.half * (1 - (i / SEGMENTS) * 0.55);
        const wx = (r.vertical ? f.ux : f.lx) * half;
        const wy = (r.vertical ? f.uy : f.ly) * half;
        const wz = (r.vertical ? f.uz : f.lz) * half;
        const o = (k * perRibbon + i * 2) * 3;
        P[o] = cx - wx;
        P[o + 1] = cy - wy;
        P[o + 2] = cz - wz;
        P[o + 3] = cx + wx;
        P[o + 4] = cy + wy;
        P[o + 5] = cz + wz;
      }
    });
    this.posAttr.needsUpdate = true;
  }

  /** 复位、瞬移之后：把光带收回到尾灯上，不要从旧位置拉一条长线过来 */
  clear(): void {
    this.frames.length = 0;
    this.level.value = 0;
    this.mesh.visible = false;
  }
}
