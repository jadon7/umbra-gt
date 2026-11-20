/** 检查赛道中心线：长度、最小弯道半径、是否自交。运行：node scripts/track-check.ts [输出图片路径] */
import { execFileSync } from 'node:child_process';
import { buildTrackLayout, TRACK_HALF_WIDTH } from '../src/drive/trackLayout.ts';

const layout = buildTrackLayout(3);
const S = layout.samples;
const n = S.length;
let minR = Infinity;
let minRs = 0;
const tight: string[] = [];
for (let i = 0; i < n; i++) {
  const a = S[i].dir;
  const b = S[(i + 1) % n].dir;
  const ang = Math.acos(Math.min(1, a.dot(b)));
  const r = ang > 1e-6 ? 3 / ang : Infinity;
  if (r < minR) { minR = r; minRs = S[i].s; }
}
// 找出各弯道的最小半径（半径 < 150 米算弯）
let inCorner = false; let cornerMin = Infinity; let cornerS = 0;
for (let i = 0; i < n; i++) {
  const ang = Math.acos(Math.min(1, S[i].dir.dot(S[(i + 1) % n].dir)));
  const r = ang > 1e-6 ? 3 / ang : Infinity;
  if (r < 150) { if (!inCorner) { inCorner = true; cornerMin = Infinity; } if (r < cornerMin) { cornerMin = r; cornerS = S[i].s; } }
  else if (inCorner) { inCorner = false; tight.push(`s=${cornerS.toFixed(0)} R=${cornerMin.toFixed(0)}`); }
}
let minGap = Infinity;
for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
  const ds = Math.min(S[j].s - S[i].s, layout.length - (S[j].s - S[i].s));
  if (ds < 80) continue;
  const d = S[i].pos.distanceTo(S[j].pos);
  if (d < minGap) minGap = d;
}
console.log(`长度 ${layout.length.toFixed(0)} 米，采样 ${n} 个`);
console.log(`最小半径 ${minR.toFixed(1)} 米（s=${minRs.toFixed(0)}）`);
console.log(`各弯最小半径：${tight.join('  ')}`);
console.log(`不相邻路段的最近距离 ${minGap.toFixed(1)} 米（需要大于 ${(2 * (TRACK_HALF_WIDTH + 2)).toFixed(0)} 米）`);

const out = process.argv[2];
if (out) {
  const xs = S.map((p) => p.pos.x); const zs = S.map((p) => p.pos.z);
  const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40, minZ = Math.min(...zs) - 40, maxZ = Math.max(...zs) + 40;
  const scale = 900 / Math.max(maxX - minX, maxZ - minZ);
  // 图上 +Z 向上；+X 向右（即车头朝上时，画面右侧是车的左手边——俯视图是镜像的，仅用于检查形状）
  const px = (x: number) => ((x - minX) * scale).toFixed(1);
  const pz = (z: number) => ((maxZ - z) * scale).toFixed(1);
  const side = (k: number) => S.map((p) => `${px(p.pos.x + p.left.x * k)},${pz(p.pos.z + p.left.z * k)}`).join(' ');
  const w = Math.ceil((maxX - minX) * scale), h = Math.ceil((maxZ - minZ) * scale);
  execFileSync('magick', ['-size', `${w}x${h}`, 'xc:#101216', '-fill', 'none',
    '-stroke', '#5a6070', '-strokewidth', '1', '-draw', `polygon ${side(TRACK_HALF_WIDTH)}`, '-draw', `polygon ${side(-TRACK_HALF_WIDTH)}`,
    '-stroke', '#f7de00', '-draw', `polygon ${side(0)}`,
    '-stroke', '#ff2a93', '-strokewidth', '3', '-draw', `line ${px(-12)},${pz(layout.start.z)} ${px(12)},${pz(layout.start.z)}`,
    out]);
  console.log('已输出', out);
}
