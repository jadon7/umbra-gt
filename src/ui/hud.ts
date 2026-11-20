import type { Vehicle } from '../drive/Vehicle.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const KEY_HELP: [string, string][] = [
  ['W / ↑', '油门'],
  ['S / ↓', '刹车 · 停稳后倒车'],
  ['A D / ← →', '转向'],
  ['空格', '手刹（漂移）'],
  ['Shift', '氮气'],
  ['C', '回头看'],
  ['V', '切换镜头'],
  ['L', '切换时段（白天 / 黄昏 / 夜晚）'],
  ['K', '切换天气（晴 / 雨 / 雾 / 雪）'],
  ['R', '复位（比赛中回到赛道中间）'],
  ['Esc', '暂停 / 菜单'],
  ['M', '静音'],
];

const PAD_HELP: [string, string][] = [
  ['RT', '油门'],
  ['LT', '刹车 · 停稳后倒车'],
  ['左摇杆', '转向'],
  ['X', '手刹（漂移）'],
  ['A', '氮气'],
  ['B', '回头看'],
  ['Y', '切换镜头'],
  ['Start', '暂停 / 菜单'],
  ['Back', '复位'],
];

/**
 * 试驾界面：车速、挡位、转速、氮气、漂移角度、按键提示、遥测。自由驾驶和比赛都用它；
 * 比赛专有的部分（名次、圈数、计时、小地图）在 raceHud.ts。
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly rpmFill: HTMLElement;
  private readonly nitroFill: HTMLElement;
  private readonly nitroBox: HTMLElement;
  private readonly drift: HTMLElement;
  private readonly driftValue: HTMLElement;
  private readonly help: HTMLElement;
  private readonly helpList: HTMLElement;
  private readonly tele: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly label: HTMLElement;
  private toastTimer = 0;
  private lastSpeed = -1;
  private lastGear = '';
  private padHelp = false;
  private teleVisible = false;

  /** @param onMenu 点左上角"菜单"按钮时调用 */
  constructor(parent: HTMLElement, onMenu: () => void, label = '试驾') {
    this.root = el('div', 'hud');
    this.root.style.display = 'none';

    const top = el('div', 'hud-top');
    this.label = el('div', 'brand-tag', label);
    top.appendChild(this.label);
    const exit = el('button', 'hud-exit');
    exit.append('菜单 ');
    exit.appendChild(el('kbd', '', 'Esc'));
    exit.addEventListener('click', onMenu);
    top.appendChild(exit);
    this.root.appendChild(top);

    this.drift = el('div', 'hud-drift');
    this.drift.append('漂移 ');
    this.driftValue = el('b', '', '0°');
    this.drift.appendChild(this.driftValue);
    this.root.appendChild(this.drift);

    const gauge = el('div', 'hud-gauge');
    const row = el('div', 'hud-row');
    this.gear = el('div', 'hud-gear', '1');
    row.appendChild(this.gear);
    const sp = el('div', 'hud-speed');
    this.speed = el('b', '', '0');
    sp.appendChild(this.speed);
    sp.appendChild(el('span', '', 'KM/H'));
    row.appendChild(sp);
    gauge.appendChild(row);

    const rpm = el('div', 'hud-rpm');
    this.rpmFill = el('i');
    rpm.appendChild(this.rpmFill);
    gauge.appendChild(rpm);

    this.nitroBox = el('div', 'hud-nitro');
    this.nitroBox.appendChild(el('label', '', '氮气'));
    const bar = el('div');
    this.nitroFill = el('i');
    bar.appendChild(this.nitroFill);
    this.nitroBox.appendChild(bar);
    gauge.appendChild(this.nitroBox);
    this.root.appendChild(gauge);

    this.help = el('div', 'hud-help');
    this.help.appendChild(el('h3', '', '操作'));
    this.helpList = el('dl');
    this.help.appendChild(this.helpList);
    this.help.appendChild(el('p', '', 'H 隐藏提示 · T 遥测数据 · P 自动驾驶（电影镜头，V 换回）'));
    this.root.appendChild(this.help);
    this.renderHelp();

    this.tele = el('pre', 'hud-tele');
    this.tele.style.display = 'none';
    this.root.appendChild(this.tele);

    this.toast = el('div', 'hud-toast');
    this.root.appendChild(this.toast);

    parent.appendChild(this.root);
  }

  private renderHelp(): void {
    this.helpList.textContent = '';
    for (const [key, what] of this.padHelp ? PAD_HELP : KEY_HELP) {
      this.helpList.appendChild(el('dt', '', key));
      this.helpList.appendChild(el('dd', '', what));
    }
  }

  /** 改左上角的标签（地图名、时段） */
  setLabel(text: string): void {
    this.label.textContent = text;
  }

  show(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** 比赛时：按键提示默认收起，并给小地图让出左下角 */
  setRacing(on: boolean): void {
    this.root.classList.toggle('racing', on);
    this.help.classList.toggle('hidden', on);
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden');
  }

  toggleTelemetry(): void {
    this.teleVisible = !this.teleVisible;
    this.tele.style.display = this.teleVisible ? '' : 'none';
  }

  /** 屏幕中央的短提示（切换镜头、复位等） */
  flash(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    this.toastTimer = 1.2;
  }

  update(dt: number, v: Vehicle, fps: number, gamepad: boolean, cameraName: string): void {
    const kmh = Math.round(Math.abs(v.forwardSpeed) * 3.6);
    if (kmh !== this.lastSpeed) {
      this.speed.textContent = String(kmh);
      this.lastSpeed = kmh;
    }
    const gear = v.gear < 0 ? 'R' : String(v.gear);
    if (gear !== this.lastGear) {
      this.gear.textContent = gear;
      this.lastGear = gear;
    }

    const rpmRatio = Math.min(1, v.rpm / v.cfg.redline);
    this.rpmFill.style.transform = `scaleX(${rpmRatio.toFixed(3)})`;
    this.rpmFill.classList.toggle('hot', rpmRatio > 0.9);

    this.nitroFill.style.transform = `scaleX(${v.nitro.toFixed(3)})`;
    this.nitroBox.classList.toggle('active', v.nitroActive);

    this.drift.classList.toggle('show', v.drifting);
    if (v.drifting) this.driftValue.textContent = `${Math.round(Math.abs(v.sideSlip) * 57.3)}°`;

    if (gamepad !== this.padHelp) {
      this.padHelp = gamepad;
      this.renderHelp();
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }

    if (this.teleVisible) {
      const w = v.wheels;
      const f = (x: number, d = 2) => x.toFixed(d).padStart(6);
      this.tele.textContent =
        `${fps} FPS · ${cameraName}\n` +
        `纵向 ${f(v.longG)} g   横向 ${f(v.lateralG)} g\n` +
        `侧滑角 ${f(v.sideSlip * 57.3, 1)}°  转向 ${f(v.steerAngle * 57.3, 1)}°\n` +
        `转速 ${f(v.rpm, 0)}   接地 ${v.groundedCount}/4${v.drifting ? '  漂移中' : ''}\n` +
        `轮载 ${w.map((x) => (x.load / 1000).toFixed(1)).join(' ')} 千牛\n` +
        `打滑 ${w.map((x) => x.skid.toFixed(2)).join(' ')}`;
    }
  }
}
