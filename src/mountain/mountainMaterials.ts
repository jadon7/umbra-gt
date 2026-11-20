import * as THREE from 'three/webgpu';
import { abs, attribute, cameraViewMatrix, float, floor, fract, fwidth, length, max, min, mix, normalize, normalWorld, positionView, positionWorld, sin, smoothstep, step, texture, time, uv, vec2, vec3 } from 'three/tsl';
import { withSurface } from '../core/surface.ts';
import type { CityLightmap } from '../city/cityLights.ts';
import { band, cityUniforms, hash2, nz, SNOW, stripe } from '../city/materials.ts';
import { MOUNTAIN } from './mountainLayout.ts';
import { createCoverAtlas, createFoliageMaterial, createTreeAtlas } from './flora.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 沥青铺到离中心线多远（再往外是碎石路肩） */
export const PAVED = 8.6;

/* ------------------------------------------------------------------ */
/* 路面                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 山路的路面：沥青 + 标线 + 两侧的碎石路肩。
 * 和城市的路面不一样，这条路是弯的，标线没法按世界坐标算：路面网格的贴图坐标里带着
 * 「离中心线多远（米，左为正）」和「沿路走了多远（米）」，标线、车轮压出来的两道都按它们画。
 * 双向四车道：中间双黄线，两边各一道虚线，最外面是白色的边线。
 */
