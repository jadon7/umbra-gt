import * as THREE from 'three/webgpu';
import {
  reflector,
  uniform,
  float,
  vec2,
  vec3,
  dot,
  pow,
  mix,
  abs,
  max,
  min,
  length,
  smoothstep,
  saturate,
  uv,
  normalView,
  positionViewDirection,
  positionWorld,
  mx_noise_float,
} from 'three/tsl';

interface Emitter {
  size: [number, number, number];
  pos: [number, number, number];
  color: number;
  /** 照在车上有多亮（环境贴图里用这个数） */
  intensity: number;
  /** 直接看过去有多亮。比照明用的亮度低得多：灯板本身不刺眼、不冒光晕，地面上的倒影也淡 */
  visible: number;
}

const WHITE = 0xf2f5fb;

/** 车库尺寸（米）。车停在原点，车头朝 +Z。 */
const ROOM = { halfX: 11, zBack: -13, zFront: 15, height: 6 };

/**
 * 灯具：摄影棚式的布光，只有白光。
 * 头顶三块长条柔光板（沿车身方向，在车漆上拉出三道干净的高光），两侧墙各一块横着的柔光板（给车门一条水平的亮带）。
 * 灯板做得宽、亮度压得低：照在车上的总光量和以前差不多，但反射是宽而柔的一片，不是一根根刺眼的细灯管。
 * 以前这里还有粉、青、黄三色霓虹和前后墙的竖灯，看着乱，都拿掉了。
 */
function buildEmitters(): Emitter[] {
  return [
    { size: [1.5, 0.05, 12], pos: [-3.0, 5.42, 0.5], color: WHITE, intensity: 7.5, visible: 0.95 },
    { size: [1.5, 0.05, 12], pos: [0, 5.42, 0.5], color: WHITE, intensity: 7.5, visible: 0.95 },
    { size: [1.5, 0.05, 12], pos: [3.0, 5.42, 0.5], color: WHITE, intensity: 7.5, visible: 0.95 },
    { size: [0.04, 0.85, 18], pos: [-ROOM.halfX + 0.06, 2.55, 1], color: WHITE, intensity: 3.4, visible: 0.6 },
    { size: [0.04, 0.85, 18], pos: [ROOM.halfX - 0.06, 2.55, 1], color: WHITE, intensity: 3.4, visible: 0.6 },
  ];
}

function makeBayTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1536;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  // 车位线是低调的浅灰色细线（以前是亮黄色的粗线）
  const yellow = '#aeb3ba';

  // 车位框
  g.strokeStyle = yellow;
  g.lineWidth = 9;
  g.strokeRect(150, 120, 724, 1296);

  // 斜纹警示带（画布上方对应世界 -Z，即车尾后方）
  g.save();
  g.beginPath();
  g.rect(150, 40, 724, 56);
  g.clip();
  g.fillStyle = yellow;
  for (let x = -100; x < 1100; x += 80) {
    g.beginPath();
    g.moveTo(x, 96);
    g.lineTo(x + 40, 96);
    g.lineTo(x + 96, 40);
    g.lineTo(x + 56, 40);
    g.closePath();
    g.fill();
  }
  g.restore();

  // 车位编号
  g.fillStyle = yellow;
  g.font = '600 96px "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('05', 512, 1484 - 6);

  // 做旧：随机擦除，让漆面显得磨损
  g.globalCompositeOperation = 'destination-out';
  let s = 12345;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 2600; i++) {
    g.globalAlpha = 0.12 + rnd() * 0.5;
    const w = 2 + rnd() * 26;
    g.fillRect(rnd() * c.width, rnd() * c.height, w, 1 + rnd() * 5);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

function makeMuralTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 640;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);

  // 后墙上的字标：一行疏朗的浅灰色细体字，下面一道细线和一行小字。
  // 以前是黄、粉、青三色的喷漆大字，在画面里太抢
  g.textBaseline = 'alphabetic';
  g.textAlign = 'center';
  g.fillStyle = '#c9ced6';
  g.font = '300 250px "Helvetica Neue", "PingFang SC", Arial, sans-serif';
  const word = 'UMBRA';
  // 字距拉开：一个字一个字地摆
  const gap = 250;
  const x0 = 1024 - ((word.length - 1) * gap) / 2;
  for (let i = 0; i < word.length; i++) g.fillText(word[i], x0 + i * gap, 400);

  g.fillRect(1024 - 560, 452, 1120, 3);
  g.font = '400 40px "Helvetica Neue", Arial, sans-serif';
  g.fillStyle = '#8d939c';
  const sub = 'STREET GARAGE   ·   BAY 05';
  g.fillText(sub, 1024, 530);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * 展厅车库：可见的房间 + 实时灯光 + 镜面地板，
 * 另外生成一份同布局的环境贴图（IBL），让车漆反射和看到的房间一致。
 */
