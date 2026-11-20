import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  vec3,
  float,
  mix,
  dot,
  abs,
  pow,
  texture,
  normalize,
  positionLocal,
  normalLocal,
  normalViewGeometry,
  positionViewDirection,
  transformNormalToView,
  negateOnBackSide,
} from 'three/tsl';

/** 一种车漆配方 */
export interface PaintPreset {
  id: string;
  name: string;
  /** 正视颜色 */
  base: string;
  /** 掠射角颜色（金属漆的"暗部色"、幻彩漆的变色） */
  flop: string;
  flopAmount: number;
  flopPower: number;
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  /** 金属颗粒强度 */
  flake: number;
}

export const PAINTS: PaintPreset[] = [
  { id: 'lava', name: '熔岩红', base: '#c20812', flop: '#3d0005', flopAmount: 0.85, flopPower: 2.2, metalness: 0.7, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.2 },
  { id: 'acid', name: '酸性黄', base: '#ffc600', flop: '#c26a00', flopAmount: 0.75, flopPower: 2.2, metalness: 0.3, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.035, flake: 0.08 },
  { id: 'midnight', name: '极夜黑', base: '#07070a', flop: '#000000', flopAmount: 0.5, flopPower: 2.0, metalness: 0.85, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.025, flake: 0.3 },
  { id: 'glacier', name: '冰川白', base: '#eceef2', flop: '#a9b6cc', flopAmount: 0.8, flopPower: 2.2, metalness: 0.2, roughness: 0.48, clearcoat: 1, clearcoatRoughness: 0.035, flake: 0.1 },
  { id: 'volt', name: '电光蓝', base: '#0b3ae0', flop: '#020a3c', flopAmount: 0.9, flopPower: 2.0, metalness: 0.75, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.22 },
  { id: 'toxic', name: '毒液绿', base: '#46dc0e', flop: '#0b5c00', flopAmount: 0.85, flopPower: 2.2, metalness: 0.6, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.18 },
  { id: 'sunset', name: '落日橙', base: '#ff5600', flop: '#7c1500', flopAmount: 0.85, flopPower: 2.2, metalness: 0.65, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.2 },
  { id: 'chroma', name: '幻彩紫', base: '#5d18d6', flop: '#00caa6', flopAmount: 1.0, flopPower: 1.25, metalness: 0.9, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.18 },
  { id: 'silver', name: '液态银', base: '#c7cbd1', flop: '#6c727a', flopAmount: 0.8, flopPower: 2.0, metalness: 1.0, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.26 },
  { id: 'stealth', name: '哑光灰', base: '#5f6368', flop: '#3c3f43', flopAmount: 0.6, flopPower: 2.0, metalness: 0.35, roughness: 0.6, clearcoat: 0.0, clearcoatRoughness: 0.5, flake: 0.0 },
];

/** 副色（车顶、下包围、后视镜壳等）的可选项 */
export const SECONDARY: PaintPreset[] = [
  { id: 'gloss', name: '亮黑', base: '#040405', flop: '#000000', flopAmount: 0.5, flopPower: 2.0, metalness: 0.5, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.03, flake: 0.08 },
  { id: 'satin', name: '缎面黑', base: '#0b0b0c', flop: '#050505', flopAmount: 0.5, flopPower: 2.0, metalness: 0.2, roughness: 0.55, clearcoat: 0.0, clearcoatRoughness: 0.5, flake: 0.0 },
];

/* ------------------------------------------------------------------ */
/* 金属颗粒贴图：每个颗粒是一小块取向随机的"镜片"。                      */
/* 用贴图而不是纯程序噪声，是为了让远处靠 mipmap 自然变平，不闪烁。       */
/* ------------------------------------------------------------------ */

let flakeTexture: THREE.DataTexture | null = null;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getFlakeTexture(): THREE.DataTexture {
  if (flakeTexture) return flakeTexture;
  const size = 512;
  const cell = 4;
  const n = size / cell;
  const rnd = mulberry32(20261110);
  const px = new Float32Array(n * n);
  const py = new Float32Array(n * n);
  const col = new Uint8Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      px[k] = (i + rnd()) * cell;
      py[k] = (j + rnd()) * cell;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      col[k * 3] = Math.round((Math.cos(a) * r * 0.5 + 0.5) * 255);
      col[k * 3 + 1] = Math.round((Math.sin(a) * r * 0.5 + 0.5) * 255);
      col[k * 3 + 2] = Math.round(rnd() * 255);
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const cj = Math.floor(y / cell);
    for (let x = 0; x < size; x++) {
      const ci = Math.floor(x / cell);
      let best = 1e9;
      let bk = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = (ci + di + n) % n;
          const jj = (cj + dj + n) % n;
          const k = jj * n + ii;
          // 环绕距离，保证贴图无缝平铺
          let dx = Math.abs(px[k] - (x + 0.5));
          let dy = Math.abs(py[k] - (y + 0.5));
          if (dx > size / 2) dx = size - dx;
          if (dy > size / 2) dy = size - dy;
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            bk = k;
          }
        }
      }
      const o = (y * size + x) * 4;
      data[o] = col[bk * 3];
      data[o + 1] = col[bk * 3 + 1];
      data[o + 2] = col[bk * 3 + 2];
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  flakeTexture = tex;
  return tex;
}

/* ------------------------------------------------------------------ */

