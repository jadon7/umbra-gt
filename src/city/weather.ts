import type { TimePreset } from './atmosphere.ts';

type RGB = [number, number, number];

export type WeatherId = 'clear' | 'rain' | 'fog' | 'snow';

/** 一种天气要达到的目标值。实际状态（WeatherState）朝着它慢慢变 */
export interface WeatherPreset {
  id: WeatherId;
  name: string;
  /** 雨量 0–1 */
  rain: number;
  /** 地面最终有多湿 0–1 */
  wet: number;
  /** 雾的浓度是晴天的几倍 */
  fog: number;
  /** 阴云程度 0–1：遮住太阳和星星，天空发灰 */
  overcast: number;
  lightning: boolean;
  /** 雪下得多大 0–1。下着雪地上就会积雪 */
  snow: number;
}

export const WEATHERS: Record<WeatherId, WeatherPreset> = {
  clear: { id: 'clear', name: '晴', rain: 0, wet: 0, fog: 1, overcast: 0, lightning: false, snow: 0 },
  rain: { id: 'rain', name: '雨', rain: 1, wet: 1, fog: 2.3, overcast: 1, lightning: true, snow: 0 },
  // 雾天地面是潮的，但没有积水
  fog: { id: 'fog', name: '雾', rain: 0, wet: 0.32, fog: 7.0, overcast: 0.8, lightning: false, snow: 0 },
  // 雪天：满天云、空气发白，地上积雪；车轮压过的地方是化开的雪水，所以路面本身也是潮的
  snow: { id: 'snow', name: '雪', rain: 0, wet: 0.3, fog: 3.1, overcast: 0.95, lightning: false, snow: 1 },
};

export const WEATHER_ORDER: WeatherId[] = ['clear', 'rain', 'fog', 'snow'];

/** 当前这一刻的天气状态 */
export interface WeatherState {
  rain: number;
  wetness: number;
  fog: number;
  overcast: number;
  /** 闪电的亮度 0–1（一闪而过） */
  flash: number;
  /** 正在下的雪有多大 0–1 */
  snow: number;
  /** 地上的积雪 0–1 */
  snowCover: number;
}

const approach = (v: number, target: number, rate: number, dt: number) => (v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt));

/** 让状态朝目标天气走一步。各个量的快慢不一样：雨说下就下，地面要一会儿才湿透，干得更慢 */
export function stepWeather(s: WeatherState, target: WeatherPreset, dt: number): void {
  s.rain = approach(s.rain, target.rain, 0.45, dt);
  s.overcast = approach(s.overcast, target.overcast, 0.3, dt);
  s.fog += (target.fog - s.fog) * (1 - Math.exp(-dt * 0.55));
  // 下雨时按雨量变湿（约 6 秒湿透）；雨停后慢慢干到这种天气该有的湿度（约 25 秒）
  if (s.rain > 0.05) s.wetness = Math.min(1, s.wetness + s.rain * dt * 0.17);
  else s.wetness = approach(s.wetness, target.wet, 0.04, dt);
  // 雪：说下就下；积雪约 12 秒铺满，雪停后约 20 秒化完（下雨化得更快）
  s.snow = approach(s.snow, target.snow, 0.4, dt);
  if (s.snow > 0.05) s.snowCover = Math.min(1, s.snowCover + s.snow * dt * 0.085);
  else s.snowCover = Math.max(0, s.snowCover - dt * (0.05 + 0.12 * s.rain));
}

const lum = (c: RGB) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const scale3 = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const desat = (c: RGB, k: number): RGB => {
  const g = lum(c);
  return [mix(c[0], g, k), mix(c[1], g, k), mix(c[2], g, k)];
};
const add3 = (a: RGB, b: RGB, k = 1): RGB => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/**
 * 把天气叠到一个时段的光照参数上，返回新的一组参数。
 * 时段决定"现在几点"，天气决定"天上有没有云、空气里有多少水"。
 */
