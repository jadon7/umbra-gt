import * as THREE from 'three/webgpu';
import type { Car } from '../car/Car';
import type { TailLamp } from './TailTrails.ts';

const _p = new THREE.Vector3();

/** 左右对称的灯：给出左边那一盏，右边的镜像出来 */
function pair(lamp: TailLamp): TailLamp[] {
  return lamp.x === 0 ? [lamp] : [lamp, { ...lamp, x: -lamp.x }];
}

/**
 * 每台车的尾灯长什么样、在车尾的什么位置（整车坐标：x 左、y 上、z 前）。
 * 尾灯拖光照着它拖：形状是从各台车的模型上量下来的。
 */
export function tailLampsFor(car: Car): TailLamp[] {
  switch (car.model.base) {
    case 'brute':
      // 两边各三根竖条：拖出六道并排的光
      return [0.47, 0.6, 0.73].flatMap((x) => pair({ x, y: 0.845, z: -2.5, w: 0.1, h: 0.11, gain: 1.15 }));
    case 'ronin':
      // 两边各两个圆环：拖出四根空心的光管；中间那条细灯带拖出一片很淡的光
      return [...[0.535, 0.705].flatMap((x) => pair({ x, y: 0.815, z: -2.08, w: 0.13, h: 0.13, hollow: true, gain: 1.25 })), { x: 0, y: 0.87, z: -2.08, w: 0.74, h: 0.02, gain: 0.4 }];
    case 'nomad':
      // 尾门两侧立式的刹车灯：拖出两道竖着的光刃
      return pair({ x: 0.865, y: 1.145, z: -2.68, w: 0.09, h: 0.13, gain: 1.3 });
    default: {
      // 原型车：贯穿式的括号形灯带——中间一整片薄薄的光幕，两头更亮，两端各有一小段往下拐的竖条。
      // 五款变体的车尾宽窄、长短不一样，位置按车型换算
      const at = (x: number, y: number, z: number) => {
        car.mapPoint(_p.set(x, y, z));
        return { x: _p.x, y: _p.y, z: _p.z };
      };
      const end = at(0.74, 0.765, -1.9);
      const mid = at(0, 0.765, -1.92);
      const leg = at(0.965, 0.645, -1.84);
      return [
        { ...mid, w: 1.05, h: 0.02, gain: 0.5 },
        ...pair({ ...end, w: 0.46, h: 0.02, gain: 1 }),
        ...pair({ ...leg, w: 0.02, h: 0.24, gain: 0.8 }),
      ];
    }
  }
}
