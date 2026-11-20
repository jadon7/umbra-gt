import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, dot, exp, instancedBufferAttribute, length, normalize, normalView, positionView, smoothstep, uv } from 'three/tsl';
import { fxDepthFade } from '../core/fx.ts';
import { cityUniforms } from './materials.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 一处会在空气里晕开的灯 */
export interface GlowSpot {
  x: number;
  y: number;
  z: number;
  color: [number, number, number];
  /** 光晕的大小（米） */
  size: number;
  /** 灯下光锥落到地面的半径；0 表示不画光锥（红绿灯、招牌这类不往下照的灯） */
  cone: number;
  /** 灯下地面的高度（不写就是 0） */
  ground?: number;
}

/**
 * 灯在空气里的样子：每盏灯一团光晕，路灯下面再加一个淡淡的光锥。
 *
 * 真实的夜景里灯不是一个个干净的亮点：空气里有水汽和灰尘，灯周围会晕开一团，
 * 起雾、下雨时更明显，还能看到灯往下照出来的一束光。这里没有做真正的体积光，
 * 而是给每盏灯贴一张朝着镜头的发光圆片、套一个半透明的圆锥，按天气调浓淡。
 * 画在特效叠加层里，只往画面上加亮。
 */
export function createLampGlow(spots: GlowSpot[]): THREE.Group {
  const group = new THREE.Group();
  if (spots.length === 0) return group;

  const additive = (m: THREE.Material) => {
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = false;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
  };
  const lights: N = cityUniforms.lights;
  const haze: N = cityUniforms.haze;

  /* ---- 光晕 ---- */
  const pos = new Float32Array(spots.length * 3);
  const tint = new Float32Array(spots.length * 4);
  spots.forEach((s, i) => {
    pos.set([s.x, s.y, s.z], i * 3);
    tint.set([s.color[0], s.color[1], s.color[2], s.size], i * 4);
  });
  const p: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(pos, 3));
  const t: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(tint, 4));
  const halo = new THREE.SpriteNodeMaterial();
  additive(halo);
  halo.fog = false;
  const away: N = length(p.sub(cameraPosition));
  halo.positionNode = p;
  // 离得越远、空气越浑，晕得越大
  halo.scaleNode = t.w.mul(away.mul(0.006).add(1.0)).mul(haze.mul(1.8).add(1.0));
  const d: N = length(uv().sub(0.5)).mul(2.0);
  const soft: N = d.oneMinus().max(0.0);
  halo.colorNode = t.rgb
    .mul(soft.mul(soft).mul(soft))
    .mul(lights)
    .mul(haze.mul(0.55).add(0.16))
    // 贴到脸上的光晕是一块糊住画面的光斑：走近了就淡掉
    .mul(smoothstep(5.0, 16.0, away))
    // 远处的灯被空气吃掉一部分：不然一长排路灯的光晕会在街道尽头叠成一团白
    .mul(exp(away.mul(haze.mul(-0.012).sub(0.004))))
    .mul(fxDepthFade(1.5));
  const sprite = new THREE.Sprite(halo);
  sprite.count = spots.length;
  sprite.frustumCulled = false;
  group.add(sprite);

  /* ---- 光锥 ---- */
  const cones = spots.filter((s) => s.cone > 0);
  if (cones.length > 0) {
    const SEG = 14;
    const cp: number[] = [];
    const cn: number[] = [];
    const cc: number[] = [];
    const ch: number[] = [];
    const idx: number[] = [];
    for (const s of cones) {
      const base = cp.length / 3;
      const floor = s.ground ?? 0;
      const slope = s.cone / Math.max(s.y - floor, 0.1);
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        // 顶上那一圈略收一点，不从一个尖点出来
        cp.push(s.x + cx * 0.25, s.y, s.z + cz * 0.25, s.x + cx * s.cone, floor + 0.05, s.z + cz * s.cone);
        const len = Math.hypot(1, slope);
        for (let j = 0; j < 2; j++) {
          cn.push(cx / len, slope / len, cz / len);
          cc.push(s.color[0], s.color[1], s.color[2]);
        }
        ch.push(1, 0);
      }
      for (let k = 0; k < SEG; k++) {
        const a = base + k * 2;
        idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(cn, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
    g.setAttribute('aHeight', new THREE.Float32BufferAttribute(ch, 1));
    g.setIndex(idx);
    const cone = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    additive(cone);
    cone.fog = false;
    const h: N = attribute('aHeight', 'float');
    // 视线穿过光锥中间那一段最厚、最亮，擦着边的地方几乎看不见。
    // 要用这个像素自己的视线方向，不能用镜头的正前方：光锥在画面边上时两者差得很多
    const thick: N = abs(dot(normalView, normalize(positionView)));
    cone.colorNode = (attribute('color', 'vec3') as N)
      .mul(thick.mul(thick))
      .mul(h.mul(0.85).add(0.15))
      .mul(lights)
      .mul(haze.mul(0.14).add(0.02))
      .mul(exp(length(positionView).mul(-0.012)))
      .mul(fxDepthFade(1.0));
    const mesh = new THREE.Mesh(g, cone);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

/** 空气有多浑 0–1：雾比晴天浓出来的部分，加上雨带来的水汽。光晕和光锥跟着它变浓 */
export const haze01 = (fogMultiple: number, rain: number): number => Math.min(1, Math.max(0, (fogMultiple - 1) / 3) + rain * 0.35);
