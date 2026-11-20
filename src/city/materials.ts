import * as THREE from 'three/webgpu';
import {
  abs,
  atan,
  attribute,
  cameraViewMatrix,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  materialColor,
  materialMetalness,
  materialRoughness,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  normalView,
  normalWorld,
  positionView,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { withSurface } from '../core/surface.ts';
import { createFacadeMaterial } from './facade.ts';
import { createGraffitiAtlas } from './graffiti.ts';

let graffiti: THREE.Texture | null = null;
/** 涂鸦图集：卷帘门、桥墩、围挡都用同一张 */
export function graffitiAtlas(): THREE.Texture {
  if (!graffiti) graffiti = createGraffitiAtlas();
  return graffiti;
}
import { createShopSignAtlas } from './shopSigns.ts';
import type { CityLightmap } from './cityLights.ts';
import { avenueX, CITY, HALF_ROAD, LAKESHORE } from './cityLayout.ts';
import { junctionAt } from './turnMap.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 地面材质里同时给几辆别的车算车底阴影 */
export const RIVAL_SLOTS = 5;

/** 全城共用的可调量。阶段 4（昼夜）、阶段 5（雨）会接着驱动这些值 */
export const cityUniforms = {
  /** 窗户和招牌的亮灯程度：0 白天，1 入夜 */
  lights: uniform(0),
  /** 路面潮湿程度：0 干，1 湿透 */
  wetness: uniform(0),
  /** 正在下的雨有多大：0–1。水洼里的涟漪跟着它 */
  rain: uniform(0),
  /** 空气有多浑：0 通透，1 大雾。灯的光晕和光锥跟着它变浓 */
  haze: uniform(0),
  /** 积雪：0 没有，1 铺满。路面、人行道、屋顶和所有朝上的面都读它 */
  snow: uniform(0),
  /** 路灯等城市灯光照在地面、墙面上的整体强度 */
  lampGain: uniform(1.2),
  /** 车头大灯：位置、朝向、亮度。光束在着色器里按公式算，不是真光源 */
  headPos: uniform(new THREE.Vector3()),
  headDir: uniform(new THREE.Vector3(0, 0, 1)),
  headPower: uniform(0),
  /** 车的位置（贴地）和车头方向（水平），用来算车底的软阴影和尾灯洒在地上的红光 */
  carPos: uniform(new THREE.Vector3(0, -100, 0)),
  carDir: uniform(new THREE.Vector2(0, 1)),
  carShadow: uniform(0),
  tailGlow: uniform(0),
  /**
   * 其他车（比赛里的对手）的车底阴影和尾灯地面光，只算离镜头最近的几辆。
   * 每辆两个四维数：(x, 贴地高度, z, 阴影浓度) 和 (车头方向 x, 车头方向 z, 尾灯地面光强度, 0)
   */
  rivalPos: uniformArray(
    Array.from({ length: RIVAL_SLOTS }, () => new THREE.Vector4(0, -100, 0, 0)),
    'vec4',
  ),
  rivalDir: uniformArray(
    Array.from({ length: RIVAL_SLOTS }, () => new THREE.Vector4(0, 1, 0, 0)),
    'vec4',
  ),
};

/* 抗锯齿的辅助函数 */
export const aa = (d: N) => max(fwidth(d), 0.0005);
/** 以 center 为中心、半宽 hw 的一条线（1 = 在线上） */
export const stripe = (d: N, center: number, hw: number): N => {
  const e = abs(d.sub(center));
  const w = aa(d);
  return float(1).sub(smoothstep(float(hw).sub(w), float(hw).add(w), e));
};
/** d 落在 [a, b] 区间内 */
export const band = (d: N, a: number, b: number): N => {
  const w = aa(d);
  return smoothstep(float(a).sub(w), float(a).add(w), d).mul(float(1).sub(smoothstep(float(b).sub(w), float(b).add(w), d)));
};
/** 伪随机：二维格点 → 0..1 */
export const hash2 = (p: N): N => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

/* ------------------------------------------------------------------ */
/* 噪声贴图                                                             */
/* ------------------------------------------------------------------ */

/** 贴图边长（像素）和它一圈有多少个起伏：每个起伏 8 个像素 */
const NOISE_SIZE = 512;
const NOISE_PERIOD = 64;
let noiseTex: THREE.DataTexture | null = null;

/**
 * 一张可以无缝平铺的噪声贴图，四个通道是四份互不相关的噪声。
 *
 * 路面的斑驳、裂缝、油渍、磨损原来都是在着色器里现算的噪声函数，一个像素要算十五次，
 * 路面又占了画面的一大半，是全场最贵的材质之一。改成查贴图以后每次只是一次采样。
 * 代价是图案每 64 个起伏重复一次——几层不同尺度的噪声叠在一起，看不出来。
 */
function noiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  for (let c = 0; c < 4; c++) {
    // 每个格点一个随机方向（经典的梯度噪声），格点按周期回绕所以首尾相接
    const grad = new Float32Array(NOISE_PERIOD * NOISE_PERIOD * 2);
    let seed = (c + 1) * 7919;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < NOISE_PERIOD * NOISE_PERIOD; i++) {
      const a = rnd() * Math.PI * 2;
      grad[i * 2] = Math.cos(a);
      grad[i * 2 + 1] = Math.sin(a);
    }
    const dotAt = (ix: number, iy: number, fx: number, fy: number) => {
      const k = ((iy % NOISE_PERIOD) * NOISE_PERIOD + (ix % NOISE_PERIOD)) * 2;
      return grad[k] * fx + grad[k + 1] * fy;
    };
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const step = NOISE_PERIOD / NOISE_SIZE;
    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        const px = x * step;
        const py = y * step;
        const ix = Math.floor(px);
        const iy = Math.floor(py);
        const fx = px - ix;
        const fy = py - iy;
        const u = fade(fx);
        const v = fade(fy);
        const top = dotAt(ix, iy, fx, fy) * (1 - u) + dotAt(ix + 1, iy, fx - 1, fy) * u;
        const bottom = dotAt(ix, iy + 1, fx, fy - 1) * (1 - u) + dotAt(ix + 1, iy + 1, fx - 1, fy - 1) * u;
        // 梯度噪声的范围大约是 ±0.7，放大到 ±1 再存成 0–255
        const n = (top * (1 - v) + bottom * v) * 1.42;
        data[(y * NOISE_SIZE + x) * 4 + c] = Math.max(0, Math.min(255, Math.round((n * 0.5 + 0.5) * 255)));
      }
    }
  }
  const tex = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  noiseTex = tex;
  return tex;
}

