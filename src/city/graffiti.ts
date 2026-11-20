import * as THREE from 'three/webgpu';

/** 图集的排布：4 × 4 格，每格宽是高的两倍（一扇卷帘门的比例） */
export const GRAFFITI_COLS = 4;
export const GRAFFITI_ROWS = 4;
const CELL_W = 512;
const CELL_H = 256;

type Ctx = CanvasRenderingContext2D;

/** 固定种子的随机数：每次打开游戏，墙上的涂鸦长得一样 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Piece {
  text: string;
  /** 字的上下两个颜色（渐变） */
  top: string;
  bottom: string;
  outline: string;
  /** 立体投影的颜色 */
  depth: string;
  /** 字后面那团"云"的颜色；空着就不画 */
  cloud: string;
}

/** 大字涂鸦（throw-up）：胖体字、粗描边、立体投影、网点、高光，底下一团云 */
const PIECES: Piece[] = [
  { text: 'UMBRA', top: '#ffe04a', bottom: '#ff7a1a', outline: '#111014', depth: '#7a1fd0', cloud: '#2b2440' },
  { text: 'KAOS', top: '#ff5fa8', bottom: '#b3188f', outline: '#fdfbf5', depth: '#141118', cloud: '' },
  { text: 'RUSH', top: '#7df2ff', bottom: '#1f78ff', outline: '#0e1020', depth: '#ff3d6e', cloud: '#f4efe6' },
  { text: 'ZOOM', top: '#c6ff4a', bottom: '#2fb866', outline: '#0f1410', depth: '#16324a', cloud: '' },
  { text: 'NITE', top: '#f6f2ea', bottom: '#aab4c8', outline: '#15131c', depth: '#e23b2e', cloud: '#40326e' },
  { text: 'VOLT', top: '#ffb23f', bottom: '#e8452c', outline: '#fdfbf5', depth: '#1b1b22', cloud: '' },
  { text: 'DRIFT', top: '#b98bff', bottom: '#5d2ee0', outline: '#0f0d18', depth: '#28d6c0', cloud: '#161a26' },
  { text: 'BOOM', top: '#ff6a4a', bottom: '#c3162a', outline: '#16110f', depth: '#ffd23c', cloud: '' },
  { text: 'WAVY', top: '#5af0c4', bottom: '#168a9c', outline: '#fdfbf5', depth: '#1a1730', cloud: '' },
  { text: 'HEAT', top: '#ffd64a', bottom: '#ff3d2e', outline: '#130f0f', depth: '#3a1466', cloud: '#e9e2d4' },
];

/** 签名（tag）：一笔写成的手写字，单色 */
const TAGS: { text: string; color: string; second: string }[] = [
  { text: 'nova!', color: '#f4f1ea', second: '#ff4f8a' },
  { text: 'kaze 1', color: '#141218', second: '#f4f1ea' },
  { text: 'jinx', color: '#ff4f8a', second: '#f4f1ea' },
  { text: 'stay loud', color: '#f4f1ea', second: '#ffd23c' },
  { text: 'viper', color: '#7df2ff', second: '#141218' },
  { text: 'zr crew', color: '#ffd23c', second: '#141218' },
];

const ROUND = '"Arial Rounded MT Bold", "Arial Black", "Helvetica Neue", Arial, sans-serif';
const HAND = '"Marker Felt", "Chalkboard SE", "Comic Sans MS", cursive';

/** 网点图案：涂在字的下半截，像喷漆的渐变 */
function dots(color: string): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = c.height = 14;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  for (const [x, y] of [
    [3.5, 3.5],
    [10.5, 10.5],
  ]) {
    g.beginPath();
    g.arc(x, y, 2.6, 0, Math.PI * 2);
    g.fill();
  }
  return g.createPattern(c, 'repeat');
}

