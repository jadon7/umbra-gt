/**
 * 过弯对比：同一个真实的街角、同一个入弯车速，「不漂移」和「漂移」各能多快过去。
 *
 * 用来回答「漂移对过弯到底有多大用」：
 *  - 不漂移：交给自动驾驶（提前刹车、贴着中心线拐过去），它代表老老实实刹车过弯的开法
 *  - 漂移：一个照着脚本开的驾驶员——（可选）先刹到某个车速，带方向拉手刹，打满方向给油，
 *    车头快指到出弯方向时反打收车，然后交给自动驾驶。入弯点、手刹拉多久、提前多少收车都穷举一遍，取最好的
 *
 * 比的是从弯前 150 米到出弯后 70 米这一段的用时、弯里的最低车速、出弯车速、蹭没蹭墙。
 *
 * 运行：node scripts/corner-test.ts [入弯车速（千米/时），可以给几个]
 */
import { Quaternion, Vector3 } from 'three';
import { addCityColliders, buildStructures } from '../src/city/cityPhysics.ts';
import { buildCityTrack, type TrackSample } from '../src/city/cityLayout.ts';
import { Autopilot } from '../src/drive/Autopilot.ts';
import { PhysicsWorld, PHYSICS_DT } from '../src/drive/PhysicsWorld.ts';
import { Vehicle, type DriveInput } from '../src/drive/Vehicle.ts';
import { DEFAULT_CONFIG } from '../src/drive/VehicleConfig.ts';

const KMH = 3.6;
const speeds = process.argv.slice(2).map(Number).filter((v) => v > 0);
if (speeds.length === 0) speeds.push(120, 160, 200);

const physics = await PhysicsWorld.create();
addCityColliders(physics, buildStructures());
const track = buildCityTrack();
const S = track.samples;
const n = S.length;
const step = track.length / n;

/* ---------- 找出赛道上的直角弯 ---------- */
interface Turn {
  /** 弯的起止（采样点下标） */
  i0: number;
  i1: number;
  /** 一共转过多少（弧度，正 = 左弯） */
  angle: number;
  radius: number;
  /** 弯前的直道有多长（米） */
  lead: number;
}
const turns: Turn[] = [];
{
  const bent = (i: number) => Math.abs(S[(i + n) % n].curvature) > 0.004;
  let first = 0;
  while (first < n && bent(first)) first++;
  let i = 0;
  let lastEnd = first;
  while (i < n) {
    if (!bent(first + i)) {
      i++;
      continue;
    }
    const from = i;
    let angle = 0;
    while (i < n && bent(first + i)) {
      angle += S[(first + i) % n].curvature * step;
      i++;
    }
    const i0 = (first + from) % n;
    const i1 = (first + i - 1) % n;
    turns.push({ i0, i1, angle, radius: ((i - from) * step) / Math.abs(angle), lead: (first + from - lastEnd) * step });
    lastEnd = first + i;
  }
}

interface Result {
  time: number;
  minSpeed: number;
  exitSpeed: number;
  hits: number;
  hardest: number;
  done: boolean;
  /** 在弯里最多偏到离中心线多远 */
  offset: number;
}

// 所有测试共用一台车（每次放回起点重来）：物理世界里不能留着上一次的车
const car = new Vehicle(physics, DEFAULT_CONFIG);
const q = new Quaternion();
const fwd = new Vector3();
const angleDiff = (a: number, b: number) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

interface DriftPlan {
  /** 拉手刹前先刹到多快（米/秒）；不小于入弯车速就是不刹 */
  entry: number;
  /** 离弯口多远开始拉手刹（米，负数 = 已经进弯了） */
  at: number;
  /** 手刹拉多久（秒） */
  hand: number;
  /** 车头离出弯方向还差多少度时开始反打收车 */
  early: number;
}

/**
 * 跑一次。plan 不给就是自动驾驶（不漂移）。
 * @param approach 这一段从弯前多远开始算（米）
 */
