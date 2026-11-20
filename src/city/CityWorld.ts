import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  cross,
  float,
  fract,
  length,
  lights,
  max,
  mix,
  mod,
  mx_noise_float,
  normalize,
  positionView,
  positionWorld,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { QUALITY } from '../core/quality.ts';
import { fxDepthFade } from '../core/fx.ts';
import type { CarLighting } from '../drive/CarLights.ts';
import type { DriveWorld, RivalLighting, WorldLook } from '../drive/DriveWorld.ts';
import type { PhysicsWorld } from '../drive/PhysicsWorld.ts';
import {
  ARCH_BRIDGE,
  avenueX,
  BLOCK,
  buildCityTrack,
  CITY,
  ELEVATED,
  FLAT_BRIDGE,
  HALF_ROAD,
  LAKESHORE,
  LAND,
  LOWER_LEVEL,
  RIVER,
  facadeGrid,
  GROUND_FLOOR,
  roadHeight,
  SHOP_BAY,
  shopLit,
  shopMask,
  streetZ,
  type Building,
  type CityTrack,
} from './cityLayout.ts';
import { addCityColliders, buildStructures, type CityStructures } from './cityPhysics.ts';
import { applySky, blendTime, skyColorNode, TIME_ORDER, TIMES, type TimeId, type TimePreset } from './atmosphere.ts';
import { CityLightmap, LightPool, type CityLight, type SkyCover } from './cityLights.ts';
import { createLampGlow, haze01, type GlowSpot } from './LampGlow.ts';
import { addAwning, addFireEscape, addMast, addWaterTower, createAwningMaterial, type WallFace } from './cityDetails.ts';
import { addSnow, cityUniforms, createCityMaterials, LED_CELL, RIVAL_SLOTS, type CityMaterials } from './materials.ts';
import { MeshBuilder, type V3 } from './MeshBuilder.ts';
import { SnowTracks } from './SnowTracks.ts';
import { Precipitation } from './Precipitation.ts';
import { applyWeather, stepWeather, WEATHER_ORDER, WEATHERS, type WeatherId, type WeatherPreset, type WeatherState } from './weather.ts';
import { createSignAtlas, createSignMaterial, type SignCell } from './signs.ts';
import { createLitter, createSteamVents, LITTER_COLORS, StreetProps, type LitterPiece } from './props.ts';
import { createParkedCars, PARKED_COLORS, type ParkedCar } from './parkedCars.ts';
import { createTree } from './trees.ts';
import { DETAIL_LAYER, groupByCell, splitGeometry } from './chunks.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 时段切换的过渡时间（秒） */
const TIME_FADE = 2.6;
/** 各种灯的颜色 */
const LAMP_WARM: [number, number, number] = [1.0, 0.66, 0.32];
const LAMP_TEAL: [number, number, number] = [0.55, 0.95, 1.0];
const LAMP_SODIUM: [number, number, number] = [1.0, 0.6, 0.24];
const EDGE = HALF_ROAD + CITY.sidewalk;
const UP = new THREE.Vector3(0, 1, 0);

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

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/** 这个位置是不是在高架铁路下面 */
const underElevated = (x: number, z: number) =>
  Math.abs(x - avenueX(ELEVATED.avenue)) < 14 && z > streetZ(ELEVATED.j0) - 20 && z < streetZ(ELEVATED.j1) + 20;
/** 这个位置是不是在下层街道（上面盖着顶板）里 */
const underDeck = (x: number, z: number) =>
  Math.abs(z - streetZ(LOWER_LEVEL.street)) < 14 && x > avenueX(LOWER_LEVEL.i0) + 10 && x < avenueX(LOWER_LEVEL.i1) - 10;

/**
 * 城市赛道"霓虹湾"。
 * 所有几何都由 cityLayout 里的数据程序化生成，并和物理碰撞体共用同一份数据。
 * 这一阶段只做白天的中性光照；夜景、霓虹、雨天在阶段 4、5 接着这套材质做。
 */
export class CityWorld implements DriveWorld {
  readonly group = new THREE.Group();
  readonly label = '霓虹湾';
  readonly dynamicReflections = true;
  readonly start: { x: number; z: number; yaw: number };
  readonly track: CityTrack;
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
  /** 雨丝、闪电这些特效。试驾模式会把它加进引擎的特效叠加层 */
  readonly fxGroup = new THREE.Group();
  /** 打闪电的一瞬间调用（雷声跟着它响） */
  onLightning: (() => void) | null = null;

  private readonly mats: CityMaterials;
  private readonly st: CityStructures;
  /** 全城的灯：烤进地面光照图，也是车身高光点光源的来源 */
  private readonly cityLights: CityLight[] = [];
  private readonly covers: SkyCover[] = [];
  /** 会在空气里晕开的灯（路灯、桥下的钠灯、红绿灯），建完之后一起做成光晕和光锥 */
  private readonly glowSpots: GlowSpot[] = [];
  readonly lightmap = new CityLightmap();
  private lampPool!: LightPool;
  private neonPool!: LightPool;
  private readonly litMaterials = new Set<THREE.Material>();
  private hemi!: THREE.HemisphereLight;
  private timeFrom: TimePreset = TIMES.night;
  private timeTo: TimePreset = TIMES.night;
  private timeT = 1;
  private current: TimePreset = TIMES.night;
  /** 环境贴图按"时段 + 是否阴天"各烤一套 */
  private readonly envs = new Map<string, { car: THREE.Texture; sky: THREE.Texture }>();
  private envKey: string | null = null;
  private weatherTo: WeatherPreset = WEATHERS.rain;
  private readonly weather: WeatherState = { rain: 1, wetness: 1, fog: WEATHERS.rain.fog, overcast: 1, flash: 0, snow: 0, snowCover: 0 };
  /** 雨丝、雪花、闪电（和山路那张图共用的那一套） */
  private readonly precip: Precipitation;
  /** 车轮在雪地上压出来的车辙 */
  readonly snowTracks: SnowTracks;
  /** 主光（太阳或月亮）此刻的方向和颜色乘亮度：特效拿它算受光 */
  readonly keyLight = { dir: new THREE.Vector3(0, 1, 0), color: new THREE.Color(0, 0, 0) };
  private sun!: THREE.DirectionalLight;
  private csm: CSMShadowNode | null = null;
  private sky!: THREE.Mesh;
  private lastFov = 0;
  private lastAspect = 0;
  private lastNear = 0;

  constructor(physics: PhysicsWorld) {
    this.track = buildCityTrack();
    this.start = this.track.start;
    this.st = buildStructures();
    addCityColliders(physics, this.st);
    this.mats = createCityMaterials(this.lightmap);

    this.buildLand();
    this.buildSidewalks();
    this.buildBuildings();
    this.buildWater();
    this.buildBridges();
    this.buildElevated();
    this.buildLowerLevel();
    this.buildRailings();
    this.buildBarriers();
    this.buildStreetFurniture();
    this.buildSigns();
    this.buildFacadeDetails();
    this.buildTrees();
    this.buildSteam();
    this.buildParkedCars();
    this.buildFerrisWheel();
    this.buildSky();
    this.precip = new Precipitation(this.lightmap);
    this.fxGroup.add(this.precip.group);
    this.fxGroup.add(createLampGlow(this.glowSpots));
    this.finishLighting();
    // 雪地上的车辙：和路面一样接进城市的灯光；高架下面没有雪，也就不显示
    this.snowTracks = new SnowTracks(float(1).sub(this.lightmap.cover(positionWorld)));
    this.adopt(this.snowTracks.material);
    this.group.add(this.snowTracks.mesh);
    this.present();
  }

  /**
   * 把攒好的三角形做成网格放进城市。
   * 面数多的会按格子切成几块，镜头外的整块跳过（见 chunks.ts）；面数少的保持一整块，不参与裁剪。
   * @param detail 细碎的东西（杂物、防火梯、灯杆）：反射探针不拍
   */
  private add(b: MeshBuilder, material: THREE.Material, cast = true, receive = true, detail = false): void {
    const whole = b.build();
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

  /** 一种"灯具"材质：白天是不发光的灯罩颜色，入夜后亮成 on 的颜色 */
  private glow(off: [number, number, number], on: [number, number, number]): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = mix(vec3(...off), vec3(...on), smoothstep(0.1, 0.5, cityUniforms.lights));
    return m;
  }

  /** 登记一盏灯。ground 是灯正下方地面的高度（桥面上的灯不是 0） */
  private light(x: number, y: number, z: number, color: [number, number, number], power: number, radius: number, pool: 0 | 1 | 2 = 1, ground = 0): void {
    this.cityLights.push({ x, y, z, color, power, radius, pool, ground });
  }

  /* ------------------------------ 陆地与路面 ------------------------------ */

