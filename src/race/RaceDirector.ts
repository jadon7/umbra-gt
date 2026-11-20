import type { CityTrack, TrackSample } from '../city/cityLayout.ts';
import { TrackProgress } from './TrackProgress.ts';

export type RacePhase = 'idle' | 'grid' | 'countdown' | 'racing' | 'over';

/** 一个参赛者（玩家或对手）在比赛里的状态 */
export interface Racer {
  id: number;
  name: string;
  isPlayer: boolean;
  /** 界面上代表他的颜色 */
  color: string;
  progress: TrackProgress;
  /** 已经通过了几道门（检查点和终点线都算） */
  gates: number;
  /** 已经跑完几圈 */
  lap: number;
  lapStart: number;
  lapTimes: number[];
  best: number;
  finished: boolean;
  finishTime: number;
  /** 当前名次，1 起 */
  position: number;
}

export type RaceEvent =
  | { type: 'count'; n: number }
  | { type: 'go' }
  | { type: 'gate'; racer: Racer; index: number; time: number }
  | { type: 'lap'; racer: Racer; lap: number; time: number; best: boolean }
  | { type: 'finalLap' }
  | { type: 'finish'; racer: Racer }
  | { type: 'position'; from: number; to: number }
  | { type: 'over' };

/** 赛道上的一道门：检查点或终点线 */
export interface Gate {
  /** 在一圈里的第几米（终点线 = 一整圈的长度） */
  s: number;
  sample: TrackSample;
  finish: boolean;
}

export interface GridSlot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** 一圈分成几段：7 个检查点 + 终点线 */
const GATES_PER_LAP = 8;
/** 发车格摆好之后，先停一会儿再开始倒数 */
const GRID_HOLD = 1.6;
/** 玩家冲线后，最多再等其他人多久 */
const WAIT_AFTER_FINISH = 25;

/**
 * 比赛的裁判：倒计时、检查点、圈数、名次、完赛。
 * 不碰物理和画面，只看每辆车的赛道进度，所以可以在不开浏览器的仿真里跑。
 */
export class RaceDirector {
  readonly track: CityTrack;
  readonly laps: number;
  readonly racers: Racer[] = [];
  readonly gates: Gate[] = [];
  phase: RacePhase = 'idle';
  /** 比赛用时：发车信号那一刻是 0 */
  time = 0;
  /** 倒计时还剩几秒（发车前） */
  countdown = 0;
  /** 排好名次的参赛者 */
  order: Racer[] = [];

  private hold = 0;
  private lastCount = 4;
  private overTimer = 0;
  private readonly events: RaceEvent[] = [];
  private playerPos = 0;

  constructor(track: CityTrack, laps: number) {
    this.track = track;
    this.laps = laps;
    this.placeGates();
  }

  /** 把门尽量挪到直道上（不放在弯心，也不放在拱桥上：车在那儿是飞着的） */
  private placeGates(): void {
    const S = this.track.samples;
    const n = S.length;
    const L = this.track.length;
    const step = L / n;
    const crest = this.track.crest;
    const bad = (i: number, limit: number) => {
      for (let k = -10; k <= 10; k++) {
        const j = (i + k + n) % n;
        const p = S[j];
        if (Math.abs(p.curvature) > limit || (crest ? crest[j] : p.pos.y > 0.05)) return true;
      }
      return false;
    };
    for (let g = 1; g < GATES_PER_LAP; g++) {
      const base = Math.round(((L * g) / GATES_PER_LAP) / step);
      let pick = -1;
      for (const limit of [0.002, 0.008]) {
        for (let off = 0; off <= 40 && pick < 0; off++) {
          for (const sgn of [1, -1]) {
            const i = (base + sgn * off * 2 + n) % n;
            if (!bad(i, limit)) {
              pick = i;
              break;
            }
          }
        }
        if (pick >= 0) break;
      }
      if (pick < 0) pick = base % n;
      this.gates.push({ s: S[pick].s, sample: S[pick], finish: false });
    }
    this.gates.push({ s: L, sample: S[0], finish: true });
  }

  addRacer(name: string, color: string, isPlayer: boolean): Racer {
    const r: Racer = {
      id: this.racers.length,
      name,
      isPlayer,
      color,
      progress: new TrackProgress(this.track),
      gates: 0,
      lap: 0,
      lapStart: 0,
      lapTimes: [],
      best: Infinity,
      finished: false,
      finishTime: 0,
      position: this.racers.length + 1,
    };
    this.racers.push(r);
    this.order.push(r);
    return r;
  }

