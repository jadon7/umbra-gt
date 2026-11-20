import * as THREE from 'three/webgpu';
import { cubeTexture, float, reflectVector } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const SIZE = 256;
/** 用到的最模糊一级：每个面 2×2 像素 */
const MAX_LOD = Math.log2(SIZE) - 1;

/**
 * 把探针的立方体贴图接进材质的环境光：反射方向取样，粗糙度越高取越模糊的级别。
 * three.js 默认会把环境贴图再做一遍精确的预过滤（每帧上亿次采样），实时更新的探针负担不起；
 * 这里直接用贴图自带的逐级缩小图当作"模糊过的反射"，精度够车身用，开销可以忽略。
 */
class ProbeEnvNode extends THREE.Node {
  constructor(private readonly cube: THREE.CubeTexture) {
    super('vec3');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup(builder: any): N {
    const ctx = builder.context;
    // 镜面反射时拿到的是反射方向和粗糙度；漫反射环境光时是法线方向和 1
    const dir: N = ctx.getUV ? ctx.getUV(this, builder) : reflectVector;
    const rough: N = ctx.getTextureLevel ? ctx.getTextureLevel(this) : float(0);
    return (cubeTexture(this.cube, dir, rough.mul(MAX_LOD)) as N).rgb;
  }
}

/**
 * 跟着车走的实时反射探针。
 * 每帧从车的位置朝几个方向各拍一张小图，拼成立方体贴图，给车漆、玻璃当环境贴图。
 * 这样车身上映出来的是它此刻身边真实的街道：霓虹招牌、路灯、亮着的窗会从车身上滑过去。
 */
export class CarProbe {
  /** 接到车的材质上（material.envNode） */
  readonly envNode: THREE.Node;

  private readonly rt: THREE.CubeRenderTarget;
  private readonly cam: THREE.CubeCamera;
  private face = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
  ) {
    this.rt = new THREE.CubeRenderTarget(SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cam = new THREE.CubeCamera(0.3, 1600, this.rt);
    this.envNode = new ProbeEnvNode(this.rt.texture);
  }

  /**
   * 更新探针。
   * @param center 探针的位置（车身中部）
   * @param hide 拍的时候要藏起来的物体（车自己）
   * @param faces 这一帧重拍几个面。六个面轮流拍，每帧 2 个 = 每个面每秒更新 20 次
   */
  update(center: THREE.Vector3, hide: THREE.Object3D[], faces = 2): void {
    const r = this.renderer;
    const cam = this.cam;
    cam.position.copy(center);
    cam.updateMatrixWorld(true);
    if (cam.coordinateSystem !== r.coordinateSystem) {
      cam.coordinateSystem = r.coordinateSystem;
      cam.updateCoordinateSystem();
    }

    const visible = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const prevTarget = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevMip = r.getActiveMipmapLevel();
    const tex = this.rt.texture;
    for (let k = 0; k < faces; k++) {
      // 逐级缩小图（给粗糙表面当"模糊的反射"用）六个面都拍完一轮才重新生成一次：
      // 生成一次要给每个面的每一级各画一遍，几十个小步骤加起来比拍照本身还贵
      const next = (this.face + 1) % 6;
      tex.mipmapsAutoUpdate = next === 0;
      r.setRenderTarget(this.rt, this.face, 0);
      r.render(this.scene, cam.children[this.face] as THREE.Camera);
      this.face = next;
    }
    tex.mipmapsAutoUpdate = true;
    r.setRenderTarget(prevTarget, prevFace, prevMip);
    hide.forEach((o, i) => (o.visible = visible[i]));
  }
}
