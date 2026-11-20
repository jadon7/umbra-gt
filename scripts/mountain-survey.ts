/**
 * 山路沿线的地势：每隔一段路，量一下左右两侧 20 / 45 / 80 米外的地面比路面高多少。
 * 给路边的建筑、观景台、岩壁选址用（正数 = 那一侧是山，负数 = 那一侧是坡下）。
 * 运行：node scripts/mountain-survey.ts [间隔米数，默认 60]
 */
import { buildMountainTrack, spanAt, terrainHeight } from '../src/mountain/mountainLayout.ts';

const step = Number(process.argv[2] ?? 60);
const track = buildMountainTrack();
const S = track.samples;
const f = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(0).padStart(2);
console.log('  路程    x     z   高度  朝向 |  左 20  45  80 |  右 20  45  80 | 备注');
for (let s = 0; s < track.length; s += step) {
  const i = Math.round(s / 2) % S.length;
  const p = S[i];
  const rel = (side: number, d: number) => terrainHeight(p.pos.x + p.left.x * d * side, p.pos.z + p.left.z * d * side) - p.pos.y;
  const yaw = ((Math.atan2(p.dir.x, p.dir.z) * 180) / Math.PI + 360) % 360;
  const note = spanAt(i) ?? (Math.abs(p.curvature) > 1 / 130 ? `弯 R${Math.round(1 / Math.abs(p.curvature))}${p.curvature > 0 ? '左' : '右'}` : '');
  console.log(
    `${String(s).padStart(6)} ${p.pos.x.toFixed(0).padStart(5)} ${p.pos.z.toFixed(0).padStart(5)} ${p.pos.y.toFixed(0).padStart(5)} ${yaw.toFixed(0).padStart(5)} | ${f(rel(1, 20))} ${f(rel(1, 45))} ${f(rel(1, 80))} | ${f(rel(-1, 20))} ${f(rel(-1, 45))} ${f(rel(-1, 80))} | ${note}`,
  );
}
