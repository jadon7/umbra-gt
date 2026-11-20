import * as THREE from 'three/webgpu';
import { float, lights, positionWorld } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { QUALITY } from '../core/quality.ts';
import type { CarLighting } from '../drive/CarLights.ts';
import type { DriveWorld, RivalLighting, WorldLook } from '../drive/DriveWorld.ts';
import type { PhysicsWorld } from '../drive/PhysicsWorld.ts';
import { applySky, blendTime, skyColorNode, TIME_ORDER, TIMES, type TimeId, type TimePreset } from '../city/atmosphere.ts';
import { CityLightmap, LightPool, type CityLight, type SkyCover } from '../city/cityLights.ts';
import { createLampGlow, haze01, type GlowSpot } from '../city/LampGlow.ts';
import { addSnow, cityUniforms, createWaterMaterial, RIVAL_SLOTS } from '../city/materials.ts';
import { MeshBuilder, type V3 } from '../city/MeshBuilder.ts';
import { Precipitation } from '../city/Precipitation.ts';
import { SnowTracks } from '../city/SnowTracks.ts';
import { applyWeather, stepWeather, WEATHER_ORDER, WEATHERS, type WeatherId, type WeatherPreset, type WeatherState } from '../city/weather.ts';
import { DETAIL_LAYER, groupByCell, splitGeometry } from '../city/chunks.ts';
import { baseHeight, buildMountainTrack, fbm, MOUNTAIN, nearestRoad, roadHeightAt, spanAt, surfaceHeight, terrainHeight, terrainNormal, type MountainTrack, type Span } from './mountainLayout.ts';
import { addMountainColliders, ringOffset, VERGE_RINGS } from './mountainPhysics.ts';
import { BILLBOARDS, createMountainMaterials, PAVED, type MountainMaterials } from './mountainMaterials.ts';
import { BROADLEAF_FILL, COVER, COVER_TILES, FoliageBatch, TREE, TREE_TILES } from './flora.ts';
import { buildScenery, CASCADE, GALLERY, POLE_OFFSET, POWER_LINES, type SceneryAnim } from './scenery.ts';
import { createSceneryMaterials, type SceneryMaterials } from './sceneryMaterials.ts';
import { Leaves } from './Leaves.ts';

/** 时段切换的过渡时间（秒） */
const TIME_FADE = 2.6;
const LAMP_WARM: [number, number, number] = [1.0, 0.66, 0.32];
const LAMP_SODIUM: [number, number, number] = [1.0, 0.6, 0.24];
const UP = new THREE.Vector3(0, 1, 0);
/** 地形网格的格子边长（米） */
const GRID = 10;
/** 隧道的断面：墙离中心线多远、直墙多高、拱再往上多高 */
const TUNNEL = { half: 10.4, wall: 3.6, rise: 4.2 };

/**
 * 山里的光：时段还是白天、黄昏、夜晚三个，方向和空气按这座山重新定。
 *  - 白天：太阳在东南，照着朝南的山坡，树影斜着落在路上；空气通透，看得见远处的雪山
 *  - 黄昏：太阳压在湖的西南角，下山那几段正对着落日
 *  - 夜晚：没有城市的灯，天是深蓝的，星星多；月亮比城里亮一些，不然山的轮廓看不出来
 */
const MOUNTAIN_TIMES: Record<TimeId, TimePreset> = {
  day: { ...TIMES.day, keyDir: [0.42, 0.66, -0.62], fogColor: [0.6, 0.69, 0.8], fogDensity: 0.00042, hemiIntensity: 1.15 },
  dusk: { ...TIMES.dusk, keyDir: [-0.78, 0.16, -0.6], fogColor: [0.46, 0.34, 0.4], fogDensity: 0.00056 },
  night: {
    ...TIMES.night,
    keyDir: [0.34, 0.62, -0.5],
    keyIntensity: 0.6,
    hemiSky: [0.2, 0.28, 0.5],
    hemiGround: [0.07, 0.08, 0.1],
    hemiIntensity: 1.0,
    zenith: [0.006, 0.011, 0.03],
    horizon: [0.03, 0.042, 0.07],
    below: [0.012, 0.014, 0.02],
    haze: [0.01, 0.014, 0.024],
    stars: 0.85,
    cloudLit: [0.05, 0.06, 0.085],
    cloudDark: [0.012, 0.016, 0.028],
    cloudAmount: 0.55,
    fogColor: [0.016, 0.022, 0.036],
    fogDensity: 0.00105,
    exposure: 1.4,
  },
};

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number) => {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k * k * (3 - 2 * k);
};

const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** 一段连续的弯（按采样点下标） */
interface Bend {
  i0: number;
  i1: number;
  /** 1 = 左弯，-1 = 右弯 */
  side: number;
  /** 最急处的半径 */
  radius: number;
}

/**
 * 山路赛道「云岭」的画面。
 * 山体、路面、护栏、隧道、桥、树全部由 mountainLayout 里的数据程序化生成，和物理碰撞体共用同一份数据。
 * 昼夜、天气、灯光、雨雪用的是城市那一套（atmosphere / weather / cityLights / Precipitation），只是参数按山里的样子另定。
 */
export class MountainWorld implements DriveWorld {
  readonly group = new THREE.Group();
  readonly label = '云岭山道';
  readonly dynamicReflections = true;
  /** 护栏外面是山坡和草地，不是楼：电影镜头的机位可以立到路外面去 */
  readonly openVerge = true;
  readonly start: { x: number; y: number; z: number; yaw: number };
  readonly track: MountainTrack;
  readonly look: WorldLook = {
    fogColor: new THREE.Color(),
    fogDensity: 0.001,
    exposure: 1,
    environment: null,
    environmentIntensity: 1,
    night: 0,
    bloomStrength: 0.24,
    bloomThreshold: 2.2,
    bloomRadius: 0.5,
    contrast: 1,
    saturation: 1,
    shadowTint: new THREE.Color(1, 1, 1),
    highlightTint: new THREE.Color(1, 1, 1),
    wetness: 0,
    rain: 0,
    snow: 0,
  };
  readonly fxGroup = new THREE.Group();
  onLightning: (() => void) | null = null;
  readonly snowTracks: SnowTracks;
  readonly keyLight = { dir: new THREE.Vector3(0, 1, 0), color: new THREE.Color(0, 0, 0) };

  private readonly mats: MountainMaterials;
  private readonly looks: SceneryMaterials;
  private scenery!: SceneryAnim;
  private readonly leaves = new Leaves();
  private readonly leafLight = new THREE.Color();
  readonly lightmap: CityLightmap;
  private readonly lamps: CityLight[] = [];
  private readonly covers: SkyCover[] = [];
  private readonly glowSpots: GlowSpot[] = [];
  private lampPool!: LightPool;
  private readonly litMaterials = new Set<THREE.Material>();
  private readonly water: THREE.MeshStandardNodeMaterial;
  private readonly precip: Precipitation;
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private csm: CSMShadowNode | null = null;
  private sky!: THREE.Mesh;
  // 不指定的话是黄昏、晴天：这条路最好看的时候（城市默认是雨夜，那是霓虹最好看的时候）
  private timeFrom: TimePreset = MOUNTAIN_TIMES.dusk;
  private timeTo: TimePreset = MOUNTAIN_TIMES.dusk;
  private timeT = 1;
  private current: TimePreset = MOUNTAIN_TIMES.dusk;
  private readonly envs = new Map<string, { car: THREE.Texture; sky: THREE.Texture }>();
  private envKey: string | null = null;
  private weatherTo: WeatherPreset = WEATHERS.clear;
  private readonly weather: WeatherState = { rain: 0, wetness: 0, fog: 1, overcast: 0, flash: 0, snow: 0, snowCover: 0 };
  private lastFov = 0;
  private lastAspect = 0;
  private lastNear = 0;
  private readonly bends: Bend[] = [];
  /** 一共种了多少棵树（调试用） */
  treeCount = 0;
  /** 地面上一共撒了多少丛草木（调试用） */
  coverCount = 0;

  constructor(physics: PhysicsWorld) {
    this.track = buildMountainTrack();
    this.start = this.track.start;
    addMountainColliders(physics);
    this.lightmap = new CityLightmap({ x0: -MOUNTAIN.extent, z0: -MOUNTAIN.extent, size: MOUNTAIN.extent * 2, ground: this.groundTexture(), coveredLit: true });
    this.mats = createMountainMaterials(this.lightmap);
    this.looks = createSceneryMaterials();
    this.water = createWaterMaterial();
    this.findBends();

    this.buildTerrain();
    this.buildFar();
    this.buildRoad();
    this.buildRails();
    for (const sp of this.track.spans) {
      if (sp.kind === 'tunnel') this.buildTunnel(sp);
      else this.buildBridge(sp);
    }
    this.buildLamps();
    this.buildSigns();
    this.buildGantry();
    this.scenery = buildScenery({
      track: this.track,
      group: this.group,
      lamps: this.lamps,
      glowSpots: this.glowSpots,
      covers: this.covers,
      bends: this.bends,
      mats: this.mats,
      looks: this.looks,
      water: this.water,
      add: (b, material, cast, receive, detail) => this.add(b, material, cast, receive, detail),
    });
    this.buildFlora();
    this.buildRocks();
    this.buildWater();
    this.buildSky();
    this.group.add(this.leaves.mesh);
    this.precip = new Precipitation(this.lightmap);
    this.fxGroup.add(this.precip.group);
    this.fxGroup.add(createLampGlow(this.glowSpots));
    this.finishLighting();
    // 雪地上的车辙：隧道里没有雪，也就不显示
    this.snowTracks = new SnowTracks(float(1).sub(this.lightmap.cover(positionWorld)));
    this.adopt(this.snowTracks.material);
    this.group.add(this.snowTracks.mesh);
    this.present();
  }