/**
 * 查噪声贴图，用法和着色器里的噪声函数一样：(px, pz) 每走 1 是一个起伏，返回 -1..1。
 * k 选第几份噪声：四个通道轮着用，超过四份的在贴图上错开一段位置。
 */
export const nz = (px: N, pz: N, k: number): N => {
  const lap = Math.floor(k / 4);
  const at: N = vec2(px, pz)
    .div(NOISE_PERIOD)
    .add(vec2(lap * 0.371 + k * 0.113, lap * 0.617 + k * 0.071));
  const t: N = texture(noiseTexture(), at);
  // 乘 0.68：贴图里的噪声起伏比着色器里那个噪声函数大，直接换上去裂缝和油渍会多出一倍。
  // 压到和原来差不多的幅度，材质里那些阈值就不用重调
  return ([t.r, t.g, t.b, t.a][k % 4] as N).mul(2.0).sub(1.0).mul(0.68);
};

/* ------------------------------------------------------------------ */
/* 积雪                                                                 */
/* ------------------------------------------------------------------ */

/** 雪的颜色：不是纯白，背光处偏蓝。夜里路灯照上去会被染成暖色 */
// 入夜后照在雪上的几乎全是钠灯的橙光，按原样算出来雪是土黄色的，像沙子。
// 所以夜里把雪本身往冷色偏：灯下是带一点暖意的白，灯照不到的地方是蓝灰
export const SNOW: N = vec3(0.3, 0.325, 0.37).mul(mix(vec3(1.0, 1.0, 1.0), vec3(0.74, 1.08, 1.85), smoothstep(0.2, 0.9, cityUniforms.lights)));

/**
 * 给一种普通材质加上积雪：朝上的面盖一层雪，边缘按噪声参差不齐；头顶有遮挡的地方（高架下、下层街道）没有。
 * 屋顶、雨棚、树冠、停着的车、护栏顶、杂物都走这里；路面和人行道有各自更细的写法。
 * 必须在接入夜间灯光之前调用：灯光是按材质的颜色节点算的，雪也要被路灯照亮。
 */
export function addSnow(m: THREE.MeshStandardNodeMaterial, lightmap: CityLightmap): void {
  const p: N = positionWorld;
  const up: N = smoothstep(0.42, 0.78, normalWorld.y);
  const patchy: N = nz(p.x.mul(0.9), p.z.mul(0.9), 3).mul(0.5).add(0.5);
  const open: N = float(1).sub(lightmap.cover(p));
  const mask: N = smoothstep(0.25, 0.6, cityUniforms.snow.mul(up).mul(open).mul(patchy.mul(0.5).add(0.75)));
  const base: N = m.colorNode ?? materialColor;
  const shade: N = nz(p.x.mul(0.33), p.z.mul(0.33), 2).mul(0.08).add(0.96);
  m.colorNode = (mix as N)(base, SNOW.mul(shade), mask);
  m.roughnessNode = (mix as N)(m.roughnessNode ?? materialRoughness, float(0.92), mask);
  m.metalnessNode = (mix as N)(m.metalnessNode ?? materialMetalness, float(0.0), mask);
}

/* ------------------------------------------------------------------ */
/* 路面                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 路面：沥青 + 标线，全部按世界坐标解析计算，所以整座城市的路只用一种材质、不需要贴图。
 * 网格街道的标线由"到最近一条路中心线的距离"推出；湖滨大道的弧线部分用极坐标。
 */
/** 地面转向箭头的大小（米）：一条车道宽 4 米，箭头占中间这么宽；拉得很长，贴着地面看过去才不会被压扁 */
const ARROW_W = 2.3;
const ARROW_L = 6.9;
/** 两排箭头的箭头尖离路口中心多远 */
const ARROW_ROWS = [21, 44];

/**
 * 刷在路面上的左转箭头（右转把它左右翻过来用）：白 = 有漆。
 * 画布上边是箭头指的那一头（靠路口），下边是箭杆的尾巴（靠来车）
 */
function turnArrowTexture(): THREE.CanvasTexture {
  const K = 72; // 每米多少像素
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(ARROW_W * K);
  canvas.height = Math.round(ARROW_L * K);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(K, K);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  // 箭杆：从下往上，到上面三分之一处往左拐
  g.lineWidth = 0.34;
  g.beginPath();
  g.moveTo(1.6, ARROW_L - 0.08);
  g.lineTo(1.6, 3.9);
  g.quadraticCurveTo(1.6, 2.95, 1.12, 2.3);
  g.stroke();
  // 箭头：朝左上
  const dx = -0.58;
  const dz = -0.815;
  const px = -dz;
  const pz = dx;
  const bx = 1.2;
  const bz = 2.42;
  g.beginPath();
  g.moveTo(bx + dx * 2.1, bz + dz * 2.1);
  g.lineTo(bx + px * 0.7, bz + pz * 0.7);
  g.lineTo(bx - px * 0.7, bz - pz * 0.7);
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  return tex;
}

