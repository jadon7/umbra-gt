import * as THREE from 'three/webgpu';
import { dot, float, mix, smoothstep, texture, vec3 } from 'three/tsl';
import { cityUniforms } from './materials.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 图集里的一格。v0 是下沿、v1 是上沿 */
export interface SignCell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** 这块招牌的主色（线性 RGB），夜里它往周围洒的光就是这个颜色 */
  color: [number, number, number];
}

export interface SignAtlas {
  texture: THREE.CanvasTexture;
  /** 横幅招牌（宽 : 高 = 3 : 1） */
  wide: SignCell[];
  /** 竖招牌（宽 : 高 = 1 : 4） */
  tall: SignCell[];
}

const SIZE = 2048;
const WIDE_W = 512;
const WIDE_H = 170;
const TALL_W = 128;
const TALL_H = 512;

/**
 * 灯管的颜色。真实街道上的霓虹以红、琥珀、暖白为主，偶尔一块绿、蓝或粉；
 * 满街高饱和的紫和青是"合成器浪潮"的画风，不是街头的样子
 */
const NEON = ['#ff4a3a', '#fff0d2', '#ffbe45', '#ff7a2f', '#3fd98c', '#ff5c8f', '#f1f5ff', '#58b6ff'];
/** 灯箱的底色（发光的亚克力板）：米白、奶黄、白、橙黄 */
const LIGHTBOX = ['#f2e8cf', '#f6f2e8', '#f0c648', '#ece6d8'];
/** 灯箱上的字 */
const LIGHTBOX_INK = ['#8a1812', '#14161a', '#16294d', '#1c1c1c'];
const CJK = `900 100px "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif`;
const LATIN = `italic 800 100px "Avenir Next", "Helvetica Neue", Arial, sans-serif`;

/** 店名都是虚构的 */
const WIDE_SIGNS: [string, string][] = [
  ['NOVA MOTORS', ''],
  ['霓虹湾酒店', 'NEON BAY HOTEL'],
  ['KUMO 拉面', ''],
  ['PIXEL ARCADE', ''],
  ['极速俱乐部', 'VELOCITY CLUB'],
  ['ORBIT RECORDS', ''],
  ['蓝鲸咖啡', 'BLUE WHALE COFFEE'],
  ['24H 便利店', ''],
  ['HALO CINEMA', ''],
  ['夜行者酒吧', 'NIGHTCRAWLER BAR'],
  ['VOLT 能量', ''],
  ['星河影城', 'GALAXY CINEMA'],
  ['UMBRA GT', ''],
  ['珍珠奶茶', 'BOBA TEA'],
  ['海湾银行', 'BAY BANK'],
  ['DRIFT KING', '改装 · TUNING'],
  ['深夜食堂', ''],
  ['LUNA 药房', ''],
  ['赛博网咖', 'CYBER CAFE'],
  ['TOKI 寿司', ''],
  ['晚风书店', 'EVENING BOOKS'],
  ['APEX 轮胎', ''],
  ['卡拉 OK', 'KARAOKE'],
  ['龙门火锅', 'HOT POT'],
];

const TALL_SIGNS: string[] = [
  '酒店', '拉面', '电玩城', '酒吧', '网咖', '火锅', '药房', '咖啡',
  '寿司', '影城', '便利店', '烧烤', '奶茶', '书店', '改装', '夜市',
  'HOTEL', 'BAR', 'ARCADE', 'CAFE', 'CLUB', '24H', 'SUSHI', 'RAMEN',
  'NOVA', 'VOLT', 'ORBIT', 'HALO', 'LUNA', 'TOKI', 'KUMO', 'APEX',
];

const isCjk = (s: string) => /[㐀-鿿]/.test(s);

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 把字号缩到能放进 maxW，返回实际字号 */
function fitFont(ctx: CanvasRenderingContext2D, text: string, base: string, size: number, maxW: number): number {
  ctx.font = base.replace('100px', `${size}px`);
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    size = Math.floor((size * maxW) / w);
    ctx.font = base.replace('100px', `${size}px`);
  }
  return size;
}