  /** 车能落脚的高度（路上是路面，路外是地面）：把车放到某个位置时用 */
  groundAt(x: number, z: number): number {
    return surfaceHeight(x, z);
  }

  /* ------------------------------ 小工具 ------------------------------ */

  /** 把攒好的三角形做成网格放进场景；面数多的按格子切块，镜头外的整块跳过 */
  private add(b: MeshBuilder, material: THREE.Material, cast = true, receive = true, detail = false): void {
    if (b.triangleCount === 0) return;
    this.addGeometry(b.build(), material, cast, receive, detail);
  }

  private addGeometry(whole: THREE.BufferGeometry, material: THREE.Material, cast = true, receive = true, detail = false): void {
    const parts = (whole.index?.count ?? 0) > 8000 * 3 ? splitGeometry(whole) : [whole];
    for (const g of parts) {
      const m = new THREE.Mesh(g, material);
      m.castShadow = cast;
      m.receiveShadow = receive;
      m.frustumCulled = parts.length > 1;
      if (detail) m.layers.set(DETAIL_LAYER);
      this.group.add(m);
    }
  }

  /** 路上第 i 个采样点、离中心线 lateral 米（左为正）、离路面 up 米高的那一点 */
  private at(i: number, lateral: number, up = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const n = this.track.samples.length;
    const k = ((i % n) + n) % n;
    const p = this.track.samples[k];
    return out.set(p.pos.x + p.left.x * lateral, roadHeightAt(k, lateral) + up, p.pos.z + p.left.z * lateral);
  }