export function createRoadMaterial(lightmap: CityLightmap): THREE.MeshStandardNodeMaterial {
  const P = CITY.pitch;
  const x: N = positionWorld.x;
  const z: N = positionWorld.z;

  // 到最近的大道 / 街中心线的距离
  const dx: N = abs(fract(x.div(P).add(0.5)).sub(0.5)).mul(P);
  const dz: N = abs(fract(z.div(P)).sub(0.5)).mul(P);

  const eastCurb = avenueX(CITY.ni - 1) + HALF_ROAD;
  const inGrid: N = float(1).sub(step(eastCurb, x)); // 最东一条大道以西
  const beforeArc: N = float(1).sub(step(LAKESHORE.cx, x)); // 湖滨连接段以西

  /** 一条街上的标线。across = 横向离中心线多远，toCross = 纵向离最近路口中心多远，along = 纵向坐标 */
  const markings = (across: N, toCross: N, along: N) => {
    const onRoad = float(1).sub(step(HALF_ROAD - 0.55, across)); // 留出路缘边的排水沟
    const mid = step(14.6, toCross); // 路口和斑马线之外才画车道线
    const yellow = max(stripe(across, 0.2, 0.065), float(0)).mul(mid);
    const dash = stripe(across, 4.0, 0.06).mul(step(fract(along.div(9.0)), 0.34)).mul(mid);
    // 斑马线：条纹顺着行车方向
    const zebra = band(toCross, 9.6, 12.6)
      .mul(step(fract(across.div(1.2).add(0.25)), 0.5))
      .mul(onRoad);
    const stopBar = band(toCross, 13.5, 13.95).mul(onRoad);
    return { yellow, white: max(max(dash, zebra), stopBar) };
  };

  const ns = markings(dx, dz, z);
  const ew = markings(dz, dx, x);
  const onNS: N = float(1).sub(step(HALF_ROAD, dx)).mul(inGrid);
  const onEW: N = float(1).sub(step(HALF_ROAD, dz)).mul(beforeArc);

  // 湖滨大道弧线段
  const rel: N = vec2(x.sub(LAKESHORE.cx), z.sub(LAKESHORE.cz));
  const r: N = length(rel);
  const acrossArc: N = abs(r.sub(LAKESHORE.radius));
  const onArc: N = step(LAKESHORE.cx, x).mul(float(1).sub(step(HALF_ROAD, acrossArc)));
  const arcAlong: N = atan(rel.y, rel.x).mul(LAKESHORE.radius);
  const arcYellow: N = stripe(acrossArc, 0.2, 0.065).mul(onArc);
  const arcDash: N = stripe(acrossArc, 4.0, 0.06).mul(step(fract(arcAlong.div(9.0)), 0.34)).mul(onArc);

  const yellow: N = max(max(ns.yellow.mul(onNS), ew.yellow.mul(onEW)), arcYellow);
  let white: N = max(max(ns.white.mul(onNS), ew.white.mul(onEW)), arcDash);

  // 入弯前刷在每条车道上的转向箭头：赛道在哪个路口往哪边拐，查那张一个路口一个像素的小图（turnMap.ts）
  {
    const arrowTex = turnArrowTexture();
    const j = junctionAt(x, z);
    const north: N = step(0.0, j.oz); // 在路口北边的那条臂上（+z）
    const east: N = step(0.0, j.ox);
    // 以来车的方向看：离路中心线往右多远、离路口中心多远、这条臂上记的转向。南北向的路和东西向的路各算各的，在哪条路上用哪套
    const right: N = mix(j.oz.mul(float(1).sub(east.mul(2.0))), j.ox.mul(north.mul(2.0).sub(1.0)), onNS);
    const toCross: N = mix(abs(j.ox), abs(j.oz), onNS);
    const turn: N = mix(j.armEW.mul(onEW), j.armNS, onNS);
    const lane: N = floor(right.div(4.0)).add(0.5).mul(4.0);
    const w0: N = right.sub(lane).div(ARROW_W);
    const w: N = mix(w0, w0.negate(), step(0.75, turn)).add(0.5);
    const t: N = toCross.sub(mix(float(ARROW_ROWS[0]), float(ARROW_ROWS[1]), step((ARROW_ROWS[0] + ARROW_L + ARROW_ROWS[1]) / 2, toCross))).div(ARROW_L);
    const inside: N = step(abs(w0), 0.49).mul(step(0.01, t)).mul(step(t, 0.99)).mul(step(0.25, turn));
    // 只在箭头自己的那一块里真的取样：出了这一块，坐标和它的变化率都归零，取的是同一个像素、不做各向异性过滤，几乎不花时间。
    //（车道之间、两排之间坐标是断开的，变化率得自己给，不能让显卡拿相邻像素去减）
    const at: N = vec2(w, float(1).sub(t));
    const arrow: N = (texture(arrowTex, at.mul(inside)) as N).grad(dFdx(at).mul(inside), dFdy(at).mul(inside)).r.mul(inside);
    white = max(white, arrow);
  }

  // 沥青：大尺度明暗 + 颗粒 + 轮迹（常走车的地方更黑更亮）
  const big: N = nz(x.mul(0.035), z.mul(0.035), 0).mul(0.5).add(0.5);
  const grain: N = nz(x.mul(9.0), z.mul(9.0), 1).mul(0.5).add(0.5);
  const across: N = min(min(dx, dz), acrossArc);
  const wheelPath: N = max(stripe(across, 2.1, 0.55), stripe(across, 5.9, 0.55)).mul(0.5);
  // 补丁：按 12 米格子随机挑一些方块，颜色略有不同
  const cell: N = floor(vec2(x, z).div(12.0));
  const patch: N = step(0.86, hash2(cell)).mul(band(fract(x.div(12.0)), 0.15, 0.8)).mul(band(fract(z.div(12.0)), 0.2, 0.7));
  let asphalt: N = mix(vec3(0.03, 0.03, 0.032), vec3(0.058, 0.057, 0.056), big);
  asphalt = asphalt.mul(grain.mul(0.3).add(0.85));
  asphalt = asphalt.mul(float(1).sub(wheelPath.mul(0.22)));
  asphalt = mix(asphalt, asphalt.mul(0.7), patch);
  // 只在近处看得见的细节：离得远了这些东西比一个像素还小，画出来只会闪
  const nearRoad: N = float(1).sub(smoothstep(0.02, 0.12, max(fwidth(x), fwidth(z))));
  // 骨料：沥青表面细碎的明暗颗粒
  const stone: N = nz(x.mul(31.0), z.mul(31.0), 2).mul(0.6).add(nz(x.mul(77.0), z.mul(77.0), 3).mul(0.4));
  asphalt = asphalt.mul(stone.mul(0.22).mul(nearRoad).add(1.0));
  // 裂缝：噪声等于零的那些线，天然就是弯弯曲曲、互相连着的；一部分灌过沥青（更宽、更黑、发亮）
  const crackField: N = nz(x.mul(0.22), z.mul(0.22), 4).add(nz(x.mul(0.9), z.mul(0.9), 5).mul(0.25));
  const crackZone: N = smoothstep(0.1, 0.5, nz(x.mul(0.03), z.mul(0.03), 6).mul(0.5).add(0.5));
  const crack: N = float(1).sub(smoothstep(0.0, 0.02, abs(crackField))).mul(crackZone).mul(nearRoad);
  const sealed: N = float(1).sub(smoothstep(0.004, 0.035, abs(crackField.sub(0.3)))).mul(crackZone).mul(float(1).sub(smoothstep(0.03, 0.2, max(fwidth(x), fwidth(z)))));
  asphalt = mix(asphalt, vec3(0.012, 0.012, 0.013), max(crack.mul(0.85), sealed.mul(0.9)));
  // 油渍：车道中间、路口停车线前面，一摊摊深色
  const oil: N = smoothstep(0.55, 0.85, nz(x.mul(0.45), z.mul(0.45), 7).mul(0.5).add(0.5)).mul(max(stripe(across, 4.0, 1.0), stripe(across, 0.0, 0.6)));
  asphalt = asphalt.mul(float(1).sub(oil.mul(0.4)));
  // 路缘边的混凝土排水沟
  const gutter: N = smoothstep(HALF_ROAD - 0.6, HALF_ROAD - 0.5, across);
  // 白天的沥青是中灰色的，夜里灯下才显得黑：按天色把底色提亮，再往暖里带一点
  //（不然背阴处只有天光，整条路是一片发蓝的黑）
  const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));
  asphalt = asphalt.mul(mix(vec3(1.0, 1.0, 1.0), vec3(2.05, 1.92, 1.74), daylight));
  asphalt = mix(asphalt, vec3(0.2, 0.2, 0.19).mul(grain.mul(0.2).add(0.9)), gutter.mul(0.85));

  // 井盖：每条路上每隔约 31 米一个
  const manhole = (acrossSigned: N, along: N) => {
    const id: N = floor(along.div(31.0));
    const center: N = id.add(0.5).mul(31.0).add(hash2(vec2(id, 7.0)).sub(0.5).mul(9.0));
    const d: N = length(vec2(acrossSigned.sub(2.2), along.sub(center)));
    return { disc: float(1).sub(smoothstep(0.33, 0.36, d)), ring: band(d, 0.36, 0.43) };
  };
  const mhNS = manhole(dx, z);
  const mhEW = manhole(dz, x);
  // 路口范围内不放井盖
  const clearNS: N = onNS.mul(step(16.0, dz));
  const clearEW: N = onEW.mul(step(16.0, dx));
  const disc: N = max(mhNS.disc.mul(clearNS), mhEW.disc.mul(clearEW));
  const ring: N = max(mhNS.ring.mul(clearNS), mhEW.ring.mul(clearEW));

  // 标线做旧：漆面有磨损
  const wear: N = nz(x.mul(6.5), z.mul(6.5), 8).mul(0.5).add(0.5);
  const wearBig: N = nz(x.mul(0.6), z.mul(0.6), 9).mul(0.5).add(0.5);
  // 磨损集中在车轮压过的两道上；磨掉的地方不是整片变淡，而是一粒粒露出下面的沥青
  const speck: N = nz(x.mul(31.0), z.mul(31.0), 10).mul(0.5).add(0.5);
  const worn: N = smoothstep(0.38, 0.8, wear.mul(0.35).add(wearBig.mul(0.65)).add(wheelPath.mul(0.22)));
  const paint: N = float(0.93)
    .mul(float(1).sub(worn.mul(smoothstep(0.32, 0.62, speck)).mul(0.8)))
    .mul(float(1).sub(max(crack, sealed).mul(0.8)));

  let color: N = asphalt;
  color = mix(color, vec3(0.1, 0.1, 0.1), ring.mul(0.8));
  color = mix(color, vec3(0.045, 0.045, 0.048), disc);
  color = mix(color, vec3(0.5, 0.5, 0.48), white.mul(paint));
  color = mix(color, vec3(0.5, 0.36, 0.05), yellow.mul(paint));

  /* ---- 潮湿 ---- */
  // 头顶有遮挡的地方（下层街道、高架下面）淋不到雨，保持干燥
  const open: N = smoothstep(0.5, 0.88, lightmap.sample(vec2(x, z)).a);
  const wet: N = cityUniforms.wetness.mul(open);

  /* ---- 积雪 ---- */
  // 雪不是均匀的一层：车轮反复压过的两道把雪碾成了发黑的雪水，露出湿沥青；
  // 两道之间和车道中间是压实的脏雪；靠路缘没人走的地方堆得最厚、最白
  const snowAmt: N = cityUniforms.snow.mul(open);
  const lumpy: N = nz(x.mul(0.5), z.mul(0.5), 12).mul(0.5).add(0.5);
  const fleck: N = nz(x.mul(5.0), z.mul(5.0), 13).mul(0.5).add(0.5);
  const fine: N = nz(x.mul(17.0), z.mul(17.0), 14).mul(0.5).add(0.5);
  // 车辙：边缘弯弯曲曲、宽窄不一，不是尺子画出来的直线
  const wobble: N = nz(x.mul(0.3), z.mul(0.3), 9).mul(0.34).add(nz(x.mul(1.7), z.mul(1.7), 10).mul(0.1));
  const toRut: N = min(abs(across.sub(2.1)), abs(across.sub(5.9))).add(wobble);
  const rutHalf: N = lumpy.mul(0.26).add(0.3);
  const rut: N = float(1).sub(smoothstep(rutHalf.mul(0.5), rutHalf.mul(1.9), toRut));
  const bank: N = smoothstep(HALF_ROAD - 3.0, HALF_ROAD - 1.1, across);
  // 雪有多厚（0–1 多一点）：车辙里最薄，路边最厚
  const depth: N = snowAmt
    .mul(lumpy.mul(0.45).add(0.66))
    .mul(float(1).sub(rut.mul(0.86)))
    .add(bank.mul(snowAmt).mul(0.5));
  const snowMask: N = smoothstep(0.3, 0.62, depth.add(fleck.sub(0.5).mul(0.3)).add(fine.sub(0.5).mul(0.12)));
  // 车道上的雪被压过、带着泥，比路边的灰；紧挨着车辙的一圈是半化的雪泥，最脏
  const slushy: N = smoothstep(0.62, 0.3, depth).mul(0.55);
  const dirty: N = max(float(1).sub(bank).mul(0.34), slushy);
  const snowTone: N = lumpy.mul(0.3).add(0.74).mul(fleck.mul(0.2).add(0.9)).mul(fine.mul(0.16).add(0.92));
  const snowColor: N = mix(SNOW, vec3(0.13, 0.135, 0.145), dirty).mul(snowTone);
  // 水洼：用大尺度噪声当"地势"，低的地方先积水；靠路缘的排水沟一带更低
  const terrain: N = nz(x.mul(0.085), z.mul(0.085), 11)
    .mul(0.35)
    .add(nz(x.mul(0.31), z.mul(0.31), 12).mul(0.15))
    .add(0.5)
    .sub(smoothstep(HALF_ROAD - 2.4, HALF_ROAD - 0.5, across).mul(0.2));
  const level: N = mix(float(0.16), float(0.37), wet);
  const puddle: N = smoothstep(level, level.sub(0.06), terrain).mul(smoothstep(0.4, 0.7, wet));
  // 雨点打出来的涟漪：按格子随机放圆心，一圈圈往外扩、变淡
  const ripple = (cell: number, seed: number): N => {
    const g: N = vec2(x, z).div(cell);
    const id: N = floor(g);
    const f: N = fract(g).sub(0.5);
    const h: N = hash2(id.add(seed));
    const h2: N = hash2(id.mul(1.7).add(seed + 3.1));
    const rel: N = f.sub(vec2(h, h2).sub(0.5).mul(0.5));
    const life: N = fract(time.mul(1.5).add(h.mul(17.0)));
    const d: N = length(rel);
    const at: N = d.sub(life.mul(0.42));
    const ring: N = sin(at.mul(42.0)).mul(smoothstep(0.07, 0.0, abs(at))).mul(float(1).sub(life).pow(2.0));
    return rel.div(max(d, 0.001)).mul(ring);
  };
  const ripples: N = ripple(0.85, 0.0).add(ripple(0.52, 5.0)).mul(cityUniforms.rain);
  // 湿沥青表面也不是镜子：一层细小的起伏
  const film: N = vec2(nz(x.mul(3.1), z.mul(3.1), 13), nz(x.mul(3.1), z.mul(3.1), 14)).mul(0.035);
  const bump: N = ripples.mul(mix(float(0.06), float(0.3), puddle)).add(film.mul(float(1).sub(puddle))).mul(wet);

  // 湿了的沥青更黑；水洼里几乎只剩反光
  color = color.mul(mix(float(1.0), float(0.5), wet));
  color = mix(color, color.mul(0.45), puddle);
  color = mix(color, snowColor, snowMask);

  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  // 屏幕空间反射用的表面参数（反射率、反射的模糊程度）。
  // 干沥青贴着地面看也有一层淡淡的反光：远处的霓虹和路灯会在路面上拖出一点光晕；
  // 路面越湿反射越强、越清晰，水洼里接近镜面
  // 白天的干路面不反光（反射率给 0，屏幕空间反射会整片跳过，省下一大块时间）；
  // 入夜后才有那层淡淡的反光
  const dryReflect: N = mix(float(0.0), float(0.07), smoothstep(0.15, 0.6, cityUniforms.lights));
  // 雪面不反光
  const reflect: N = mix(mix(dryReflect, float(0.3), wet), float(0.85), puddle).mul(float(1).sub(snowMask));
  const blur: N = mix(mix(float(0.74), float(0.5), wet), float(0.03), puddle);
  m.colorNode = withSurface(color, reflect, blur);
  const dryRough: N = mix(float(0.88), float(0.62), max(white, yellow).mul(paint))
    .sub(wheelPath.mul(0.12))
    .sub(disc.mul(0.35))
    .sub(sealed.mul(0.45))
    .sub(oil.mul(0.2));
  m.roughnessNode = mix(mix(mix(dryRough, float(0.45), wet), float(0.05), puddle), float(0.9), snowMask);
  m.metalnessNode = disc.mul(0.7).mul(float(1).sub(puddle)).mul(float(1).sub(snowMask));
  // 雪面坑坑洼洼：车辙边上、脚印、被风吹出来的起伏
  const snowBump: N = vec2(nz(x.mul(2.3), z.mul(2.3), 4), nz(x.mul(2.3), z.mul(2.3), 5)).mul(0.3).add(vec2(nz(x.mul(9.0), z.mul(9.0), 6), nz(x.mul(9.0), z.mul(9.0), 7)).mul(0.14)).mul(snowMask);
  const nW: N = normalize(normalWorld.add(vec3(bump.x.mul(float(1).sub(snowMask)).add(snowBump.x), 0.0, bump.y.mul(float(1).sub(snowMask)).add(snowBump.y))));
  m.normalNode = nW.transformDirection(cameraViewMatrix);
  return m;
}

