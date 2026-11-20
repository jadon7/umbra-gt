import * as THREE from 'three/webgpu';
import { abs, attribute, float, floor, fract, max, mix, normalWorld, positionWorld, smoothstep, step, texture, time, uv, vec2, vec3, vec4 } from 'three/tsl';
import { cityUniforms, hash2, nz } from '../city/materials.ts';
import { SIGNS } from './signRects.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 山路沿线的建筑和设施用的材质。
 * 几何是程序搭的，一种材质要管很多种东西，所以颜色都写在顶点上（MeshBuilder.tint），材质只负责「质感」：
 *  - plain：平的漆面（钢结构、混凝土、塑料）
 *  - boards：横着的一条条板缝（木屋的墙板、码头的木板、看台的台阶）
 *  - seams：顺着坡的一道道立缝（铁皮屋顶）
 */
function createBuilt(pattern: 'plain' | 'boards' | 'seams'): THREE.MeshStandardNodeMaterial {
  const p: N = positionWorld;
  const base: N = attribute('color', 'vec3');
  const grime: N = nz(p.x.mul(0.6).add(p.y.mul(1.1)), p.z.mul(0.6), 21).mul(0.5).add(0.5);
  const fine: N = nz(p.x.mul(7.0).add(p.y.mul(5.0)), p.z.mul(7.0), 22).mul(0.5).add(0.5);
  // 竖着往下挂的水渍，只在竖直的面上
  const streak: N = smoothstep(0.6, 0.92, nz(p.x.add(p.z).mul(1.9), p.y.mul(0.16), 23).mul(0.5).add(0.5)).mul(float(1).sub(abs(normalWorld.y)));
  const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));
  let color: N = base.mul(mix(float(0.8), float(1.08), grime)).mul(fine.mul(0.14).add(0.93));
  color = mix(color, color.mul(0.6), streak.mul(0.5));
  let rough: N = float(0.72);
  if (pattern === 'boards') {
    const v: N = uv().y;
    const gap: N = float(1).sub(smoothstep(0.012, 0.03, abs(fract(v.div(0.24)).sub(0.5)).mul(0.24)));
    // 每块板深浅不一
    const board: N = hash2(vec2(floor(v.div(0.24)), 7.0)).mul(0.22).add(0.89);
    color = mix(color.mul(board), color.mul(0.35), gap.mul(0.8));
    rough = float(0.86);
  } else if (pattern === 'seams') {
    const u: N = uv().x;
    const seam: N = float(1).sub(smoothstep(0.015, 0.045, abs(fract(u.div(0.5)).sub(0.5)).mul(0.5)));
    color = mix(color, color.mul(1.35), seam.mul(0.6));
    rough = float(0.5);
  }
  color = color.mul(mix(float(1.0), float(1.3), daylight)).mul(mix(float(1.0), float(0.8), cityUniforms.wetness));
  const m = new THREE.MeshStandardNodeMaterial({ metalness: pattern === 'seams' ? 0.35 : 0, side: THREE.DoubleSide });
  m.colorNode = color;
  m.roughnessNode = rough;
  return m;
}

/**
 * 窗：贴图坐标是米。按一米多宽、一米半高分成一格一格的窗扇，中间是窗框。
 * 白天是发暗的玻璃，映着天；入夜后一部分窗亮起来（顶点色 = 灯光的颜色，亮哪几扇按格子随机）。
 */
