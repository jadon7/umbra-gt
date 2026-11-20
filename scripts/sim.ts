/**
 * 无头仿真：不开浏览器，直接跑物理并打印关键数据，用来调校手感。
 * 运行：node scripts/sim.ts
 */
import { Quaternion, Vector3 } from 'three';
import { PhysicsWorld, PHYSICS_DT } from '../src/drive/PhysicsWorld.ts';
import { Vehicle, type DriveInput } from '../src/drive/Vehicle.ts';

const physics = await PhysicsWorld.create();
physics.addGround(40000);
const car = new Vehicle(physics);

const KMH = 3.6;
const fmt = (v: number, d = 1) => v.toFixed(d);
const deg = (r: number) => (r * 180) / Math.PI;

function input(p: Partial<DriveInput> = {}): DriveInput {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, ...p };
}

function yawOf(): number {
  const r = car.body.rotation();
  const f = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w));
  return Math.atan2(f.x, f.z);
}

function pos(): Vector3 {
  const t = car.body.translation();
  return new Vector3(t.x, t.y, t.z);
}

/** 跑一段时间。fn 返回 false 可提前结束 */
function run(seconds: number, fn: (t: number) => DriveInput | false): number {
  const steps = Math.round(seconds / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS_DT;
    const inp = fn(t);
    if (inp === false) return t;
    car.step(inp, PHYSICS_DT);
    physics.step();
  }
  return seconds;
}

function settle(): void {
  car.reset(0, 0.02, 0, 0);
  car.nitro = 1;
  run(1.5, () => input());
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

/* 1. 静止姿态 */
section('静止姿态');
settle();
{
  const p = pos();
  const r = car.body.rotation();
  const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w));
  console.log(`车身原点高度 ${fmt(p.y * 1000, 1)} 毫米（目标 0）  前后漂移 ${fmt(p.z * 1000, 1)} 毫米  倾角 ${fmt(deg(Math.acos(Math.min(1, up.y))), 2)}°`);
  console.log(`轮载荷 ${car.wheels.map((w) => fmt(w.load, 0)).join(' / ')} 牛   悬挂位移 ${car.wheels.map((w) => fmt(w.travel * 1000, 1)).join(' / ')} 毫米`);
}

/* 2. 直线加速 */
section('直线加速（全油门）');
settle();
{
  const marks = [60, 100, 160, 200, 250, 300];
  const times: Record<number, number> = {};
  let maxLat = 0;
  let prev = 0;
  let lastGear = 1;
  const shifts: string[] = [];
  run(45, (t) => {
    const v = car.forwardSpeed * KMH;
    for (const m of marks) if (prev < m && v >= m) times[m] = t;
    prev = v;
    maxLat = Math.max(maxLat, Math.abs(pos().x));
    if (car.gear !== lastGear) {
      shifts.push(`${lastGear}→${car.gear}@${fmt(v, 0)}`);
      lastGear = car.gear;
    }
    return input({ throttle: 1 });
  });
  console.log(marks.map((m) => `0–${m}: ${times[m] !== undefined ? fmt(times[m], 2) + ' 秒' : '未达到'}`).join('   '));
  console.log(`45 秒后车速 ${fmt(car.forwardSpeed * KMH, 0)} 千米/时（极速）  ${car.gear} 挡 ${fmt(car.rpm, 0)} 转  直线跑偏 ${fmt(maxLat, 3)} 米`);
  console.log(`换挡点：${shifts.join('  ')}`);
}

/* 3. 氮气 */
section('氮气（100 千米/时 起，全油门 + 氮气）');
settle();
{
  run(30, () => (car.forwardSpeed * KMH >= 100 ? false : input({ throttle: 1 })));
  car.nitro = 1;
  const v0 = car.forwardSpeed * KMH;
  let used = 0;
  run(10, (t) => {
    if (car.nitro <= 0.01 && used === 0) used = t;
    return used ? false : input({ throttle: 1, nitro: true });
  });
  const v1 = car.forwardSpeed * KMH;
  console.log(`${fmt(v0, 0)} → ${fmt(v1, 0)} 千米/时，氮气持续 ${fmt(used, 2)} 秒，平均加速度 ${fmt((v1 - v0) / KMH / used / 9.81, 2)} g`);
  settle();
  run(30, () => (car.forwardSpeed * KMH >= 100 ? false : input({ throttle: 1 })));
  const a0 = car.forwardSpeed * KMH;
  run(used, () => input({ throttle: 1 }));
  console.log(`对照（不开氮气同样时长）：${fmt(a0, 0)} → ${fmt(car.forwardSpeed * KMH, 0)} 千米/时`);
}