/* ------------------------------------------------------------------ */
/* 人行道                                                               */
/* ------------------------------------------------------------------ */

/** 人行道：混凝土地砖 + 花岗岩路缘。同样按世界坐标计算 */
export function createSidewalkMaterial(lightmap: CityLightmap): THREE.MeshStandardNodeMaterial {
  const P = CITY.pitch;
  const x: N = positionWorld.x;
  const z: N = positionWorld.z;
  const dx: N = abs(fract(x.div(P).add(0.5)).sub(0.5)).mul(P);
  const dz: N = abs(fract(z.div(P)).sub(0.5)).mul(P);
  // 离最近的路缘多远
  const toCurb: N = min(dx, dz).sub(HALF_ROAD);

  const tile = 1.5;
  // 到地砖边缘的距离（0 = 正好在砖缝上）
  const jx: N = float(tile / 2).sub(abs(fract(x.div(tile)).sub(0.5)).mul(tile));
  const jz: N = float(tile / 2).sub(abs(fract(z.div(tile)).sub(0.5)).mul(tile));
  const joint: N = float(1).sub(smoothstep(0.012, 0.03, min(jx, jz)));
  const tileId: N = floor(vec2(x, z).div(tile));
  const tone: N = hash2(tileId).mul(0.12).add(0.94);
  const stain: N = mx_noise_float(vec3(x.mul(0.5), 2.0, z.mul(0.5))).mul(0.5).add(0.5);

  let color: N = mix(vec3(0.13, 0.13, 0.125), vec3(0.2, 0.196, 0.185), stain).mul(tone);
  color = mix(color, color.mul(0.55), joint.mul(0.8));
  const nearWalk: N = float(1).sub(smoothstep(0.02, 0.1, max(fwidth(x), fwidth(z))));
  // 有的地砖裂了，有的换过（颜色新一点）；地上零星的口香糖渍
  const cracked: N = step(0.82, hash2(tileId.add(11.0)));
  const crackLine: N = float(1).sub(smoothstep(0.0, 0.03, abs(mx_noise_float(vec3(x.mul(1.3), 4.0, z.mul(1.3)))))).mul(cracked).mul(nearWalk);
  color = mix(color, color.mul(0.4), crackLine);
  color = mix(color, color.mul(1.3), step(0.93, hash2(tileId.add(29.0))).mul(0.6));
  const gumCell: N = floor(vec2(x, z).mul(3.0));
  const gum: N = step(0.94, hash2(gumCell)).mul(smoothstep(0.16, 0.1, length(fract(vec2(x, z).mul(3.0)).sub(0.5)))).mul(nearWalk);
  color = mix(color, color.mul(0.45), gum);
  // 墙根和路缘边积的灰
  const grime: N = smoothstep(CITY.sidewalk - 0.9, CITY.sidewalk, toCurb).mul(stain.mul(0.5).add(0.5));
  color = color.mul(float(1).sub(grime.mul(0.35)));
  const curb: N = float(1).sub(smoothstep(0.26, 0.3, toCurb));
  color = mix(color, vec3(0.27, 0.27, 0.26).mul(stain.mul(0.2).add(0.85)), curb);
  // 侧面（路缘立面）也用路缘石的颜色
  color = mix(vec3(0.24, 0.24, 0.23), color, step(0.5, normalWorld.y));

  // 淋湿：地砖变深、带一点反光（头顶有遮挡的地方保持干燥）
  const open: N = smoothstep(0.5, 0.88, lightmap.sample(vec2(x, z)).a).mul(step(0.5, normalWorld.y));
  const wet: N = cityUniforms.wetness.mul(open);
  color = color.mul(mix(float(1.0), float(0.62), wet));

  // 积雪：人行道中间被人踩出一条发灰的道，露出一点地砖；两边和路缘上是没人碰过的白雪
  const lumpy: N = nz(x.mul(0.6), z.mul(0.6), 5).mul(0.5).add(0.5);
  const fleck: N = nz(x.mul(6.0), z.mul(6.0), 6).mul(0.5).add(0.5);
  const trodden: N = stripe(toCurb, CITY.sidewalk * 0.52, 0.75).mul(smoothstep(0.25, 0.7, nz(x.mul(0.21), z.mul(0.21), 7).mul(0.5).add(0.5)));
  const depth: N = cityUniforms.snow.mul(open).mul(lumpy.mul(0.4).add(0.72)).mul(float(1).sub(trodden.mul(0.6)));
  const snowMask: N = smoothstep(0.3, 0.55, depth.add(fleck.sub(0.5).mul(0.2)));
  const snowColor: N = mix(SNOW, vec3(0.16, 0.165, 0.175), trodden.mul(0.7)).mul(lumpy.mul(0.24).add(0.8)).mul(fleck.mul(0.16).add(0.92));
  color = mix(color, snowColor, snowMask);

  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  m.colorNode = withSurface(color, wet.mul(0.2).mul(float(1).sub(snowMask)), float(0.45));
  m.roughnessNode = mix(mix(mix(float(0.9), float(0.75), curb), float(0.5), wet), float(0.92), snowMask);
  return m;
}