function drawPiece(g: Ctx, p: Piece, random: () => number): void {
  g.save();
  g.translate(CELL_W / 2, CELL_H / 2 + 6);
  g.rotate((random() - 0.5) * 0.14);
  g.transform(1, 0, -0.12 + random() * 0.1, 1, 0, 0);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 178;
  g.font = `${size}px ${ROUND}`;
  while (g.measureText(p.text).width > CELL_W - 96 && size > 60) {
    size -= 6;
    g.font = `${size}px ${ROUND}`;
  }
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // 字后面的一团云：一圈大小不一的圆
  if (p.cloud) {
    g.fillStyle = p.cloud;
    const w = g.measureText(p.text).width / 2 + 26;
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * Math.PI * 2;
      g.beginPath();
      g.arc(Math.cos(a) * w * 0.86, Math.sin(a) * size * 0.42, size * (0.26 + random() * 0.12), 0, Math.PI * 2);
      g.fill();
    }
    g.fillRect(-w * 0.8, -size * 0.4, w * 1.6, size * 0.8);
  }

  // 立体投影：往右下叠十几层
  g.fillStyle = p.depth;
  g.strokeStyle = p.depth;
  g.lineWidth = 22;
  for (let k = 14; k >= 1; k -= 2) {
    g.strokeText(p.text, k, k);
  }
  // 粗描边
  g.strokeStyle = p.outline;
  g.lineWidth = 22;
  g.strokeText(p.text, 0, 0);
  // 往下流的几道漆
  g.lineWidth = 7;
  const half = g.measureText(p.text).width / 2;
  for (let k = 0; k < 4; k++) {
    const x = (random() * 2 - 1) * half * 0.85;
    const y0 = size * 0.36;
    g.beginPath();
    g.moveTo(x, y0);
    g.lineTo(x, y0 + 14 + random() * 34);
    g.stroke();
  }
  // 填色：上下渐变
  const grad = g.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
  grad.addColorStop(0, p.top);
  grad.addColorStop(1, p.bottom);
  g.fillStyle = grad;
  g.fillText(p.text, 0, 0);
  // 下半截的网点
  const pattern = dots(p.bottom);
  if (pattern) {
    g.save();
    g.beginPath();
    g.rect(-CELL_W, -size * 0.12, CELL_W * 2, size);
    g.clip();
    g.fillStyle = pattern;
    g.globalAlpha = 0.55;
    g.fillText(p.text, 0, 0);
    g.restore();
  }
  // 字里面的一圈细线
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 2.5;
  g.strokeText(p.text, -2, -3);
  // 左上角的高光：几个小亮块和一颗星
  g.fillStyle = '#ffffff';
  for (let k = 0; k < 3; k++) {
    const x = -half + 30 + k * half * 0.62 + random() * 14;
    g.beginPath();
    g.ellipse(x, -size * 0.27, 9, 4.5, -0.5, 0, Math.PI * 2);
    g.fill();
  }
  star(g, half * 0.86, -size * 0.36, 17);
  g.restore();
}

function star(g: Ctx, x: number, y: number, r: number): void {
  g.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const rr = k % 2 === 0 ? r : r * 0.28;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

function drawTag(g: Ctx, t: { text: string; color: string; second: string }, random: () => number): void {
  g.save();
  g.translate(CELL_W / 2, CELL_H / 2);
  g.rotate(-0.1 + (random() - 0.5) * 0.12);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 132;
  g.font = `italic ${size}px ${HAND}`;
  while (g.measureText(t.text).width > CELL_W - 90 && size > 50) {
    size -= 6;
    g.font = `italic ${size}px ${HAND}`;
  }
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const half = g.measureText(t.text).width / 2;
  // 字下面甩的一笔，末尾带个箭头
  g.strokeStyle = t.second;
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(-half - 6, size * 0.46);
  g.quadraticCurveTo(0, size * 0.62, half + 18, size * 0.36);
  g.stroke();
  g.beginPath();
  g.moveTo(half + 18, size * 0.36);
  g.lineTo(half - 2, size * 0.3);
  g.moveTo(half + 18, size * 0.36);
  g.lineTo(half + 6, size * 0.56);
  g.stroke();
  // 字本身：先描一圈让笔画更粗，再填
  g.strokeStyle = t.color;
  g.fillStyle = t.color;
  g.lineWidth = 6;
  g.strokeText(t.text, 0, 0);
  g.fillText(t.text, 0, 0);
  // 头顶一个小皇冠或者引号
  g.strokeStyle = t.second;
  g.lineWidth = 6;
  g.beginPath();
  if (random() > 0.5) {
    const cx = -half * 0.6;
    const cy = -size * 0.56;
    g.moveTo(cx - 22, cy + 12);
    g.lineTo(cx - 26, cy - 12);
    g.lineTo(cx - 10, cy);
    g.lineTo(cx, cy - 16);
    g.lineTo(cx + 10, cy);
    g.lineTo(cx + 26, cy - 12);
    g.lineTo(cx + 22, cy + 12);
    g.closePath();
  } else {
    for (const dx of [0, 16]) {
      g.moveTo(half * 0.7 + dx, -size * 0.6);
      g.lineTo(half * 0.7 + dx - 6, -size * 0.42);
    }
  }
  g.stroke();
  g.restore();
}

/**
 * 涂鸦图集：十幅大字涂鸦加六个签名，画在一张带透明度的贴图上。
 * 喷在拉下来的卷帘门上（见 facade.ts）——《不羁》的街道气质一大半来自墙上的涂鸦。
 * 内容都是自己编的词，不照搬任何现成的作品。
 */
export function createGraffitiAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * GRAFFITI_COLS;
  canvas.height = CELL_H * GRAFFITI_ROWS;
  const g = canvas.getContext('2d')!;
  const random = rng(20261110);
  const cells = GRAFFITI_COLS * GRAFFITI_ROWS;
  for (let i = 0; i < cells; i++) {
    g.save();
    g.translate((i % GRAFFITI_COLS) * CELL_W, Math.floor(i / GRAFFITI_COLS) * CELL_H);
    g.beginPath();
    g.rect(0, 0, CELL_W, CELL_H);
    g.clip();
    if (i < PIECES.length) drawPiece(g, PIECES[i], random);
    else drawTag(g, TAGS[(i - PIECES.length) % TAGS.length], random);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