/* 4. 制动 */
section('制动');
for (const from of [100, 200]) {
  settle();
  run(60, () => (car.forwardSpeed * KMH >= from ? false : input({ throttle: 1 })));
  const z0 = pos().z;
  const t = run(20, () => (car.forwardSpeed < 0.3 ? false : input({ brake: 1 })));
  const dist = pos().z - z0;
  console.log(`${from}–0：${fmt(dist, 1)} 米，${fmt(t, 2)} 秒，平均 ${fmt(from / KMH / t / 9.81, 2)} g，跑偏 ${fmt(Math.abs(pos().x), 2)} 米`);
}

/* 5. 定速过弯 */
section('定速过弯（方向打满，定速巡航）');
for (const target of [50, 100, 150, 220]) {
  settle();
  const cruise = () => clamp01((target / KMH - car.forwardSpeed) * 0.6 + 0.25);
  run(40, () => (car.forwardSpeed * KMH >= target ? false : input({ throttle: 1 })));
  run(6, () => input({ throttle: cruise(), steer: 1 }));
  // 取最后 2 秒的平均
  let sumG = 0;
  let sumV = 0;
  let sumBeta = 0;
  let sumYaw = 0;
  let n = 0;
  let drift = 0;
  run(2, () => {
    sumG += car.lateralG;
    sumV += car.speed;
    sumBeta += car.sideSlip;
    sumYaw += car.body.angvel().y;
    if (car.drifting) drift++;
    n++;
    return input({ throttle: cruise(), steer: 1 });
  });
  const v = sumV / n;
  const radius = v / Math.max(1e-3, Math.abs(sumYaw / n));
  console.log(
    `目标 ${target}：实际 ${fmt(v * KMH, 0)} 千米/时  半径 ${fmt(radius, 1)} 米  横向 ${fmt(sumG / n, 2)} g  侧滑角 ${fmt(deg(sumBeta / n), 1)}°  前轮转角 ${fmt(deg(car.steerAngle), 1)}°  漂移占比 ${fmt((drift / n) * 100, 0)}%`,
  );
}

/* 6. 高速变线 */
section('高速变线（180 千米/时，左打 0.5 秒 → 右打 0.5 秒 → 回正）');
settle();
{
  run(40, () => (car.forwardSpeed * KMH >= 180 ? false : input({ throttle: 1 })));
  const y0 = yawOf();
  const x0 = pos().x;
  let maxBeta = 0;
  run(0.5, () => input({ throttle: 0.6, steer: 1 }));
  run(0.5, () => {
    maxBeta = Math.max(maxBeta, Math.abs(car.sideSlip));
    return input({ throttle: 0.6, steer: -1 });
  });
  let settleT = -1;
  run(3, (t) => {
    maxBeta = Math.max(maxBeta, Math.abs(car.sideSlip));
    if (settleT < 0 && Math.abs(car.body.angvel().y) < 0.02 && Math.abs(car.sideSlip) < 0.01) settleT = t;
    return input({ throttle: 0.6 });
  });
  console.log(
    `横移 ${fmt(pos().x - x0, 1)} 米  航向变化 ${fmt(deg(yawOf() - y0), 1)}°  最大侧滑角 ${fmt(deg(maxBeta), 1)}°  回稳 ${settleT < 0 ? '3 秒内未回稳' : fmt(settleT, 2) + ' 秒'}  结束车速 ${fmt(car.forwardSpeed * KMH, 0)}`,
  );
}

/* 7–8. 漂移 */

/** 行进方向角（速度矢量的朝向） */
function velYaw(): number {
  const v = car.body.linvel();
  return Math.atan2(v.x, v.z);
}

interface DriftPhase {
  name: string;
  seconds: number;
  input: (t: number) => DriveInput;
}