/** 湖滨公园：草地 + 环形步道 + 内圈人行道 */
export function createParkMaterial(): THREE.MeshStandardNodeMaterial {
  const x: N = positionWorld.x;
  const z: N = positionWorld.z;
  const r: N = length(vec2(x.sub(LAKESHORE.cx), z.sub(LAKESHORE.cz)));
  const inner = LAKESHORE.radius - HALF_ROAD;
  const walk: N = smoothstep(inner - CITY.sidewalk - 0.05, inner - CITY.sidewalk + 0.05, r);
  const path: N = max(band(r, 96, 99.5), band(r, 38, 41));
  const n1: N = mx_noise_float(vec3(x.mul(0.12), 0.0, z.mul(0.12))).mul(0.5).add(0.5);
  const n2: N = mx_noise_float(vec3(x.mul(2.4), 3.0, z.mul(2.4))).mul(0.5).add(0.5);
  const grass: N = mix(vec3(0.045, 0.1, 0.022), vec3(0.09, 0.17, 0.04), n1).mul(n2.mul(0.35).add(0.8));
  const paving: N = mix(vec3(0.3, 0.29, 0.27), vec3(0.4, 0.39, 0.36), n1);
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  m.colorNode = mix(mix(grass, paving.mul(0.85), path), paving, walk);
  m.roughnessNode = float(0.92);
  return m;
}