export function createMountainRoadMaterial(lightmap: CityLightmap): THREE.MeshStandardNodeMaterial {
  const x: N = positionWorld.x;
  const z: N = positionWorld.z;
  const across: N = abs(uv().x);
  const along: N = uv().y;
  const paved: N = float(1).sub(smoothstep(PAVED - 0.05, PAVED + 0.05, across));

  const yellow: N = stripe(across, 0.17, 0.06);
  const dash: N = stripe(across, 3.75, 0.065).mul(step(fract(along.div(12.0)), 0.34));
  const edge: N = stripe(across, 7.45, 0.075);
  const white: N = max(dash, edge);

  // 沥青：大尺度明暗 + 颗粒 + 轮迹（常走车的地方更黑更亮）
  const big: N = nz(x.mul(0.035), z.mul(0.035), 0).mul(0.5).add(0.5);
  const grain: N = nz(x.mul(9.0), z.mul(9.0), 1).mul(0.5).add(0.5);
  const wheelPath: N = max(stripe(across, 1.0, 0.5), max(stripe(across, 2.75, 0.5), max(stripe(across, 4.75, 0.5), stripe(across, 6.5, 0.5)))).mul(0.5);
  let asphalt: N = mix(vec3(0.03, 0.03, 0.032), vec3(0.058, 0.057, 0.056), big);
  asphalt = asphalt.mul(grain.mul(0.3).add(0.85));
  asphalt = asphalt.mul(float(1).sub(wheelPath.mul(0.2)));
  // 重铺过的路段：沿着路一段一段的，颜色深一点
  const relaid: N = step(0.72, hash2(vec2(floor(along.div(46.0)), 3.0))).mul(step(across, 3.6));
  asphalt = mix(asphalt, asphalt.mul(0.74), relaid.mul(0.8));
  // 只在近处看得见的细节
  const nearRoad: N = float(1).sub(smoothstep(0.02, 0.12, max(fwidth(x), fwidth(z))));
  const stone: N = nz(x.mul(31.0), z.mul(31.0), 2).mul(0.6).add(nz(x.mul(77.0), z.mul(77.0), 3).mul(0.4));
  asphalt = asphalt.mul(stone.mul(0.22).mul(nearRoad).add(1.0));
  // 裂缝和灌过缝的沥青条：山路保养得不错，比城里少
  const crackField: N = nz(x.mul(0.22), z.mul(0.22), 4).add(nz(x.mul(0.9), z.mul(0.9), 5).mul(0.25));
  const crackZone: N = smoothstep(0.55, 0.85, nz(x.mul(0.03), z.mul(0.03), 6).mul(0.5).add(0.5));
  const crack: N = float(1).sub(smoothstep(0.0, 0.02, abs(crackField))).mul(crackZone).mul(nearRoad);
  const sealed: N = float(1).sub(smoothstep(0.004, 0.035, abs(crackField.sub(0.3)))).mul(crackZone).mul(float(1).sub(smoothstep(0.03, 0.2, max(fwidth(x), fwidth(z)))));
  asphalt = mix(asphalt, vec3(0.012, 0.012, 0.013), max(crack.mul(0.7), sealed.mul(0.32)));
  // 白天的沥青是中灰色的，夜里灯下才显得黑
  const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));
  asphalt = asphalt.mul(mix(vec3(1.0, 1.0, 1.0), vec3(2.05, 1.92, 1.74), daylight));

  // 标线做旧
  const wear: N = nz(x.mul(6.5), z.mul(6.5), 8).mul(0.5).add(0.5);
  const wearBig: N = nz(x.mul(0.6), z.mul(0.6), 9).mul(0.5).add(0.5);
  const speck: N = nz(x.mul(31.0), z.mul(31.0), 10).mul(0.5).add(0.5);
  const worn: N = smoothstep(0.45, 0.85, wear.mul(0.35).add(wearBig.mul(0.65)).add(wheelPath.mul(0.2)));
  const paint: N = float(0.95)
    .mul(float(1).sub(worn.mul(smoothstep(0.32, 0.62, speck)).mul(0.7)))
    .mul(float(1).sub(max(crack, sealed).mul(0.8)));

  let color: N = asphalt;
  color = mix(color, vec3(0.52, 0.52, 0.5), white.mul(paint));
  color = mix(color, vec3(0.55, 0.39, 0.05), yellow.mul(paint));

  // 碎石路肩：沥青外面那一条。挨着沥青的一小段是被车轮带出来的砂土
  const pebble: N = nz(x.mul(4.3), z.mul(4.3), 11).mul(0.5).add(0.5);
  const grit: N = nz(x.mul(19.0), z.mul(19.0), 12).mul(0.5).add(0.5);
  const gravel: N = mix(vec3(0.085, 0.078, 0.066), vec3(0.17, 0.158, 0.135), pebble).mul(grit.mul(0.5).add(0.75)).mul(mix(float(1.0), float(1.5), daylight));
  color = mix(gravel, color, paved);

  /* ---- 潮湿和积雪：隧道里淋不到 ---- */
  const open: N = float(1).sub(lightmap.cover(positionWorld));
  const wet: N = cityUniforms.wetness.mul(open);
  const snowAmt: N = cityUniforms.snow.mul(open);
  const lumpy: N = nz(x.mul(0.5), z.mul(0.5), 12).mul(0.5).add(0.5);
  const fleck: N = nz(x.mul(5.0), z.mul(5.0), 13).mul(0.5).add(0.5);
  const fine: N = nz(x.mul(17.0), z.mul(17.0), 14).mul(0.5).add(0.5);
  // 车辙：四条车道各两道，边缘弯弯曲曲
  const wobble: N = nz(x.mul(0.3), z.mul(0.3), 9).mul(0.3).add(nz(x.mul(1.7), z.mul(1.7), 10).mul(0.1));
  const toRut: N = min(min(abs(across.sub(1.0)), abs(across.sub(2.75))), min(abs(across.sub(4.75)), abs(across.sub(6.5)))).add(wobble);
  const rutHalf: N = lumpy.mul(0.24).add(0.28);
  const rut: N = float(1).sub(smoothstep(rutHalf.mul(0.5), rutHalf.mul(1.9), toRut));
  const bank: N = smoothstep(PAVED - 2.2, PAVED - 0.6, across);
  const depth: N = snowAmt
    .mul(lumpy.mul(0.45).add(0.66))
    .mul(float(1).sub(rut.mul(0.86)))
    .add(bank.mul(snowAmt).mul(0.5));
  const snowMask: N = smoothstep(0.3, 0.62, depth.add(fleck.sub(0.5).mul(0.3)).add(fine.sub(0.5).mul(0.12)));
  const slushy: N = smoothstep(0.62, 0.3, depth).mul(0.55);
  const dirty: N = max(float(1).sub(bank).mul(0.34), slushy);
  const snowTone: N = lumpy.mul(0.3).add(0.74).mul(fleck.mul(0.2).add(0.9)).mul(fine.mul(0.16).add(0.92));
  const snowColor: N = mix(SNOW, vec3(0.13, 0.135, 0.145), dirty).mul(snowTone);
  // 水洼：路是有坡、有横坡的，水大多流走了，只在边上和低洼处留一点
  const terrain: N = nz(x.mul(0.085), z.mul(0.085), 11)
    .mul(0.35)
    .add(nz(x.mul(0.31), z.mul(0.31), 12).mul(0.15))
    .add(0.5)
    .sub(smoothstep(PAVED - 2.6, PAVED - 0.4, across).mul(0.16));
  const level: N = mix(float(0.1), float(0.27), wet);
  const puddle: N = smoothstep(level, level.sub(0.06), terrain).mul(smoothstep(0.4, 0.7, wet)).mul(paved);
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
  const film: N = vec2(nz(x.mul(3.1), z.mul(3.1), 13), nz(x.mul(3.1), z.mul(3.1), 14)).mul(0.035);
  const bump: N = ripples.mul(mix(float(0.06), float(0.3), puddle)).add(film.mul(float(1).sub(puddle))).mul(wet).mul(paved);

  color = color.mul(mix(float(1.0), mix(float(0.62), float(0.5), paved), wet));
  color = mix(color, color.mul(0.45), puddle);
  color = mix(color, snowColor, snowMask);

  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  // 干路面白天不反光，入夜后贴着地面看有一层淡淡的反光；越湿反射越强，水洼里接近镜面；雪面和碎石不反光
  const dryReflect: N = mix(float(0.0), float(0.07), smoothstep(0.15, 0.6, cityUniforms.lights));
  const reflect: N = mix(mix(dryReflect, float(0.3), wet), float(0.85), puddle).mul(float(1).sub(snowMask)).mul(paved);
  const blur: N = mix(mix(float(0.74), float(0.5), wet), float(0.03), puddle);
  m.colorNode = withSurface(color, reflect, blur);
  // 反光道钉：边线上每 12 米一颗白的，中线上每 12 米一对黄的。入夜后是路面上的两串小亮点，
  // 没有路灯的路段靠它们看出前面的路往哪拐
  const studAt: N = abs(fract(along.div(12.0)).sub(0.5)).mul(12.0);
  const stud: N = float(1).sub(smoothstep(0.05, 0.08, studAt));
  const whiteStud: N = stripe(across, 7.45, 0.055).mul(stud);
  const amberStud: N = stripe(across, 0.17, 0.05).mul(stud);
  const night: N = smoothstep(0.2, 0.8, cityUniforms.lights);
  m.emissiveNode = vec3(0.9, 0.95, 1.0)
    .mul(whiteStud)
    .add(vec3(1.0, 0.62, 0.1).mul(amberStud))
    .mul(night)
    .mul(2.2)
    .mul(float(1).sub(snowMask));
  const dryRough: N = mix(float(0.88), float(0.62), max(white, yellow).mul(paint)).sub(wheelPath.mul(0.12)).sub(sealed.mul(0.45));
  const roadRough: N = mix(mix(dryRough, float(0.45), wet), float(0.05), puddle);
  m.roughnessNode = mix(mix(float(0.96), roadRough, paved), float(0.9), snowMask);
  const snowBump: N = vec2(nz(x.mul(2.3), z.mul(2.3), 4), nz(x.mul(2.3), z.mul(2.3), 5)).mul(0.3).add(vec2(nz(x.mul(9.0), z.mul(9.0), 6), nz(x.mul(9.0), z.mul(9.0), 7)).mul(0.14)).mul(snowMask);
  // 碎石路肩坑坑洼洼
  const rough: N = vec2(nz(x.mul(6.0), z.mul(6.0), 0), nz(x.mul(6.0), z.mul(6.0), 1)).mul(0.22).mul(float(1).sub(paved)).mul(float(1).sub(snowMask));
  const nW: N = normalize(normalWorld.add(vec3(bump.x.mul(float(1).sub(snowMask)).add(snowBump.x).add(rough.x), 0.0, bump.y.mul(float(1).sub(snowMask)).add(snowBump.y).add(rough.y))));
  m.normalNode = nW.transformDirection(cameraViewMatrix);
  return m;
}