/** 先加速到指定车速，再依次执行各阶段；每个阶段结束时打印侧滑角、车速、这一段的平均弧线半径 */
function driftRun(title: string, fromKmh: number, phases: DriftPhase[]): void {
  section(title);
  settle();
  run(40, () => (car.forwardSpeed * KMH >= fromKmh ? false : input({ throttle: 1 })));
  const y0 = velYaw();
  let turned = 0;
  let prevYaw = y0;
  for (const ph of phases) {
    let dist = 0;
    let yawSum = 0;
    let driftT = 0;
    let maxBeta = 0;
    run(ph.seconds, (t) => {
      const y = velYaw();
      let d = y - prevYaw;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      yawSum += d;
      prevYaw = y;
      dist += car.speed * PHYSICS_DT;
      if (car.drifting) driftT += PHYSICS_DT;
      maxBeta = Math.max(maxBeta, Math.abs(car.sideSlip));
      return ph.input(t);
    });
    turned += yawSum;
    const radius = Math.abs(yawSum) > 1e-3 ? dist / Math.abs(yawSum) : Infinity;
    console.log(
      `${ph.name.padEnd(14, '　')} ${fmt(ph.seconds, 1)}s  侧滑角 ${fmt(deg(car.sideSlip), 0).padStart(4)}°（最大 ${fmt(deg(maxBeta), 0)}°） 车速 ${fmt(car.speed * KMH, 0).padStart(3)}  弧线半径 ${radius === Infinity ? '直线' : fmt(radius, 0) + ' 米'}  转过 ${fmt(deg(yawSum), 0)}°  漂移 ${fmt((driftT / ph.seconds) * 100, 0)}%`,
    );
  }
  console.log(`合计转过 ${fmt(deg(turned), 0)}°  结束：漂移状态 ${car.drifting}  侧滑角 ${fmt(deg(car.sideSlip), 1)}°  氮气 ${fmt(car.nitro, 2)}`);
}

const entry: DriftPhase = { name: '手刹入弯', seconds: 0.4, input: () => input({ steer: 1, handbrake: true }) };
const tap = (period: number, on: number) => (t: number) => input({ throttle: 1, steer: t % period < on ? 1 : 0 });

driftRun('漂移 A：入弯后松开方向，只给油（应保持中等角度走大弧线，几秒后自己摆正）', 110, [
  entry,
  { name: '松开方向', seconds: 1.5, input: () => input({ throttle: 1 }) },
  { name: '继续松开', seconds: 2.5, input: () => input({ throttle: 1 }) },
  { name: '继续松开', seconds: 2.0, input: () => input({ throttle: 1 }) },
]);

driftRun('漂移 B：键盘连点方向（每 0.3 秒点 0.2 秒），应能一直漂下去；点得稀了会自己收车', 120, [
  entry,
  { name: '点按', seconds: 3, input: tap(0.3, 0.2) },
  { name: '点按', seconds: 3, input: tap(0.3, 0.2) },
  { name: '点按', seconds: 3, input: tap(0.3, 0.2) },
]);

driftRun('漂移 C：往弯里打满（角度最大、弧线最紧）', 110, [
  entry,
  { name: '打满', seconds: 2, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '打满', seconds: 2, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '松开方向', seconds: 1.5, input: () => input({ throttle: 1 }) },
]);

driftRun('漂移 D：往弯里只打一半（弧线放宽），再轻轻反打一半收车', 120, [
  entry,
  { name: '打满', seconds: 1.5, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '只打一半', seconds: 2, input: () => input({ throttle: 1, steer: 0.5 }) },
  { name: '轻轻反打一半', seconds: 1.0, input: () => input({ throttle: 1, steer: -0.5 }) },
  { name: '回正', seconds: 1.5, input: () => input({ throttle: 0.6 }) },
]);

driftRun('漂移 E：松油退出', 110, [
  entry,
  { name: '打满', seconds: 1.5, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '松油', seconds: 2, input: () => input({ steer: 0.3 }) },
  { name: '再给油', seconds: 1.5, input: () => input({ throttle: 1 }) },
]);

driftRun('漂移 F：反打并一直按住（应该收车、然后正常往右拐，不会甩到另一边去）', 120, [
  entry,
  { name: '左打满', seconds: 1.5, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '右打满', seconds: 1.2, input: () => input({ throttle: 1, steer: -1 }) },
  { name: '右打满', seconds: 1.5, input: () => input({ throttle: 1, steer: -1 }) },
]);

driftRun('漂移 F2：换向（左漂中反打右、同时再拉一把手刹，甩到另一侧）', 120, [
  entry,
  { name: '左打满', seconds: 1.5, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '右打加手刹', seconds: 0.3, input: () => input({ throttle: 1, steer: -1, handbrake: true }) },
  { name: '右打满', seconds: 1.5, input: () => input({ throttle: 1, steer: -1 }) },
]);

driftRun('漂移 G：点刹入弯（左打同时点刹 0.25 秒）', 130, [
  { name: '点刹', seconds: 0.25, input: () => input({ steer: 1, brake: 1 }) },
  { name: '给油左打', seconds: 2.5, input: () => input({ throttle: 1, steer: 1 }) },
]);

driftRun('漂移 H：低速回头弯（70 千米/时 手刹入弯后打满）', 70, [
  entry,
  { name: '打满', seconds: 2.5, input: () => input({ throttle: 1, steer: 1 }) },
]);

