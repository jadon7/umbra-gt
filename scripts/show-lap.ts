/**
 * 用表演式的自动驾驶（会漂移、会开氮气，见 src/drive/ShowPilot.ts）在无头仿真里跑城市赛道，
 * 看它跑得怎么样：每圈用时、蹭了几次墙、每个弯是多快漂过去的、有没有卡住。
 * 运行：node scripts/show-lap.ts [圈数] [车型：gt | rs | lm | st | xr | brute | ronin | nomad] [detail] [grip=0.8] [map=mountain]
 */
import { Quaternion, Vector3 } from 'three';
import { ShowPilot } from '../src/drive/ShowPilot.ts';
import { PHYSICS_DT } from '../src/drive/PhysicsWorld.ts';
import { Vehicle } from '../src/drive/Vehicle.ts';
import { carModel, vehicleConfig } from '../src/car/models.ts';
import { loadMap } from './lib/maps.ts';

const args = process.argv.slice(2).filter((a) => !a.includes('=') && a !== 'detail');
const laps = Number(args[0] ?? 3);
const detail = process.argv.includes('detail');
const map = await loadMap();
const { physics, track } = map;
const model = carModel(args[1]);
const cfg = vehicleConfig(model);
const car = new Vehicle(physics, cfg);
car.reset(track.start.x, map.startY + 0.05, track.start.z, track.start.yaw);
const pilot = new ShowPilot(track);
pilot.tuneFor(cfg);
// 路面抓地（积雪时小于 1）：命令行里写 grip=0.8
const grip = Number(process.argv.find((a) => a.startsWith('grip='))?.slice(5) ?? 1);
car.surfaceGrip = grip;
pilot.grip = grip;
// 调参用：long=入弯车速几成,提前几秒甩,往外靠几米（见 ShowPilot.longTurn）
{
  const raw = process.argv.find((a) => a.startsWith('long='))?.slice(5);
  if (raw) {
    const [hold, lead, bias] = raw.split(',').map(Number);
    if (Number.isFinite(hold)) pilot.longTurn.hold = hold;
    if (Number.isFinite(lead)) pilot.longTurn.lead = lead;
    if (Number.isFinite(bias)) pilot.longTurn.bias = bias;
  }
}
console.log(`车型 ${model.name}，${map.label} ${track.length.toFixed(0)} 米${grip < 1 ? `，路面抓地 ${grip}` : ''}`);

const KMH = 3.6;
const trace = process.argv.find((a) => a.startsWith('trace='))?.slice(6).split(',').map(Number) ?? null;
const q = new Quaternion();
const fwd = new Vector3();
let t = 0;
let lapStart = 0;
let lap = 0;
let hits = 0;
let hard = 0;
let hardest = 0;
let stuckCount = 0;
let drifts = 0;
let nitroTime = 0;
let driftTime = 0;
let maxV = 0;
let cool = 0;
let wasDrifting = false;
let lastPhase = pilot.phase;
/** 每次漂移：从哪开始、入弯车速、最低车速、蹭没蹭墙 */
let cur: { s: number; vin: number; vmin: number; hit: number } | null = null;
const log: string[] = [];
const times: number[] = [];

