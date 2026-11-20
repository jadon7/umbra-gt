/**
 * 山路赛道的布局检查：不开浏览器，报告长度、每个弯的半径、坡度、隧道和桥的位置、路堑路堤有多高，
 * 并画一张俯视图（SVG）。改了 src/mountain/mountainLayout.ts 先跑这个。
 * 运行：node scripts/mountain-check.ts [输出的 svg 路径]
 */
import { writeFileSync } from 'node:fs';
import { baseHeight, buildMountainTrack, MOUNTAIN, routeProblems, terrainHeight } from '../src/mountain/mountainLayout.ts';

const problems = routeProblems();
for (const p of problems) console.log(`!! ${p}`);

const track = buildMountainTrack();
const S = track.samples;
const n = S.length;
const step = track.length / n;
console.log(`赛道 ${track.length.toFixed(0)} 米，${n} 个采样点，间隔 ${step.toFixed(2)} 米`);

let yMin = Infinity;
let yMax = -Infinity;
let gMax = 0;
let gMin = 0;
for (let i = 0; i < n; i++) {
  yMin = Math.min(yMin, S[i].pos.y);
  yMax = Math.max(yMax, S[i].pos.y);
  gMax = Math.max(gMax, track.grade[i]);
  gMin = Math.min(gMin, track.grade[i]);
}
console.log(`高度 ${yMin.toFixed(1)} – ${yMax.toFixed(1)} 米（落差 ${(yMax - yMin).toFixed(0)} 米），最陡上坡 ${(gMax * 100).toFixed(1)}%，最陡下坡 ${(gMin * 100).toFixed(1)}%`);

/* 弯：曲率连续超过一定值的一段 */
console.log('弯道：');
{
  const bent = (i: number) => Math.abs(S[(i + n) % n].curvature) > 0.004;
  let first = 0;
  while (first < n && bent(first)) first++;
  let i = 0;
  let count = 0;
  let left = 0;
  let right = 0;
  while (i < n) {
    if (!bent(first + i)) {
      i++;
      continue;
    }
    const from = i;
    let angle = 0;
    let tight = 0;
    while (i < n && bent(first + i)) {
      const c = S[(first + i) % n].curvature;
      angle += c * step;
      tight = Math.max(tight, Math.abs(c));
      i++;
    }
    if (Math.abs(angle) < 0.12) continue;
    count++;
    if (angle > 0) left++;
    else right++;
    const a = S[(first + from) % n];
    const b = S[(first + i - 1) % n];
    console.log(
      `  ${String(count).padStart(2)}. ${a.s.toFixed(0).padStart(4)}–${b.s.toFixed(0).padEnd(4)} 米  ${angle > 0 ? '左' : '右'} ${Math.abs((angle * 180) / Math.PI).toFixed(0).padStart(3)}°  最小半径 ${(1 / tight).toFixed(0).padStart(3)} 米  高度 ${a.pos.y.toFixed(0)} → ${b.pos.y.toFixed(0)}`,
    );
  }
  console.log(`  共 ${count} 个弯（左 ${left}、右 ${right}）`);
}

/* 直道 */
{
  let longest = 0;
  let run = 0;
  let at = 0;
  for (let k = 0; k < n * 2; k++) {
    const i = k % n;
    if (Math.abs(S[i].curvature) < 0.002) {
      run += step;
      if (run > longest) {
        longest = run;
        at = S[i].s;
      }
    } else run = 0;
  }
  console.log(`最长的直道 ${Math.min(longest, track.length).toFixed(0)} 米（到 ${at.toFixed(0)} 米处为止）`);
}

let crest = 0;
for (let i = 0; i < n; i++) crest += track.crest[i];
console.log(`坡顶（车可能飘起来）的路段共 ${(crest * step).toFixed(0)} 米`);
for (const sp of track.spans) {
  const a = S[sp.i0];
  const b = S[sp.i1];
  let clear = Infinity;
  for (let i = sp.i0; i <= sp.i1; i++) {
    const d = baseHeight(S[i].pos.x, S[i].pos.z) - S[i].pos.y;
    clear = Math.min(clear, sp.kind === 'tunnel' ? d : -d);
  }
  let deep = 0;
  for (let i = sp.i0; i <= sp.i1; i++) deep = Math.max(deep, Math.abs(baseHeight(S[i].pos.x, S[i].pos.z) - S[i].pos.y));
  console.log(
    `${sp.kind === 'tunnel' ? '隧道' : '高架桥'}：${a.s.toFixed(0)}–${b.s.toFixed(0)} 米（长 ${(b.s - a.s).toFixed(0)} 米），${sp.kind === 'tunnel' ? `头顶的山最薄 ${clear.toFixed(1)} 米、最厚 ${deep.toFixed(1)} 米` : `桥面离沟底最高 ${deep.toFixed(1)} 米`}，坡度 ${(track.grade[sp.i0] * 100).toFixed(1)}%`,
  );
}

/* 路堑、路堤：路两边 40 米处的地面比路面高（低）多少 */
{
  let cut = 0;
  let fill = 0;
  let cutAt = 0;
  let fillAt = 0;
  const inSpan = (i: number) => track.spans.some((sp) => i >= sp.i0 - 12 && i <= sp.i1 + 12);
  for (let i = 0; i < n; i += 2) {
    const p = S[i];
    if (inSpan(i)) continue;
    for (const side of [-1, 1]) {
      const x = p.pos.x + p.left.x * side * 40;
      const z = p.pos.z + p.left.z * side * 40;
      const d = terrainHeight(x, z) - p.pos.y;
      if (d > cut) {
        cut = d;
        cutAt = p.s;
      }
      if (d < fill) {
        fill = d;
        fillAt = p.s;
      }
    }
  }
  console.log(`路外 40 米处的地面（不算隧道和桥）：最高比路面高 ${cut.toFixed(1)} 米（${cutAt.toFixed(0)} 米处），最低比路面低 ${(-fill).toFixed(1)} 米（${fillAt.toFixed(0)} 米处）`);
}