/* ------------------------------------------------------------------ */
/* 山体                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 山体：缓的地方是草和林下的土，陡的地方露出石头，水边是卵石滩，很高的地方终年有雪。
 * 贴着路的那一小条是碎石（顶点属性 aEdge = 离路面边缘多远）。全部按世界坐标算，不用贴图坐标。
 */
export function createTerrainMaterial(lightmap: CityLightmap): THREE.MeshStandardNodeMaterial {
  const p: N = positionWorld;
  const x: N = p.x;
  const z: N = p.z;
  const edge: N = attribute('aEdge', 'float');
  const dist: N = length(positionView);

  const big: N = nz(x.mul(0.012), z.mul(0.012), 0).mul(0.5).add(0.5);
  const mid: N = nz(x.mul(0.07), z.mul(0.07), 1).mul(0.5).add(0.5);
  const small: N = nz(x.mul(0.6), z.mul(0.6), 2).mul(0.5).add(0.5);
  const grit: N = nz(x.mul(5.5), z.mul(5.5), 3).mul(0.5).add(0.5);
  const near: N = float(1).sub(smoothstep(0.05, 0.4, max(fwidth(x), fwidth(z))));
  const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));

  // 把法线按噪声搅一搅：远山的网格是七十五米一格的，不搅的话是一团光滑的奶油。
  // 搅过以后山坡上有了沟和梁——哪儿露石头、哪儿挂得住雪、哪儿背光，都跟着它走
  const farness: N = smoothstep(160.0, 700.0, dist);
  const g1: N = vec2(nz(x.mul(0.0062), z.mul(0.0062), 14), nz(x.mul(0.0062).add(31.7), z.mul(0.0062).sub(12.3), 15));
  const g2: N = vec2(nz(x.mul(0.027), z.mul(0.027), 16), nz(x.mul(0.027).add(11.1), z.mul(0.027).add(5.7), 17));
  const g3: N = vec2(nz(x.mul(0.13), z.mul(0.13), 18), nz(x.mul(0.13).add(3.3), z.mul(0.13).sub(8.1), 19));
  const stir: N = g1.mul(farness.mul(0.8)).add(g2.mul(farness.mul(0.45).add(0.07))).add(g3.mul(0.06));
  const nrm: N = normalize(normalWorld.add(vec3(stir.x, 0.0, stir.y)));
  const up: N = nrm.y;

  // 草地：一片深一片浅；高处、朝阳的地方草是干的，金黄色；谷底的阔叶林下面铺着落叶
  let grass: N = mix(vec3(0.022, 0.04, 0.015), vec3(0.05, 0.072, 0.026), big);
  const dry: N = smoothstep(0.42, 0.78, mid.add(smoothstep(40.0, 95.0, p.y).mul(0.22)));
  grass = mix(grass, mix(vec3(0.1, 0.085, 0.036), vec3(0.15, 0.125, 0.055), small), dry.mul(0.75));
  grass = grass.mul(small.mul(0.5).add(0.75)).mul(grit.mul(0.3).mul(near).add(0.85));
  const litter: N = smoothstep(0.5, 0.75, nz(x.mul(0.11), z.mul(0.11), 20).mul(0.5).add(0.5)).mul(float(1).sub(smoothstep(30.0, 44.0, p.y)));
  grass = mix(grass, mix(vec3(0.11, 0.05, 0.02), vec3(0.16, 0.1, 0.03), grit), litter.mul(0.6));
  // 林下：树多的山坡，地上是针叶和土，颜色暗
  const duff: N = mix(vec3(0.045, 0.036, 0.024), vec3(0.08, 0.064, 0.038), small);
  grass = mix(grass, duff, smoothstep(0.45, 0.7, nz(x.mul(0.03), z.mul(0.03), 4).mul(0.5).add(0.5)).mul(0.7));

  // 石头：一层一层的（沿高度的条带被噪声扭一扭），黄褐色里夹着灰，缝里发暗
  const warp: N = nz(x.mul(0.05), z.mul(0.05), 5).mul(4.0).add(nz(x.mul(0.31), z.mul(0.31), 6).mul(0.8));
  const strata: N = nz(p.y.add(warp).mul(0.42), x.add(z).mul(0.03), 7).mul(0.5).add(0.5);
  let rock: N = mix(vec3(0.1, 0.085, 0.066), vec3(0.27, 0.225, 0.165), strata);
  rock = mix(rock, mix(vec3(0.085, 0.085, 0.082), vec3(0.2, 0.2, 0.19), strata), smoothstep(0.45, 0.7, big));
  rock = rock.mul(small.mul(0.4).add(0.8)).mul(grit.mul(0.35).mul(near).add(0.82));
  const seam: N = float(1).sub(smoothstep(0.0, 0.05, abs(nz(p.y.add(warp).mul(0.9), x.sub(z).mul(0.07), 8))));
  rock = mix(rock, rock.mul(0.42), seam.mul(0.7));

  // 远处的山坡上是成片的树林（一棵棵树只种到路边一两百米）：离镜头远了就按林子的颜色画，
  // 一团团的树冠有明有暗，中间露着草地
  const away: N = smoothstep(240.0, 560.0, dist);
  const clump: N = nz(x.mul(0.16), z.mul(0.16), 10).mul(0.5).add(0.5);
  const canopy: N = mix(vec3(0.01, 0.022, 0.012), vec3(0.03, 0.05, 0.022), clump).mul(nz(x.mul(0.045), z.mul(0.045), 9).mul(0.3).add(0.85));
  const wooded: N = smoothstep(0.34, 0.56, nz(x.mul(0.0118).add(3.1), z.mul(0.0118).sub(1.7), 21).mul(0.5).add(0.5));
  // 树长不到太高的地方：林线以上是碎石和草甸
  const treeline: N = float(1).sub(smoothstep(230.0, 320.0, p.y.add(mid.mul(60.0))));
  grass = mix(grass, canopy, away.mul(treeline).mul(wooded.mul(0.75).add(0.2)));
  grass = mix(grass, mix(vec3(0.085, 0.075, 0.055), vec3(0.13, 0.115, 0.08), mid), float(1).sub(treeline).mul(0.85));
  // 坡度超过三十几度就挂不住土了
  const steep: N = smoothstep(0.2, 0.38, float(1).sub(up).add(mid.sub(0.5).mul(0.1)));
  let color: N = mix(grass, rock, steep);
  // 水边的卵石滩
  const shore: N = smoothstep(MOUNTAIN.lake + 2.2, MOUNTAIN.lake + 0.5, p.y.add(small.mul(0.8)));
  color = mix(color, mix(vec3(0.1, 0.095, 0.085), vec3(0.2, 0.19, 0.17), grit), shore);
  // 贴着路的碎石和被翻开的土
  const verge: N = float(1).sub(smoothstep(2.6, 5.5, edge.add(small.sub(0.5).mul(2.4))));
  const pebble: N = nz(x.mul(4.3), z.mul(4.3), 11).mul(0.5).add(0.5);
  color = mix(color, mix(vec3(0.095, 0.082, 0.064), vec3(0.185, 0.165, 0.13), pebble).mul(grit.mul(0.5).add(0.75)), verge.mul(float(1).sub(steep.mul(0.6))));
  color = color.mul(mix(float(1.0), float(1.3), daylight));

  // 远处的高山：雪线以上有雪，但只在缓的地方挂得住——陡的石壁是露着的，一道道往下伸
  const cap: N = smoothstep(420.0, 540.0, p.y.add(big.mul(80.0)).add(g2.x.mul(40.0))).mul(smoothstep(0.62, 0.8, up));
  // 天气带来的雪：朝上的面盖一层，陡的石壁上挂不住
  const patchy: N = nz(x.mul(0.9), z.mul(0.9), 3).mul(0.5).add(0.5);
  const open: N = float(1).sub(lightmap.cover(p));
  const fresh: N = smoothstep(0.25, 0.6, cityUniforms.snow.mul(smoothstep(0.5, 0.82, up)).mul(open).mul(patchy.mul(0.5).add(0.75)));
  const snowMask: N = max(cap, fresh);
  const shade: N = nz(x.mul(0.33), z.mul(0.33), 2).mul(0.08).add(0.96);

  const wet: N = cityUniforms.wetness.mul(open);
  color = color.mul(mix(float(1.0), float(0.68), wet));
  color = mix(color, SNOW.mul(shade).mul(mix(float(1.0), float(1.7), cap.mul(daylight))), snowMask);

  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, side: THREE.DoubleSide });
  m.colorNode = color;
  m.roughnessNode = mix(mix(mix(float(0.96), float(0.86), steep), float(0.7), wet.mul(steep)), float(0.92), snowMask);
  m.normalNode = nrm.transformDirection(cameraViewMatrix);
  return m;
}