/* ------------------------------------------------------------------ */
/* 水面                                                                 */
/* ------------------------------------------------------------------ */

export function createWaterMaterial(): THREE.MeshStandardNodeMaterial {
  const x: N = positionWorld.x;
  const z: N = positionWorld.z;
  const t: N = time.mul(0.35);
  // 两层方向不同的波纹叠加
  const n1: N = mx_noise_float(vec3(x.mul(0.18).add(t), t.mul(0.6), z.mul(0.26)));
  const n2: N = mx_noise_float(vec3(x.mul(0.55).sub(t.mul(1.3)), 4.0, z.mul(0.47).add(t)));
  const n3: N = mx_noise_float(vec3(x.mul(0.21), t.mul(0.5).add(9.0), z.mul(0.17).sub(t)));
  const n4: N = mx_noise_float(vec3(x.mul(0.49).add(t), 13.0, z.mul(0.6).sub(t.mul(1.2))));
  const nx: N = n1.mul(0.07).add(n2.mul(0.035));
  const nz: N = n3.mul(0.07).add(n4.mul(0.035));
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  m.colorNode = mix(vec3(0.006, 0.02, 0.026), vec3(0.012, 0.035, 0.04), n1.mul(0.5).add(0.5));
  m.roughnessNode = float(0.06);
  m.normalNode = normalize(vec3(nx, 1.0, nz)).transformDirection(cameraViewMatrix);
  return m;
}

