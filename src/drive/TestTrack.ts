import * as THREE from 'three/webgpu';
import {
  abs,
  dot,
  float,
  fract,
  fwidth,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  smoothstep,
  step,
  uv,
  vec3,
} from 'three/tsl';
import { staticLook, type DriveWorld } from './DriveWorld.ts';
import { RAPIER, type PhysicsWorld } from './PhysicsWorld.ts';
import { buildTrackLayout, TRACK_HALF_WIDTH, type TrackLayout } from './trackLayout.ts';

const BARRIER_OFFSET = TRACK_HALF_WIDTH + 0.8;
const BARRIER_HEIGHT = 1.0;
/** 主直道内侧留一个缺口，可以开进内场（沿赛道的距离范围） */
const INFIELD_GAP: [number, number] = [268, 362];

/** 夕阳方向（从地面指向太阳）。放在主直道的左后方：追尾视角下车尾和侧面受光，背光面留给回程 */
const SUN_DIR = new THREE.Vector3(0.62, 0.36, -0.58).normalize();

interface Prop {
  body: RAPIER.RigidBody;
  home: { x: number; y: number; z: number };
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 天空着色：地平线暖橙 → 中段粉紫 → 天顶深蓝，加太阳光晕 */
function skyColorNode(scale = 1) {
  const dir = normalize(positionLocal);
  const h = dir.y;
  const horizon = vec3(0.62, 0.26, 0.1);
  const mid = vec3(0.2, 0.1, 0.2);
  const zenith = vec3(0.016, 0.04, 0.15);
  const up = mix(mix(horizon, mid, smoothstep(0.0, 0.16, h)), zenith, smoothstep(0.08, 0.6, h));
  const below = mix(horizon.mul(0.5), vec3(0.02, 0.02, 0.025), smoothstep(0.0, -0.25, h));
  const base = mix(below, up, step(0.0, h));
  const d = saturate(dot(dir, vec3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z)));
  const sunCol = vec3(1.0, 0.62, 0.3);
  // 大范围的暖色光晕 + 紧一点的日晕 + 日面
  const glow = sunCol
    .mul(pow(d, 3.0).mul(0.16))
    .add(sunCol.mul(pow(d, 40.0).mul(0.5)))
    .add(sunCol.mul(pow(d, 1400.0).mul(16.0)));
  return base.add(glow).mul(scale);
}

/**
 * 灰盒测试场：一块大平地 + 闭环赛道 + 护栏 + 内场的跳台、绕桩和定圆。
 * 这里的画面只求干净、有速度参照物；正式的城市和光照在阶段 3、4 重做。
 */
export class TestTrack implements DriveWorld {
  readonly group = new THREE.Group();
  readonly label = '测试场';
  readonly layout: TrackLayout;
  get start(): { x: number; z: number; yaw: number } {
    return this.layout.start;
  }
  readonly look = staticLook(new THREE.Color(0.2, 0.1, 0.075), 0.0011, 1.0);

  private readonly physics: PhysicsWorld;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;
  private readonly props: Prop[] = [];
  private coneMesh!: THREE.InstancedMesh;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
    this.layout = buildTrackLayout(3);
    physics.addGround();

    this.buildGround();
    this.buildRoad();
    this.buildBarriers();
    this.buildScenery();
    this.buildInfield();

    // 天空
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    skyMat.colorNode = skyColorNode();
    skyMat.fog = false;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // 太阳：阴影范围跟着车走
    this.sun = new THREE.DirectionalLight(0xffc89a, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -18;
    cam.right = 18;
    cam.top = 18;
    cam.bottom = -18;
    cam.near = 1;
    cam.far = 220;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.group.add(this.sun, this.sun.target);
  }

  /* ------------------------------ 地面与赛道 ------------------------------ */