export class Garage {
  readonly group = new THREE.Group();
  /** 地面反射的可调参数 */
  readonly reflectStrength = uniform(0.7);
  readonly reflectBlurMin = uniform(0.0);
  readonly reflectBlurMax = uniform(1.6);
  readonly reflectCompress = uniform(0.35);
  private emitters = buildEmitters();
  /** 房间自身的材质和它们各自的环境光强度（墙、地要比车暗得多，氛围才压得住） */
  private envMats: { mat: THREE.MeshStandardNodeMaterial; intensity: number }[] = [];

  constructor() {
    this.buildRoom();
    this.buildEmitterMeshes();
    this.buildFloor();
    this.buildLights();
    this.buildDecor();
  }

  private buildRoom(): void {
    const wallMat = new THREE.MeshStandardNodeMaterial({ color: 0x15171b, roughness: 0.92, metalness: 0 });
    // 墙面加一点大尺度明暗变化，避免一片死色
    const n = mx_noise_float(positionWorld.mul(0.35)).mul(0.5).add(0.5);
    wallMat.colorNode = mix(vec3(0.075, 0.077, 0.082), vec3(0.11, 0.112, 0.118), n);
    this.envMats.push({ mat: wallMat, intensity: 0.2 });

    const w = ROOM.halfX * 2;
    const d = ROOM.zFront - ROOM.zBack;
    const zc = (ROOM.zFront + ROOM.zBack) / 2;
    const h = ROOM.height;

    const add = (geo: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number]) => {
      const m = new THREE.Mesh(geo, wallMat);
      m.position.set(...pos);
      m.rotation.set(...rot);
      m.receiveShadow = true;
      this.group.add(m);
    };
    add(new THREE.PlaneGeometry(w, h), [0, h / 2, ROOM.zBack], [0, 0, 0]);
    add(new THREE.PlaneGeometry(w, h), [0, h / 2, ROOM.zFront], [0, Math.PI, 0]);
    add(new THREE.PlaneGeometry(d, h), [-ROOM.halfX, h / 2, zc], [0, Math.PI / 2, 0]);
    add(new THREE.PlaneGeometry(d, h), [ROOM.halfX, h / 2, zc], [0, -Math.PI / 2, 0]);
    add(new THREE.PlaneGeometry(w, d), [0, h, zc], [Math.PI / 2, 0, 0]);

