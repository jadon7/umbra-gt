/** 检查城市布局：赛道长度、弯道、护栏数量，并输出一张俯视图。运行：node scripts/city-check.ts [输出图片路径] */
import { execFileSync } from 'node:child_process';
import { ARCH_BRIDGE, avenueX, buildBarriers, buildBlocks, buildCityTrack, buildTurnHints, CITY, ELEVATED, HALF_ROAD, LAKESHORE, LAND, LOWER_LEVEL, RIVER, streetZ } from '../src/city/cityLayout.ts';

const track = buildCityTrack();
const S = track.samples;
const blocks = buildBlocks();
const barriers = buildBarriers();
const nb = blocks.reduce((n, b) => n + b.buildings.length, 0);
const maxH = Math.max(...blocks.flatMap((b) => b.buildings.map((x) => x.h)));

console.log(`赛道长度 ${track.length.toFixed(0)} 米，采样 ${S.length} 个`);
// 弯道：曲率超过阈值的连续段
let inCorner = false, cs = 0, cmax = 0, turned = 0; const corners: string[] = [];
for (let i = 0; i < S.length; i++) {
  const k = S[i].curvature;
  if (Math.abs(k) > 1 / 400) {
    if (!inCorner) { inCorner = true; cs = S[i].s; cmax = 0; turned = 0; }
    cmax = Math.max(cmax, Math.abs(k)); turned += k * 2;
  } else if (inCorner) {
    inCorner = false;
    corners.push(`s=${cs.toFixed(0)} ${turned > 0 ? '左' : '右'}${Math.abs(turned * 57.3).toFixed(0)}° R=${(1 / cmax).toFixed(0)}`);
  }
}
console.log(`弯道 ${corners.length} 个：${corners.join('  ')}`);
const maxY = Math.max(...S.map((p) => p.pos.y));
console.log(`最高点 ${maxY.toFixed(2)} 米（拱桥）  街区 ${blocks.length} 个  楼 ${nb} 栋  最高 ${maxH.toFixed(0)} 米  路口护栏 ${barriers.length} 处`);
console.log(`起点 (${track.start.x}, ${track.start.z})`);

// 弯道的指引：每个直角弯的箭头方向要和赛道实际拐的方向一致，正前方和另一侧各有一道护栏、都贴着楼的外墙线
{
  const hints = buildTurnHints();
  let bad = 0;
  for (const h of hints) {
    const cx = avenueX(h.i), cz = streetZ(h.j);
    // 赛道在这个路口附近实际拐了多少（左正右负）
    let turned = 0;
    for (const p of S) if (Math.hypot(p.pos.x - cx, p.pos.z - cz) < 30) turned += p.curvature * 2;
    const ahead = barriers.filter((b) => b.kind === 'ahead' && Math.abs(b.x - (cx + h.inX * 12.9)) < 0.5 && Math.abs(b.z - (cz + h.inZ * 12.9)) < 0.5);
    const wrong = barriers.filter((b) => b.kind === 'wrong' && Math.abs(b.x - (cx - h.outX * 12.9)) < 0.5 && Math.abs(b.z - (cz - h.outZ * 12.9)) < 0.5);
    const ok = turned > 0 === h.left && Math.abs(Math.abs(turned) - Math.PI / 2) < 0.2 && ahead.length === 1 && wrong.length === 1 && ahead[0].tx === h.outX && ahead[0].tz === h.outZ;
    if (!ok) {
      bad++;
      console.log(`  ✗ 路口 (${h.i}, ${h.j})：指引说${h.left ? '左' : '右'}拐，赛道实际拐了 ${(turned * 57.3).toFixed(0)}°；正前方护栏 ${ahead.length} 道，另一侧 ${wrong.length} 道`);
    }
  }
  console.log(`弯道指引 ${hints.length} 处：${hints.map((h) => `(${h.i},${h.j})${h.left ? '左' : '右'}`).join(' ')}  ${bad ? `✗ ${bad} 处不对` : '✓ 方向和赛道一致'}`);
  if (bad) process.exitCode = 1;
}

