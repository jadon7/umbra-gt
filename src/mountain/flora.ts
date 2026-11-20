import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, cameraViewMatrix, cos, dot, float, length, mix, normalize, positionLocal, positionView, positionWorld, sin, smoothstep, texture, time, uv, vec2, vec3, vec4 } from 'three/tsl';
import { QUALITY } from '../core/quality.ts';
import { cityUniforms, SNOW } from '../city/materials.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type Ctx = CanvasRenderingContext2D;
type Rnd = () => number;

/**
 * 山上的植被：树、灌木、草丛。
 *
 * 都是「面片」——几片竖着的、互相交叉的四边形，上面贴一张画出来的植物（带透明的轮廓）。
 * 一棵树只有十几个顶点，所以林子可以种得很密；轮廓是画出来的，树干、一层层垂下来的枝、
 * 枝叶之间漏出来的空隙都在，比用圆锥搭出来的树像得多。老的赛车游戏里的树就是这么做的。
 *
 * 贴图不用图片文件，启动时在画布上画：八种树一张图，八种地面上的小植物一张图。
 */

function seeded(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rnd: Rnd, list: T[]): T => list[Math.floor(rnd() * list.length) % list.length];

/** 树的图集：一行八种 */
export const TREE_TILES = 8;
export const TREE = { spruce: 0, spruceSlim: 1, pine: 2, fir: 3, green: 4, gold: 5, rust: 6, birch: 7 } as const;
/** 阔叶树只画在格子下面这么高的一截里（树冠是圆的，格子是瘦长的） */
export const BROADLEAF_FILL = 0.74;
/** 地面植物的图集：一行八种 */
export const COVER_TILES = 8;
export const COVER = { shrub: 0, redShrub: 1, dryGrass: 2, grass: 3, fern: 4, flowers: 5, sapling: 6, twigs: 7 } as const;

interface Greens {
  dark: string[];
  mid: string[];
  light: string[];
}
const SPRUCE: Greens = { dark: ['#14261d', '#1a3125', '#1e3a2a'], mid: ['#27482f', '#2f5637', '#335d3d'], light: ['#44703f', '#55824a', '#6a9556'] };
const PINE: Greens = { dark: ['#1d2b17', '#25361b', '#2c3f1f'], mid: ['#3a5025', '#47602b', '#526b30'], light: ['#66803a', '#7a9244', '#8fa552'] };
const FIR: Greens = { dark: ['#17241c', '#1d2e22', '#223526'], mid: ['#2b4530', '#345238', '#3b5a3c'], light: ['#4b6c44', '#5c7c4c', '#6f8c58'] };
const LEAF_GREEN: Greens = { dark: ['#243f19', '#2c4b1d', '#345622'], mid: ['#44702a', '#528131', '#5f9038'], light: ['#7aa644', '#93ba52', '#a9c962'] };
const LEAF_GOLD: Greens = { dark: ['#6a4a0c', '#7d5a10', '#8c6814'], mid: ['#b0851a', '#c4961e', '#d5a524'], light: ['#e6bb36', '#efcb4c', '#f5d968'] };
const LEAF_RUST: Greens = { dark: ['#5a200e', '#6d2a11', '#7d3314'], mid: ['#a2441a', '#b8521d', '#c96222'], light: ['#de7b2c', '#e8923a', '#f0a94c'] };
const LEAF_BIRCH: Greens = { dark: ['#7a6a14', '#8c7a18', '#9a881c'], mid: ['#bfa826', '#d0b82c', '#dcc636'], light: ['#e9d64e', '#f0e06a', '#f4e884'] };
const DRY: Greens = { dark: ['#5a4a22', '#6b5828', '#77632c'], mid: ['#94803a', '#a89244', '#b8a04c'], light: ['#cdb65e', '#dcc670', '#e8d484'] };

