import type { CityTrack } from '../city/cityLayout.ts';

/** 小地图在屏幕上的边长（像素） */
const SIZE = 236;
/** 前方要走的路线标亮多少米 */
const AHEAD = 520;
/**
 * 透视：小地图是从车的后上方斜着往前看的一块地面，近处的路宽、远处的路窄，
 * 前面几百米的弯一眼就能看出往哪拐、有多急。
 * 镜头在车后 BACK 米、离地 HEIGHT 米，往下俯 PITCH 弧度；FOCAL 决定整体大小。
 */
const HEIGHT = 127;
const BACK = 33;
const PITCH = 0.96;
const FOCAL = 185;
/** 自己的车画在离上沿多远的地方（0–1）：靠下，前方留出更多路 */
const ANCHOR = 0.84;
/** 比这更近（离镜头的纵深，米）的东西不画：已经在镜头脚底下或者身后了 */
const NEAR = 40;
/** 路线带子的半宽（米）。比真实的路宽，小地图上才看得清 */
const BAND = 10.5;

/** 地图上的一个点（对手的车） */
export interface MapDot {
  x: number;
  z: number;
  color: string;
}

/** 赛道上的一个弯：从第几米到第几米，一共转过多少度（正 = 左弯） */
interface Turn {
  start: number;
  end: number;
  angle: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const angleDiff = (a: number, b: number) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** 三种弯的箭头（都画成左弯，右弯在样式里镜像） */
const ARROWS = {
  // 直角弯
  sharp: 'M30 44 V24 Q30 16 22 16 H14 M20 9 L12 16 L20 23',
  // 回头弯
  hairpin: 'M32 44 V20 Q32 9 22 9 Q12 9 12 20 V30 M6 24 L12 31 L18 24',
  // 缓弯
  gentle: 'M30 44 V30 Q30 18 17 12 M24 8 L15 11 L20 20',
};

/**
 * 实时小地图：只画赛道路线。以自己的车为准、行进方向朝上，带透视地看前面几百米——
 * 路线是一条有宽度的带子，近宽远窄；前方要走的一段是亮的，赛道的其余部分是淡的。
 * 对手是带颜色的点，自己是一个箭头；旁边另有一块提示下一个弯往哪拐、还有多远。
 */
export class MiniMap {
  readonly root: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly hint: HTMLElement;
  private readonly hintArrow: SVGPathElement;
  private readonly hintDist: HTMLElement;
  private readonly track: CityTrack;
  private readonly turns: Turn[] = [];
  private readonly dpr: number;
  private heading = 0;
  /** 镜头拉远的倍数：开得越快看得越远 */
  private zoom = 1;
  private hintKey = '';
  private started = false;

  constructor(track: CityTrack) {
    this.track = track;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.root = el('div', 'race-mapbox');

    this.hint = el('div', 'race-turn');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 44 48');
    this.hintArrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(this.hintArrow);
    this.hintDist = el('b');
    this.hint.append(svg, this.hintDist, el('span', '', '米'));

    this.canvas = el('canvas', 'race-map');
    this.canvas.width = this.canvas.height = SIZE * this.dpr;
    this.root.append(this.hint, this.canvas);

    this.findTurns();
  }

  /** 把赛道上的弯找出来：曲率连续不为零的一段算一个弯 */
  private findTurns(): void {
    const S = this.track.samples;
    const n = S.length;
    const step = this.track.length / n;
    const bent = (i: number) => Math.abs(S[(i + n) % n].curvature) > 0.004;
    // 从一段直路开始扫，免得把跨过起点的弯切成两半
    let first = 0;
    while (first < n && bent(first)) first++;
    let i = 0;
    while (i < n) {
      const k = first + i;
      if (!bent(k)) {
        i++;
        continue;
      }
      let angle = 0;
      const from = i;
      while (i < n && bent(first + i)) {
        angle += S[(first + i) % n].curvature * step;
        i++;
      }
      if (Math.abs(angle) > 0.3) {
        this.turns.push({ start: S[(first + from) % n].s, end: S[(first + i - 1) % n].s, angle });
      }
    }
  }

