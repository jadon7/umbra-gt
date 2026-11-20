import * as THREE from 'three/webgpu';
import { abs, clamp, cross, dot, exp, float, length, materialColor, max, mix, normalize, normalWorld, positionWorld, pow, smoothstep, step, texture, uniform, vec2, vec3 } from 'three/tsl';
import { LAKESHORE, LAND } from './cityLayout.ts';
import { cityUniforms, RIVAL_SLOTS } from './materials.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 城市里的一盏灯（路灯、隧道灯、招牌、橱窗……） */
export interface CityLight {
  x: number;
  y: number;
  z: number;
  color: [number, number, number];
  /** 正下方地面的照度 */
  power: number;
  /** 水平方向能照多远（米） */
  radius: number;
  /** 0 = 不参与车身高光；1 = 路灯这类主要光源；2 = 招牌这类彩色点缀 */
  pool: 0 | 1 | 2;
  /** 灯正下方地面的高度（默认 0；桥面上的灯不是） */
  ground?: number;
}

/** 头顶有遮挡的矩形区域（下层街道、高架下面）：天光照不进来 */
export interface SkyCover {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 还能看到多少天空：0 全遮，1 不遮 */
  visibility: number;
}

/** 地面光照图覆盖的范围：整座城市加上半岛 */
const X0 = LAND.west - 20;
const Z0 = LAND.south - 14;
const SIZE = Math.max(LAKESHORE.cx + LAKESHORE.radius + 40 - X0, LAND.north + 14 - Z0);
const RES = 1024;

/**
 * 地面光照图：把全城几千盏灯在地面上的照度烤进一张俯视贴图里。
 * 路面、人行道、墙面、护栏在着色器里按世界坐标查这张图，就都被"照亮"了，
 * 不需要几千个实时光源。rgb = 灯光照度，a = 天空可见度。
 */
/** 光照图覆盖哪一块、地面有没有高低 */
export interface LightmapOptions {
  /** 覆盖范围的一个角和边长（米）。不写就是整座城市 */
  x0?: number;
  z0?: number;
  size?: number;
  /**
   * 地面的高度：一张俯视的贴图（红色通道 = 高度，米），范围和光照图一样。
   * 灯光照多高、头顶有没有遮挡，都是按「离地面多高」算的；城市是平的，不用给。
   */
  ground?: THREE.Texture;
  /**
   * 头顶有遮挡的地方（隧道里）灯是不是白天也亮着。
   * 城市里灯只在入夜后亮；山路的隧道里没有天光，灯得一直开着，不然白天里面是一片黑。
   */
  coveredLit?: boolean;
}

let flat: THREE.DataTexture | null = null;
/** 一张「地面到处都是 0」的高度贴图：平地的地图用它占位 */
export function flatGround(): THREE.DataTexture {
  if (!flat) {
    flat = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    flat.colorSpace = THREE.NoColorSpace;
    flat.needsUpdate = true;
  }
  return flat;
}

export class CityLightmap {
  readonly texture: THREE.DataTexture;
  private readonly data = new Uint16Array(RES * RES * 4);
  private readonly x0: number;
  private readonly z0: number;
  private readonly size: number;
  private readonly ground: THREE.Texture | null;
  private readonly coveredLit: boolean;
  /** 着色器里用的范围（和上面三个数一样；跟着别的光照图走的时候会变） */
  private readonly origin: N;
  private readonly extent: N;
  /** 这张图发出去的所有「查贴图」的节点：follow() 的时候把它们查的贴图换掉 */
  private readonly lightNodes: N[] = [];
  private readonly groundNodes: N[] = [];