/* ------------------------------------------------------------------ */
/* 混凝土、护栏、树                                                     */
/* ------------------------------------------------------------------ */

/** 混凝土（桥、隧道口、防撞墙）：模板的接缝、往下挂的水渍 */
function createConcrete(tone: number): THREE.MeshStandardNodeMaterial {
  const p: N = positionWorld;
  const big: N = nz(p.x.mul(0.21), p.z.mul(0.21).add(p.y.mul(0.17)), 0).mul(0.5).add(0.5);
  const grain: N = nz(p.x.mul(6.0).add(p.y.mul(3.0)), p.z.mul(6.0), 1).mul(0.5).add(0.5);
  // 水渍：竖着的一道道
  const streak: N = smoothstep(0.55, 0.9, nz(p.x.add(p.z).mul(1.6), p.y.mul(0.12), 2).mul(0.5).add(0.5)).mul(float(1).sub(abs(normalWorld.y)));
  let color: N = mix(vec3(0.19, 0.185, 0.175), vec3(0.3, 0.295, 0.28), big).mul(grain.mul(0.25).add(0.86)).mul(tone);
  color = mix(color, color.mul(0.5), streak.mul(0.6));
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, side: THREE.DoubleSide });
  m.colorNode = color;
  m.roughnessNode = float(0.86);
  return m;
}

