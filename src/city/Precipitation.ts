import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, cross, float, length, max, mix, mod, mx_noise_float, normalize, positionView, sin, smoothstep, time, uniform, uv, varying, vec2, vec3 } from 'three/tsl';
import { fxDepthFade } from '../core/fx.ts';
import type { CityLightmap } from './cityLights.ts';
import type { WeatherState } from './weather.ts';
import { QUALITY } from '../core/quality.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 雨丝活动的范围：一个跟着镜头走的盒子（米） */
const RAIN_BOX: [number, number, number] = [36, 20, 36];
const RAIN_COUNT = Math.round(10000 * QUALITY.particles);
const SNOW_BOX: [number, number, number] = [32, 16, 32];
const SNOW_COUNT = Math.round(9000 * QUALITY.particles);

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 天上掉下来的东西：雨丝、雪花、闪电。城市和山路两张地图共用。
 * 都画在引擎的特效叠加层里（把 group 加进地图的 fxGroup）；被哪些灯照亮、哪里淋不到，问地图的地面光照图。
 */
export class Precipitation {
  readonly group = new THREE.Group();
  readonly rain = {
    /** 盒子的中心（跟着镜头走） */
    center: uniform(new THREE.Vector3()),
    /** 雨丝累计下落的位移 */
    fall: uniform(new THREE.Vector3()),
    /** 一根雨丝在画面上拖出来的方向和长度 = 雨相对镜头的速度 × 曝光时间 */
    streak: uniform(new THREE.Vector3(0, -0.4, 0)),
    amount: uniform(0),
    /** 雨丝本身的底色（天光照出来的） */
    ambient: uniform(new THREE.Color(0.2, 0.22, 0.26)),
  };
  /** 飘雪：和雨丝同一套办法，一个跟着镜头走的盒子 */
  readonly snowFx = {
    center: uniform(new THREE.Vector3()),
    fall: uniform(new THREE.Vector3()),
    streak: uniform(new THREE.Vector3(0, -0.05, 0)),
    amount: uniform(0),
    ambient: uniform(new THREE.Color(0.5, 0.52, 0.56)),
  };

  private readonly lightmap: CityLightmap;
  private snowMesh: THREE.Mesh | null = null;
  private readonly prevCam = new THREE.Vector3();
  private readonly camVel = new THREE.Vector3();
  private camKnown = false;
  /** 闪电：距离下一次还有多久、这一次已经亮了多久（< 0 表示没在闪） */
  private flashTimer = 6;
  private flashAge = -1;
  private readonly boltLevel = uniform(0);
  private readonly boltSeed = uniform(0);
  private bolt!: THREE.Mesh;

  constructor(lightmap: CityLightmap) {
    this.lightmap = lightmap;
    this.buildRain();
    this.buildSnow();
    this.buildBolt();
  }