/* ------------------------------------------------------------------ */
/* 其他                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 导向屏的尺寸（米）：箭头屏一格 aw × ah，红叉屏小一些，一格 cw × ch；
 * 架在箭头屏上方的那块大箭头是 bw × bh（三格箭头屏那么宽）
 */
export const LED_CELL = { aw: 3.05, ah: 2.9, cw: 2.44, ch: 1.5, bw: 9.15, bh: 2.9 };

/**
 * 弯道路口的 LED 导向屏。黑色的板子上一颗颗灯珠，白天也亮着。一个材质画三种屏，按 uv.y 落在哪一段分：
 * 0–1 箭头屏：uv.x = 第几格（朝着出弯的方向递增），一格一个「>」，亮光一格一格地朝出弯的方向追过去；
 * 2–3 红叉屏：一格一个红色的叉，表示这边封了；
 * 4–5 大箭头：整块屏是一个箭头，uv.x 从箭尾（0）到箭头尖（1）。
 */
function createLedBoardMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const u: N = uv().x;
  const kind: N = floor(uv().y.mul(0.5).add(0.25));
  const closed: N = step(0.5, kind).mul(float(1).sub(step(1.5, kind)));
  const big: N = step(1.5, kind);
  const v: N = uv().y.sub(kind.mul(2.0));
  const fx: N = fract(u);
  const cy: N = v.sub(0.5);
  // 抗锯齿用的宽度按没被截断的坐标算（fract 在格子边上是断的）
  const soft: N = max(fwidth(u).add(fwidth(v)), 0.002);
  const fill = (d: N, w: N): N => float(1).sub(smoothstep(w.negate(), w, d));

  // 箭头：一个「>」，尖朝着 u 增大的方向
  const arrow: N = fill(abs(fx.add(abs(cy).mul(0.74)).sub(0.63)).sub(0.145), soft).mul(fill(abs(cy).sub(0.41), soft));
  // 叉：按格子的高度量，画在格子中间
  const px: N = fx.sub(0.5).mul(LED_CELL.cw / LED_CELL.ch);
  const cross_: N = fill(abs(abs(px).sub(abs(cy))).sub(0.075), soft).mul(fill(max(abs(px), abs(cy)).sub(0.36), soft));
  // 大箭头：按米量。一根粗箭杆，前面一个三角
  const xm: N = u.mul(LED_CELL.bw);
  const ym: N = cy.mul(LED_CELL.bh);
  const softM: N = max(max(fwidth(xm), fwidth(ym)), 0.004);
  const neck = LED_CELL.bw - 3.5;
  const tip = LED_CELL.bw - 0.45;
  const shaft: N = fill(max(max(abs(ym).sub(0.5), float(0.5).sub(xm)), xm.sub(neck + 0.05)), softM);
  const head: N = fill(max(abs(ym).sub(float(tip).sub(xm).mul(1.24 / (tip - neck))), float(neck).sub(xm)), softM);
  const shape: N = mix(mix(arrow, cross_, closed), max(shaft, head), big);

  // 灯珠：十厘米一颗；离远了一颗比一个像素还小，就按平均亮度画
  const cellW: N = mix(mix(float(LED_CELL.aw), float(LED_CELL.cw), closed), float(LED_CELL.bw), big);
  const cellH: N = mix(mix(float(LED_CELL.ah), float(LED_CELL.ch), closed), float(LED_CELL.bh), big);
  const cell: N = vec2(u.mul(cellW).div(0.1), v.mul(cellH).div(0.1));
  const bead: N = float(1).sub(smoothstep(0.26, 0.44, length(fract(cell).sub(0.5))));
  const far: N = smoothstep(0.25, 0.9, max(fwidth(cell.x), fwidth(cell.y)));
  const dots: N = mix(bead, float(0.5), far);

  // 一道亮光顺着箭头的方向追过去（一秒走六格）；没轮到的地方也亮着，只是暗一些。大箭头和下面那排箭头是同一道光
  const along: N = mix(floor(u), u.mul(LED_CELL.bw / LED_CELL.aw).add(2.5), big);
  const chase: N = smoothstep(0.45, 1.0, fract(time.mul(1.2).sub(along.div(5.0))));
  const level: N = mix(chase.mul(mix(float(0.72), float(0.5), big)).add(mix(float(0.28), float(0.5), big)), sin(time.mul(3.0)).mul(0.12).add(0.88), closed);
  const night: N = smoothstep(0.1, 0.5, cityUniforms.lights);
  // 雾里灯要更亮才透得出来
  const gain: N = mix(float(3.4), float(5.2), night).mul(cityUniforms.haze.mul(2.0).add(1.0));
  const tone: N = mix(vec3(1.0, 0.56, 0.06), vec3(1.0, 0.07, 0.035), closed);
  const board: N = mix(vec3(0.03, 0.03, 0.032), vec3(0.006, 0.006, 0.007), night);
  m.colorNode = board.add(tone.mul(shape).mul(dots).mul(level).mul(gain)).add(tone.mul(dots).mul(0.012));
  return m;
}