/** 隧道内壁：浅色的瓷砖墙裙、上面是喷过的混凝土；贴图坐标 = （绕着拱走了多远，沿着隧道走了多远），单位米 */
function createTunnelLining(): THREE.MeshStandardNodeMaterial {
  const around: N = uv().x;
  const along: N = uv().y;
  const p: N = positionWorld;
  const grain: N = nz(p.x.mul(5.0).add(p.y.mul(2.0)), p.z.mul(5.0), 1).mul(0.5).add(0.5);
  const stain: N = nz(along.mul(0.35), around.mul(0.5), 2).mul(0.5).add(0.5);
  // 伸缩缝：每 8 米一道
  const joint: N = float(1).sub(smoothstep(0.02, 0.06, abs(fract(along.div(8.0)).sub(0.5)).mul(8.0)));
  // 墙裙：两侧离地 3 米以内贴瓷砖，上沿一道深色的腰线
  const skirt: N = attribute('aSkirt', 'float');
  const tile: N = float(1).sub(smoothstep(0.012, 0.03, min(abs(fract(along.div(0.6)).sub(0.5)).mul(0.6), abs(fract(around.div(0.3)).sub(0.5)).mul(0.3))));
  const upper: N = mix(vec3(0.1, 0.098, 0.092), vec3(0.17, 0.165, 0.155), stain).mul(grain.mul(0.3).add(0.82));
  const lower: N = mix(vec3(0.36, 0.36, 0.34), vec3(0.47, 0.47, 0.44), stain).mul(float(1).sub(tile.mul(0.45)));
  let color: N = mix(upper, lower, smoothstep(0.45, 0.55, skirt));
  color = mix(color, vec3(0.05, 0.05, 0.05), band(skirt, 0.4, 0.5).mul(0.9));
  color = mix(color, color.mul(0.45), joint.mul(0.8));
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, side: THREE.DoubleSide });
  m.colorNode = color;
  m.roughnessNode = mix(float(0.9), float(0.38), smoothstep(0.45, 0.55, skirt));
  return m;
}