  /** 每帧调用：雨丝和雪花跟着镜头走 */
  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.updateRain(dt, camera);
    this.updateSnow(dt, camera);
  }

  /** 立刻打一道闪电 */
  strike(): void {
    this.flashAge = 0;
    this.boltSeed.value = Math.random() * 100;
  }

  /** 天气被直接切换了：正在闪的那一下收掉 */
  calm(): void {
    this.flashAge = -1;
  }

  /**
   * 每帧调用：到时间了就打一道闪电，并把这一刻的闪光亮度写进 w.flash。
   * @param stormy 现在的天气会不会打雷
   * @param onStrike 打闪的一瞬间调用（雷声）
   */
  updateLightning(dt: number, camera: THREE.PerspectiveCamera, w: WeatherState, stormy: boolean, onStrike: () => void): void {
    if (stormy && w.rain > 0.7 && this.flashAge < 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.flashTimer = 6 + Math.random() * 10;
        this.strike();
        onStrike();
      }
    }
    if (this.flashAge < 0) {
      w.flash = 0;
      this.bolt.visible = false;
      return;
    }
    if (this.flashAge === 0) {
      // 落在镜头前方左右各 25° 以内、六七百米外：保证闪的时候看得见
      const fwd = _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const yaw = Math.atan2(fwd.x, fwd.z) + (Math.random() - 0.5) * 0.9;
      const dist = 520 + Math.random() * 260;
      // 闪电中段的高度：平地上是 150 米；镜头在山上的话跟着抬高
      this.bolt.position.set(camera.position.x + Math.sin(yaw) * dist, 150 + Math.max(0, camera.position.y - 20), camera.position.z + Math.cos(yaw) * dist);
      this.bolt.rotation.y = Math.atan2(camera.position.x - this.bolt.position.x, camera.position.z - this.bolt.position.z);
    }
    this.flashAge += dt;
    const a = this.flashAge;
    // 两连闪：第一下最亮，隔一拍再闪一下，然后拖着余光暗下去
    const pulse = (t0: number, len: number) => (a < t0 ? 0 : Math.exp(-(a - t0) / len));
    w.flash = Math.min(1, pulse(0, 0.07) + (a > 0.16 ? 0.7 * pulse(0.16, 0.12) : 0));
    this.boltLevel.value = a < 0.3 ? Math.min(1, w.flash * 1.4) : 0;
    this.bolt.visible = this.boltLevel.value > 0.02;
    if (a > 0.9) {
      this.flashAge = -1;
      w.flash = 0;
    }
  }

  /* ------------------------------ 雨丝 ------------------------------ */

  /**
   * 雨丝：一万根细长的面片，分布在一个跟着镜头走的盒子里，位置完全在着色器里算。
   * 每根的方向是"雨相对镜头的运动方向"：车停着时竖直落下，开快了就迎面扑过来。
   * 雨丝会被路灯、霓虹和车头大灯照亮，头顶有遮挡的地方（下层街道、高架下、隧道里）没有雨。
   */
  private buildRain(): void {
    const seeds = new Float32Array(RAIN_COUNT * 4 * 3);
    const corners = new Float32Array(RAIN_COUNT * 4 * 2);
    const index = new Uint32Array(RAIN_COUNT * 6);
    const rnd = seeded(8128);
    const quad = [-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1];
    for (let i = 0; i < RAIN_COUNT; i++) {
      const sx = rnd();
      const sy = rnd();
      const sz = rnd();
      for (let k = 0; k < 4; k++) {
        seeds.set([sx, sy, sz], (i * 4 + k) * 3);
        corners.set([quad[k * 2], quad[k * 2 + 1]], (i * 4 + k) * 2);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_COUNT * 4 * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const u = this.rain;
    const seed: N = attribute('aSeed', 'vec3');
    const corner: N = attribute('aCorner', 'vec2');
    const box: N = vec3(...RAIN_BOX);
    // 每根雨丝下落的快慢略有不同
    const speed: N = seed.x.mul(0.35).add(0.82);
    const local: N = mod(seed.mul(box).add(u.fall.mul(speed)).sub(u.center), box).sub(box.mul(0.5));
    const world: N = u.center.add(local);
    const len: N = max(length(u.streak), 0.05);
    const dir: N = u.streak.div(len);
    const toCam: N = normalize(cameraPosition.sub(world));
    const side: N = normalize(cross(dir, toCam));
    const dist: N = length(cameraPosition.sub(world));
    // 远处的雨丝按距离加粗，保证至少有一个像素宽
    const width: N = max(seed.z.mul(0.008).add(0.01), dist.mul(0.0011));
    const pos: N = world.add(dir.mul(corner.y.sub(0.5)).mul(len.mul(speed))).add(side.mul(corner.x).mul(width));

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    mat.positionNode = pos;
    const vWorld: N = varying(world);
    const vLocal: N = varying(local);
    const vCorner: N = varying(corner);
    const across: N = float(1).sub(abs(vCorner.x).mul(2.0));
    const along: N = sin(vCorner.y.mul(Math.PI));
    const viewDist: N = length(positionView);
    const nearFade: N = smoothstep(0.7, 2.6, viewDist);
    // 盒子边缘渐隐，雨丝绕回另一头时不会突然冒出来
    const edge: N = max(max(abs(vLocal.x).div(RAIN_BOX[0] / 2), abs(vLocal.y).div(RAIN_BOX[1] / 2)), abs(vLocal.z).div(RAIN_BOX[2] / 2));
    const edgeFade: N = float(1).sub(smoothstep(0.8, 1.0, edge));
    const open: N = float(1).sub(this.lightmap.cover(vWorld));
    mat.colorNode = u.ambient.add(this.lightmap.airLight(vWorld).mul(0.55));
    mat.opacityNode = smoothstep(0.0, 0.7, across).mul(along).mul(nearFade).mul(edgeFade).mul(open).mul(u.amount).mul(0.42).mul(fxDepthFade(0.5));
    mat.fog = false;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  private updateRain(dt: number, camera: THREE.PerspectiveCamera): void {
    const u = this.rain;
    // 镜头的速度：用来算雨丝迎面扑来的角度
    if (this.camKnown && dt > 0.0005) {
      _v.subVectors(camera.position, this.prevCam).divideScalar(dt);
      // 镜头瞬移（复位、切机位）的那一帧不算
      if (_v.lengthSq() < 150 * 150) this.camVel.lerp(_v, Math.min(1, dt * 10));
    }
    this.prevCam.copy(camera.position);
    this.camKnown = true;

    // 雨的下落速度，带一点风
    _w.set(1.6, -13.5, -1.1);
    u.fall.value.addScaledVector(_w, dt);
    // 画面上拖出来的一道 = 相对速度 × 快门时间；太长的截断
    _w.sub(this.camVel).multiplyScalar(0.017);
    if (_w.length() > 1.25) _w.setLength(1.25);
    u.streak.value.copy(_w);
    // 盒子的中心放在镜头前方一点：眼前的雨更密，身后看不到的地方少浪费
    _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    u.center.value.set(camera.position.x + _v.x * 11, camera.position.y + 3.5, camera.position.z + _v.z * 11);
  }

  /* ------------------------------ 雪花 ------------------------------ */

  /**
   * 雪花：九千片，和雨丝一样分布在跟着镜头走的盒子里。
   * 车停着时是一片片慢慢飘下来的小白点，带一点左右晃；开快了每一片都被拉成迎面扑来的一道。
   */
  private buildSnow(): void {
    const seeds = new Float32Array(SNOW_COUNT * 4 * 3);
    const corners = new Float32Array(SNOW_COUNT * 4 * 2);
    const index = new Uint32Array(SNOW_COUNT * 6);
    const rnd = seeded(1225);
    const quad = [-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1];
    for (let i = 0; i < SNOW_COUNT; i++) {
      const sx = rnd();
      const sy = rnd();
      const sz = rnd();
      for (let k = 0; k < 4; k++) {
        seeds.set([sx, sy, sz], (i * 4 + k) * 3);
        corners.set([quad[k * 2], quad[k * 2 + 1]], (i * 4 + k) * 2);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_COUNT * 4 * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const u = this.snowFx;
    const seed: N = attribute('aSeed', 'vec3');
    const corner: N = attribute('aCorner', 'vec2');
    const box: N = vec3(...SNOW_BOX);
    // 大片的落得快一点
    const speed: N = seed.z.mul(0.5).add(0.75);
    // 飘：每一片按自己的节奏左右晃
    const swayX: N = sin(time.mul(seed.x.mul(1.3).add(0.6)).add(seed.y.mul(40.0)));
    const swayZ: N = sin(time.mul(seed.y.mul(1.1).add(0.5)).add(seed.x.mul(40.0)));
    const sway: N = (vec3 as N)(swayX, 0.0, swayZ).mul(0.35);
    const local: N = mod(seed.mul(box).add(u.fall.mul(speed)).add(sway).sub(u.center), box).sub(box.mul(0.5));
    const world: N = u.center.add(local);
    const dist: N = length(cameraPosition.sub(world));
    // 远处的雪花按距离放大，保证至少有一个多像素
    const size: N = max(seed.z.mul(0.02).add(0.018), dist.mul(0.0019));
    const len: N = max(length(u.streak), 0.0001);
    const dir: N = u.streak.div(len);
    const toCam: N = normalize(cameraPosition.sub(world));
    const side: N = normalize(cross(dir, toCam));
    // 静止时是个圆点（长宽一样），有相对速度时顺着运动方向拉长
    const tall: N = max(size, len);
    const pos: N = world.add(dir.mul(corner.y.sub(0.5)).mul(tall)).add(side.mul(corner.x).mul(size));

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    mat.positionNode = pos;
    const vWorld: N = varying(world);
    const vLocal: N = varying(local);
    const vCorner: N = varying(corner);
    const vStretch: N = varying(size.div(tall));
    const d: N = length(vec2(vCorner.x.mul(2.0), vCorner.y.sub(0.5).mul(2.0)));
    const soft: N = smoothstep(1.0, 0.25, d);
    const nearFade: N = smoothstep(1.2, 3.6, length(positionView));
    const edge: N = max(max(abs(vLocal.x).div(SNOW_BOX[0] / 2), abs(vLocal.y).div(SNOW_BOX[1] / 2)), abs(vLocal.z).div(SNOW_BOX[2] / 2));
    const edgeFade: N = float(1).sub(smoothstep(0.8, 1.0, edge));
    const open: N = float(1).sub(this.lightmap.cover(vWorld));
    mat.colorNode = u.ambient.add(this.lightmap.airLight(vWorld).mul(0.9));
    // 拉得越长越淡：同样多的雪摊在更长的一道上
    mat.opacityNode = soft.mul(nearFade).mul(edgeFade).mul(open).mul(u.amount).mul(mix(float(0.42), float(0.92), vStretch)).mul(fxDepthFade(0.5));
    mat.fog = false;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.snowMesh = mesh;
  }

  private updateSnow(dt: number, camera: THREE.PerspectiveCamera): void {
    const u = this.snowFx;
    if (this.snowMesh) this.snowMesh.visible = u.amount.value > 0.01;
    // 雪落得慢，被风斜着吹
    _w.set(0.9, -2.1, -0.6);
    u.fall.value.addScaledVector(_w, dt);
    // 相对镜头的速度 × 快门时间 = 画面上拖出来的一道
    _w.sub(this.camVel).multiplyScalar(0.014);
    if (_w.length() > 0.8) _w.setLength(0.8);
    u.streak.value.copy(_w);
    _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    u.center.value.set(camera.position.x + _v.x * 10, camera.position.y + 2.5, camera.position.z + _v.z * 10);
  }

  /* ------------------------------ 闪电 ------------------------------ */

  /** 闪电：远处一块朝着镜头的大面片，上面用噪声画出一道曲折的主干和一条分叉 */
  private buildBolt(): void {
    // 只往颜色上加、不动透明度通道：特效层的透明度表示"遮住了多少底图"，闪电是光，不遮东西
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const x: N = uv().x.sub(0.5);
    const y: N = uv().y;
    const sd: N = this.boltSeed;
    const wander: N = mx_noise_float(vec3(y.mul(5.0), sd, 0.0))
      .mul(0.13)
      .add(mx_noise_float(vec3(y.mul(19.0), sd.add(7.0), 1.0)).mul(0.035))
      .add(mx_noise_float(vec3(y.mul(60.0), sd.add(3.0), 2.0)).mul(0.008));
    const d: N = abs(x.sub(wander.mul(float(1).sub(y).mul(0.6).add(0.4))));
    const trunk: N = smoothstep(0.006, 0.0, d).mul(3.5).add(float(0.005).div(d.add(0.004)));
    // 分叉：从半腰岔出去，越往下离主干越远
    const split: N = smoothstep(0.62, 0.58, y);
    const branchX: N = wander.add(float(0.6).sub(y).mul(0.42)).add(mx_noise_float(vec3(y.mul(26.0), sd.add(11.0), 4.0)).mul(0.03));
    const bd: N = abs(x.sub(branchX));
    const branch: N = smoothstep(0.003, 0.0, bd).mul(1.6).add(float(0.0015).div(bd.add(0.003))).mul(split).mul(smoothstep(0.22, 0.34, y));
    const ends: N = smoothstep(0.0, 0.06, y).mul(smoothstep(0.5, 0.42, abs(x)));
    mat.colorNode = vec3(0.72, 0.8, 1.0).mul(trunk.add(branch)).mul(ends).mul(this.boltLevel).mul(2.2).mul(fxDepthFade(2.0));
    mat.fog = false;
    this.bolt = new THREE.Mesh(new THREE.PlaneGeometry(420, 520), mat);
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    this.group.add(this.bolt);
  }
}