  private buildGround(): void {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    const p = positionWorld.xz;
    // 抗锯齿网格线：每 10 米一条细线，每 50 米一条粗线，作为距离和速度的参照
    const grid = (cell: number, width: number) => {
      const q = p.div(cell);
      const g = abs(fract(q.sub(0.5)).sub(0.5)).div(fwidth(q).mul(width));
      return float(1).sub(min(min(g.x, g.y), 1.0));
    };
    const noise = mx_noise_float(vec3(p.mul(0.08), 0.0)).mul(0.5).add(0.5);
    const base = mix(vec3(0.07, 0.071, 0.076), vec3(0.1, 0.101, 0.108), noise);
    const lines = max(grid(10, 1.2).mul(0.35), grid(50, 2.0).mul(0.9));
    mat.colorNode = mix(base, vec3(0.3, 0.31, 0.33), lines);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  private buildRoad(): void {
    const S = this.layout.samples;
    const n = S.length;
    const pos = new Float32Array((n + 1) * 2 * 3);
    const nor = new Float32Array((n + 1) * 2 * 3);
    const uvs = new Float32Array((n + 1) * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const s = S[i % n];
      const dist = i === n ? this.layout.length : s.s;
      for (let k = 0; k < 2; k++) {
        const sign = k === 0 ? 1 : -1; // 0 = 左缘，1 = 右缘
        const o = (i * 2 + k) * 3;
        pos[o] = s.pos.x + s.left.x * TRACK_HALF_WIDTH * sign;
        pos[o + 1] = 0.02;
        pos[o + 2] = s.pos.z + s.left.z * TRACK_HALF_WIDTH * sign;
        nor[o + 1] = 1;
        uvs[(i * 2 + k) * 2] = k === 0 ? 1 : 0;
        uvs[(i * 2 + k) * 2 + 1] = dist;
      }
      if (i < n) {
        const l0 = i * 2;
        const r0 = i * 2 + 1;
        const l1 = (i + 1) * 2;
        const r1 = (i + 1) * 2 + 1;
        idx.push(l0, r0, r1, l0, r1, l1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);

    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    const across = uv().x.sub(0.5).abs().mul(2.0); // 0 = 中线，1 = 路缘
    const along = uv().y;
    const noise = mx_noise_float(vec3(positionWorld.xz.mul(0.6), 1.7)).mul(0.5).add(0.5);
    const asphalt = mix(vec3(0.034, 0.035, 0.038), vec3(0.052, 0.053, 0.057), noise);
    const edge = smoothstep(0.9, 0.905, across).mul(float(1).sub(smoothstep(0.935, 0.94, across)));
    const dash = float(1).sub(smoothstep(0.012, 0.016, across)).mul(step(fract(along.div(12.0)), 0.5));
    mat.colorNode = mix(asphalt, vec3(0.62, 0.62, 0.6), max(edge, dash.mul(0.85)));
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    this.group.add(road);

    // 起点线：黑白格
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 64;
    const g = c.getContext('2d')!;
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 16; x++) {
        g.fillStyle = (x + y) % 2 === 0 ? '#e9e9e6' : '#101012';
        g.fillRect(x * 32, y * 32, 32, 32);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const lineMat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.7 });
    lineMat.polygonOffset = true;
    lineMat.polygonOffsetFactor = -4;
    lineMat.polygonOffsetUnits = -4;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HALF_WIDTH * 2 * 0.9, 1.7), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(this.startLineX(), 0.03, this.layout.start.z + 6);
    this.group.add(line);
  }

  /** 起点线处赛道中心线的 x（样条在直道两端有轻微外摆） */
  private startLineX(): number {
    const z = this.layout.start.z + 6;
    let best = this.layout.samples[0];
    for (const s of this.layout.samples) {
      if (s.s > 400) break;
      if (Math.abs(s.pos.z - z) < Math.abs(best.pos.z - z)) best = s;
    }
    return best.pos.x;
  }