/** 弯道外侧的导向牌：黄底黑箭头。牌面朝哪边由贴图坐标决定（左弯、右弯各翻一下） */
function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0c0c0c';
  g.fillRect(0, 0, 256, 192);
  g.fillStyle = '#f0b800';
  g.fillRect(8, 8, 240, 176);
  g.fillStyle = '#0c0c0c';
  for (const x0 of [36, 132]) {
    g.beginPath();
    g.moveTo(x0, 22);
    g.lineTo(x0 + 44, 22);
    g.lineTo(x0 + 92, 96);
    g.lineTo(x0 + 44, 170);
    g.lineTo(x0, 170);
    g.lineTo(x0 + 48, 96);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 广告牌的画面：几块虚构的牌子拼在一张图上，从上到下一行一块 */
export const BILLBOARDS = 6;
function billboardTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 440;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H * BILLBOARDS;
  const g = c.getContext('2d')!;
  const ads: { bg: [string, string]; ink: string; accent: string; big: string; small: string }[] = [
    { bg: ['#0b0b10', '#1c1030'], ink: '#f4f4f0', accent: '#ff3b2f', big: 'UMBRA GT', small: 'OWN THE NIGHT' },
    { bg: ['#f2c200', '#ff8a00'], ink: '#101014', accent: '#101014', big: 'NITRO+', small: 'HIGH OCTANE BOOSTER' },
    { bg: ['#06202c', '#0a4a5a'], ink: '#e9fbff', accent: '#35e0ff', big: 'KAZE TYRES', small: 'GRIP · SLIDE · REPEAT' },
    { bg: ['#16161a', '#2c2c33'], ink: '#f4f4f2', accent: '#ff3b2f', big: '云岭山道', small: 'CLOUD RIDGE PASS · 3.9 KM' },
    { bg: ['#3a0a0a', '#8a1410'], ink: '#fff2e0', accent: '#ffb000', big: 'RONIN', small: 'TURBO AWD · 4 RINGS OF FIRE' },
    { bg: ['#0d2a14', '#1f5a2a'], ink: '#eaffea', accent: '#7dff5a', big: 'VOLT', small: 'ENERGY DRINK · STAY SIDEWAYS' },
  ];
  ads.forEach((ad, k) => {
    const y0 = k * H;
    const grad = g.createLinearGradient(0, y0, W, y0 + H);
    grad.addColorStop(0, ad.bg[0]);
    grad.addColorStop(1, ad.bg[1]);
    g.fillStyle = grad;
    g.fillRect(0, y0, W, H);
    // 斜条
    g.fillStyle = ad.accent;
    g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(W - 250, y0);
    g.lineTo(W - 170, y0);
    g.lineTo(W - 330, y0 + H);
    g.lineTo(W - 410, y0 + H);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = ad.ink;
    g.textBaseline = 'middle';
    g.font = `italic 900 ${ad.big.length > 7 ? 150 : 190}px Impact, "Arial Narrow Bold", "PingFang SC", sans-serif`;
    g.fillText(ad.big, 56, y0 + H * 0.43);
    g.fillStyle = ad.accent;
    g.fillRect(60, y0 + H * 0.7, 420, 8);
    g.fillStyle = ad.ink;
    g.font = '700 44px "Arial Narrow", Arial, sans-serif';
    g.fillText(ad.small, 60, y0 + H * 0.83);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function createMountainMaterials(lightmap: CityLightmap) {
  const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  const lit: N = smoothstep(0.1, 0.5, cityUniforms.lights);

  // 护栏：镀锌钢板，旧了有点发乌
  const rail = std(0x8d9093, 0.5, 0.75);
  {
    const p: N = positionWorld;
    const worn: N = nz(p.x.mul(0.8).add(p.y.mul(2.0)), p.z.mul(0.8), 3).mul(0.5).add(0.5);
    rail.colorNode = mix(vec3(0.2, 0.205, 0.21), vec3(0.42, 0.43, 0.44), worn);
    rail.roughnessNode = mix(float(0.62), float(0.4), worn);
  }
  // 导向牌：被车灯一照就亮（反光膜），所以接灯光的时候给它放大几倍（见 MountainWorld.finishLighting）
  const chevron = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
  chevron.colorNode = (texture(chevronTexture()) as N).rgb;
  // 广告牌：入夜后有灯打着
  const billboard = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });
  {
    const tex: N = (texture(billboardTexture()) as N).rgb;
    billboard.colorNode = tex;
    billboard.emissiveNode = tex.mul(lit.mul(1.25));
  }
  // 路边的反光柱头：白天是一小块橙色的塑料，夜里微微发亮
  const reflector = new THREE.MeshBasicNodeMaterial();
  reflector.colorNode = mix(vec3(0.5, 0.2, 0.03), vec3(2.6, 0.9, 0.12), lit);
  const lamp = new THREE.MeshBasicNodeMaterial();
  lamp.colorNode = mix(vec3(0.55, 0.55, 0.52), vec3(1.0, 0.6, 0.24).mul(9.0), lit);
  // 隧道里的灯白天也亮着
  const tunnelLamp = new THREE.MeshBasicNodeMaterial();
  tunnelLamp.colorNode = vec3(3.4, 2.3, 0.95);
  // 起点龙门架上的灯带
  const gantryStrip = new THREE.MeshBasicNodeMaterial();
  gantryStrip.colorNode = mix(vec3(0.85, 0.75, 0.02), vec3(1.7, 1.5, 0.05), lit);

  return {
    road: createMountainRoadMaterial(lightmap),
    terrain: createTerrainMaterial(lightmap),
    concrete: createConcrete(1),
    darkConcrete: createConcrete(0.6),
    lining: createTunnelLining(),
    rail,
    post: std(0x3a3d40, 0.6, 0.5),
    steel: std(0x1d1f22, 0.5, 0.7),
    /** 树和地面上的草木：面片，见 flora.ts */
    tree: createFoliageMaterial(createTreeAtlas(), 0.5, 0.22),
    cover: createFoliageMaterial(createCoverAtlas(), 0.5, 0.05),
    rock: (() => {
      const m = std(0x55524c, 0.9);
      const p: N = positionWorld;
      const a: N = nz(p.x.mul(0.5).add(p.y.mul(0.7)), p.z.mul(0.5), 6).mul(0.5).add(0.5);
      const b: N = nz(p.x.mul(4.0), p.z.mul(4.0).add(p.y.mul(3.0)), 7).mul(0.5).add(0.5);
      const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));
      // 一层一层的黄褐色砂岩，缝里发暗
      const strata: N = nz(p.y.mul(0.9).add(a.mul(1.5)), p.x.add(p.z).mul(0.05), 8).mul(0.5).add(0.5);
      const seam: N = float(1).sub(smoothstep(0.0, 0.06, abs(nz(p.y.mul(1.7).add(a), p.x.sub(p.z).mul(0.09), 9))));
      let c: N = mix(vec3(0.1, 0.085, 0.066), vec3(0.27, 0.225, 0.165), strata);
      c = mix(c, vec3(0.13, 0.13, 0.125), smoothstep(0.55, 0.8, a).mul(0.6));
      c = mix(c, c.mul(0.45), seam.mul(0.6));
      m.colorNode = c.mul(b.mul(0.35).add(0.8)).mul(mix(float(1.0), float(1.4), daylight));
      return m;
    })(),
    chevron,
    billboard,
    reflector,
    lamp,
    tunnelLamp,
    gantryStrip,
  };
}

export type MountainMaterials = ReturnType<typeof createMountainMaterials>;
