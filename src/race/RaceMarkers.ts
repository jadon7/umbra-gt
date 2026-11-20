import * as THREE from 'three/webgpu';
import { abs, float, fract, mix, smoothstep, step, texture, time, uniform, uv, vec3 } from 'three/tsl';
import { HALF_ROAD, type TrackSample } from '../city/cityLayout.ts';
import { fxDepthFade } from '../core/fx.ts';
import type { Gate } from './RaceDirector.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 能把外来材质接进自己灯光系统的地图（城市赛道） */
export interface MarkerHost {
  adopt(m: THREE.MeshStandardNodeMaterial): void;
}

const GATE_HEIGHT = 4.4;
const HALF_SPAN = HALF_ROAD + 0.3;

/** 把一个物体摆到赛道上的某一点：本地 +Z 朝行进方向，+X 朝左 */
function placeOn(o: THREE.Object3D, s: TrackSample): void {
  o.position.set(s.pos.x, s.pos.y, s.pos.z);
  o.rotation.set(0, Math.atan2(s.dir.x, s.dir.z), 0);
}

/** 一道门：两根发光的立柱、一根横梁，中间一道光幕 */
class GateMarker {
  readonly frame = new THREE.Group();
  readonly curtain: THREE.Mesh;
  private readonly level = uniform(1);
  private readonly tint = uniform(new THREE.Color(1, 0.68, 0.13));
  private readonly veil = uniform(1);

  constructor() {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = (this.tint as N).mul(this.level);
    mat.fog = false;
    const post = new THREE.BoxGeometry(0.36, GATE_HEIGHT, 0.36);
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(post, mat);
      m.position.set(side * HALF_SPAN, GATE_HEIGHT / 2, 0);
      this.frame.add(m);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(HALF_SPAN * 2 + 0.36, 0.22, 0.22), mat);
    beam.position.y = GATE_HEIGHT;
    this.frame.add(beam);

    // 光幕：只往画面上加亮，画在特效叠加层里。一条条斜纹慢慢往上走，靠近地面更亮
    const veil = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    veil.blending = THREE.CustomBlending;
    veil.blendEquation = THREE.AddEquation;
    veil.blendSrc = THREE.OneFactor;
    veil.blendDst = THREE.OneFactor;
    veil.blendSrcAlpha = THREE.ZeroFactor;
    veil.blendDstAlpha = THREE.OneFactor;
    const u: N = uv();
    const stripes: N = smoothstep(0.35, 0.5, abs(fract(u.y.mul(7.0).sub(time.mul(0.6)).add(abs(u.x.sub(0.5)).mul(5.0))).sub(0.5)));
    const fall: N = float(1).sub(u.y).pow(1.6);
    const edge: N = smoothstep(0.0, 0.04, u.x).mul(smoothstep(1.0, 0.96, u.x));
    veil.colorNode = (this.tint as N)
      .mul(mix(float(0.07), float(0.4), stripes))
      .mul(fall.mul(0.85).add(0.15))
      .mul(edge)
      .mul(this.veil)
      .mul(fxDepthFade(0.5));
    veil.fog = false;
    this.curtain = new THREE.Mesh(new THREE.PlaneGeometry(HALF_SPAN * 2, GATE_HEIGHT), veil);
    this.curtain.frustumCulled = false;
  }

  place(s: TrackSample): void {
    placeOn(this.frame, s);
    placeOn(this.curtain, s);
    this.curtain.position.y += GATE_HEIGHT / 2;
  }

  /** @param level 立柱亮度 @param veil 光幕强度（0 = 不画） */
  style(color: THREE.Color, level: number, veil: number): void {
    this.tint.value.copy(color);
    this.level.value = level;
    this.veil.value = veil;
    this.curtain.visible = veil > 0.001;
  }
}

// 下一道门是琥珀色，终点是红的（和界面上的强调色一路）
const YELLOW = new THREE.Color(1.0, 0.68, 0.13);
const PINK = new THREE.Color(1.0, 0.2, 0.14);

/**
 * 比赛在赛道上的标记：起终点的横幅和地上的黑白格、下一个检查点的光门。
 * 立柱、横幅、黑白格在主场景里；光幕在特效叠加层里。
 */
export class RaceMarkers {
  readonly sceneGroup = new THREE.Group();
  readonly fxGroup = new THREE.Group();

  private readonly next = new GateMarker();
  private readonly after = new GateMarker();
  private readonly banner = new THREE.Group();
  private readonly bannerLevel = uniform(1);
  private pulse = 0;
  private clock = 0;
  private nextIsFinish = false;