function createGlass(): THREE.MeshStandardNodeMaterial {
  const g: N = uv();
  const cell: N = vec2(floor(g.x.div(1.25)), floor(g.y.div(1.6)));
  const fx: N = abs(fract(g.x.div(1.25)).sub(0.5)).mul(1.25);
  const fy: N = abs(fract(g.y.div(1.6)).sub(0.5)).mul(1.6);
  const frame: N = max(smoothstep(0.55, 0.585, fx), smoothstep(0.72, 0.755, fy));
  const p: N = positionWorld;
  // 同一栋楼里亮哪几扇：按格子和这面墙在哪儿
  const seed: N = hash2(cell.add(vec2(floor(p.x.mul(0.21)), floor(p.z.mul(0.21)))));
  const on: N = step(0.34, seed);
  const lit: N = smoothstep(0.15, 0.6, cityUniforms.lights);
  const warm: N = attribute('color', 'vec3');
  // 窗帘、屋里的东西：亮度不匀
  const inside: N = nz(g.x.mul(2.3), g.y.mul(1.7), 31).mul(0.3).add(0.75);
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0.2 });
  m.colorNode = mix(vec3(0.016, 0.022, 0.03), vec3(0.05, 0.045, 0.04), frame);
  m.roughnessNode = mix(float(0.08), float(0.7), frame);
  m.emissiveNode = warm.mul(on).mul(inside).mul(lit).mul(float(1).sub(frame)).mul(2.6);
  return m;
}

/* ------------------------------------------------------------------ */
/* 路牌和招牌的图集                                                     */
/* ------------------------------------------------------------------ */

type Ctx = CanvasRenderingContext2D;

const ATLAS = 2048;
const FONT = '"Arial Narrow", "Helvetica Neue", Arial, "PingFang SC", sans-serif';


function diamond(g: Ctx, x: number, y: number, s: number, draw: (g: Ctx, c: number) => void): void {
  g.save();
  g.translate(x + s / 2, y + s / 2);
  g.rotate(Math.PI / 4);
  const r = s * 0.34;
  g.fillStyle = '#101010';
  g.fillRect(-r, -r, r * 2, r * 2);
  g.fillStyle = '#f2b90a';
  g.fillRect(-r * 0.93, -r * 0.93, r * 1.86, r * 1.86);
  g.restore();
  g.save();
  g.translate(x + s / 2, y + s / 2);
  g.strokeStyle = '#101010';
  g.fillStyle = '#101010';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  draw(g, s);
  g.restore();
}

function arrowHead(g: Ctx, x: number, y: number, angle: number, size: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.beginPath();
  g.moveTo(size, 0);
  g.lineTo(-size * 0.6, -size * 0.75);
  g.lineTo(-size * 0.6, size * 0.75);
  g.closePath();
  g.fill();
  g.restore();
}