/** 一簇短线：从 (x, y) 朝 angle 方向散开。针叶、草叶都是它（画布的 y 朝下，angle 按画布算） */
function spray(g: Ctx, rnd: Rnd, x: number, y: number, angle: number, spread: number, len: number, count: number, colors: string[], width: number): void {
  for (let k = 0; k < count; k++) {
    const a = angle + (rnd() - 0.5) * spread;
    const l = len * (0.45 + rnd() * 0.75);
    g.strokeStyle = pick(rnd, colors);
    g.lineWidth = width * (0.7 + rnd() * 0.7);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
}

interface ConiferSpec {
  /** 最低的一层枝在格子的多高（0 顶 – 1 底）；小于它的那一截是光树干 */
  skirt: number;
  /** 树冠从多高开始（0 = 顶上）：松树的冠只在上半截 */
  crown: number;
  /** 最宽的地方占格子宽度的多少（半宽） */
  reach: number;
  /** 轮廓：1 是直边的圆锥，小于 1 往外鼓 */
  taper: number;
  /** 枝条往下垂多少 */
  droop: number;
  /** 多大比例的枝缺掉（老树、稀疏的树） */
  gaps: number;
  greens: Greens;
  trunk: [string, string];
}

/** 画一棵针叶树：树干在格子底边正中，树尖顶到格子上沿 */
function drawConifer(g: Ctx, rnd: Rnd, W: number, H: number, sp: ConiferSpec): void {
  const cx = W / 2;
  const yTop = H * 0.015;
  const yBase = H * 0.998;
  const y0 = yTop + (H * sp.crown);
  const y1 = H * sp.skirt;
  const u = W / 256; // 线条粗细跟着格子大小走

  // 树干：下粗上细，一侧亮一侧暗
  const tw = W * 0.034;
  const grad = g.createLinearGradient(cx - tw, 0, cx + tw, 0);
  grad.addColorStop(0, sp.trunk[0]);
  grad.addColorStop(1, sp.trunk[1]);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(cx - tw, yBase);
  g.lineTo(cx - tw * 0.25, yTop + H * 0.05);
  g.lineTo(cx + tw * 0.25, yTop + H * 0.05);
  g.lineTo(cx + tw, yBase);
  g.closePath();
  g.fill();
  // 光树干上的断枝
  for (let y = y1 + H * 0.02; y < yBase - H * 0.04; y += H * (0.02 + rnd() * 0.04)) {
    if (rnd() < 0.55) continue;
    const side = rnd() < 0.5 ? -1 : 1;
    g.strokeStyle = sp.trunk[0];
    g.lineWidth = 1.6 * u;
    g.beginPath();
    g.moveTo(cx, y);
    g.lineTo(cx + side * W * (0.04 + rnd() * 0.07), y - H * 0.008 + rnd() * H * 0.02);
    g.stroke();
  }

  const levels = Math.round((y1 - y0) / (H * 0.0125));
  // 三遍：先画背后的暗枝，再画中间的，最后画朝着光的亮枝
  for (let pass = 0; pass < 3; pass++) {
    const tones = pass === 0 ? sp.greens.dark : pass === 1 ? [...sp.greens.dark, ...sp.greens.mid, ...sp.greens.mid] : [...sp.greens.mid, ...sp.greens.light];
    for (let k = 0; k < levels; k++) {
      const t = (k + 0.5) / levels;
      const y = y0 + (y1 - y0) * t + (rnd() - 0.5) * H * 0.01;
      const half = W * sp.reach * Math.pow(t, sp.taper) + W * 0.014;
      for (const side of [-1, 1]) {
        if (rnd() < sp.gaps * (pass === 0 ? 0.4 : 1)) continue;
        const len = half * (0.62 + rnd() * 0.42) * (pass === 2 ? 0.92 : 1);
        const steps = Math.max(3, Math.round(len / (W * 0.022)));
        // 枝的主梗
        g.strokeStyle = sp.greens.dark[0];
        g.lineWidth = 1.2 * u;
        g.beginPath();
        g.moveTo(cx, y);
        for (let j = 1; j <= steps; j++) {
          const q = j / steps;
          g.lineTo(cx + side * len * q, y + len * sp.droop * Math.pow(q, 1.5) - len * 0.07 * Math.sin(q * Math.PI));
        }
        g.stroke();
        // 沿着枝挂下来的针叶
        for (let j = pass === 2 ? 1 : 0; j <= steps; j++) {
          const q = j / steps;
          const bx = cx + side * len * q;
          const by = y + len * sp.droop * Math.pow(q, 1.5) - len * 0.07 * Math.sin(q * Math.PI);
          const nl = (W * 0.026 + len * 0.13) * (1 - 0.35 * q);
          const down = Math.PI / 2 - side * (0.35 + 0.5 * q);
          spray(g, rnd, bx, by, pass === 2 ? down - side * 0.5 : down, 1.25, pass === 2 ? nl * 0.7 : nl, pass === 0 ? 4 : 5, tones, 1.7 * u);
        }
      }
      // 朝着镜头伸过来的枝：看上去是一小团垂下来的针叶，把树干挡住
      if (pass > 0 && rnd() > sp.gaps) {
        const x = cx + (rnd() - 0.5) * half * 1.15;
        spray(g, rnd, x, y, Math.PI / 2, 1.9, half * 0.3 + H * 0.012, pass === 2 ? 5 : 8, tones, 1.8 * u);
      }
    }
  }
  // 树尖
  g.strokeStyle = sp.greens.mid[0];
  g.lineWidth = 1.6 * u;
  g.beginPath();
  g.moveTo(cx, y0 + H * 0.03);
  g.lineTo(cx, Math.max(yTop, y0 - H * 0.012));
  g.stroke();
}

interface BroadleafSpec {
  /** 用格子的多高 */
  fill: number;
  /** 枝杈往两边张开多少（弧度） */
  spread: number;
  /** 叶子多密（每个枝梢上几片） */
  leaves: number;
  greens: Greens;
  trunk: [string, string];
  /** 白桦：树干上有黑斑 */
  marks?: boolean;
}

/** 画一棵阔叶树：一根主干不断分杈，枝梢上是一团团叶子 */
function drawBroadleaf(g: Ctx, rnd: Rnd, W: number, H: number, sp: BroadleafSpec): void {
  const cx = W / 2;
  const yBase = H * 0.998;
  const u = W / 256;
  const tips: [number, number, number][] = [];
  const edge = W * 0.06;
  const grow = (x: number, y: number, ang: number, len: number, wid: number, depth: number): void => {
    let x2 = x + Math.cos(ang) * len;
    const y2 = y - Math.sin(ang) * len;
    // 别长出格子
    x2 = Math.min(W - edge, Math.max(edge, x2));
    g.strokeStyle = depth > 3 ? sp.trunk[1] : sp.trunk[0];
    g.lineWidth = Math.max(1 * u, wid);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x2, y2);
    g.stroke();
    if (sp.marks && depth > 3) {
      g.strokeStyle = '#2a2622';
      g.lineWidth = 1.4 * u;
      for (let k = 0; k < 9; k++) {
        const q = rnd();
        const mx = x + (x2 - x) * q;
        const my = y + (y2 - y) * q;
        g.beginPath();
        g.moveTo(mx - wid * 0.45, my);
        g.lineTo(mx + wid * (rnd() - 0.2) * 0.5, my + (rnd() - 0.5) * 2 * u);
        g.stroke();
      }
    }
    if (depth <= 2) tips.push([x2, y2, depth]);
    if (depth <= 0) return;
    const n = depth > 3 ? 2 : 2 + (rnd() < 0.45 ? 1 : 0);
    for (let c = 0; c < n; c++) {
      const turn = ((c + 0.5) / n - 0.5) * 2 * sp.spread + (rnd() - 0.5) * sp.spread * 0.7;
      // 枝条总是想往上长
      const next = ang + turn + (Math.PI / 2 - ang) * 0.18;
      grow(x2, y2, next, len * (0.6 + rnd() * 0.22), wid * 0.62, depth - 1);
    }
  };
  grow(cx, yBase, Math.PI / 2 + (rnd() - 0.5) * 0.14, H * sp.fill * 0.31, W * 0.05, 5);

  const R = W * 0.085;
  const dot = (x: number, y: number, r: number, color: string): void => {
    g.fillStyle = color;
    g.beginPath();
    g.ellipse(x, y, r, r * (0.6 + rnd() * 0.35), rnd() * 3.1, 0, Math.PI * 2);
    g.fill();
  };
  // 三遍：背光的暗叶在下面，中间色，最后是朝着光的亮叶（偏上）
  for (let pass = 0; pass < 3; pass++) {
    const tones = pass === 0 ? sp.greens.dark : pass === 1 ? sp.greens.mid : sp.greens.light;
    for (const [x, y, depth] of tips) {
      const count = Math.round(sp.leaves * (pass === 2 ? 0.45 : 1) * (depth === 0 ? 1 : 0.6));
      for (let k = 0; k < count; k++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * R;
        const ox = Math.cos(a) * d;
        const oy = Math.sin(a) * d * 0.8 + (pass === 0 ? R * 0.3 : pass === 2 ? -R * 0.35 : 0);
        dot(x + ox, Math.min(y + oy, yBase - H * 0.1), W * 0.0098 * (0.6 + rnd() * 0.9), pick(rnd, tones));
      }
    }
  }
}