  private buildBarriers(): void {
    const S = this.layout.samples;
    const n = S.length;
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, BARRIER_HEIGHT, 1), mat, n * 2);
    const red = new THREE.Color(0.75, 0.035, 0.03);
    const white = new THREE.Color(0.8, 0.8, 0.78);
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const scale = new THREE.Vector3();
    let count = 0;

    for (const side of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const a = S[i];
        const b = S[(i + 1) % n];
        if (side === 1 && a.s > INFIELD_GAP[0] && a.s < INFIELD_GAP[1]) continue;
        p0.copy(a.pos).addScaledVector(a.left, BARRIER_OFFSET * side);
        p1.copy(b.pos).addScaledVector(b.left, BARRIER_OFFSET * side);
        const len = p0.distanceTo(p1);
        const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
        this.v.addVectors(p0, p1).multiplyScalar(0.5);
        this.v.y = BARRIER_HEIGHT / 2;
        this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
        scale.set(1, 1, len + 0.08);
        mesh.setMatrixAt(count, this.m4.compose(this.v, this.q, scale));
        mesh.setColorAt(count, Math.floor(i / 2) % 2 === 0 ? red : white);
        count++;
        // 碰撞体比画面略高，防止高速冲撞时翻出去
        this.physics.addBox(
          { x: this.v.x, y: 0.7, z: this.v.z },
          { x: 0.25, y: 0.7, z: len / 2 + 0.04 },
          { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w },
          0.2,
          0.15,
        );
      }
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /* ------------------------------ 场外参照物 ------------------------------ */

  private buildScenery(): void {
    const S = this.layout.samples;
    const rnd = seeded(20261110);

    // 外圈的体块建筑：只为了有视差和速度感，不可到达，所以不做碰撞
    const boxMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), boxMat, 90);
    const scale = new THREE.Vector3();
    const col = new THREE.Color();
    let count = 0;
    for (let tries = 0; tries < 400 && count < 90; tries++) {
      const s = S[Math.floor(rnd() * S.length)];
      const w = 14 + rnd() * 26;
      const d = 14 + rnd() * 26;
      const h = 8 + Math.pow(rnd(), 2.2) * 60;
      const off = TRACK_HALF_WIDTH + 14 + Math.max(w, d) * 0.5 + rnd() * 70;
      this.v.copy(s.pos).addScaledVector(s.left, -off);
      const reach = Math.hypot(w, d) * 0.5 + TRACK_HALF_WIDTH + 8;
      let ok = true;
      for (let k = 0; k < S.length; k += 2) {
        if (S[k].pos.distanceTo(this.v) < reach) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      this.v.y = h / 2;
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(s.dir.x, s.dir.z));
      scale.set(w, h, d);
      boxes.setMatrixAt(count, this.m4.compose(this.v, this.q, scale));
      const g = 0.1 + rnd() * 0.14;
      boxes.setColorAt(count, col.setRGB(g, g * 1.02, g * 1.08));
      count++;
    }
    boxes.count = count;
    boxes.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    boxes.castShadow = true;
    boxes.receiveShadow = true;
    boxes.frustumCulled = false;
    this.group.add(boxes);

    // 主直道外侧的灯杆：近处高速掠过的参照物
    const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x24262b, roughness: 0.6, metalness: 0.4 });
    const lampMat = new THREE.MeshBasicNodeMaterial();
    lampMat.colorNode = vec3(1.0, 0.82, 0.55).mul(5.0);
    const poleGeo = new THREE.BoxGeometry(0.22, 9, 0.22);
    const lampGeo = new THREE.BoxGeometry(1.6, 0.14, 0.4);
    const poleCount = Math.floor(this.layout.length / 36);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, poleCount);
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, poleCount);
    let pc = 0;
    for (let i = 0; i < S.length && pc < poleCount; i += 12) {
      const s = S[i];
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(s.dir.x, s.dir.z));
      this.v.copy(s.pos).addScaledVector(s.left, -(TRACK_HALF_WIDTH + 3.2));
      this.v.y = 4.5;
      poles.setMatrixAt(pc, this.m4.compose(this.v, this.q, this.one));
      this.v.addScaledVector(s.left, 0.7);
      this.v.y = 9;
      lamps.setMatrixAt(pc, this.m4.compose(this.v, this.q, this.one));
      pc++;
    }
    poles.count = pc;
    lamps.count = pc;
    poles.castShadow = true;
    poles.frustumCulled = false;
    lamps.frustumCulled = false;
    this.group.add(poles, lamps);

    // 起点龙门架
    const gx = this.startLineX();
    const gz = this.layout.start.z + 6;
    const span = TRACK_HALF_WIDTH + 2.4;
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.5), poleMat);
      post.position.set(gx + sx * span, 3.5, gz);
      post.castShadow = true;
      this.group.add(post);
      this.physics.addBox({ x: gx + sx * span, y: 3.5, z: gz }, { x: 0.25, y: 3.5, z: 0.25 });
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.5, 0.9, 0.5), poleMat);
    beam.position.set(gx, 6.9, gz);
    beam.castShadow = true;
    this.group.add(beam);
    const stripMat = new THREE.MeshBasicNodeMaterial();
    stripMat.colorNode = vec3(0.97, 0.87, 0.0).mul(3.0);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(span * 2 - 1, 0.18, 0.56), stripMat);
    strip.position.set(gx, 6.5, gz);
    this.group.add(strip);
  }

  /* ------------------------------ 内场 ------------------------------ */

  private buildInfield(): void {
    // 定圆（练漂移和画圈）
    const ringMat = new THREE.MeshStandardNodeMaterial({ color: 0xcfcfc8, roughness: 0.7 });
    ringMat.polygonOffset = true;
    ringMat.polygonOffsetFactor = -2;
    ringMat.polygonOffsetUnits = -2;
    for (const r of [18, 32]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.15, r + 0.15, 96), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(95, 0.025, 270);
      this.group.add(ring);
    }

    // 跳台：6° 斜坡，车头朝 +Z 冲上去
    const rampLen = 14;
    const rampWidth = 9;
    const th = (6 * Math.PI) / 180;
    const rampMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
    const stripes = step(fract(uv().x.mul(6.0)), 0.5);
    rampMat.colorNode = mix(vec3(0.02, 0.02, 0.022), vec3(0.9, 0.72, 0.0), stripes);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(rampWidth, 0.3, rampLen), rampMat);
    const rq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -th);
    const ry = (rampLen / 2) * Math.sin(th) - 0.15 * Math.cos(th);
    ramp.position.set(95, ry, 40);
    ramp.quaternion.copy(rq);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    this.group.add(ramp);
    this.physics.addBox({ x: 95, y: ry, z: 40 }, { x: rampWidth / 2, y: 0.15, z: rampLen / 2 }, { x: rq.x, y: rq.y, z: rq.z, w: rq.w }, 1.0, 0);

    // 锥桶：可以撞飞的动态刚体
    const spots: [number, number][] = [];
    for (let i = 0; i < 10; i++) spots.push([60, -40 - i * 20]); // 绕桩
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      spots.push([95 + Math.cos(a) * 18, 270 + Math.sin(a) * 18]); // 定圆内圈
    }
    for (const dz of [-34, 64]) spots.push([10.5, dz], [13.5, dz]); // 内场入口两侧

    const coneGeo = new THREE.ConeGeometry(0.19, 0.7, 16);
    const coneMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5 });
    // 橙色锥身 + 一圈白色反光带
    const hgt = positionLocal.y;
    const band = smoothstep(0.02, 0.04, hgt).mul(float(1).sub(smoothstep(0.16, 0.18, hgt)));
    coneMat.colorNode = mix(vec3(0.9, 0.2, 0.01), vec3(0.85, 0.85, 0.82), band);
    this.coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, spots.length);
    this.coneMesh.castShadow = true;
    this.coneMesh.frustumCulled = false;
    this.group.add(this.coneMesh);

    for (const [x, z] of spots) {
      const home = { x, y: 0.36, z };
      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(home.x, home.y, home.z).setLinearDamping(0.3).setAngularDamping(0.6),
      );
      this.physics.world.createCollider(RAPIER.ColliderDesc.cone(0.35, 0.19).setMass(3).setFriction(0.7).setRestitution(0.2), body);
      this.props.push({ body, home });
    }
    this.syncProps();
  }

  /** 把锥桶放回原位 */
  resetProps(): void {
    for (const p of this.props) {
      p.body.setTranslation(p.home, true);
      p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.syncProps();
  }

  private syncProps(): void {
    for (let i = 0; i < this.props.length; i++) {
      const t = this.props[i].body.translation();
      const r = this.props[i].body.rotation();
      this.v.set(t.x, t.y, t.z);
      this.q.set(r.x, r.y, r.z, r.w);
      this.coneMesh.setMatrixAt(i, this.m4.compose(this.v, this.q, this.one));
    }
    this.coneMesh.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------ 每帧 ------------------------------ */

  /** focus：车的位置。太阳阴影范围和天空球都跟着走 */
  update(_dt: number, focus: THREE.Vector3, camera: THREE.Camera): void {
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, 90);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.sky.position.copy(camera.position);
    this.syncProps();
  }

  /** 生成和天空一致的环境贴图，供车漆反射和环境光使用 */
  buildEnvironment(renderer: THREE.WebGPURenderer): void {
    const env = new THREE.Scene();
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    mat.colorNode = skyColorNode();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), mat));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(100, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.045, 0.045) }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.5;
    env.add(floor);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(env, 0, 0.1, 200, { size: 256 });
    pmrem.dispose();
    this.look.environment = rt.texture;
  }
}