  /** @param title 横幅上写的赛道名 */
  constructor(host: MarkerHost, finish: TrackSample, title = 'NEON BAY') {
    this.sceneGroup.add(this.next.frame, this.after.frame);
    this.fxGroup.add(this.next.curtain, this.after.curtain);

    /* 地上的黑白格终点线 */
    const cols = 20;
    const line = new THREE.MeshStandardNodeMaterial();
    const u: N = uv();
    const cell: N = step(0.5, fract(u.x.mul(cols / 2))).sub(step(0.5, fract(u.y))).abs();
    line.colorNode = mix(vec3(0.03, 0.03, 0.035), vec3(0.82, 0.82, 0.8), cell);
    line.roughness = 0.8;
    line.metalness = 0;
    line.polygonOffset = true;
    line.polygonOffsetFactor = -2;
    line.polygonOffsetUnits = -2;
    host.adopt(line);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(HALF_ROAD * 2, 1.6), line);
    strip.rotation.x = -Math.PI / 2;
    strip.position.y = 0.012;
    strip.receiveShadow = true;
    const lineHolder = new THREE.Group();
    lineHolder.add(strip);
    placeOn(lineHolder, finish);
    this.sceneGroup.add(lineHolder);

    /* 横幅：挂在路的正上方 */
    const tex = new THREE.CanvasTexture(drawBanner(title));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const face = new THREE.MeshBasicNodeMaterial();
    face.colorNode = (texture(tex) as N).rgb.mul(this.bannerLevel);
    face.fog = false;
    const dark = new THREE.MeshStandardNodeMaterial();
    dark.color.set('#0b0c10');
    dark.roughness = 0.6;
    host.adopt(dark);
    const w = HALF_ROAD * 2 + 1.6;
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, 1.25, 0.3), [dark, dark, dark, dark, face, face]);
    board.position.y = 5.35;
    board.castShadow = true;
    this.banner.add(board);
    for (const side of [-1, 1]) {
      const rod = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.12), dark);
      rod.position.set(side * (w / 2 - 1.2), 6.55, 0);
      this.banner.add(rod);
    }
    placeOn(this.banner, finish);
    this.sceneGroup.add(this.banner);
    this.setVisible(false);
  }

  setVisible(on: boolean): void {
    this.sceneGroup.visible = on;
    this.fxGroup.visible = on;
  }

  /** 下一道该过的门，和再下一道（提前露个头） */
  setGates(next: Gate | null, after: Gate | null): void {
    this.next.frame.visible = !!next;
    this.next.curtain.visible = !!next;
    this.after.frame.visible = !!after && !after.finish;
    this.after.curtain.visible = false;
    if (next) {
      this.next.place(next.sample);
      this.nextIsFinish = next.finish;
      // 终点线上有横幅，不再立柱子，只留光幕
      this.next.frame.visible = !next.finish;
    }
    if (after) this.after.place(after.sample);
  }

  /** 过门的一瞬间闪一下 */
  flash(): void {
    this.pulse = 1;
  }

  /** @param night 入夜程度 0–1：横幅夜里更亮 */
  update(dt: number, night: number): void {
    this.clock += dt;
    this.pulse = Math.max(0, this.pulse - dt * 2.5);
    const beat = 0.5 + 0.5 * Math.sin(this.clock * 5);
    const color = this.nextIsFinish ? PINK : YELLOW;
    this.next.style(color, 2.2 + beat * 1.3 + this.pulse * 5, 1 + this.pulse * 2.5);
    this.after.style(YELLOW, 0.55, 0);
    this.bannerLevel.value = 0.75 + 1.3 * night;
  }
}

/** 横幅上的画面：两头黑白格，中间一行字 */
function drawBanner(title: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 140;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0a0a0d';
  g.fillRect(0, 0, c.width, c.height);
  const cell = 35;
  const blocks = 9;
  for (const x0 of [0, c.width - blocks * cell]) {
    for (let i = 0; i < blocks; i++) {
      for (let j = 0; j < 4; j++) {
        g.fillStyle = (i + j) % 2 === 0 ? '#f2f2ee' : '#0a0a0d';
        g.fillRect(x0 + i * cell, j * cell, cell, cell);
      }
    }
  }
  g.fillStyle = '#f4f4f2';
  g.fillRect(blocks * cell + 24, 18, c.width - (blocks * cell + 24) * 2, 6);
  g.fillRect(blocks * cell + 24, c.height - 24, c.width - (blocks * cell + 24) * 2, 6);
  g.font = 'italic 900 78px Impact, "Arial Narrow Bold", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const text = `${title}  ·  START / FINISH  ·  UMBRA GT`;
  g.fillStyle = '#ff3b2f';
  g.fillText(text, c.width / 2 + 4, c.height / 2 + 6);
  g.fillStyle = '#f4f4f0';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  return c;
}