/** 一丛草：从底边正中往上散开的弯叶 */
function drawTuft(g: Ctx, rnd: Rnd, W: number, H: number, greens: Greens, blades: number, tall: number, flowers: string[] = []): void {
  const cx = W / 2;
  const yBase = H * 0.99;
  const u = W / 256;
  for (let k = 0; k < blades; k++) {
    const lean = (rnd() - 0.5) * 1.5;
    const len = H * tall * (0.45 + rnd() * 0.55);
    const x0 = cx + (rnd() - 0.5) * W * 0.34;
    const x1 = x0 + Math.sin(lean) * len * 0.75;
    const y1 = yBase - Math.cos(lean) * len;
    const pool = rnd() < 0.3 ? greens.dark : rnd() < 0.6 ? greens.mid : greens.light;
    g.strokeStyle = pick(rnd, pool);
    g.lineWidth = (1.6 + rnd() * 1.8) * u;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, yBase);
    g.quadraticCurveTo(x0 + (x1 - x0) * 0.25, yBase - len * 0.6, x1, y1);
    g.stroke();
    if (flowers.length && rnd() < 0.3) {
      g.fillStyle = pick(rnd, flowers);
      g.beginPath();
      g.arc(x1, y1, (2.6 + rnd() * 2.6) * u, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** 一丛灌木：贴着地的几根枝，上面一团团叶子 */
function drawShrub(g: Ctx, rnd: Rnd, W: number, H: number, greens: Greens, bare = false): void {
  const cx = W / 2;
  const yBase = H * 0.99;
  const u = W / 256;
  const tips: [number, number][] = [];
  for (let k = 0; k < 9; k++) {
    const a = Math.PI / 2 + (rnd() - 0.5) * 2.1;
    const len = H * (0.35 + rnd() * 0.42);
    const x1 = cx + Math.cos(a) * len * 0.62;
    const y1 = yBase - Math.sin(a) * len;
    g.strokeStyle = '#3a2c20';
    g.lineWidth = (bare ? 2.2 : 1.8) * u;
    g.beginPath();
    g.moveTo(cx + (rnd() - 0.5) * W * 0.1, yBase);
    g.quadraticCurveTo(cx + (x1 - cx) * 0.3, yBase - len * 0.6, x1, y1);
    g.stroke();
    tips.push([x1, y1], [cx + (x1 - cx) * 0.55, yBase - (yBase - y1) * 0.6]);
    if (bare) {
      // 枯枝：再分几根细杈
      for (let j = 0; j < 4; j++) {
        const q = 0.4 + rnd() * 0.6;
        const bx = cx + (x1 - cx) * q;
        const by = yBase - (yBase - y1) * q;
        g.lineWidth = 1.1 * u;
        g.beginPath();
        g.moveTo(bx, by);
        g.lineTo(bx + (rnd() - 0.5) * W * 0.2, by - rnd() * H * 0.16);
        g.stroke();
      }
    }
  }
  if (bare) return;
  for (let pass = 0; pass < 3; pass++) {
    const tones = pass === 0 ? greens.dark : pass === 1 ? greens.mid : greens.light;
    for (const [x, y] of tips) {
      for (let k = 0; k < (pass === 2 ? 9 : 20); k++) {
        const a = rnd() * 6.28;
        const d = Math.sqrt(rnd()) * W * 0.13;
        g.fillStyle = pick(rnd, tones);
        g.beginPath();
        g.ellipse(x + Math.cos(a) * d, Math.min(yBase - 4 * u, y + Math.sin(a) * d * 0.75 + (pass === 0 ? 8 * u : pass === 2 ? -9 * u : 0)), (3.2 + rnd() * 3.4) * u, (2.2 + rnd() * 2.2) * u, rnd() * 3, 0, 6.3);
        g.fill();
      }
    }
  }
}

/** 一丛蕨：几片弯下来的羽状叶 */
function drawFern(g: Ctx, rnd: Rnd, W: number, H: number): void {
  const cx = W / 2;
  const yBase = H * 0.99;
  const u = W / 256;
  for (let k = 0; k < 11; k++) {
    const a = Math.PI / 2 + (rnd() - 0.5) * 2.4;
    const len = H * (0.5 + rnd() * 0.4);
    const tone = pick(rnd, [...LEAF_GREEN.dark, ...LEAF_GREEN.mid, ...LEAF_GREEN.mid]);
    let px = cx;
    let py = yBase;
    for (let j = 1; j <= 12; j++) {
      const q = j / 12;
      // 叶梗越往外越往下弯
      const bend = a + (a < Math.PI / 2 ? -1 : 1) * q * q * 0.9;
      const x = px + Math.cos(bend) * (len / 12);
      const y = py - Math.sin(bend) * (len / 12);
      g.strokeStyle = tone;
      g.lineWidth = 1.5 * u;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(x, y);
      g.stroke();
      const leaf = W * 0.07 * (1 - q * 0.75);
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(bend + s * 1.25) * leaf, y - Math.sin(bend + s * 1.25) * leaf);
        g.stroke();
      }
      px = x;
      py = y;
    }
  }
}

/** 透明像素底下的颜色补成这一格的平均色：不然缩小之后轮廓上会有一圈黑边 */
function bleed(img: ImageData, tiles: number): void {
  const d = img.data;
  const tw = img.width / tiles;
  for (let t = 0; t < tiles; t++) {
    let r = 0;
    let gg = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < img.height; y += 2) {
      for (let x = Math.floor(t * tw); x < (t + 1) * tw; x += 2) {
        const o = (y * img.width + x) * 4;
        if (d[o + 3] > 200) {
          r += d[o];
          gg += d[o + 1];
          b += d[o + 2];
          n++;
        }
      }
    }
    if (!n) continue;
    r = Math.round(r / n);
    gg = Math.round(gg / n);
    b = Math.round(b / n);
    for (let y = 0; y < img.height; y++) {
      for (let x = Math.floor(t * tw); x < (t + 1) * tw; x++) {
        const o = (y * img.width + x) * 4;
        if (d[o + 3] === 0) {
          d[o] = r;
          d[o + 1] = gg;
          d[o + 2] = b;
        }
      }
    }
  }
}

