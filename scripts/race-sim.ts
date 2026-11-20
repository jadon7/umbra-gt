/**
 * 在无头仿真里跑一整场比赛：检查对手能不能跑完、会不会卡死、各难度的圈速和差距。
 * "玩家"也由 AI 来开，水平用第 4 个参数指定。
 *
 * 运行：node scripts/race-sim.ts [难度 easy|normal|hard] [对手数] [圈数] [玩家水平 slow|mid|fast|show|none] [map=mountain] [grip=0.8]
 *   玩家水平写 show = 用比赛里的自动驾驶（表演式的那个：会漂移、开氮气，见 src/race/RacePilot.ts）来开玩家的车
 */
import { PHYSICS_DT } from '../src/drive/PhysicsWorld.ts';
import { loadMap } from './lib/maps.ts';
import { Vehicle } from '../src/drive/Vehicle.ts';
import { RaceField } from '../src/race/RaceField.ts';
import type { AISkill } from '../src/race/RivalAI.ts';
import { pickRivals, type RaceLevel } from '../src/race/roster.ts';
import { RacePilot } from '../src/race/RacePilot.ts';
import { ShowPilot } from '../src/drive/ShowPilot.ts';

const args = process.argv.slice(2).filter((a) => !a.includes('=') && a !== '-v');
const level = (args[0] ?? 'normal') as RaceLevel;
const rivalCount = Number(args[1] ?? 5);
const laps = Number(args[2] ?? 2);
const who = args[3] ?? 'mid';

const PLAYERS: Record<string, AISkill> = {
  slow: { lateral: 7.5, brake: 7.5, top: 48, nitro: false, reaction: 0.5, line: 0 },
  mid: { lateral: 10.5, brake: 9.5, top: 62, nitro: true, reaction: 0.3, line: 0 },
  fast: { lateral: 12.5, brake: 10.5, top: 78, nitro: true, reaction: 0.2, line: 0 },
};

const map = await loadMap();
const { physics, track } = map;
if (map.name !== 'city') console.log(`${map.label}，一圈 ${track.length.toFixed(0)} 米`);
const rivals = pickRivals(rivalCount, 'lava');
const hasPlayer = who !== 'none';
const vehicles = Array.from({ length: rivals.length + (hasPlayer ? 1 : 0) }, () => new Vehicle(physics));
const field = new RaceField(track, vehicles, {
  laps,
  level,
  rivals,
  player: hasPlayer ? { name: `玩家(${who})`, color: '#f7de00' } : undefined,
  playerSkill: hasPlayer ? (PLAYERS[who] ?? PLAYERS.fast) : undefined,
});
// show：玩家的车由比赛里的自动驾驶来开（它算「人开的」，这里自己推进）；别的水平是普通的对手 AI
const showPilot = who === 'show' && field.player ? new ShowPilot(track) : null;
const racePilot = showPilot ? new RacePilot(showPilot, field, track.length) : null;
if (field.player && !racePilot) field.player.human = false;
let drifts = 0;
let wasDrifting = false;
// 可选：grip=0.8 这样的参数模拟雪地
const gripArg = process.argv.find((a) => a.startsWith('grip='));
if (gripArg) {
  field.setGrip(Number(gripArg.slice(5)));
  if (showPilot) showPilot.grip = Number(gripArg.slice(5));
}
field.lineUp();

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const hits = field.cars.map(() => 0);
const hardest = field.cars.map(() => 0);
const seen = field.cars.map(() => 0);
const verbose = process.argv.includes('-v');
let t = 0;
let stepIndex = 0;
const d = field.director;
console.log(`难度 ${level} · 对手 ${rivals.length} · ${laps} 圈 · 玩家 ${who} · 检查点在 ${d.gates.map((g) => g.s.toFixed(0)).join(' / ')} 米`);

while (d.phase !== 'over' && t < 900) {
  if (racePilot && field.player && field.player.human) {
    const v = field.player.vehicle;
    v.step(racePilot.drive(PHYSICS_DT), PHYSICS_DT);
    if (v.drifting && !wasDrifting) drifts++;
    wasDrifting = v.drifting;
  }
  field.step(PHYSICS_DT);
  physics.step();
  field.cars.forEach((c, i) => {
    if (c.vehicle.collisionImpact > 0.12) {
      hits[i]++;
      hardest[i] = Math.max(hardest[i], c.vehicle.collisionImpact);
    }
    if (c.vehicle.collisionImpact > 0.8 && verbose) console.log(`  ${fmt(d.time)}  ${c.racer.name} 重撞 ${c.vehicle.collisionImpact.toFixed(2)} @ ${c.racer.progress.s.toFixed(0)} 米 横向 ${c.racer.progress.lateral.toFixed(1)} 车速 ${(c.vehicle.speed * 3.6).toFixed(0)}`);
    c.vehicle.collisionImpact = 0;
    c.vehicle.landingImpact = 0;
    if (c.respawns !== seen[i]) {
      seen[i] = c.respawns;
      console.log(`  ${fmt(d.time)}  ${c.racer.name} 被放回赛道 @ ${c.racer.progress.s.toFixed(0)} 米`);
    }
  });
  if (stepIndex % 2 === 1) {
    field.think(PHYSICS_DT * 2);
    for (const e of d.drain()) {
      if (e.type === 'lap') console.log(`  ${fmt(d.time)}  ${e.racer.name.padEnd(10)} 第 ${e.lap} 圈 ${e.time.toFixed(2)} 秒  名次 ${e.racer.position}`);
      if (e.type === 'position') console.log(`  ${fmt(d.time)}  玩家名次 ${e.from} → ${e.to}`);
    }
  }
  stepIndex++;
  t += PHYSICS_DT;
}

if (racePilot) console.log(`\n玩家由比赛里的自动驾驶开：漂移 ${drifts} 次`);
console.log(`\n结果（${d.phase === 'over' ? '比赛结束' : '超时'}，用时 ${fmt(d.time)}）`);
for (const r of d.order) {
  const i = field.cars.findIndex((c) => c.racer === r);
  const c = field.cars[i];
  const time = r.finished ? fmt(r.finishTime) : `未完赛（${(r.progress.total / track.length).toFixed(2)} 圈）`;
  console.log(
    `${String(r.position).padStart(2)}. ${r.name.padEnd(10)} ${time.padEnd(18)} 最快圈 ${r.best === Infinity ? '—' : r.best.toFixed(2)}  碰撞 ${hits[i]} 次（最重 ${hardest[i].toFixed(2)}）  放回赛道 ${c.respawns} 次`,
  );
}