/** 带辉光的霓虹字 */
function neonText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, glow: number): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = glow * 0.35;
  ctx.fillText(text, x, y);
  ctx.restore();
  // 灯管中心发白
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#ffffff';
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawWide(ctx: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  const [main, sub] = WIDE_SIGNS[k];
  const color = NEON[(k * 3 + 1) % NEON.length];
  const accent = NEON[(k * 5 + 4) % NEON.length];
  const style = k % 3;
  const pad = 8;
  const w = WIDE_W - pad * 2;
  const h = WIDE_H - pad * 2;
  ctx.save();
  ctx.translate(x + pad, y + pad);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (style === 1) {
    // 灯箱：整块底色 + 深色字
    roundRect(ctx, 0, 0, w, h, 10);
    ctx.fillStyle = LIGHTBOX[k % LIGHTBOX.length];
    ctx.fill();
    const ink = LIGHTBOX_INK[(k >> 1) % LIGHTBOX_INK.length];
    ctx.fillStyle = ink;
    ctx.fillRect(0, h * 0.78, w, h * 0.22);
    const cy = sub ? h * 0.4 : h * 0.5;
    fitFont(ctx, main, isCjk(main) ? CJK : LATIN, sub ? 76 : 92, w - 44);
    ctx.fillText(main, w / 2, cy);
    if (sub) {
      ctx.fillStyle = '#f2ecdc';
      fitFont(ctx, sub, LATIN, 26, w - 60);
      ctx.fillText(sub, w / 2, h * 0.885);
    }
    // 旧灯箱：板子后面的灯管亮度不匀，边角发暗
    const shade = ctx.createLinearGradient(0, 0, w, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.28)');
    shade.addColorStop(0.18, 'rgba(0,0,0,0)');
    shade.addColorStop(0.6, 'rgba(0,0,0,0.08)');
    shade.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, w, h * 0.78);
  } else {
    // 深色底板 + 霓虹字
    roundRect(ctx, 0, 0, w, h, 10);
    ctx.fillStyle = style === 0 ? '#08080c' : '#0d0a14';
    ctx.fill();
    if (style === 0) {
      // 一圈霓虹灯管做边框
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 5;
      roundRect(ctx, 9, 9, w - 18, h - 18, 14);
      ctx.stroke();
      ctx.restore();
    } else {
      // 上下两道灯条
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 12;
      ctx.fillStyle = accent;
      ctx.fillRect(22, 12, w - 44, 5);
      ctx.fillRect(22, h - 17, w - 44, 5);
      ctx.restore();
    }
    const cy = sub ? h * 0.42 : h * 0.52;
    fitFont(ctx, main, isCjk(main) ? CJK : LATIN, sub ? 74 : 88, w - 64);
    neonText(ctx, main, w / 2, cy, color, 22);
    if (sub) {
      fitFont(ctx, sub, LATIN, 25, w - 90);
      neonText(ctx, sub, w / 2, h * 0.8, accent, 10);
    }
  }
  ctx.restore();
}

function drawTall(ctx: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  const text = TALL_SIGNS[k];
  const color = NEON[(k * 5 + 2) % NEON.length];
  const accent = NEON[(k * 3 + 5) % NEON.length];
  const lightbox = k % 4 === 3;
  const pad = 6;
  const w = TALL_W - pad * 2;
  const h = TALL_H - pad * 2;
  const chars = [...text];
  ctx.save();
  ctx.translate(x + pad, y + pad);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  roundRect(ctx, 0, 0, w, h, 9);
  ctx.fillStyle = lightbox ? LIGHTBOX[k % LIGHTBOX.length] : '#09090d';
  ctx.fill();
  if (!lightbox) {
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    roundRect(ctx, 7, 7, w - 14, h - 14, 10);
    ctx.stroke();
    ctx.restore();
  }

  const top = 30;
  const usable = h - top * 2;
  const stepY = Math.min(usable / chars.length, 104);
  const size = Math.min(stepY * 0.9, isCjk(text) ? 88 : 78);
  const startY = h / 2 - (stepY * (chars.length - 1)) / 2;
  chars.forEach((ch, n) => {
    const base = isCjk(ch) ? CJK : LATIN.replace('italic ', '');
    fitFont(ctx, ch, base, size, w - 30);
    if (lightbox) {
      ctx.fillStyle = LIGHTBOX_INK[(k >> 2) % LIGHTBOX_INK.length];
      ctx.fillText(ch, w / 2, startY + n * stepY);
    } else {
      neonText(ctx, ch, w / 2, startY + n * stepY, color, 18);
    }
  });
  ctx.restore();
}

/** 把所有招牌画进一张图集。只在浏览器里调用 */
export function createSignAtlas(): SignAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#050507';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // 取样范围往里收几个像素，远处用小级别贴图时不会串到隔壁格
  const inset = 5;
  const cell = (px: number, py: number, pw: number, ph: number, hex: string): SignCell => {
    const c = new THREE.Color(hex);
    return {
      u0: (px + inset) / SIZE,
      u1: (px + pw - inset) / SIZE,
      v1: 1 - (py + inset) / SIZE,
      v0: 1 - (py + ph - inset) / SIZE,
      color: [c.r, c.g, c.b],
    };
  };

  const wide: SignCell[] = [];
  for (let k = 0; k < WIDE_SIGNS.length; k++) {
    const px = (k % 4) * WIDE_W;
    const py = Math.floor(k / 4) * WIDE_H;
    drawWide(ctx, px, py, k);
    wide.push(cell(px, py, WIDE_W, WIDE_H, k % 3 === 1 ? LIGHTBOX[k % LIGHTBOX.length] : NEON[(k * 3 + 1) % NEON.length]));
  }
  const tall: SignCell[] = [];
  for (let k = 0; k < TALL_SIGNS.length; k++) {
    const px = (k % 16) * TALL_W;
    const py = SIZE / 2 + Math.floor(k / 16) * TALL_H;
    drawTall(ctx, px, py, k);
    tall.push(cell(px, py, TALL_W, TALL_H, k % 4 === 3 ? LIGHTBOX[k % LIGHTBOX.length] : NEON[(k * 5 + 2) % NEON.length]));
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture: tex, wide, tall };
}

/**
 * 招牌材质：白天是一块印着字的灯箱面板（只带一点点自发光），
 * 入夜后由 cityUniforms.lights 点亮（阶段 4）。
 */
export function createSignMaterial(atlas: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const t: N = texture(atlas);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0 });
  m.colorNode = t.rgb.mul(0.85).add(0.01);
  // 入夜后的亮度。大面积的亮色（灯箱）要压着点，否则一块招牌就把半条街照成它的颜色
  const luma: N = dot(t.rgb, vec3(0.3, 0.55, 0.15));
  m.emissiveNode = t.rgb.mul(cityUniforms.lights.mul(mix(float(1.5), float(0.55), smoothstep(0.35, 0.8, luma))).add(0.1));
  return m;
}
