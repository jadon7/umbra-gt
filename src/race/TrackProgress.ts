import type { CityTrack } from '../city/cityLayout.ts';

/** 离赛道中心线多远还算"在赛道上"（路面半宽 8 米 + 人行道 4.5 米 + 一点余量） */
const MAX_OFF = 15;
/** 抄近道重新回到赛道时，最多允许往前跳多远还算数 */
const MAX_JUMP = 120;

/**
 * 一辆车在赛道上的进度：在第几米、离中心线多远、从发车线算起一共跑了多远。
 * 玩家和对手都用它；名次、圈数、检查点全由 total 推出来。
 *
 * 只认"沿着赛道走"的进度：车离中心线太远（钻到别的路上）时进度停住，
 * 回到赛道附近才继续算，所以抄近道不会多算距离。
 */
export class TrackProgress {
  /** 最近的采样点下标 */
  index = 0;
  /** 这一圈跑到第几米 */
  s = 0;
  /** 离中心线的横向距离，正值在左边 */
  lateral = 0;
  /** 从发车线算起累计的距离。发车格在线后，所以起步时是负的 */
  total = 0;
  /** 离赛道太远，进度暂停中 */
  offTrack = false;

  private readonly track: CityTrack;
  private readonly step: number;

  constructor(track: CityTrack) {
    this.track = track;
    this.step = track.length / track.samples.length;
  }

  /** 全图找最近的点 */
  private nearest(x: number, z: number): { i: number; d2: number } {
    const S = this.track.samples;
    let best = Infinity;
    let bi = 0;
    for (let i = 0; i < S.length; i++) {
      const d = (S[i].pos.x - x) ** 2 + (S[i].pos.z - z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return { i: bi, d2: best };
  }

  private settle(i: number, x: number, z: number): void {
    const p = this.track.samples[i];
    const dx = x - p.pos.x;
    const dz = z - p.pos.z;
    this.index = i;
    this.lateral = dx * p.left.x + dz * p.left.z;
    const along = dx * p.dir.x + dz * p.dir.z;
    let s = p.s + along;
    const L = this.track.length;
    if (s < 0) s += L;
    if (s >= L) s -= L;
    // total 跟着 s 走：取离上一次最近的那个等价值（差整数圈）
    let d = s - this.s;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    this.total += d;
    this.s = s;
  }

  /** 把车放到某个位置后调用。发车线之后半圈以内的位置算作"线后"（负的距离） */
  reset(x: number, z: number): void {
    const { i } = this.nearest(x, z);
    this.s = 0;
    this.total = 0;
    this.settle(i, x, z);
    const L = this.track.length;
    this.total = this.s > L / 2 ? this.s - L : this.s;
    this.offTrack = false;
  }

  update(x: number, z: number): void {
    const S = this.track.samples;
    const n = S.length;
    // 先在上一次位置附近找（往后 16 米、往前 90 米）
    let best = Infinity;
    let bi = this.index;
    for (let k = -8; k <= 45; k++) {
      const i = (this.index + k + n) % n;
      const d = (S[i].pos.x - x) ** 2 + (S[i].pos.z - z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    if (best <= MAX_OFF * MAX_OFF) {
      this.offTrack = false;
      this.settle(bi, x, z);
      return;
    }
    // 附近没有：可能是切了个弯角又回到赛道上。往前跳得不多就认，否则算偏离赛道
    const g = this.nearest(x, z);
    let jump = (g.i - this.index) * this.step;
    const L = this.track.length;
    if (jump > L / 2) jump -= L;
    if (jump < -L / 2) jump += L;
    if (g.d2 <= MAX_OFF * MAX_OFF && jump > -40 && jump < MAX_JUMP) {
      this.offTrack = false;
      this.settle(g.i, x, z);
      return;
    }
    this.offTrack = true;
  }
}
