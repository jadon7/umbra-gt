import * as THREE from 'three/webgpu';
import { abs, attribute, cos, float, length, max, mix, mod, positionView, sin, smoothstep, step, time, uniform, varying, vec2, vec3 } from 'three/tsl';
import { QUALITY } from '../core/quality.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 落叶飘在镜头周围多大的一个盒子里（米） */
const BOX: [number, number, number] = [46, 15, 46];

/**
 * 飘落的秋叶。谷底和湖边的阔叶林里，空中总有几片叶子在往下打着转飘；车开得快的时候它们从镜头两边掠过去。
 *
 * 做法和雪花一样：几百片叶子的位置全在着色器里算，围着镜头的一个盒子里循环——飘出盒子这一头就从那一头回来，
 * 所以不管开到哪儿，身边的叶子总是这么多。和雪花不同的是每片叶子是一小片会翻转的面，不是朝着镜头的圆点。
 * 只在海拔低的地方有（山腰以上是针叶林）；下雨、下雪的时候没有。
 */
export class Leaves {
  readonly mesh: THREE.Mesh;
  private readonly center = uniform(new THREE.Vector3());
  private readonly fall = uniform(new THREE.Vector3());
  private readonly amount = uniform(0);
  private readonly light = uniform(new THREE.Color(1, 1, 1));
  private readonly ahead = new THREE.Vector3();
  private readonly drift = new THREE.Vector3();
  private gust = 0;

  constructor() {
    const count = Math.round(420 * QUALITY.particles);
    const seeds = new Float32Array(count * 4 * 3);
    const corners = new Float32Array(count * 4 * 2);
    const index = new Uint16Array(count * 6);
    let a = 77123;
    const rnd = (): number => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
    const quad = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
    for (let i = 0; i < count; i++) {
      const s = [rnd(), rnd(), rnd()];
      for (let k = 0; k < 4; k++) {
        seeds.set(s, (i * 4 + k) * 3);
        corners.set([quad[k * 2], quad[k * 2 + 1]], (i * 4 + k) * 2);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const seed: N = attribute('aSeed', 'vec3');
    const corner: N = attribute('aCorner', 'vec2');
    const box: N = vec3(...BOX);
    const t: N = time;
    // 每片按自己的节奏左右荡，落得有快有慢
    const speed: N = seed.z.mul(0.6).add(0.7);
    const sway: N = (vec3 as N)(sin(t.mul(seed.x.mul(0.9).add(0.5)).add(seed.y.mul(40.0))), 0.0, sin(t.mul(seed.y.mul(0.8).add(0.4)).add(seed.x.mul(40.0)))).mul(0.9);
    const local: N = mod(seed.mul(box).add(this.fall.mul(speed)).add(sway).sub(this.center), box).sub(box.mul(0.5));
    const world: N = this.center.add(local);
    // 叶片自己在翻：两条互相垂直的边绕着转
    const phi: N = t.mul(seed.x.mul(2.2).add(1.1)).add(seed.z.mul(50.0));
    const theta: N = t.mul(seed.y.mul(2.6).add(1.4)).add(seed.x.mul(30.0));
    const ax: N = (vec3 as N)(cos(phi), 0.0, sin(phi));
    const bx: N = (vec3 as N)(sin(phi).negate().mul(cos(theta)), sin(theta), cos(phi).mul(cos(theta)));
    const size: N = seed.y.mul(0.09).add(0.11);
    const pos: N = world.add(ax.mul(corner.x).mul(size)).add(bx.mul(corner.y).mul(size).mul(0.72));

    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    mat.positionNode = pos;
    const vCorner: N = varying(corner);
    const vLocal: N = varying(local);
    const vSeed: N = varying(seed);
    // 叶子的颜色：金黄、锈红、少数还绿着；朝上的那一面亮一些
    const gold: N = vec3(0.5, 0.33, 0.045);
    const rust: N = vec3(0.4, 0.13, 0.035);
    const green: N = vec3(0.16, 0.23, 0.05);
    const tone: N = mix(mix(gold, rust, step(0.5, vSeed.z)), green, step(0.86, vSeed.x));
    const facing: N = abs(varying(bx.y)).mul(0.5).add(0.6);
    mat.colorNode = tone.mul(facing).mul(this.light);
    // 叶子的形状：一头尖的椭圆；盒子边上的、太贴近镜头的不画
    const d: N = length(vec2(vCorner.x.mul(2.0), vCorner.y.mul(2.0).mul(float(1.0).add(vCorner.x.mul(0.6)))));
    const edge: N = max(max(abs(vLocal.x).div(BOX[0] / 2), abs(vLocal.y).div(BOX[1] / 2)), abs(vLocal.z).div(BOX[2] / 2));
    // 一共这么多片里现在飘着多少：按 amount 挑出一部分
    const chosen: N = step(vSeed.y.mul(0.999), this.amount);
    mat.opacityNode = step(d, 0.95).mul(step(edge, 0.94)).mul(smoothstep(0.9, 1.6, length(positionView))).mul(chosen);
    mat.alphaTest = 0.5;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /**
   * 每帧调用。height = 镜头所在的海拔；calm = 0–1，天气有多不适合飘叶子（下雨、下雪时是 1）；
   * light = 这会儿的环境光有多亮、什么颜色（叶子不受灯光照，直接乘这个）
   */
  update(dt: number, camera: THREE.PerspectiveCamera, calm: number, light: THREE.Color): void {
    const low = Math.min(1, Math.max(0, (50 - camera.position.y) / 16));
    const amount = low * (1 - calm);
    this.amount.value = amount;
    this.mesh.visible = amount > 0.02;
    if (!this.mesh.visible) return;
    // 风一阵一阵的
    this.gust += dt;
    const wind = 0.9 + 0.7 * Math.sin(this.gust * 0.37) + 0.4 * Math.sin(this.gust * 1.13);
    this.drift.set(0.8 * wind, -0.95, -0.45 * wind);
    this.fall.value.addScaledVector(this.drift, dt);
    this.ahead.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.center.value.set(camera.position.x + this.ahead.x * 12, camera.position.y + 3.5, camera.position.z + this.ahead.z * 12);
    this.light.value.copy(light);
  }
}