while (lap < laps && t < laps * 140) {
  const p = car.body.translation();
  const r = car.body.rotation();
  q.set(r.x, r.y, r.z, r.w);
  fwd.set(0, 0, 1).applyQuaternion(q);
  const inp = pilot.update(car, p.x, p.z, Math.atan2(fwd.x, fwd.z), PHYSICS_DT);
  car.step(inp, PHYSICS_DT);
  physics.step();
  t += PHYSICS_DT;
  cool -= PHYSICS_DT;

  const s = pilot.progress - lap * track.length;
  const v = car.speed * KMH;
  // 调参用：trace=从第几米,到第几米 —— 第一圈经过这一段时每 0.1 秒打一行
  if (trace && lap === 0 && s >= trace[0] && s <= trace[1] && Math.round(t / PHYSICS_DT) % 12 === 0) {
    const tr = track.samples[pilot.index];
    const rel = (a: number) => (((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const lv = car.body.linvel();
    const head = rel(Math.atan2(fwd.x, fwd.z) - Math.atan2(tr.dir.x, tr.dir.z));
    const course = rel(Math.atan2(lv.x, lv.z) - Math.atan2(tr.dir.x, tr.dir.z));
    console.log(
      `   ${s.toFixed(0).padStart(5)} 米  ${v.toFixed(0).padStart(3)} km/h  偏离 ${pilot.offset.toFixed(1).padStart(5)}  车头 ${((head * 180) / Math.PI).toFixed(0).padStart(4)}°  行进 ${((course * 180) / Math.PI).toFixed(0).padStart(4)}°  ${pilot.phase.padEnd(6)}  方向 ${inp.steer.toFixed(2).padStart(5)}  油 ${inp.throttle.toFixed(1)} 刹 ${inp.brake.toFixed(1)}${inp.handbrake ? ' 手刹' : ''}${inp.nitro ? ' 氮气' : ''}  ${car.drifting ? '漂移中' : ''}`,
    );
  }
  maxV = Math.max(maxV, v);
  if (car.nitroActive) nitroTime += PHYSICS_DT;
  if (car.drifting) driftTime += PHYSICS_DT;
  if (pilot.phase === 'hand' && lastPhase !== 'hand') {
    drifts++;
    cur = { s, vin: v, vmin: v, hit: 0 };
  }
  if (cur) cur.vmin = Math.min(cur.vmin, v);
  if (pilot.phase === 'recover' && lastPhase !== 'recover') {
    stuckCount++;
    log.push(`  !! 卡住倒车 @ ${s.toFixed(0)} 米`);
  }
  if (car.collisionImpact > 0.12 && cool <= 0 && t > 1) {
    hits++;
    if (car.collisionImpact > 0.5) hard++;
    hardest = Math.max(hardest, car.collisionImpact);
    if (cur) cur.hit = Math.max(cur.hit, car.collisionImpact);
    if (detail) log.push(`  蹭墙 ${car.collisionImpact.toFixed(2)} @ ${s.toFixed(0)} 米  车速 ${v.toFixed(0)}  ${pilot.phase}  偏离 ${pilot.offset.toFixed(1)} 米  离路面 ${(p.y - track.samples[pilot.index].pos.y).toFixed(2)} 米  接地 ${car.groundedCount}`);
    cool = 0.4;
  }
  car.collisionImpact = 0;
  car.landingImpact = 0;
  if (cur && pilot.phase === 'cruise' && lastPhase !== 'cruise') {
    log.push(`  漂移 @ ${cur.s.toFixed(0)} 米  入弯 ${cur.vin.toFixed(0)}  最低 ${cur.vmin.toFixed(0)}  出弯 ${v.toFixed(0)}  偏离 ${pilot.offset.toFixed(1)} 米${cur.hit ? `  蹭墙 ${cur.hit.toFixed(2)}` : ''}`);
    cur = null;
  }
  wasDrifting = car.drifting;
  lastPhase = pilot.phase;
  if (p.y < map.startY - 30) {
    console.log(`!! 掉出赛道 @ ${s.toFixed(0)} 米`);
    break;
  }
  if (pilot.progress >= (lap + 1) * track.length) {
    lap++;
    const lt = t - lapStart;
    times.push(lt);
    console.log(`第 ${lap} 圈：${lt.toFixed(2)} 秒  最高 ${maxV.toFixed(0)}  漂移 ${drifts} 次共 ${driftTime.toFixed(1)} 秒  氮气 ${nitroTime.toFixed(1)} 秒  蹭墙 ${hits} 次（重的 ${hard} 次，最重 ${hardest.toFixed(2)}）  卡住 ${stuckCount} 次`);
    if (detail || lap === 1) for (const l of log) console.log(l);
    log.length = 0;
    lapStart = t;
    hits = 0; hard = 0; hardest = 0; stuckCount = 0; drifts = 0; nitroTime = 0; driftTime = 0; maxV = 0;
  }
}
if (lap < laps) {
  console.log(`未完成：跑了 ${lap} 圈，用时 ${t.toFixed(1)} 秒，停在 ${(pilot.progress % track.length).toFixed(0)} 米，状态 ${pilot.phase}`);
  for (const l of log) console.log(l);
}