  /**
   * 第 i 个发车位（0 = 杆位）。两列交错排开：左列靠前，右列落后半个车位。
   * 都在发车线后面，所以累计距离是负的。
   */
  gridSlot(i: number): GridSlot {
    const S = this.track.samples;
    const n = S.length;
    const step = this.track.length / n;
    const row = Math.floor(i / 2);
    const right = i % 2 === 1;
    const back = 6 + row * 8.5 + (right ? 3.6 : 0);
    const p = S[(n - Math.round(back / step)) % n];
    const lateral = right ? -2.7 : 2.7;
    return {
      x: p.pos.x + p.left.x * lateral,
      y: p.pos.y,
      z: p.pos.z + p.left.z * lateral,
      yaw: Math.atan2(p.dir.x, p.dir.z),
    };
  }

  /** 停在发车格上先不倒数（放赛前镜头的时候用）。放完调 release */
  gridHeld = false;

  /** 赛前镜头放完了：隔一小会儿开始倒数 */
  release(delay = 0.45): void {
    this.gridHeld = false;
    if (this.phase === 'grid') this.hold = delay;
  }

  /** 所有车摆上发车格之后调用：开始走流程 */
  begin(): void {
    this.phase = 'grid';
    this.hold = GRID_HOLD;
    this.countdown = 3;
    this.lastCount = 4;
    this.time = 0;
    this.overTimer = 0;
    this.playerPos = this.racers.find((r) => r.isPlayer)?.position ?? 0;
    this.rank();
  }

  get player(): Racer | undefined {
    return this.racers.find((r) => r.isPlayer);
  }

  /** 车现在能不能动（倒计时结束之后） */
  get live(): boolean {
    return this.phase === 'racing' || this.phase === 'over';
  }

  /** 取走这一段时间里发生的事（界面和声音用） */
  drain(): RaceEvent[] {
    return this.events.splice(0, this.events.length);
  }

  private rank(): void {
    this.order.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress.total - a.progress.total;
    });
    this.order.forEach((r, i) => (r.position = i + 1));
  }

  /** 每帧调用一次。调用前各车的 progress 应该已经按最新位置更新过 */
  update(dt: number): void {
    if (this.phase === 'idle') return;
    if (this.phase === 'grid') {
      // 赛前的特写镜头还没放完：先不倒数
      if (this.gridHeld) return;
      this.hold -= dt;
      if (this.hold <= 0) this.phase = 'countdown';
      return;
    }
    if (this.phase === 'countdown') {
      const shown = Math.ceil(this.countdown);
      if (shown < this.lastCount && shown >= 1) {
        this.lastCount = shown;
        this.events.push({ type: 'count', n: shown });
      }
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'racing';
        this.time = 0;
        this.events.push({ type: 'go' });
      }
      return;
    }

    this.time += dt;
    const L = this.track.length;
    for (const r of this.racers) {
      if (r.finished) continue;
      // 一帧里可能连过两道门（卡顿之后），所以用循环
      for (;;) {
        const k = r.gates % GATES_PER_LAP;
        const at = Math.floor(r.gates / GATES_PER_LAP) * L + this.gates[k].s;
        if (r.progress.total < at) break;
        r.gates++;
        if (!this.gates[k].finish) {
          this.events.push({ type: 'gate', racer: r, index: k, time: this.time });
          continue;
        }
        const lapTime = this.time - r.lapStart;
        const best = lapTime < r.best;
        if (best) r.best = lapTime;
        r.lapTimes.push(lapTime);
        r.lapStart = this.time;
        r.lap++;
        this.events.push({ type: 'lap', racer: r, lap: r.lap, time: lapTime, best });
        if (r.lap >= this.laps) {
          r.finished = true;
          r.finishTime = this.time;
          this.events.push({ type: 'finish', racer: r });
          break;
        }
        if (r.isPlayer && r.lap === this.laps - 1) this.events.push({ type: 'finalLap' });
      }
    }
    this.rank();

    const player = this.player;
    if (player) {
      if (player.position !== this.playerPos && this.phase === 'racing' && !player.finished) {
        this.events.push({ type: 'position', from: this.playerPos, to: player.position });
      }
      this.playerPos = player.position;
    }

    if (this.phase === 'racing') {
      const all = this.racers.every((r) => r.finished);
      if (player?.finished || (!player && all)) {
        this.overTimer += dt;
        if (all || this.overTimer > WAIT_AFTER_FINISH || !player) {
          this.phase = 'over';
          this.events.push({ type: 'over' });
        }
      }
    }
  }

  /** 玩家冲线后其他人还没跑完的话，不再等：比赛立刻算结束（名次按当前的前后） */
  endNow(): void {
    if (this.phase === 'racing') {
      this.phase = 'over';
      this.events.push({ type: 'over' });
    }
  }

  /** 下一道该过的门（画检查点用） */
  nextGate(r: Racer): Gate {
    return this.gates[r.gates % GATES_PER_LAP];
  }

  /** 再下一道门 */
  gateAfter(r: Racer): Gate {
    return this.gates[(r.gates + 1) % GATES_PER_LAP];
  }

  get gatesPerLap(): number {
    return GATES_PER_LAP;
  }
}