/* 路线有没有自己和自己挨得太近（不该相交，也不该贴着） */
{
  let closest = Infinity;
  let at = '';
  for (let i = 0; i < n; i += 3) {
    for (let j = i + 40; j < n; j += 3) {
      if (n - (j - i) < 40) continue;
      const d = Math.hypot(S[i].pos.x - S[j].pos.x, S[i].pos.z - S[j].pos.z);
      if (d < closest) {
        closest = d;
        at = `${S[i].s.toFixed(0)} 米处和 ${S[j].s.toFixed(0)} 米处`;
      }
    }
  }
  console.log(`路线离自己最近的地方：${closest.toFixed(1)} 米（${at}）${closest < MOUNTAIN.bench * 2 + 6 ? '  !! 太近' : ''}`);
}

/* ---- 俯视图 ---- */
const out = process.argv[2];
if (out) {
  const E = 760;
  const W = 1200;
  const sc = W / (E * 2);
  const X = (x: number) => (x + E) * sc;
  // 图上北（+Z）朝上
  const Y = (z: number) => (E - z) * sc;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">`);
  parts.push(`<rect width="${W}" height="${W}" fill="#10141a"/>`);
  // 地形：按高度上色的格子
  const cell = 16;
  for (let z = -E; z < E; z += cell) {
    for (let x = -E; x < E; x += cell) {
      const h = terrainHeight(x + cell / 2, z + cell / 2);
      const hx = terrainHeight(x + cell / 2 + 3, z + cell / 2) - h;
      const shade = Math.max(-0.25, Math.min(0.25, hx * 0.12));
      let r: number;
      let g: number;
      let b: number;
      if (h < MOUNTAIN.lake) [r, g, b] = [30, 60, 95];
      else {
        const t = Math.min(1, (h - 15) / 160);
        r = 46 + 150 * t;
        g = 78 + 90 * t;
        b = 52 + 70 * t;
      }
      const k = 1 + shade;
      parts.push(`<rect x="${X(x).toFixed(1)}" y="${Y(z + cell).toFixed(1)}" width="${(cell * sc + 0.5).toFixed(1)}" height="${(cell * sc + 0.5).toFixed(1)}" fill="rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})"/>`);
    }
  }
  // 路：宽度按实际路宽画
  const line = (from: number, to: number, color: string, width: number) => {
    const pts: string[] = [];
    for (let i = from; i <= to; i++) {
      const p = S[i % n].pos;
      pts.push(`${X(p.x).toFixed(1)},${Y(p.z).toFixed(1)}`);
    }
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${width.toFixed(1)}" stroke-linejoin="round" stroke-linecap="round"/>`);
  };
  line(0, n, '#1b1d22', MOUNTAIN.rail * 2 * sc);
  line(0, n, '#d8d8d2', 2.2);
  for (const sp of track.spans) line(sp.i0, sp.i1, sp.kind === 'tunnel' ? '#ff8a2a' : '#35c8ff', 5);
  for (let i = 0; i < n; i++) if (track.crest[i]) parts.push(`<circle cx="${X(S[i].pos.x).toFixed(1)}" cy="${Y(S[i].pos.z).toFixed(1)}" r="2.2" fill="#ff3d7a"/>`);
  // 每 200 米一个刻度，写上距离和高度
  for (let m = 0; m < track.length; m += 200) {
    const p = S[Math.round(m / step) % n];
    const px = X(p.pos.x);
    const py = Y(p.pos.z);
    parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.4" fill="#f7de00"/>`);
    parts.push(`<text x="${(px + 7).toFixed(1)}" y="${(py - 6).toFixed(1)}" font-family="Helvetica" font-size="13" fill="#ffffff">${m}m · ${p.pos.y.toFixed(0)}</text>`);
  }
  // 起点和行进方向
  {
    const p = S[0];
    const q = S[12];
    parts.push(`<line x1="${X(p.pos.x)}" y1="${Y(p.pos.z)}" x2="${X(q.pos.x)}" y2="${Y(q.pos.z)}" stroke="#ff2a93" stroke-width="5"/>`);
    parts.push(`<circle cx="${X(q.pos.x)}" cy="${Y(q.pos.z)}" r="6" fill="#ff2a93"/>`);
  }
  // 坡度剖面：贴在图的底部
  {
    const h = 150;
    const y0 = W - 16;
    parts.push(`<rect x="20" y="${y0 - h - 10}" width="${W - 40}" height="${h + 20}" fill="#000" fill-opacity="0.55"/>`);
    const pts: string[] = [];
    for (let i = 0; i < n; i += 2) {
      const px = 30 + ((W - 60) * i) / n;
      const py = y0 - ((S[i].pos.y - yMin) / (yMax - yMin)) * h;
      pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#f7de00" stroke-width="2"/>`);
    for (let m = 0; m < track.length; m += 400) {
      const px = 30 + ((W - 60) * m) / track.length;
      parts.push(`<text x="${px.toFixed(1)}" y="${y0 + 8}" font-family="Helvetica" font-size="11" fill="#bbb">${m}</text>`);
    }
  }
  parts.push('</svg>');
  writeFileSync(out, parts.join('\n'));
  console.log(`俯视图：${out}`);
}
