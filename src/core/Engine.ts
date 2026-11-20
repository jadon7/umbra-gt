import * as THREE from 'three/webgpu';
import { appSize, onLayout } from './viewport.ts';
import {
  Fn,
  Loop,
  clamp,
  convertToTexture,
  dot,
  float,
  fract,
  int,
  max,
  metalness,
  min,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  rand,
  renderOutput,
  roughness,
  sample,
  screenSize,
  screenUV,
  smoothstep,
  step,
  time,
  uniform,
  unpackRGBToNormal,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { dropletField } from './droplets.ts';
import { sceneDepth as fxSceneDepth } from './fx.ts';
import { surfaceBlur, surfaceReflect } from './surface.ts';
import { DETAIL_LAYER } from './layers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 后期管线的三套配置：
 *  - garage 车库：带景深，不要运动模糊
 *  - drive 试驾：屏幕空间反射、运动模糊、特效层
 *  - cinema 赛前的特写镜头：和试驾一样的街景和特效，但换成景深（背景虚化），不要运动模糊
 */
export type PostProfile = 'garage' | 'drive' | 'cinema';

/** 可以单独关掉的后期效果（地址栏 fx=-ao,-ssr 这样写），调试和对比用 */
export interface PostFeatures {
  ao: boolean;
  ssr: boolean;
  motionBlur: boolean;
  dof: boolean;
  lens: boolean;
  /** 主画面的多重采样抗锯齿 */
  msaa: boolean;
}

export type Updater = (dt: number, time: number) => void;

/**
 * 渲染底座：WebGPU 渲染器 + HDR 后期管线（泛光、暗角）+ 主循环。
 * 后续阶段的反射、运动模糊、调色都接在这条管线上。
 */
export class Engine {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  /**
   * 特效叠加层：雨丝、水雾、闪电这类半透明特效放在这个场景里，
   * 在主画面之后单独渲染再叠上去（原因见 fx.ts）。只在试驾时渲染。
   */
  readonly fx = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 300);

  /** 后期参数，运行时可调 */
  readonly post = {
    bloomStrength: uniform(0.24),
    bloomRadius: uniform(0.5),
    // 2.2：只让灯具和车灯溢光；再低的话亮色车漆的受光面也会跟着发光
    bloomThreshold: uniform(2.2),
    bloomClamp: uniform(4.0),
    vignette: uniform(0.42),
    /** 调色：对比度、饱和度、暗部和亮部各自的色调 */
    contrast: uniform(1.0),
    saturation: uniform(1.0),
    shadowTint: uniform(new THREE.Color(1, 1, 1)),
    highlightTint: uniform(new THREE.Color(1, 1, 1)),
    /** 环境光遮蔽的强度：0 关，1 全量 */
    ao: uniform(0.85),
    /** 屏幕空间反射的强度 */
    ssr: uniform(1.0),
    /** 运动模糊：快门时间（秒）。0 = 关 */
    shutter: 0,
    /** 每帧由 shutter 和帧时间算出来的模糊比例，不要直接改 */
    motionScale: uniform(0),
    /** 景深：对焦距离（米）和虚化程度 */
    focusDistance: uniform(6),
    bokeh: uniform(0),
    /** 镜头：边缘色散、胶片颗粒 */
    aberration: uniform(0.16),
    grain: uniform(0.035),
    /** 镜头上的水滴：0 没有，1 大雨 */
    droplets: uniform(0),
    /** 速度感：0 平常，1 全速加氮气。画面从中心往外拉丝，运动模糊也放得更长 */
    speed: uniform(0),
    /** 强光拖出的横向光条（变形宽银幕镜头的那种）：0 关 */
    streak: uniform(0),
  };

  readonly features: PostFeatures;
  /** 调试用：各个后期节点的引用，方便在控制台里现场调参数 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly debug: Record<string, any> = {};

  fps = 0;
  backendName = 'WebGPU';

  private pipeline!: THREE.RenderPipeline;
  private outputs!: Record<PostProfile, N>;
  private profile: PostProfile = 'garage';
  private updaters: Updater[] = [];
  private afterRender: (() => void)[] = [];
  private last = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;

  /**
   * @param off 要关掉的后期效果，例如 ['ao', 'ssr']
   * @param profiling 是否统计 GPU 耗时（地址栏 prof=1）
   * @param maxPixels 渲染分辨率上限（像素总数）。默认相当于 2560×1440；0 = 不限制，按屏幕原生分辨率
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    off: string[] = [],
    private readonly profiling = false,
    private readonly maxPixels = 2560 * 1440,
  ) {
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      trackTimestamp: profiling,
    });
    // 主镜头看得见细碎物件那一层（反射探针的镜头看不见，见 layers.ts）
    this.camera.layers.enable(DETAIL_LAYER);
    this.features = {
      ao: !off.includes('ao'),
      ssr: !off.includes('ssr'),
      motionBlur: !off.includes('mb'),
      dof: !off.includes('dof'),
      lens: !off.includes('lens'),
      msaa: !off.includes('msaa'),
    };
  }

  async init(): Promise<void> {
    const r = this.renderer;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    // 没有背景的场景（特效叠加层）清屏成全透明，叠加时才不会把主画面盖黑
    r.setClearColor(0x000000, 0);
    await r.init();
    this.backendName = (r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

    this.buildPipeline();
    this.resize();
    onLayout(() => this.resize());
  }

  private buildPipeline(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = this.post as any;
    const f = this.features;

    // 主画面一次渲染同时输出：颜色、法线、反射率和粗糙度、每个像素的运动速度
    const scenePass = pass(this.scene, this.camera, f.msaa ? {} : { samples: 0 });
    // 反射率：只有够光滑的表面（玻璃、水面、车漆、以后的湿地面）才参与屏幕空间反射，
    // 沥青、砖墙这些粗糙表面是 0，反射那一步会直接跳过它们
    // （不受光的材质没有粗糙度，值是 0；正常材质最小也有 0.05，用这个把灯具、天空之类排除掉）
    const auto: N = smoothstep(0.5, 0.12, roughness).mul(mix(float(0.3), float(0.55), metalness)).mul(step(0.03, roughness));
    // 个别材质（路面）会自己指定反射率和模糊度，见 surface.ts；指定成负数 = 这里不要反射（弯道前的橱窗）
    const reflectivity: N = max(auto, surfaceReflect).mul(step(-0.5, surfaceReflect));
    const blur: N = mix(roughness, surfaceBlur, step(0.0005, surfaceReflect));
    scenePass.setMRT(
      mrt({
        output,
        normal: packNormalToRGB(normalView),
        surface: vec2(reflectivity, blur),
        velocity,
      }),
    );
    const sceneColor: N = scenePass.getTextureNode('output');
    const sceneDepth: N = scenePass.getTextureNode('depth');
    const sceneNormalRaw: N = scenePass.getTextureNode('normal');
    const sceneSurface: N = scenePass.getTextureNode('surface');
    const sceneVelocity: N = scenePass.getTextureNode('velocity');
    // 法线存成 8 位颜色就够了，省带宽
    scenePass.getTexture('normal').type = THREE.UnsignedByteType;
    const sceneNormal: N = sample((at: N) => unpackRGBToNormal(sceneNormalRaw.sample(at)));
    // 把主画面的深度图交给特效材质用（见 fx.ts）
    fxSceneDepth.value = scenePass.getTexture('depth');

    // 特效叠加层：不带多重采样，也不输出法线、速度这些
    const fxPass = pass(this.fx, this.camera, { samples: 0 });
    const fxColor: N = fxPass.getTextureNode('output');

    // 环境光遮蔽：墙角、车底、缝隙里压暗
    let lit: N = sceneColor.rgb;
    if (f.ao) {
      const aoPass = ao(sceneDepth, sceneNormal, this.camera);
      this.debug.ao = aoPass;
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 1.4;
      aoPass.thickness.value = 1.2;
      // 每个像素朝四周采 8 次样（原来 12 次）：墙角和车底的暗影看不出区别，省三分之一的时间
      aoPass.samples.value = 8;
      const occlusion: N = aoPass.getTextureNode().r;
      lit = lit.mul(mix(float(1), occlusion, p.ao));
    }

    const compose = (profile: PostProfile): N => {
      let hdr: N = lit;

      // 屏幕空间反射：光滑表面映出画面里已有的东西（水面上的桥和灯、玻璃幕墙上的街景）
      if (f.ssr && profile !== 'garage') {
        const ssrPass = ssr(sceneColor, sceneDepth, sceneNormal, {
          metalnessNode: sceneSurface.r,
          roughnessNode: sceneSurface.g,
          camera: this.camera,
          // 步子迈得大（省时间），命中后再二分细化位置
          binaryRefine: true,
        });
        ssrPass.resolutionScale = 0.5;
        ssrPass.maxDistance.value = 140;
        ssrPass.thickness.value = 2.5;
        // 每条反射光线走的步数 ∝ 它在屏幕上的长度 × quality。0.25 比 0.6 省一半以上的时间，
        // 路面的反射本来就是模糊的，看不出区别
        ssrPass.quality.value = 0.25;
        this.debug.ssr = ssrPass;
        hdr = hdr.add(ssrPass.rgb.mul(p.ssr));
      }

      // 运动模糊：按每个像素这一帧移动了多少来拉丝。车跟着镜头走，所以车是清楚的，路和楼在糊
      if (f.motionBlur && profile === 'drive') {
        const still = convertToTexture(vec4(hdr, 1.0));
        const v: N = sceneVelocity.xy.mul(p.motionScale);
        // 速度感：在每个像素真实的运动之外，再叠一个从画面中心往外的拉丝，越靠边越长。
        // 中间（车所在的位置）不动，所以车是清楚的，四周的街景在往后飞
        const fromCentre: N = uv().sub(0.5);
        const rush: N = fromCentre.mul(smoothstep(0.06, 0.55, fromCentre.length())).mul(p.speed).mul(0.24);
        const total: N = v.add(rush);
        // 限制最长的拉丝，免得贴脸的东西糊成一片；开得越快放得越宽
        const len: N = max(total.length(), 0.0001);
        const capped: N = total.mul(min(len, mix(float(0.03), float(0.16), p.speed)).div(len));
        // 拉丝最长能到画面宽度的六分之一。沿着拉丝方向等距取 20 个点会看出一格一格的重影，
        // 所以每个像素把取样位置随机错开一点（每帧还不一样），重影就散成了细腻的颗粒
        const jitter: N = rand(uv().add(fract(time))).sub(0.5).div(20.0);
        hdr = (Fn(() => {
          const acc: N = vec3(0.0).toVar();
          Loop({ start: int(0), end: int(20), type: 'int', condition: '<' }, ({ i }: { i: N }) => {
            const t: N = float(i).add(0.5).div(20.0).sub(0.5).add(jitter);
            acc.addAssign(still.sample(uv().add(capped.mul(t))).rgb);
          });
          return acc.div(20.0);
        }) as N)();
      }

      // 叠上特效层。它存的是预乘过透明度的颜色：先按透明度压暗底图，再加上去
      const overlay = (base: N): N => base.mul(float(1).sub(fxColor.a.clamp(0, 1))).add(fxColor.rgb);
      if (profile === 'drive') hdr = overlay(hdr);

      // 景深：对焦在车上，背景虚化（车库和赛前镜头用）
      if (f.dof && profile !== 'drive') {
        hdr = (dof(vec4(hdr, 1.0), scenePass.getViewZNode(), p.focusDistance, float(7.0), p.bokeh) as N).rgb;
      }
      // 赛前镜头：特效层放在景深之后叠。景深是按主画面的深度算的，雨丝、雪花没有深度，
      // 先叠的话会被当成它们背后那面墙一起虚化，糊成一块块白斑
      if (profile === 'cinema') hdr = overlay(hdr);

      // 只让高于阈值的 HDR 亮部（车灯、霓虹、灯带）溢光
      // 进泛光前先封顶：极小极亮的高光点（玻璃上的主光反射）否则会炸成一大团
      const c: N = min(hdr, vec3(p.bloomClamp));
      // 阈值按最亮通道判断而不是按亮度：纯红尾灯、粉色霓虹的亮度值很低，按亮度会被漏掉
      const peak: N = max(max(c.r, c.g), c.b);
      const gate: N = smoothstep(p.bloomThreshold, p.bloomThreshold.add(0.6), peak);
      const bloomNode: N = bloom(vec4(c.mul(gate), 1.0), p.bloomStrength, p.bloomRadius, 0);
      // 横向光条：把泛光的结果再沿水平方向拉长。路灯、车灯、招牌会拖出一道淡蓝色的横线，
      // 是变形宽银幕镜头拍夜景时的样子。在四分之一分辨率上做，几乎不花时间
      const streaks: N = profile !== 'garage' ? (gaussianBlur(bloomNode.getTextureNode(), vec2(7.0, 0.0), 14, { resolutionScale: 0.25 }) as N).rgb.mul(vec3(0.5, 0.72, 1.0)).mul(p.streak) : vec3(0.0);

      // 暗角
      const d: N = screenUV.sub(0.5).mul(vec2(1.0, 0.82)).length();
      const vig: N = float(1).sub(smoothstep(0.32, 0.9, d).mul(p.vignette));

      // 先做色调映射，再在显示空间里调色和抗锯齿：
      // HDR 高亮边缘（霓虹、灯带）靠多重采样是抹不平的
      const display: N = renderOutput(vec4(hdr.add(bloomNode.rgb).add(streaks).mul(vig), 1.0));
      // 调色：分离色调 → 饱和度 → 对比度
      const luma: N = dot(display.rgb, vec3(0.2126, 0.7152, 0.0722));
      let g: N = display.rgb.mul(mix(p.shadowTint, p.highlightTint, smoothstep(0.04, 0.7, luma)));
      g = mix(vec3(dot(g, vec3(0.2126, 0.7152, 0.0722))), g, p.saturation);
      g = clamp(g.sub(0.42).mul(p.contrast).add(0.42), 0, 1);
      const aa: N = fxaa(vec4(g, 1.0));
      if (!f.lens) return aa;

      // 镜头：画面边缘红蓝两个通道往外、往里错开一点（色散），再叠一层很淡的颗粒
      const tex: N = convertToTexture(aa);
      const raw: N = uv();
      // 镜头上的水滴：每颗水珠像一个小透镜，把它后面的画面折射、倒过来
      const aspect: N = screenSize.x.div(screenSize.y);
      const drops: N = dropletField(raw.mul(vec2(aspect, 1.0)), time, p.droplets);
      const bend: N = drops.xy.mul(vec2(float(1).div(aspect), 1.0)).mul(-0.03).mul(smoothstep(0.0, 0.05, p.droplets));
      const at: N = raw.add(bend);
      const off: N = at.sub(0.5);
      const shift: N = off.mul(dot(off, off)).mul(p.aberration).mul(0.03);
      const lens: N = vec3(tex.sample(at.add(shift)).r, tex.sample(at).g, tex.sample(at.sub(shift)).b);
      // 水珠边缘压暗一圈、整体提亮一点，看起来有厚度
      const dropMask: N = drops.z.clamp(0, 1).mul(smoothstep(0.0, 0.05, p.droplets));
      const wet: N = lens.mul(float(1).sub(dropMask.mul(float(1).sub(dropMask)).mul(0.3))).add(dropMask.mul(0.015));
      const noise: N = rand(raw.add(fract(time))).sub(0.5);
      return vec4(wet.add(noise.mul(p.grain)), 1.0);
    };

    this.outputs = { garage: compose('garage'), drive: compose('drive'), cinema: compose('cinema') };
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = this.outputs[this.profile];
  }

  /** 切换后期配置（进出试驾时调用） */
  setProfile(profile: PostProfile): void {
    if (profile === this.profile) return;
    this.profile = profile;
    this.pipeline.outputNode = this.outputs[profile];
    this.pipeline.needsUpdate = true;
  }

  /** GPU 上一帧主画面的耗时（毫秒）。只有带 prof=1 启动时才有数 */
  async gpuMs(): Promise<number> {
    if (!this.profiling) return 0;
    await this.renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
    return this.renderer.info.render.timestamp;
  }

  /** 车库用的默认画面参数。离开试驾时调用 */
  resetLook(): void {
    const p = this.post;
    p.bloomStrength.value = 0.24;
    p.bloomRadius.value = 0.5;
    p.bloomThreshold.value = 2.2;
    p.contrast.value = 1.0;
    p.saturation.value = 1.0;
    p.shadowTint.value.setRGB(1, 1, 1);
    p.highlightTint.value.setRGB(1, 1, 1);
    p.shutter = 0;
    p.droplets.value = 0;
    p.speed.value = 0;
    p.streak.value = 0;
    p.vignette.value = 0.42;
    p.aberration.value = 0.16;
    this.renderer.toneMappingExposure = 1.0;
  }

  onUpdate(fn: Updater): void {
    this.updaters.push(fn);
  }

  /** 主画面渲染完之后调用（反射探针这类"为下一帧准备"的离屏渲染放这里） */
  onAfterRender(fn: () => void): void {
    this.afterRender.push(fn);
  }

  /**
   * three.js 的"每帧只算一次"的节点（主画面、阴影、各个后期）是按帧号判断的，
   * 帧号由浏览器的动画循环推进。手动出帧（截图、性能测试）时要自己推进它，
   * 否则渲染出来的还是上一帧的画面。
   */
  private advanceFrame(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = this.renderer as any;
    r._nodes.nodeFrame.update();
    r.info.frame = r._nodes.nodeFrame.frameId;
  }

  /**
   * 抓取一帧原尺寸画面。自己出帧再读画布，不依赖动画循环
   * （页面在后台时浏览器会暂停 requestAnimationFrame）。
   */
  async capture(): Promise<Blob> {
    // 连出几帧：让阴影、反射探针、运动模糊的速度缓冲都稳定下来
    for (let i = 0; i < 4; i++) {
      this.advanceFrame();
      this.tick(this.last + 1000 / 60);
    }
    // 画布读到的是"上一次提交"的画面，所以要先让出一拍等这一帧提交
    await new Promise((r) => setTimeout(r, 80));
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('读取画布失败'))), 'image/png');
    });
  }

  /**
   * 性能测试：不等垂直同步，按 60 帧/秒的步长连续出帧，返回平均每帧耗时（毫秒）。
   * 所有帧提交完之后等 GPU 把活全部干完再停表，所以量到的是 CPU + GPU 的真实吞吐。
   */
  async benchmark(frames = 120): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const device = (this.renderer.backend as any).device as { queue: { onSubmittedWorkDone(): Promise<void> } } | undefined;
    if (!device) return 0;
    for (let i = 0; i < 12; i++) {
      this.advanceFrame();
      this.tick(this.last + 1000 / 60);
    }
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      this.advanceFrame();
      this.tick(this.last + 1000 / 60);
    }
    await device.queue.onSubmittedWorkDone();
    return (performance.now() - t0) / frames;
  }

  resize(): void {
    // 界面的尺寸，不是窗口的：手机竖着拿的时候界面是转过来的（见 viewport.ts）
    const { width: w, height: h } = appSize();
    // 高分屏上窗口一大，像素数就翻几倍；后期是按像素算钱的，所以给渲染分辨率设个上限，
    // 超过的部分由浏览器拉伸显示
    let ratio = Math.min(window.devicePixelRatio, 2);
    if (this.maxPixels > 0) ratio = Math.min(ratio, Math.sqrt(this.maxPixels / (w * h)));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 推进一帧：更新、渲染、统计帧率。正常由动画循环调用 */
  tick(now: number): void {
    const dt = Math.min(Math.max(now - this.last, 0) / 1000, 0.1);
    this.last = now;
    const t = now / 1000;
    for (const fn of this.updaters) fn(dt, t);
    // 模糊长度 = 速度 × 快门时间；速度缓冲里是"每帧位移"，所以要除以帧时间
    this.post.motionScale.value = dt > 0.001 ? Math.min(this.post.shutter / dt, 3.2) : 0;
    this.pipeline.render();
    for (const fn of this.afterRender) fn();

    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }

  start(): void {
    this.last = performance.now();
    this.renderer.setAnimationLoop((now: number) => this.tick(now));
  }
}
