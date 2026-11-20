import { PAINTS, SECONDARY, type PaintPreset } from '../car/paint';
import { RIMS, CALIPERS, type Car, type ColorOption } from '../car/Car';
import { FX_THEMES, type FxTheme } from '../fx/themes.ts';
import { CAR_BASES, CAR_MODELS, carLength, type CarModel } from '../car/models.ts';
import type { CarLook } from '../car/looks.ts';

export interface ViewDef {
  id: string;
  name: string;
}

export interface UIHooks {
  car: Car;
  views: ViewDef[];
  initialView: string;
  initialAutoRotate: boolean;
  setView(id: string): void;
  setAutoRotate(on: boolean): void;
  setSteer(on: boolean): void;
  getStats(): { fps: number; backend: string };
  startDrive(): void;
  /** 换特效配色 */
  setFxTheme(theme: FxTheme): void;
  /** 换车型（主程序会把这款车自己的那套外观换上） */
  setModel(model: CarModel): void;
  /** 当前这款车的外观（车漆、副色、尾翼、轮毂、卡钳、特效配色） */
  getLook(): CarLook;
  /** 玩家改了其中几项：记到当前这款车名下 */
  setLook(patch: Partial<CarLook>): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/**
 * 一组互斥选项：点击后高亮自己并回调。
 * 返回一个函数：从外面把高亮挪到第 i 项（不触发回调），换车之后同步面板用。
 */
function exclusive<T>(
  container: HTMLElement,
  items: T[],
  make: (item: T) => HTMLElement,
  onPick: (item: T) => void,
  initial = 0,
): (index: number) => void {
  const nodes = items.map((item, i) => {
    const node = make(item);
    if (i === initial) node.classList.add('active');
    node.addEventListener('click', () => {
      nodes.forEach((n) => n.classList.remove('active'));
      node.classList.add('active');
      onPick(item);
    });
    container.appendChild(node);
    return node;
  });
  return (index) => nodes.forEach((n, i) => n.classList.toggle('active', i === index));
}

function section(title: string): { root: HTMLElement; label: HTMLElement } {
  const root = el('section');
  const h = el('h2');
  h.append(title);
  const label = el('b');
  h.appendChild(label);
  root.appendChild(h);
  return { root, label };
}

export function buildUI(root: HTMLElement, hooks: UIHooks): void {
  const { car } = hooks;

  /* 标题 */
  const brand = el('header', 'brand');
  brand.appendChild(el('div', 'brand-tag', '车库'));
  const h1 = el('h1');
  h1.append('UMBRA ');
  const modelName = el('em', '', car.model.name);
  h1.appendChild(modelName);
  brand.appendChild(h1);
  const brandSub = el('div', 'brand-sub');
  brand.appendChild(brandSub);
  root.appendChild(brand);

  /* 车型：五款车选一款。名字、定位、介绍和四项能力跟着变 */
  const card = el('div', 'model-card');
  const modelChips = el('div', 'model-chips');
  const tagline = el('div', 'model-tagline');
  const blurb = el('p', 'model-blurb');
  const bars: { fill: HTMLElement; value: HTMLElement }[] = [];
  const statsBox = el('div', 'model-stats');
  const STAT_NAMES: [keyof CarModel['stats'], string][] = [
    ['speed', '极速'],
    ['accel', '加速'],
    ['grip', '抓地'],
    ['drift', '漂移'],
  ];
  for (const [, label] of STAT_NAMES) {
    const row = el('div', 'model-stat');
    row.appendChild(el('span', '', label));
    const track = el('i');
    const fill = el('b');
    track.appendChild(fill);
    row.appendChild(track);
    const value = el('em');
    row.appendChild(value);
    statsBox.appendChild(row);
    bars.push({ fill, value });
  }
  const showModel = (m: CarModel) => {
    modelName.textContent = m.name;
    tagline.textContent = m.tagline;
    blurb.textContent = m.blurb;
    brandSub.textContent = `${CAR_BASES[m.base].kind} · 长 ${carLength(m).toFixed(2)} 米 · ${m.tagline}`;
    STAT_NAMES.forEach(([key], i) => {
      bars[i].fill.style.width = `${m.stats[key] * 10}%`;
      bars[i].value.textContent = String(m.stats[key]);
    });
  };
  // 两排按钮：上面一排选车身（外形完全不同的几台车），下面一排选这台车身的款式（只有原型车有好几款）
  const variantChips = el('div', 'model-chips model-variants');
  const bases = Object.values(CAR_BASES);
  /** 每台车身上次选的是哪一款：换回来的时候还是它 */
  const lastOf = new Map<string, CarModel>();
  const bodyNodes = new Map<string, HTMLElement>();
  const refreshChips = (m: CarModel) => {
    lastOf.set(m.base, m);
    for (const [id, node] of bodyNodes) node.classList.toggle('active', id === m.base);
    const variants = CAR_MODELS.filter((x) => x.base === m.base);
    variantChips.textContent = '';
    variantChips.style.display = variants.length > 1 ? '' : 'none';
    for (const v of variants) {
      const b = el('button', 'model-chip', v.name);
      if (v === m) b.classList.add('active');
      b.addEventListener('click', () => pickModel(v));
      variantChips.appendChild(b);
    }
  };
  /** 换车之后把改装面板上的高亮挪到这台车自己的那套上（下面建面板的时候填进来） */
  let syncLook: () => void = () => {};
  const pickModel = (m: CarModel) => {
    hooks.setModel(m);
    showModel(m);
    refreshChips(m);
    syncLook();
  };
  for (const base of bases) {
    const b = el('button', 'model-chip', base.name);
    b.addEventListener('click', () => {
      if (car.model.base === base.id) return;
      pickModel(lastOf.get(base.id) ?? CAR_MODELS.find((x) => x.base === base.id)!);
    });
    bodyNodes.set(base.id, b);
    modelChips.appendChild(b);
  }
  refreshChips(car.model);
  showModel(car.model);
  card.append(modelChips, variantChips, tagline, blurb, statsBox);
  root.appendChild(card);

  /* 改装面板：每一项改完都记到当前这款车名下 */
  const panel = el('aside', 'panel');
  const at = (i: number) => Math.max(0, i);

  const paint = section('车漆');
  const paintGrid = el('div', 'swatches');
  const selectPaint = exclusive<PaintPreset>(
    paintGrid,
    PAINTS,
    (p) => {
      const b = el('button', 'swatch');
      b.title = p.name;
      b.style.background = `linear-gradient(135deg, ${p.base} 0%, ${p.base} 52%, ${p.flop} 100%)`;
      return b;
    },
    (p) => {
      car.setPaint(p);
      paint.label.textContent = p.name;
      hooks.setLook({ paint: p.id });
    },
  );
  paint.root.appendChild(paintGrid);
  panel.appendChild(paint.root);

  const second = section('副色');
  const chips = el('div', 'chips');
  type SecondaryPick = PaintPreset | 'follow' | 'carbon';
  const SECOND_OPTIONS: { id: string; name: string; value: SecondaryPick }[] = [
    ...SECONDARY.map((x) => ({ id: x.id, name: x.name, value: x as SecondaryPick })),
    { id: 'carbon', name: '碳纤维', value: 'carbon' },
    { id: 'follow', name: '同色', value: 'follow' },
  ];
  const selectSecond = exclusive(
    chips,
    SECOND_OPTIONS,
    (o) => el('button', 'chip', o.name),
    (o) => {
      car.setSecondary(o.value);
      hooks.setLook({ secondary: o.id });
    },
  );
  second.root.appendChild(chips);
  panel.appendChild(second.root);

  const colorGroup = (title: string, items: ColorOption[], apply: (o: ColorOption) => void) => {
    const s = section(title);
    const grid = el('div', 'swatches');
    const select = exclusive<ColorOption>(
      grid,
      items,
      (o) => {
        const b = el('button', 'swatch');
        b.title = o.name;
        b.style.background = o.color;
        return b;
      },
      (o) => {
        apply(o);
        s.label.textContent = o.name;
      },
    );
    s.root.appendChild(grid);
    panel.appendChild(s.root);
    return (id: string) => {
      const i = at(items.findIndex((o) => o.id === id));
      select(i);
      s.label.textContent = items[i].name;
    };
  };
  const wing = section('尾翼');
  const wingChips = el('div', 'chips');
  const selectWing = exclusive<{ name: string; on: boolean }>(
    wingChips,
    [
      { name: '扰流翼', on: true },
      { name: '无', on: false },
    ],
    (o) => el('button', 'chip', o.name),
    (o) => {
      car.setWing(o.on);
      hooks.setLook({ wing: o.on });
    },
  );
  wing.root.appendChild(wingChips);
  panel.appendChild(wing.root);

  const selectRim = colorGroup('轮毂', RIMS, (o) => {
    car.setRim(o);
    hooks.setLook({ rim: o.id });
  });
  const selectCaliper = colorGroup('卡钳', CALIPERS, (o) => {
    car.setCaliper(o);
    hooks.setLook({ caliper: o.id });
  });

  // 特效配色：轮胎烟和氮气喷焰的颜色。色块左上是烟的颜色，右下是喷焰的颜色
  const fx = section('特效');
  const fxGrid = el('div', 'swatches');
  const css = (c: [number, number, number]) => `rgb(${c.map((x) => Math.round(Math.min(1, x) * 255)).join(',')})`;
  const selectFx = exclusive<FxTheme>(
    fxGrid,
    FX_THEMES,
    (t) => {
      const b = el('button', 'swatch');
      b.title = t.name;
      b.style.background = `linear-gradient(135deg, ${css(t.smoke)} 0%, ${css(t.smoke)} 50%, ${css(t.line)} 50%, ${css(t.line)} 100%)`;
      return b;
    },
    (t) => {
      hooks.setFxTheme(t);
      fx.label.textContent = t.name;
      hooks.setLook({ fx: t.id });
    },
  );
  fx.root.appendChild(fxGrid);
  panel.appendChild(fx.root);

  syncLook = () => {
    const look = hooks.getLook();
    const pi = at(PAINTS.findIndex((p) => p.id === look.paint));
    selectPaint(pi);
    paint.label.textContent = PAINTS[pi].name;
    selectSecond(at(SECOND_OPTIONS.findIndex((o) => o.id === look.secondary)));
    selectWing(look.wing ? 0 : 1);
    // 这款车没有能拆的尾翼，就不显示这一栏
    wing.root.style.display = car.hasWing ? '' : 'none';
    selectRim(look.rim);
    selectCaliper(look.caliper);
    const fi = at(FX_THEMES.findIndex((t) => t.id === look.fx));
    selectFx(fi);
    fx.label.textContent = FX_THEMES[fi].name;
  };
  syncLook();
  root.appendChild(panel);

  /* 底部：视角 + 开关 */
  const dock = el('nav', 'dock');
  const btn = (text: string) => {
    const b = el('button');
    b.appendChild(el('span', '', text));
    return b;
  };

  const viewGroup = el('div', 'dock-group');
  exclusive<ViewDef>(
    viewGroup,
    hooks.views,
    (v) => btn(v.name),
    (v) => hooks.setView(v.id),
    Math.max(0, hooks.views.findIndex((v) => v.id === hooks.initialView)),
  );
  dock.appendChild(viewGroup);

  const toggleGroup = el('div', 'dock-group');
  const toggle = (text: string, initial: boolean, onChange: (on: boolean) => void) => {
    const b = btn(text);
    let on = initial;
    b.classList.toggle('active', on);
    b.addEventListener('click', () => {
      on = !on;
      b.classList.toggle('active', on);
      onChange(on);
    });
    toggleGroup.appendChild(b);
  };
  toggle('车灯', true, (on) => car.setLights(on));
  toggle('转台', hooks.initialAutoRotate, (on) => hooks.setAutoRotate(on));
  toggle('打方向', true, (on) => hooks.setSteer(on));
  dock.appendChild(toggleGroup);

  const driveGroup = el('div', 'dock-group');
  const go = btn('试驾 ▶');
  go.classList.add('cta');
  go.addEventListener('click', () => hooks.startDrive());
  driveGroup.appendChild(go);
  dock.appendChild(driveGroup);
  root.appendChild(dock);

  /* 状态 */
  const stat = el('div', 'stat');
  root.appendChild(stat);
  const refresh = () => {
    const s = hooks.getStats();
    stat.innerHTML = `${s.backend} · <b>${s.fps}</b> FPS`;
  };
  refresh();
  window.setInterval(refresh, 500);

  root.appendChild(el('div', 'hint', '拖动旋转 · 滚轮缩放 · 右键平移'));
}