function toTexture(c: HTMLCanvasElement, tiles: number): THREE.DataTexture {
  const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  bleed(img, tiles);
  const tex = new THREE.DataTexture(new Uint8Array(img.data.buffer), c.width, c.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 每一格里画的时候，上面盖一层从上到下由亮到暗的渐变（只染在已经画了的地方）：树冠顶上受光多，底下暗 */
function shadeTile(g: Ctx, W: number, H: number, top: number): void {
  g.globalCompositeOperation = 'source-atop';
  const grad = g.createLinearGradient(0, H * top, 0, H);
  grad.addColorStop(0, 'rgba(255,244,214,0.13)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(4,8,16,0.34)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
}

function tileCanvas(tiles: number, W: number, H: number, draw: (g: Ctx, k: number) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W * tiles;
  c.height = H;
  const g = c.getContext('2d')!;
  g.lineCap = 'round';
  for (let k = 0; k < tiles; k++) {
    // 每一格单独画在一张小画布上再贴过去：渐变只染这一格，也不会画出格
    const one = document.createElement('canvas');
    one.width = W;
    one.height = H;
    const og = one.getContext('2d')!;
    og.lineCap = 'round';
    draw(og, k);
    g.drawImage(one, k * W, 0);
  }
  return c;
}

/** 八种树的图集 */
export function createTreeAtlas(): THREE.DataTexture {
  // 手机上用小一半的图
  const W = QUALITY.particles < 0.6 ? 224 : 448;
  const H = W * 2;
  const bark: [string, string] = ['#2a211b', '#4a3b30'];
  const c = tileCanvas(TREE_TILES, W, H, (g, k) => {
    const rnd = seeded(101 + k * 37);
    if (k === TREE.spruce) drawConifer(g, rnd, W, H, { skirt: 0.9, crown: 0, reach: 0.44, taper: 0.82, droop: 0.3, gaps: 0.07, greens: SPRUCE, trunk: bark });
    else if (k === TREE.spruceSlim) drawConifer(g, rnd, W, H, { skirt: 0.86, crown: 0, reach: 0.3, taper: 0.7, droop: 0.42, gaps: 0.14, greens: FIR, trunk: bark });
    else if (k === TREE.pine) drawConifer(g, rnd, W, H, { skirt: 0.52, crown: 0.02, reach: 0.4, taper: 0.5, droop: 0.2, gaps: 0.16, greens: PINE, trunk: ['#4a2f22', '#8a5a3c'] });
    else if (k === TREE.fir) drawConifer(g, rnd, W, H, { skirt: 0.72, crown: 0, reach: 0.4, taper: 0.9, droop: 0.36, gaps: 0.34, greens: FIR, trunk: bark });
    else if (k === TREE.green) drawBroadleaf(g, rnd, W, H, { fill: BROADLEAF_FILL, spread: 0.52, leaves: 50, greens: LEAF_GREEN, trunk: ['#3a2d22', '#544434'] });
    else if (k === TREE.gold) drawBroadleaf(g, rnd, W, H, { fill: BROADLEAF_FILL, spread: 0.55, leaves: 44, greens: LEAF_GOLD, trunk: ['#33281f', '#4d3d2f'] });
    else if (k === TREE.rust) drawBroadleaf(g, rnd, W, H, { fill: BROADLEAF_FILL, spread: 0.5, leaves: 44, greens: LEAF_RUST, trunk: ['#2f251d', '#47382b'] });
    else drawBroadleaf(g, rnd, W, H, { fill: BROADLEAF_FILL, spread: 0.4, leaves: 24, greens: LEAF_BIRCH, trunk: ['#b9b3a6', '#e6e1d6'], marks: true });
    shadeTile(g, W, H, k >= TREE.green ? 1 - BROADLEAF_FILL : 0);
  });
  return toTexture(c, TREE_TILES);
}

/** 八种地面植物的图集 */
export function createCoverAtlas(): THREE.DataTexture {
  const S = QUALITY.particles < 0.6 ? 128 : 192;
  const c = tileCanvas(COVER_TILES, S, S, (g, k) => {
    const rnd = seeded(907 + k * 53);
    if (k === COVER.shrub) drawShrub(g, rnd, S, S, LEAF_GREEN);
    else if (k === COVER.redShrub) drawShrub(g, rnd, S, S, LEAF_RUST);
    else if (k === COVER.dryGrass) drawTuft(g, rnd, S, S, DRY, 70, 0.92);
    else if (k === COVER.grass) drawTuft(g, rnd, S, S, LEAF_GREEN, 80, 0.8);
    else if (k === COVER.fern) drawFern(g, rnd, S, S);
    else if (k === COVER.flowers) drawTuft(g, rnd, S, S, LEAF_GREEN, 60, 0.7, ['#e8d24a', '#f2f0e6', '#b46ad8', '#e8884a']);
    else if (k === COVER.sapling) drawConifer(g, rnd, S, S, { skirt: 0.95, crown: 0, reach: 0.4, taper: 0.9, droop: 0.2, gaps: 0.05, greens: SPRUCE, trunk: ['#2a211b', '#4a3b30'] });
    else drawShrub(g, rnd, S, S, DRY, true);
    shadeTile(g, S, S, 0);
  });
  return toTexture(c, COVER_TILES);
}

/**
 * 植被的材质。
 *  - 颜色 = 贴图 × 每棵的色调（顶点色）× gain（画布上的颜色是「看上去的颜色」，这里换算成和山体、草地同一个量级的反照率）；
 *  - 轮廓按贴图的透明度裁掉；离得远了把门槛放低，不然缩小后的树会越来越瘦；
 *  - 法线不用面片自己的（那样一片亮一片暗，一眼看出是十字插片）：统一朝上，再往「离树干远的那一侧」偏一点，
 *    于是朝着太阳的半边树冠亮、背着的半边暗；
 *  - 顶上随风轻轻晃。
 */
export function createFoliageMaterial(atlas: THREE.Texture, gain: number, swayAmp: number): THREE.MeshStandardNodeMaterial {
  const t: N = texture(atlas, uv());
  // aLeaf = （面片横着的方向 x、z，离地多高 0–1，这个顶点在面片的左边还是右边 ∓1）
  const leaf: N = attribute('aLeaf', 'vec4');
  const tint: N = attribute('color', 'vec3');
  const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));
  let rgb: N = t.rgb.mul(tint).mul(gain).mul(mix(float(1.0), float(1.3), daylight));
  // 画布上的颜色偏艳：往灰里收一点
  const lum: N = dot(rgb, vec3(0.3, 0.55, 0.15));
  rgb = mix(vec3(lum, lum, lum), rgb, 0.84);
  // 下雪：枝叶上挂一层，越靠上越多
  rgb = mix(rgb, SNOW, cityUniforms.snow.mul(leaf.z.mul(0.5).add(0.25)));
  rgb = rgb.mul(mix(float(1.0), float(0.72), cityUniforms.wetness));
  // 面片侧对着镜头的时候是一条拉长的线：淡掉（另外几片这时候是正对着的）
  const toCam: N = normalize(vec2(cameraPosition.x.sub(positionWorld.x), cameraPosition.z.sub(positionWorld.z)));
  const facing: N = abs(toCam.x.mul(leaf.y.negate()).add(toCam.y.mul(leaf.x)));
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.94, side: THREE.DoubleSide });
  m.colorNode = vec4(rgb, t.a.mul(smoothstep(0.1, 0.32, facing)));
  m.alphaTestNode = mix(float(0.4), float(0.14), smoothstep(40.0, 260.0, length(positionView)));
  m.alphaToCoverage = true;
  const out: N = leaf.xy.mul(leaf.w);
  m.normalNode = normalize(vec3(out.x.mul(0.6), 0.8, out.y.mul(0.6))).transformDirection(cameraViewMatrix);
  const p: N = positionLocal;
  const w: N = leaf.z.mul(leaf.z).mul(swayAmp);
  const t0: N = time;
  const swayX: N = sin(t0.mul(1.1).add(p.x.mul(0.07)).add(p.z.mul(0.05))).mul(w);
  const swayZ: N = cos(t0.mul(0.83).add(p.z.mul(0.06)).sub(p.x.mul(0.04))).mul(w).mul(0.7);
  m.positionNode = p.add((vec3 as N)(swayX, 0, swayZ));
  return m;
}