    // 立柱和横梁：给空间加结构和纵深
    const colGeo = new THREE.BoxGeometry(0.7, h, 0.7);
    const beamGeo = new THREE.BoxGeometry(w, 0.55, 0.5);
    for (const z of [-9.5, -3.2, 3.2, 9.5]) {
      for (const sx of [-1, 1]) {
        const col = new THREE.Mesh(colGeo, wallMat);
        col.position.set(sx * (ROOM.halfX - 0.5), h / 2, z);
        col.castShadow = true;
        col.receiveShadow = true;
        this.group.add(col);
      }
      const beam = new THREE.Mesh(beamGeo, wallMat);
      beam.position.set(0, h - 0.275, z);
      this.group.add(beam);
    }
  }

  private buildEmitterMeshes(): void {
    for (const e of this.emitters) {
      const mat = new THREE.MeshBasicNodeMaterial();
      const c = new THREE.Color(e.color);
      mat.colorNode = vec3(c.r, c.g, c.b).mul(e.visible);
      mat.fog = false;
      const m = new THREE.Mesh(new THREE.BoxGeometry(...e.size), mat);
      m.position.set(...e.pos);
      this.group.add(m);
    }
  }

  private buildFloor(): void {
    const refl = reflector({ resolutionScale: 0.75, generateMipmaps: true, bounces: false });

    const wp = positionWorld.xz;
    const nLarge = mx_noise_float(vec3(wp.mul(0.3), 0.0));
    const nFine = mx_noise_float(vec3(wp.mul(2.6), 4.2));
    /** 0 = 抛得很亮，1 = 偏哑 */
    const dull = saturate(float(0.42).add(nLarge.mul(0.4)).add(nFine.mul(0.12)));

    // 轻微扰动 + 按"哑度"取模糊层级，做出抛光混凝土而不是镜子
    refl.uvNode = refl.uvNode!.add(vec2(nFine, nLarge).mul(0.0012));
    const reflColor = refl.level(mix(this.reflectBlurMin, this.reflectBlurMax, dull));

    const ndv = saturate(dot(normalView, positionViewDirection));
    const fresnel = float(0.04).add(float(0.96).mul(pow(float(1).sub(ndv), 5.0)));
    // 高亮灯带经过模糊会把整片地面抬灰，这里把反射亮度软压一下
    const reflSoft = reflColor.rgb.div(reflColor.rgb.mul(this.reflectCompress).add(1.0));

    const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
    mat.colorNode = mix(vec3(0.016, 0.0165, 0.018), vec3(0.03, 0.031, 0.034), dull);
    mat.roughnessNode = mix(float(0.5), float(0.85), dull);
    mat.emissiveNode = reflSoft.mul(fresnel).mul(this.reflectStrength);
    this.envMats.push({ mat, intensity: 0.06 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.add(refl.target);
    this.group.add(floor);

    // 车底接触阴影：圆角矩形的柔和压暗
    const blobSize = new THREE.Vector2(7, 9.5);
    const blobMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    blobMat.colorNode = vec3(0, 0, 0);
    const p = uv().sub(0.5).mul(vec2(blobSize.x, blobSize.y));
    const q = abs(p).sub(vec2(0.8, 1.98));
    const sdf = length(max(q, vec2(0.0))).add(min(max(q.x, q.y), 0.0));
    blobMat.opacityNode = float(1).sub(smoothstep(-0.3, 0.85, sdf)).mul(0.9);
    blobMat.fog = false;
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(blobSize.x, blobSize.y), blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(0, 0.004, -0.24);
    blob.renderOrder = 2;
    this.group.add(blob);

    // 地面车位线
    const bayMat = new THREE.MeshStandardNodeMaterial({
      map: makeBayTexture(),
      transparent: true,
      roughness: 0.55,
      metalness: 0,
      depthWrite: false,
    });
    this.envMats.push({ mat: bayMat, intensity: 0.35 });
    const bay = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 6.9), bayMat);
    bay.rotation.x = -Math.PI / 2;
    bay.position.set(0, 0.002, -0.2);
    bay.renderOrder = 1;
    this.group.add(bay);
  }

  private buildLights(): void {
    // 主光：从车头右前上方打下来，带柔和阴影
    const key = new THREE.SpotLight(0xfff4e6, 290, 30, 0.6, 0.75, 2);
    key.position.set(3.2, 6.6, 5.2);
    key.target.position.set(0, 0.4, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 5;
    this.group.add(key, key.target);

    // 轮廓光：从车尾左后方勾边
    const rim = new THREE.SpotLight(0xdbe8ff, 380, 30, 0.7, 0.8, 2);
    rim.position.set(-4.5, 5.8, -6);
    rim.target.position.set(0, 0.5, 0);
    this.group.add(rim, rim.target);

    // 后墙的洗墙光：一盏很淡的白光从上往下扫过后墙，墙上的字标才看得见，墙面也有一点由亮到暗的过渡
    const wash = new THREE.SpotLight(0xeef2f8, 60, 22, 0.95, 0.9, 2);
    wash.position.set(0, 5.6, ROOM.zBack + 3.2);
    wash.target.position.set(0, 2.2, ROOM.zBack);
    this.group.add(wash, wash.target);
  }

  private buildDecor(): void {
    const tex = makeMuralTexture();
    const mat = new THREE.MeshStandardNodeMaterial({
      map: tex,
      transparent: true,
      roughness: 0.9,
      metalness: 0,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.02,
    });
    this.envMats.push({ mat, intensity: 0.2 });
    const mural = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 3), mat);
    mural.position.set(0, 2.7, ROOM.zBack + 0.03);
    this.group.add(mural);
  }

  /**
   * 生成环境贴图：用同一套灯具摆一份"代理房间"拍成立方体贴图。
   * 灯具在地面以下再镜像一份并压暗，模拟抛光地面的反光，
   * 这样车身下半部分也有东西可以反射。
   */
  buildEnvironment(renderer: THREE.WebGPURenderer): THREE.Texture {
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x010102);

    const w = ROOM.halfX * 2;
    const d = ROOM.zFront - ROOM.zBack;
    const zc = (ROOM.zFront + ROOM.zBack) / 2;
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(w, ROOM.height * 2, d),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.012, 0.013, 0.016), side: THREE.BackSide }),
    );
    shell.position.set(0, 0, zc);
    env.add(shell);

    for (const e of this.emitters) {
      const geo = new THREE.BoxGeometry(...e.size);
      const up = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(e.color).multiplyScalar(e.intensity) }));
      up.position.set(...e.pos);
      env.add(up);
      const down = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(e.color).multiplyScalar(e.intensity * 0.2) }));
      down.position.set(e.pos[0], -e.pos[1], e.pos[2]);
      env.add(down);
    }

    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(env, 0, 0.1, 100, { size: 512, position: new THREE.Vector3(0, 0.9, 0) });
    pmrem.dispose();

    for (const { mat, intensity } of this.envMats) {
      mat.envMap = rt.texture;
      mat.envMapIntensity = intensity;
      mat.needsUpdate = true;
    }
    return rt.texture;
  }
}
