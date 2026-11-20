import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
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
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { withSurface } from '../core/surface.ts';
import { GROUND_FLOOR, SHOP_BAY } from './cityLayout.ts';
import { facesTurnApproach } from './turnMap.ts';
import { cityUniforms } from './materials.ts';
import { SHOP_SIGN_CELL, SHOP_SIGN_COLS, SHOP_SIGN_ROWS } from './shopSigns.ts';
import { GRAFFITI_COLS, GRAFFITI_ROWS } from './graffiti.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const hash2 = (p: N): N => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
/** d 落在 [a, b] 区间内（边缘按屏幕像素抗锯齿） */
const band = (d: N, a: N | number, b: N | number): N => {
  const w = max(fwidth(d), 0.0005);
  return smoothstep(float(a).sub(w), float(a).add(w), d).mul(float(1).sub(smoothstep(float(b).sub(w), float(b).add(w), d)));
};
const inv = (x: N): N => float(1).sub(x);


/**
 * 楼体立面。整座城市的楼只用这一种材质，所有细节按墙面坐标程序化算出来：
 *
 *  - 墙面：砖（一块块砖带色差和灰缝）、石材（分块）、金属板、玻璃幕墙，带雨水污迹、腰线和檐口
 *  - 窗：每扇窗后面是一间"房间"。不是真的几何体，而是按视线算出它打在房间的哪面墙上
 *    （后墙、侧墙、天花板、地板），所以走过时能看到屋里的东西随视角错动。
 *    夜里只有一部分房间亮灯，亮度、色温各不相同；有的拉着百叶或窗帘
 *  - 底层：一家家店，橱窗里能看到货架，门楣上是店招（从图集里挑），
 *    关门的店拉着卷帘门。哪家店亮灯由顶点属性 aShop 给出，和地面光照图里的店面灯光对得上
 *
 * 顶点属性：
 *   aInfo = (立面风格 0–3, 随机种子, 开间宽度, 层高)
 *   aSize = (这面墙的总宽, 楼的总高)
 *   aShop = 这面墙上哪几家店亮着灯（按位）
 * uv = (沿墙面的水平距离, 离地高度)，单位米。
 */