  constructor(options: LightmapOptions = {}) {
    this.x0 = options.x0 ?? X0;
    this.z0 = options.z0 ?? Z0;
    this.size = options.size ?? SIZE;
    this.ground = options.ground ?? null;
    this.coveredLit = options.coveredLit ?? false;
    this.origin = uniform(new THREE.Vector2(this.x0, this.z0));
    this.extent = uniform(this.size);
    this.texture = new THREE.DataTexture(this.data, RES, RES, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;
  }

  bake(lights: CityLight[], covers: SkyCover[]): void {
    const acc = new Float32Array(RES * RES * 4);
    const texel = this.size / RES;
    const X0 = this.x0;
    const Z0 = this.z0;
    for (let i = 3; i < acc.length; i += 4) acc[i] = 1;

    for (const l of lights) {
      const cx = (l.x - X0) / texel;
      const cz = (l.z - Z0) / texel;
      const rad = l.radius / texel;
      const tx0 = Math.max(0, Math.floor(cx - rad));
      const tx1 = Math.min(RES - 1, Math.ceil(cx + rad));
      const tz0 = Math.max(0, Math.floor(cz - rad));
      const tz1 = Math.min(RES - 1, Math.ceil(cz + rad));
      const h = Math.max(0.5, l.y - (l.ground ?? 0));
      const h2 = h * h;
      const h3 = h2 * h;
      const r2Max = l.radius * l.radius;
      for (let tz = tz0; tz <= tz1; tz++) {
        const dz = (tz + 0.5 - cz) * texel;
        for (let tx = tx0; tx <= tx1; tx++) {
          const dx = (tx + 0.5 - cx) * texel;
          const r2 = dx * dx + dz * dz;
          if (r2 >= r2Max) continue;
          // 点光源照在水平面上：照度 ∝ 高度 / 距离³。归一化成正下方 = power
          const e = (l.power * h3) / Math.pow(r2 + h2, 1.5);
          const edge = 1 - r2 / r2Max;
          const w = e * edge * edge;
          const i = (tz * RES + tx) * 4;
          acc[i] += l.color[0] * w;
          acc[i + 1] += l.color[1] * w;
          acc[i + 2] += l.color[2] * w;
        }
      }
    }

    // 天空可见度：先按矩形填，再模糊一下，遮挡的边缘是渐变的
    const vis = new Float32Array(RES * RES).fill(1);
    for (const c of covers) {
      const tx0 = Math.max(0, Math.floor((c.x0 - X0) / texel));
      const tx1 = Math.min(RES - 1, Math.ceil((c.x1 - X0) / texel));
      const tz0 = Math.max(0, Math.floor((c.z0 - Z0) / texel));
      const tz1 = Math.min(RES - 1, Math.ceil((c.z1 - Z0) / texel));
      for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) vis[tz * RES + tx] = Math.min(vis[tz * RES + tx], c.visibility);
    }
    const tmp = new Float32Array(RES * RES);
    const K = 3;
    for (let z = 0; z < RES; z++) {
      for (let x = 0; x < RES; x++) {
        let s = 0;
        for (let k = -K; k <= K; k++) s += vis[z * RES + Math.min(RES - 1, Math.max(0, x + k))];
        tmp[z * RES + x] = s / (K * 2 + 1);
      }
    }
    for (let z = 0; z < RES; z++) {
      for (let x = 0; x < RES; x++) {
        let s = 0;
        for (let k = -K; k <= K; k++) s += tmp[Math.min(RES - 1, Math.max(0, z + k)) * RES + x];
        acc[(z * RES + x) * 4 + 3] = s / (K * 2 + 1);
      }
    }

    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < acc.length; i++) this.data[i] = toHalf(Math.min(acc[i], 60000));
    this.texture.needsUpdate = true;
  }

  /** 按世界坐标 (x, z) 查光照图：rgb = 灯光照度，a = 天空可见度 */
  sample(xz: N): N {
    const node: N = texture(this.texture, xz.sub(this.origin).div(this.extent));
    this.lightNodes.push(node);
    return node;
  }

  /** p 点离地面多高。平地的地图就是 p.y；有高低的地图查地面高度的贴图 */
  private above(p: N): N {
    if (!this.ground) return p.y;
    const node: N = texture(this.ground, vec2(p.x, p.z).sub(this.origin).div(this.extent));
    this.groundNodes.push(node);
    return p.y.sub(node.r);
  }

  /** 灯开到几成：入夜程度；头顶有遮挡的地方（隧道）白天也按全开算 */
  private lit(lm: N): N {
    if (!this.coveredLit) return cityUniforms.lights;
    return max(cityUniforms.lights, float(1).sub(smoothstep(0.1, 0.6, lm.a)));
  }

  /**
   * 改成照着另一张光照图来。
   * 车的特效（轮胎烟、水雾）的材质是进游戏时建一次的，它们查的是一张「替身」光照图；
   * 换地图的时候让替身跟着新地图的那一张走，烟和水雾就被新地图的灯照亮了。
   * 替身自己要带一张地面高度贴图（哪怕是 flatGround），否则山路的高低它查不到。
   */
  follow(other: CityLightmap | null): void {
    const src = other ?? this;
    for (const n of this.lightNodes) n.value = src.texture;
    for (const n of this.groundNodes) n.value = src.ground ?? flatGround();
    this.origin.value.set(src.x0, src.z0);
    this.extent.value = src.size;
  }

  /** 这个位置头顶有没有遮挡（下层街道、高架下面、隧道里）：1 = 淋不到雨 */
  cover(p: N): N {
    const a: N = this.sample(vec2(p.x, p.z)).a;
    return float(1).sub(smoothstep(0.5, 0.88, a)).mul(float(1).sub(step(6.3, this.above(p))));
  }

  /**
   * 车头大灯的光束在 p 点的强度（不含表面朝向）。
   * 一束横向宽、纵向薄的光。贴着地面的入射角极小，按物理算近处会过曝、远处全黑，
   * 所以光束形状和衰减都是按想要的样子写的：车前一两米起亮，十几米最亮，一直铺到七八十米外。
   * @param ground true = 照在地面和墙上（近处压暗）；false = 照亮空中的雨丝和水雾
   */
  private headBeam(p: N, ground: boolean): { beam: N; dir: N } {
    const toP: N = p.sub(cityUniforms.headPos);
    const dist: N = length(toP);
    const dir: N = toP.div(max(dist, 0.001));
    const fwd: N = dot(dir, cityUniforms.headDir);
    const right: N = normalize(cross(cityUniforms.headDir, vec3(0, 1, 0)));
    const inv: N = float(1).div(max(fwd, 0.001));
    const tanH: N = dot(dir, right).mul(inv);
    const tanV: N = dir.y.sub(cityUniforms.headDir.y).mul(inv);
    let shape: N = exp(tanH.mul(tanH).mul(-3.2)).mul(step(0.0, fwd));
    if (ground) shape = shape.mul(smoothstep(0.1, -0.01, tanV)).mul(smoothstep(-0.45, -0.07, tanV));
    else shape = shape.mul(smoothstep(0.2, 0.02, tanV)).mul(smoothstep(-0.5, -0.12, tanV)).mul(smoothstep(0.6, 3.0, dist));
    const reach: N = float(1).div(dist.div(26.0).pow(2.0).add(1.0));
    return { beam: vec3(0.84, 0.92, 1.0).mul(shape).mul(reach).mul(cityUniforms.headPower), dir };
  }

  /** 空中一点（雨丝、水雾）被城市灯光和车灯照到多亮 */
  airLight(p: N): N {
    const lm: N = this.sample(vec2(p.x, p.z));
    const height: N = exp(max(this.above(p).sub(1.5), 0).mul(-0.09));
    const lamps: N = lm.rgb.mul(height).mul(this.lit(lm)).mul(cityUniforms.lampGain);
    return lamps.add(this.headBeam(p, false).beam.mul(0.6));
  }

  /**
   * 着色器里的取样：返回这个表面收到的城市灯光（已含法线朝向和高度的衰减）和天空可见度。
   * @param cars 要不要算其他车（比赛里的对手）的车底阴影
   */
  nodes(cars = false): { light: N; sky: N } {
    const p: N = positionWorld;
    const n: N = normalWorld;
    const upness: N = clamp(n.y, 0, 1);
    const downness: N = clamp(n.y.negate(), 0, 1);
    // 竖直的面（墙、柱子、护栏）往外偏一点取样：取到的是它面前那块地上的光
    const side: N = float(1).sub(abs(n.y));
    const xz: N = vec2(p.x, p.z).add(vec2(n.x, n.z).mul(side).mul(1.6));
    const lm: N = this.sample(xz);
    const up: N = this.above(p);
    // 灯都在 6–9 米高，再往上的墙面基本照不到
    const height: N = exp(max(up.sub(2.5), 0).mul(mix(float(-0.22), float(-0.1), upness)));
    const facing: N = mix(float(0.42), float(1.0), upness).mul(float(1).sub(downness.mul(0.6)));
    const lamps: N = lm.rgb.mul(facing).mul(height).mul(this.lit(lm)).mul(cityUniforms.lampGain);

    const hb = this.headBeam(p, true);
    const toward: N = smoothstep(-0.08, 0.3, dot(n, hb.dir.negate()));
    const head: N = hb.beam.mul(toward);

    // 车底的软阴影和尾灯洒在车后地面上的红光：都按车的位置直接算在地面材质里
    // （做成半透明贴片的话会盖掉这块地面的反射和运动模糊信息）
    const rel: N = vec2(p.x, p.z).sub(vec2(cityUniforms.carPos.x, cityUniforms.carPos.z));
    const f: N = cityUniforms.carDir;
    const along: N = dot(rel, f);
    const across: N = dot(rel, vec2(f.y, f.x.negate()));
    const nearGround: N = smoothstep(1.2, 0.3, abs(p.y.sub(cityUniforms.carPos.y))).mul(upness);
    const q: N = vec2(abs(across).div(1.5), abs(along).div(2.95));
    const footprint: N = pow(pow(q.x, 4.0).add(pow(q.y, 4.0)), 0.25);
    const shade: N = float(1).sub(smoothstep(1.0, 0.35, footprint).mul(cityUniforms.carShadow).mul(nearGround));
    const tailAt: N = length(vec2(across.div(1.8), along.add(3.1).div(1.2)));
    const tail: N = vec3(1.0, 0.035, 0.02).mul(smoothstep(1.0, 0.0, tailAt).pow(2.0)).mul(cityUniforms.tailGlow).mul(nearGround);

    // 其他车（对手）：同样的车底阴影和尾灯光，形状算得粗一些。
    // 只有路面和人行道算这一段：每多一辆就多一份逐像素的开销，墙面上又用不着
    let shadeAll: N = shade;
    let glow: N = tail;
    for (let i = 0; cars && i < RIVAL_SLOTS; i++) {
      const rp: N = cityUniforms.rivalPos.element(i);
      const rd: N = cityUniforms.rivalDir.element(i);
      const r: N = vec2(p.x, p.z).sub(vec2(rp.x, rp.z));
      const al: N = dot(r, vec2(rd.x, rd.y));
      const ac: N = dot(r, vec2(rd.y, rd.x.negate()));
      const ng: N = smoothstep(1.2, 0.3, abs(p.y.sub(rp.y))).mul(upness);
      const fp: N = length(max(vec2(abs(ac).div(1.5), abs(al).div(2.95)).sub(0.45), 0.0)).div(0.55);
      shadeAll = shadeAll.mul(float(1).sub(smoothstep(1.0, 0.2, fp).mul(rp.w).mul(ng)));
      const ta: N = smoothstep(1.0, 0.0, length(vec2(ac.div(1.8), al.add(3.1).div(1.2))));
      glow = glow.add(vec3(1.0, 0.035, 0.02).mul(ta.mul(ta)).mul(rd.z).mul(ng));
    }

    const light: N = lamps.add(head).mul(shadeAll).add(glow);
    // 顶板和高架自己的上表面不算被遮挡
    const sky: N = mix(lm.a, float(1), step(6.3, up)).mul(shadeAll);
    return { light, sky };
  }

  /**
   * 让一个材质被城市灯光照亮：漫反射颜色 × 灯光照度，加到自发光里。
   * scale 用来单独压低某些材质（树冠被照得太亮会像塑料）；
   * cars = true 的材质（路面、人行道）还会算其他车的车底阴影
   */
  apply(m: THREE.MeshStandardNodeMaterial, scale = 1, cars = false): void {
    const { light, sky } = this.nodes(cars);
    const albedo: N = m.colorNode ?? materialColor;
    // 白色标线这类浅色表面在几盏灯叠加的地方会过曝，这里把亮部压一压
    const raw: N = albedo.rgb.mul(light).mul(scale);
    const add: N = raw.div(max(max(raw.r, raw.g), raw.b).mul(0.7).add(1.0));
    m.emissiveNode = m.emissiveNode ? (m.emissiveNode as N).add(add) : add;
    m.aoNode = sky;
  }
}

