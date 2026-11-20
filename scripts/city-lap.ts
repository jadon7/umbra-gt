/**
 * 用（不漂移的）自动驾驶在无头仿真里跑一张地图的赛道，验证整圈能跑通、没有漏洞。
 * 运行：node scripts/city-lap.ts [圈数] [车型：gt | rs | lm | st | xr | brute | ronin | nomad] [map=mountain]
 */
import { Quaternion, Vector3 } from 'three';
import { Autopilot } from '../src/drive/Autopilot.ts';
import { PHYSICS_DT } from '../src/drive/PhysicsWorld.ts';
import { Vehicle } from '../src/drive/Vehicle.ts';
import { carModel, vehicleConfig } from '../src/car/models.ts';
import { loadMap } from './lib/maps.ts';

const args = process.argv.slice(2).filter((a) => !a.includes('='));
const laps = Number(args[0] ?? 2);
const map = await loadMap();
const { physics, track } = map;
const model = carModel(args[1]);
const car = new Vehicle(physics, vehicleConfig(model));
if (model.id !== 'gt') console.log(`车型 ${model.name}（${model.tagline}）`);
car.reset(track.start.x, map.startY + 0.05, track.start.z, track.start.yaw);
const pilot = new Autopilot(track);
pilot.tuneFor(vehicleConfig(model));

console.log(`${map.name === 'city' ? '' : `${map.label}：`}赛道 ${track.length.toFixed(0)} 米；碰撞体：${map.info}`);

const KMH = 3.6;
let t = 0;
let lapStart = 0;
let lap = 0;
let maxV = 0;
let minV = 999;
let maxOffset = 0;
let impacts = 0;
let hardest = 0;
let stuck = 0;
let airTime = 0;
let minY = map.startY;
let maxY = map.startY;
const sectors: string[] = [];
let nextMark = 200;
const fwd = new Vector3();
const q = new Quaternion();

while (lap < laps && t < laps * 200) {
  const p = car.body.translation();
  const r = car.body.rotation();
  q.set(r.x, r.y, r.z, r.w);
  fwd.set(0, 0, 1).applyQuaternion(q);
  const yaw = Math.atan2(fwd.x, fwd.z);
  const inp = pilot.update(p.x, p.z, yaw, car.forwardSpeed);
  car.step(inp, PHYSICS_DT);
  physics.step();
  t += PHYSICS_DT;

  const v = car.speed * KMH;
  if (t - lapStart > 4) { maxV = Math.max(maxV, v); minV = Math.min(minV, v); }
  maxOffset = Math.max(maxOffset, pilot.offset);
  if (car.collisionImpact > 0.12) {
    impacts++; hardest = Math.max(hardest, car.collisionImpact);
    if (lap === 0) console.log(`  冲击 ${car.collisionImpact.toFixed(2)} @ 赛道 ${(pilot.progress % track.length).toFixed(0)} 米 位置 (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}) 车速 ${v.toFixed(0)} 接地 ${car.groundedCount} 偏离 ${pilot.offset.toFixed(1)}`);
  }
  car.collisionImpact = 0; car.landingImpact = 0;
  if (car.groundedCount === 0) airTime += PHYSICS_DT;
  minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  stuck = car.speed < 1.5 && t > 3 ? stuck + PHYSICS_DT : 0;
  if (stuck > 4 || p.y < -3) {
    console.log(`!! 卡住或掉落：t=${t.toFixed(1)}s 位置 (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}) 赛道距离 ${(pilot.progress % track.length).toFixed(0)} 米 车速 ${v.toFixed(0)}`);
    break;
  }
  const s = pilot.progress - lap * track.length;
  if (s >= nextMark && lap === 0) {
    sectors.push(`${nextMark}m:${v.toFixed(0)}`);
    nextMark += 200;
  }
  if (pilot.progress >= (lap + 1) * track.length) {
    lap++;
    console.log(`第 ${lap} 圈：${(t - lapStart).toFixed(2)} 秒  平均 ${((track.length / (t - lapStart)) * KMH).toFixed(0)} 千米/时  最高 ${maxV.toFixed(0)}  最低 ${minV.toFixed(0)}  偏离中心线最大 ${maxOffset.toFixed(1)} 米  碰撞 ${impacts} 次（最重 ${hardest.toFixed(2)}）  腾空 ${airTime.toFixed(2)} 秒  高度 ${minY.toFixed(2)}–${maxY.toFixed(2)}`);
    lapStart = t; maxV = 0; minV = 999; maxOffset = 0; impacts = 0; hardest = 0; airTime = 0; minY = p.y; maxY = p.y;
  }
}
console.log(`每 200 米处的车速（第 1 圈）：${sectors.join('  ')}`);
if (lap < laps) console.log(`未完成：跑了 ${lap} 圈，用时 ${t.toFixed(1)} 秒`);