/** 攒一批面片植物，合成一个网格 */
export class FoliageBatch {
  private readonly pos: number[] = [];
  private readonly uvs: number[] = [];
  private readonly col: number[] = [];
  private readonly leaf: number[] = [];
  private readonly idx: number[] = [];
  count = 0;

  /**
   * 加一棵：根在 (x, y, z)，面片宽 w、高 h，用图集里一行 tiles 格中的第 tile 格；
   * quads 片面片绕着竖轴均匀错开，yaw 是第一片的朝向；mirror 把贴图左右翻过来（同一种树多一个样子）
   */
  add(x: number, y: number, z: number, w: number, h: number, tile: number, tiles: number, yaw: number, quads: number, tint: [number, number, number], mirror = false): void {
    const pad = 0.012;
    let u0 = (tile + pad) / tiles;
    let u1 = (tile + 1 - pad) / tiles;
    if (mirror) [u0, u1] = [u1, u0];
    for (let q = 0; q < quads; q++) {
      const a = yaw + (q * Math.PI) / quads;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const base = this.pos.length / 3;
      const hw = w / 2;
      this.pos.push(x - dx * hw, y, z - dz * hw, x + dx * hw, y, z + dz * hw, x + dx * hw, y + h, z + dz * hw, x - dx * hw, y + h, z - dz * hw);
      this.uvs.push(u0, 0.995, u1, 0.995, u1, 0.004, u0, 0.004);
      for (let k = 0; k < 4; k++) this.col.push(tint[0], tint[1], tint[2]);
      this.leaf.push(dx, dz, 0, -1, dx, dz, 0, 1, dx, dz, 1, 1, dx, dz, 1, -1);
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.count++;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(this.leaf, 4));
    // 光照用不到面片自己的法线，但别的地方（阴影的偏移）要有：统一朝上
    const up = new Float32Array(this.pos.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(up, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
