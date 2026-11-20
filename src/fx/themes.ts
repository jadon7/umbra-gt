/** 一套特效的配色 */
export interface FxTheme {
  id: string;
  name: string;
  /** 轮胎烟的受光面、背光面 */
  smoke: [number, number, number];
  smokeShade: [number, number, number];
  /** 氮气喷焰和速度流光的颜色 */
  line: [number, number, number];
}

/**
 * 特效配色。界面上（车库）可以换，换的只是颜色：轮胎烟一个色，氮气喷焰一个色。
 * 第一套是真车的样子（白烟、蓝焰）；其余几套相当于换了彩烟胎。
 */
export const FX_THEMES: FxTheme[] = [
  { id: 'chalk', name: '霜白', smoke: [0.8, 0.81, 0.83], smokeShade: [0.34, 0.36, 0.42], line: [0.25, 0.7, 1.0] },
  { id: 'heat', name: '烈焰', smoke: [1.0, 0.56, 0.18], smokeShade: [0.42, 0.08, 0.06], line: [1.0, 0.36, 0.08] },
  { id: 'candy', name: '霓虹粉', smoke: [1.0, 0.36, 0.7], smokeShade: [0.3, 0.07, 0.4], line: [1.0, 0.22, 0.75] },
  { id: 'acid', name: '酸性绿', smoke: [0.58, 1.0, 0.3], smokeShade: [0.05, 0.3, 0.3], line: [0.45, 1.0, 0.25] },
  { id: 'volt', name: '电光紫', smoke: [0.5, 0.42, 1.0], smokeShade: [0.12, 0.07, 0.42], line: [0.55, 0.35, 1.0] },
];