/**
 * 金属颗粒的整体强度（所有车漆共用）。平时是 1；镜头贴得很近、又有强光直射的时候（赛前的特写镜头），
 * 一个像素正好是一粒颗粒那么大，每个像素的反光方向都不一样，画面上是一片噪点——那时把它调低
 */
export const paintFlakeGain = uniform(1);

export interface PaintMaterial {
  material: THREE.MeshPhysicalNodeMaterial;
  /** 切换配方；immediate 为 false 时平滑过渡 */
  apply(preset: PaintPreset, immediate?: boolean): void;
  update(dt: number): void;
  current: PaintPreset;
}

/**
 * 多层车漆：
 *  - 底色层：正视色 → 掠射色的角度渐变（金属漆的明暗翻转 / 幻彩变色）
 *  - 颗粒层：三平面投影的随机镜片法线，只扰动底色层
 *  - 清漆层：使用未扰动的几何法线，保持镜面般的锐利反射
 */
export function createPaintMaterial(initial: PaintPreset, aoMap: THREE.Texture | null): PaintMaterial {
  const uBase = uniform(new THREE.Color(initial.base));
  const uFlop = uniform(new THREE.Color(initial.flop));
  const uFlopAmount = uniform(initial.flopAmount);
  const uFlopPower = uniform(initial.flopPower);
  const uMetal = uniform(initial.metalness);
  const uRough = uniform(initial.roughness);
  const uCoat = uniform(initial.clearcoat);
  const uCoatRough = uniform(initial.clearcoatRoughness);
  const uFlake = uniform(initial.flake);
  /** 每米平铺次数：512 贴图含 128 个颗粒，14 次/米 ≈ 0.55 毫米一颗 */
  const uFlakeScale = uniform(14.0);

  const tex = getFlakeTexture();

  const flakeSample = Fn(() => {
    const p = positionLocal.mul(uFlakeScale);
    const w = pow(abs(normalLocal), vec3(8.0));
    const wn = w.div(w.x.add(w.y).add(w.z));
    const sx = texture(tex, p.yz).rgb;
    const sy = texture(tex, p.zx).rgb;
    const sz = texture(tex, p.xy).rgb;
    return sx.mul(wn.x).add(sy.mul(wn.y)).add(sz.mul(wn.z));
  })();

  const material = new THREE.MeshPhysicalNodeMaterial();
  material.name = 'CarPaint';
  material.side = THREE.DoubleSide;

  // 颗粒法线（局部空间扰动 → 视图空间）
  const flakeVec = flakeSample.sub(0.5).mul(2.0);
  const nLocal = normalize(normalLocal.add(flakeVec.mul(uFlake).mul(paintFlakeGain)));
  material.normalNode = negateOnBackSide(transformNormalToView(nLocal));

  // 角度变色
  const ndv = abs(dot(normalViewGeometry, positionViewDirection)).clamp(0, 1);
  const flop = pow(float(1).sub(ndv), uFlopPower).mul(uFlopAmount);
  const flakeTint = float(1).add(flakeSample.z.sub(0.5).mul(uFlake).mul(paintFlakeGain).mul(1.4));
  material.colorNode = mix(uBase, uFlop, flop).mul(flakeTint);

  material.metalnessNode = uMetal;
  material.roughnessNode = uRough;
  material.clearcoatNode = uCoat;
  material.clearcoatRoughnessNode = uCoatRough;

  if (aoMap) {
    material.aoMap = aoMap;
    material.aoMapIntensity = 1.0;
  }

  // 平滑过渡
  const num = [uFlopAmount, uFlopPower, uMetal, uRough, uCoat, uCoatRough, uFlake];
  const keys: (keyof PaintPreset)[] = ['flopAmount', 'flopPower', 'metalness', 'roughness', 'clearcoat', 'clearcoatRoughness', 'flake'];
  const targetBase = new THREE.Color(initial.base);
  const targetFlop = new THREE.Color(initial.flop);
  const target = keys.map((k) => initial[k] as number);
  let animating = false;

  const api: PaintMaterial = {
    material,
    current: initial,
    apply(preset, immediate = false) {
      api.current = preset;
      targetBase.set(preset.base);
      targetFlop.set(preset.flop);
      keys.forEach((k, i) => (target[i] = preset[k] as number));
      if (immediate) {
        (uBase.value as THREE.Color).copy(targetBase);
        (uFlop.value as THREE.Color).copy(targetFlop);
        num.forEach((u, i) => (u.value = target[i]));
        animating = false;
      } else {
        animating = true;
      }
    },
    update(dt) {
      if (!animating) return;
      const k = 1 - Math.exp(-dt * 7);
      (uBase.value as THREE.Color).lerp(targetBase, k);
      (uFlop.value as THREE.Color).lerp(targetFlop, k);
      let maxDiff = 0;
      num.forEach((u, i) => {
        const v = u.value as number;
        u.value = v + (target[i] - v) * k;
        maxDiff = Math.max(maxDiff, Math.abs(target[i] - (u.value as number)));
      });
      const c = uBase.value as THREE.Color;
      maxDiff = Math.max(maxDiff, Math.abs(c.r - targetBase.r), Math.abs(c.g - targetBase.g), Math.abs(c.b - targetBase.b));
      if (maxDiff < 0.002) api.apply(api.current, true);
    },
  };
  return api;
}
