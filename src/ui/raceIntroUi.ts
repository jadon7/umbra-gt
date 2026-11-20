import type { IntroCaption } from '../race/RaceIntro.ts';
import { isTouch } from '../core/viewport.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * 赛前特写镜头上叠的界面：上下两条电影黑边、赛事标题、车手名牌、「跳过」提示。
 *
 * 进出场的动画全部按镜头的时间在这里逐帧算（不用样式表里的过渡）：
 * 镜头是硬切的，字要跟着同一个时钟走，才不会出现镜头切了、上一块字还在慢慢淡出。
 */
export class IntroOverlay {
  private readonly root: HTMLElement;
  private readonly top: HTMLElement;
  private readonly bottom: HTMLElement;
  private readonly event: HTMLElement;
  private readonly eventTitle: HTMLElement;
  private readonly eventSub: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cardSlot: HTMLElement;
  private readonly cardName: HTMLElement;
  private readonly cardSub: HTMLElement;
  private readonly cardTag: HTMLElement;
  private readonly skip: HTMLElement;
  private readonly note: HTMLElement;
  private key = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'intro');
    this.root.style.display = 'none';
    this.top = el('div', 'intro-bar intro-bar-top');
    this.bottom = el('div', 'intro-bar intro-bar-bottom');

    this.event = el('div', 'intro-event');
    this.event.appendChild(el('span', 'intro-kicker', 'UMBRA STREET SERIES'));
    this.eventTitle = el('b');
    this.eventSub = el('p');
    this.event.append(this.eventTitle, this.eventSub);

    this.card = el('div', 'intro-card');
    this.cardSlot = el('em');
    const text = el('div');
    this.cardTag = el('span', 'intro-kicker');
    this.cardName = el('b');
    this.cardSub = el('p');
    text.append(this.cardTag, this.cardName, this.cardSub);
    this.card.append(this.cardSlot, text);

    this.skip = el('div', 'intro-skip');
    if (isTouch) this.skip.textContent = '点一下屏幕跳过';
    else this.skip.append(el('kbd', '', '空格'), document.createTextNode(' 跳过'));

    // 自动驾驶的电影镜头用的一行小字（和「跳过」在同一个位置）
    this.note = el('div', 'intro-skip');
    this.root.append(this.top, this.bottom, this.event, this.card, this.skip, this.note);
    parent.appendChild(this.root);
  }

  show(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    if (!visible) this.key = '';
  }

  /**
   * 自动驾驶的电影镜头：只要上下两条黑边（比赛前镜头的窄一些），右下角一行小字。
   * @param bars 黑边收放 0–1
   * @param note 小字写什么；noteOpacity 它有多显眼 0–1
   */
  cine(bars: number, note: string, noteOpacity: number): void {
    const h = `${(easeOut(clamp01(bars)) * 8).toFixed(2)}vh`;
    this.top.style.height = h;
    this.bottom.style.height = h;
    this.skip.style.opacity = '0';
    this.event.style.opacity = '0';
    this.card.style.opacity = '0';
    if (this.note.textContent !== note) this.note.textContent = note;
    this.note.style.opacity = String(clamp01(noteOpacity) * 0.8);
  }

  /**
   * @param bars 黑边收放 0–1
   * @param caption 这一刻该显示的字
   */
  update(bars: number, caption: IntroCaption | null): void {
    const h = `${(easeOut(clamp01(bars)) * 11).toFixed(2)}vh`;
    this.top.style.height = h;
    this.bottom.style.height = h;
    this.skip.style.opacity = String(clamp01(bars) * 0.75);
    this.note.style.opacity = '0';

    const isEvent = caption?.kind === 'event';
    const block = isEvent ? this.event : this.card;
    const other = isEvent ? this.card : this.event;
    other.style.opacity = '0';
    if (!caption) {
      this.event.style.opacity = '0';
      this.card.style.opacity = '0';
      return;
    }
    const key = `${caption.kind}:${caption.title}:${caption.sub}`;
    if (key !== this.key) {
      this.key = key;
      if (isEvent) {
        this.eventTitle.textContent = caption.title;
        this.eventSub.textContent = caption.sub;
      } else {
        this.cardSlot.textContent = String(caption.slot);
        this.cardSlot.style.background = caption.color;
        this.cardTag.textContent = caption.kind === 'player' ? '你的车' : `第 ${caption.slot} 发车位`;
        this.cardName.textContent = caption.title;
        this.cardSub.textContent = caption.sub;
        this.card.style.borderLeftColor = caption.color;
      }
    }
    // 进场：从左边滑进来；退场：快速淡掉
    const enter = easeOut(clamp01(caption.age / 0.28));
    const leave = clamp01(caption.left / 0.16);
    block.style.opacity = String(Math.min(enter, leave));
    block.style.transform = `translateX(${((1 - enter) * -46).toFixed(1)}px)`;
  }
}
