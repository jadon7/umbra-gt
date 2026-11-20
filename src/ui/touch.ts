/**
 * 触屏上开车的按钮：左手管方向，右手管刹车、漂移、氮气，右上角一排小的是暂停、换镜头、复位。
 *
 * 默认是自动油门：车自己往前走，不用一直按着油门——两只手一共就两个拇指，再占一个按油门就没法同时漂移和喷氮气了。
 * 想自己控制油门的，在设置里改成手动，右下角会多出一个油门键。
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

export type TouchAction = 'pause' | 'camera' | 'reset';

const ARROW = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';

export class TouchPad {
  readonly root: HTMLElement;
  /** 现在按着哪些键 */
  readonly state = { left: false, right: false, gas: false, brake: false, drift: false, nitro: false };
  /** 自动油门 */
  auto = true;
  /** 进入开车以后有没有碰过任何一个键：碰过了自动油门才开始给油（不然一进游戏车就自己窜出去了） */
  armed = false;

  constructor(parent: HTMLElement, onAction: (a: TouchAction) => void) {
    this.root = el('div', 'touch-pad');
    this.root.style.display = 'none';

    const hold = (className: string, key: keyof TouchPad['state'], label: string, html = false): void => {
      const b = el('button', `tc ${className}`);
      if (html) b.innerHTML = label;
      else b.textContent = label;
      const set = (on: boolean) => {
        this.state[key] = on;
        if (on) this.armed = true;
        b.classList.toggle('down', on);
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        set(true);
        // 手指滑出按钮也算按着，直到松开
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* 抓不住这根手指也没关系：松开的时候照样会收到 pointerup */
        }
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(type, () => set(false));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      this.root.appendChild(b);
    };
    hold('tc-left', 'left', ARROW, true);
    hold('tc-right', 'right', ARROW.replace('M15 5l-7 7 7 7', 'M9 5l7 7-7 7'), true);
    hold('tc-brake', 'brake', '刹车');
    hold('tc-gas', 'gas', '油门');
    hold('tc-drift', 'drift', '漂移');
    hold('tc-nitro', 'nitro', '氮气');

    const tap = (className: string, label: string, action: TouchAction): void => {
      const b = el('button', `tc tc-small ${className}`, label);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.classList.add('down');
      });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) b.addEventListener(type, () => b.classList.remove('down'));
      b.addEventListener('click', () => onAction(action));
      this.root.appendChild(b);
    };
    tap('tc-pause', '暂停', 'pause');
    tap('tc-cam', '镜头', 'camera');
    tap('tc-reset', '复位', 'reset');

    parent.appendChild(this.root);
  }

  setAuto(on: boolean): void {
    this.auto = on;
    this.root.classList.toggle('manual', !on);
  }

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
    if (!on) this.release();
  }

  /** 把所有键都松开（暂停、退出的时候） */
  release(): void {
    for (const k of Object.keys(this.state) as (keyof TouchPad['state'])[]) this.state[k] = false;
    this.armed = false;
    for (const b of this.root.querySelectorAll('.tc.down')) b.classList.remove('down');
  }
}