function run(turn: Turn, V: number, approach: number, plan: DriftPlan | null): Result {
  const startIndex = (turn.i0 - Math.round(approach / step) + n) % n;
  const a = S[startIndex];
  car.reset(a.pos.x, 0.05, a.pos.z, Math.atan2(a.dir.x, a.dir.z));
  // 悬挂先落稳，再把车速直接给上（挡位跟着挂到合适的那一挡）
  for (let i = 0; i < 40; i++) {
    car.step({ throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false }, PHYSICS_DT);
    physics.step();
  }
  car.body.setLinvel({ x: a.dir.x * V, y: 0, z: a.dir.z * V }, true);
  const c = DEFAULT_CONFIG;
  for (let g = c.gears.length; g >= 1; g--) {
    const rpm = (V / c.wheelRadius) * 9.5493 * c.gears[g - 1] * c.finalDrive;
    car.gear = g;
    if (rpm > c.shiftDownRpm + 400) break;
  }

  const pilot = new Autopilot(track);
  pilot.reset(a.pos.x, a.pos.z);
  const exit = S[(turn.i1 + 2) % n];
  const exitYaw = Math.atan2(exit.dir.x, exit.dir.z);
  const side = Math.sign(turn.angle);
  const goal = approach + ((turn.i1 - turn.i0 + n) % n) * step + 70;

  let t = 0;
  let phase: 'approach' | 'hand' | 'steer' | 'catch' | 'pilot' = plan ? 'approach' : 'pilot';
  let phaseTime = 0;
  let minSpeed = 999;
  let hits = 0;
  let hardest = 0;
  let offset = 0;
  let cool = 0;
  while (t < 14) {
    const p = car.body.translation();
    const r = car.body.rotation();
    q.set(r.x, r.y, r.z, r.w);
    fwd.set(0, 0, 1).applyQuaternion(q);
    const yaw = Math.atan2(fwd.x, fwd.z);
    const auto = pilot.update(p.x, p.z, yaw, car.forwardSpeed);
    const toCorner = approach - pilot.progress;
    let inp: DriveInput = auto;
    if (plan) {
      const v = car.speed;
      if (phase === 'approach') {
        // 沿着中心线保持车速；到点了先刹到入弯车速
        const brakeFrom = plan.at + Math.max(0, (v * v - plan.entry * plan.entry) / (2 * 11));
        const braking = toCorner < brakeFrom && v > plan.entry;
        inp = { throttle: braking ? 0 : v < V ? 1 : 0.3, brake: braking ? 1 : 0, steer: auto.steer, handbrake: false, nitro: false };
        if (toCorner <= plan.at) {
          phase = 'hand';
          phaseTime = 0;
        }
      }
      if (phase === 'hand') {
        inp = { throttle: 1, brake: 0, steer: side, handbrake: true, nitro: false };
        if (phaseTime >= plan.hand) {
          phase = 'steer';
          phaseTime = 0;
        }
      } else if (phase === 'steer') {
        inp = { throttle: 1, brake: 0, steer: side, handbrake: false, nitro: false };
        const left = angleDiff(exitYaw, yaw) * side;
        if (left <= (plan.early * Math.PI) / 180 || phaseTime > 4) {
          phase = 'catch';
          phaseTime = 0;
        }
      } else if (phase === 'catch') {
        inp = { throttle: 1, brake: 0, steer: -side, handbrake: false, nitro: false };
        if (!car.drifting || phaseTime > 1.5) phase = 'pilot';
      }
    }
    car.step(inp, PHYSICS_DT);
    physics.step();
    t += PHYSICS_DT;
    phaseTime += PHYSICS_DT;
    cool -= PHYSICS_DT;
    if (toCorner < 20) {
      minSpeed = Math.min(minSpeed, car.speed);
      offset = Math.max(offset, pilot.offset);
    }
    // 开头把车速直接给上去的那一下也会被当成"撞了"，不算
    if (car.collisionImpact > 0.1 && cool <= 0 && t > 0.6) {
      hits++;
      hardest = Math.max(hardest, car.collisionImpact);
      cool = 0.3;
    }
    car.collisionImpact = 0;
    car.landingImpact = 0;
    if (pilot.progress >= goal) return { time: t, minSpeed, exitSpeed: car.speed, hits, hardest, done: true, offset };
  }
  return { time: t, minSpeed, exitSpeed: car.speed, hits, hardest, done: false, offset };
}

/**
 * 什么时候收车：车头离出弯方向还差多少度（负数 = 车头已经转过了出弯方向）。
 * 收车时车头会往回摆一些、行进方向往车头那边追一些，所以要等车头略微转过头再松手
 */
const EARLY = [-25, -5, 15];