const _best: { d: number; l: CityLight | null }[] = [];

/**
 * 实时点光源池：只给车身用。
 * 从全城的灯里挑出离车最近的几盏，把真正的点光源挪过去，车开过时灯光的高光就会在车漆上流动。
 * 城市本身的材质不受这些点光源影响（它们查地面光照图），所以数量很少也够用。
 */
export class LightPool {
  readonly lights: THREE.PointLight[] = [];
  /** 整体强度，跟着入夜程度走 */
  strength = 0;

  constructor(
    private readonly sources: CityLight[],
    count: number,
    private readonly gain: number,
    private readonly maxRange: number,
    parent: THREE.Object3D,
  ) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, maxRange * 1.2, 2);
      l.castShadow = false;
      this.lights.push(l);
      parent.add(l);
    }
  }

  update(focus: THREE.Vector3): void {
    const n = this.lights.length;
    // 取最近的 n + 1 盏：第 n + 1 盏的距离就是这一帧的有效范围，
    // 范围边上的灯强度正好淡到 0，所以灯在池子里换进换出时不会跳变
    _best.length = 0;
    for (const s of this.sources) {
      const dx = s.x - focus.x;
      const dy = s.y - focus.y;
      const dz = s.z - focus.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (_best.length === n + 1 && d >= _best[n].d) continue;
      let k = _best.length;
      if (k < n + 1) _best.push({ d, l: s });
      else k = n;
      while (k > 0 && _best[k - 1].d > d) {
        if (k <= n) _best[k] = _best[k - 1];
        k--;
      }
      _best[k] = { d, l: s };
    }
    const range = _best.length > n ? Math.min(this.maxRange, Math.sqrt(_best[n].d)) : this.maxRange;
    for (let i = 0; i < n; i++) {
      const light = this.lights[i];
      const b = _best[i];
      if (!b || !b.l || this.strength <= 0.001) {
        light.intensity = 0;
        continue;
      }
      const d = Math.sqrt(b.d);
      const t = Math.min(1, Math.max(0, (d - range * 0.55) / (range * 0.45)));
      const fade = 1 - t * t * (3 - 2 * t);
      light.position.set(b.l.x, b.l.y, b.l.z);
      light.color.setRGB(b.l.color[0], b.l.color[1], b.l.color[2]);
      light.intensity = b.l.power * this.gain * this.strength * fade;
    }
  }
}
