import * as THREE from 'three/webgpu';
import { abs, atan, dot, float, floor, fract, length, mix, positionGeometry, screenSize, screenUV, sin, smoothstep, step, time, uniform, vec2, vec3, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 速度流光：开氮气或者车速很高时，画面四周有一道道细长的光从中间往外飞出去，
 * 像高速穿过雨夜时被拉成线的灯。每一道有亮的头、渐淡的尾，速度和长短各不相同。
 * 一块铺满屏幕的面片，全部在着色器里画，只往画面上加亮。
 */
export class SpeedLines {
  readonly mesh: THREE.Mesh;
  /** 强度 0–1 */
  readonly amount = uniform(0);
  /** 光的颜色（跟着特效配色走）；每道光的芯是白的 */
  readonly tint = uniform(new THREE.Color(0.3, 0.62, 1.0));

  constructor() {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    // 直接在裁剪空间里铺满屏幕，不跟着镜头走
    mat.vertexNode = vec4(positionGeometry.xy, 0.0, 1.0);
    const hash = (p: N): N => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
    const aspect: N = screenSize.x.div(screenSize.y);
    const c: N = screenUV.sub(0.5).mul(vec2(aspect, 1.0));
    const r: N = length(c);
    // 两层：一层细而密，一层粗而疏，错开转速，不会看出规律
    const layer = (count: number, seed: number, thick: number): N => {
      const t: N = atan(c.y, c.x).div(6.2832).add(0.5).mul(count);
      const id: N = floor(t);
      const f: N = fract(t);
      const h1: N = hash(vec2(id, seed));
      const h2: N = hash(vec2(id.mul(1.7).add(5.0), seed + 3.0));
      const h3: N = hash(vec2(id.mul(2.3).add(11.0), seed + 7.0));
      // 只有一部分角度上有光，强度越大越多
      const on: N = step(float(1.0).sub(this.amount.mul(0.34)), h1);
      // 光头的位置：从离中心一段距离的地方出发，一路飞出画面，然后从头再来
      const phase: N = fract(time.mul(h2.mul(1.3).add(1.1)).add(h3.mul(9.0)));
      const head: N = phase.mul(1.05).add(0.3);
      const len: N = h2.mul(0.2).add(0.1).mul(phase.add(0.4));
      // 头亮、往中心方向的尾巴渐淡；头前面干净利落地截断
      const along: N = smoothstep(head.sub(len), head, r).pow(2.0).mul(float(1).sub(smoothstep(head, head.add(0.012), r)));
      // 越往外越粗（透视），本身很细
      const half: N = float(thick).mul(h3.mul(0.6).add(0.7)).mul(smoothstep(0.2, 1.0, r));
      const d: N = abs(f.sub(0.5));
      const across: N = smoothstep(half, half.mul(0.25), d);
      const glow: N = smoothstep(half.mul(3.2), half, d).mul(0.3);
      return vec2(across.mul(along).mul(on), glow.mul(along).mul(on));
    };
    const a: N = layer(120.0, 1.0, 0.07);
    const b: N = layer(46.0, 23.0, 0.045);
    const core: N = a.x.add(b.x);
    const halo: N = a.y.add(b.y);
    // 画面中间（车和前方的路）不画
    const window: N = smoothstep(0.26, 0.52, r);
    const level: N = smoothstep(0.0, 0.3, this.amount).mul(window);
    mat.colorNode = mix(this.tint as N, vec3(1.0, 1.0, 1.0), 0.55)
      .mul(core)
      .mul(1.5)
      .add((this.tint as N).mul(halo).mul(1.2))
      .mul(level);
    mat.fog = false;

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }

  set(amount: number): void {
    this.amount.value = amount;
    this.mesh.visible = amount > 0.02;
  }
}
