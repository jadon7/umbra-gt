import type { AISkill } from './RivalAI.ts';

export type RaceLevel = 'easy' | 'normal' | 'hard';

export const LEVELS: { id: RaceLevel; name: string }[] = [
  { id: 'easy', name: '简单' },
  { id: 'normal', name: '普通' },
  { id: 'hard', name: '困难' },
];

/** 一个对手：名字、车漆（car/paint 里的配方 id）、界面上代表他的颜色 */
export interface RivalDef {
  name: string;
  paint: string;
  color: string;
}

/** 对手名单。最多同时上场 7 个；多出来的一个是替补（玩家的车漆和谁撞色，就换替补上） */
export const ROSTER: RivalDef[] = [
  { name: 'NOVA', paint: 'volt', color: '#4d7dff' },
  { name: 'KAZE', paint: 'glacier', color: '#e8ecf2' },
  { name: 'VIPER', paint: 'toxic', color: '#57e01c' },
  { name: 'BLITZ', paint: 'sunset', color: '#ff7a2a' },
  { name: 'ONYX', paint: 'midnight', color: '#8d93a0' },
  { name: 'JINX', paint: 'chroma', color: '#a25bff' },
  { name: 'AURUM', paint: 'acid', color: '#ffcf1a' },
  { name: 'STEEL', paint: 'silver', color: '#c7cbd1' },
];

export const MAX_RIVALS = 7;

/** 选出上场的对手：跳过和玩家撞色的那个 */
export function pickRivals(count: number, playerPaint: string): RivalDef[] {
  return ROSTER.filter((r) => r.paint !== playerPaint).slice(0, Math.min(count, MAX_RIVALS));
}

interface LevelDef {
  lateral: number;
  brake: number;
  top: number;
  nitro: boolean;
  /** 每往后一个发车位，水平降多少（比例） */
  spread: number;
  /** 橡皮筋：领先玩家时最多放慢多少、落后玩家时最多加快多少（比例） */
  easeAhead: number;
  pushBehind: number;
}

const LEVEL_DEFS: Record<RaceLevel, LevelDef> = {
  easy: { lateral: 8.2, brake: 8.0, top: 50, nitro: false, spread: 0.018, easeAhead: 0.1, pushBehind: 0.02 },
  normal: { lateral: 10.2, brake: 9.2, top: 57, nitro: true, spread: 0.014, easeAhead: 0.07, pushBehind: 0.04 },
  hard: { lateral: 12.3, brake: 10.5, top: 78, nitro: true, spread: 0.01, easeAhead: 0.035, pushBehind: 0.05 },
};

/** 第 slot 个发车位（0 = 杆位）上的对手是什么水平：排在前面的更快 */
export function skillFor(level: RaceLevel, slot: number): AISkill {
  const d = LEVEL_DEFS[level];
  const f = 1 - d.spread * slot;
  return {
    lateral: d.lateral * f * f,
    brake: d.brake * f,
    top: d.top * f,
    nitro: d.nitro && slot < 4,
    reaction: 0.12 + ((slot * 37) % 11) * 0.035,
    // 左右交替、幅度不一，不排成一列
    line: (slot % 2 === 0 ? 1 : -1) * (0.8 + ((slot * 53) % 7) * 0.3),
  };
}

/**
 * 橡皮筋：按"对手比玩家多跑了多少米"算他的状态系数。
 * 领先玩家 150 米以上放慢到最多，落后 150 米以上加快到最多，中间线性过渡。
 */
export function rubberBand(level: RaceLevel, aheadOfPlayer: number): number {
  const d = LEVEL_DEFS[level];
  const t = Math.max(-1, Math.min(1, aheadOfPlayer / 150));
  return t > 0 ? 1 - d.easeAhead * t : 1 - d.pushBehind * t;
}
