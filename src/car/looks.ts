/**
 * 一台车的外观：车漆、副色、尾翼、轮毂、卡钳、特效配色。
 * 每款车有自己的一套出厂配色；玩家在车库里改过之后，按车型记在浏览器里，下次切到这台车还是这一套。
 */
export interface CarLook {
  /** 车漆（paint.ts 里 PAINTS 的 id） */
  paint: string;
  /** 副色：SECONDARY 的 id，或者 'carbon'（碳纤维）、'follow'（和车漆同色） */
  secondary: string;
  /** 尾翼装不装（只对有尾翼的车型有用） */
  wing: boolean;
  /** 轮毂、卡钳颜色（Car.ts 里 RIMS / CALIPERS 的 id） */
  rim: string;
  caliper: string;
  /** 特效配色（fx/themes.ts 的 id） */
  fx: string;
}

/** 各款车的出厂配色。每台都不一样，一眼分得出是哪台 */
const FACTORY: Record<string, CarLook> = {
  gt: { paint: 'lava', secondary: 'gloss', wing: true, rim: 'black', caliper: 'red', fx: 'chalk' },
  rs: { paint: 'glacier', secondary: 'carbon', wing: true, rim: 'bronze', caliper: 'red', fx: 'chalk' },
  lm: { paint: 'silver', secondary: 'gloss', wing: true, rim: 'gunmetal', caliper: 'yellow', fx: 'chalk' },
  st: { paint: 'chroma', secondary: 'satin', wing: true, rim: 'silver', caliper: 'cyan', fx: 'chalk' },
  xr: { paint: 'toxic', secondary: 'satin', wing: true, rim: 'black', caliper: 'yellow', fx: 'chalk' },
  brute: { paint: 'sunset', secondary: 'satin', wing: true, rim: 'gunmetal', caliper: 'yellow', fx: 'chalk' },
  ronin: { paint: 'volt', secondary: 'gloss', wing: true, rim: 'bronze', caliper: 'red', fx: 'chalk' },
  nomad: { paint: 'stealth', secondary: 'satin', wing: true, rim: 'black', caliper: 'orange', fx: 'chalk' },
};

const key = (modelId: string) => `umbra.look.${modelId}`;

/** 这款车的出厂配色（一份新的，可以随便改） */
export function factoryLook(modelId: string): CarLook {
  return { ...(FACTORY[modelId] ?? FACTORY.gt) };
}

/** 这款车现在该是什么样：玩家存过就用存的，没存过用出厂的 */
export function loadLook(modelId: string): CarLook {
  const look = factoryLook(modelId);
  try {
    const raw = localStorage.getItem(key(modelId));
    if (raw) {
      const saved = JSON.parse(raw) as Partial<CarLook>;
      for (const k of Object.keys(look) as (keyof CarLook)[]) {
        const v = saved[k];
        if (typeof v === typeof look[k]) (look as unknown as Record<string, unknown>)[k] = v;
      }
    }
  } catch {
    /* 隐私模式下读不了，或者存的东西坏了：用出厂的 */
  }
  return look;
}

export function saveLook(modelId: string, look: CarLook): void {
  try {
    localStorage.setItem(key(modelId), JSON.stringify(look));
  } catch {
    /* 存不了就算了 */
  }
}
