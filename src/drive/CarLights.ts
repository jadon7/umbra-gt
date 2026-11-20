import * as THREE from 'three/webgpu';
import type { Car } from '../car/Car';

/** 车对周围地面的照明状态。地图拿去在自己的材质里算光束、阴影和光晕 */
export interface CarLighting {
  /** 大灯的位置和朝向 */
  headPos: THREE.Vector3;
  headDir: THREE.Vector3;
  /** 大灯开度 0–1 */
  headlight: number;
  /** 车的贴地位置和水平朝向（单位向量 x, z） */
  groundPos: THREE.Vector3;
  heading: THREE.Vector2;
  /** 车底软阴影的浓度 0–1 */
  shadow: number;
  /** 尾灯洒在车后地面上的红光强度 */
  tailGlow: number;
}

/**
 * 车自带的照明：大灯的光束、尾灯洒在车后地面上的红光、车底的软阴影。
 * 这里只负责算状态（位置、朝向、强弱）；真正画出来是在地图的地面材质里按公式算的，
 * 不用真光源和半透明贴片。
 */
export class CarLights {
  readonly state: CarLighting = {
    headPos: new THREE.Vector3(),
    headDir: new THREE.Vector3(0, 0, 1),
    headlight: 0,
    groundPos: new THREE.Vector3(0, -100, 0),
    heading: new THREE.Vector2(0, 1),
    shadow: 0,
    tailGlow: 0,
  };

  private groundY = 0;

  constructor(private readonly car: Car) {}

  /**
   * @param night 入夜程度 0–1
   * @param braking 是否在刹车（尾灯更亮）
   * @param grounded 有没有轮子着地
   */
  update(dt: number, night: number, braking: boolean, grounded: boolean): void {
    const root = this.car.root;
    const s = this.state;
    // 大灯：黄昏开始亮，入夜全亮
    const target = Math.min(1, Math.max(0, (night - 0.25) / 0.45));
    s.headlight += (target - s.headlight) * (1 - Math.exp(-dt * 4));
    s.headDir.set(0, 0, 1).applyQuaternion(root.quaternion);
    s.headPos.copy(root.position).addScaledVector(s.headDir, 1.9);
    s.headPos.y += 0.65;

    const tailTarget = s.headlight * (braking ? 0.42 : 0.1);
    s.tailGlow += (tailTarget - s.tailGlow) * (1 - Math.exp(-dt * (braking ? 30 : 6)));

    // 车底阴影贴着地面：腾空时留在起跳前的高度并变淡
    if (grounded) this.groundY = root.position.y;
    const lift = Math.max(0, root.position.y - this.groundY);
    s.groundPos.set(root.position.x, this.groundY, root.position.z);
    const len = Math.hypot(s.headDir.x, s.headDir.z) || 1;
    s.heading.set(s.headDir.x / len, s.headDir.z / len);
    // 白天有真实的太阳阴影，车底只补一点；夜里全靠它
    s.shadow = (0.3 + 0.4 * night) / (1 + lift * 1.2);
    s.tailGlow /= 1 + lift * 0.5;
  }

  /** 离开试驾：全部关掉 */
  off(): void {
    this.state.headlight = 0;
    this.state.tailGlow = 0;
    this.state.shadow = 0;
  }
}
