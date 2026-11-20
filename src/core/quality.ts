import { isTouch } from './viewport.ts';

export type QualityId = 'low' | 'medium' | 'high';

/** 一档画质：渲染分辨率、后期效果、阴影、反射探针、雨雪的多少 */
export interface QualitySpec {
  id: QualityId;
  name: string;
  /** 渲染分辨率上限（像素总数） */
  maxPixels: number;
  /** 关掉哪些后期效果（和地址栏 fx=-ssr 里的名字一样） */
  fxOff: string[];
  /** 主光阴影：每一级的贴图边长、分几级、照多远 */
  shadowSize: number;
  cascades: number;
  shadowFar: number;
  /** 车身的实时反射探针每帧重拍几个面 */
  probeFaces: number;
  /** 雨丝、雪花的数量是最高档的几成 */
  particles: number;
}

export const QUALITIES: Record<QualityId, QualitySpec> = {
  // 精细：桌面电脑的默认，就是这个游戏一直以来的样子
  high: { id: 'high', name: '精细', maxPixels: 2560 * 1440, fxOff: [], shadowSize: 2048, cascades: 3, shadowFar: 320, probeFaces: 2, particles: 1 },
  // 均衡：分辨率降一半，不算屏幕空间反射
  medium: { id: 'medium', name: '均衡', maxPixels: 1.8e6, fxOff: ['ssr'], shadowSize: 1536, cascades: 3, shadowFar: 260, probeFaces: 1, particles: 0.7 },
  // 流畅：手机的默认。一百万像素，反射、环境光遮蔽、多重采样都不算，阴影少一级
  low: { id: 'low', name: '流畅', maxPixels: 1.0e6, fxOff: ['ssr', 'ao', 'msaa'], shadowSize: 1024, cascades: 2, shadowFar: 180, probeFaces: 1, particles: 0.5 },
};

const KEY = 'umbra.quality';

function pick(): QualitySpec {
  const fromUrl = new URLSearchParams(location.search).get('q');
  if (fromUrl && fromUrl in QUALITIES) return QUALITIES[fromUrl as QualityId];
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved in QUALITIES) return QUALITIES[saved as QualityId];
  } catch {
    /* 读不了就用默认的 */
  }
  return isTouch ? QUALITIES.low : QUALITIES.high;
}

/**
 * 这次运行用的画质。打开页面的时候定下来就不变了（阴影、粒子数量都是建场景的时候按它定的），
 * 在设置里换一档要重新载入页面。地址栏 q=low / medium / high 可以临时指定
 */
export const QUALITY: QualitySpec = pick();

/** 记下新选的画质（下次打开页面生效；调用的人负责重新载入） */
export function saveQuality(id: QualityId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* 存不了就算了 */
  }
}