export function applyWeather(p: TimePreset, w: WeatherState): TimePreset {
  const o = w.overcast;
  // 雾比晴天浓出来的那部分，折算成 0–1
  const haze = Math.min(1, Math.max(0, (w.fog - 1) / 3));
  const night = p.lights;
  const snow = Math.max(w.snow, w.snowCover);

  // 阴天的天空：整片云的颜色。用这个时段云的明暗两色调出来，再去掉大半饱和度
  // （厚云把晚霞挡在后面，黄昏的阴天是发灰的紫，不是一片粉红）
  const cloudSky = desat(mix3(p.cloudDark, p.cloudLit, 0.3), 0.6);
  const cloudHorizon = desat(mix3(p.cloudDark, p.cloudLit, 0.5), 0.5);
  let zenith = mix3(p.zenith, cloudSky, o * 0.92);
  let horizon = mix3(p.horizon, cloudHorizon, o * 0.85);
  // 满天云的时候云层自己的明暗对比要收掉，否则夜里会剩下一块块黑斑
  let cloudLit = mix3(p.cloudLit, cloudHorizon, o * 0.7);
  let cloudDark = mix3(p.cloudDark, cloudSky, o * 0.85);
  let below = mix3(p.below, scale3(cloudHorizon, 0.6), o * 0.6);

  const keyGray = lum(p.keyColor);
  const hemiGray = lum(p.hemiSky);
  // 雾里的光：夜里城市的灯把雾照亮
  const cityGlow: RGB = [0.055, 0.04, 0.06];
  let fogColor = mix3(p.fogColor, horizon, Math.max(haze, o * 0.6));
  fogColor = add3(fogColor, cityGlow, night * haze);
  // 雪天的空气是发白的：白天一片灰白，夜里满城的灯被雪和低云来回反射，天是暖的橙粉色
  fogColor = mix3(fogColor, add3(scale3(fogColor, 1.5), [0.02, 0.022, 0.026]), snow * (1 - night));
  fogColor = add3(fogColor, [0.075, 0.046, 0.04], night * snow);
  // 起雾之后天空也被雾吞掉：整片天都往雾的颜色靠（天空球本身不受雾影响，要在这里手动做）
  zenith = mix3(zenith, fogColor, haze * 0.9);
  horizon = mix3(horizon, fogColor, haze);
  cloudLit = mix3(cloudLit, fogColor, haze * 0.9);
  cloudDark = mix3(cloudDark, fogColor, haze * 0.9);
  below = mix3(below, fogColor, haze);

  const out: TimePreset = {
    ...p,
    keyIntensity: p.keyIntensity * (1 - 0.82 * o),
    // 地上铺了雪，从下往上反的光多得多：背光面、屋檐下都被照亮
    hemiGround: mix3(p.hemiGround, add3(scale3(p.hemiSky, 0.62), [0.02, 0.02, 0.022]), w.snowCover * 0.85),
    keyColor: mix3(p.keyColor, [keyGray * 0.92, keyGray * 0.97, keyGray * 1.06], 0.7 * o),
    hemiSky: mix3(p.hemiSky, [hemiGray * 0.94, hemiGray * 0.98, hemiGray * 1.05], 0.65 * o),
    hemiIntensity: p.hemiIntensity * (1 - 0.12 * o) * (1 + 0.3 * w.snowCover + 0.5 * w.snowCover * night),
    zenith,
    horizon,
    below,
    cloudLit,
    cloudDark,
    disk: scale3(p.disk, (1 - o) * (1 - o)),
    glow: scale3(p.glow, 1 - o),
    haze: scale3(p.haze, 1 - 0.85 * o),
    stars: p.stars * (1 - o),
    cloudAmount: mix(p.cloudAmount, 1, o),
    fogColor,
    fogDensity: p.fogDensity * w.fog,
    // 阴雨天白天也会开灯
    lights: Math.max(p.lights, 0.45 * Math.max(o, haze)),
    exposure: p.exposure * (1 - 0.04 * o),
    bloomStrength: p.bloomStrength * (1 + 0.7 * haze + 0.2 * w.rain) * (1 - 0.25 * w.snowCover * (1 - night)),
    bloomThreshold: p.bloomThreshold - 0.2 * haze,
    bloomRadius: Math.min(1, p.bloomRadius + 0.12 * haze),
    // 白天阴天颜色发灰；夜里靠霓虹撑着，不减饱和度
    saturation: p.saturation * (1 - 0.1 * o * (1 - night)),
  };

  if (w.flash > 0) {
    const f = w.flash;
    const bolt: RGB = [0.62, 0.7, 1.0];
    out.hemiSky = mix3(out.hemiSky, bolt, Math.min(1, f));
    out.hemiIntensity += f * 5.5;
    out.zenith = add3(out.zenith, bolt, f * 0.22);
    out.horizon = add3(out.horizon, bolt, f * 0.34);
    out.cloudLit = add3(out.cloudLit, bolt, f * 0.6);
    out.cloudDark = add3(out.cloudDark, bolt, f * 0.14);
    out.fogColor = add3(out.fogColor, bolt, f * 0.16);
  }
  return out;
}