/** 越小越好：用时，蹭墙要罚时（撞得越重罚得越多），没跑完的不算 */
const score = (r: Result) => (r.done ? r.time + r.hits * 0.8 + r.hardest * 4 : 99);
const fmt = (r: Result) =>
  `${r.time.toFixed(2)} 秒  弯里最低 ${(r.minSpeed * KMH).toFixed(0)}  出弯 ${(r.exitSpeed * KMH).toFixed(0)}  偏离中心线 ${r.offset.toFixed(1)} 米  ${r.hits ? `蹭墙 ${r.hits} 次（最重 ${r.hardest.toFixed(2)}）` : '没蹭墙'}${r.done ? '' : '  !! 没跑完'}`;

// 只测接近直角、弯前有足够直道的弯（几个直角弯形状一样，测一个就够）
const picked = turns.filter((t) => Math.abs(t.angle) > 1.2 && Math.abs(t.angle) < 1.9 && t.lead > 190).slice(0, 1);
console.log(`赛道上的弯：${turns.map((t) => `${S[t.i0].s.toFixed(0)}米 ${t.angle > 0 ? '左' : '右'}${((Math.abs(t.angle) * 180) / Math.PI).toFixed(0)}° 半径${t.radius.toFixed(0)}`).join('、')}`);
for (const turn of picked) {
  console.log(`\n=== 赛道 ${S[turn.i0].s.toFixed(0)} 米处的${turn.angle > 0 ? '左' : '右'}弯（${((Math.abs(turn.angle) * 180) / Math.PI).toFixed(0)}°，中心线半径 ${turn.radius.toFixed(0)} 米，路宽 16 米） ===`);
  for (const kmh of speeds) {
    const V = kmh / KMH;
    const approach = 150;
    const grip = run(turn, V, approach, null);
    console.log(`入弯 ${kmh} 千米/时`);
    console.log(`  不漂移（自动驾驶，提前刹车）：${fmt(grip)}`);

    // 随手一漂：不刹车，带方向点一下手刹（0.3 秒），打满方向给油，快到出弯方向时反打。只试不同的入弯点
    const spots = [70, 62, 54, 46, 38, 30, 22, 14, 6];
    let clean = 0;
    let naive: Result | null = null;
    let naiveAt = 0;
    const cleanAt: number[] = [];
    for (const at of spots) {
      let bestHere: Result | null = null;
      for (const early of EARLY) {
        const r = run(turn, V, approach, { entry: V, at, hand: 0.3, early });
        if (!bestHere || score(r) < score(bestHere)) bestHere = r;
      }
      if (bestHere && bestHere.done && bestHere.hits === 0) {
        clean++;
        cleanAt.push(at);
      }
      if (bestHere && (!naive || score(bestHere) < score(naive))) {
        naive = bestHere;
        naiveAt = at;
      }
    }
    if (naive) {
      console.log(`  随手一漂（不刹车，点一下手刹）：${fmt(naive)}`);
      console.log(`      最好的入弯点：离弯口 ${naiveAt} 米。九个入弯点里 ${clean} 个能不蹭墙过去${cleanAt.length ? `（离弯口 ${cleanAt.join('、')} 米）` : ''}；比不漂移${naive.time < grip.time ? '快' : '慢'} ${Math.abs(grip.time - naive.time).toFixed(2)} 秒`);
    }

    // 认真漂：可以先刹车、可以拉住手刹
    let best: Result | null = null;
    let bestPlan: DriftPlan | null = null;
    for (const entryK of [1, 0.8, 0.62]) {
      for (const at of [54, 40, 28, 16, 4]) {
        for (const hand of [0.3, 0.8]) {
          for (const early of EARLY) {
            const plan = { entry: V * entryK, at, hand, early };
            const r = run(turn, V, approach, plan);
            if (!best || score(r) < score(best)) {
              best = r;
              bestPlan = plan;
            }
          }
        }
      }
    }
    if (best && bestPlan) {
      console.log(`  认真漂（最好的一次）：${fmt(best)}`);
      console.log(`      开法：${bestPlan.entry < V - 0.5 ? `先刹到 ${(bestPlan.entry * KMH).toFixed(0)}，` : '不刹车，'}离弯口 ${bestPlan.at} 米拉手刹 ${bestPlan.hand} 秒，车头${bestPlan.early >= 0 ? `离出弯方向还差 ${bestPlan.early}°` : `转过出弯方向 ${-bestPlan.early}°`} 时反打；比不漂移${best.time < grip.time ? '快' : '慢'} ${Math.abs(grip.time - best.time).toFixed(2)} 秒`);
    }
  }
}
