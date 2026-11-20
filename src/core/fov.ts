/**
 * 按画面比例修正纵向视野角。
 * 机位都是按 16:9 调的；窗口比 16:9 窄时（竖屏、接近方形的预览窗）如果纵向视野不变，
 * 横向视野会被压窄，车会顶满画面。这里在窄画面下加大纵向视野，保持横向能看到的范围。
 */
export function fitFov(baseDeg: number, aspect: number): number {
  const k = Math.min(Math.max(16 / 9 / aspect, 1), 1.7);
  return (2 * Math.atan(Math.tan((baseDeg * Math.PI) / 360) * k) * 180) / Math.PI;
}
