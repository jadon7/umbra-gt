/**
 * 屏幕和设备：是不是触屏、界面有多大、要不要把界面转过来。
 *
 * 游戏只有横屏。手机上很多人锁着屏幕方向，网页又没法可靠地要求系统横过来（iPhone 上完全不行），
 * 所以触屏设备竖着拿的时候，这里直接把整个界面（#app）顺时针转九十度：不管系统是什么方向，
 * 把手机横过来看到的都是正的。转过来以后「界面的宽高」和「窗口的宽高」是对调的，
 * 要用界面尺寸的地方（渲染分辨率、名牌的位置）都问 appSize()，不要直接读 window.innerWidth。
 */
const params = new URLSearchParams(location.search);
const forced = params.get('touch');

/** 是不是触屏设备（手机、平板）。地址栏 touch=1 / touch=0 可以强制，调试用 */
export const isTouch = forced === '1' || (forced !== '0' && matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches);

/** 是不是已经装到主屏幕上、从图标打开的（PWA） */
export const isStandalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || (navigator as { standalone?: boolean }).standalone === true;

const app = document.getElementById('app') as HTMLElement;
let width = window.innerWidth;
let height = window.innerHeight;
let rotated = false;
const listeners: (() => void)[] = [];

function layout(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  rotated = isTouch && vh > vw;
  width = rotated ? vh : vw;
  height = rotated ? vw : vh;
  app.style.width = `${width}px`;
  app.style.height = `${height}px`;
  // 顺时针转九十度，再往右挪一个屏幕宽：界面的左上角落在屏幕的右上角
  app.style.transform = rotated ? `translateX(${vw}px) rotate(90deg)` : '';
  document.documentElement.classList.toggle('rotated', rotated);
  // 界面矮（手机横屏）：用紧凑的样式。按界面自己的高度判断，不按窗口的
  document.documentElement.classList.toggle('compact', height <= 560);
  for (const fn of listeners) fn();
}

document.documentElement.classList.toggle('touch', isTouch);
layout();
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => window.setTimeout(layout, 60));
window.visualViewport?.addEventListener('resize', layout);

/** 界面的宽高（像素）。竖着拿、界面被转过来的时候，是窗口的高和宽 */
export function appSize(): { width: number; height: number } {
  return { width, height };
}

/** 界面现在是不是转过来的（设备竖着、界面横着） */
export function isRotated(): boolean {
  return rotated;
}

/** 界面的尺寸或方向变了的时候调用 fn */
export function onLayout(fn: () => void): void {
  listeners.push(fn);
}

/** 把屏幕上的一点（指针事件的 clientX / clientY）换成界面里的坐标 */
export function toApp(clientX: number, clientY: number): { x: number; y: number } {
  return rotated ? { x: clientY, y: window.innerWidth - clientX } : { x: clientX, y: clientY };
}

/**
 * 尽量把浏览器切到全屏并锁成横屏（安卓的浏览器里管用；iPhone 上不支持，就靠上面的转九十度）。
 * 只能在用户点了一下之后调用。失败了不报错
 */
export function goFullscreen(): void {
  if (!isTouch || isStandalone) return;
  const root = document.documentElement as HTMLElement & { requestFullscreen?: (o?: FullscreenOptions) => Promise<void> };
  if (document.fullscreenElement || !root.requestFullscreen) return;
  root
    .requestFullscreen({ navigationUI: 'hide' })
    .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => {});
}

let wakeLock: { release(): Promise<void> } | null = null;

/** 开车的时候不让屏幕自己熄掉（手机上）。on = false 时放开 */
export function keepAwake(on: boolean): void {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
  if (!isTouch || !nav.wakeLock) return;
  if (on && !wakeLock) {
    nav.wakeLock
      .request('screen')
      .then((lock) => (wakeLock = lock))
      .catch(() => {});
  } else if (!on && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