export function createCityMaterials(lightmap: CityLightmap) {
  const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  const emissive = (r: number, g: number, b: number) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = vec3(r, g, b);
    return m;
  };
  // 护栏：红白相间的斜条纹
  const barrier = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
  {
    const d: N = positionWorld.x.add(positionWorld.z).add(positionWorld.y.mul(0.9));
    const s: N = step(fract(d.div(1.6)), 0.5);
    barrier.colorNode = mix(vec3(0.78, 0.78, 0.76), vec3(0.72, 0.03, 0.03), s);
  }
  // 树冠：按世界坐标做明暗斑驳，朝上的面亮、朝下的面暗；轮廓上按一张细碎的噪声挖洞，
  // 边缘就不是一条光滑的弧线，而是参差的叶子
  const leaves = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, side: THREE.DoubleSide });
  {
    const big: N = mx_noise_float(positionWorld.mul(0.7)).mul(0.5).add(0.5);
    const fine: N = mx_noise_float(positionWorld.mul(4.5)).mul(0.5).add(0.5);
    const up: N = normalWorld.y.mul(0.5).add(0.5);
    leaves.colorNode = mix(vec3(0.022, 0.06, 0.016), vec3(0.085, 0.165, 0.04), big)
      .mul(mix(float(0.5), float(1.2), up))
      .mul(mix(float(0.75), float(1.15), fine));
    const facing: N = abs(dot(normalize(normalView), normalize(positionView)));
    const holes: N = mx_noise_float(positionWorld.mul(3.4)).mul(0.5).add(0.5);
    leaves.opacityNode = step(mix(float(0.6), float(0.0), smoothstep(0.05, 0.6, facing)), holes);
    leaves.alphaTest = 0.5;
  }
  return {
    road: createRoadMaterial(lightmap),
    sidewalk: createSidewalkMaterial(lightmap),
    park: createParkMaterial(),
    facade: createFacadeMaterial(createShopSignAtlas(), graffitiAtlas()),
    water: createWaterMaterial(),
    roof: std(0x1b1c1f, 0.9),
    concrete: std(0x6f6e6a, 0.88),
    darkConcrete: std(0x3b3b3a, 0.9),
    /** 拱桥：芝加哥桥梁常见的暗红色钢结构 */
    steelRed: std(0x5a1c17, 0.55, 0.35),
    /** 平桥和高架铁路：深灰绿色的旧漆，一块块锈斑，往下挂着水渍 */
    steelDark: (() => {
      const m = std(0x24292a, 0.6, 0.4);
      const p: N = positionWorld;
      const rust: N = smoothstep(0.52, 0.8, mx_noise_float(p.mul(vec3(0.9, 0.35, 0.9))).mul(0.5).add(0.5));
      const fine: N = mx_noise_float(p.mul(6.0)).mul(0.5).add(0.5);
      const paint: N = mix(vec3(0.05, 0.075, 0.07), vec3(0.085, 0.1, 0.09), fine);
      m.colorNode = mix(paint, mix(vec3(0.16, 0.07, 0.035), vec3(0.24, 0.12, 0.06), fine), rust.mul(0.8));
      m.roughnessNode = mix(float(0.55), float(0.9), rust);
      m.metalnessNode = mix(float(0.35), float(0.1), rust);
      return m;
    })(),
    rail: std(0x2a2c30, 0.5, 0.6),
    metal: std(0x1d1f22, 0.45, 0.7),
    trunk: std(0x1e1610, 0.9),
    /** 树坑里的土 */
    soil: std(0x120e0a, 0.95),
    /** 屋顶水箱的木板 */
    wood: std(0x33261b, 0.88),
    leaves,
    barrier,
    /** 弯道路口的 LED 导向屏（箭头和红叉） */
    led: createLedBoardMaterial(),
    train: std(0xb9bec4, 0.35, 0.8),
    /** 列车车窗：入夜后车厢里亮着灯 */
    trainWindow: (() => {
      const m = std(0x0a0d10, 0.1, 0.2);
      m.emissiveNode = vec3(1.0, 0.84, 0.6).mul(cityUniforms.lights).mul(1.6);
      return m;
    })(),
    /** 路灯灯头：白天是一块浅色的灯罩，入夜后由 lights 点亮 */
    lamp: (() => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = mix(vec3(0.55, 0.55, 0.52), vec3(1.0, 0.6, 0.24).mul(9.0), smoothstep(0.1, 0.5, cityUniforms.lights));
      return m;
    })(),
    /** 下层街道的顶灯：白天也亮着 */
    tunnelLamp: emissive(3.2, 2.3, 1.0),
    signalRed: emissive(2.4, 0.08, 0.05),
    signalGreen: emissive(0.05, 1.8, 0.5),
  };
}

export type CityMaterials = ReturnType<typeof createCityMaterials>;