const out = process.argv[2];
if (out) {
  const pad = 40;
  const minX = LAND.west - pad, maxX = LAKESHORE.cx + LAKESHORE.radius + 60, minZ = LAND.south - pad, maxZ = LAND.north + pad;
  const scale = 1500 / (maxZ - minZ);
  // 图上 +Z 向上、+X 向左（这样车头朝上时左手边在画面左侧，和游戏里一致）
  const px = (x: number) => ((maxX - x) * scale).toFixed(1);
  const pz = (z: number) => ((maxZ - z) * scale).toFixed(1);
  const W = Math.ceil((maxX - minX) * scale), H = Math.ceil((maxZ - minZ) * scale);
  const args: string[] = ['-size', `${W}x${H}`, 'xc:#0f2a3a'];
  const rect = (x0: number, z0: number, x1: number, z1: number) => `rectangle ${px(x1)},${pz(z1)} ${px(x0)},${pz(z0)}`;
  // 陆地
  args.push('-fill', '#26282c', '-stroke', 'none', '-draw', rect(LAND.west, LAND.south, LAND.east, RIVER.z0), '-draw', rect(LAND.west, RIVER.z1, LAND.east, LAND.north));
  const R = LAKESHORE.radius + HALF_ROAD + LAKESHORE.promenade;
  args.push('-draw', `circle ${px(LAKESHORE.cx)},${pz(LAKESHORE.cz)} ${px(LAKESHORE.cx + R)},${pz(LAKESHORE.cz)}`);
  args.push('-fill', '#1f3a22', '-draw', `circle ${px(LAKESHORE.cx)},${pz(LAKESHORE.cz)} ${px(LAKESHORE.cx + LAKESHORE.radius - HALF_ROAD)},${pz(LAKESHORE.cz)}`);
  // 街区与楼
  for (const b of blocks) {
    args.push('-fill', '#3a3d42', '-draw', rect(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2));
    for (const g of b.buildings) {
      const v = Math.round(70 + Math.min(1, g.h / 160) * 150);
      args.push('-fill', `rgb(${v},${v},${Math.min(255, v + 12)})`, '-draw', rect(g.x - g.w / 2 + 0.6, g.z - g.d / 2 + 0.6, g.x + g.w / 2 - 0.6, g.z + g.d / 2 - 0.6));
    }
  }
  // 特殊路段
  const ax = avenueX(ELEVATED.avenue);
  args.push('-fill', 'none', '-stroke', '#19e3ff', '-strokewidth', '3', '-draw', `line ${px(ax - 9)},${pz(streetZ(ELEVATED.j0))} ${px(ax - 9)},${pz(streetZ(ELEVATED.j1))}`, '-draw', `line ${px(ax + 9)},${pz(streetZ(ELEVATED.j0))} ${px(ax + 9)},${pz(streetZ(ELEVATED.j1))}`);
  const lz = streetZ(LOWER_LEVEL.street);
  args.push('-stroke', '#ff9d2e', '-draw', `line ${px(avenueX(LOWER_LEVEL.i0))},${pz(lz - 9)} ${px(avenueX(LOWER_LEVEL.i1))},${pz(lz - 9)}`, '-draw', `line ${px(avenueX(LOWER_LEVEL.i0))},${pz(lz + 9)} ${px(avenueX(LOWER_LEVEL.i1))},${pz(lz + 9)}`);
  args.push('-stroke', '#b0b6c0', '-strokewidth', '2');
  for (let i = 0; i < CITY.ni; i++) args.push('-draw', `line ${px(avenueX(i) - 8)},${pz(RIVER.z0)} ${px(avenueX(i) - 8)},${pz(RIVER.z1)}`, '-draw', `line ${px(avenueX(i) + 8)},${pz(RIVER.z0)} ${px(avenueX(i) + 8)},${pz(RIVER.z1)}`);
  // 赛道
  args.push('-fill', 'none', '-stroke', '#f7de00', '-strokewidth', '4', '-draw', `polygon ${S.map((p) => `${px(p.pos.x)},${pz(p.pos.z)}`).join(' ')}`);
  // 护栏
  args.push('-stroke', '#ff2a93', '-strokewidth', '4');
  for (const b of barriers) {
    const hx = b.alongX ? b.length / 2 : 0, hz = b.alongX ? 0 : b.length / 2;
    args.push('-draw', `line ${px(b.x - hx)},${pz(b.z - hz)} ${px(b.x + hx)},${pz(b.z + hz)}`);
  }
  // 起点
  args.push('-stroke', '#ffffff', '-strokewidth', '5', '-draw', `line ${px(track.start.x - 8)},${pz(track.start.z)} ${px(track.start.x + 8)},${pz(track.start.z)}`);
  args.push(out);
  execFileSync('magick', args);
  console.log('已输出', out, `（${ARCH_BRIDGE.avenue} 号大道拱桥）`);
}