  private buildLand(): void {
    const top = new MeshBuilder();
    const quay = new MeshBuilder();
    const L = LAKESHORE;
    const rect = (x0: number, z0: number, x1: number, z1: number, y = 0) =>
      top.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], [x0, z0, x1, z1]);

    // 河南、河北两块陆地
    rect(LAND.west, LAND.south, LAND.east, RIVER.z0);
    rect(LAND.west, RIVER.z1, LAND.east, LAND.north);

    // 半岛：圆盘在湖岸线以东的部分
    const R = L.radius + HALF_ROAD + L.promenade;
    const am = Math.acos((LAND.east - L.cx) / R);
    const arc: [number, number][] = [];
    for (let k = 0; k <= 72; k++) {
      const a = -am + (2 * am * k) / 72;
      arc.push([L.cx + R * Math.cos(a), L.cz + R * Math.sin(a)]);
    }
    top.fan([L.cx + 40, L.cz], [...arc, arc[0]], 0);
    for (let k = 0; k < arc.length - 1; k++) {
      const a = (arc[k][0] + arc[k + 1][0]) / 2 - L.cx;
      const b = (arc[k][1] + arc[k + 1][1]) / 2 - L.cz;
      quay.wall(arc[k][0], arc[k][1], arc[k + 1][0], arc[k + 1][1], -3.4, 0, [a, 0, b]);
    }

    // 桥面：平的直接铺一块；拱桥沿拱形细分
    for (let i = 0; i < CITY.ni; i++) {
      const x = avenueX(i);
      if (i === ARCH_BRIDGE.avenue) {
        const n = 48;
        for (let k = 0; k < n; k++) {
          const za = RIVER.z0 + ((RIVER.z1 - RIVER.z0) * k) / n;
          const zb = RIVER.z0 + ((RIVER.z1 - RIVER.z0) * (k + 1)) / n;
          const ya = roadHeight(x, za);
          const yb = roadHeight(x, zb);
          top.quad([x - EDGE, ya, za], [x - EDGE, yb, zb], [x + EDGE, yb, zb], [x + EDGE, ya, za], [0, 1, 0]);
          // 桥面板的侧面和底面
          for (const s of [-1, 1]) {
            quay.quad([x + s * EDGE, ya - 0.9, za], [x + s * EDGE, yb - 0.9, zb], [x + s * EDGE, yb, zb], [x + s * EDGE, ya, za], [s, 0, 0]);
          }
          quay.quad([x - EDGE, ya - 0.9, za], [x - EDGE, yb - 0.9, zb], [x + EDGE, yb - 0.9, zb], [x + EDGE, ya - 0.9, za], [0, -1, 0]);
        }
      } else {
        rect(x - EDGE, RIVER.z0, x + EDGE, RIVER.z1);
        quay.box(x, -0.62, (RIVER.z0 + RIVER.z1) / 2, EDGE * 2, 1.2, RIVER.z1 - RIVER.z0, true);
        // 桥墩
        for (const t of [0.33, 0.67]) quay.box(x, -2.4, RIVER.z0 + (RIVER.z1 - RIVER.z0) * t, EDGE * 2 - 3, 2.6, 2.2);
      }
    }
    // 拱桥桥墩
    {
      const x = avenueX(ARCH_BRIDGE.avenue);
      for (const t of [0.5]) quay.box(x, -1.2, RIVER.z0 + (RIVER.z1 - RIVER.z0) * t, EDGE * 2 - 3, 5.0, 2.6);
    }

    // 驳岸墙
    quay.wall(LAND.west, RIVER.z0, LAND.east, RIVER.z0, -3.4, 0, [0, 0, 1]);
    quay.wall(LAND.west, RIVER.z1, LAND.east, RIVER.z1, -3.4, 0, [0, 0, -1]);
    const zLo = arc[0][1];
    const zHi = arc[arc.length - 1][1];
    quay.wall(LAND.east, LAND.south, LAND.east, zLo, -3.4, 0, [1, 0, 0]);
    quay.wall(LAND.east, zHi, LAND.east, RIVER.z0, -3.4, 0, [1, 0, 0]);
    quay.wall(LAND.east, RIVER.z1, LAND.east, LAND.north, -3.4, 0, [1, 0, 0]);

    this.add(top, this.mats.road, false, true);
    this.add(quay, this.mats.concrete, true, true);

    // 城市范围以外的远景地面：让边缘的街道尽头不是一片空
    const far = new MeshBuilder();
    const y = -0.06;
    const pad = 900;
    far.quad([LAND.west - pad, y, LAND.north + pad], [LAND.west, y, LAND.north + pad], [LAND.west, y, LAND.south - pad], [LAND.west - pad, y, LAND.south - pad], [0, 1, 0]);
    far.quad([LAND.west, y, LAND.south], [LAND.east, y, LAND.south], [LAND.east, y, LAND.south - pad], [LAND.west, y, LAND.south - pad], [0, 1, 0]);
    far.quad([LAND.west, y, LAND.north + pad], [LAND.east, y, LAND.north + pad], [LAND.east, y, LAND.north], [LAND.west, y, LAND.north], [0, 1, 0]);
    this.add(far, this.mats.darkConcrete, false, true);
  }

  private buildSidewalks(): void {
    const b = new MeshBuilder();
    const h = CITY.curb + 0.05;
    const yc = CITY.curb - h / 2;
    for (const blk of this.st.blocks) b.box(blk.x, yc, blk.z, blk.w, h, blk.d);
    for (const s of this.st.strips) b.box((s.x0 + s.x1) / 2, yc, (s.z0 + s.z1) / 2, s.x1 - s.x0, h, s.z1 - s.z0);
    this.add(b, this.mats.sidewalk, false, true);

    // 湖滨公园（抬高的半圆）和外侧步道
    const L = LAKESHORE;
    const park = new MeshBuilder();
    const rim = new MeshBuilder();
    const r = L.radius - HALF_ROAD;
    const xEdge = LAND.east - CITY.sidewalk;
    const am = Math.acos((xEdge - L.cx) / r);
    const arc: [number, number][] = [];
    for (let k = 0; k <= 72; k++) {
      const a = -am + (2 * am * k) / 72;
      arc.push([L.cx + r * Math.cos(a), L.cz + r * Math.sin(a)]);
    }
    park.fan([L.cx + 40, L.cz], [...arc, arc[0]], CITY.curb);
    for (let k = 0; k < arc.length - 1; k++) {
      rim.wall(arc[k][0], arc[k][1], arc[k + 1][0], arc[k + 1][1], -0.02, CITY.curb, [arc[k][0] - L.cx, 0, arc[k][1] - L.cz]);
    }
    this.add(park, this.mats.park, false, true);

    const r0 = L.radius + HALF_ROAD;
    const r1 = r0 + L.promenade;
    const n = 60;
    for (let k = 0; k < n; k++) {
      const a0 = -Math.PI / 2 + (Math.PI * k) / n;
      const a1 = -Math.PI / 2 + (Math.PI * (k + 1)) / n;
      const p = (rr: number, a: number): V3 => [L.cx + rr * Math.cos(a), CITY.curb, L.cz + rr * Math.sin(a)];
      rim.quad(p(r0, a0), p(r1, a0), p(r1, a1), p(r0, a1), [0, 1, 0]);
      const q0 = p(r0, a0);
      const q1 = p(r0, a1);
      rim.wall(q0[0], q0[2], q1[0], q1[2], -0.02, CITY.curb, [-Math.cos(a0), 0, -Math.sin(a0)]);
    }
    this.add(rim, this.mats.concrete, false, true);
  }

  /* ------------------------------ 楼体 ------------------------------ */

  private buildBuildings(): void {
    const fb = new MeshBuilder(true);
    const roof = new MeshBuilder();
    const rnd = seeded(77);

    const volume = (g: Building, cx: number, cz: number, w: number, d: number, y0: number, y1: number, top: number) => {
      const seed = (g.seed % 997) * 0.137;
      const gx = facadeGrid(g.style, d, top);
      const gz = facadeGrid(g.style, w, top);
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
      const ix = [g.style, seed, gx.bay, gx.floorH];
      const iz = [g.style, seed + 3.3, gz.bay, gz.floorH];
      // 只有落地的那一段有店面：哪几家亮灯按位写进顶点属性
      const shops = (face: number, len: number) => (y0 === 0 ? shopMask(g.seed, face, len) : 0);
      fb.wall(x1, z1, x1, z0, y0, y1, [1, 0, 0], ix, [d, top], shops(0, d));
      fb.wall(x0, z0, x0, z1, y0, y1, [-1, 0, 0], ix, [d, top], shops(1, d));
      fb.wall(x0, z1, x1, z1, y0, y1, [0, 0, 1], iz, [w, top], shops(2, w));
      fb.wall(x1, z0, x0, z0, y0, y1, [0, 0, -1], iz, [w, top], shops(3, w));
      roof.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
    };

    const building = (g: Building) => {
      if (g.podium > 0) {
        volume(g, g.x, g.z, g.w, g.d, 0, g.podium, g.podium);
        const tw = g.w - g.setback * 2;
        const td = g.d - g.setback * 2;
        volume(g, g.x, g.z, tw, td, g.podium, g.h, g.h);
        // 高塔再收一层顶冠
        if (g.h > 110) volume(g, g.x, g.z, tw * 0.62, td * 0.62, g.h, g.h + 9, g.h + 9);
        this.roofUnits(roof, rnd, g.x, g.z, tw, td, g.h > 110 ? g.h + 9 : g.h);
      } else {
        volume(g, g.x, g.z, g.w, g.d, 0, g.h, g.h);
        this.roofUnits(roof, rnd, g.x, g.z, g.w, g.d, g.h);
      }
    };

    for (const blk of this.st.blocks) for (const g of blk.buildings) building(g);

    // 城市范围外的远景楼群：只为了让街道尽头和天际线不空
    const far = seeded(4242);
    for (let k = 0; k < 110; k++) {
      const sideIdx = Math.floor(far() * 3);
      const t = far();
      const depth = 60 + far() * 420;
      let x = 0;
      let z = 0;
      if (sideIdx === 0) {
        x = LAND.west - depth;
        z = LAND.south - 200 + t * (LAND.north - LAND.south + 400);
      } else if (sideIdx === 1) {
        x = LAND.west - 200 + t * (LAND.east - LAND.west + 200);
        z = LAND.south - depth;
      } else {
        x = LAND.west - 200 + t * (LAND.east - LAND.west + 200);
        z = LAND.north + depth;
      }
      const w = 30 + far() * 50;
      const d = 30 + far() * 50;
      const h = 25 + Math.pow(far(), 1.6) * 170;
      building({ x, z, w, d, h: Math.round(h / 3.6) * 3.6, podium: 0, setback: 0, style: Math.floor(far() * 4), seed: Math.floor(far() * 1e6) });
    }

    this.add(fb, this.mats.facade, true, true);
    this.add(roof, this.mats.roof, true, true);
  }

  /** 屋顶上的机房、水箱 */
  private roofUnits(roof: MeshBuilder, rnd: () => number, cx: number, cz: number, w: number, d: number, y: number): void {
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const sx = 3 + rnd() * Math.min(9, w * 0.3);
      const sz = 3 + rnd() * Math.min(9, d * 0.3);
      const sy = 1.6 + rnd() * 3.2;
      const px = cx + (rnd() - 0.5) * Math.max(0, w - sx - 4);
      const pz = cz + (rnd() - 0.5) * Math.max(0, d - sz - 4);
      roof.box(px, y + sy / 2, pz, sx, sy, sz);
    }
  }

  private buildWater(): void {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000), this.mats.water);
    m.rotation.x = -Math.PI / 2;
    m.position.set(200, -1.7, 0);
    m.receiveShadow = true;
    m.frustumCulled = false;
    this.group.add(m);
  }

  /* ------------------------------ 桥 ------------------------------ */

  private buildBridges(): void {
    const red = new MeshBuilder();
    const dark = new MeshBuilder();
    const rail = new MeshBuilder();
    const z0 = RIVER.z0;
    const z1 = RIVER.z1;

    /** 下承式钢桁架：两侧各一片华伦桁架，顶上用横梁和斜撑连起来，车从中间穿过去 */
    const strips = new MeshBuilder();
    const truss = (b: MeshBuilder, xc: number, heightTop: number) => {
      const n = 10;
      const zs: number[] = [];
      for (let k = 0; k <= n; k++) zs.push(z0 + ((z1 - z0) * k) / n);
      const topPts: THREE.Vector3[][] = [];
      for (const s of [-1, 1]) {
        const x = xc + s * (EDGE - 0.4);
        const lo = zs.map((z) => v3(x, roadHeight(xc, z) + 0.35, z));
        // 上弦两端低、中间高
        const hi = zs.map((z, k) => v3(x, roadHeight(xc, z) + heightTop * (0.62 + 0.38 * Math.sin((Math.PI * k) / n)), z));
        for (let k = 0; k < n; k++) b.beam(lo[k], lo[k + 1], 0.5, 0.7);
        for (let k = 1; k < n - 1; k++) {
          b.beam(hi[k], hi[k + 1], 0.5, 0.55);
          // 上弦内侧一条灯带：入夜后勾出桥的轮廓
          const off = v3(-s * 0.3, -0.2, 0);
          strips.beam(hi[k].clone().add(off), hi[k + 1].clone().add(off), 0.07, 0.1);
        }
        b.beam(lo[0], hi[1], 0.5, 0.55);
        b.beam(hi[n - 1], lo[n], 0.5, 0.55);
        for (let k = 1; k < n; k++) b.beam(lo[k], hi[k], 0.28, 0.32);
        for (let k = 1; k < n - 1; k++) {
          if (k % 2 === 1) b.beam(lo[k], hi[k + 1], 0.24, 0.28);
          else b.beam(hi[k], lo[k + 1], 0.24, 0.28);
        }
        topPts.push(hi);
      }
      // 顶部横向联结
      const [A, B] = topPts;
      for (let k = 1; k < n; k++) {
        b.beam(A[k], B[k], 0.3, 0.4);
        // 每隔一道横梁吊一盏灯，照亮桥面
        if (k % 2 === 0 || k === 1 || k === n - 1) {
          const y = (A[k].y + B[k].y) / 2 - 0.35;
          strips.box(xc, y, A[k].z, 1.5, 0.12, 0.4, true);
          this.light(xc, y, A[k].z, LAMP_WARM, 2.3, 26, 1, roadHeight(xc, A[k].z));
        }
        if (k < n - 1) {
          if (k % 2 === 1) b.beam(A[k], B[k + 1], 0.16, 0.18);
          else b.beam(B[k], A[k + 1], 0.16, 0.18);
        }
      }
    };
    truss(red, avenueX(ARCH_BRIDGE.avenue), 8.2);
    truss(dark, avenueX(FLAT_BRIDGE.avenue), 7.4);

    // 其余的桥：只做两侧的简单栏杆
    for (let i = 0; i < CITY.ni; i++) {
      if (i === ARCH_BRIDGE.avenue || i === FLAT_BRIDGE.avenue) continue;
      for (const s of [-1, 1]) {
        const x = avenueX(i) + s * (EDGE - 0.3);
        rail.beam(v3(x, 1.05, z0), v3(x, 1.05, z1), 0.1, 0.1);
        rail.beam(v3(x, 0.55, z0), v3(x, 0.55, z1), 0.06, 0.06);
        for (let z = z0; z <= z1; z += 4.25) rail.beam(v3(x, 0, z), v3(x, 1.05, z), 0.1, 0.1);
      }
    }
    this.add(red, this.mats.steelRed);
    this.add(dark, this.mats.steelDark);
    this.add(rail, this.mats.rail);
    this.add(strips, this.glow([0.4, 0.38, 0.34], [3.0, 2.2, 1.3]), false, false);
  }

  /* ------------------------------ 高架铁路 ------------------------------ */

  private buildElevated(): void {
    const b = new MeshBuilder();
    const deck = new MeshBuilder();
    const x = avenueX(ELEVATED.avenue);
    const H = ELEVATED.height;
    const zStart = streetZ(ELEVATED.j0) - 22;
    const zEnd = streetZ(ELEVATED.j1) + 22;

    // 立柱 + 每对立柱上的横梁
    const seen = new Set<number>();
    for (const c of this.st.elevatedColumns) {
      b.box(c.x, c.height / 2, c.z, c.size, c.height, c.size);
      // 柱脚
      b.box(c.x, 0.3, c.z, c.size + 0.5, 0.6, c.size + 0.5);
      if (!seen.has(c.z)) {
        seen.add(c.z);
        b.beam(v3(x - HALF_ROAD - 1.7, H - 0.5, c.z), v3(x + HALF_ROAD + 1.7, H - 0.5, c.z), 0.55, 1.0);
        // 柱顶斜撑
        for (const s of [-1, 1]) b.beam(v3(x + s * (HALF_ROAD + 1.3), H - 2.4, c.z), v3(x + s * (HALF_ROAD - 1.4), H - 0.6, c.z), 0.22, 0.26);
      }
    }
    // 路口处没有立柱，用加高的纵梁跨过去。中间两根是实心的钢梁；
    // 外侧两根是桁架（上下两根弦杆，中间竖杆和斜杆）——从街上侧着看，高架的轮廓是镂空的
    for (const off of [-1.6, 1.6]) {
      b.beam(v3(x + off, H + 0.55, zStart), v3(x + off, H + 0.55, zEnd), 0.4, 1.1);
    }
    for (const off of [-4.6, 4.6]) {
      b.beam(v3(x + off, H + 1.0, zStart), v3(x + off, H + 1.0, zEnd), 0.34, 0.2);
      b.beam(v3(x + off, H + 0.08, zStart), v3(x + off, H + 0.08, zEnd), 0.34, 0.2);
      let k = 0;
      for (let z = zStart; z < zEnd - 0.1; z += 2.2, k++) {
        const z1 = Math.min(z + 2.2, zEnd);
        b.beam(v3(x + off, H + 0.08, z), v3(x + off, H + 1.0, z), 0.12, 0.12);
        b.beam(v3(x + off, k % 2 ? H + 0.08 : H + 1.0, z), v3(x + off, k % 2 ? H + 1.0 : H + 0.08, z1), 0.1, 0.1);
      }
    }
    // 轨道不是一整块板：一根根枕木架在纵梁上，中间是空的。
    // 白天阳光从枕木缝里漏下来，在路面上打出一道道光斑；从桥下抬头能看到天
    const ties = new MeshBuilder();
    for (let z = zStart + 0.3; z < zEnd; z += 0.62) ties.box(x, H + 1.3, z, 7.9, 0.2, 0.26, true);
    this.add(ties, this.mats.wood);
    // 两侧的检修走道（实心）和栏杆
    for (const s of [-1, 1]) deck.box(x + s * 4.65, H + 1.25, (zStart + zEnd) / 2, 1.3, 0.3, zEnd - zStart, true);
    for (const s of [-1, 1]) {
      b.beam(v3(x + s * 5.2, H + 2.5, zStart), v3(x + s * 5.2, H + 2.5, zEnd), 0.08, 0.08);
      b.beam(v3(x + s * 5.2, H + 1.9, zStart), v3(x + s * 5.2, H + 1.9, zEnd), 0.05, 0.05);
      for (let z = zStart; z <= zEnd; z += 3.4) b.beam(v3(x + s * 5.2, H + 1.4, z), v3(x + s * 5.2, H + 2.5, z), 0.07, 0.07);
    }
    // 钢轨
    for (const off of [-3.3, -1.85, 1.85, 3.3]) b.beam(v3(x + off, H + 1.5, zStart), v3(x + off, H + 1.5, zEnd), 0.08, 0.16);

    // 横梁下面吊着的钠灯：高架把路灯的位置占了，桥下靠它们照明。左右交错着装，一盏一片光斑
    const tubes = new MeshBuilder();
    let side = 1;
    for (const z of seen) {
      side = -side;
      tubes.box(x + side * 3.4, H - 1.08, z, 0.55, 0.14, 0.34, true);
      this.light(x + side * 3.4, H - 1.15, z, LAMP_SODIUM, 2.3, 19);
      this.glowSpots.push({ x: x + side * 3.4, y: H - 1.2, z, color: LAMP_SODIUM, size: 2.4, cone: 4.2 });
    }
    this.add(tubes, this.glow([0.4, 0.38, 0.34], [8.0, 4.6, 1.5]), false, false);
    this.covers.push({ x0: x - 5.3, x1: x + 5.3, z0: zStart, z1: zEnd, visibility: 0.6 });

    this.add(b, this.mats.steelDark);
    this.add(deck, this.mats.darkConcrete);

    // 一列停在高架上的列车
    const train = new MeshBuilder();
    const win = new MeshBuilder();
    const tz = streetZ(2) + 30;
    for (let k = 0; k < 4; k++) {
      const cz = tz + k * 15.2;
      train.box(x - 2.55, H + 3.3, cz, 2.9, 3.4, 14.4, true);
      for (const s of [-1, 1]) win.box(x - 2.55 + s * 1.46, H + 3.75, cz, 0.04, 1.0, 12.6);
    }
    this.add(train, this.mats.train);
    this.add(win, this.mats.trainWindow, false, false);
  }

  /* ------------------------------ 下层街道 ------------------------------ */

  private buildLowerLevel(): void {
    const b = new MeshBuilder();
    const lamps = new MeshBuilder();
    const z = streetZ(LOWER_LEVEL.street);
    const x0 = avenueX(LOWER_LEVEL.i0) + 14;
    const x1 = avenueX(LOWER_LEVEL.i1) - 14;
    const H = LOWER_LEVEL.clearance;

    // 顶板（上面是另一层路面）和两侧的护墙
    b.box((x0 + x1) / 2, H + 0.6, z, x1 - x0, 1.2, EDGE * 2, true);
    for (const s of [-1, 1]) b.box((x0 + x1) / 2, H + 1.75, z + s * (EDGE - 0.2), x1 - x0, 1.1, 0.4);
    // 立柱和横梁
    const seen = new Set<number>();
    for (const c of this.st.lowerColumns) {
      b.box(c.x, c.height / 2, c.z, c.size, c.height, c.size);
      if (!seen.has(c.x)) {
        seen.add(c.x);
        b.box(c.x, H - 0.45, z, 1.0, 0.9, EDGE * 2 - 0.4, true);
      }
    }
    // 两个洞口的门楣
    for (const x of [x0, x1]) b.box(x, H - 0.3, z, 1.4, 1.5, EDGE * 2, true);
    // 顶灯：两排灯带
    for (let x = x0 + 5.5; x < x1; x += 11) {
      for (const s of [-1, 1]) {
        lamps.box(x, H - 0.07, z + s * 4.2, 3.2, 0.1, 0.34, true);
        this.light(x, H - 0.15, z + s * 4.2, LAMP_SODIUM, 2.2, 17);
        this.glowSpots.push({ x, y: H - 0.2, z: z + s * 4.2, color: LAMP_SODIUM, size: 2.0, cone: 0 });
      }
    }
    this.covers.push({ x0, x1, z0: z - EDGE, z1: z + EDGE, visibility: 0.4 });
    this.add(b, this.mats.darkConcrete);
    this.add(lamps, this.mats.tunnelLamp, false, false);
  }

  /* ------------------------------ 栏杆、矮墙、护栏 ------------------------------ */

  private buildRailings(): void {
    const rail = new MeshBuilder();
    const wall = new MeshBuilder();
    const dir = new THREE.Vector3();
    for (const w of this.st.walls) {
      dir.set(Math.sin(w.yaw) * Math.cos(w.pitch), Math.sin(w.pitch), Math.cos(w.yaw) * Math.cos(w.pitch));
      const a = v3(w.x, w.y, w.z).addScaledVector(dir, -w.length / 2);
      const c = v3(w.x, w.y, w.z).addScaledVector(dir, w.length / 2);
      if (w.kind === 'rail') {
        rail.beam(a.clone().setY(a.y + 1.1), c.clone().setY(c.y + 1.1), 0.1, 0.1);
        rail.beam(a.clone().setY(a.y + 0.6), c.clone().setY(c.y + 0.6), 0.05, 0.05);
        rail.beam(a, a.clone().setY(a.y + 1.1), 0.1, 0.1);
      } else if (w.kind === 'wall') {
        wall.beam(a.clone().setY(a.y + 0.45), c.clone().setY(c.y + 0.45), 0.45, 0.9);
      }
    }
    this.add(rail, this.mats.rail);
    this.add(wall, this.mats.concrete);
  }

  /**
   * 路口的护栏。直道经过的路口，两边的岔路各一道红白护栏；
   * 弯道路口不一样：正对着来车的那一道上面立一排 LED 箭头屏，箭头指着出弯的方向、亮光一格一格地往那边追，
   * 隔着一整条街就能看出该往哪边拐；不该拐过去的那一侧立的是红叉屏。
   */
  private buildBarriers(): void {
    const b = new MeshBuilder();
    const post = new MeshBuilder();
    const warn = new MeshBuilder();
    const led = new MeshBuilder();
    for (const bar of this.st.barriers) {
      const n = Math.round(bar.length / 2.5);
      const seg = bar.length / n;
      for (let k = 0; k < n; k++) {
        const t = -bar.length / 2 + seg * (k + 0.5);
        const x = bar.x + (bar.alongX ? t : 0);
        const z = bar.z + (bar.alongX ? 0 : t);
        const sx = bar.alongX ? seg - 0.1 : 0.62;
        const sz = bar.alongX ? 0.62 : seg - 0.1;
        // 水泥墩
        b.box(x, 0.42, z, sx, 0.84, sz);
        if (bar.kind !== 'side') continue;
        // 上面一条警示板
        b.box(x, 1.45, z, bar.alongX ? seg - 0.1 : 0.08, 0.55, bar.alongX ? 0.08 : seg - 0.1);
        post.box(x, 1.0, z, 0.08, 0.5, 0.08);
        if (k % 2 === 0) warn.box(x, 1.8, z, 0.16, 0.16, 0.16, true);
      }
      if (bar.kind === 'side') continue;

      /* ---- 弯道路口：水泥墩上面立一面 LED 屏 ---- */
      const arrow = bar.kind === 'ahead';
      const cellW = arrow ? LED_CELL.aw : LED_CELL.cw;
      const cells = Math.floor((bar.length - 0.5) / cellW);
      const half = (cells * cellW) / 2;
      const y0 = 1.02;
      const y1 = y0 + (arrow ? LED_CELL.ah : LED_CELL.ch);
      // 沿着屏的方向：箭头屏朝着出弯的那一头，红叉屏随便
      const ux = arrow ? bar.tx : bar.alongX ? 1 : 0;
      const uz = arrow ? bar.tz : bar.alongX ? 0 : 1;
      const at = (t: number, y: number, out = 0): V3 => [bar.x + ux * t + bar.nx * out, y, bar.z + uz * t + bar.nz * out];
      // 屏面：朝着路口，比箱体靠前一点
      led.quad(at(-half, y0, 0.14), at(half, y0, 0.14), at(half, y1, 0.14), at(-half, y1, 0.14), [bar.nx, 0, bar.nz], arrow ? [0, 0, cells, 1] : [0, 2, cells, 3]);
      // 屏后面的箱体和边框
      const along = half * 2 + 0.16;
      post.box(bar.x, (y0 + y1) / 2, bar.z, Math.abs(ux) * along + Math.abs(bar.nx) * 0.24, y1 - y0 + 0.16, Math.abs(uz) * along + Math.abs(bar.nz) * 0.24, true);
      for (let k = 0; k <= cells; k++) {
        const t = -half + k * cellW;
        const [px, , pz] = at(t, 0);
        // 立在水泥墩上的腿
        post.box(px, 0.93, pz, 0.12, 0.2, 0.12);
        // 背后的斜撑（从路上看不到，镜头绕到后面时不至于是一块悬空的板）
        if (k % 2 === 0) post.beam(v3(...at(t, y1 - 0.3, -0.12)), v3(...at(t, 0.05, -1.7)), 0.09, 0.09);
        // 屏顶上一排警示灯
        if (arrow && k % 2 === 0) warn.box(px, y1 + 0.19, pz, 0.16, 0.16, 0.16, true);
      }
      if (arrow) {
        // 箭头屏上方再架一块大箭头：隔着两个街区、前面有车挡着的时候，先看到的是它
        const bh = LED_CELL.bw / 2;
        const b0 = y1 + 0.95;
        const b1 = b0 + LED_CELL.bh;
        led.quad(at(-bh, b0, 0.17), at(bh, b0, 0.17), at(bh, b1, 0.17), at(-bh, b1, 0.17), [bar.nx, 0, bar.nz], [0, 4, 1, 5]);
        post.box(bar.x, (b0 + b1) / 2, bar.z, Math.abs(ux) * (LED_CELL.bw + 0.2) + Math.abs(bar.nx) * 0.3, b1 - b0 + 0.2, Math.abs(uz) * (LED_CELL.bw + 0.2) + Math.abs(bar.nz) * 0.3, true);
        // 两根立柱立在护栏后面，中间拉两道斜撑
        for (const s of [-1, 1]) {
          const [qx, , qz] = at(s * (bh - 1.5), 0, -0.36);
          post.box(qx, (b1 + 0.1) / 2, qz, 0.26, b1 + 0.1, 0.26);
        }
        post.beam(v3(...at(-(bh - 1.5), y1 + 0.2, -0.36)), v3(...at(bh - 1.5, b0 - 0.1, -0.36)), 0.08, 0.08);
        post.beam(v3(...at(bh - 1.5, y1 + 0.2, -0.36)), v3(...at(-(bh - 1.5), b0 - 0.1, -0.36)), 0.08, 0.08);
      }
      // 屏照在地上的光：箭头屏是琥珀色，红叉屏是红色
      const glow: [number, number, number] = arrow ? [1.0, 0.56, 0.1] : [1.0, 0.1, 0.05];
      for (const t of [-half * 0.66, 0, half * 0.66]) {
        const [gx, , gz] = at(t, 0, 2.6);
        this.light(gx, 2.4, gz, glow, arrow ? 0.85 : 0.4, arrow ? 17 : 11, 2);
      }
    }
    this.add(b, this.mats.barrier);
    this.add(post, this.mats.metal);
    this.add(led, this.mats.led, false, false);
    // 警示灯：琥珀色，一明一暗地闪，夜里远远就能看到哪些路口封了
    const warnMat = new THREE.MeshBasicNodeMaterial();
    {
      const phase: N = fract(sin(positionWorld.x.mul(0.37).add(positionWorld.z.mul(0.53))).mul(43758.5));
      const blink: N = step(fract(time.mul(1.1).add(phase)), 0.5);
      warnMat.colorNode = mix(vec3(0.35, 0.2, 0.03), vec3(6.0, 2.6, 0.2), blink.mul(smoothstep(0.1, 0.5, cityUniforms.lights)).add(0.02));
    }
    this.add(warn, warnMat, false, false);
  }

  /* ------------------------------ 路灯、红绿灯 ------------------------------ */

  private buildStreetFurniture(): void {
    const poles = new MeshBuilder();
    const heads = new MeshBuilder();
    const red = new MeshBuilder();
    const green = new MeshBuilder();
    const rnd = seeded(909);

    /** 一盏路灯：立在人行道上，灯臂伸向路面。(dx, dz) 是指向路中心的单位方向 */
    const lamp = (x: number, z: number, dx: number, dz: number) => {
      poles.box(x, 4.3, z, 0.16, 8.6, 0.16);
      poles.box(x, 0.35, z, 0.34, 0.7, 0.34);
      poles.beam(v3(x, 8.5, z), v3(x + dx * 2.4, 8.75, z + dz * 2.4), 0.1, 0.1);
      heads.box(x + dx * 2.5, 8.66, z + dz * 2.5, dx !== 0 ? 1.0 : 0.42, 0.12, dz !== 0 ? 1.0 : 0.42, true);
      this.light(x + dx * 2.5, 8.6, z + dz * 2.5, LAMP_WARM, 3.0, 28);
      this.glowSpots.push({ x: x + dx * 2.5, y: 8.55, z: z + dz * 2.5, color: LAMP_WARM, size: 3.0, cone: 5.5 });
    };

    const off = HALF_ROAD + 0.9;

    // 大道（沿 Z）：两侧交错
    for (let i = 0; i < CITY.ni; i++) {
      const x = avenueX(i);
      for (let j = -1; j < CITY.nj; j++) {
        if (j === CITY.riverRow) continue;
        const zBase = j === -1 ? streetZ(0) - CITY.pitch : streetZ(j);
        for (const [t, s] of [[27.5, 1], [55, -1], [82.5, 1]] as const) {
          const z = zBase + t;
          if (underElevated(x, z)) continue;
          // 最东一条大道的东侧是公园或湖，那一侧不立灯
          if (i === CITY.ni - 1 && s === 1) continue;
          lamp(x + s * off, z, -s, 0);
        }
      }
    }
    // 街（沿 X）
    for (let j = 0; j < CITY.nj; j++) {
      const z = streetZ(j);
      for (let i = -1; i < CITY.ni - 1; i++) {
        const xBase = i === -1 ? avenueX(0) - CITY.pitch : avenueX(i);
        for (const [t, s] of [[27.5, -1], [55, 1], [82.5, -1]] as const) {
          const x = xBase + t;
          if (underDeck(x, z)) continue;
          // 河岸那一侧不立灯（有栏杆）
          if ((j === CITY.riverRow && s === 1) || (j === CITY.riverRow + 1 && s === -1)) continue;
          lamp(x, z + s * off, 0, -s);
        }
      }
    }
    // 湖滨大道：沿外侧步道一圈
    {
      const L = LAKESHORE;
      const r = L.radius + HALF_ROAD + 1.0;
      const n = 22;
      for (let k = 0; k <= n; k++) {
        const a = Math.PI / 2 - (Math.PI * k) / n;
        const x = L.cx + r * Math.cos(a);
        const z = L.cz + r * Math.sin(a);
        poles.box(x, 4.3, z, 0.16, 8.6, 0.16);
        poles.beam(v3(x, 8.5, z), v3(x - Math.cos(a) * 2.4, 8.75, z - Math.sin(a) * 2.4), 0.1, 0.1);
        heads.box(x - Math.cos(a) * 2.5, 8.66, z - Math.sin(a) * 2.5, 0.7, 0.12, 0.7, true);
        this.light(x - Math.cos(a) * 2.5, 8.6, z - Math.sin(a) * 2.5, LAMP_WARM, 3.0, 28);
        this.glowSpots.push({ x: x - Math.cos(a) * 2.5, y: 8.55, z: z - Math.sin(a) * 2.5, color: LAMP_WARM, size: 3.0, cone: 5.5 });
      }
    }

    // 红绿灯：每个路口两个对角各立一根，带两条横臂
    for (let i = 0; i < CITY.ni; i++) {
      for (let j = 0; j < CITY.nj; j++) {
        const cx = avenueX(i);
        const cz = streetZ(j);
        if (underElevated(cx, cz) || underDeck(cx, cz)) continue;
        for (const [sx, sz] of [[1, 1], [-1, -1]] as const) {
          const px = cx + sx * (HALF_ROAD + 0.8);
          const pz = cz + sz * (HALF_ROAD + 0.8);
          poles.box(px, 3.3, pz, 0.2, 6.6, 0.2);
          // 横臂伸到路面上方
          poles.beam(v3(px, 6.3, pz), v3(px - sx * 6.5, 6.3, pz), 0.12, 0.12);
          poles.beam(v3(px, 6.3, pz), v3(px, 6.3, pz - sz * 6.5), 0.12, 0.12);
          for (const [hx, hz] of [[px - sx * 5.6, pz], [px, pz - sz * 5.6]] as const) {
            poles.box(hx, 5.65, hz, 0.36, 1.1, 0.36, true);
            const lit = rnd() < 0.5 ? red : green;
            const yy = lit === red ? 5.98 : 5.32;
            lit.box(hx, yy, hz, 0.4, 0.24, 0.4, true);
            this.glowSpots.push({ x: hx, y: yy, z: hz, color: lit === red ? [1.0, 0.1, 0.06] : [0.1, 1.0, 0.4], size: 1.3, cone: 0 });
          }
        }
      }
    }

    // 路口正上方的灯。路灯都立在街区中段，十字路口反而是整条街最黑的地方：
    // 普通路口在两根信号灯杆之间拉一根钢索、中间吊一盏；高架下面的路口把灯装在纵梁底下
    for (let i = 0; i < CITY.ni; i++) {
      for (let j = 0; j < CITY.nj; j++) {
        const cx = avenueX(i);
        const cz = streetZ(j);
        if (underDeck(cx, cz)) continue;
        if (underElevated(cx, cz)) {
          const y = ELEVATED.height - 0.1;
          for (const s of [-1, 1]) {
            heads.box(cx + s * 3.1, y, cz, 0.6, 0.14, 0.4, true);
            this.light(cx + s * 3.1, y - 0.1, cz, LAMP_SODIUM, 2.6, 22);
            this.glowSpots.push({ x: cx + s * 3.1, y: y - 0.15, z: cz, color: LAMP_SODIUM, size: 2.4, cone: 4.6 });
          }
          continue;
        }
        const reach = HALF_ROAD + 0.8;
        poles.beam(v3(cx + reach, 6.58, cz + reach), v3(cx - reach, 6.58, cz - reach), 0.035, 0.035);
        poles.box(cx, 6.42, cz, 0.05, 0.3, 0.05);
        heads.box(cx, 6.24, cz, 0.62, 0.16, 0.62, true);
        this.light(cx, 6.15, cz, LAMP_WARM, 3.3, 27);
        this.glowSpots.push({ x: cx, y: 6.1, z: cz, color: LAMP_WARM, size: 2.8, cone: 5.2 });
      }
    }

    this.add(poles, this.mats.metal, true, true, true);
    this.add(heads, this.mats.lamp, false, false);
    this.add(red, this.mats.signalRed, false, false);
    this.add(green, this.mats.signalGreen, false, false);
  }

  /* ------------------------------ 招牌 ------------------------------ */

  /**
   * 挂在楼上的招牌：竖招牌（从墙面挑出来）、门头横幅、矮楼楼顶的广告牌。
   * 赛道沿线挂得密，其余街道稀疏一些。白天是印着字的灯箱，入夜后点亮。
   */
  private buildSigns(): void {
    const atlas = createSignAtlas();
    const panels = new MeshBuilder();
    const frames = new MeshBuilder();
    const rnd = seeded(5150);
    const bw = BLOCK - CITY.sidewalk * 2;
    const samples = this.track.samples;
    const trackDist = (x: number, z: number) => {
      let best = Infinity;
      for (let k = 0; k < samples.length; k += 5) {
        const p = samples[k].pos;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    const pick = (cells: SignCell[]) => cells[Math.floor(rnd() * cells.length)];

    /** 一块朝 (nx, nz) 的面板，中心在 (cx, cy, cz) */
    const panel = (cx: number, cy: number, cz: number, nx: number, nz: number, w: number, h: number, c: SignCell) => {
      const rx = nz * (w / 2);
      const rz = -nx * (w / 2);
      const hh = h / 2;
      panels.quad(
        [cx - rx, cy - hh, cz - rz],
        [cx + rx, cy - hh, cz + rz],
        [cx + rx, cy + hh, cz + rz],
        [cx - rx, cy + hh, cz - rz],
        [nx, 0, nz],
        [c.u0, c.v0, c.u1, c.v1],
      );
    };
    /** 面板背后的箱体，厚度沿 (nx, nz) */
    const casing = (cx: number, cy: number, cz: number, nx: number, nz: number, w: number, h: number, t: number) => {
      frames.box(cx, cy, cz, Math.abs(nx) * t + Math.abs(nz) * w, h, Math.abs(nz) * t + Math.abs(nx) * w, true);
    };

    const face = (g: Building, x0: number, z0: number, x1: number, z1: number, nx: number, nz: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      const near = trackDist(mx + nx * 12, mz + nz * 12) < 24;
      // 底层店面透出来的光：亮着灯的店各一小片，烤进地面光照图。
      // 哪家亮和立面着色器问的是同一个函数，所以橱窗亮着的店门口地上才有光
      const faceIdx = nx > 0 ? 0 : nx < 0 ? 1 : nz > 0 ? 2 : 3;
      // 东墙和南墙的墙面坐标是反着走的（见 buildBuildings 里四面墙的起点）
      const reversed = faceIdx === 0 || faceIdx === 3;
      for (let k = 0; (k + 0.5) * SHOP_BAY < len; k++) {
        const hue = rnd();
        if (!shopLit(g.seed, faceIdx, k)) continue;
        const along = (k + 0.5) * SHOP_BAY;
        const t = (reversed ? len - along : along) / len;
        const color: [number, number, number] = hue < 0.5 ? [1.0, 0.8, 0.56] : [0.8, 0.9, 1.0];
        this.light(x0 + (x1 - x0) * t + nx * 1.6, 2.4, z0 + (z1 - z0) * t + nz * 1.6, color, 0.5, 9, 0);
      }
      if (!near && rnd() > 0.3) return;
      const wallTop = g.podium > 0 ? g.podium : g.h;
      const covered = underDeck(mx + nx * 8, mz + nz * 8);
      const tight = underElevated(mx + nx * 8, mz + nz * 8);
      const tx = nz;
      const tz = -nx;
      const slots = Math.max(1, Math.floor(len / (near ? 15 : 30)));

      for (let s = 0; s < slots; s++) {
        const t = (s + 0.3 + rnd() * 0.4) / slots;
        const px = x0 + (x1 - x0) * t;
        const pz = z0 + (z1 - z0) * t;
        const kind = rnd();
        if (kind < 0.45) {
          // 竖招牌
          let h = 4.5 + rnd() * 4.5;
          if (tight) h = Math.min(h, 5.2);
          const w = h / 4;
          const y0 = (covered ? 9.6 : 6.4) + rnd() * 4;
          if (y0 + h > wallTop - 0.4) continue;
          const gap = 0.4;
          const cx = px + nx * (gap + w / 2);
          const cz = pz + nz * (gap + w / 2);
          const cy = y0 + h / 2;
          casing(cx, cy, cz, tx, tz, w + 0.16, h + 0.16, 0.2);
          const cell = pick(atlas.tall);
          panel(cx + tx * 0.105, cy, cz + tz * 0.105, tx, tz, w, h, cell);
          panel(cx - tx * 0.105, cy, cz - tz * 0.105, -tx, -tz, w, h, cell);
          this.light(cx + nx * 1.5, cy, cz + nz * 1.5, cell.color, 0.2 + h * 0.022, 13, 2);
          for (const k of [-0.36, 0.36]) {
            frames.beam(v3(px, cy + h * k, pz), v3(px + nx * (gap + 0.05), cy + h * k, pz + nz * (gap + 0.05)), 0.09, 0.09);
          }
        } else if (kind < 0.88) {
          // 门头横幅
          if (covered) continue;
          const w = Math.min(len / slots - 1.5, 5 + rnd() * 4.5);
          if (w < 3.5) continue;
          const h = w / 3;
          const cy = 5.4 + h / 2 + rnd() * 2.2;
          if (cy + h / 2 > wallTop - 0.3) continue;
          casing(px + nx * 0.15, cy, pz + nz * 0.15, nx, nz, w + 0.14, h + 0.14, 0.3);
          const cell = pick(atlas.wide);
          panel(px + nx * 0.31, cy, pz + nz * 0.31, nx, nz, w, h, cell);
          this.light(px + nx * 2.5, cy, pz + nz * 2.5, cell.color, 0.18 + w * 0.026, 14, 2);
        }
      }

      // 矮楼楼顶的大广告牌
      if (near && wallTop <= 45 && len > 18 && rnd() < 0.4) {
        const w = Math.min(len - 6, 10 + rnd() * 5);
        const h = w / 3;
        const t = 0.35 + rnd() * 0.3;
        const px = x0 + (x1 - x0) * t - nx * 0.9;
        const pz = z0 + (z1 - z0) * t - nz * 0.9;
        const y0 = wallTop + 1.3;
        const cy = y0 + h / 2;
        casing(px - nx * 0.16, cy, pz - nz * 0.16, nx, nz, w + 0.2, h + 0.2, 0.3);
        const cell = pick(atlas.wide);
        panel(px, cy, pz, nx, nz, w, h, cell);
        this.light(px + nx * 5, Math.min(cy, 26), pz + nz * 5, cell.color, 0.45, 24, 2);
        for (const k of [-0.42, 0, 0.42]) {
          const lx = px + tx * w * k - nx * 0.2;
          const lz = pz + tz * w * k - nz * 0.2;
          frames.beam(v3(lx, wallTop, lz), v3(lx, y0, lz), 0.16, 0.16);
          frames.beam(v3(lx - nx * 0.15, y0 + h * 0.8, lz - nz * 0.15), v3(lx - nx * 3.0, wallTop, lz - nz * 3.0), 0.12, 0.12);
        }
      }
    };

    const eps = 0.05;
    for (const blk of this.st.blocks) {
      // 这个街区四个方向上有没有路
      const roadE = blk.i + 1 <= CITY.ni - 1;
      const roadW = blk.i >= 0;
      const roadN = blk.j + 1 <= CITY.nj - 1;
      const roadS = blk.j >= 0;
      for (const g of blk.buildings) {
        const gx0 = g.x - g.w / 2, gx1 = g.x + g.w / 2;
        const gz0 = g.z - g.d / 2, gz1 = g.z + g.d / 2;
        if (roadE && Math.abs(gx1 - (blk.x + bw / 2)) < eps) face(g, gx1, gz0, gx1, gz1, 1, 0);
        if (roadW && Math.abs(gx0 - (blk.x - bw / 2)) < eps) face(g, gx0, gz0, gx0, gz1, -1, 0);
        if (roadN && Math.abs(gz1 - (blk.z + bw / 2)) < eps) face(g, gx0, gz1, gx1, gz1, 0, 1);
        if (roadS && Math.abs(gz0 - (blk.z - bw / 2)) < eps) face(g, gx0, gz0, gx1, gz0, 0, -1);
      }
    }

    this.add(panels, createSignMaterial(atlas.texture), true, false);
    this.add(frames, this.mats.metal);
  }

  /* ------------------------------ 楼体上的小构件 ------------------------------ */

  /** 离赛道中心线多远（粗略：每 10 米取一个点） */
  private trackDistance(x: number, z: number): number {
    const samples = this.track.samples;
    let best = Infinity;
    for (let k = 0; k < samples.length; k += 5) {
      const p = samples[k].pos;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /**
   * 檐口、防火梯、雨棚、屋顶水箱、天线：让楼不再是光溜溜的方盒子。
   * 防火梯只装在砖楼临街的那一面，赛道沿线装得多一些。
   */
  private buildFacadeDetails(): void {
    const steel = new MeshBuilder();
    const wood = new MeshBuilder();
    const trim = new MeshBuilder();
    const awnings = new MeshBuilder();
    const beacons = new MeshBuilder();
    const props = new StreetProps();
    const rnd = seeded(8128);
    // 街边杂物用自己的一串随机数：不打乱雨棚、防火梯原来的位置
    const propRnd = seeded(4242);
    const bw = BLOCK - CITY.sidewalk * 2;
    const eps = 0.05;

    const face = (g: Building, f: WallFace, faceIdx: number) => {
      const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
      const mx = (f.x0 + f.x1) / 2;
      const mz = (f.z0 + f.z1) / 2;
      const near = this.trackDistance(mx + f.nx * 12, mz + f.nz * 12) < 26;
      const reversed = faceIdx === 0 || faceIdx === 3;
      // 雨棚：大约三分之一的店有
      for (let k = 0; (k + 1) * SHOP_BAY <= len; k++) {
        if (rnd() < 0.34) addAwning(awnings, f, k, Math.floor(rnd() * 6), reversed);
      }
      // 墙根的杂物、落水管、窗式空调
      const wallTop = g.podium > 0 ? g.podium : g.h;
      props.alongWall(f, propRnd, near, g.style === 1 || g.style === 2, Math.min(wallTop, 60), facadeGrid(g.style, len, wallTop));
      // 防火梯
      if (g.style === 2 && wallTop <= 52 && len >= 14 && rnd() < (near ? 0.85 : 0.4)) {
        const grid = facadeGrid(g.style, len, wallTop);
        const floors = Math.min(grid.floors - 1, 9);
        if (floors >= 2) {
          const count = len > 42 ? 2 : 1;
          for (let c = 0; c < count; c++) {
            const want = ((c + 0.3 + rnd() * 0.4) / count) * len;
            const along = (Math.floor(want / grid.bay) + 0.5) * grid.bay;
            addFireEscape(steel, f, along, grid.floorH, floors);
          }
        }
      }
    };

    for (const blk of this.st.blocks) {
      const roadE = blk.i + 1 <= CITY.ni - 1;
      const roadW = blk.i >= 0;
      const roadN = blk.j + 1 <= CITY.nj - 1;
      const roadS = blk.j >= 0;
      for (const g of blk.buildings) {
        const gx0 = g.x - g.w / 2, gx1 = g.x + g.w / 2;
        const gz0 = g.z - g.d / 2, gz1 = g.z + g.d / 2;
        const wallTop = g.podium > 0 ? g.podium : g.h;
        const masonry = g.style === 1 || g.style === 2;
        // 檐口和腰线：砖石楼是挑出来的石条，现代楼只有一圈窄窄的金属压顶
        if (masonry) {
          trim.box(g.x, wallTop + 0.2, g.z, g.w + 0.7, 0.4, g.d + 0.7, true);
          trim.box(g.x, GROUND_FLOOR - 0.13, g.z, g.w + 0.44, 0.22, g.d + 0.44, true);
        } else {
          steel.box(g.x, wallTop + 0.07, g.z, g.w + 0.14, 0.14, g.d + 0.14, true);
        }
        // 矮的砖石楼顶上放水箱
        if (masonry && g.h <= 62 && g.w > 10 && g.d > 10 && rnd() < 0.5) {
          addWaterTower(wood, steel, g.x + (rnd() - 0.5) * (g.w - 8), g.h, g.z + (rnd() - 0.5) * (g.d - 8), 0.85 + rnd() * 0.4);
        }
        // 高楼顶上立天线，顶端一盏红色的航空障碍灯
        if (g.h > 92 && rnd() < 0.75) {
          const top = g.podium > 0 && g.h > 110 ? g.h + 9 : g.h;
          const p = addMast(steel, beacons, g.x + (rnd() - 0.5) * 4, top, g.z + (rnd() - 0.5) * 4, 7 + rnd() * 11);
          this.glowSpots.push({ x: p[0], y: p[1], z: p[2], color: [1.0, 0.08, 0.05], size: 2.6, cone: 0 });
        }
        if (roadE && Math.abs(gx1 - (blk.x + bw / 2)) < eps) face(g, { x0: gx1, z0: gz0, x1: gx1, z1: gz1, nx: 1, nz: 0 }, 0);
        if (roadW && Math.abs(gx0 - (blk.x - bw / 2)) < eps) face(g, { x0: gx0, z0: gz0, x1: gx0, z1: gz1, nx: -1, nz: 0 }, 1);
        if (roadN && Math.abs(gz1 - (blk.z + bw / 2)) < eps) face(g, { x0: gx0, z0: gz1, x1: gx1, z1: gz1, nx: 0, nz: 1 }, 2);
        if (roadS && Math.abs(gz0 - (blk.z - bw / 2)) < eps) face(g, { x0: gx0, z0: gz0, x1: gx1, z1: gz0, nx: 0, nz: -1 }, 3);
      }
    }

    this.add(steel, this.mats.metal, true, true, true);
    this.add(wood, this.mats.wood);
    this.add(trim, this.mats.concrete);
    this.add(awnings, createAwningMaterial());
    props.build((b, m) => this.add(b, m, true, true, true), this.mats.metal, this.mats.wood);
    // 航空障碍灯：入夜后一明一暗地闪
    const beacon = new THREE.MeshBasicNodeMaterial();
    beacon.colorNode = mix(vec3(0.25, 0.02, 0.02), vec3(7.0, 0.25, 0.12), smoothstep(0.1, 0.5, cityUniforms.lights).mul(step(fract(time.mul(0.6)), 0.55)));
    this.add(beacons, beacon, false, false);
  }

  /** 暂停 / 恢复阴影图的更新（见 DriveWorld.pauseShadows） */
  pauseShadows(paused: boolean): void {
    if (!this.csm) return;
    for (const light of this.csm.lights) if (light.shadow) light.shadow.autoUpdate = !paused;
  }

  /* ------------------------------ 停着的车 ------------------------------ */

  /**
   * 岔路两边停满车。只停在赛道旁边一百米以内、又隔着护栏开不到的路段：
   * 过路口时往两边看，街上是有车的；赛道本身不停车（会挡 AI 的线路）。
   */
  private buildParkedCars(): void {
    const rnd = seeded(2468);
    const cars: ParkedCar[] = [];
    const lane = HALF_ROAD - 1.25;
    const ok = (x: number, z: number) => {
      const d = this.trackDistance(x, z);
      return d > 26 && d < 100 && !underDeck(x, z) && !underElevated(x, z) && Math.abs(roadHeight(x, z)) < 0.02;
    };
    /** 沿一段路的两侧排车。along：这段路沿哪个方向；fixed：路中心线在另一个方向上的坐标 */
    const fill = (along: 'x' | 'z', fixed: number, from: number, to: number) => {
      for (const s of [-1, 1]) {
        let t = from + rnd() * 4;
        while (t < to) {
          const r = rnd();
          const kind = r < 0.4 ? 0 : r < 0.65 ? 1 : r < 0.9 ? 2 : 3;
          if (rnd() < 0.7) {
            const side = fixed + s * (lane + (rnd() - 0.5) * 0.3);
            const x = along === 'z' ? side : t;
            const z = along === 'z' ? t : side;
            // 靠右停：车头朝着这一侧的行车方向
            const yaw = (along === 'z' ? (s > 0 ? Math.PI : 0) : s > 0 ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 0.06;
            // 随机数先取完再判断能不能停：以后改筛选条件，其他车的位置和颜色不会跟着全变
            const color = Math.floor(rnd() * PARKED_COLORS);
            if (ok(x, z)) cars.push({ x, z, yaw, kind, color });
          } else if (rnd() < 0.35) {
            t += 6;
          }
          t += 5.4 + rnd() * 1.5 + (kind === 3 ? 0.9 : 0);
        }
      }
    };
    for (let i = 0; i < CITY.ni; i++) {
      for (let j = 0; j < CITY.nj - 1; j++) {
        if (j === CITY.riverRow) continue;
        fill('z', avenueX(i), streetZ(j) + HALF_ROAD + 9, streetZ(j + 1) - HALF_ROAD - 9);
      }
    }
    for (let j = 0; j < CITY.nj; j++) {
      for (let i = 0; i < CITY.ni - 1; i++) fill('x', streetZ(j), avenueX(i) + HALF_ROAD + 9, avenueX(i + 1) - HALF_ROAD - 9);
    }
    this.group.add(createParkedCars(cars));
  }

  /* ------------------------------ 蒸汽 ------------------------------ */

  /** 沿赛道每隔两百多米，路面上一个冒蒸汽的井盖 */
  private buildSteam(): void {
    const vents: { x: number; y: number; z: number }[] = [];
    const rnd = seeded(555);
    let next = 60;
    for (const smp of this.track.samples) {
      if (smp.s < next) continue;
      next = smp.s + 190 + rnd() * 120;
      const side = (rnd() < 0.5 ? -1 : 1) * (1.6 + rnd() * 2.2);
      const x = smp.pos.x + smp.left.x * side;
      const z = smp.pos.z + smp.left.z * side;
      // 只放在平地上的路面：桥上和下层街道没有井盖
      if (Math.abs(smp.pos.y) > 0.05 || underDeck(x, z)) continue;
      vents.push({ x, y: 0.05, z });
    }
    const steam = createSteamVents(vents);
    if (steam) this.fxGroup.add(steam);

    // 顺便沿着赛道撒垃圾：排水沟里、人行道的墙根下
    const litter: LitterPiece[] = [];
    const piece = (x: number, y: number, z: number) => {
      litter.push({ x, y, z, yaw: rnd() * 6.28, size: 0.14 + rnd() * 0.24, color: LITTER_COLORS[Math.floor(rnd() * LITTER_COLORS.length)] });
    };
    for (const smp of this.track.samples) {
      for (const side of [-1, 1]) {
        // 垃圾是一小堆一小堆的：大多数地方没有，有的地方连着两三片
        if (rnd() < 0.3) {
          const n = 1 + Math.floor(rnd() * 3);
          for (let k = 0; k < n; k++) {
            const off = side * (HALF_ROAD - 0.25 - rnd() * 0.9);
            piece(smp.pos.x + smp.left.x * off + smp.dir.x * (rnd() - 0.5) * 2, smp.pos.y + 0.014, smp.pos.z + smp.left.z * off + smp.dir.z * (rnd() - 0.5) * 2);
          }
        }
        if (Math.abs(smp.pos.y) < 0.05 && Math.abs(smp.curvature) < 0.004 && rnd() < 0.22) {
          const off = side * (HALF_ROAD + 0.5 + rnd() * 3.6);
          const x = smp.pos.x + smp.left.x * off;
          const z = smp.pos.z + smp.left.z * off;
          if (!underDeck(x, z)) piece(x, CITY.curb + 0.014, z);
        }
      }
    }
    const mesh = createLitter(litter);
    if (mesh) {
      mesh.layers.set(DETAIL_LAYER);
      this.group.add(mesh);
    }
  }

  /* ------------------------------ 树 ------------------------------ */

  private buildTrees(): void {
    const rnd = seeded(31337);
    const spots: { x: number; z: number; s: number; street?: boolean }[] = [];
    const off = HALF_ROAD + 1.4;

    // 行道树：只种在大道两侧，夹在路灯之间
    for (let i = 0; i < CITY.ni; i++) {
      const x = avenueX(i);
      if (i === ELEVATED.avenue) continue; // 高架下面不种树
      for (let j = -1; j < CITY.nj; j++) {
        if (j === CITY.riverRow) continue;
        const zBase = j === -1 ? streetZ(0) - CITY.pitch : streetZ(j);
        for (const t of [16, 41, 69, 94]) {
          for (const s of [-1, 1]) {
            if (rnd() < 0.28) continue;
            if (i === CITY.ni - 1 && s === 1) continue;
            spots.push({ x: x + s * off, z: zBase + t, s: 0.8 + rnd() * 0.45, street: true });
          }
        }
      }
    }
    // 湖滨公园里的树：随机撒，避开步道
    {
      const L = LAKESHORE;
      const rMax = L.radius - HALF_ROAD - CITY.sidewalk - 5;
      for (let k = 0; k < 190; k++) {
        const a = (rnd() - 0.5) * Math.PI * 1.02;
        const r = Math.sqrt(rnd()) * rMax;
        const x = L.cx + r * Math.cos(a);
        const z = L.cz + r * Math.sin(a);
        if (x < LAND.east + 3) continue;
        if (Math.abs(r - 97.5) < 4 || Math.abs(r - 39.5) < 4) continue; // 步道
        if (Math.hypot(x - (L.cx + 62), z - L.cz) < 24) continue; // 摩天轮脚下
        spots.push({ x, z, s: 1.0 + rnd() * 0.9 });
      }
    }

    // 三种长相的树轮着用，每棵再随机转个方向、放大缩小一点
    const kinds = [createTree(11), createTree(23), createTree(37)];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const pits = new MeshBuilder();
    kinds.forEach((kind, k) => {
      // 每个格子里的树各成一组：镜头外的格子整组不画
      for (const mine of groupByCell(spots.filter((_, i) => i % kinds.length === k))) {
        const trunks = new THREE.InstancedMesh(kind.trunk, this.mats.trunk, mine.length);
        const crowns = new THREE.InstancedMesh(kind.crown, this.mats.leaves, mine.length);
        mine.forEach((t, i) => {
          q.setFromAxisAngle(UP, rnd() * 6.28);
          // 有的瘦高、有的矮胖
          const tall = 0.9 + rnd() * 0.25;
          m.compose(p.set(t.x, CITY.curb, t.z), q, sc.set(t.s, t.s * tall, t.s));
          trunks.setMatrixAt(i, m);
          crowns.setMatrixAt(i, m);
          // 行道树脚下留一方土
          if (t.street) pits.box(t.x, CITY.curb + 0.012, t.z, 1.5, 0.024, 1.5, true);
        });
        for (const im of [trunks, crowns]) {
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          im.castShadow = true;
          im.receiveShadow = true;
          im.layers.set(DETAIL_LAYER);
          this.group.add(im);
        }
      }
    });
    this.add(pits, this.mats.soil, false);
  }

  /* ------------------------------ 摩天轮 ------------------------------ */

  private buildFerrisWheel(): void {
    const frame = new MeshBuilder();
    const cabins = new MeshBuilder();
    const L = LAKESHORE;
    const cx = L.cx + 62;
    const cz = L.cz;
    const R = 30;
    const hubY = 35;
    const n = 24;
    // 轮盘所在平面和 Z 轴平行：从城市一侧和湖滨大道上都能看到正面
    for (const off of [-1.6, 1.6]) {
      const hub = v3(cx + off, hubY, cz);
      const rim: THREE.Vector3[] = [];
      for (let k = 0; k < n * 2; k++) {
        const a = (k / (n * 2)) * Math.PI * 2;
        rim.push(v3(cx + off, hubY + R * Math.sin(a), cz + R * Math.cos(a)));
      }
      for (let k = 0; k < rim.length; k++) {
        frame.beam(rim[k], rim[(k + 1) % rim.length], 0.3, 0.3);
        if (k % 2 === 0) frame.beam(hub, rim[k], 0.12, 0.12);
      }
      // 内圈
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2;
        const a1 = ((k + 1) / n) * Math.PI * 2;
        frame.beam(
          v3(cx + off, hubY + R * 0.55 * Math.sin(a0), cz + R * 0.55 * Math.cos(a0)),
          v3(cx + off, hubY + R * 0.55 * Math.sin(a1), cz + R * 0.55 * Math.cos(a1)),
          0.14,
          0.14,
        );
      }
      // A 字形支架
      for (const s of [-1, 1]) frame.beam(v3(cx + off * 2.6, CITY.curb, cz + s * 13), hub, 0.7, 0.7);
    }
    frame.beam(v3(cx - 2.2, hubY, cz), v3(cx + 2.2, hubY, cz), 1.6, 1.6);
    // 轿厢
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const y = hubY + R * Math.sin(a);
      const z = cz + R * Math.cos(a);
      frame.beam(v3(cx - 1.6, y, z), v3(cx + 1.6, y, z), 0.14, 0.14);
      cabins.box(cx, y - 1.7, z, 2.2, 2.3, 2.0, true);
    }
    // 轮圈和辐条上的灯：粉、青两色交替
    const pink = new MeshBuilder();
    const cyan = new MeshBuilder();
    for (const off of [-1.95, 1.95]) {
      for (let k = 0; k < n * 4; k++) {
        const a = (k / (n * 4)) * Math.PI * 2;
        (k % 2 === 0 ? pink : cyan).box(cx + off, hubY + R * Math.sin(a), cz + R * Math.cos(a), 0.12, 0.5, 0.5, true);
      }
      for (let k = 0; k < n; k += 2) {
        const a = (k / n) * Math.PI * 2;
        for (let r = 5; r < R - 1; r += 3) (k % 4 === 0 ? cyan : pink).box(cx + off, hubY + r * Math.sin(a), cz + r * Math.cos(a), 0.1, 0.3, 0.3, true);
      }
    }
    this.add(pink, this.glow([0.5, 0.42, 0.45], [7.0, 0.5, 2.6]), false, false);
    this.add(cyan, this.glow([0.42, 0.48, 0.5], [0.4, 5.0, 7.0]), false, false);
    for (const s of [-1, 1]) {
      this.light(cx - 14, 12, cz + s * 16, [1.0, 0.2, 0.55], 1.3, 34, 0);
      this.light(cx + 14, 12, cz + s * 16, [0.2, 0.8, 1.0], 1.3, 34, 0);
    }
    const white = new THREE.MeshStandardNodeMaterial({ color: 0xd8dade, roughness: 0.45, metalness: 0.5 });
    const cabinMat = new THREE.MeshStandardNodeMaterial({ color: 0xb01525, roughness: 0.4, metalness: 0.3 });
    this.add(frame, white);
    this.add(cabins, cabinMat);
  }

  /* ------------------------------ 天空、主光、时段 ------------------------------ */

  private buildSky(): void {
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    skyMat.colorNode = skyColorNode();
    skyMat.fog = false;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 48, 24), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // 主光：白天和黄昏是太阳，夜里是月亮
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(QUALITY.shadowSize, QUALITY.shadowSize);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.06;
    // 级联阴影：近处的车影清晰，远处整条街的楼影也在
    this.csm = new CSMShadowNode(this.sun, { cascades: QUALITY.cascades, maxFar: QUALITY.shadowFar, mode: 'practical', lightMargin: 320 });
    this.sun.shadow.shadowNode = this.csm;
    this.group.add(this.sun, this.sun.target);

    // 天光补光：城市峡谷里大部分地方照不到太阳，只靠环境贴图会黑成一片。
    // 半球光只影响漫反射，不会让车漆和玻璃的反射跟着过亮
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.group.add(this.hemi);
  }

  /** 所有几何建完之后：烤地面光照图，建车身高光用的点光源池，给每个材质接上城市灯光 */
  private finishLighting(): void {
    this.lightmap.bake(this.cityLights, this.covers);
    // 路灯这类主光源 6 盏、招牌这类彩色点缀 3 盏
    this.lampPool = new LightPool(
      this.cityLights.filter((l) => l.pool === 1),
      6,
      50,
      46,
      this.group,
    );
    this.neonPool = new LightPool(
      this.cityLights.filter((l) => l.pool === 2),
      3,
      80,
      40,
      this.group,
    );

    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardNodeMaterial;
      if (this.litMaterials.has(m)) return;
      this.litMaterials.add(m);
      const ground = m === this.mats.road || m === this.mats.sidewalk;
      // 积雪要赶在夜间灯光之前加：灯光按材质的颜色算，雪也要被路灯照亮。
      // 路面和人行道有自己的写法；立面是竖的，积不住雪
      if (m.isMeshStandardNodeMaterial && !ground && m !== this.mats.water && m !== this.mats.facade && m !== this.mats.trainWindow) addSnow(m, this.lightmap);
      if (m.isMeshStandardNodeMaterial && m !== this.mats.water) this.lightmap.apply(m, m === this.mats.leaves ? 0.22 : 1, ground);
    });
    // 城市的材质只受主光和天光影响：路灯的光来自地面光照图，
    // 车身高光用的那几个点光源不应该再照它们一遍
    const node = lights([this.sun, this.hemi]);
    for (const m of this.litMaterials) (m as THREE.NodeMaterial).lightsNode = node;
  }

  setCarLighting(s: CarLighting): void {
    const u = cityUniforms;
    u.headPos.value.copy(s.headPos);
    u.headDir.value.copy(s.headDir);
    u.headPower.value = s.headlight * 7.0;
    u.carPos.value.copy(s.groundPos);
    u.carDir.value.copy(s.heading);
    u.carShadow.value = s.shadow;
    u.tailGlow.value = s.tailGlow;
  }

  /** 其他车的车底阴影和尾灯地面光。传进来的应该已经按离镜头的远近排好，多出来的不画 */
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

  /**
   * 让外来的材质（比赛的终点线、检查点）和城市其他表面一样：
   * 被地面光照图照亮，只受主光和天光影响，用城市的静态环境贴图
   */
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
    // 夜里不算主光的影子：月光很暗（街上的光来自路灯的光照图），影子几乎看不出来，
    // 却要把全城再画三遍。开关的一瞬间所有材质要重新编译，所以只在昼夜交替时切一次
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
    this.neonPool.strength = p.lights;

    // 雨丝的底色：被天光照亮。夜里很暗，主要靠路灯和车灯把它打亮
    this.precip.rain.amount.value = w.rain;
    this.precip.rain.ambient.value.setRGB(
      p.hemiSky[0] * p.hemiIntensity * 0.34 + 0.012,
      p.hemiSky[1] * p.hemiIntensity * 0.34 + 0.013,
      p.hemiSky[2] * p.hemiIntensity * 0.34 + 0.016,
    );

    // 雪花：比雨丝亮得多（白的），同样被路灯和车灯照亮
    this.precip.snowFx.amount.value = w.snow;
    this.precip.snowFx.ambient.value.setRGB(
      p.hemiSky[0] * p.hemiIntensity * 0.8 + 0.035,
      p.hemiSky[1] * p.hemiIntensity * 0.8 + 0.036,
      p.hemiSky[2] * p.hemiIntensity * 0.8 + 0.04,
    );

    // 环境贴图不能逐帧插值：时段过渡到一半（主光最暗）、云遮住一半天的时候换成对应的那一套
    const key = `${p.id}:${w.overcast > 0.5 ? 1 : 0}`;
    if (this.envKey !== key) {
      const env = this.envs.get(key);
      if (env) {
        this.envKey = key;
        k.environment = env.car;
        // 车用的是跟着它走的实时探针；城市自己的材质固定用静态环境贴图。
        // 楼体玻璃、水面、路面用只有天空的那张：它们该反射天，街上的东西由屏幕空间反射补上
        for (const m of this.litMaterials) {
          const std = m as THREE.MeshStandardNodeMaterial;
          if (!std.isMeshStandardNodeMaterial) continue;
          const first = std.envMap === null;
          std.envMap = m === this.mats.facade || m === this.mats.water || m === this.mats.road ? env.sky : env.car;
          // 路面和人行道只反射一点点天空：粗糙的沥青贴着地面看也会映出天色，太强了整条街都是蓝的
          std.envMapIntensity = m === this.mats.road || m === this.mats.sidewalk ? 0.45 : 1.0;
          if (first) std.needsUpdate = true;
        }
      }
    }
  }

  get timeName(): string {
    return this.timeTo.name;
  }

  setTime(id: string, immediate = false): void {
    const next = TIMES[id as TimeId];
    if (!next) return;
    if (immediate) {
      this.timeFrom = next;
      this.timeTo = next;
      this.timeT = 1;
      this.current = next;
      this.present();
      return;
    }
    // 过渡中途再切：从当前的混合状态出发
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
    this.neonPool.update(focus);
    this.precip.update(dt, camera);
    // 镜头的视野、近裁剪面变了（车速、切换机位），阴影的分级范围要跟着重算
    if (this.csm && (camera.fov !== this.lastFov || camera.aspect !== this.lastAspect || camera.near !== this.lastNear)) {
      this.lastFov = camera.fov;
      this.lastAspect = camera.aspect;
      this.lastNear = camera.near;
      if (this.csm.camera) this.csm.updateFrustums();
    }
  }

  /** 空中一点被城市灯光和车灯照到多亮（水雾这类特效上色用） */
  airLight(p: N): N {
    return this.lightmap.airLight(p);
  }

  openSky(p: N): N {
    return float(1).sub(this.lightmap.cover(p));
  }

  /** 这个位置头顶上有没有东西（高架下面、下层街道） */
  covered(x: number, z: number): boolean {
    for (const c of this.covers) if (c.visibility < 0.7 && x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1) return true;
    return false;
  }

  resetProps(): void {
    // 城市里暂时没有可移动的道具
  }

  /**
   * 每个时段各烤一套环境贴图：
   * - 车用的：天空 + 地面 + 一圈示意性的楼（夜里楼上有亮着的窗和霓虹色块），
   *   车身侧面反射到的是"街道两边有楼"，而不是一片空旷的天；
   * - 楼体玻璃和水面用的：只有天空，它们该反射天，而不是那圈示意楼。
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

    // 夜里示意楼上的亮窗
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 128;
    const ctx = cv.getContext('2d')!;
    const rnd = seeded(5);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 64, 128);
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 12; x++) {
        if (rnd() > 0.4) continue;
        ctx.fillStyle = rnd() < 0.6 ? '#ffb45e' : '#b9dcff';
        ctx.globalAlpha = 0.4 + rnd() * 0.6;
        ctx.fillRect(3 + x * 5, 4 + y * 4, 3, 2);
      }
    }
    const windows = new THREE.CanvasTexture(cv);
    windows.colorSpace = THREE.SRGBColorSpace;

    const boxes: { walls: THREE.MeshBasicMaterial; glow: THREE.MeshBasicMaterial; g: number }[] = [];
    const neon: THREE.MeshBasicMaterial[] = [];
    const neonColors = [0xff2e88, 0x19e3ff, 0xffd21f, 0xa45bff, 0x3dff8c, 0xff7a1a];
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * Math.PI * 2 + rnd() * 0.1;
      const r = 26 + rnd() * 30;
      const h = 18 + rnd() * 70;
      const w = 16 + rnd() * 16;
      const walls = new THREE.MeshBasicMaterial();
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), walls);
      box.position.set(Math.cos(a) * r, h / 2 - 1, Math.sin(a) * r);
      box.rotation.y = -a;
      env.add(box);
      // 亮窗：一层稍微大一点的壳，叠加在楼体上
      const glow = new THREE.MeshBasicMaterial({ map: windows, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      const shell = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, h, w + 0.3), glow);
      shell.position.copy(box.position);
      shell.rotation.copy(box.rotation);
      env.add(shell);
      boxes.push({ walls, glow, g: 0.1 + rnd() * 0.22 });
      // 楼脚的霓虹色块
      if (k % 2 === 0) {
        const m = new THREE.MeshBasicMaterial({ color: neonColors[(k / 2) % neonColors.length] });
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(5 + rnd() * 5, 2.2 + rnd() * 2.5), m);
        const rr = r - w * 0.72;
        sign.position.set(Math.cos(a) * rr, 5 + rnd() * 8, Math.sin(a) * rr);
        sign.lookAt(0, sign.position.y, 0);
        env.add(sign);
        neon.push(m);
      }
    }

    const skyOnly = new THREE.Scene();
    skyOnly.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), sky));
    const groundMat = new THREE.MeshBasicMaterial();
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 32), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    skyOnly.add(ground);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const neonBase = neon.map((m) => m.color.clone());
    for (const id of TIME_ORDER) for (const oc of [0, 1]) {
      const p = applyWeather(TIMES[id], { rain: oc, wetness: oc, fog: oc ? WEATHERS.rain.fog : 1, overcast: oc, flash: 0, snow: 0, snowCover: 0 });
      applySky(p);
      // 楼体和地面的明暗跟着时段走
      const lit = id === 'day' ? 1 : id === 'dusk' ? 0.5 : 0.045;
      const tint = id === 'dusk' ? [1.15, 0.85, 0.8] : id === 'night' ? [0.8, 0.85, 1.2] : [1, 1.02, 1.08];
      for (const b of boxes) {
        b.walls.color.setRGB(b.g * lit * tint[0], b.g * lit * tint[1], b.g * lit * tint[2]);
        b.glow.color.setScalar(p.lights * 2.2);
      }
      neon.forEach((m, k) => m.color.copy(neonBase[k]).multiplyScalar(p.lights * 3.2));
      floorMat.color.setRGB(0.1 * lit + p.lights * 0.03, 0.1 * lit + p.lights * 0.024, 0.105 * lit + p.lights * 0.016);
      groundMat.color.setRGB(0.2 * lit + p.lights * 0.02, 0.2 * lit + p.lights * 0.018, 0.2 * lit + p.lights * 0.022);
      const car = pmrem.fromScene(env, 0, 0.1, 600, { size: 256 }).texture;
      const skyTex = pmrem.fromScene(skyOnly, 0, 0.1, 600, { size: 256 }).texture;
      this.envs.set(`${id}:${oc}`, { car, sky: skyTex });
    }
    pmrem.dispose();
    this.envKey = null;
    this.present();
  }
}
