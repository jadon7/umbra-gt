import { LEVELS, type RaceLevel } from '../race/roster.ts';
import { isStandalone, isTouch } from '../core/viewport.ts';
import { QUALITIES, QUALITY, type QualityId } from '../core/quality.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** 能选的赛道 */
export const TRACKS = [
  {
    id: 'city',
    name: '霓虹湾环线',
    desc: '城里的街道赛。一圈 2.6 千米、9 个弯：高架下的发车直道、会飞起来的拱桥、下层街道、湖滨长弯。你从最后一位发车。',
  },
  {
    id: 'mountain',
    name: '云岭山道',
    desc: '山里的公路赛。一圈 3.9 千米、12 个弯，落差 70 米：湖边发车，大弯上山，山腰两个发卡弯，山脊上一个会飞起来的坡顶，下山穿隧道、过高架桥，最后一个长弯回到湖边。你从最后一位发车。',
  },
] as const;

export type TrackId = (typeof TRACKS)[number]['id'];

/** 一场比赛的设置（主菜单里选的） */
export interface RaceConfig {
  /** 哪条赛道（自由驾驶也用它） */
  map: TrackId;
  laps: number;
  rivals: number;
  level: RaceLevel;
  time: string;
  weather: string;
}

export const DEFAULT_RACE: RaceConfig = { map: 'city', laps: 2, rivals: 5, level: 'normal', time: 'night', weather: 'rain' };

/** 结算表里的一行 */
export interface ResultRow {
  position: number;
  name: string;
  color: string;
  /** 总用时；还没跑完的写"比赛中" */
  time: string;
  best: string;
  isPlayer: boolean;
}

export type MenuScreen = 'main' | 'race' | 'settings' | 'pause' | 'results';

export interface MenuHooks {
  startRace(cfg: RaceConfig): void;
  freeDrive(): void;
  openGarage(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  getVolume(): number;
  setVolume(v: number): void;
  isMuted(): boolean;
  setMuted(m: boolean): void;
  /** 界面提示音 */
  sound(kind: 'click' | 'hover' | 'back'): void;
  /** 换一档画质（要重新载入页面） */
  setQuality(id: QualityId): void;
  /** 触屏：自动油门开没开 */
  getAutoThrottle(): boolean;
  setAutoThrottle(on: boolean): void;
  /**
   * 自由驾驶时暂停菜单里的三个选项：换时段、换天气、自动驾驶开关。
   * 点了以后执行，返回这一项现在该显示的字；只问不做的话 act 传 false
   */
  driveOption(kind: 'time' | 'weather' | 'autopilot', act: boolean): string;
}

const STORE_KEY = 'umbra.race';

function loadConfig(): RaceConfig {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const cfg = { ...DEFAULT_RACE, ...(JSON.parse(raw) as Partial<RaceConfig>) };
      if (!TRACKS.some((t) => t.id === cfg.map)) cfg.map = DEFAULT_RACE.map;
      return cfg;
    }
  } catch {
    // 读不到就用默认值
  }
  return { ...DEFAULT_RACE };
}

/**
 * 菜单：主菜单、比赛设置、设置、暂停、结算。
 * 都是盖在游戏画面上的一层网页元素；主菜单的背景就是车库里那辆慢慢转的车。
 */
export class Menu {
  /** 当前显示的是哪一页；null = 菜单收起 */
  screen: MenuScreen | null = null;
  readonly config: RaceConfig = loadConfig();

  private readonly root: HTMLElement;
  private readonly pages = new Map<MenuScreen, HTMLElement>();
  private readonly hooks: MenuHooks;
  /** 设置页是从哪一页进来的（返回时回去） */
  private settingsFrom: MenuScreen = 'main';
  private pauseTitle!: HTMLElement;
  private pauseRestart!: HTMLButtonElement;
  /** 暂停页上只在自由驾驶时出现的那一排（时段、天气、自动驾驶） */
  private pauseOptions!: HTMLElement;
  private pauseOptionNodes: { kind: 'time' | 'weather' | 'autopilot'; node: HTMLElement }[] = [];
  private resultTitle!: HTMLElement;
  private resultSub!: HTMLElement;
  private resultBody!: HTMLElement;
  /** 跟着所选赛道变的字：主菜单上的那一项、比赛设置页的标题和说明、赛道的选项 */
  private trackLabel!: HTMLElement;
  private raceTitle!: HTMLElement;
  private raceDesc!: HTMLElement;
  private trackChips: HTMLElement[] = [];
  private volumeInputs: HTMLInputElement[] = [];
  private muteButtons: HTMLButtonElement[] = [];

