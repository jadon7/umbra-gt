import type { Engine } from './Engine';
import { appSize } from './viewport.ts';

/**
 * 开发用：把游戏画面和盖在上面的网页界面（比赛界面、菜单）合成一张原尺寸截图。
 *
 * 画面是 WebGPU 画的，界面是普通网页元素，浏览器没有现成的办法把两者一起按原尺寸存下来。
 * 这里把界面那几层克隆一份、把计算后的样式逐个写进去，包进 SVG 里当图片画到画布上，再叠到画面上。
 * 和真实显示的差别：背景模糊（backdrop-filter）用"把整张画面模糊一下"代替；伪元素不会画出来。
 */
export async function captureWithUi(engine: Engine): Promise<Blob> {
  const frame = await createImageBitmap(await engine.capture());
  const { width: W, height: H } = appSize();
  const scale = frame.width / W;

  const holder = document.createElement('div');
  holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  holder.style.cssText = `position:relative;width:${W}px;height:${H}px;overflow:hidden;margin:0;font-family:'PingFang SC','Helvetica Neue',Arial,sans-serif;color:#f1f1ee;`;

  const copy = (src: Element, dst: Element): void => {
    const cs = getComputedStyle(src);
    if (cs.display === 'none') {
      dst.remove();
      return;
    }
    let text = '';
    for (let i = 0; i < cs.length; i++) {
      const k = cs[i];
      // 动画和过渡不带过去：计算后的样式已经是这一刻的样子，带过去反而会从头播
      if (k.startsWith('animation') || k.startsWith('transition') || k.includes('backdrop-filter')) continue;
      text += `${k}:${cs.getPropertyValue(k)};`;
    }
    dst.setAttribute('style', `${text}animation:none;transition:none;`);
    if (cs.position === 'fixed') (dst as HTMLElement).style.position = 'absolute';
    // 可滚动的面板在图里不要画出滚动条
    if (cs.overflowX === 'auto' || cs.overflowY === 'auto') (dst as HTMLElement).style.overflow = 'hidden';
    if (src instanceof HTMLCanvasElement) {
      // 画布（小地图）克隆出来是空的，换成一张图
      const img = document.createElement('img');
      img.setAttribute('style', dst.getAttribute('style') ?? '');
      img.src = src.toDataURL();
      dst.replaceWith(img);
      return;
    }
    if (src instanceof HTMLInputElement) dst.setAttribute('value', src.value);
    const a = [...src.children];
    const b = [...dst.children];
    for (let i = 0; i < a.length; i++) copy(a[i], b[i]);
  };

  let blur = false;
  for (const root of [document.getElementById('ui'), document.getElementById('hud'), document.querySelector<HTMLElement>('.menu')]) {
    if (!root || getComputedStyle(root).display === 'none') continue;
    const clone = root.cloneNode(true) as HTMLElement;
    holder.appendChild(clone);
    copy(root, clone);
    // 主菜单以外的菜单页，背后的画面是模糊的
    if (root.classList.contains('menu') && root.dataset.screen !== 'main') blur = true;
  }

  const xml = new XMLSerializer().serializeToString(holder);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xml}</foreignObject></svg>`;
  const overlay = new Image();
  await new Promise<void>((resolve, reject) => {
    overlay.onload = () => resolve();
    overlay.onerror = () => reject(new Error('界面截图失败'));
    overlay.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const g = canvas.getContext('2d')!;
  if (blur) g.filter = `blur(${6 * scale}px)`;
  g.drawImage(frame, 0, 0);
  g.filter = 'none';
  g.drawImage(overlay, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), 'image/png'));
}