export function createFacadeMaterial(signs: THREE.Texture, graffiti: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const info: N = attribute('aInfo', 'vec4');
  const size: N = attribute('aSize', 'vec2');
  const shopBits: N = attribute('aShop', 'float');
  const u: N = uv().x;
  const v: N = uv().y;
  const style: N = info.x;
  const seed: N = info.y;
  const bay: N = info.z;
  const floorH: N = info.w;
  const L: N = cityUniforms.lights;

  const isGlass: N = inv(step(0.5, style));
  const isStone: N = step(0.5, style).mul(inv(step(1.5, style)));
  const isBrick: N = step(1.5, style).mul(inv(step(2.5, style)));
  const isDark: N = step(2.5, style);
  const masonry: N = isStone.add(isBrick);

  /* ---------------- 视线在墙面坐标系里的方向 ---------------- */
  // x 沿墙面（u 增大的方向）、y 向上、z 往楼里
  const upW: N = vec3(0.0, 1.0, 0.0);
  const tangent: N = normalize(cross(upW, normalWorld));
  const view: N = normalize(positionWorld.sub(cameraPosition));
  const rdx: N = dot(view, tangent);
  const rdy: N = view.y;
  const rdz: N = max(dot(view, normalWorld).negate(), 0.03);
  const sx: N = step(0.0, rdx);
  const sy: N = step(0.0, rdy);
  const dirX: N = mix(float(-1), float(1), sx).mul(max(abs(rdx), 1e-4));
  const dirY: N = mix(float(-1), float(1), sy).mul(max(abs(rdy), 1e-4));

  /**
   * 从窗玻璃上的一点往屋里看，视线先碰到房间的哪个面。
   * fx, fy 是这一点在房间正面上的位置（0–1），w、h、depth 是房间的宽、高、进深（米）
   */
  const trace = (fx: N, fy: N, w: N | number, h: N | number, depth: N | number) => {
    const ox: N = fx.mul(w);
    const oy: N = fy.mul(h);
    const tx: N = sx.mul(w).sub(ox).div(dirX);
    const ty: N = sy.mul(h).sub(oy).div(dirY);
    const tz: N = float(depth).div(rdz);
    const t: N = min(min(tx, ty), tz);
    const back: N = step(tz, min(tx, ty));
    const side: N = inv(back).mul(step(tx, ty));
    const flat: N = inv(back).sub(side);
    const ceil: N = flat.mul(sy);
    return { hx: ox.add(dirX.mul(t)), hy: oy.add(dirY.mul(t)), hz: rdz.mul(t), back, side, ceil, floor: flat.sub(ceil) };
  };

  /* ---------------- 标准层：窗洞 ---------------- */
  const cu: N = u.div(bay);
  const cv: N = v.sub(GROUND_FLOOR).div(floorH);
  const cellId: N = vec2(floor(cu), floor(cv));
  const f: N = vec2(fract(cu), fract(cv));
  // 窗洞四周的墙宽（占格子的比例）
  const mx: N = isGlass.mul(0.03).add(isStone.mul(0.21)).add(isBrick.mul(0.25)).add(isDark.mul(0.05));
  const myBottom: N = isGlass.mul(0.17).add(isStone.mul(0.27)).add(isBrick.mul(0.3)).add(isDark.mul(0.3));
  const myTop: N = isGlass.mul(0.03).add(isStone.mul(0.15)).add(isBrick.mul(0.16)).add(isDark.mul(0.14));
  const wx: N = max(fwidth(cu), 0.002);
  const wy: N = max(fwidth(cv), 0.002);
  const inX: N = smoothstep(mx.sub(wx), mx.add(wx), f.x).mul(inv(smoothstep(inv(mx).sub(wx), inv(mx).add(wx), f.x)));
  const inY: N = smoothstep(myBottom.sub(wy), myBottom.add(wy), f.y).mul(inv(smoothstep(inv(myTop).sub(wy), inv(myTop).add(wy), f.y)));
  // 楼的两端和顶部留实墙
  const edge: N = smoothstep(0.5, 0.65, u).mul(inv(smoothstep(size.x.sub(0.65), size.x.sub(0.5), u)));
  const parapet: N = inv(smoothstep(size.y.sub(1.5), size.y.sub(1.3), v));
  const upper: N = step(GROUND_FLOOR, v);
  const windowMask: N = inX.mul(inY).mul(edge).mul(parapet).mul(upper);
  // 窗洞里的坐标 0–1
  const px: N = clamp(f.x.sub(mx).div(inv(mx.mul(2.0))), 0, 1);
  const py: N = clamp(f.y.sub(myBottom).div(inv(myBottom.add(myTop))), 0, 1);

  const h1: N = hash2(cellId.add(vec2(seed, seed.mul(0.37))));
  const h2: N = hash2(cellId.mul(1.7).add(vec2(seed.mul(0.11), 3.1)));
  const h3: N = hash2(cellId.mul(2.3).add(vec2(9.7, seed.mul(0.53))));

  /* ---------------- 住宅 / 普通楼的房间 ---------------- */
  const homeW: N = bay.mul(inv(mx.mul(2.0)));
  const homeH: N = floorH.mul(inv(myBottom.add(myTop))).add(0.9);
  const homeD: N = h3.mul(2.5).add(3.2);
  // 窗台以下还有 0.9 米的墙：房间的地板比窗洞下沿低
  const home = trace(px, py.mul(homeH.sub(0.9)).add(0.9).div(homeH), homeW, homeH, homeD);
  const wallWarm: N = mix(vec3(0.62, 0.54, 0.42), vec3(0.56, 0.42, 0.34), h3);
  const wallCool: N = mix(vec3(0.5, 0.55, 0.58), vec3(0.42, 0.5, 0.46), h3);
  const homeWall: N = mix(wallWarm, wallCool, step(0.68, h2));
  const hfu: N = home.hx.div(homeW);
  const hfv: N = home.hy.div(homeH);
  // 后墙：靠墙一排高低不一的家具，偶尔一幅画或一扇门
  const furnTop: N = hash2(vec2(floor(hfu.mul(3.0)), h1.mul(31.0))).mul(0.3).add(0.14);
  const furniture: N = inv(smoothstep(furnTop.sub(0.012), furnTop, hfv));
  const frameX: N = h1.mul(0.5).add(0.2);
  const picture: N = band(hfu, frameX, frameX.add(0.2)).mul(band(hfv, 0.52, 0.76));
  const homeBack: N = mix(homeWall, homeWall.mul(vec3(0.22, 0.2, 0.2)), furniture);
  const homeBack2: N = mix(homeBack, mix(vec3(0.75, 0.7, 0.6), vec3(0.12, 0.16, 0.2), step(0.5, h2)), picture.mul(inv(furniture)).mul(0.8));
  const homeColor: N = homeBack2
    .mul(home.back)
    .add(homeWall.mul(0.74).mul(home.side))
    .add(vec3(0.72, 0.7, 0.66).mul(home.ceil))
    .add(mix(vec3(0.2, 0.14, 0.09), vec3(0.16, 0.16, 0.17), step(0.5, h1)).mul(home.floor));
  // 一盏吸顶灯：离灯越远越暗，天花板上灯的位置最亮
  const hl: N = vec3(home.hx.sub(homeW.mul(0.5)), home.hy.sub(homeH.mul(0.94)), home.hz.sub(homeD.mul(0.5)));
  const homeFall: N = float(1.5).div(dot(hl, hl).mul(0.42).add(1.0));
  const homeFixture: N = home.ceil.mul(smoothstep(0.55, 0.12, length(vec2(hl.x, hl.z))));
  const homeLit: N = homeColor.mul(homeFall).add(homeFixture.mul(1.6));

  /* ---------------- 写字楼的大开间 ---------------- */
  const SPAN = 4.0;
  const ou: N = cu.div(SPAN);
  const officeId: N = vec2(floor(ou), floor(cv));
  const o1: N = hash2(officeId.add(vec2(seed.mul(0.7), 5.3)));
  const office = trace(fract(ou), f.y, bay.mul(SPAN), floorH, float(9.0));
  // 天花板上一排排灯盘；后墙是隔断和门，地上一排工位
  const panel: N = band(fract(office.hx.div(1.6)), 0.2, 0.8).mul(band(fract(office.hz.div(2.8)), 0.3, 0.7));
  const desks: N = inv(smoothstep(0.26, 0.28, office.hy.div(floorH))).mul(step(0.3, hash2(vec2(floor(office.hx.div(1.4)), o1.mul(17.0)))));
  const partition: N = band(fract(office.hx.div(3.2)), 0.0, 0.06);
  const officeWall: N = mix(vec3(0.5, 0.52, 0.54), vec3(0.58, 0.55, 0.5), o1);
  const officeBack: N = mix(mix(officeWall, vec3(0.1, 0.11, 0.12), partition), vec3(0.09, 0.09, 0.1), desks);
  const officeColor: N = officeBack
    .mul(office.back)
    .add(officeWall.mul(0.7).mul(office.side))
    .add(vec3(0.5, 0.5, 0.5).mul(office.ceil))
    .add(vec3(0.16, 0.17, 0.19).mul(office.floor));
  const officeFall: N = float(0.9).div(office.hz.mul(0.07).add(1.0));
  const officeLit: N = officeColor.mul(officeFall).add(office.ceil.mul(panel).mul(0.55));

  /* ---------------- 亮灯与窗帘 ---------------- */
  // 每栋楼亮灯的比例不同；写字楼按"哪一层的哪一段"成片地亮
  const bldLit: N = hash2(vec2(seed, 4.7)).mul(0.24).add(0.07);
  const homeOn: N = step(h1, bldLit);
  const floorOn: N = step(hash2(vec2(cellId.y, seed.add(2.0))), 0.34);
  const spanOn: N = step(hash2(officeId.add(vec2(seed.mul(1.3), 9.0))), 0.6);
  const lit: N = mix(homeOn, floorOn.mul(spanOn), isGlass);
  // 灯是陆续亮起来的
  const turnOn: N = smoothstep(h2.mul(0.7), h2.mul(0.7).add(0.3), L);
  // 灯光颜色：大多是暖的钨丝灯，少数冷白，个别是电视的蓝光或者彩色的灯
  const warm: N = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.8, 0.56), h3);
  const cool: N = vec3(0.78, 0.9, 1.0);
  const odd: N = mix(vec3(0.35, 0.5, 1.0), vec3(1.0, 0.3, 0.55), step(0.5, h3));
  const homeTint: N = mix(mix(warm, cool, step(0.74, h2)), odd, step(0.93, h2));
  const officeTint: N = mix(vec3(0.82, 0.92, 1.0), vec3(1.0, 0.86, 0.66), step(0.75, o1));
  const lightTint: N = mix(homeTint, officeTint, isGlass);
  const brightness: N = mix(h3.mul(0.7).add(0.25), o1.mul(0.3).add(0.4), isGlass);

  // 百叶：从上往下放到一半；窗帘：左右两条
  const blindDrop: N = step(0.52, h2).mul(h1.mul(0.8).add(0.2)).mul(inv(isGlass));
  const blind: N = step(inv(blindDrop), py);
  const slat: N = smoothstep(0.35, 0.5, abs(fract(py.mul(homeH).mul(11.0)).sub(0.5))).mul(inv(smoothstep(0.2, 0.6, fwidth(py.mul(homeH).mul(11.0)))));
  const curtainW: N = step(0.6, h3).mul(h1.mul(0.14).add(0.1)).mul(inv(isGlass));
  const curtain: N = max(inv(step(curtainW, px)), step(inv(curtainW), px)).mul(inv(blind));
  const cover: N = max(blind, curtain);
  const fabric: N = mix(vec3(0.5, 0.46, 0.38), mix(vec3(0.3, 0.12, 0.1), vec3(0.16, 0.22, 0.3), step(0.5, h1)), curtain);
  const coverColor: N = fabric.mul(mix(float(1.0), float(0.72), slat.mul(blind)));

  const roomColor: N = mix(homeColor, officeColor, isGlass);
  const roomLit: N = mix(homeLit, officeLit, isGlass);
  // 透过窗帘和百叶漏出来的光
  const coverGlow: N = coverColor.mul(mix(float(0.55), float(0.3), curtain));
  const windowGlow: N = mix(roomLit, coverGlow, cover).mul(lightTint).mul(brightness).mul(lit).mul(turnOn);

  /* ---------------- 墙面 ---------------- */
  const tint: N = hash2(vec2(seed, 1.0));
  const tint2: N = hash2(vec2(seed, 7.7));
  // 砖：一块块砖，隔行错半块，每块的颜色略有不同
  const brickV: N = v.div(0.085);
  const brickRow: N = floor(brickV);
  const brickU: N = u.div(0.24).add(fract(brickRow.mul(0.5)));
  const brickTone: N = hash2(vec2(floor(brickU), brickRow.add(seed)));
  const brickFine: N = inv(smoothstep(0.25, 0.7, max(fwidth(brickU), fwidth(brickV))));
  const mortar: N = max(inv(band(fract(brickU), 0.05, 0.95)), inv(band(fract(brickV), 0.1, 0.9))).mul(brickFine);
  const brickBase: N = mix(mix(vec3(0.26, 0.09, 0.06), vec3(0.34, 0.16, 0.1), tint), mix(vec3(0.3, 0.25, 0.2), vec3(0.14, 0.1, 0.09), tint), step(0.72, tint2));
  const brick: N = mix(brickBase.mul(mix(float(1.0), brickTone.mul(0.5).add(0.72), brickFine)), brickBase.mul(1.5).add(0.05), mortar.mul(0.55));
  // 石材：大块分缝，每块略有明暗
  const stoneV: N = v.div(0.75);
  const stoneRow: N = floor(stoneV);
  const stoneU: N = u.div(1.5).add(fract(stoneRow.mul(0.5)));
  const stoneFine: N = inv(smoothstep(0.15, 0.5, max(fwidth(stoneU), fwidth(stoneV))));
  const stoneJoint: N = max(inv(band(fract(stoneU), 0.012, 0.988)), inv(band(fract(stoneV), 0.025, 0.975))).mul(stoneFine);
  const stoneBase: N = mix(mix(vec3(0.36, 0.33, 0.28), vec3(0.5, 0.47, 0.42), tint), vec3(0.24, 0.24, 0.25), step(0.7, tint2));
  const stone: N = stoneBase.mul(mix(float(1.0), hash2(vec2(floor(stoneU), stoneRow.add(seed))).mul(0.2).add(0.88), stoneFine)).mul(inv(stoneJoint.mul(0.45)));
  // 金属板：竖向分缝
  const panelJoint: N = inv(band(fract(u.div(1.2)), 0.012, 0.988)).mul(inv(smoothstep(0.1, 0.4, fwidth(u.div(1.2)))));
  const metal: N = mix(vec3(0.05, 0.052, 0.058), vec3(0.11, 0.11, 0.115), tint).mul(inv(panelJoint.mul(0.5)));
  // 幕墙的层间板
  const spandrel: N = mix(vec3(0.035, 0.05, 0.06), vec3(0.07, 0.08, 0.085), tint);
  let wall: N = spandrel.mul(isGlass).add(stone.mul(isStone)).add(brick.mul(isBrick)).add(metal.mul(isDark));

  // 做旧：雨水的竖向污迹，窗台下面挂着的水渍，靠近地面的脏
  const streak: N = mx_noise_float(vec3(u.mul(0.9), v.mul(0.045), seed)).mul(0.5).add(0.5);
  const blotch: N = mx_noise_float(vec3(u.mul(0.11), v.mul(0.11), seed.add(4.0))).mul(0.5).add(0.5);
  wall = wall.mul(streak.mul(0.3).add(0.76)).mul(blotch.mul(0.24).add(0.86));
  const drip: N = inX
    .mul(inv(smoothstep(0.0, myBottom, f.y)).mul(smoothstep(-0.25, myBottom, f.y)))
    .mul(upper)
    .mul(masonry)
    .mul(hash2(cellId.add(vec2(3.3, seed))).mul(0.5).add(0.2));
  wall = wall.mul(inv(drip.mul(0.38)));

  // 窗台和窗楣（砖石楼）：窗洞下面一条浅色石条，上面一条
  const sill: N = band(f.x, mx.sub(0.03), inv(mx).add(0.03)).mul(band(f.y, myBottom.sub(0.045), myBottom)).mul(masonry).mul(upper).mul(edge).mul(parapet);
  const lintel: N = band(f.x, mx.sub(0.03), inv(mx).add(0.03)).mul(band(f.y, inv(myTop), inv(myTop).add(0.06))).mul(masonry).mul(upper).mul(edge).mul(parapet);
  const trim: N = mix(vec3(0.46, 0.44, 0.4), vec3(0.3, 0.29, 0.28), tint2);
  wall = mix(wall, trim.mul(blotch.mul(0.3).add(0.8)), max(sill, lintel).mul(inv(smoothstep(0.3, 0.8, wy))));
  // 檐口：楼顶一圈压顶，下面一道阴影；底层和二层之间一道腰线
  const coping: N = band(v, size.y.sub(0.5), size.y.add(1.0));
  const copingShade: N = band(v, size.y.sub(1.25), size.y.sub(0.5));
  wall = mix(wall, trim.mul(0.9), coping.mul(masonry.add(isDark.mul(0.5))));
  wall = wall.mul(inv(copingShade.mul(0.35)));

  /* ---------------- 窗：玻璃、窗框 ---------------- */
  const frameW: N = isGlass.mul(0.0).add(masonry.mul(0.05)).add(isDark.mul(0.03));
  const frame: N = windowMask.mul(inv(band(px, frameW, inv(frameW)).mul(band(py, frameW.mul(0.7), inv(frameW.mul(0.7)))))).mul(inv(isGlass));
  // 窗中间一道横框或竖框（上下推拉窗 / 对开窗）
  const mullion: N = max(band(py, 0.48, 0.52).mul(step(0.5, tint2)), band(px, 0.485, 0.515).mul(inv(step(0.5, tint2))))
    .mul(windowMask)
    .mul(masonry)
    .mul(inv(smoothstep(0.25, 0.7, max(wx, wy))));
  const frameColor: N = mix(vec3(0.4, 0.39, 0.36), vec3(0.06, 0.06, 0.065), step(0.45, tint));
  // 窗洞凹进去：窗楣在玻璃上压一道阴影
  const recess: N = inv(smoothstep(0.78, 1.0, py).mul(0.5).mul(inv(isGlass)));
  // 白天也能隐约看到屋里：玻璃的颜色里混一点房间的样子
  const glassBase: N = mix(vec3(0.012, 0.016, 0.02), vec3(0.02, 0.035, 0.045), isGlass);
  const glass: N = mix(mix(glassBase, roomColor.mul(0.16), 0.55), coverColor.mul(0.5), cover).mul(recess);
  // 幕墙：竖梃和横档
  const curtainWall: N = max(inv(band(f.x, 0.035, 0.965)), band(f.y, myBottom.sub(0.03), myBottom)).mul(isGlass).mul(upper).mul(parapet).mul(inv(smoothstep(0.2, 0.6, wx)));

  let color: N = mix(wall, glass, windowMask);
  color = mix(color, frameColor, max(frame, mullion).mul(0.9));
  color = mix(color, vec3(0.16, 0.17, 0.18), curtainWall.mul(0.7));

  // 远处窗格小于两个像素时，退化成平均色，避免摩尔纹
  const lod: N = smoothstep(0.35, 0.9, max(fwidth(cu), fwidth(cv)));
  const avgGlass: N = inv(mx.mul(2.0)).mul(inv(myBottom.add(myTop)));
  const flatColor: N = mix(wall, glassBase.mul(1.6), avgGlass.mul(edge).mul(parapet));
  color = mix(color, flatColor, lod.mul(upper));
  const avgLit: N = mix(bldLit, float(0.25), isGlass);
  const flatGlow: N = lightTint.mul(avgLit).mul(avgGlass).mul(edge).mul(parapet).mul(L).mul(0.2);
  const upperGlow: N = mix(windowGlow.mul(windowMask).mul(inv(max(frame, mullion))), flatGlow, lod).mul(upper);

  /* ---------------- 底层：店面 ---------------- */
  const su: N = u.div(SHOP_BAY);
  const sf: N = fract(su);
  const sId: N = floor(su);
  const sw: N = max(fwidth(su), 0.002);
  const s1: N = hash2(vec2(sId, seed));
  const s2: N = hash2(vec2(sId.add(13.0), seed.mul(1.9)));
  const s3: N = hash2(vec2(sId.mul(1.3).add(5.0), seed.add(21.0)));
  // 这家店亮不亮灯：从顶点属性的二进制位里取
  const shopOn: N = step(0.25, fract(floor(shopBits.div(pow(float(2.0), sId))).mul(0.5)));
  const ground: N = inv(upper);
  // 两侧是墙垛，中间是门和橱窗
  const opening: N = smoothstep(float(0.065).sub(sw), float(0.065).add(sw), sf).mul(inv(smoothstep(float(0.935).sub(sw), float(0.935).add(sw), sf))).mul(edge);
  // 门在左边还是右边
  const doorLeft: N = step(0.5, s2);
  const doorAt: N = mix(float(0.74), float(0.085), doorLeft);
  const door: N = band(sf, doorAt, doorAt.add(0.175)).mul(band(v, 0.12, 2.5));
  const display: N = band(v, 0.62, 3.25).mul(inv(band(sf, doorAt.sub(0.02), doorAt.add(0.195))));
  const transom: N = band(v, 2.62, 3.25).mul(band(sf, doorAt, doorAt.add(0.175)));
  const shopGlass: N = max(max(door, display), transom).mul(opening).mul(ground);
  // 橱窗的竖框
  const shopMullion: N = inv(band(fract(sf.mul(4.0).add(0.02)), 0.03, 0.97)).mul(display).mul(opening).mul(inv(smoothstep(0.02, 0.08, sw)));
  const doorFrame: N = band(sf, doorAt.sub(0.012), doorAt.add(0.187)).mul(band(v, 0.0, 2.58)).mul(inv(door)).mul(opening);
  const doorHandle: N = band(sf, doorAt.add(0.08), doorAt.add(0.095)).mul(band(v, 0.95, 1.35)).mul(inv(smoothstep(0.01, 0.04, sw)));

  // 店里：货架、柜台、灯盘
  const shopW = SHOP_BAY * 0.87;
  const shopH = 3.5;
  const shop = trace(clamp(sf.sub(0.065).div(0.87), 0, 1), clamp(v.sub(0.1).div(shopH), 0, 1), shopW, shopH, s3.mul(3.0).add(5.5));
  const shelfRow: N = floor(shop.hy.div(0.42));
  // 后墙按左右数货架的格子，侧墙按进深数
  const shelfCol: N = floor(mix(shop.hx, shop.hz.add(40.0), shop.side).div(0.3));
  const goods: N = hash2(vec2(shelfCol, shelfRow.add(s1.mul(40.0))));
  // 货架上的东西：大多是不起眼的杂色，隔几格才有一块鲜艳的；有的格子是空的
  const goods2: N = hash2(vec2(shelfRow.add(3.0), shelfCol.add(s2.mul(9.0))));
  const dull: N = mix(vec3(0.34, 0.3, 0.25), vec3(0.5, 0.47, 0.42), goods);
  const vivid: N = mix(mix(vec3(0.62, 0.16, 0.1), vec3(0.66, 0.5, 0.12), goods), mix(vec3(0.12, 0.3, 0.5), vec3(0.2, 0.42, 0.25), goods), step(0.5, goods2));
  const goodsTint: N = mix(dull, vivid, step(0.72, goods2)).mul(mix(float(0.25), float(1.0), step(0.14, goods)));
  const board: N = inv(band(fract(shop.hy.div(0.42)), 0.14, 1.0));
  const counter: N = inv(smoothstep(0.9, 0.93, shop.hy));
  const shopWall: N = mix(vec3(0.6, 0.57, 0.5), vec3(0.42, 0.46, 0.48), step(0.5, s3));
  const shopBack: N = mix(mix(mix(shopWall, goodsTint.mul(0.75), 0.8), vec3(0.08, 0.07, 0.06), board), mix(vec3(0.2, 0.13, 0.08), vec3(0.12, 0.12, 0.13), step(0.5, s1)), counter);
  const tile: N = step(0.5, fract(floor(shop.hx.div(0.6)).add(floor(shop.hz.div(0.6))).mul(0.5)));
  const shopColor: N = shopBack
    .mul(shop.back)
    .add(shopBack.mul(0.8).mul(shop.side))
    .add(vec3(0.6, 0.6, 0.58).mul(shop.ceil))
    .add(mix(vec3(0.16, 0.15, 0.14), vec3(0.3, 0.29, 0.27), tile).mul(shop.floor));
  const shopPanel: N = band(fract(shop.hx.div(1.4)), 0.25, 0.75).mul(band(fract(shop.hz.div(2.2)), 0.2, 0.55));
  // 灯在天花板上：越靠近地面越暗，越往里越暗
  const shopFall: N = float(0.9).div(shop.hz.mul(0.1).add(1.0)).mul(mix(float(0.55), float(1.0), smoothstep(0.0, shopH, shop.hy)));
  const shopLit: N = shopColor.mul(shopFall).add(shop.ceil.mul(shopPanel).mul(1.3));
  // 橱窗里靠玻璃摆着的陈列：一排高低不一的剪影
  const dispCol: N = floor(sf.mul(11.0));
  const dispTop: N = hash2(vec2(dispCol, s1.mul(23.0).add(seed))).mul(1.1).add(0.62);
  const dispOn: N = step(0.35, hash2(vec2(dispCol.add(7.0), s2.mul(31.0))));
  const stand: N = inv(smoothstep(dispTop.sub(0.02), dispTop, v)).mul(dispOn).mul(band(fract(sf.mul(11.0)), 0.12, 0.88)).mul(display).mul(inv(smoothstep(0.02, 0.07, sw)));
  // 橱窗上方挂着的一圈霓虹灯管（"营业中"那种小灯牌）
  const neonAt: N = mix(float(0.3), float(0.62), step(0.5, s3));
  const nx: N = sf.sub(neonAt).div(0.075);
  const ny: N = v.sub(2.75).div(0.24);
  const neonBox: N = max(abs(nx), abs(ny));
  const neonTube: N = band(neonBox, 0.82, 1.0).mul(step(0.55, s1)).mul(display).mul(inv(smoothstep(0.015, 0.05, sw)));
  const neonTint: N = mix(vec3(1.0, 0.16, 0.12), mix(vec3(0.2, 0.7, 1.0), vec3(0.3, 1.0, 0.45), step(0.5, s2)), step(0.4, s3));
  const shopTint: N = mix(mix(vec3(1.0, 0.82, 0.6), vec3(0.84, 0.93, 1.0), step(0.5, s2)), mix(vec3(1.0, 0.45, 0.3), vec3(0.4, 1.0, 0.75), step(0.5, s3)), step(0.9, s1));

  // 关门的店：一半拉着卷帘门，一半只是黑着灯
  const shutterOn: N = inv(shopOn).mul(step(0.45, s3));
  const shutter: N = band(v, 0.05, 3.25).mul(opening).mul(ground).mul(shutterOn);
  const slats: N = smoothstep(0.3, 0.5, abs(fract(v.div(0.09)).sub(0.5))).mul(inv(smoothstep(0.2, 0.7, fwidth(v.div(0.09)))));
  const shutterColor: N = mix(vec3(0.2, 0.21, 0.22), mix(vec3(0.12, 0.2, 0.16), vec3(0.24, 0.16, 0.1), step(0.5, s2)), step(0.6, s1)).mul(mix(float(1.0), float(0.62), slats)).mul(streak.mul(0.4).add(0.7));

  // 卷帘门上的涂鸦：四扇里有三扇被喷过，每扇从图集里挑一幅。喷在铁皮上，所以一条条的阴影还在
  const gPick: N = floor(hash2(vec2(sId.add(57.0), seed.add(9.0))).mul(GRAFFITI_COLS * GRAFFITI_ROWS - 0.01));
  const gOn: N = step(0.25, hash2(vec2(sId.add(91.0), seed.mul(1.3).add(4.0))));
  const gx: N = sf.sub(0.1).div(0.8);
  const gy: N = v.sub(0.42).div(2.45);
  const gIn: N = band(gx, 0.0, 1.0).mul(band(gy, 0.0, 1.0));
  const gCol: N = gPick.sub(floor(gPick.div(GRAFFITI_COLS)).mul(GRAFFITI_COLS));
  const gRow: N = floor(gPick.div(GRAFFITI_COLS));
  const gUv: N = vec2(gCol.add(clamp(gx, 0, 1)).div(GRAFFITI_COLS), float(1).sub(gRow.add(inv(clamp(gy, 0, 1))).div(GRAFFITI_ROWS)));
  const gdu: N = u.div(SHOP_BAY * 0.8 * GRAFFITI_COLS);
  const gdv: N = v.div(2.45 * GRAFFITI_ROWS);
  const gTex: N = texture(graffiti, gUv).grad(vec2(dFdx(gdu), dFdx(gdv)), vec2(dFdy(gdu), dFdy(gdv)));
  const shutterPainted: N = mix(shutterColor, gTex.rgb.mul(mix(float(0.92), float(0.6), slats)).mul(streak.mul(0.25).add(0.75)), gTex.a.mul(gOn).mul(gIn));

  // 门楣上的店招：从图集里挑一格。用连续的坐标求导，免得格子边界上出现接缝
  const signTop = 4.5;
  const signBottom = 3.62;
  const signX: N = clamp(sf.sub(0.08).div(0.84), 0, 1);
  const signY: N = clamp(v.sub(signBottom).div(signTop - signBottom), 0, 1);
  const signMask: N = band(sf, 0.08, 0.92).mul(band(v, signBottom, signTop)).mul(ground).mul(edge);
  const pick: N = floor(s1.mul(SHOP_SIGN_COLS * SHOP_SIGN_ROWS - 0.01));
  const cellCol: N = pick.sub(floor(pick.div(SHOP_SIGN_COLS)).mul(SHOP_SIGN_COLS));
  const cellRow: N = floor(pick.div(SHOP_SIGN_COLS));
  const signUv: N = vec2(cellCol.add(signX).mul(SHOP_SIGN_CELL.u), float(1).sub(cellRow.add(inv(signY)).mul(SHOP_SIGN_CELL.v)));
  const gu: N = u.div(SHOP_BAY * 0.84).mul(SHOP_SIGN_CELL.u);
  const gv: N = v.div(signTop - signBottom).mul(SHOP_SIGN_CELL.v);
  const signTex: N = texture(signs, signUv).grad(vec2(dFdx(gu), dFdx(gv)), vec2(dFdy(gu), dFdy(gv))).rgb;
  // 有的店招是灯箱（整块发光），有的只有字是亮的，有的不亮
  const signKind: N = hash2(vec2(sId.add(3.0), seed.add(40.0)));
  const signLuma: N = dot(signTex, vec3(0.3, 0.55, 0.15));
  const signGlow: N = signTex
    .mul(mix(signLuma.mul(2.2), float(1.0), step(0.55, signKind)))
    .mul(step(0.22, signKind))
    .mul(mix(float(0.25), float(1.0), shopOn));

  // 墙垛、勒脚、店招上方的线脚
  const pier: N = inv(opening);
  const plinth: N = band(v, 0.0, 0.5).mul(inv(door.add(doorFrame)));
  const fascia: N = band(v, 3.3, signBottom).add(band(v, signTop, 4.72));
  const cornice: N = band(v, 4.72, GROUND_FLOOR);
  const shopfrontColor: N = mix(vec3(0.035, 0.035, 0.04), mix(vec3(0.16, 0.07, 0.05), vec3(0.05, 0.11, 0.1), step(0.5, s3)), step(0.55, s2));
  const pierColor: N = mix(wall, wall.mul(0.6), step(0.5, tint2).mul(isGlass.add(isDark)));
  let groundColor: N = mix(shopfrontColor, pierColor, pier);
  groundColor = mix(groundColor, mix(glassBase, shopColor.mul(0.2), 0.6).mul(inv(stand.mul(0.7))), shopGlass);
  groundColor = mix(groundColor, shopfrontColor.mul(1.6).add(0.02), max(shopMullion, doorFrame));
  groundColor = mix(groundColor, vec3(0.5, 0.48, 0.42), doorHandle.mul(door));
  groundColor = mix(groundColor, shutterPainted, shutter);
  groundColor = mix(groundColor, shopfrontColor.mul(0.7), fascia.mul(opening));
  groundColor = mix(groundColor, signTex.mul(0.8), signMask);
  groundColor = mix(groundColor, mix(vec3(0.07, 0.07, 0.075), vec3(0.2, 0.19, 0.18), tint).mul(streak.mul(0.4).add(0.7)), plinth.mul(inv(shutter)));
  groundColor = mix(groundColor, trim, cornice);
  // 线脚下面压一道阴影，墙根更脏
  groundColor = groundColor.mul(inv(band(v, 4.45, 4.72).mul(pier).mul(0.3))).mul(mix(float(0.72), float(1.0), smoothstep(0.0, 1.6, v)));
  color = mix(color, groundColor, ground);

  const groundGlass: N = shopGlass.mul(inv(shutter)).mul(inv(max(shopMullion, doorHandle)));
  // 没开灯又没拉卷帘的店，里面留一盏很暗的夜灯
  const shopLevel: N = mix(float(0.03), s2.mul(0.3).add(0.42), shopOn);
  const shopGlow: N = shopLit.mul(inv(stand.mul(0.85))).mul(shopTint).mul(shopLevel).mul(groundGlass).mul(L);
  const neonGlow: N = neonTint.mul(neonTube).mul(shopOn).mul(groundGlass).mul(L).mul(2.6);
  const groundGlow: N = shopGlow.add(neonGlow).add(signGlow.mul(signMask).mul(L).mul(0.5));

  /* ---------------- 输出 ---------------- */
  const glassMask: N = max(windowMask.mul(inv(max(frame, mullion))).mul(inv(cover)).mul(upper).mul(inv(lod)), groundGlass);
  const metalMask: N = max(shutter, curtainWall.mul(upper));

  const m = new THREE.MeshStandardNodeMaterial();
  // 通向弯道的那条街两侧的立面不做屏幕空间反射：橱窗里映出来的箭头屏是反的，会指错方向
  m.colorNode = withSurface(color, facesTurnApproach(positionWorld.x, positionWorld.z).negate(), float(0));
  // 幕墙的玻璃有新有旧：少数几块发乌，反光是糊的
  const paneRough: N = mix(float(0.06), mix(float(0.05), float(0.24), step(0.72, h3)), isGlass.mul(upper));
  m.roughnessNode = mix(mix(mix(float(0.86), float(0.5), isDark.mul(upper)), float(0.45), metalMask), paneRough, glassMask);
  // 喷了漆的地方不再是裸露的铁皮
  const painted: N = gTex.a.mul(gOn).mul(gIn).mul(shutter);
  m.metalnessNode = mix(mix(float(0.0), float(0.7), metalMask.mul(inv(painted.mul(0.85)))), float(0.2), glassMask);
  // 白天屋里也不是全黑的：从窗外照进去一点光
  const daylight: N = mix(roomColor.mul(windowMask).mul(inv(cover)).mul(upper).mul(inv(lod)), shopColor.mul(groundGlass), ground)
    .mul(inv(L))
    .mul(mix(float(0.05), float(0.11), isGlass.mul(upper)));
  m.emissiveNode = upperGlow.add(groundGlow).add(daylight);

  // 每扇窗的法线带一点点随机倾斜：整面玻璃的反光不会像一块平板
  // 玻璃幕墙的倾斜更大：一块块玻璃各自反射天空的不同位置，整面墙才不是一块平板
  const tilt: N = vec2(h1.sub(0.5), h2.sub(0.5)).mul(mix(float(0.03), float(0.085), isGlass)).mul(windowMask);
  const nW: N = normalize(normalWorld.add(tangent.mul(tilt.x)).add(upW.mul(tilt.y)));
  m.normalNode = nW.transformDirection(cameraViewMatrix);
  return m;
}
