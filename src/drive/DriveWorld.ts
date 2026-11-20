import * as THREE from 'three/webgpu';
import type { CarLighting } from './CarLights.ts';
import type { SnowTracks } from '../city/SnowTracks.ts';
import type { CityTrack } from '../city/cityLayout.ts';
import type { CityLightmap } from '../city/cityLights.ts';

/**
 * 一张地图当前想要的"画面外观"：雾、曝光、环境贴图、后期参数。
 * 试驾模式每帧把它写进渲染器，所以地图可以随时改（昼夜切换就是这么做的）。
 */
export interface WorldLook {
  fogColor: THREE.Color;
  fogDensity: number;
  exposure: number;
  /** 环境贴图（车漆反射 + 环境光） */
  environment: THREE.Texture | null;
  environmentIntensity: number;
  /** 入夜程度：0 白天，1 夜晚。车灯跟着它开关 */
  night: number;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  contrast: number;
  saturation: number;
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  /** 地面有多湿 0–1（轮胎水雾跟着它） */
  wetness: number;
  /** 正在下的雨有多大 0–1（镜头水滴跟着它） */
  rain: number;
  /** 地上的积雪 0–1（抓地力、车轮卷起的雪雾跟着它） */
  snow: number;
}

/** 不带昼夜变化的地图用这个生成一份固定的外观 */
export function staticLook(fogColor: THREE.Color, fogDensity: number, environmentIntensity: number): WorldLook {
  return {
    fogColor,
    fogDensity,
    exposure: 1,
    environment: null,
    environmentIntensity,
    night: 0,
    bloomStrength: 0.24,
    bloomThreshold: 2.2,
    bloomRadius: 0.5,
    contrast: 1.04,
    saturation: 1.06,
    shadowTint: new THREE.Color(1, 1, 1),
    highlightTint: new THREE.Color(1, 1, 1),
    wetness: 0,
    rain: 0,
    snow: 0,
  };
}

/** 一辆别的车对地面的影响：车底阴影和尾灯地面光 */
export interface RivalLighting {
  x: number;
  /** 贴地高度 */
  y: number;
  z: number;
  /** 水平车头方向（单位向量） */
  dirX: number;
  dirZ: number;
  shadow: number;
  tailGlow: number;
}

/** 试驾模式能开进去的一张"地图"：城市赛道、灰盒测试场都实现这个接口 */
export interface DriveWorld {
  readonly group: THREE.Group;
  /** 显示在界面左上角的名字 */
  readonly label: string;
  /** 出发点和车头朝向（绕 Y 轴，0 = +Z）；y 是那里的路面高度（不写就是 0） */
  readonly start: { x: number; y?: number; z: number; yaw: number };
  /** 赛道（能比赛、能自动驾驶的地图才有） */
  readonly track?: CityTrack;
  /** 车能落脚的高度：把车放到 (x, z) 时用。不实现就当地面在 y = 0 */
  groundAt?(x: number, z: number): number;
  /** 这个位置的路面头顶上有没有东西（隧道、棚洞、高架下面）。电影镜头用：有的话不从高处拍 */
  covered?(x: number, z: number): boolean;
  /** 护栏外面是不是开阔的（山路是；城里路边就是楼）。电影镜头用：开阔的话机位可以立到路外面去 */
  readonly openVerge?: boolean;
  /** 地面光照图：烟、水雾这些特效按它上色（被哪些灯照亮、头顶有没有遮挡） */
  readonly lightmap?: CityLightmap;
  /** 让外来的材质（终点线、检查点）接进这张地图的灯光 */
  adopt?(m: THREE.MeshStandardNodeMaterial): void;
  /** 当前的画面外观 */
  readonly look: WorldLook;
  /**
   * 车是否用实时反射探针（映出身边真实的街道）。
   * 为 true 的地图要给自己的材质单独指定环境贴图，否则它们也会跟着探针变。
   */
  readonly dynamicReflections?: boolean;
  /** 每帧调用：focus 是车的位置 */
  update(dt: number, focus: THREE.Vector3, camera: THREE.PerspectiveCamera): void;
  /** 生成环境贴图，结果放进 look.environment。进入试驾前调用一次 */
  buildEnvironment(renderer: THREE.WebGPURenderer): void;
  /** 把可移动的道具放回原位 */
  resetProps(): void;
  /** 当前时段的名字（白天 / 黄昏 / 夜晚）。没有昼夜的地图没有 */
  readonly timeName?: string;
  /** 切到下一个时段，返回新时段的名字。没有昼夜的地图不实现 */
  cycleTime?(): string;
  /** 直接指定时段（'day' / 'dusk' / 'night'） */
  setTime?(id: string, immediate?: boolean): void;
  /** 当前天气的名字（晴 / 雨 / 雾 / 雪）。没有天气的地图没有 */
  readonly weatherName?: string;
  /** 切到下一种天气，返回它的名字 */
  cycleWeather?(): string;
  /** 直接指定天气（'clear' / 'rain' / 'fog' / 'snow'） */
  setWeather?(id: string, immediate?: boolean): void;
  /** 这张地图自己的特效（雨丝、闪电）。试驾模式把它加进引擎的特效叠加层 */
  readonly fxGroup?: THREE.Group;
  /** 雪地上的车辙（有雪天的地图才有）。试驾模式每帧把各辆车的车轮落点记进去 */
  readonly snowTracks?: SnowTracks;
  /** 主光（太阳或月亮）：从地面指向它的方向、颜色乘亮度。烟这类特效按它算受光面 */
  readonly keyLight?: { dir: THREE.Vector3; color: THREE.Color };
  /** 空中一点被这张地图的灯光照到多亮（着色器节点），水雾这类特效上色用 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  airLight?(p: any): any;
  /** 这个位置头顶是不是露天（着色器节点，1 = 露天）。淋不到雨雪的地方没有轮胎水雾 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openSky?(p: any): any;
  /** 车对地面的照明状态（大灯、车底阴影、尾灯地面光）。地图在自己的材质里算 */
  setCarLighting?(state: CarLighting): void;
  /** 暂停 / 恢复阴影图的更新。反射探针拍照的时候用：阴影这一帧已经画过了，不用为探针的每个面再画一遍 */
  pauseShadows?(paused: boolean): void;
  /** 打闪电的一瞬间调用（雷声跟着它响）。没有闪电的地图没有 */
  onLightning?: (() => void) | null;
  /** 其他车（对手）的车底阴影和尾灯地面光，按离镜头由近到远排好 */
  setRivalLighting?(list: RivalLighting[]): void;
}