  /** 下一个弯：还有多远（刚进弯是 0）、转多少度、弯有多急（半径，米） */
  private nextTurn(s: number): { distance: number; angle: number; radius: number } | null {
    const len = this.track.length;
    let best: { distance: number; angle: number; radius: number } | null = null;
    for (const t of this.turns) {
      const span = (((t.end - t.start) % len) + len) % len;
      // 这个弯的入口在前方多远；负数 = 已经进弯这么远了
      let toStart = (((t.start - s) % len) + len) % len;
      if (toStart > len - span) toStart -= len;
      // 进弯一小段之后就不再提示它，改看下一个
      if (toStart < -Math.min(26, span * 0.5)) continue;
      const distance = Math.max(0, toStart);
      if (!best || distance < best.distance) best = { distance, angle: t.angle, radius: span / Math.abs(t.angle) };
    }
    return best;
  }

  /**
   * @param x,z 自己的车的位置
   * @param carYaw 车头朝向；velYaw 行进方向（车速很低时传车头朝向）
   * @param s 这一圈跑到第几米；index 最近的赛道采样点
   * @param gate 下一道门的位置（没有传 null）
   */
  update(
    dt: number,
    x: number,
    z: number,
    carYaw: number,
    velYaw: number,
    speed: number,
    s: number,
    index: number,
    dots: MapDot[],
    gate: { x: number; z: number; finish: boolean } | null,
  ): void {
    // 地图跟着行进方向转，转得柔一点；漂移时车头和行进方向不一样，箭头会斜过来
    if (!this.started) {
      this.heading = velYaw;
      this.started = true;
    }
    this.heading += angleDiff(velYaw, this.heading) * (1 - Math.exp(-dt * 5));
    // 开得越快看得越远
    const want = 1 + 0.3 * Math.min(1, speed / 65);
    this.zoom += (want - this.zoom) * (1 - Math.exp(-dt * 1.5));

    const g = this.canvas.getContext('2d')!;
    const dpr = this.dpr;
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    const zoom = this.zoom;
    const sp = Math.sin(PITCH);
    const cp = Math.cos(PITCH);
    const H = HEIGHT * zoom;
    const B = BACK * zoom;
    // 自己的车（地面上的原点）落在画面上的哪一行：据此定出镜头光轴对应的那一行
    const depth0 = H * sp + B * cp;
    const cy = SIZE * ANCHOR + (FOCAL * (-H * cp + B * sp)) / depth0;
    const cx = SIZE / 2;
    /**
     * 世界坐标 → 小地图像素。返回 [x, y, 每米多少像素]；在镜头身后或者太近的返回 null
     */
    const P = (wx: number, wz: number): [number, number, number] | null => {
      const dx = wx - x;
      const dz = wz - z;
      // 以行进方向为"前"：side 往右为正，fwd 往前为正
      const side = -(dx * cos - dz * sin);
      const fwd = dx * sin + dz * cos + B;
      const depth = H * sp + fwd * cp;
      if (depth < NEAR) return null;
      const up = -H * cp + fwd * sp;
      const k = FOCAL / depth;
      return [cx + side * k, cy - up * k, k];
    };

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, SIZE, SIZE);

    /* ---- 赛道：一条有宽度的带子 ---- */
    const S = this.track.samples;
    const n = S.length;
    const step = this.track.length / n;
    const half = BAND;
    /** 把赛道上从 from 起的 count 个采样点画成带子（看不见的部分断开） */
    const band = (from: number, count: number, every: number, style: string) => {
      g.fillStyle = style;
      let left: [number, number][] = [];
      let right: [number, number][] = [];
      const flush = () => {
        if (left.length > 1) {
          g.beginPath();
          g.moveTo(left[0][0], left[0][1]);
          for (let i = 1; i < left.length; i++) g.lineTo(left[i][0], left[i][1]);
          for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
          g.closePath();
          g.fill();
        }
        left = [];
        right = [];
      };
      for (let i = 0; i <= count; i += every) {
        const a = S[(from + i + n) % n];
        const l = P(a.pos.x + a.left.x * half, a.pos.z + a.left.z * half);
        const r = P(a.pos.x - a.left.x * half, a.pos.z - a.left.z * half);
        // 出了画面很远的也断开，免得带子拉成一大片
        if (!l || !r || l[1] < -60 || l[1] > SIZE + 60 || l[0] < -160 || l[0] > SIZE + 160) {
          flush();
          continue;
        }
        left.push([l[0], l[1]]);
        right.push([r[0], r[1]]);
      }
      flush();
    };
    // 整圈：淡的一条
    band(0, n, 2, 'rgba(255, 255, 255, 0.2)');
    // 前方要走的一段：亮的
    const ahead = Math.round(AHEAD / step);
    band(index - 2, ahead, 1, 'rgba(255, 255, 255, 0.82)');

