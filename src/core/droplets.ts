import { abs, dot, float, floor, fract, length, sin, smoothstep, vec2, vec3 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 一个数 → 三个 0–1 的随机数 */
const hash3 = (p: N): N => {
  const p3: N = fract(vec3(p, p, p).mul(vec3(0.1031, 0.11369, 0.13787)));
  const q: N = p3.add(dot(p3, p3.yzx.add(19.19)));
  return fract(vec3(q.x.add(q.y).mul(q.z), q.x.add(q.z).mul(q.y), q.y.add(q.z).mul(q.x)));
};

/** 从 0 升到 1 再落回 0，b 是峰值的位置 */
const saw = (b: number, t: N): N => smoothstep(0.0, b, t).mul(smoothstep(1.0, b, t));

/** 挂在镜头上不动的小水珠：按格子随机摆放，一批批出现、缩小、消失 */
function staticDrops(uv: N, t: N, scale: number, amount: N): N {
  const st: N = uv.mul(scale);
  const id: N = floor(st);
  const f: N = fract(st).sub(0.5);
  const n: N = hash3(id.x.mul(107.45).add(id.y.mul(3543.654)));
  const p: N = n.xy.sub(0.5).mul(0.6);
  const d: N = length(f.sub(p));
  const life: N = saw(0.04, fract(t.mul(0.11).add(n.z)));
  const size: N = fract(n.z.mul(13.7)).mul(0.22).add(0.1);
  // 雨越大，有水珠的格子越多
  const exists: N = smoothstep(float(1.0).sub(amount.mul(0.2)), float(1.02).sub(amount.mul(0.2)), fract(n.x.mul(7.3).add(n.y)));
  const c: N = smoothstep(size, size.mul(0.35), d).mul(life).mul(exists);
  return vec3(f.sub(p).div(size).mul(c), c);
}

/** 往下滑的大水珠，后面拖一条水痕 */
function slidingDrops(uv: N, t: N, amount: N): N {
  const cols = 9.0;
  const sx: N = uv.x.mul(cols);
  const col: N = floor(sx);
  const n: N = hash3(col.mul(12.7).add(3.1));
  const speed: N = n.y.mul(0.45).add(0.22);
  // 画面坐标 y 向上为正，所以让图案随时间往 y 减小的方向走
  const sy: N = uv.y.mul(2.0).add(t.mul(speed)).add(n.z.mul(7.0));
  const row: N = floor(sy);
  const fy: N = fract(sy);
  const n2: N = hash3(col.mul(41.0).add(row.mul(7.3)));
  const exists: N = smoothstep(float(1.0).sub(amount.mul(0.28)), float(1.02).sub(amount.mul(0.28)), n2.x);
  const x: N = n2.y.sub(0.5).mul(0.5).add(0.5).add(sin(uv.y.mul(18.0).add(n.z.mul(6.0))).mul(0.06));
  const dx: N = fract(sx).sub(x);
  // 一格宽 1/9 屏、高 1/2 屏，把纵向距离折算到和横向同一个单位，水珠才是圆的
  const dy: N = fy.sub(0.3).mul(4.5);
  const head: N = smoothstep(0.2, 0.06, length(vec2(dx, dy)));
  // 水痕在水珠的上方（它滑过来的方向），越往上越淡
  const above: N = fy.sub(0.3);
  const trail: N = smoothstep(0.075, 0.02, abs(dx)).mul(smoothstep(0.0, 0.04, above)).mul(float(1.0).sub(smoothstep(0.0, 0.6, above)));
  const mask: N = head.add(trail.mul(0.35)).mul(exists);
  const off: N = vec2(dx, dy).div(0.2).mul(head).add(vec2(dx.div(0.075), 0.0).mul(trail).mul(0.35)).mul(exists);
  return vec3(off, mask);
}

/**
 * 镜头上的水滴。返回 (折射造成的画面偏移 x, y, 水滴遮罩)。
 * @param uv 画面坐标，已经按宽高比修正（x 乘过宽高比）
 * @param t 时间
 * @param amount 雨量 0–1
 */
export function dropletField(uv: N, t: N, amount: N): N {
  const a: N = staticDrops(uv, t, 26.0, amount);
  const b: N = staticDrops(uv.add(vec2(3.7, 1.3)), t.mul(0.7), 13.0, amount.mul(0.7));
  const c: N = slidingDrops(uv, t, amount);
  return a.add(b).add(c);
}