driftRun('漂移 I：一直拉着手刹打满（应该原地甩过直角弯，而不是横着往前滑）', 120, [
  { name: '手刹打满', seconds: 1.0, input: () => input({ steer: 1, handbrake: true }) },
  { name: '手刹打满', seconds: 1.0, input: () => input({ steer: 1, handbrake: true }) },
  { name: '松手刹给油', seconds: 1.5, input: () => input({ throttle: 1, steer: 0.4 }) },
  { name: '反打收车', seconds: 1.2, input: () => input({ throttle: 1, steer: -1 }) },
]);

driftRun('漂移 J：高速入直角弯（150 千米/时，点一下手刹后打满给油）', 150, [
  { name: '手刹', seconds: 0.3, input: () => input({ steer: 1, handbrake: true }) },
  { name: '打满给油', seconds: 1.0, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '打满给油', seconds: 1.0, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '打满给油', seconds: 1.0, input: () => input({ throttle: 1, steer: 1 }) },
  { name: '反打收车', seconds: 1.2, input: () => input({ throttle: 1, steer: -1 }) },
  { name: '回正', seconds: 1.0, input: () => input({ throttle: 1 }) },
]);

/* 8b. 收车：漂移中想结束的时候，各种结束的办法各要多久、车头还会不会接着转、会不会甩到另一边去 */

/**
 * 先漂起来（点手刹、打满方向给油 1.2 秒），然后换成"结束漂移"的操作，看：
 *  - 多久之后不再是漂移状态
 *  - 从开始收车到结束，车头又多转了多少度（越少越好：松手时车头指哪，车就该往哪走）
 *  - 结束之后行进方向和「开始收车那一刻车头的方向」差多少
 *  - 之后有没有又进入漂移、有没有甩到另一边去
 */
