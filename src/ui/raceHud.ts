import type { CityTrack } from '../city/cityLayout.ts';
import type { Gate, RaceDirector } from '../race/RaceDirector.ts';
import type { RivalTag } from '../race/RaceSession.ts';
import { MiniMap, type MapDot } from './miniMap.ts';
import { appSize } from '../core/viewport.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** 把秒数写成 分:秒.百分秒 */
export function formatTime(t: number): string {
  if (!isFinite(t)) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 自己的车此刻在哪、朝哪、多快（小地图用） */
export interface MapPose {
  x: number;
  z: number;
  carYaw: number;
  velYaw: number;
  speed: number;
}

/**
 * 比赛界面：名次、圈数、计时、排行榜、小地图、倒计时和各种横幅、对手头顶的名牌。
 * 车速表那一块还是用试驾界面（hud.ts）的。
 */
export class RaceHud {
  private readonly root: HTMLElement;
  private readonly pos: HTMLElement;
  private readonly posTotal: HTMLElement;
  private readonly lap: HTMLElement;
  private readonly time: HTMLElement;
  private readonly lapTime: HTMLElement;
  private readonly best: HTMLElement;
  private readonly board: HTMLElement;
  private readonly big: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly note: HTMLElement;
  private readonly warn: HTMLElement;
  private readonly tagLayer: HTMLElement;
  private readonly tagNodes: HTMLElement[] = [];
  private readonly map: MiniMap;
  private readonly dots: MapDot[] = [];
  private bannerTimer = 0;
  private noteTimer = 0;
  private bigTimer = 0;
  private boardKey = '';
  private lastPos = 0;
  private lastLap = '';

  constructor(parent: HTMLElement, track: CityTrack) {
    this.root = el('div', 'race');
    this.root.style.display = 'none';

    const rank = el('div', 'race-rank');
    this.pos = el('b', '', '1');
    this.posTotal = el('span', '', '/6');
    rank.append(this.pos, this.posTotal);
    this.lap = el('div', 'race-lap', '第 1 / 2 圈');
    const left = el('div', 'race-left');
    left.append(rank, this.lap);
    this.board = el('ol', 'race-board');
    left.appendChild(this.board);
    this.root.appendChild(left);

    const clock = el('div', 'race-clock');
    this.time = el('b', '', '0:00.00');
    const row1 = el('div');
    row1.append(el('label', '', '本圈'));
    this.lapTime = el('span', '', '0:00.00');
    row1.appendChild(this.lapTime);
    const row2 = el('div');
    row2.append(el('label', '', '最快'));
    this.best = el('span', '', '--:--.--');
    row2.appendChild(this.best);
    clock.append(this.time, row1, row2);
    this.root.appendChild(clock);

    // 名牌垫在最下面：倒计时的大字、横幅都压在它上面
    this.tagLayer = el('div', 'race-tags');
    this.root.appendChild(this.tagLayer);

    this.big = el('div', 'race-big');
    this.banner = el('div', 'race-banner');
    this.note = el('div', 'race-note');
    this.warn = el('div', 'race-warn');
    this.root.append(this.big, this.banner, this.note, this.warn);

    this.map = new MiniMap(track);
    this.root.appendChild(this.map.root);

    parent.appendChild(this.root);
  }

  show(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    if (!visible) {
      this.big.classList.remove('show');
      this.banner.classList.remove('show');
      this.note.classList.remove('show');
      this.warn.classList.remove('show');
    }
  }

  /** 屏幕正中的大字：倒数的 3、2、1 和"出发" */
  count(text: string, go = false): void {
    this.big.textContent = text;
    this.big.classList.toggle('go', go);
    // 重新触发弹出动画
    this.big.classList.remove('show');
    void this.big.offsetWidth;
    this.big.classList.add('show');
    this.bigTimer = go ? 1.1 : 0.95;
  }

  /** 横幅：最后一圈、完赛 */
  announce(text: string, seconds = 2.4, kind: 'normal' | 'finish' = 'normal'): void {
    this.banner.textContent = text;
    this.banner.classList.toggle('finish', kind === 'finish');
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    this.bannerTimer = seconds;
  }

  /** 小字提示：检查点、圈速 */
  tell(text: string, seconds = 2): void {
    this.note.textContent = text;
    this.note.classList.add('show');
    this.noteTimer = seconds;
  }

  /** 持续的警告（逆行、偏离赛道）。传空字符串收起 */
  warning(text: string): void {
    if (text) this.warn.textContent = text;
    this.warn.classList.toggle('show', !!text);
  }

  /**
   * @param nextGate 玩家下一道要过的门（小地图上标出来）
   * @param pose 玩家的车此刻的位置和朝向
   */
  update(dt: number, d: RaceDirector, tags: RivalTag[], nextGate: Gate | null, pose: MapPose): void {
    const player = d.player;
    if (!player) return;

    if (player.position !== this.lastPos) {
      this.lastPos = player.position;
      this.pos.textContent = String(player.position);
      this.pos.classList.remove('pop');
      void this.pos.offsetWidth;
      this.pos.classList.add('pop');
    }
    this.posTotal.textContent = `/${d.racers.length}`;
    const lapText = `第 ${Math.min(player.lap + 1, d.laps)} / ${d.laps} 圈`;
    if (lapText !== this.lastLap) {
      this.lastLap = lapText;
      this.lap.textContent = lapText;
    }
    const t = player.finished ? player.finishTime : d.time;
    this.time.textContent = formatTime(t);
    this.lapTime.textContent = formatTime(player.finished ? player.lapTimes[player.lapTimes.length - 1] : d.time - player.lapStart);
    this.best.textContent = formatTime(player.best);

    // 排行榜：名次有变化才重排
    const key = d.order.map((r) => `${r.id}${r.finished ? 'f' : ''}`).join(',');
    if (key !== this.boardKey) {
      this.boardKey = key;
      this.board.textContent = '';
      for (const r of d.order) {
        const li = el('li', r.isPlayer ? 'me' : '');
        const chip = el('i');
        chip.style.background = r.color;
        li.append(el('em', '', String(r.position)), chip, el('span', '', r.name));
        if (r.finished) li.appendChild(el('small', '', '完赛'));
        this.board.appendChild(li);
      }
    }

    if (this.bigTimer > 0 && (this.bigTimer -= dt) <= 0) this.big.classList.remove('show');
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) this.banner.classList.remove('show');
    if (this.noteTimer > 0 && (this.noteTimer -= dt) <= 0) this.note.classList.remove('show');

    this.drawTags(tags);
    this.drawMap(dt, d, nextGate, pose);
  }

  private drawTags(tags: RivalTag[]): void {
    while (this.tagNodes.length < tags.length) {
      const n = el('div', 'race-tag');
      n.append(el('em'), el('span'));
      this.tagLayer.appendChild(n);
      this.tagNodes.push(n);
    }
    const { width: w, height: h } = appSize();
    this.tagNodes.forEach((n, i) => {
      const t = tags[i];
      // 左上角是名次和排行榜，名牌不往那儿画
      if (!t || !t.visible || (t.x < 0.17 && t.y < 0.52)) {
        n.style.display = 'none';
        return;
      }
      n.style.display = '';
      // 越远越小、越淡
      const scale = Math.max(0.55, Math.min(1, 16 / t.distance + 0.45));
      n.style.transform = `translate(${(t.x * w).toFixed(1)}px, ${(t.y * h).toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(2)})`;
      n.style.opacity = String(Math.max(0.35, Math.min(1, 1.25 - t.distance / 110)));
      (n.firstChild as HTMLElement).textContent = String(t.racer.position);
      (n.firstChild as HTMLElement).style.background = t.racer.color;
      (n.lastChild as HTMLElement).textContent = t.racer.name;
    });
  }

  private drawMap(dt: number, d: RaceDirector, nextGate: Gate | null, pose: MapPose): void {
    const S = d.track.samples;
    let k = 0;
    for (const r of d.racers) {
      if (r.isPlayer) continue;
      const s = S[r.progress.index];
      const dot = (this.dots[k] ??= { x: 0, z: 0, color: '' });
      dot.x = s.pos.x + s.left.x * r.progress.lateral;
      dot.z = s.pos.z + s.left.z * r.progress.lateral;
      dot.color = r.color;
      k++;
    }
    this.dots.length = k;
    const player = d.player;
    const gate = nextGate ? { x: nextGate.sample.pos.x, z: nextGate.sample.pos.z, finish: nextGate.finish } : null;
    this.map.update(dt, pose.x, pose.z, pose.carYaw, pose.velYaw, pose.speed, player ? player.progress.s : 0, player ? player.progress.index : 0, this.dots, gate);
  }
}