    // 起终点线
    {
      const a = S[0];
      const l = P(a.pos.x + a.left.x * half, a.pos.z + a.left.z * half);
      const r = P(a.pos.x - a.left.x * half, a.pos.z - a.left.z * half);
      if (l && r) {
        g.beginPath();
        g.moveTo(l[0], l[1]);
        g.lineTo(r[0], r[1]);
        g.strokeStyle = '#ff3b2f';
        g.lineWidth = Math.max(2, 5 * l[2]);
        g.stroke();
      }
    }
    // 下一道门：路线上的一道横线
    if (gate && !gate.finish) {
      const p = P(gate.x, gate.z);
      if (p && p[1] > 0 && p[1] < SIZE) {
        g.beginPath();
        g.arc(p[0], p[1], Math.max(3, 5 * p[2]), 0, Math.PI * 2);
        g.strokeStyle = '#ffb224';
        g.lineWidth = 2;
        g.stroke();
      }
    }

    /* ---- 对手 ---- */
    for (const d of dots) {
      const p = P(d.x, d.z);
      if (!p) continue;
      const m = 7;
      // 跑出地图范围的贴在边上，知道他在哪个方向
      const out = p[0] < m || p[0] > SIZE - m || p[1] < m || p[1] > SIZE - m;
      const px = Math.min(SIZE - m, Math.max(m, p[0]));
      const py = Math.min(SIZE - m, Math.max(m, p[1]));
      g.beginPath();
      g.arc(px, py, out ? 3 : Math.max(3.4, 3.4 * p[2]), 0, Math.PI * 2);
      g.fillStyle = d.color;
      g.globalAlpha = out ? 0.7 : 1;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 1.4;
      g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      g.stroke();
    }

    /* ---- 自己：一个箭头，朝着车头的方向。画在地面上再投影过来，所以和路线是同一个透视 ---- */
    {
      const fx = Math.sin(carYaw);
      const fz = Math.cos(carYaw);
      // 世界坐标里车头朝前、朝左的方向
      const lx = fz;
      const lz = -fx;
      const pts: [number, number][] = [
        [11, 0],
        [-8, 7.5],
        [-3.5, 0],
        [-8, -7.5],
      ];
      g.beginPath();
      pts.forEach(([f, l], i) => {
        const p = P(x + fx * f + lx * l, z + fz * f + lz * l);
        if (!p) return;
        if (i === 0) g.moveTo(p[0], p[1]);
        else g.lineTo(p[0], p[1]);
      });
      g.closePath();
      g.fillStyle = '#f4f4f2';
      g.fill();
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      g.stroke();
    }

    this.updateHint(s);
  }

  /** 地图上方的转弯提示：往哪边、什么样的弯、还有多远 */
  private updateHint(s: number): void {
    const t = this.nextTurn(s);
    if (!t || t.distance > 330) {
      if (this.hintKey !== '') {
        this.hintKey = '';
        this.hint.classList.remove('show');
      }
      return;
    }
    const deg = (Math.abs(t.angle) * 180) / Math.PI;
    // 半径很大的长弯（湖滨那个半圆）不算回头弯，按缓弯提示
    const kind = t.radius > 60 || deg <= 55 ? 'gentle' : deg > 135 ? 'hairpin' : 'sharp';
    const side = t.angle > 0 ? 'left' : 'right';
    // 距离按 10 米取整，免得数字一直在跳
    const dist = t.distance < 15 ? 0 : Math.round(t.distance / 10) * 10;
    const key = `${kind}${side}${dist}`;
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hint.classList.add('show');
    this.hint.classList.toggle('right', side === 'right');
    this.hint.classList.toggle('now', dist === 0);
    this.hint.classList.toggle('soon', dist > 0 && dist <= 90);
    this.hintArrow.setAttribute('d', ARROWS[kind]);
    this.hintDist.textContent = dist === 0 ? '转弯' : String(dist);
    (this.hint.lastChild as HTMLElement).style.display = dist === 0 ? 'none' : '';
  }
}