function label(g: Ctx, text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 800): void {
  g.fillStyle = color;
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

function drawSigns(g: Ctx): void {
  let x = 0;
  let y = 0;
  let rowH = 0;
  /** 在图集里占一块地方，画完记下它的贴图坐标 */
  const place = (name: string, w: number, h: number, draw: (x: number, y: number) => void): void => {
    if (x + w > ATLAS) {
      x = 0;
      y += rowH + 8;
      rowH = 0;
    }
    draw(x, y);
    SIGNS[name] = [(x + 1) / ATLAS, 1 - (y + h - 1) / ATLAS, (x + w - 1) / ATLAS, 1 - (y + 1) / ATLAS];
    x += w + 8;
    rowH = Math.max(rowH, h);
  };

  /* 黄色菱形的警告牌 */
  const curve = (dir: number) => (c: Ctx, s: number) => {
    c.lineWidth = s * 0.075;
    c.beginPath();
    c.moveTo(-dir * s * 0.06, s * 0.2);
    c.lineTo(-dir * s * 0.06, s * 0.02);
    c.quadraticCurveTo(-dir * s * 0.06, -s * 0.1, dir * s * 0.08, -s * 0.12);
    c.stroke();
    arrowHead(c, dir * s * 0.13, -s * 0.125, dir > 0 ? -0.1 : Math.PI + 0.1, s * 0.075);
  };
  const hairpin = (dir: number) => (c: Ctx, s: number) => {
    c.lineWidth = s * 0.07;
    c.beginPath();
    c.moveTo(-dir * s * 0.1, s * 0.2);
    c.lineTo(-dir * s * 0.1, -s * 0.04);
    c.arc(0, -s * 0.04, s * 0.1, dir > 0 ? Math.PI : 0, dir > 0 ? 0 : Math.PI, dir < 0);
    c.lineTo(dir * s * 0.1, s * 0.08);
    c.stroke();
    arrowHead(c, dir * s * 0.1, s * 0.13, Math.PI / 2, s * 0.07);
  };
  place('curveL', 256, 256, (x0, y0) => diamond(g, x0, y0, 256, curve(-1)));
  place('curveR', 256, 256, (x0, y0) => diamond(g, x0, y0, 256, curve(1)));
  place('hairpinL', 256, 256, (x0, y0) => diamond(g, x0, y0, 256, hairpin(-1)));
  place('hairpinR', 256, 256, (x0, y0) => diamond(g, x0, y0, 256, hairpin(1)));
  place('rocks', 256, 256, (x0, y0) =>
    diamond(g, x0, y0, 256, (c, s) => {
      // 一面陡坡，石头往下滚
      c.beginPath();
      c.moveTo(-s * 0.2, s * 0.17);
      c.lineTo(-s * 0.2, -s * 0.16);
      c.lineTo(-s * 0.02, s * 0.17);
      c.closePath();
      c.fill();
      for (const [dx, dy, r] of [[0.02, -0.08, 0.035], [0.1, 0.0, 0.045], [0.06, 0.1, 0.03], [0.17, 0.13, 0.04]] as const) {
        c.beginPath();
        c.arc(s * dx, s * dy, s * r, 0, 7);
        c.fill();
      }
    }),
  );
  place('deer', 256, 256, (x0, y0) =>
    diamond(g, x0, y0, 256, (c, s) => {
      // 一头跳起来的鹿（示意）
      c.lineWidth = s * 0.035;
      c.beginPath();
      c.ellipse(0, 0, s * 0.13, s * 0.06, -0.25, 0, 7);
      c.fill();
      for (const [ax, ay, bx, by] of [[-0.1, 0.03, -0.19, 0.16], [-0.07, 0.04, -0.11, 0.18], [0.08, 0.0, 0.17, 0.1], [0.1, -0.02, 0.21, 0.04], [0.1, -0.05, 0.16, -0.15], [0.16, -0.15, 0.13, -0.22], [0.16, -0.15, 0.21, -0.21]] as const) {
        c.beginPath();
        c.moveTo(s * ax, s * ay);
        c.lineTo(s * bx, s * by);
        c.stroke();
      }
      c.beginPath();
      c.ellipse(s * 0.18, -s * 0.13, s * 0.045, s * 0.028, -0.5, 0, 7);
      c.fill();
    }),
  );
  place('grade', 256, 256, (x0, y0) =>
    diamond(g, x0, y0, 256, (c, s) => {
      c.beginPath();
      c.moveTo(-s * 0.2, s * 0.12);
      c.lineTo(s * 0.2, s * 0.12);
      c.lineTo(s * 0.2, -s * 0.04);
      c.closePath();
      c.fill();
      label(c, '8%', -s * 0.03, -s * 0.07, s * 0.15, '#101010');
    }),
  );

  /* 限速牌：白底黑字 */
  for (const v of ['80', '50', '30']) {
    place(`speed${v}`, 192, 256, (x0, y0) => {
      g.fillStyle = '#101010';
      g.fillRect(x0, y0, 192, 256);
      g.fillStyle = '#f1f1ec';
      g.fillRect(x0 + 8, y0 + 8, 176, 240);
      label(g, 'SPEED', x0 + 96, y0 + 44, 36, '#101010');
      label(g, 'LIMIT', x0 + 96, y0 + 84, 36, '#101010');
      label(g, v, x0 + 96, y0 + 176, 128, '#101010', 'center', 900);
    });
  }
  /* 隧道口两边的红白导向板、黄黑的警示板 */
  place('portal', 192, 256, (x0, y0) => {
    g.save();
    g.beginPath();
    g.rect(x0, y0, 192, 256);
    g.clip();
    g.fillStyle = '#f1f1ec';
    g.fillRect(x0, y0, 192, 256);
    g.fillStyle = '#c8161a';
    for (let k = -3; k < 8; k++) {
      g.beginPath();
      g.moveTo(x0, y0 + k * 64);
      g.lineTo(x0 + 96, y0 + k * 64 + 64);
      g.lineTo(x0 + 192, y0 + k * 64);
      g.lineTo(x0 + 192, y0 + k * 64 + 32);
      g.lineTo(x0 + 96, y0 + k * 64 + 96);
      g.lineTo(x0, y0 + k * 64 + 32);
      g.closePath();
      g.fill();
    }
    g.restore();
  });
  place('hazard', 192, 256, (x0, y0) => {
    g.save();
    g.beginPath();
    g.rect(x0, y0, 192, 256);
    g.clip();
    g.fillStyle = '#f2b90a';
    g.fillRect(x0, y0, 192, 256);
    g.fillStyle = '#101010';
    for (let k = -4; k < 10; k++) {
      g.beginPath();
      g.moveTo(x0 - 20, y0 + k * 56);
      g.lineTo(x0 + 212, y0 + k * 56 - 130);
      g.lineTo(x0 + 212, y0 + k * 56 - 102);
      g.lineTo(x0 - 20, y0 + k * 56 + 28);
      g.closePath();
      g.fill();
    }
    g.restore();
  });
  /* 里程牌：绿底白字的小牌子 */
  for (const km of ['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5']) {
    place(`km${km}`, 128, 176, (x0, y0) => {
      g.fillStyle = '#f1f1ec';
      g.fillRect(x0, y0, 128, 176);
      g.fillStyle = '#0e6a3c';
      g.fillRect(x0 + 6, y0 + 6, 116, 164);
      label(g, 'KM', x0 + 64, y0 + 40, 36, '#f1f1ec');
      label(g, km, x0 + 64, y0 + 108, 62, '#f1f1ec', 'center', 900);
    });
  }
  /* 蓝色的服务区牌、棕色的观景台牌 */
  const board = (name: string, w: number, h: number, bg: string, lines: [string, number][], arrow = 0): void => {
    place(name, w, h, (x0, y0) => {
      g.fillStyle = '#f1f1ec';
      g.fillRect(x0, y0, w, h);
      g.fillStyle = bg;
      g.fillRect(x0 + 8, y0 + 8, w - 16, h - 16);
      const total = lines.reduce((a, l) => a + l[1] * 1.25, 0);
      let ty = y0 + h / 2 - total / 2;
      for (const [text, size] of lines) {
        label(g, text, x0 + (arrow ? (w - h * 0.5) / 2 : w / 2), ty + size * 0.62, size, '#f1f1ec');
        ty += size * 1.25;
      }
      if (arrow) {
        g.fillStyle = '#f1f1ec';
        g.strokeStyle = '#f1f1ec';
        g.lineWidth = h * 0.09;
        const cx = x0 + w - h * 0.42;
        const cy = y0 + h / 2;
        g.beginPath();
        if (arrow === 1) {
          // 朝上（直行）
          g.moveTo(cx, cy + h * 0.26);
          g.lineTo(cx, cy - h * 0.12);
          g.stroke();
          arrowHead(g, cx, cy - h * 0.2, -Math.PI / 2, h * 0.14);
        } else {
          g.moveTo(cx - h * 0.2, cy);
          g.lineTo(cx + h * 0.1, cy);
          g.stroke();
          arrowHead(g, cx + h * 0.17, cy, 0, h * 0.14);
        }
      }
    });
  };
  board('guidePass', 1024, 320, '#0e6a3c', [['云岭山口  CLOUD RIDGE PASS', 60], ['SUMMIT 92 M · TUNNEL · VIADUCT', 40]], 1);
  board('guideLake', 1024, 320, '#0e6a3c', [['湖滨  LAKESIDE', 84], ['FUEL · FOOD · LODGING', 48]], 1);
  board('service', 512, 256, '#14509a', [['FUEL · FOOD', 62], ['NEXT RIGHT', 44]]);
  board('overlook', 512, 256, '#5a3a1e', [['SCENIC OVERLOOK', 54], ['观景台 · 缆车', 46]]);
  board('tunnelName', 1024, 176, '#14509a', [['云岭隧道  CLOUD RIDGE TUNNEL', 62]]);
  board('gallery', 512, 176, '#14509a', [['ROCK SHED · 110 M', 52]]);
  board('lumber', 768, 256, '#2a2a22', [['TIMBERLINE LUMBER CO.', 64], ['SINCE 1968 · KILN DRIED', 36]]);

  /* 招牌：加油站、便利店、餐馆、旅馆 */
  place('fuelBand', 1024, 128, (x0, y0) => {
    g.fillStyle = '#c8161a';
    g.fillRect(x0, y0, 1024, 128);
    g.fillStyle = '#f4f4f0';
    g.fillRect(x0, y0 + 92, 1024, 14);
    label(g, 'APEX', x0 + 512, y0 + 50, 84, '#f4f4f0', 'center', 900);
  });
  place('fuelPrice', 256, 448, (x0, y0) => {
    g.fillStyle = '#101216';
    g.fillRect(x0, y0, 256, 448);
    g.fillStyle = '#c8161a';
    g.fillRect(x0 + 10, y0 + 10, 236, 120);
    label(g, 'APEX', x0 + 128, y0 + 72, 80, '#f4f4f0', 'center', 900);
    const rows: [string, string, string][] = [['91', '3.79', '#f4f4f0'], ['95', '4.15', '#f4f4f0'], ['DSL', '3.98', '#ffb224']];
    rows.forEach(([name, price, color], k) => {
      label(g, name, x0 + 22, y0 + 184 + k * 92, 44, '#9aa0a8', 'left');
      label(g, price, x0 + 236, y0 + 184 + k * 92, 76, color, 'right', 900);
    });
  });
  place('mart', 512, 128, (x0, y0) => {
    g.fillStyle = '#f4f4f0';
    g.fillRect(x0, y0, 512, 128);
    label(g, 'MART · 24H', x0 + 256, y0 + 66, 82, '#c8161a', 'center', 900);
  });
  place('diner', 768, 224, (x0, y0) => {
    g.fillStyle = '#16181c';
    g.fillRect(x0, y0, 768, 224);
    g.strokeStyle = '#ff3b2f';
    g.lineWidth = 8;
    g.strokeRect(x0 + 14, y0 + 14, 740, 196);
    g.shadowColor = '#ff5a3a';
    g.shadowBlur = 18;
    label(g, 'RIDGE DINER', x0 + 384, y0 + 94, 112, '#ffd9c8', 'center', 900);
    label(g, 'BURGERS · PIE · COFFEE', x0 + 384, y0 + 176, 40, '#6fd3ff', 'center', 700);
    g.shadowBlur = 0;
  });
  place('lodge', 768, 176, (x0, y0) => {
    g.fillStyle = '#2a1c12';
    g.fillRect(x0, y0, 768, 176);
    g.fillStyle = '#d9b87a';
    g.fillRect(x0 + 10, y0 + 10, 748, 6);
    g.fillRect(x0 + 10, y0 + 160, 748, 6);
    label(g, 'LAKESIDE LODGE', x0 + 384, y0 + 90, 92, '#f0d9a8', 'center', 800);
  });
  place('cablecar', 512, 176, (x0, y0) => {
    g.fillStyle = '#f4f4f0';
    g.fillRect(x0, y0, 512, 176);
    g.fillStyle = '#c8161a';
    g.fillRect(x0, y0, 512, 30);
    label(g, 'SUMMIT GONDOLA', x0 + 256, y0 + 104, 62, '#16181c', 'center', 900);
  });
  /* 看台顶棚和彩旗上的字 */
  place('grandstand', 1024, 128, (x0, y0) => {
    g.fillStyle = '#16181c';
    g.fillRect(x0, y0, 1024, 128);
    g.fillStyle = '#ff3b2f';
    g.fillRect(x0, y0 + 112, 1024, 16);
    label(g, 'UMBRA GT · CLOUD RIDGE CIRCUIT', x0 + 512, y0 + 58, 66, '#f4f4f0', 'center', 800);
  });
}

function signTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = ATLAS;
  c.height = ATLAS;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a3d40';
  g.fillRect(0, 0, ATLAS, ATLAS);
  drawSigns(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function createSceneryMaterials() {
  const lit: N = smoothstep(0.1, 0.5, cityUniforms.lights);
  const atlas = signTexture();
  // 路牌：反光膜，被车灯照到比别的东西亮（接灯光的时候放大，见 MountainWorld.finishLighting）
  const sign = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  sign.colorNode = (texture(atlas) as N).rgb.mul(0.8);
  // 招牌：入夜后自己亮
  const neon = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0 });
  {
    const tex: N = (texture(atlas) as N).rgb;
    neon.colorNode = tex.mul(0.8);
    neon.emissiveNode = tex.mul(lit.mul(1.9));
  }
  // 航标灯：塔顶、风车、缆车站上一闪一闪的红灯（白天是一小块暗红）
  const beacon = new THREE.MeshBasicNodeMaterial();
  {
    const p: N = positionWorld;
    const phase: N = hash2(vec2(floor(p.x.mul(0.05)), floor(p.z.mul(0.05))));
    const blink: N = smoothstep(0.0, 0.08, fract((time as N).mul(0.55).add(phase)).sub(0.5)).mul(0.85).add(0.15);
    beacon.colorNode = mix(vec3(0.3, 0.02, 0.02), vec3(7.0, 0.35, 0.2).mul(blink), lit);
  }
  // 瀑布和溪水：白沫顺着水流往下淌（贴图坐标 y = 沿水流走了多远，x = 横着 0–1）
  const cascade = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.25, transparent: true, depthWrite: false });
  {
    const g: N = uv();
    const flow: N = g.y.sub((time as N).mul(5.5));
    const streaks: N = nz(g.x.mul(9.0), flow.mul(0.22), 41).mul(0.5).add(0.5);
    const foam: N = nz(g.x.mul(23.0), flow.mul(0.7), 42).mul(0.5).add(0.5);
    const white: N = smoothstep(0.25, 0.8, streaks.mul(0.65).add(foam.mul(0.45)));
    const side: N = smoothstep(0.0, 0.16, g.x).mul(smoothstep(1.0, 0.84, g.x));
    const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));
    const body: N = mix(vec3(0.05, 0.09, 0.1), vec3(0.36, 0.4, 0.42), white).mul(mix(float(0.45), float(1.5), daylight));
    cascade.colorNode = (vec4 as N)(body, side.mul(white.mul(0.45).add(0.55)));
  }
  // 水雾：瀑布脚下的一团
  const mist = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  {
    const g: N = uv();
    const r: N = g.sub(0.5).length().mul(2.0);
    const puff: N = nz(g.x.mul(3.0).add((time as N).mul(0.12)), g.y.mul(3.0).sub((time as N).mul(0.3)), 43).mul(0.5).add(0.5);
    const daylight: N = float(1).sub(smoothstep(0.0, 0.7, cityUniforms.lights));
    const grey: N = vec3(0.5, 0.54, 0.58).mul(mix(float(0.12), float(1.0), daylight));
    mist.colorNode = (vec4 as N)(grey, smoothstep(1.0, 0.25, r).mul(puff).mul(0.5));
  }
  return {
    paint: createBuilt('plain'),
    boards: createBuilt('boards'),
    roofing: createBuilt('seams'),
    glass: createGlass(),
    sign,
    neon,
    beacon,
    cascade,
    mist,
  };
}

export type SceneryMaterials = ReturnType<typeof createSceneryMaterials>;
