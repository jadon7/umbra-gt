import * as THREE from 'three/webgpu';
import { abs, floor, max, mix, step, texture, vec2 } from 'three/tsl';
import { buildTurnHints, CITY } from './cityLayout.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 路口的四条臂在图里各占一个通道，顺序和 cityLayout 里一样：+x、-x、+z、-z */
const armIndex = (dx: number, dz: number): number => (dx === 1 ? 0 : dx === -1 ? 1 : dz === 1 ? 2 : 3);

let map: THREE.DataTexture | null = null;

/**
 * 一张很小的图，一个路口一个像素，四个通道是路口的四条臂。记的是「赛道从这条臂开过去要拐弯」：
 * 0.5 = 从这条臂进路口、往左拐，1 = 往右拐；0.125 = 这条臂通向下一个路口的弯（上一个路口朝着弯的那半条街）；0 = 都不是。
 * 路面着色器拿它画入弯前的地面箭头，立面着色器拿它找出「通向弯道的那条街」。
 */
export function turnMapTexture(): THREE.DataTexture {
  if (map) return map;
  const data = new Uint8Array(CITY.ni * CITY.nj * 4);
  for (const t of buildTurnHints()) {
    data[(t.j * CITY.ni + t.i) * 4 + t.arm] = t.left ? 128 : 255;
    const pi = t.i - t.inX;
    const pj = t.j - t.inZ;
    if (pi < 0 || pj < 0 || pi >= CITY.ni || pj >= CITY.nj) continue;
    const k = (pj * CITY.ni + pi) * 4 + armIndex(t.inX, t.inZ);
    data[k] = Math.max(data[k], 32);
  }
  map = new THREE.DataTexture(data, CITY.ni, CITY.nj, THREE.RGBAFormat);
  map.colorSpace = THREE.NoColorSpace;
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.needsUpdate = true;
  return map;
}

/**
 * 着色器里用：世界坐标 (x, z) 这一点归哪个路口管（最近的那个），
 * 返回它相对路口中心的偏移，和它所在的南北向 / 东西向那条臂上记的值（见 turnMapTexture）
 */
export function junctionAt(x: N, z: N): { ox: N; oz: N; armNS: N; armEW: N } {
  const P = CITY.pitch;
  const fi: N = floor(x.div(P).add(3.5));
  const fj: N = floor(z.div(P).add(4.0));
  const ox: N = x.sub(fi.sub(3).mul(P));
  const oz: N = z.sub(fj.sub(3.5).mul(P));
  const code: N = texture(turnMapTexture(), vec2(fi.add(0.5).div(CITY.ni), fj.add(0.5).div(CITY.nj)));
  // 路网以外没有路口：不然会查到最边上那一排的值
  const inGrid: N = step(-0.5, fi)
    .mul(step(fi, CITY.ni - 0.5))
    .mul(step(-0.5, fj))
    .mul(step(fj, CITY.nj - 0.5));
  return {
    ox,
    oz,
    armNS: mix(code.a, code.b, step(0.0, oz)).mul(inGrid),
    armEW: mix(code.g, code.r, step(0.0, ox)).mul(inGrid),
  };
}

/**
 * 这一点是不是在「通向弯道的那条街」的两侧（1 = 是）。
 * 弯道尽头立着箭头屏，这条街两边的橱窗和玻璃幕墙正好和屏垂直，镜子里的箭头是反的——
 * 所以这些立面不做屏幕空间反射（见 facade.ts），只留环境贴图里的反光。
 */
export function facesTurnApproach(x: N, z: N): N {
  const j = junctionAt(x, z);
  const reach = CITY.road / 2 + CITY.sidewalk + 9; // 楼的外墙线，再加上塔楼往里收的那几米
  return max(step(abs(j.ox), reach).mul(step(0.06, j.armNS)), step(abs(j.oz), reach).mul(step(0.06, j.armEW)));
}