  /** 一个顺着路摆的长方体：中心 c，宽 w（横着路）、高 h、长 d（顺着路） */
  private block(b: MeshBuilder, c: THREE.Vector3, dir: THREE.Vector3, left: THREE.Vector3, w: number, h: number, d: number): void {
    const corner = (sl: number, su: number, sd: number): V3 => [
      c.x + left.x * w * 0.5 * sl + dir.x * d * 0.5 * sd,
      c.y + h * 0.5 * su,
      c.z + left.z * w * 0.5 * sl + dir.z * d * 0.5 * sd,
    ];
    const L: V3 = [left.x, 0, left.z];
    const D: V3 = [dir.x, 0, dir.z];
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
    b.quad(corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1), L);
    b.quad(corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1), neg(L));
    b.quad(corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1), D);
    b.quad(corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1), neg(D));
    b.quad(corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1), [0, 1, 0]);
    b.quad(corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1), [0, -1, 0]);
  }

  /**
   * 隧道的洞门立在哪两个采样点上。地形是每隔一个采样点取一排的，洞门要正好立在其中一排上：
   * 洞门外面那一排是路基，里面那一排已经是山，中间那一截陡坡正好藏在洞门的墙后面
   */
  private portals(sp: Span): [number, number] {
    return [Math.floor((sp.i0 - 1) / 2) * 2, Math.ceil((sp.i1 + 1) / 2) * 2];
  }

  /** 找出路上的弯（导向牌、路灯按它摆） */
  private findBends(): void {
    const S = this.track.samples;
    const n = S.length;
    const bent = (i: number) => Math.abs(S[(i + n) % n].curvature) > 1 / 130;
    let first = 0;
    while (first < n && bent(first)) first++;
    let i = 0;
    while (i < n) {
      if (!bent(first + i)) {
        i++;
        continue;
      }
      const from = i;
      let peak = 0;
      let sum = 0;
      while (i < n && bent(first + i)) {
        const c = S[(first + i) % n].curvature;
        peak = Math.max(peak, Math.abs(c));
        sum += c;
        i++;
      }
      if (i - from > 10) this.bends.push({ i0: (first + from) % n, i1: (first + i - 1) % n, side: Math.sign(sum), radius: 1 / peak });
    }
  }

  /** 地面的高度贴图（给地面光照图用：灯照多高、隧道里淋不淋得到雨，都按离地面多高算）。只算路附近的 */
  private groundTexture(): THREE.DataTexture {
    const R = 512;
    const data = new Uint16Array(R * R * 4);
    const texel = (MOUNTAIN.extent * 2) / R;
    const half = THREE.DataUtils.toHalfFloat;
    for (let tz = 0; tz < R; tz++) {
      for (let tx = 0; tx < R; tx++) {
        const x = -MOUNTAIN.extent + (tx + 0.5) * texel;
        const z = -MOUNTAIN.extent + (tz + 0.5) * texel;
        const q = nearestRoad(x, z, 64);
        let h = 0;
        // 路基范围内取路面的高度（隧道里、桥上也是）；再往外取地面
        if (q) h = q.dist < MOUNTAIN.bench + 4 ? q.y : terrainHeight(x, z);
        data[(tz * R + tx) * 4] = half(h);
      }
    }
    const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /* ------------------------------ 山体 ------------------------------ */

  /**
   * 山体的网格分两部分，都落在同一个高度函数（terrainHeight）上：
   *  - 贴着路的几圈：跟着路走，护栏外面到三十几米，够细，路堑和路堤的形状靠它；
   *  - 铺满全图的大格子：十米一格。路附近的格点往下压了几米，藏在前面那几圈下面，免得两层打架。
   */
  private buildTerrain(): void {
    const S = this.track.samples;
    const n = S.length;
    const pos: number[] = [];
    const nor: number[] = [];
    const edge: number[] = [];
    const idx: number[] = [];
    const vert = (x: number, y: number, z: number, e: number, normal?: THREE.Vector3): number => {
      const nn = normal ?? terrainNormal(x, z, _n);
      pos.push(x, y, z);
      nor.push(nn.x, nn.y, nn.z);
      edge.push(e);
      return pos.length / 3 - 1;
    };

    /* 贴着路的几圈 */
    const rings = VERGE_RINGS.length;
    for (const side of [1, -1]) {
      let prev = -1;
      for (let i = 0; i <= n; i += 2) {
        const k = i % n;
        const p = S[k];
        const base = pos.length / 3;
        let lx = 0;
        let ly = 0;
        let lz = 0;
        for (let r = 0; r < rings; r++) {
          const off = ringOffset(VERGE_RINGS[r], p.curvature, side) * side;
          lx = p.pos.x + p.left.x * off;
          lz = p.pos.z + p.left.z * off;
          ly = r === 0 && !spanAt(k) ? roadHeightAt(k, off) - 0.06 : terrainHeight(lx, lz);
          vert(lx, ly, lz, Math.abs(off) - PAVED);
        }
        // 裙边：最外一圈正下方再接一截，和大格子之间不会露缝
        vert(lx, ly - 3.5, lz, 30);
        if (prev >= 0) {
          for (let r = 0; r < rings; r++) {
            const a = prev + r;
            const b = base + r;
            if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
            else idx.push(a, a + 1, b, a + 1, b + 1, b);
          }
        }
        prev = base;
      }
    }

    /* 隧道顶上、桥底下：路正上（下）方那一条 */
    const across = [-MOUNTAIN.bench, -5.4, 0, 5.4, MOUNTAIN.bench];
    for (const sp of this.track.spans) {
      let prev = -1;
      // 隧道：只铺洞门以内的（洞门外面是路）；桥：两头多铺一点，接上桥台
      const [from, to] = sp.kind === 'tunnel' ? [this.portals(sp)[0] + 2, this.portals(sp)[1] - 2] : [Math.floor(sp.i0 / 2) * 2 - 2, Math.ceil(sp.i1 / 2) * 2 + 2];
      for (let i = from; i <= to; i += 2) {
        const p = S[((i % n) + n) % n];
        const base = pos.length / 3;
        for (const l of across) {
          const x = p.pos.x + p.left.x * l;
          const z = p.pos.z + p.left.z * l;
          vert(x, baseHeight(x, z), z, 30);
        }
        if (prev >= 0) {
          for (let r = 0; r < across.length - 1; r++) {
            const a = prev + r;
            const b = base + r;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
        prev = base;
      }
    }

    /* 大格子 */
    const E = MOUNTAIN.extent;
    const cells = (E * 2) / GRID;
    const row = cells + 1;
    const h = new Float32Array(row * row);
    const sink = new Float32Array(row * row);
    // 隧道正上方和洞口附近的格点：这些格子不画（那里由贴着路的几圈和隧道顶上那一条盖着）。
    // 十米一格太粗，洞口内外高度差十几米，画出来会有一个斜面插进隧道里
    const overTunnel = new Uint8Array(row * row);
    const nearPortal = (i: number): boolean => {
      for (const sp of this.track.spans) {
        if (sp.kind !== 'tunnel') continue;
        const [a, b] = this.portals(sp);
        if (i >= a - 7 && i <= b + 7) return true;
      }
      return false;
    };
    for (let iz = 0; iz < row; iz++) {
      for (let ix = 0; ix < row; ix++) {
        const x = -E + ix * GRID;
        const z = -E + iz * GRID;
        h[iz * row + ix] = terrainHeight(x, z);
        const q = nearestRoad(x, z, 36);
        // 隧道顶上少压一点：压多了格点会掉进隧道里
        sink[iz * row + ix] = q ? (q.span === 'tunnel' ? 1.4 : 4.2) * (1 - smooth((q.dist - 22) / 10)) : 0;
        if (q && q.dist < 27 && nearPortal(q.index)) overTunnel[iz * row + ix] = 1;
      }
    }
    const gbase = pos.length / 3;
    for (let iz = 0; iz < row; iz++) {
      for (let ix = 0; ix < row; ix++) {
        const k = iz * row + ix;
        const hx = h[iz * row + Math.min(row - 1, ix + 1)] - h[iz * row + Math.max(0, ix - 1)];
        const hz = h[Math.min(row - 1, iz + 1) * row + ix] - h[Math.max(0, iz - 1) * row + ix];
        _n.set(-hx, (ix > 0 && ix < row - 1 ? 2 : 1) * GRID, -hz * (ix > 0 && ix < row - 1 && (iz === 0 || iz === row - 1) ? 2 : 1)).normalize();
        vert(-E + ix * GRID, h[k] - sink[k], -E + iz * GRID, 30, _n);
      }
    }
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const k = iz * row + ix;
        if (overTunnel[k] || overTunnel[k + 1] || overTunnel[k + row] || overTunnel[k + row + 1]) continue;
        const a = gbase + k;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.addGeometry(g, this.mats.terrain, true, true);
  }

  /** 地图外面一圈远山：格子很粗，越往外越高，最远处是带雪顶的山。湖的南岸隔着水也有 */
  private buildFar(): void {
    const E = MOUNTAIN.extent;
    const R = 3000;
    const cell = 75;
    const cells = (R * 2) / cell;
    const row = cells + 1;
    const far = (x: number, z: number): number => {
      const out = Math.max(Math.abs(x), Math.abs(z)) - E;
      const t = smooth(out / 950);
      // 一道道山脊：把噪声折一下，谷是圆的、脊是尖的
      const r1 = 1 - Math.abs(fbm(x / 1000 + 7.3, z / 1000 - 2.1, 4, 101));
      const r2 = 1 - Math.abs(fbm(x / 420 - 1.2, z / 420 + 5.5, 3, 131));
      const r3 = 1 - Math.abs(fbm(x / 190 + 4.4, z / 190 - 7.1, 2, 151));
      let peak = 170 + 460 * Math.pow(r1, 2.6) + 130 * r2 * r2 + 46 * (r3 - 0.5);
      // 湖的那一侧：水面要一直铺到一千多米外，山在对岸
      // 近岸的山往南慢慢矮下去（不是到湖边齐刷刷地断掉）；对岸的山在一千多米外重新起来
      peak *= Math.max(smooth((z + 900) / 620), smooth((-z - 1350) / 700));
      const base = baseHeight(x, z);
      // 最外一圈压到地平线以下（藏在雾里），不然远山的边是齐刷刷的一条线
      const rim = smooth((Math.max(Math.abs(x), Math.abs(z)) - (R - 500)) / 500);
      return (base + (peak - Math.min(base, peak) * 0.4) * t) * (1 - rim) - 30 * rim;
    };
    const pos: number[] = [];
    const idx: number[] = [];
    const hs = new Float32Array(row * row);
    for (let iz = 0; iz < row; iz++) {
      for (let ix = 0; ix < row; ix++) {
        const x = -R + ix * cell;
        const z = -R + iz * cell;
        const inside = Math.max(Math.abs(x), Math.abs(z)) < E - 5;
        // 压在主地形下面的那几排往下沉，免得从缝里冒出来
        hs[iz * row + ix] = far(x, z) - (inside ? 12 : 0);
        pos.push(x, hs[iz * row + ix], z);
      }
    }
    const nor: number[] = [];
    for (let iz = 0; iz < row; iz++) {
      for (let ix = 0; ix < row; ix++) {
        const hx = hs[iz * row + Math.min(row - 1, ix + 1)] - hs[iz * row + Math.max(0, ix - 1)];
        const hz = hs[Math.min(row - 1, iz + 1) * row + ix] - hs[Math.max(0, iz - 1) * row + ix];
        _n.set(-hx, 2 * cell, -hz).normalize();
        nor.push(_n.x, _n.y, _n.z);
      }
    }
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const x = -R + (ix + 0.5) * cell;
        const z = -R + (iz + 0.5) * cell;
        // 完全压在主地形下面的格子不画
        if (Math.max(Math.abs(x), Math.abs(z)) < E - cell) continue;
        const a = iz * row + ix;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(new Float32Array(row * row).fill(30), 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.mats.terrain);
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.layers.set(DETAIL_LAYER);
    this.group.add(mesh);
  }

  /* ------------------------------ 路面 ------------------------------ */

  /** 路面是一条带子：横着九个点（两侧碎石路肩、沥青的边、中间），贴图坐标里记着离中心线多远、沿路走了多远 */
  private buildRoad(): void {
    const S = this.track.samples;
    const n = S.length;
    const lat = [-MOUNTAIN.bench, -PAVED, -8, -4, 0, 4, 8, PAVED, MOUNTAIN.bench];
    const m = lat.length;
    const pos = new Float32Array((n + 1) * m * 3);
    const nor = new Float32Array((n + 1) * m * 3);
    const uvs = new Float32Array((n + 1) * m * 2);
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const p = S[k];
      const dist = i === n ? this.track.length : p.s;
      // 路面的法线：往上，再按坡度和横坡歪一点
      _n.set(0, 1, 0)
        .addScaledVector(p.dir, -this.track.grade[k])
        .addScaledVector(p.left, this.track.bank[k])
        .normalize();
      for (let j = 0; j < m; j++) {
        const l = lat[j];
        const o = (i * m + j) * 3;
        const verge = Math.max(0, Math.abs(l) - PAVED) / (MOUNTAIN.bench - PAVED);
        pos[o] = p.pos.x + p.left.x * l;
        pos[o + 1] = roadHeightAt(k, l) - 0.06 * verge;
        pos[o + 2] = p.pos.z + p.left.z * l;
        nor[o] = _n.x;
        nor[o + 1] = _n.y;
        nor[o + 2] = _n.z;
        uvs[(i * m + j) * 2] = l;
        uvs[(i * m + j) * 2 + 1] = dist;
      }
      if (i < n) {
        for (let j = 0; j < m - 1; j++) {
          const a = i * m + j;
          const b = a + 1;
          const c = a + m;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.addGeometry(g, this.mats.road, false, true);
  }

  /* ------------------------------ 护栏 ------------------------------ */

  /**
   * 两侧的波形护栏：四米一根立柱，上面一道横着的钢板。桥上换成混凝土防撞墙，隧道里没有（两边就是墙）。
   * 每隔十几米一个橙色的反光柱头，夜里是路两边一串小亮点。
   */
  private buildRails(): void {
    const S = this.track.samples;
    const n = S.length;
    const beams = new MeshBuilder();
    const posts = new MeshBuilder();
    const walls = new MeshBuilder();
    const dots = new MeshBuilder();
    const lateral = MOUNTAIN.rail + 0.05;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i += 2) {
        const j = i + 2;
        const here = spanAt(i);
        const next = spanAt(j % n);
        if (here === 'tunnel' && next === 'tunnel') continue;
        if (here === 'bridge' || next === 'bridge') {
          // 防撞墙：下宽上窄，这里用一根粗梁代替
          walls.beam(this.at(i, lateral * side + 0.25 * side, 0.5, _a), this.at(j, lateral * side + 0.25 * side, 0.5, _b), 0.46, 1.0);
          continue;
        }
        const a = this.at(i, lateral * side, 0.56, _a);
        const b = this.at(j, lateral * side, 0.56, _b);
        beams.beam(a, b, 0.07, 0.32);
        const p = this.at(i, (lateral + 0.1) * side, 0, _a);
        posts.box(p.x, p.y + 0.38, p.z, 0.11, 0.76, 0.11);
        if (i % 6 === 0) dots.box(p.x, p.y + 0.83, p.z, 0.1, 0.13, 0.1, true);
      }
    }
    this.add(beams, this.mats.rail, true, true);
    this.add(posts, this.mats.post, false, true, true);
    this.add(walls, this.mats.concrete, true, true);
    this.add(dots, this.mats.reflector, false, false, true);
  }

  /* ------------------------------ 隧道 ------------------------------ */

  /** 隧道的断面：从左墙脚绕过拱顶到右墙脚的一串点（离中心线多远、离路面多高、是不是墙裙） */
  private tunnelProfile(): { l: number; h: number; skirt: number }[] {
    const T = TUNNEL;
    const out: { l: number; h: number; skirt: number }[] = [];
    out.push({ l: T.half, h: -0.4, skirt: 1 }, { l: T.half, h: 3.0, skirt: 1 }, { l: T.half, h: 3.0, skirt: 0 }, { l: T.half, h: T.wall, skirt: 0 });
    const seg = 12;
    for (let k = 1; k < seg; k++) {
      const a = (k / seg) * Math.PI;
      out.push({ l: T.half * Math.cos(a), h: T.wall + T.rise * Math.sin(a), skirt: 0 });
    }
    out.push({ l: -T.half, h: T.wall, skirt: 0 }, { l: -T.half, h: 3.0, skirt: 0 }, { l: -T.half, h: 3.0, skirt: 1 }, { l: -T.half, h: -0.4, skirt: 1 });
    return out;
  }

  private buildTunnel(sp: Span): void {
    const S = this.track.samples;
    const n = S.length;
    const prof = this.tunnelProfile();
    const m = prof.length;
    // 沿着断面走了多远（贴图坐标用）
    const around: number[] = [0];
    for (let j = 1; j < m; j++) around.push(around[j - 1] + Math.hypot(prof[j].l - prof[j - 1].l, prof[j].h - prof[j - 1].h));

    /* 内壁 */
    const pos: number[] = [];
    const nor: number[] = [];
    const uvs: number[] = [];
    const skirt: number[] = [];
    const idx: number[] = [];
    const [i0, i1] = this.portals(sp);
    for (let i = i0; i <= i1; i++) {
      const k = ((i % n) + n) % n;
      const p = S[k];
      for (let j = 0; j < m; j++) {
        const q = prof[j];
        pos.push(p.pos.x + p.left.x * q.l, p.pos.y + q.h, p.pos.z + p.left.z * q.l);
        // 法线朝隧道里面：墙是水平朝里，拱是朝着圆心
        const inX = -q.l;
        const inY = q.h > TUNNEL.wall ? -(q.h - TUNNEL.wall) * (TUNNEL.half / TUNNEL.rise) ** 2 : 0;
        const len = Math.hypot(inX, inY) || 1;
        nor.push((p.left.x * inX) / len, inY / len, (p.left.z * inX) / len);
        uvs.push(around[j], (i - i0) * 2);
        skirt.push(q.skirt);
      }
      if (i > i0) {
        const a0 = (i - i0 - 1) * m;
        const b0 = (i - i0) * m;
        for (let j = 0; j < m - 1; j++) idx.push(a0 + j, b0 + j, a0 + j + 1, a0 + j + 1, b0 + j, b0 + j + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.addGeometry(g, this.mats.lining, false, true);

    /* 两头的洞门：一面混凝土墙，中间掏出拱形的洞，顶上高出山坡一截 */
    const portal = new MeshBuilder();
    for (const [i, face] of [[i0, -1], [i1, 1]] as const) {
      const k = ((i % n) + n) % n;
      const p = S[k];
      const out: V3 = [p.dir.x * face, 0, p.dir.z * face];
      const top = 15.5;
      const wide = 21;
      const pt = (l: number, hh: number): V3 => [p.pos.x + p.left.x * l + p.dir.x * face * 0.35, p.pos.y + hh, p.pos.z + p.left.z * l + p.dir.z * face * 0.35];
      // 洞两边
      portal.quad(pt(TUNNEL.half, -1.5), pt(wide, -1.5), pt(wide, top), pt(TUNNEL.half, top), out);
      portal.quad(pt(-wide, -1.5), pt(-TUNNEL.half, -1.5), pt(-TUNNEL.half, top), pt(-wide, top), out);
      // 拱上面
      for (let j = 3; j < m - 4; j++) {
        const a = prof[j];
        const b = prof[j + 1];
        portal.quad(pt(a.l, a.h), pt(b.l, b.h), pt(b.l, top), pt(a.l, top), out);
      }
      // 洞门顶上一道压顶
      const c = new THREE.Vector3(p.pos.x + p.dir.x * face * 0.6, p.pos.y + top + 0.3, p.pos.z + p.dir.z * face * 0.6);
      this.block(portal, c, p.dir, p.left, wide * 2 + 1, 0.6, 1.4);
    }
    this.add(portal, this.mats.concrete, true, true);

    /* 顶灯：左右各一排，十二米一组。白天也亮着 */
    const fixtures = new MeshBuilder();
    for (let i = sp.i0 + 3; i <= sp.i1 - 2; i += 6) {
      const k = ((i % n) + n) % n;
      const p = S[k];
      for (const side of [1, -1]) {
        const l = 6.2 * side;
        const y = p.pos.y + TUNNEL.wall + TUNNEL.rise * Math.sin(Math.acos(Math.abs(l) / TUNNEL.half)) - 0.22;
        const c = new THREE.Vector3(p.pos.x + p.left.x * l, y, p.pos.z + p.left.z * l);
        this.block(fixtures, c, p.dir, p.left, 0.5, 0.12, 2.2);
        this.lamps.push({ x: c.x, y: y - 0.1, z: c.z, color: LAMP_SODIUM, power: 2.0, radius: 17, pool: 1, ground: p.pos.y });
      }
      this.glowSpots.push({ x: p.pos.x, y: p.pos.y + 7.0, z: p.pos.z, color: LAMP_SODIUM, size: 1.8, cone: 0, ground: p.pos.y });
    }
    this.add(fixtures, this.mats.tunnelLamp, false, false);

    /* 头顶有遮挡：隧道里不下雨、不积雪 */
    for (let i = sp.i0 + 1; i <= sp.i1 - 1; i += 3) {
      const p = S[((i % n) + n) % n];
      this.covers.push({ x0: p.pos.x - 10, x1: p.pos.x + 10, z0: p.pos.z - 10, z1: p.pos.z + 10, visibility: 0 });
    }
  }

  /* ------------------------------ 高架桥 ------------------------------ */

  private buildBridge(sp: Span): void {
    const S = this.track.samples;
    const n = S.length;
    const deck = new MeshBuilder();
    const piers = new MeshBuilder();
    const w = MOUNTAIN.bench + 0.5;
    /* 桥面下面的箱梁：上宽下窄 */
    for (let i = sp.i0 - 2; i < sp.i1 + 2; i += 2) {
      const a = S[((i % n) + n) % n];
      const b = S[(((i + 2) % n) + n) % n];
      const sec = (p: typeof a, l: number, drop: number): V3 => [p.pos.x + p.left.x * l, p.pos.y - drop, p.pos.z + p.left.z * l];
      for (const side of [1, -1]) {
        // 桥面板的侧沿、斜腹板
        deck.quad(sec(a, w * side, -0.1), sec(b, w * side, -0.1), sec(b, w * side, 0.55), sec(a, w * side, 0.55), [a.left.x * side, 0, a.left.z * side]);
        deck.quad(sec(a, w * side, 0.55), sec(b, w * side, 0.55), sec(b, 6.4 * side, 2.6), sec(a, 6.4 * side, 2.6), [a.left.x * side, -0.6, a.left.z * side]);
      }
      deck.quad(sec(a, -6.4, 2.6), sec(b, -6.4, 2.6), sec(b, 6.4, 2.6), sec(a, 6.4, 2.6), [0, -1, 0]);
    }
    /* 桥墩：两头各一个桥台，中间两根墩 */
    const len = sp.i1 - sp.i0;
    for (const t of [0.3, 0.7]) {
      const i = Math.round(sp.i0 + len * t);
      const p = S[((i % n) + n) % n];
      const foot = terrainHeight(p.pos.x, p.pos.z) - 2;
      const top = p.pos.y - 2.6;
      const c = new THREE.Vector3(p.pos.x, (top + foot) / 2, p.pos.z);
      this.block(piers, c, p.dir, p.left, 9, top - foot, 2.6);
      // 墩帽
      this.block(piers, new THREE.Vector3(p.pos.x, top - 0.5, p.pos.z), p.dir, p.left, 12.5, 1.0, 3.4);
    }
    for (const i of [sp.i0 - 2, sp.i1 + 2]) {
      const p = S[((i % n) + n) % n];
      const c = new THREE.Vector3(p.pos.x, p.pos.y - 8.2, p.pos.z);
      this.block(piers, c, p.dir, p.left, w * 2 + 6, 16, 5);
    }
    this.add(deck, this.mats.concrete, true, true);
    this.add(piers, this.mats.darkConcrete, true, true);
  }

  /* ------------------------------ 路灯 ------------------------------ */

  /** 一盏路灯：立在护栏外面，灯臂伸向路面 */
  private lamp(poles: MeshBuilder, heads: MeshBuilder, i: number, side: number): void {
    const n = this.track.samples.length;
    const k = ((i % n) + n) % n;
    if (spanAt(k) === 'tunnel') return;
    const p = this.track.samples[k];
    const foot = this.at(k, (MOUNTAIN.rail + 0.75) * side, 0, _a);
    const ground = roadHeightAt(k, 0);
    poles.box(foot.x, foot.y + 4.3, foot.z, 0.17, 8.6, 0.17);
    poles.box(foot.x, foot.y + 0.35, foot.z, 0.36, 0.7, 0.36);
    const tip = new THREE.Vector3(foot.x - p.left.x * side * 2.6, foot.y + 8.75, foot.z - p.left.z * side * 2.6);
    poles.beam(new THREE.Vector3(foot.x, foot.y + 8.5, foot.z), tip, 0.1, 0.1);
    this.block(heads, new THREE.Vector3(tip.x, tip.y - 0.1, tip.z), p.left, p.dir, 0.42, 0.12, 1.0);
    this.lamps.push({ x: tip.x, y: tip.y - 0.15, z: tip.z, color: LAMP_WARM, power: 3.0, radius: 28, pool: 1, ground });
    this.glowSpots.push({ x: tip.x, y: tip.y - 0.2, z: tip.z, color: LAMP_WARM, size: 3.0, cone: 5.5, ground });
  }

  /**
   * 路灯只在几个地方有：湖边的发车直道、两个发卡弯、大回头弯的外侧、桥上、隧道口。
   * 其余的路段夜里只有车灯和月光——山路本来就是这样的。
   */
  private buildLamps(): void {
    const S = this.track.samples;
    const n = S.length;
    const poles = new MeshBuilder();
    const heads = new MeshBuilder();
    const at = (s: number) => Math.round(((s % this.track.length) + this.track.length) % this.track.length / 2) % n;
    // 发车直道：两侧交错
    for (let k = 0, s = -64; s <= 300; s += 40, k++) this.lamp(poles, heads, at(s), k % 2 === 0 ? 1 : -1);
    // 弯：外侧（发卡弯密一些）
    for (const b of this.bends) {
      if (b.radius > 100) continue;
      const span = (b.i1 - b.i0 + n) % n;
      const count = b.radius < 45 ? 4 : 3;
      for (let k = 0; k < count; k++) this.lamp(poles, heads, b.i0 + Math.round((span * (k + 0.5)) / count), -b.side);
    }
    for (const sp of this.track.spans) {
      if (sp.kind === 'bridge') {
        const len = sp.i1 - sp.i0;
        [0.15, 0.5, 0.85].forEach((t, k) => this.lamp(poles, heads, Math.round(sp.i0 + len * t), k % 2 === 0 ? 1 : -1));
      } else {
        this.lamp(poles, heads, sp.i0 - 9, -1);
        this.lamp(poles, heads, sp.i1 + 9, 1);
      }
    }
    void S;
    this.add(poles, this.mats.steel, true, true, true);
    this.add(heads, this.mats.lamp, false, false, true);
  }

  /* ------------------------------ 导向牌、广告牌、龙门架 ------------------------------ */

  private buildSigns(): void {
    const S = this.track.samples;
    const n = S.length;
    const boards = new MeshBuilder();
    const legs = new MeshBuilder();
    /* 弯道外侧的导向牌：箭头指向弯里 */
    for (const b of this.bends) {
      if (b.radius > 110) continue;
      const span = (b.i1 - b.i0 + n) % n;
      const gap = b.radius < 45 ? 5 : 8;
      for (let d = 2; d < span - 1; d += gap) {
        const k = (b.i0 + d) % n;
        if (spanAt(k) === 'tunnel') continue;
        const p = S[k];
        const out = -b.side;
        const c = this.at(k, (MOUNTAIN.rail + 0.95) * out, 1.5, new THREE.Vector3());
        const half = 0.78;
        const corner = (sl: number, su: number): V3 => [c.x + p.left.x * half * sl, c.y + 0.56 * su, c.z + p.left.z * half * sl];
        // 牌面朝着来车；左弯箭头朝左，右弯朝右
        const uv: [number, number, number, number] = b.side > 0 ? [0, 0, 1, 1] : [1, 0, 0, 1];
        boards.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), [-p.dir.x, 0, -p.dir.z], uv);
        legs.box(c.x, c.y - 0.75, c.z, 0.08, 1.5, 0.08);
      }
    }
    this.add(boards, this.mats.chevron, false, true, true);

    /* 路边的大广告牌：立在护栏外面，朝着来车 */
    const ads = new MeshBuilder();
    const sites: [number, number][] = [
      [408, -1],
      [612, 1],
      [986, -1],
      [2066, 1],
      [2500, -1],
      [3690, -1],
    ];
    sites.forEach(([s, side], k) => {
      const i = Math.round(s / 2) % n;
      const p = S[i];
      const cx = p.pos.x + p.left.x * (MOUNTAIN.rail + 8.5) * side;
      const cz = p.pos.z + p.left.z * (MOUNTAIN.rail + 8.5) * side;
      const foot = terrainHeight(cx, cz);
      const bottom = Math.max(p.pos.y + 4.6, foot + 3.2);
      const W = 11.5;
      const H = 4.9;
      const corner = (sl: number, su: number): V3 => [cx + p.left.x * (W / 2) * sl, bottom + (su > 0 ? H : 0), cz + p.left.z * (W / 2) * sl];
      const row = k % BILLBOARDS;
      // 朝着来车的人看过去，左手边是 +left
      ads.quad(corner(1, -1), corner(-1, -1), corner(-1, 1), corner(1, 1), [-p.dir.x, 0, -p.dir.z], [0, 1 - (row + 1) / BILLBOARDS, 1, 1 - row / BILLBOARDS]);
      // 背板、边框和两条腿
      const back = new THREE.Vector3(cx + p.dir.x * 0.2, bottom + H / 2, cz + p.dir.z * 0.2);
      this.block(legs, back, p.dir, p.left, W + 0.5, H + 0.5, 0.3);
      for (const sl of [-1, 1]) {
        const lx = cx + p.left.x * (W / 2 - 1.6) * sl + p.dir.x * 0.4;
        const lz = cz + p.left.z * (W / 2 - 1.6) * sl + p.dir.z * 0.4;
        legs.box(lx, (bottom + foot - 1) / 2, lz, 0.4, bottom - foot + 1, 0.4);
      }
    });
    this.add(ads, this.mats.billboard, false, false);
    this.add(legs, this.mats.steel, true, true, true);
  }

  /** 起终点线上方的龙门架（比赛时终点的横幅就挂在它下面） */
  private buildGantry(): void {
    const S = this.track.samples;
    const i = 0;
    const p = S[i];
    const frame = new MeshBuilder();
    const strip = new MeshBuilder();
    const board = new MeshBuilder();
    const span = MOUNTAIN.rail + 0.9;
    for (const side of [1, -1]) {
      const c = this.at(i, span * side, 3.9, new THREE.Vector3());
      this.block(frame, c, p.dir, p.left, 0.55, 7.8, 0.55);
    }
    const mid = this.at(i, 0, 7.6, new THREE.Vector3());
    this.block(frame, mid, p.dir, p.left, span * 2 + 0.55, 0.9, 0.7);
    // 横梁朝着来车的那一面嵌一条灯带（不朝下：朝下的话车停在底下时整个画面顶上一片黄）
    this.block(strip, new THREE.Vector3(mid.x - p.dir.x * 0.36, mid.y, mid.z - p.dir.z * 0.36), p.dir, p.left, span * 2 - 1.2, 0.14, 0.06);
    // 横梁上挂一块牌子（用广告牌图集里写着赛道名的那一块）
    const row = 3;
    const W = 9;
    const H = 2.1;
    const c = new THREE.Vector3(mid.x - p.dir.x * 0.4, mid.y + 1.6, mid.z - p.dir.z * 0.4);
    const corner = (sl: number, su: number): V3 => [c.x + p.left.x * (W / 2) * sl, c.y + (H / 2) * su, c.z + p.left.z * (W / 2) * sl];
    // 只取那一块中间的一条（字在的地方）
    const v0 = 1 - (row + 0.72) / BILLBOARDS;
    const v1 = 1 - (row + 0.16) / BILLBOARDS;
    board.quad(corner(1, -1), corner(-1, -1), corner(-1, 1), corner(1, 1), [-p.dir.x, 0, -p.dir.z], [0, v0, 0.62, v1]);
    this.block(frame, new THREE.Vector3(c.x + p.dir.x * 0.2, c.y, c.z + p.dir.z * 0.2), p.dir, p.left, W + 0.4, H + 0.4, 0.25);
    this.add(frame, this.mats.steel, true, true);
    this.add(strip, this.mats.gantryStrip, false, false);
    this.add(board, this.mats.billboard, false, false);
  }

  /* ------------------------------ 树、灌木、草 ------------------------------ */

  /**
   * 这个地方是不是已经有东西了（树要离它 margin 米）：盖了房子的空地、电线底下、棚洞朝山谷的那一侧、山沟里的水。
   * 种树、撒草、摆石头之前都问一下
   */
  private occupied(x: number, z: number, margin: number): boolean {
    for (const c of this.scenery.clearings) if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + margin * 0.5) ** 2) return true;
    // 山沟里的水
    if (z < CASCADE.z0 + 12 && z > CASCADE.z1 - 12 && Math.abs(x - CASCADE.x) < 15 + margin) return true;
    const q = nearestRoad(x, z, 46);
    if (!q) return false;
    const s = this.track.samples[q.index].s;
    const side = Math.sign(q.lateral);
    // 电线：杆子那一侧让出一条
    for (const [s0, s1, lineSide] of POWER_LINES) if (margin > 0 && side === lineSide && s > s0 - 20 && s < s1 + 20 && Math.abs(q.lateral) < POLE_OFFSET + 4.5) return true;
    // 棚洞：朝山谷的那一侧不种，柱子之间要看得见外面；山坡那一侧是回填的土石
    if (s > GALLERY[0] - 6 && s < GALLERY[1] + 6 && (side < 0 ? Math.abs(q.lateral) < 40 : Math.abs(q.lateral) < 30)) return true;
    return false;
  }


  /**
   * 路两边的林子和地面上的草木。都是面片（见 flora.ts），所以可以种得密。
   *  - 湖边和谷底是阔叶林，秋天的颜色：金黄、锈红里夹着还没黄的绿和几棵白桦；
   *  - 山腰是针叶林：高大的云杉，和光着半截树干的松树；
   *  - 山脊上风大，树矮、稀，夹着半枯的老树。
   * 林子不是匀匀地铺满的：按噪声分成一片一片，中间留着草地；坡下的那一侧故意种得稀，开过去看得见山谷和湖。
   */
  private buildFlora(): void {
    const S = this.track.samples;
    const n = S.length;
    const rnd = seeded(20261113);
    // 手机上种得稀一些
    const thin = QUALITY.particles;
    interface Plant {
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      tile: number;
      tint: [number, number, number];
      near: boolean;
    }
    const trees: Plant[] = [];
    /** 这里是不是一片林子：0 草地 – 1 密林 */
    const stand = (x: number, z: number): number => smooth((fbm(x / 85 + 3.1, z / 85 - 1.7, 3, 77) + 0.3) / 0.5);
    const species = (y: number): number => {
      const low = smooth((40 - y) / 12);
      const high = smooth((y - 76) / 12);
      if (rnd() < 0.66 * low + 0.14 * (1 - low) * (1 - high)) {
        const k = rnd();
        return k < 0.36 ? TREE.gold : k < 0.62 ? TREE.rust : k < 0.84 ? TREE.green : TREE.birch;
      }
      const k = rnd();
      if (rnd() < high * 0.6) return k < 0.55 ? TREE.fir : TREE.spruceSlim;
      return k < 0.36 ? TREE.spruce : k < 0.58 ? TREE.spruceSlim : k < 0.86 ? TREE.pine : TREE.fir;
    };
    const plant = (x: number, z: number, near: boolean): void => {
      if (Math.abs(x) > MOUNTAIN.extent - 6 || Math.abs(z) > MOUNTAIN.extent - 6) return;
      const q = nearestRoad(x, z, 15);
      // 离任何一段路的护栏都要有几米；隧道顶上可以长
      if (q && q.span !== 'tunnel' && q.dist < MOUNTAIN.rail + 3.4) return;
      if (this.occupied(x, z, 4)) return;
      const y = terrainHeight(x, z);
      if (y < MOUNTAIN.lake + 0.9) return;
      if (terrainNormal(x, z, _n, 2).y < 0.72) return;
      const tile = species(y);
      const broad = tile >= TREE.green;
      const high = smooth((y - 76) / 12);
      // 针叶树 15–30 米，山脊上矮一截；阔叶树 9–15 米（面片要再高一些：格子上面那一截是空的）
      const tall = broad ? (9 + rnd() * 6) / BROADLEAF_FILL : (15 + rnd() * rnd() * 16) * (1 - 0.3 * high);
      const shade = 0.78 + rnd() * 0.4;
      trees.push({ x, y: y - 0.3, z, w: tall * 0.5, h: tall, tile, tint: [shade * (0.94 + rnd() * 0.12), shade, shade * (0.92 + rnd() * 0.16)], near });
    };
    // 沿路种：每两米一排，每侧六列，越靠外越稀
    for (let i = 0; i < n; i++) {
      const p = S[i];
      for (const side of [1, -1]) {
        // 坡下的一侧：往外四十五米的地方比路面低好几米，那边是山谷
        const fall = p.pos.y - terrainHeight(p.pos.x + p.left.x * 45 * side, p.pos.z + p.left.z * 45 * side);
        const vista = smooth((fall - 3) / 5);
        for (const [d0, d1, chance] of [[13.6, 21, 0.62], [21, 33, 0.7], [33, 52, 0.7], [52, 82, 0.62], [82, 125, 0.5], [125, 180, 0.38]] as const) {
          const d = d0 + rnd() * (d1 - d0);
          const along = (rnd() - 0.5) * 4;
          const x = p.pos.x + p.left.x * d * side + p.dir.x * along;
          const z = p.pos.z + p.left.z * d * side + p.dir.z * along;
          let c = chance * thin * (0.12 + 0.88 * stand(x, z));
          if (d < 60) c *= 1 - 0.72 * vista;
          // 发车直道朝湖的那一侧再稀一些：看得见湖和码头
          if (side > 0 && (p.s < 350 || p.s > 3850)) c *= 0.4;
          if (rnd() < c) plant(x, z, d < 48);
        }
      }
    }
    // 再远的山坡上成片地撒一些，免得林子的边是齐的
    for (let k = 0; k < 7000 * thin; k++) {
      const x = (rnd() * 2 - 1) * (MOUNTAIN.extent - 10);
      const z = -430 + rnd() * (MOUNTAIN.extent + 420);
      if (rnd() > stand(x, z)) continue;
      if (nearestRoad(x, z, 175)) continue;
      plant(x, z, false);
    }
    for (const near of [true, false]) {
      for (const cell of groupByCell(trees.filter((t) => t.near === near), 320)) {
        const batch = new FoliageBatch();
        for (const t of cell) batch.add(t.x, t.y, t.z, t.w, t.h, t.tile, TREE_TILES, rnd() * Math.PI, near ? 3 : 2, t.tint, rnd() < 0.5);
        const mesh = new THREE.Mesh(batch.build(), this.mats.tree);
        mesh.castShadow = near;
        mesh.receiveShadow = true;
        mesh.layers.set(DETAIL_LAYER);
        this.group.add(mesh);
      }
    }
    this.treeCount = trees.length;

    /* 地面上的：护栏外面一条稀稀拉拉的干草，再往外是草丛、蕨和野花，夹着灌木和小树苗 */
    const cover: Plant[] = [];
    for (let i = 0; i < n; i++) {
      if (spanAt(i)) continue;
      const p = S[i];
      for (const side of [1, -1]) {
        const put = (d0: number, d1: number, tile: number, lo: number, hi: number, wide: number): void => {
          const d = d0 + rnd() * (d1 - d0);
          const along = (rnd() - 0.5) * 2;
          const x = p.pos.x + p.left.x * d * side + p.dir.x * along;
          const z = p.pos.z + p.left.z * d * side + p.dir.z * along;
          const q = nearestRoad(x, z, 14);
          if (q && q.span !== 'tunnel' && q.dist < MOUNTAIN.bench + 0.3) return;
          if (this.occupied(x, z, 0)) return;
          const y = terrainHeight(x, z);
          if (y < MOUNTAIN.lake + 0.4) return;
          if (terrainNormal(x, z, _n, 1.5).y < 0.6) return;
          const h = lo + rnd() * (hi - lo);
          const shade = 0.8 + rnd() * 0.35;
          cover.push({ x, y: y - 0.05, z, w: h * wide, h, tile, tint: [shade, shade, shade], near: false });
        };
        const high = smooth((p.pos.y - 70) / 14);
        if (rnd() < 0.55 * thin) put(11.1, 13.6, rnd() < 0.75 ? COVER.dryGrass : COVER.twigs, 0.45, 0.95, 1.2);
        for (let k = 0; k < 3; k++) {
          if (rnd() > 0.7 * thin) continue;
          const r = rnd();
          const tile = r < 0.3 + 0.4 * high ? COVER.dryGrass : r < 0.62 ? COVER.grass : r < 0.8 ? COVER.fern : r < 0.93 ? COVER.flowers : COVER.twigs;
          put(13.2, 23, tile, 0.6, 1.4, 1.25);
        }
        if (rnd() < 0.4 * thin) {
          const r = rnd();
          put(15, 36, r < 0.42 ? COVER.shrub : r < 0.72 ? COVER.redShrub : r < 0.9 ? COVER.sapling : COVER.twigs, 1.3, 3.0, 1.1);
        }
      }
    }
    this.coverCount = cover.length;
    for (const cell of groupByCell(cover, 320)) {
      const batch = new FoliageBatch();
      for (const t of cell) batch.add(t.x, t.y, t.z, t.w, t.h, t.tile, COVER_TILES, rnd() * Math.PI, 2, t.tint, rnd() < 0.5);
      const mesh = new THREE.Mesh(batch.build(), this.mats.cover);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.layers.set(DETAIL_LAYER);
      this.group.add(mesh);
    }
  }

  /**
   * 石头。两种：
   *  - 路堑那一侧（山坡被切开、路边就是坡）嵌着一排大岩块，高高低低连成一道石壁；
   *  - 别处零星散着些小的。
   * 岩块是把一个二十面体的顶点随机推一推再压扁，不平滑着色，所以有棱有角。
   */
  private buildRocks(): void {
    const S = this.track.samples;
    const n = S.length;
    const rnd = seeded(4242);
    const shape = (seed: number, squash: number): THREE.BufferGeometry => {
      const base = new THREE.IcosahedronGeometry(1, 2);
      const p = base.attributes.position;
      const r2 = seeded(seed);
      // 同一个位置的顶点要推到同一个地方（否则石头会裂开）：按位置取随机数
      const seen = new Map<string, number>();
      for (let i = 0; i < p.count; i++) {
        const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
        let k = seen.get(key);
        if (k === undefined) {
          k = 0.7 + r2() * 0.5;
          seen.set(key, k);
        }
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * squash, p.getZ(i) * k);
      }
      const g = base.toNonIndexed();
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    };
    const spots: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
    for (let i = 0; i < n; i += 2) {
      const p = S[i];
      if (spanAt(i)) continue;
      for (const side of [1, -1]) {
        const rise = terrainHeight(p.pos.x + p.left.x * 20 * side, p.pos.z + p.left.z * 20 * side) - p.pos.y;
        const cut = rise > 3;
        if (rnd() > (cut ? 0.62 : 0.1)) continue;
        const d = MOUNTAIN.rail + (cut ? 2.6 + rnd() * 5.5 : 2.2 + rnd() * 18);
        const x = p.pos.x + p.left.x * d * side + p.dir.x * (rnd() - 0.5) * 3;
        const z = p.pos.z + p.left.z * d * side + p.dir.z * (rnd() - 0.5) * 3;
        const q = nearestRoad(x, z, 14);
        if (q && q.dist < MOUNTAIN.rail + 1.9) continue;
        if (this.occupied(x, z, 0)) continue;
        const s = cut ? 1.8 + rnd() * 3.4 : 0.5 + rnd() * rnd() * 2.4;
        spots.push({ x, y: terrainHeight(x, z) + s * (cut ? 0.25 : 0.12), z, sx: s * (0.8 + rnd() * 0.7), sy: s * (cut ? 0.8 + rnd() * 0.9 : 0.55 + rnd() * 0.5), sz: s * (0.8 + rnd() * 0.7) });
      }
    }
    const kinds = [shape(99, 0.85), shape(7, 1.0), shape(31, 0.7)];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pv = new THREE.Vector3();
    const sc = new THREE.Vector3();
    kinds.forEach((geo, k) => {
      const mine = spots.filter((_, i) => i % kinds.length === k);
      const mesh = new THREE.InstancedMesh(geo, this.mats.rock, mine.length);
      mine.forEach((t, i) => {
        q.setFromEuler(e.set((rnd() - 0.5) * 0.7, rnd() * 6.28, (rnd() - 0.5) * 0.7));
        m.compose(pv.set(t.x, t.y, t.z), q, sc.set(t.sx, t.sy, t.sz));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.layers.set(DETAIL_LAYER);
      this.group.add(mesh);
    });
  }

  /* ------------------------------ 湖、天空 ------------------------------ */

  private buildWater(): void {
    const lake = new THREE.Mesh(new THREE.PlaneGeometry(6200, 6200), this.water);
    lake.rotation.x = -Math.PI / 2;
    lake.position.y = MOUNTAIN.lake;
    lake.receiveShadow = true;
    lake.frustumCulled = false;
    this.group.add(lake);
  }

  private buildSky(): void {
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    skyMat.colorNode = skyColorNode();
    skyMat.fog = false;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 48, 24), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // 主光：白天和黄昏是太阳，夜里是月亮。级联阴影：近处的车影清晰，远处的树影也在
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(QUALITY.shadowSize, QUALITY.shadowSize);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.06;
    this.csm = new CSMShadowNode(this.sun, { cascades: QUALITY.cascades, maxFar: QUALITY.shadowFar, mode: 'practical', lightMargin: 320 });
    this.sun.shadow.shadowNode = this.csm;
    this.group.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.group.add(this.hemi);
  }

  pauseShadows(paused: boolean): void {
    if (!this.csm) return;
    for (const light of this.csm.lights) if (light.shadow) light.shadow.autoUpdate = !paused;
  }

  /** 所有几何建完之后：烤地面光照图，建车身高光用的点光源池，给每个材质接上灯光和积雪 */
  private finishLighting(): void {
    this.lightmap.bake(this.lamps, this.covers);
    this.lampPool = new LightPool(
      this.lamps.filter((l) => l.pool === 1),
      6,
      50,
      46,
      this.group,
    );
    const M = this.mats;
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardNodeMaterial;
      if (this.litMaterials.has(m)) return;
      this.litMaterials.add(m);
      if (!m.isMeshStandardNodeMaterial || m === this.water) return;
      // 路面和山体有自己的积雪写法；隧道内壁淋不到；牌子是竖着的
      const foliage = m === M.tree || m === M.cover;
      const L = this.looks;
      const flat = m === M.chevron || m === M.billboard || m === L.sign || m === L.neon || m === L.glass || m === L.cascade;
      if (m !== M.road && m !== M.terrain && m !== M.lining && !flat && !foliage) addSnow(m, this.lightmap);
      // 导向牌贴的是反光膜：被车灯照到比别的东西亮得多。树冠压暗一些，不然像塑料
      this.lightmap.apply(m, m === M.chevron || m === L.sign ? 3.2 : foliage ? 0.3 : 1, m === M.road);
    });
    const node = lights([this.sun, this.hemi]);
    for (const m of this.litMaterials) (m as THREE.NodeMaterial).lightsNode = node;
  }

  setCarLighting(s: CarLighting): void {
    const u = cityUniforms;
    u.headPos.value.copy(s.headPos);
    u.headDir.value.copy(s.headDir);
    // 山里没有别的灯，路全靠车灯照：比城里开得亮得多（眼睛也适应了暗处）
    u.headPower.value = s.headlight * 17.0;
    u.carPos.value.copy(s.groundPos);
    u.carDir.value.copy(s.heading);
    u.carShadow.value = s.shadow;
    u.tailGlow.value = s.tailGlow;
  }

  setRivalLighting(list: RivalLighting[]): void {
    const pos = cityUniforms.rivalPos.array as THREE.Vector4[];
    const dir = cityUniforms.rivalDir.array as THREE.Vector4[];
    for (let i = 0; i < RIVAL_SLOTS; i++) {
      const r = list[i];
      if (r) {
        pos[i].set(r.x, r.y, r.z, r.shadow);
        dir[i].set(r.dirX, r.dirZ, r.tailGlow, 0);
      } else {
        pos[i].set(0, -100, 0, 0);
        dir[i].set(0, 1, 0, 0);
      }
    }
  }

  /** 让外来的材质（比赛的终点线、检查点、雪地车辙）和这里的其他表面一样受光 */
  adopt(m: THREE.MeshStandardNodeMaterial): void {
    this.lightmap.apply(m);
    m.lightsNode = lights([this.sun, this.hemi]);
    this.litMaterials.add(m);
    this.envKey = null;
  }

  /** 把当前的时段叠上天气，写进灯光、天空和画面外观。每帧调用 */
  private present(): void {
    const w = this.weather;
    const p = applyWeather(this.current, w);
    applySky(p);
    cityUniforms.lights.value = p.lights;
    cityUniforms.wetness.value = w.wetness;
    cityUniforms.rain.value = w.rain;
    cityUniforms.haze.value = haze01(w.fog, w.rain);
    cityUniforms.snow.value = w.snowCover;

    this.sun.color.setRGB(...p.keyColor);
    this.sun.intensity = p.keyIntensity;
    // 夜里不算主光的影子（月光很暗，影子几乎看不出来）。开关的一瞬间材质要重新编译，所以只在昼夜交替时切一次
    const shadows = p.keyIntensity >= 0.7;
    if (this.sun.castShadow !== shadows) this.sun.castShadow = shadows;
    this.sun.position.set(...p.keyDir).normalize().multiplyScalar(300);
    this.keyLight.dir.set(...p.keyDir).normalize();
    this.keyLight.color.setRGB(...p.keyColor).multiplyScalar(p.keyIntensity);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    this.hemi.color.setRGB(...p.hemiSky);
    this.hemi.groundColor.setRGB(...p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;

    const k = this.look;
    k.fogColor.setRGB(...p.fogColor);
    k.fogDensity = p.fogDensity;
    k.exposure = p.exposure;
    k.environmentIntensity = p.envIntensity;
    k.night = p.lights;
    k.bloomStrength = p.bloomStrength;
    k.bloomThreshold = p.bloomThreshold;
    k.bloomRadius = p.bloomRadius;
    k.contrast = p.contrast;
    k.saturation = p.saturation;
    k.shadowTint.setRGB(...p.shadowTint);
    k.highlightTint.setRGB(...p.highlightTint);
    k.wetness = w.wetness;
    k.rain = w.rain;
    k.snow = w.snowCover;

    this.lampPool.strength = p.lights;
    // 落叶不受灯光照：按这会儿太阳和天光加起来有多亮直接给它一个颜色
    this.leafLight.setRGB(
      (p.keyColor[0] * p.keyIntensity * 0.6 + p.hemiSky[0] * p.hemiIntensity) / Math.PI,
      (p.keyColor[1] * p.keyIntensity * 0.6 + p.hemiSky[1] * p.hemiIntensity) / Math.PI,
      (p.keyColor[2] * p.keyIntensity * 0.6 + p.hemiSky[2] * p.hemiIntensity) / Math.PI,
    );

    this.precip.rain.amount.value = w.rain;
    this.precip.rain.ambient.value.setRGB(p.hemiSky[0] * p.hemiIntensity * 0.34 + 0.012, p.hemiSky[1] * p.hemiIntensity * 0.34 + 0.013, p.hemiSky[2] * p.hemiIntensity * 0.34 + 0.016);
    this.precip.snowFx.amount.value = w.snow;
    this.precip.snowFx.ambient.value.setRGB(p.hemiSky[0] * p.hemiIntensity * 0.8 + 0.035, p.hemiSky[1] * p.hemiIntensity * 0.8 + 0.036, p.hemiSky[2] * p.hemiIntensity * 0.8 + 0.04);

    // 环境贴图不能逐帧插值：时段过渡到一半、云遮住一半天的时候换成对应的那一套
    const key = `${p.id}:${w.overcast > 0.5 ? 1 : 0}`;
    if (this.envKey !== key) {
      const env = this.envs.get(key);
      if (env) {
        this.envKey = key;
        k.environment = env.car;
        // 车用的是跟着它走的实时探针；山和路自己的材质固定用静态环境贴图。路面和水面只反射天
        for (const m of this.litMaterials) {
          const std = m as THREE.MeshStandardNodeMaterial;
          if (!std.isMeshStandardNodeMaterial) continue;
          const first = std.envMap === null;
          std.envMap = m === this.mats.road || m === this.water ? env.sky : env.car;
          std.envMapIntensity = m === this.mats.road ? 0.45 : 1.0;
          if (first) std.needsUpdate = true;
        }
      }
    }
  }

  get timeName(): string {
    return this.timeTo.name;
  }

  setTime(id: string, immediate = false): void {
    const next = MOUNTAIN_TIMES[id as TimeId];
    if (!next) return;
    if (immediate) {
      this.timeFrom = next;
      this.timeTo = next;
      this.timeT = 1;
      this.current = next;
      this.present();
      return;
    }
    this.timeFrom = this.current;
    this.timeTo = next;
    this.timeT = 0;
  }

  cycleTime(): string {
    const i = TIME_ORDER.indexOf(this.timeTo.id);
    this.setTime(TIME_ORDER[(i + 1) % TIME_ORDER.length]);
    return this.timeTo.name;
  }

  get weatherName(): string {
    return this.weatherTo.name;
  }

  setWeather(id: string, immediate = false): void {
    const next = WEATHERS[id as WeatherId];
    if (!next) return;
    this.weatherTo = next;
    if (immediate) {
      const w = this.weather;
      w.rain = next.rain;
      w.wetness = next.wet;
      w.fog = next.fog;
      w.overcast = next.overcast;
      w.snow = next.snow;
      w.snowCover = next.snow;
      w.flash = 0;
      this.precip.calm();
      this.present();
    }
  }

  cycleWeather(): string {
    const i = WEATHER_ORDER.indexOf(this.weatherTo.id);
    this.setWeather(WEATHER_ORDER[(i + 1) % WEATHER_ORDER.length]);
    return this.weatherTo.name;
  }

  /** 立刻打一道闪电（调试、截图用） */
  strikeLightning(): void {
    this.precip.strike();
    this.onLightning?.();
  }

  update(dt: number, focus: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    if (this.timeT < 1) {
      this.timeT = Math.min(1, this.timeT + dt / TIME_FADE);
      const t = this.timeT;
      this.current = blendTime(this.timeFrom, this.timeTo, t * t * (3 - 2 * t));
    }
    stepWeather(this.weather, this.weatherTo, dt);
    this.precip.updateLightning(dt, camera, this.weather, this.weatherTo.lightning, () => this.onLightning?.());
    this.present();

    this.sky.position.copy(camera.position);
    this.lampPool.update(focus);
    this.precip.update(dt, camera);
    this.scenery.update(dt);
    this.leaves.update(dt, camera, Math.min(1, this.weather.rain + this.weather.snow), this.leafLight);
    if (this.csm && (camera.fov !== this.lastFov || camera.aspect !== this.lastAspect || camera.near !== this.lastNear)) {
      this.lastFov = camera.fov;
      this.lastAspect = camera.aspect;
      this.lastNear = camera.near;
      if (this.csm.camera) this.csm.updateFrustums();
    }
  }

  airLight(p: unknown): unknown {
    return this.lightmap.airLight(p);
  }

  openSky(p: unknown): unknown {
    return float(1).sub(this.lightmap.cover(p));
  }

  /** 这个位置头顶上有没有东西（隧道、棚洞） */
  covered(x: number, z: number): boolean {
    for (const c of this.covers) if (c.visibility < 0.7 && x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1) return true;
    return false;
  }

  resetProps(): void {
    // 山路上没有可移动的道具
  }

  /**
   * 每个时段各烤一套环境贴图：
   *  - 车和树用的：天空 + 地面 + 一圈示意性的山和树林，车身侧面映出来的是两边的林子，不是一片空天；
   *  - 路面和水面用的：只有天空。
   */
  buildEnvironment(renderer: THREE.WebGPURenderer): void {
    const env = new THREE.Scene();
    const sky = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    sky.colorNode = skyColorNode();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), sky));
    const floorMat = new THREE.MeshBasicMaterial();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(400, 32), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1;
    env.add(floor);

    const rnd = seeded(5);
    const woods: { mat: THREE.MeshBasicMaterial; g: number }[] = [];
    // 近处一圈树
    for (let k = 0; k < 46; k++) {
      const a = (k / 46) * Math.PI * 2 + rnd() * 0.12;
      const r = 20 + rnd() * 26;
      const h = 14 + rnd() * 16;
      const mat = new THREE.MeshBasicMaterial();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(3.4 + rnd() * 2.2, h, 7), mat);
      cone.position.set(Math.cos(a) * r, h / 2 - 1, Math.sin(a) * r);
      env.add(cone);
      woods.push({ mat, g: 0.05 + rnd() * 0.05 });
    }
    // 远处一圈山
    const hills: { mat: THREE.MeshBasicMaterial; g: number }[] = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2 + rnd() * 0.2;
      // 朝南（-Z）是湖：那一侧不堆山
      if (Math.sin(a) < -0.55) continue;
      const r = 150 + rnd() * 60;
      const h = 60 + rnd() * 80;
      const mat = new THREE.MeshBasicMaterial();
      const hill = new THREE.Mesh(new THREE.ConeGeometry(90 + rnd() * 50, h, 6), mat);
      hill.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
      env.add(hill);
      hills.push({ mat, g: 0.12 + rnd() * 0.08 });
    }

    const skyOnly = new THREE.Scene();
    skyOnly.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), sky));
    const groundMat = new THREE.MeshBasicMaterial();
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 32), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    skyOnly.add(ground);

    const pmrem = new THREE.PMREMGenerator(renderer);
    for (const id of TIME_ORDER) for (const oc of [0, 1]) {
      const p = applyWeather(MOUNTAIN_TIMES[id], { rain: oc, wetness: oc, fog: oc ? WEATHERS.rain.fog : 1, overcast: oc, flash: 0, snow: 0, snowCover: 0 });
      applySky(p);
      const lit = id === 'day' ? 1 : id === 'dusk' ? 0.5 : 0.06;
      const tint = id === 'dusk' ? [1.2, 0.85, 0.75] : id === 'night' ? [0.75, 0.85, 1.25] : [1, 1.02, 1.05];
      for (const t of woods) t.mat.color.setRGB(t.g * 0.5 * lit * tint[0], t.g * lit * tint[1], t.g * 0.5 * lit * tint[2]);
      for (const h of hills) h.mat.color.setRGB(h.g * lit * tint[0], h.g * 1.1 * lit * tint[1], h.g * 1.05 * lit * tint[2]);
      floorMat.color.setRGB(0.09 * lit * tint[0], 0.1 * lit * tint[1], 0.08 * lit * tint[2]);
      groundMat.color.setRGB(0.16 * lit, 0.17 * lit, 0.16 * lit);
      const car = pmrem.fromScene(env, 0, 0.1, 600, { size: 256 }).texture;
      const skyTex = pmrem.fromScene(skyOnly, 0, 0.1, 600, { size: 256 }).texture;
      this.envs.set(`${id}:${oc}`, { car, sky: skyTex });
    }
    pmrem.dispose();
    this.envKey = null;
    this.present();
  }
}