  constructor(parent: HTMLElement, hooks: MenuHooks) {
    this.hooks = hooks;
    this.root = el('div', 'menu');
    this.root.style.display = 'none';
    this.buildMain();
    this.buildRace();
    this.buildSettings();
    this.buildPause();
    this.buildResults();
    parent.appendChild(this.root);

    // 键盘：上下键在按钮之间移动，Esc 返回
    window.addEventListener('keydown', (e) => {
      if (!this.screen) return;
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        const page = this.pages.get(this.screen);
        if (!page) return;
        const items = [...page.querySelectorAll<HTMLButtonElement>('button.menu-item')].filter((b) => b.offsetParent !== null);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.code === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[i < 0 ? 0 : next].focus();
        this.hooks.sound('hover');
        e.preventDefault();
      } else if (e.code === 'Escape') {
        // 菜单开着的时候 Esc 归菜单管，别再传给游戏（否则刚关掉暂停又被打开）
        e.preventDefault();
        e.stopImmediatePropagation();
        this.back();
      }
    });
  }

  get visible(): boolean {
    return this.screen !== null;
  }

  /** 选一条赛道（地址栏指定赛道时由外面调用；菜单里点选也走这里） */
  setMap(id: string, save = false): void {
    const track = TRACKS.find((t) => t.id === id);
    if (!track) return;
    this.config.map = track.id;
    this.trackLabel.textContent = `赛道 · ${track.name}`;
    this.raceTitle.textContent = track.name;
    this.raceDesc.textContent = track.desc;
    this.trackChips.forEach((n, i) => n.classList.toggle('active', TRACKS[i].id === track.id));
    if (save) this.saveConfig();
  }

  show(screen: MenuScreen | null): void {
    this.screen = screen;
    this.root.style.display = screen ? '' : 'none';
    this.root.dataset.screen = screen ?? '';
    for (const [id, page] of this.pages) page.style.display = id === screen ? '' : 'none';
    if (screen) {
      this.syncVolume();
      // 把焦点放到这一页的第一个按钮上，回车就能选
      const first = this.pages.get(screen)?.querySelector<HTMLButtonElement>('button.menu-item');
      first?.focus({ preventScroll: true });
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  /** Esc 或"返回"按钮：回上一页 */
  private back(): void {
    this.hooks.sound('back');
    switch (this.screen) {
      case 'race':
        this.show('main');
        break;
      case 'settings':
        this.show(this.settingsFrom);
        break;
      case 'pause':
        this.hooks.resume();
        break;
      default:
        break;
    }
  }

  private page(id: MenuScreen, className = ''): HTMLElement {
    const p = el('section', `menu-page ${className}`);
    p.style.display = 'none';
    this.pages.set(id, p);
    this.root.appendChild(p);
    return p;
  }

  private item(text: string, hint: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = el('button', `menu-item${primary ? ' primary' : ''}`);
    b.appendChild(el('span', '', text));
    if (hint) b.appendChild(el('small', '', hint));
    b.addEventListener('mouseenter', () => this.hooks.sound('hover'));
    b.addEventListener('click', () => {
      this.hooks.sound('click');
      onClick();
    });
    return b;
  }

  private title(small: string, big: string): HTMLElement {
    const h = el('header', 'menu-title');
    h.appendChild(el('div', 'brand-tag', small));
    h.appendChild(el('h2', '', big));
    return h;
  }

  /* ------------------------------ 主菜单 ------------------------------ */

  private buildMain(): void {
    const p = this.page('main', 'menu-main');
    const brand = el('header', 'menu-brand');
    brand.appendChild(el('div', 'brand-tag', '霓虹湾 · 云岭 · 街头赛'));
    const h1 = el('h1');
    h1.append('UMBRA ');
    h1.appendChild(el('em', '', 'GT'));
    brand.appendChild(h1);
    p.appendChild(brand);
    const list = el('nav', 'menu-list');
    list.appendChild(this.item('开始比赛', '和对手跑一场', () => this.show('race'), true));
    list.appendChild(this.item('自由驾驶', '一个人随便开，不计时', () => this.hooks.freeDrive()));
    // 换赛道：比赛和自由驾驶都在选中的这一条上
    const track = this.item('赛道', '点一下换一条', () => {
      const i = TRACKS.findIndex((t) => t.id === this.config.map);
      this.setMap(TRACKS[(i + 1) % TRACKS.length].id, true);
    });
    this.trackLabel = track.querySelector('span')!;
    list.appendChild(track);
    list.appendChild(this.item('车库', '换车漆、轮毂、尾翼', () => this.hooks.openGarage()));
    list.appendChild(
      this.item('设置', '音量、操作说明', () => {
        this.settingsFrom = 'main';
        this.show('settings');
      }),
    );
    p.appendChild(list);
    p.appendChild(el('div', 'menu-foot', '↑ ↓ 选择 · 回车 确认'));
    // 手机上还没装成应用的时候：提醒可以装到主屏幕（装了以后是全屏的，断网也能开）
    if (isTouch && !isStandalone) p.appendChild(el('div', 'menu-install', '在浏览器菜单里选「添加到主屏幕」，装成应用后全屏游玩'));
    // 素材署名：整车模型用的是 CC BY 4.0 授权的素材，公开发布时要带着署名
    const credit = el('div', 'menu-credit');
    const model = el('a', '', 'Car Concept');
    model.href = 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept';
    const license = el('a', '', 'CC BY 4.0');
    license.href = 'https://creativecommons.org/licenses/by/4.0/';
    for (const a of [model, license]) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    credit.append('车辆模型基于 Khronos glTF Sample Assets 的 ', model, '（Eric Chadwick，© 2024 Darmstadt Graphics Group GmbH，', license, '），有修改');
    p.appendChild(credit);
  }

  /* ------------------------------ 比赛设置 ------------------------------ */

  private choice<T>(parent: HTMLElement, label: string, options: { name: string; value: T }[], get: () => T, set: (v: T) => void): void {
    const row = el('div', 'menu-row');
    row.appendChild(el('label', '', label));
    const group = el('div', 'chips');
    const nodes = options.map((o) => {
      const b = el('button', 'chip', o.name);
      b.classList.toggle('active', o.value === get());
      b.addEventListener('click', () => {
        this.hooks.sound('click');
        set(o.value);
        nodes.forEach((n, i) => n.classList.toggle('active', options[i].value === o.value));
        this.saveConfig();
      });
      group.appendChild(b);
      return b;
    });
    row.appendChild(group);
    parent.appendChild(row);
  }

  private saveConfig(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.config));
    } catch {
      // 存不了就算了
    }
  }

  private buildRace(): void {
    const p = this.page('race', 'menu-panel');
    const title = this.title('比赛设置', '');
    this.raceTitle = title.querySelector('h2')!;
    p.appendChild(title);
    this.raceDesc = el('p', 'menu-desc');
    p.appendChild(this.raceDesc);
    const c = this.config;
    {
      const row = el('div', 'menu-row');
      row.appendChild(el('label', '', '赛道'));
      const group = el('div', 'chips');
      for (const t of TRACKS) {
        const b = el('button', 'chip', t.name);
        b.addEventListener('click', () => {
          this.hooks.sound('click');
          this.setMap(t.id, true);
        });
        group.appendChild(b);
        this.trackChips.push(b);
      }
      row.appendChild(group);
      p.appendChild(row);
    }
    this.choice(
      p,
      '圈数',
      [1, 2, 3, 5].map((n) => ({ name: `${n} 圈`, value: n })),
      () => c.laps,
      (v) => (c.laps = v),
    );
    this.choice(
      p,
      '对手',
      [1, 3, 5, 7].map((n) => ({ name: `${n} 个`, value: n })),
      () => c.rivals,
      (v) => (c.rivals = v),
    );
    this.choice(
      p,
      '难度',
      LEVELS.map((l) => ({ name: l.name, value: l.id })),
      () => c.level,
      (v) => (c.level = v),
    );
    this.choice(
      p,
      '时段',
      [
        { name: '白天', value: 'day' },
        { name: '黄昏', value: 'dusk' },
        { name: '夜晚', value: 'night' },
      ],
      () => c.time,
      (v) => (c.time = v),
    );
    this.choice(
      p,
      '天气',
      [
        { name: '晴', value: 'clear' },
        { name: '雨', value: 'rain' },
        { name: '雾', value: 'fog' },
        { name: '雪', value: 'snow' },
      ],
      () => c.weather,
      (v) => (c.weather = v),
    );
    const actions = el('div', 'menu-actions');
    actions.appendChild(this.item('出发 ▶', '', () => this.hooks.startRace({ ...c }), true));
    actions.appendChild(this.item('返回', '', () => this.show('main')));
    p.appendChild(actions);
    this.setMap(c.map);
  }

  /* ------------------------------ 设置（音量） ------------------------------ */

  private volumeRow(parent: HTMLElement): void {
    const row = el('div', 'menu-row');
    row.appendChild(el('label', '', '音量'));
    const wrap = el('div', 'menu-volume');
    const input = el('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.addEventListener('input', () => {
      this.hooks.setVolume(Number(input.value) / 100);
      this.syncVolume();
    });
    input.addEventListener('change', () => this.hooks.sound('click'));
    const mute = el('button', 'chip', '静音');
    mute.addEventListener('click', () => {
      this.hooks.setMuted(!this.hooks.isMuted());
      this.hooks.sound('click');
      this.syncVolume();
    });
    wrap.append(input, mute);
    row.appendChild(wrap);
    parent.appendChild(row);
    this.volumeInputs.push(input);
    this.muteButtons.push(mute);
  }

  private syncVolume(): void {
    const v = Math.round(this.hooks.getVolume() * 100);
    for (const i of this.volumeInputs) {
      if (document.activeElement !== i) i.value = String(v);
      i.style.setProperty('--fill', `${v}%`);
    }
    for (const b of this.muteButtons) b.classList.toggle('active', this.hooks.isMuted());
  }

  private buildSettings(): void {
    const p = this.page('settings', 'menu-panel');
    p.appendChild(this.title('设置', '声音、画质与操作'));
    this.volumeRow(p);
    // 画质：换一档要重新载入页面（阴影、雨雪的数量都是建场景的时候定的）
    this.choice(
      p,
      '画质',
      (Object.keys(QUALITIES) as QualityId[]).map((id) => ({ name: QUALITIES[id].name, value: id })),
      () => QUALITY.id,
      (v) => {
        if (v !== QUALITY.id) this.hooks.setQuality(v);
      },
    );
    if (isTouch) {
      this.choice(
        p,
        '油门',
        [
          { name: '自动', value: true },
          { name: '手动', value: false },
        ],
        () => this.hooks.getAutoThrottle(),
        (v) => this.hooks.setAutoThrottle(v),
      );
    }
    const keys = el('dl', 'menu-keys');
    const rows: [string, string][] = isTouch
      ? [
          ['◀ ▶', '左手：转向'],
          ['刹车', '右手：刹车 · 停稳后按住是倒车'],
          ['漂移', '带着方向按一下，把车甩起来'],
          ['氮气', '直道上按住'],
          ['油门', '默认是自动的；改成手动后右下角多一个油门键'],
          ['右上角', '暂停、换镜头、复位'],
        ]
      : [
          ['W / ↑', '油门'],
          ['S / ↓', '刹车 · 停稳后倒车'],
          ['A D / ← →', '转向'],
          ['空格', '手刹（漂移）'],
          ['Shift', '氮气'],
          ['V', '切换镜头'],
          ['C', '回头看'],
          ['R', '复位（比赛中回到赛道中间）'],
          ['Esc', '暂停'],
          ['M', '静音'],
        ];
    for (const [k, v] of rows) {
      keys.appendChild(el('dt', '', k));
      keys.appendChild(el('dd', '', v));
    }
    p.appendChild(keys);
    if (!isTouch) p.appendChild(el('p', 'menu-desc', '手柄：RT 油门，LT 刹车，左摇杆转向，X 手刹，A 氮气，Y 切镜头，Start 暂停，Back 复位。'));
    const actions = el('div', 'menu-actions');
    actions.appendChild(this.item('返回', '', () => this.show(this.settingsFrom), true));
    p.appendChild(actions);
  }

  /* ------------------------------ 暂停 ------------------------------ */

  private buildPause(): void {
    const p = this.page('pause', 'menu-panel menu-narrow');
    const t = this.title('暂停', '比赛暂停');
    this.pauseTitle = t.querySelector('h2')!;
    p.appendChild(t);
    const list = el('nav', 'menu-list');
    list.appendChild(this.item('继续', isTouch ? '' : 'Esc', () => this.hooks.resume(), true));
    this.pauseRestart = this.item('重新开始', '', () => this.hooks.restart());
    list.appendChild(this.pauseRestart);
    // 自由驾驶时：换时段、换天气、自动驾驶（键盘上是 L、K、P；手机上没有键盘，只能在这里点）
    this.pauseOptions = el('div', 'chips');
    this.pauseOptions.style.margin = '12px 0 2px';
    for (const kind of ['time', 'weather', 'autopilot'] as const) {
      const b = el('button', 'chip');
      b.addEventListener('click', () => {
        this.hooks.sound('click');
        b.textContent = this.hooks.driveOption(kind, true);
      });
      this.pauseOptions.appendChild(b);
      this.pauseOptionNodes.push({ kind, node: b });
    }
    list.appendChild(
      this.item('设置', '', () => {
        this.settingsFrom = 'pause';
        this.show('settings');
      }),
    );
    list.appendChild(this.item('回主菜单', '', () => this.hooks.quit()));
    p.appendChild(list);
    p.appendChild(this.pauseOptions);
  }

  /** 打开暂停页。比赛中和自由驾驶时的字样不一样 */
  showPause(racing: boolean): void {
    this.pauseTitle.textContent = racing ? '比赛暂停' : '自由驾驶';
    this.pauseRestart.querySelector('span')!.textContent = racing ? '重新开始' : '回到起点';
    // 比赛中只留「自动驾驶」一项（时段和天气是开赛前定的）
    for (const o of this.pauseOptionNodes) {
      o.node.style.display = racing && o.kind !== 'autopilot' ? 'none' : '';
      o.node.textContent = this.hooks.driveOption(o.kind, false);
    }
    this.show('pause');
  }

  /* ------------------------------ 结算 ------------------------------ */

  private buildResults(): void {
    const p = this.page('results', 'menu-panel menu-results');
    const t = this.title('完赛', '第 1 名');
    this.resultTitle = t.querySelector('h2')!;
    p.appendChild(t);
    this.resultSub = el('p', 'menu-desc');
    p.appendChild(this.resultSub);
    const table = el('table', 'menu-table');
    const head = el('thead');
    const tr = el('tr');
    for (const h of ['名次', '车手', '用时', '最快圈']) tr.appendChild(el('th', '', h));
    head.appendChild(tr);
    table.appendChild(head);
    this.resultBody = el('tbody');
    table.appendChild(this.resultBody);
    p.appendChild(table);
    const actions = el('div', 'menu-actions');
    actions.appendChild(this.item('再来一局', '', () => this.hooks.restart(), true));
    actions.appendChild(this.item('回主菜单', '', () => this.hooks.quit()));
    p.appendChild(actions);
  }

  /** 填结算表（对手陆续冲线时会反复调用） */
  setResults(position: number, total: number, summary: string, rows: ResultRow[]): void {
    this.resultTitle.textContent = `第 ${position} 名`;
    this.resultTitle.classList.toggle('win', position === 1);
    this.resultSub.textContent = `${summary} · 共 ${total} 辆车`;
    this.resultBody.textContent = '';
    for (const r of rows) {
      const tr = el('tr', r.isPlayer ? 'me' : '');
      const name = el('td');
      const chip = el('i');
      chip.style.background = r.color;
      name.append(chip, r.name);
      tr.append(el('td', '', String(r.position)), name, el('td', '', r.time), el('td', '', r.best));
      this.resultBody.appendChild(tr);
    }
  }
}
