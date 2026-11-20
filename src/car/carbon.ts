import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  vec2,
  vec3,
  float,
  mix,
  abs,
  pow,
  max,
  floor,
  fract,
  mod,
  step,
  fwidth,
  smoothstep,
  normalize,
  positionLocal,
  normalLocal,
  transformNormalToView,
  negateOnBackSide,
} from 'three/tsl';

/**
 * 碳纤维：程序化 2×2 斜纹编织 + 清漆。
 * 编织只扰动底层法线和明暗，清漆层保持光滑，所以近看是"玻璃下面压着织物"的效果。
 * 按物体空间三平面投影，不依赖模型 UV，各块面板上的纹路大小一致。
 */
export function createCarbonMaterial(aoMap: THREE.Texture | null): THREE.MeshPhysicalNodeMaterial {
  /** 每米多少束纱：250 ≈ 4 毫米一束（比真实略大，远看才读得出来） */
  const uScale = uniform(250.0);
  const uBump = uniform(0.55);

  // 在一个投影平面内算编织。返回 (法线偏移 x, 法线偏移 y, 明暗)
  const weave = Fn(([p]: [THREE.Node<'vec2'>]) => {
    const c = floor(p);
    const f = fract(p);
    // 斜纹：(x+y) mod 4 的前两格是横向纱束在上，后两格是纵向纱束在上
    const k = mod(c.x.add(c.y), 4.0);
    const horiz = step(k, 1.5);

    // 纱束横截面鼓起 + 沿纱束方向拱起
    const acrossH = f.y.sub(0.5);
    const alongH = k.add(f.x).mul(0.5).sub(0.5);
    const acrossV = f.x.sub(0.5);
    const alongV = k.sub(2.0).add(f.y).mul(0.5).sub(0.5);

    const dH = vec2(alongH.mul(-0.45), acrossH.mul(-1.5));
    const dV = vec2(acrossV.mul(-1.5), alongV.mul(-0.45));
    const d = mix(dV, dH, horiz);

    // 横纵两个方向的纤维反光不同，形成明暗相间的斜纹
    const shade = mix(float(0.62), float(1.25), horiz);

    // 纹路小于约两个像素时淡出，避免远处出现摩尔纹和闪烁
    const fw = max(fwidth(p.x), fwidth(p.y));
    const fade = float(1).sub(smoothstep(0.18, 0.55, fw));

    return vec3(d.mul(fade), mix(float(1.0), shade, fade));
  });

  const pos = positionLocal.mul(uScale);
  const w = pow(abs(normalLocal), vec3(12.0));
  const wn = w.div(w.x.add(w.y).add(w.z));

  const wx = weave(pos.yz); // 投影到 YZ 平面
  const wy = weave(pos.zx);
  const wz = weave(pos.xy);

  // 把各平面内的偏移放回物体空间的对应轴上
  const offset = vec3(0.0, wx.x, wx.y)
    .mul(wn.x)
    .add(vec3(wy.y, 0.0, wy.x).mul(wn.y))
    .add(vec3(wz.x, wz.y, 0.0).mul(wn.z));
  const shade = wx.z.mul(wn.x).add(wy.z.mul(wn.y)).add(wz.z.mul(wn.z));

  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = 'CarbonFiber';
  m.side = THREE.DoubleSide;
  m.normalNode = negateOnBackSide(transformNormalToView(normalize(normalLocal.add(offset.mul(uBump)))));
  m.colorNode = vec3(0.028, 0.029, 0.032).mul(shade);
  m.metalnessNode = float(0.55);
  m.roughnessNode = float(0.42);
  m.clearcoatNode = float(1.0);
  m.clearcoatRoughnessNode = float(0.035);
  if (aoMap) {
    m.aoMap = aoMap;
    m.aoMapIntensity = 1.0;
  }
  return m;
}