function exitRun(name: string, fromKmh: number, seconds: number, exit: (t: number) => DriveInput): void {
  settle();
  run(40, () => (car.forwardSpeed * KMH >= fromKmh ? false : input({ throttle: 1 })));
  run(0.3, () => input({ steer: 1, handbrake: true }));
  run(1.2, () => input({ throttle: 1, steer: 1 }));
  const nose0 = yawOf();
  const slip0 = car.sideSlip;
  const speed0 = car.speed * KMH;
  let ended = -1;
  let noseAtEnd = nose0;
  let again = false;
  let flipped = 0;
  const diff = (a: number, b: number) => {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  run(seconds, (t) => {
    if (ended < 0 && !car.drifting) {
      ended = t;
      noseAtEnd = yawOf();
    } else if (ended >= 0 && car.drifting) {
      again = true;
    }
    // 甩到另一边：侧滑角的符号和原来相反、而且不小
    if (Math.sign(car.sideSlip) === -Math.sign(slip0)) flipped = Math.max(flipped, Math.abs(car.sideSlip));
    return exit(t);
  });
  const noseTurn = deg(diff(noseAtEnd, nose0));
  const pathOff = deg(diff(velYaw(), nose0));
  console.log(
    `${name.padEnd(16, '　')} ${fmt(speed0, 0).padStart(3)} 千米/时、侧滑 ${fmt(Math.abs(deg(slip0)), 0)}° 时开始收车：` +
      (ended < 0 ? `${fmt(seconds, 1)} 秒内没能结束漂移` : `${fmt(ended, 2)} 秒后结束，期间车头又转了 ${fmt(noseTurn, 0)}°`) +
      `；${fmt(seconds, 1)} 秒后行进方向比收车时的车头方向偏 ${fmt(pathOff, 0)}°，车速 ${fmt(car.speed * KMH, 0)}` +
      `${again ? '  !! 又进入了漂移' : ''}${flipped > 0.2 ? `  !! 甩到另一边 ${fmt(deg(flipped), 0)}°` : ''}`,
  );
}

section('收车（漂移中换成各种"结束"的操作）');
exitRun('松开方向、油门不松', 110, 2.0, () => input({ throttle: 1 }));
exitRun('松开方向（高速）', 160, 2.0, () => input({ throttle: 1 }));
exitRun('反打一下再回正', 110, 2.0, (t) => input({ throttle: 1, steer: t < 0.25 ? -1 : 0 }));
exitRun('反打并按住 0.8 秒', 110, 2.0, (t) => input({ throttle: 1, steer: t < 0.8 ? -1 : 0 }));
exitRun('松开方向和油门', 110, 2.0, () => input({}));
exitRun('踩刹车', 110, 2.0, (t) => input({ brake: t < 0.6 ? 1 : 0, throttle: t < 0.6 ? 0 : 1 }));
exitRun('轻轻反打一半并按住', 110, 2.0, (t) => input({ throttle: 1, steer: t < 0.8 ? -0.5 : 0 }));

/* 9. 大油门出弯（不该莫名其妙打转） */
section('低速大油门出弯（40 千米/时，方向打满 + 全油门 4 秒）');
settle();
{
  run(40, () => (car.forwardSpeed * KMH >= 40 ? false : input({ throttle: 0.6 })));
  let maxBeta = 0;
  run(4, () => {
    maxBeta = Math.max(maxBeta, Math.abs(car.sideSlip));
    return input({ throttle: 1, steer: 1 });
  });
  console.log(`最大侧滑角 ${fmt(deg(maxBeta), 0)}°  结束车速 ${fmt(car.speed * KMH, 0)}  漂移状态 ${car.drifting}`);
}

/* 10. 倒车 */
section('倒车（静止踩刹车 3 秒，再全油门 2 秒）');
settle();
{
  run(3, () => input({ brake: 1 }));
  const vr = car.forwardSpeed * KMH;
  const g = car.gear;
  run(2, () => input({ throttle: 1 }));
  console.log(`倒车车速 ${fmt(vr, 0)} 千米/时（挡位 ${g}）→ 再给油后 ${fmt(car.forwardSpeed * KMH, 0)} 千米/时（挡位 ${car.gear}）`);
}

/* 12. 跳台 */
section('跳台（10° 坡道，150 千米/时 冲上去）');
{
  const th = (10 * Math.PI) / 180;
  const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -th);
  physics.addBox({ x: 0, y: 9 * Math.sin(th) - 0.25 * Math.cos(th), z: 400 }, { x: 5, y: 0.25, z: 9 }, q, 1.0, 0);
  settle();
  run(40, () => (car.forwardSpeed * KMH >= 150 ? false : input({ throttle: 1 })));
  const zNow = pos().z;
  car.body.setTranslation({ x: 0, y: pos().y, z: 380 - (zNow - zNow) }, true);
  let maxH = 0;
  let air = 0;
  let minUp = 1;
  let landed = -1;
  let impact = 0;
  run(5, (t) => {
    const p = pos();
    maxH = Math.max(maxH, p.y);
    if (car.groundedCount === 0) air += PHYSICS_DT;
    const r = car.body.rotation();
    const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w));
    minUp = Math.min(minUp, up.y);
    impact = Math.max(impact, car.landingImpact);
    if (landed < 0 && air > 0.3 && car.groundedCount >= 3) landed = t;
    return input({ throttle: 1 });
  });
  console.log(
    `最大离地 ${fmt(maxH, 2)} 米  滞空 ${fmt(air, 2)} 秒  最大倾斜 ${fmt(deg(Math.acos(minUp)), 0)}°  落地冲击 ${fmt(impact, 2)}  5 秒后车速 ${fmt(car.speed * KMH, 0)}  跑偏 ${fmt(Math.abs(pos().x), 2)} 米  车身高度 ${fmt(pos().y, 3)}`,
  );
}

/* 13. 擦墙 */
section('擦墙（150 千米/时，约 8° 夹角蹭上右侧护栏）');
{
  physics.addBox({ x: -6.3, y: 1, z: 1200 }, { x: 0.3, y: 1, z: 300 });
  settle();
  run(40, () => (car.forwardSpeed * KMH >= 150 ? false : input({ throttle: 1 })));
  car.body.setTranslation({ x: 0, y: pos().y, z: 950 }, true);
  const yaw = (-8 * Math.PI) / 180;
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  const sp = car.speed;
  car.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  car.body.setLinvel({ x: Math.sin(yaw) * sp, y: 0, z: Math.cos(yaw) * sp }, true);
  let impact = 0;
  let minSpeed = 999;
  let minX = 0;
  run(3, () => {
    impact = Math.max(impact, car.collisionImpact);
    minSpeed = Math.min(minSpeed, car.speed * KMH);
    minX = Math.min(minX, pos().x);
    return input({ throttle: 1 });
  });
  const r = car.body.rotation();
  const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w));
  console.log(
    `碰撞冲击 ${fmt(impact, 2)}  最低车速 ${fmt(minSpeed, 0)}  最靠墙 x=${fmt(minX, 2)}（墙面在 -6.0）  3 秒后：车速 ${fmt(car.speed * KMH, 0)}  x=${fmt(pos().x, 1)}  航向 ${fmt(deg(yawOf()), 1)}°  倾斜 ${fmt(deg(Math.acos(Math.min(1, up.y))), 1)}°`,
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
