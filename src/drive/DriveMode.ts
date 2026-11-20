import * as THREE from 'three/webgpu';
import type { Engine } from '../core/Engine';
import type { Car } from '../car/Car';
import { Hud } from '../ui/hud.ts';
import { ChaseCamera } from './ChaseCamera.ts';
import { Input } from './Input.ts';
import { CarFx } from '../fx/CarFx.ts';
import { CAR_BASES, carLength, vehicleConfig, type CarModel } from '../car/models.ts';
import { PHYSICS_DT, PhysicsWorld } from './PhysicsWorld.ts';
import { TireSpray } from './TireSpray.ts';
import { CityWorld } from '../city/CityWorld.ts';
import { CityLightmap, flatGround } from '../city/cityLights.ts';
import { MountainWorld } from '../mountain/MountainWorld.ts';
import { float } from 'three/tsl';
import { ShowPilot } from './ShowPilot.ts';
import { CineCamera } from './CineCamera.ts';
import { RacePilot } from '../race/RacePilot.ts';
import { isTouch as TOUCH } from '../core/viewport.ts';
import { CarLights } from './CarLights.ts';
import { CarProbe } from './CarProbe.ts';
import type { DriveWorld } from './DriveWorld.ts';
import { TestTrack } from './TestTrack.ts';
import { NO_INPUT, Vehicle, type DriveInput } from './Vehicle.ts';
import type { GameAudio, RivalSound } from '../audio/GameAudio.ts';
import type { RaceEvent } from '../race/RaceDirector.ts';
import { RaceMarkers, type MarkerHost } from '../race/RaceMarkers.ts';
import { RaceSession, RivalPool, type RaceOptions } from '../race/RaceSession.ts';
import { formatTime, RaceHud } from '../ui/raceHud.ts';
import { IntroOverlay } from '../ui/raceIntroUi.ts';
import { RaceIntro, type IntroCar } from '../race/RaceIntro.ts';
import { fitFov } from '../core/fov.ts';
import { paintFlakeGain } from '../car/paint';
import { TouchPad } from '../ui/touch.ts';
import { isTouch } from '../core/viewport.ts';
import { QUALITY } from '../core/quality.ts';

/** 积雪铺满时轮胎抓地力掉多少 */
const SNOW_GRIP_LOSS = 0.2;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 试驾模式需要外面（主程序）配合的几件事 */
export interface DriveHooks {
  /** 玩家要求暂停 / 打开菜单 */
  onPause(): void;
  /** 玩家要求直接退出（自由驾驶里按 G） */
  onExit(): void;
  /** 玩家冲线之后过了一小会儿：该弹结算了 */
  onRaceFinished(): void;
}

/** 能开进去的地图：城市赛道、山路赛道、灰盒测试场 */
export type MapId = 'city' | 'mountain' | 'test';

/** 一张地图，以及跟着它走的那些东西（自动驾驶认的是它的赛道，比赛的标记和界面也是按它的赛道建的） */
interface Venue {
  id: MapId;
  world: DriveWorld;
  autopilot: ShowPilot | null;
  markers: RaceMarkers | null;
  raceHud: RaceHud | null;
}

/**
 * 试驾模式：把物理、测试场、输入、镜头、界面串起来。
 * 物理按 120 Hz 固定步长推进，画面在两个物理状态之间插值，所以帧率波动不影响手感。
 */
export class DriveMode {
  active = false;
  readonly vehicle: Vehicle;
  /** 当前的地图：城市赛道、山路赛道或灰盒测试场。用到哪张才生成哪张，生成过的留着，换回去不用再等 */
  get world(): DriveWorld {
    return this.venue.world;
  }
  /** 当前是哪张地图 */
  get mapId(): MapId {
    return this.venue.id;
  }
  /**
   * 自动驾驶（有赛道的地图才有）。按 P 开关，用来看一圈或者录视频。
   * 是表演式的开法：直道开氮气，急弯漂过去（见 ShowPilot.ts）
   */
  get autopilot(): ShowPilot | null {
    return this.venue.autopilot;
  }
  autopilotOn = false;
  /**
   * 电影镜头：自动驾驶时在一组机位之间切来切去（见 CineCamera）。打开自动驾驶时默认开着，
   * 按换镜头的键回到平时的机位，再按一圈又回来
   */
  cineOn = false;
  private readonly cine: CineCamera;
  private cineBars = 0;
  private cineAge = 0;
  private cineUi = false;
  /** 比赛里替玩家开车的自动驾驶（每场比赛一个） */
  private racePilot: RacePilot | null = null;
  readonly chase: ChaseCamera;
  readonly input = new Input();
  /** 触屏上的按钮（只有触屏设备有） */
  readonly touch: TouchPad | null;
  readonly hud: Hud;
  /** 大灯、尾灯地面光、车底阴影 */
  readonly carLights: CarLights;
  /** 湿地面上的轮胎水雾 */
  readonly spray: TireSpray;
  /** 轮胎烟、翅膀、火花、胎痕这些随驾驶触发的特效 */
  readonly fx: CarFx;
  private readonly smokeLight = new THREE.Color();
  private readonly smokeKey = new THREE.Color();
  /** 调试用：设置后覆盖键盘和手柄输入 */
  scriptedInput: DriveInput | null = null;
  /** 正在进行的比赛；自由驾驶时是 null */
  race: RaceSession | null = null;
  /** 暂停中：画面还在渲染，但什么都不动 */
  paused = false;
  get raceHud(): RaceHud | null {
    return this.venue.raceHud;
  }
  readonly audio: GameAudio;

  private readonly engine: Engine;
  private readonly car: Car;
  private readonly physics: PhysicsWorld;

  private acc = 0;
  private time = 0;
  private leanRoll = 0;
  private leanPitch = 0;
  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currQuat = new THREE.Quaternion();
  private readonly renderPos = new THREE.Vector3();
  private readonly renderQuat = new THREE.Quaternion();
  private readonly fwd = new THREE.Vector3();
  private readonly fog = new THREE.FogExp2(0x000000, 0.001);
  private readonly background = new THREE.Color();
  private environment: THREE.Texture | null = null;
  private probe: CarProbe | null = null;
  private venue!: Venue;
  private readonly venues = new Map<MapId, Venue>();
  /**
   * 特效用的地面光照图「替身」：轮胎烟、水雾的材质只建一次，它们查这张替身；
   * 换地图时让替身跟着新地图的光照图走（见 CityLightmap.follow）
   */
  private readonly air = new CityLightmap({ ground: flatGround() });
  private readonly probePos = new THREE.Vector3();
  private readonly carVel = new THREE.Vector3();
  private readonly mist = new THREE.Color();
  private droplets = 0;
  /** 进入试驾后先正常渲染几帧（让阴影等初始化），再开始拍探针 */
  private probeWarm = 0;
  private readonly hooks: DriveHooks;
  private pool: RivalPool | null = null;
  private get markers(): RaceMarkers | null {
    return this.venue.markers;
  }
  /** 只照对手车的一盏聚光灯：城市地面上的大灯光束是着色器里算的，照不到别的车 */
  private readonly headLamp: THREE.SpotLight;
  private readonly rivalSounds: RivalSound[] = [];
  private readonly rivalDistance: number[] = [];
  private readonly camRight = new THREE.Vector3();
  /** 玩家冲线后，隔多久弹结算（< 0 表示没在等） */
  private finishTimer = -1;
  private wrongWay = 0;
  /** 速度感 0–1：车速和氮气算出来的，平滑过 */
  private rush = 0;
  /** 驾驶室视角的曝光补偿，0–1 平滑过渡 */
  private cockpitGain = 0;
  /** 刚撞过：画面抖一下色散（撞击瞬间拉满，五分之一秒内退掉） */
  private hit = 0;
  /** 赛前的特写镜头（没在放的时候是 null） */
  private intro: RaceIntro | null = null;
  private readonly introUi: IntroOverlay;
  private readonly hudRoot: HTMLElement;
  /** 电影黑边收放 0–1 */
  private introBars = 0;
  /** 跳过键要先松开过一次才算数：点「出发」时按着的空格不能把镜头直接跳掉 */
  private introSkipArmed = false;
  /** 赛前镜头的两盏灯：主光（暖白，在镜头一侧的斜上方）和轮廓光（偏冷，在车后方）。城市的材质不吃它们，只照得到车 */
  private readonly introLight = new THREE.PointLight(0xfff0dc, 0, 16, 1.5);
  private readonly introRim = new THREE.PointLight(0xa8c8ff, 0, 16, 1.5);
  private readonly introDir = new THREE.Vector3();
  private readonly introPos = new THREE.Vector3();
  private readonly introQuat = new THREE.Quaternion();

  /** map：'city'（默认）城市赛道，'mountain' 山路赛道，'test' 灰盒测试场 */
  /**
   * time：起始时段 'day' / 'dusk' / 'night'；weather：起始天气 'clear' / 'rain' / 'fog'
   * （只对有昼夜和天气的地图有效）
   */
  static async create(
    engine: Engine,
    car: Car,
    hudRoot: HTMLElement,
    hooks: DriveHooks,
    audio: GameAudio,
    map = 'city',
    time: string | null = null,
    weather: string | null = null,
  ): Promise<DriveMode> {
    const physics = await PhysicsWorld.create();
    return new DriveMode(engine, car, physics, hudRoot, hooks, audio, map, time, weather);
  }

  private constructor(
    engine: Engine,
    car: Car,
    physics: PhysicsWorld,
    hudRoot: HTMLElement,
    hooks: DriveHooks,
    audio: GameAudio,
    map: string,
    time: string | null,
    weather: string | null,
  ) {
    this.engine = engine;
    this.car = car;
    this.physics = physics;
    this.hooks = hooks;
    this.audio = audio;

    this.hudRoot = hudRoot;
    // 替身光照图先烤一张空的（没有灯、头顶全是露天），再让它跟着地图走
    this.air.bake([], []);
    this.venue = this.buildVenue(map === 'test' || map === 'mountain' ? map : 'city', time, weather);
    this.air.follow(this.world.lightmap ?? null);
    this.headLamp = new THREE.SpotLight(0xdde8ff, 0, 80, 0.42, 0.8, 1.6);
    this.headLamp.visible = false;
    engine.scene.add(this.headLamp, this.headLamp.target);
    this.spray = new TireSpray(
      (p) => this.air.airLight(p),
      (p) => float(1).sub(this.air.cover(p)),
    );
    engine.fx.add(this.spray.group);
    this.carLights = new CarLights(car);
    engine.onAfterRender(() => this.updateProbe(QUALITY.probeFaces));

    this.vehicle = new Vehicle(physics, vehicleConfig(car.model));
    this.chase = new ChaseCamera(engine.camera);
    this.chase.fitCar(car);
    this.cine = new CineCamera(engine.camera, physics);
    this.fx = new CarFx(car, (p) => this.air.airLight(p));
    this.fx.fxGroup.visible = false;
    this.fx.sceneGroup.visible = false;
    engine.fx.add(this.fx.fxGroup);
    engine.scene.add(this.fx.sceneGroup);
    this.hud = new Hud(hudRoot, () => this.hooks.onPause(), this.worldLabel());
    this.introUi = new IntroOverlay(hudRoot);
    this.touch = isTouch
      ? new TouchPad(hudRoot, (a) => {
          if (a === 'pause') {
            if (this.intro) this.intro.skip();
            else this.hooks.onPause();
          } else this.input.trigger(a);
        })
      : null;
    this.input.touch = this.touch;
    // 赛前镜头：点一下屏幕也能跳过（触屏上没有空格键）
    engine.renderer.domElement.addEventListener('pointerdown', () => {
      if (this.intro && this.introSkipArmed) this.intro.skip();
    });
    engine.scene.add(this.introLight, this.introRim);
    // 回车也能跳过赛前镜头（空格和手柄按键走的是下面每帧读输入的那条路）
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' && this.intro && this.introSkipArmed) this.intro.skip();
    });

    this.input.on('reset', () => {
      if (this.race) {
        // 比赛中：倒计时的时候不让动；之后是放回赛道中间
        if (!this.race.director.live || this.race.playerOnAuto) return;
        this.race.respawnPlayer();
        this.afterTeleport();
        this.hud.flash('回到赛道');
        return;
      }
      this.upright();
      this.hud.flash('已复位');
    });
    this.input.on('pause', () => {
      // 赛前镜头期间按暂停键：先跳过镜头
      if (this.intro) this.intro.skip();
      else this.hooks.onPause();
    });
    this.input.on('camera', () => {
      // 自动驾驶时多一个「电影镜头」：电影镜头 → 追尾（远）→ 追尾（近）→ 车头 → 驾驶室 → 电影镜头
      if (this.cineOn) {
        this.setCine(false);
        this.hud.flash(this.chase.modeName);
        return;
      }
      this.chase.nextMode();
      if (this.autopilotOn && this.chase.mode === 0) {
        this.setCine(true);
        return;
      }
      this.hud.flash(this.chase.modeName);
    });
    // G：自由驾驶时直接回主菜单。比赛中不响应，免得误触
    this.input.on('exit', () => {
      if (!this.race) this.hooks.onExit();
    });
    this.input.on('help', () => this.hud.toggleHelp());
    this.input.on('telemetry', () => this.hud.toggleTelemetry());
    this.input.on('time', () => this.option('time', true));
    this.input.on('weather', () => this.option('weather', true));
    this.input.on('autopilot', () => this.option('autopilot', true));
  }

  /**
   * 三个选项：换时段、换天气、自动驾驶开关。键盘上是 L、K、P，暂停菜单里也有（手机上没有键盘）。
   * 时段和天气只在自由驾驶时能换；自动驾驶在比赛里也能开（见 RacePilot）。
   * @param act true = 执行；false = 只问这一项现在该显示什么字
   * @returns 这一项现在的样子，例如「时段 · 黄昏」
   */
  option(kind: 'time' | 'weather' | 'autopilot', act: boolean): string {
    if (act && (!this.race || kind === 'autopilot')) {
      if (kind === 'time') {
        const name = this.world.cycleTime?.();
        this.hud.flash(name ? `时段：${name}` : '这张图没有昼夜');
        this.hud.setLabel(this.worldLabel());
      } else if (kind === 'weather') {
        const name = this.world.cycleWeather?.();
        this.hud.flash(name ? `天气：${name}` : '这张图没有天气');
        this.hud.setLabel(this.worldLabel());
      } else if (!this.autopilot) {
        this.hud.flash('这张图没有自动驾驶');
      } else {
        this.setAutopilot(!this.autopilotOn);
        this.hud.flash(this.autopilotOn ? '自动驾驶 开 · 漂移加氮气' : '自动驾驶 关');
      }
    }
    if (kind === 'time') return `时段 · ${this.world.timeName ?? '—'}`;
    if (kind === 'weather') return `天气 · ${this.world.weatherName ?? '—'}`;
    return `自动驾驶 · ${this.autopilotOn ? '开' : '关'}`;
  }

  /**
   * 生成一张地图和跟着它走的东西。两张地图的碰撞体都在同一个物理世界里（位置是重叠的），
   * 各归各的一组，同一时间只开着当前这张的。
   */
  private buildVenue(id: MapId, time: string | null = null, weather: string | null = null): Venue {
    const { engine, physics, car } = this;
    physics.beginGroup(id);
    const world: DriveWorld = id === 'test' ? new TestTrack(physics) : id === 'mountain' ? new MountainWorld(physics) : new CityWorld(physics);
    world.onLightning = () => this.audio.thunder(0.35 + Math.random() * 0.9);
    world.group.visible = false;
    engine.scene.add(world.group);
    if (time) world.setTime?.(time, true);
    if (weather) world.setWeather?.(weather, true);
    world.buildEnvironment(engine.renderer);
    // 地图自己的特效（雨丝、闪电）放进引擎的特效叠加层
    if (world.fxGroup) {
      world.fxGroup.visible = false;
      engine.fx.add(world.fxGroup);
    }
    if (world.dynamicReflections && !this.probe) this.probe = new CarProbe(engine.renderer, engine.scene);
    const venue: Venue = { id, world, autopilot: null, markers: null, raceHud: null };
    const track = world.track;
    if (track && world.adopt) {
      venue.autopilot = new ShowPilot(track);
      venue.autopilot.tuneFor(vehicleConfig(car.model));
      // 比赛用的东西：对手的车（两张地图共用）、赛道上的标记、比赛界面。平时都藏着
      if (!this.pool) {
        this.pool = new RivalPool(physics, car);
        this.pool.group.visible = false;
        engine.scene.add(this.pool.group);
      }
      venue.markers = new RaceMarkers(world as DriveWorld & MarkerHost, track.samples[0], id === 'mountain' ? 'CLOUD RIDGE' : 'NEON BAY');
      engine.scene.add(venue.markers.sceneGroup);
      engine.fx.add(venue.markers.fxGroup);
      venue.raceHud = new RaceHud(this.hudRoot, track);
    }
    this.venues.set(id, venue);
    return venue;
  }

  /** 这张地图是不是已经生成过了（没有的话 setMap 要花几秒钟） */
  hasMap(id: MapId): boolean {
    return this.venues.has(id);
  }

  /** 换一张地图。只在没在开车的时候调用（主菜单里选了另一条赛道）；第一次换到某张地图时要现生成 */
  setMap(id: MapId, time: string | null = null, weather: string | null = null): void {
    if (id === this.venue.id) return;
    const prev = this.venue;
    this.endRace();
    this.autopilotOn = false;
    prev.world.group.visible = false;
    if (prev.world.fxGroup) prev.world.fxGroup.visible = false;
    prev.markers?.setVisible(false);
    prev.raceHud?.show(false);
    this.physics.setGroupEnabled(prev.id, false);
    this.venue = this.venues.get(id) ?? this.buildVenue(id, time, weather);
    this.physics.setGroupEnabled(id, true);
    this.air.follow(this.world.lightmap ?? null);
    // 环境贴图、雪地车辙、水雾都是上一张地图的：清掉重来
    this.environment = null;
    this.spray.clear();
    this.fx.reset();
    this.hud.setLabel(this.worldLabel());
  }

  setAutopilot(on: boolean): void {
    if (!this.autopilot) return;
    this.autopilotOn = on;
    if (on) {
      const t = this.vehicle.body.translation();
      this.autopilot.reset(t.x, t.z);
    }
    // 自动驾驶是用来看的：打开的时候直接进电影镜头
    this.setCine(on);
  }

  /** 开关电影镜头（只在自动驾驶时有意义） */
  setCine(on: boolean): void {
    this.cineOn = on && this.autopilotOn;
    this.hudRoot.classList.toggle('cine', this.cineOn);
    if (this.cineOn) {
      this.cine.reset();
      this.cineAge = 0;
    } else {
      this.engine.post.bokeh.value = 0;
    }
  }

  /** 每帧在追尾镜头算完之后：电影镜头开着的话由它来摆机位，并把上下的黑边收进来 */
  private updateCine(dt: number, intro: boolean): void {
    const on = this.cineOn && this.autopilotOn && !intro;
    this.cineBars += ((on ? 1 : 0) - this.cineBars) * (1 - Math.exp(-dt * 6));
    if (on) {
      this.cine.update(dt, this.renderPos, this.renderQuat, this.vehicle, this.world);
      this.cine.cut = false;
      this.cineAge += dt;
      const post = this.engine.post;
      post.focusDistance.value = this.cine.focus;
      post.bokeh.value = this.cine.delegate ? 0 : this.cine.bokeh * 3;
    }
    if (intro) return;
    if (this.cineBars > 0.01) {
      if (!this.cineUi) {
        this.cineUi = true;
        this.introUi.show(true);
      }
      // 那行小字露几秒就淡掉，不挡画面
      const fade = Math.min(1, Math.max(0, (5 - this.cineAge) / 1.2));
      this.introUi.cine(this.cineBars, TOUCH ? '电影镜头 · 点「镜头」换回普通视角' : '电影镜头 · 按 V 换回普通视角', on ? fade : 0);
    } else if (this.cineUi) {
      this.cineUi = false;
      this.introUi.show(false);
    }
  }

  /** 界面左上角的标签：地图名 + 当前时段 */
  private worldLabel(): string {
    const parts = [this.world.label, this.world.timeName, this.world.weatherName].filter((x): x is string => !!x);
    if (!this.race) parts.push('自由驾驶');
    return parts.join(' · ');
  }

  /** 更新反射探针：从车身中部往外拍，拍的时候把车藏起来 */
  private updateProbe(faces: number): void {
    if (!this.probe || !this.active || !this.world.dynamicReflections) return;
    if (this.probeWarm > 0) {
      this.probeWarm--;
      // 最后一帧预热时把六个面一次拍全，车一出场反射就是对的
      if (this.probeWarm > 0) return;
      faces = 6;
    }
    this.probePos.copy(this.car.root.position);
    this.probePos.y += 0.95;
    this.world.pauseShadows?.(true);
    this.probe.update(this.probePos, [this.car.root], faces);
    this.world.pauseShadows?.(false);
  }

  /** 车库里换了车型：物理调校和镜头机位跟着换。只在不开车的时候调用 */
  setCarModel(): void {
    const cfg = vehicleConfig(this.car.model);
    this.vehicle.configure(cfg);
    for (const v of this.venues.values()) v.autopilot?.tuneFor(cfg);
    this.chase.fitCar(this.car);
  }

  /** 把地图当前的画面外观（雾、曝光、环境贴图、后期参数）写进渲染器 */
  private applyLook(): void {
    const k = this.world.look;
    const { scene, renderer, post } = this.engine;
    this.fog.color.copy(k.fogColor);
    this.fog.density = k.fogDensity;
    this.background.copy(k.fogColor);
    const env = k.environment;
    if (env && env !== this.environment) {
      this.environment = env;
      scene.environment = env;
      this.car.setEnvironment(env);
    }
    scene.environmentIntensity = k.environmentIntensity;
    // 驾驶室视角：画面下半截是车内，整体偏暗，眼睛会自己适应——曝光提一点（夜里提得多）
    const inCockpit = this.active && this.chase.modeName === '驾驶室';
    this.cockpitGain += ((inCockpit ? 1 : 0) - this.cockpitGain) * 0.08;
    renderer.toneMappingExposure = k.exposure * (1 + this.cockpitGain * (0.1 + 0.2 * k.night));
    this.car.setCockpit(inCockpit, k.night);
    post.bloomStrength.value = k.bloomStrength;
    post.bloomThreshold.value = k.bloomThreshold;
    post.bloomRadius.value = k.bloomRadius;
    post.contrast.value = k.contrast;
    post.saturation.value = k.saturation;
    post.shadowTint.value.copy(k.shadowTint);
    post.highlightTint.value.copy(k.highlightTint);
    // 速度感：车速越快、尤其是开氮气的时候，运动模糊越长、画面四周拉丝、边缘色散和暗角都加重
    const v = this.vehicle;
    const speedN = clamp((v.speed - 18) / 56, 0, 1);
    // 猛加速（大脚油门把人按在座椅上的那一段）也算进去，不只看车速
    const surge = clamp((v.longG - 0.25) / 0.5, 0, 1) * clamp(v.speed / 30, 0, 1);
    const target = this.active ? clamp(speedN * speedN * 0.62 + surge * 0.26 + (v.nitroActive ? 0.85 : 0), 0, 1) : 0;
    // 拉丝也是渐渐变长的（约五分之一秒），不跟着氮气键一下子跳到最长
    this.rush += (target - this.rush) * (target > this.rush ? 0.08 : 0.05);
    const cockpit = this.chase.modeName === '驾驶室';
    // 快门：平时 1/125 秒，全速加氮气时放到 1/28（街景拉成长长的丝）。驾驶室视角下画面本来就晃，减半
    post.shutter = (1 / 125 + this.rush * (1 / 28 - 1 / 125)) * (cockpit ? 0.5 : 1);
    post.speed.value = this.rush * (cockpit ? 0.6 : 1);
    post.aberration.value = 0.16 + this.rush * 1.1 + this.hit * 2.2;
    post.vignette.value = 0.42 + this.rush * 0.38 + this.hit * 0.18;
    post.streak.value = 0.1 + 0.34 * k.night;
    // 赛前镜头：按电影的路子再调一道——反差和颜色浓一点，暗角重一点，灯的光晕和横向光条多一点，边缘色散收掉
    if (this.intro) {
      const g = 1 - this.intro.handoff;
      post.contrast.value *= 1 + 0.07 * g;
      post.saturation.value *= 1 + 0.06 * g;
      post.bloomStrength.value *= 1 + 0.15 * g;
      post.streak.value += 0.16 * g * k.night;
      post.vignette.value += 0.2 * g;
      post.aberration.value = 0.16 - 0.08 * g + this.hit * 2.2;
    }
  }

  enter(): void {
    this.active = true;
    const scene = this.engine.scene;
    scene.fog = this.fog;
    scene.background = this.background;
    this.environment = null;
    this.applyLook();
    this.world.group.visible = true;
    if (this.world.fxGroup) this.world.fxGroup.visible = true;
    this.fx.fxGroup.visible = true;
    this.fx.sceneGroup.visible = true;
    // 车身的反射改用跟车的实时探针
    if (this.probe && this.world.dynamicReflections) this.car.setEnvNode(this.probe.envNode);
    this.probeWarm = 3;
    this.input.enabled = true;
    this.paused = false;
    this.hud.show(true);
    this.touch?.show(true);
    this.hud.setLabel(this.worldLabel());
    this.car.driven = true;
    if (this.pool) this.pool.group.visible = true;
    this.audio.setDriving(true);
    this.respawn();
    // 触屏：提醒一下油门是自动的（不然不知道该按哪个键走）
    if (this.touch && !this.race) this.hud.flash(this.touch.auto ? '自动油门 · 碰一下任意按钮出发' : '右下角是油门');
  }

  exit(): void {
    this.endRace();
    this.active = false;
    this.paused = false;
    this.setAutopilot(false);
    this.autopilotOn = false;
    this.cineBars = 0;
    if (this.cineUi) {
      this.cineUi = false;
      this.introUi.show(false);
    }
    if (this.pool) this.pool.group.visible = false;
    this.headLamp.visible = false;
    this.audio.setDriving(false);
    this.audio.suspend(false);
    this.world.group.visible = false;
    this.input.enabled = false;
    this.hud.show(false);
    this.touch?.show(false);
    this.fx.off();
    this.fx.fxGroup.visible = false;
    this.fx.sceneGroup.visible = false;
    this.carLights.off();
    this.spray.clear();
    if (this.world.fxGroup) this.world.fxGroup.visible = false;
    this.car.setEnvNode(null);
    this.car.resetPose();
  }

  /** 暂停 / 继续 */
  setPaused(on: boolean): void {
    this.paused = on;
    this.input.enabled = !on && this.active;
    this.touch?.show(!on && this.active);
    // 暂停时只把开车的声音收掉：菜单的提示音还要能响
    this.audio.setDriving(!on && this.active);
  }

  /** 开始一场比赛（已经在比赛中的话，重新开始） */
  startRace(options: RaceOptions): boolean {
    const track = this.world.track;
    if (!this.pool || !this.markers || !track) return false;
    this.race?.dispose();
    this.setAutopilot(false);
    this.scriptedInput = null;
    this.race = new RaceSession(track, this.pool, this.markers, this.vehicle, this.car, options);
    this.racePilot = this.autopilot ? new RacePilot(this.autopilot, this.race.field, track.length) : null;
    this.race.lineUp();
    // 所有车一起空跑一小段，让悬挂落稳
    for (let i = 0; i < 40; i++) {
      this.vehicle.step(NO_INPUT, PHYSICS_DT);
      this.race.prePhysics(PHYSICS_DT);
      this.physics.step();
    }
    this.race.postPhysics();
    this.vehicle.nitro = 1;
    this.afterTeleport();
    this.spray.clear();
    this.fx.reset();
    this.finishTimer = -1;
    this.wrongWay = 0;
    this.headLamp.visible = true;
    this.hud.setRacing(true);
    this.hud.setLabel(this.worldLabel());
    this.raceHud?.show(true);
    this.raceHud?.warning('');
    this.endIntro();
    if (options.intro !== false) this.beginIntro(this.race, options);
    return true;
  }

  /**
   * 赛前镜头的这一帧：把镜头从追尾机位挪到特写机位上（最后一个镜头再逐渐交还给追尾机位），
   * 设好景深，更新黑边和字幕；放完了就收尾。
   */
  private applyIntro(intro: RaceIntro, dt: number): void {
    const cam = this.engine.camera;
    const post = this.engine.post;
    if (intro.done) {
      this.endIntro();
      return;
    }
    const w = intro.handoff;
    // 此刻镜头在追尾机位上（上一行刚算的）：按交接的比例往特写机位混
    this.introPos.copy(intro.position).lerp(cam.position, w);
    this.introQuat.copy(intro.quaternion).slerp(cam.quaternion, w);
    cam.position.copy(this.introPos);
    cam.quaternion.copy(this.introQuat);
    cam.fov = fitFov(intro.fov + (this.chase.baseFov - intro.fov) * w, cam.aspect);
    cam.near = 0.08;
    cam.updateProjectionMatrix();
    post.focusDistance.value = intro.focus;
    post.bokeh.value = intro.bokeh * (1 - w);
    // 补光：像拍汽车广告那样围着被拍的车打两盏灯（城市的材质不吃它们，只照得到车）。
    // 主光在镜头一侧的斜上方——不能架在镜头上，那样像开了闪光灯，车身是平的一片；
    // 轮廓光在车的后方偏另一侧，给车顶和车肩勾一道亮边，把车从暗背景里分出来
    const sub = intro.subject;
    const toCam = this.introDir.subVectors(cam.position, sub).setY(0).normalize();
    const side = this.camRight.set(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
    this.introLight.position.copy(sub).addScaledVector(toCam, 2.4).addScaledVector(side, 3.6);
    this.introLight.position.y += 3.1;
    this.introRim.position.copy(sub).addScaledVector(toCam, -3.8).addScaledVector(side, -2.6);
    this.introRim.position.y += 1.9;
    // 白天画面的曝光低得多，同样亮的灯显得暗：白天给得更足
    const night = this.world.look.night;
    this.introLight.intensity = (72 - 42 * night) * (1 - w);
    this.introRim.intensity = (84 - 46 * night) * (1 - w);
    // 镜头贴得近、灯又是直射的：车漆的金属颗粒会变成一片噪点，这一段把颗粒压下去
    paintFlakeGain.value = 0.22 + 0.78 * w;
    // 黑边：开头收进来，交还镜头的时候退出去
    const target = 1 - w;
    this.introBars += (target - this.introBars) * (1 - Math.exp(-dt * 7));
    this.introUi.update(this.introBars, intro.caption);
  }

  /** 这辆车在开场镜头里的资料：位置、尺寸、名牌 */
  private introCar(v: Vehicle, model: CarModel, slot: number, name: string, color: string): IntroCar {
    const t = v.body.translation();
    const q = v.body.rotation();
    const base = CAR_BASES[model.base];
    const wheel = v.cfg.wheelPos[0];
    return {
      pos: new THREE.Vector3(t.x, t.y, t.z),
      quat: new THREE.Quaternion(q.x, q.y, q.z, q.w),
      length: carLength(model),
      height: base.height,
      wheelX: Math.abs(wheel[0]),
      wheelR: v.cfg.wheelRadius,
      wheelZ: wheel[2],
      // 发车格是左右两列：左列的车左边空着，右列的车右边空着
      side: slot % 2 === 0 ? 1 : -1,
      slot: slot + 1,
      name,
      model: model.base === 'gt' ? `${base.name} ${model.name}` : base.name,
      color,
    };
  }

  /** 开始放赛前的特写镜头：发车格先不倒数，开车的界面藏起来，画面换成带景深的那一套 */
  private beginIntro(race: RaceSession, options: RaceOptions): void {
    const rivals = race.rivals.map((r, i) => this.introCar(r.vehicle, r.visual.model, i, r.car?.racer.name ?? '', r.car?.racer.color ?? '#ffffff'));
    const me = race.director.player;
    const player = this.introCar(this.vehicle, this.car.model, rivals.length, '你', me?.color ?? '#ff3b2f');
    const parts = [this.world.label, `${options.laps} 圈`, `${rivals.length + 1} 辆车`, this.world.timeName, this.world.weatherName].filter((x): x is string => !!x);
    this.intro = new RaceIntro(player, rivals, { title: '街头赛', sub: parts.join(' · ') });
    this.introSkipArmed = false;
    this.introBars = 0;
    race.director.gridHeld = true;
    this.engine.setProfile('cinema');
    this.hudRoot.classList.add('cinematic');
    this.introUi.show(true);
    this.audio.whoosh(1);
  }

  /** 镜头放完（或者被跳过、比赛被中止）：恢复界面和画面配置，开始倒数 */
  private endIntro(): void {
    if (!this.intro) return;
    this.intro = null;
    this.race?.director.release();
    this.engine.setProfile('drive');
    this.engine.post.bokeh.value = 0;
    this.introLight.intensity = 0;
    this.introRim.intensity = 0;
    paintFlakeGain.value = 1;
    this.hudRoot.classList.remove('cinematic');
    this.introUi.show(false);
  }

  /** 结束比赛，回到自由驾驶的状态（车留在原地） */
  endRace(): void {
    if (!this.race) return;
    this.race.dispose();
    this.race = null;
    this.racePilot = null;
    this.setAutopilot(false);
    this.vehicle.hold = false;
    this.finishTimer = -1;
    this.headLamp.visible = false;
    this.world.setRivalLighting?.([]);
    this.hud.setRacing(false);
    this.hud.setLabel(this.worldLabel());
    this.raceHud?.show(false);
    this.endIntro();
  }

  /** 车被瞬间挪到别处之后：画面状态和镜头跟过去 */
  private afterTeleport(): void {
    this.vehicle.landingImpact = 0;
    this.vehicle.collisionImpact = 0;
    this.readBody();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.acc = 0;
    this.leanRoll = 0;
    this.leanPitch = 0;
    this.chase.snap(this.currPos, this.currQuat);
    this.cine.reset();
  }

  /** 回到起点 */
  respawn(): void {
    const s = this.world.start;
    this.place(s.x, s.z, s.yaw);
    this.vehicle.nitro = 1;
    this.spray.clear();
    this.fx.reset();
    this.world.resetProps();
    if (this.autopilotOn) this.autopilot?.reset(s.x, s.z);
  }

  /** 原地扶正（翻车、卡住时用） */
  upright(): void {
    const t = this.vehicle.body.translation();
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.currQuat);
    const fallen = t.y < (this.world.groundAt?.(t.x, t.z) ?? 0) - 5;
    if (fallen) this.respawn();
    else this.place(t.x, t.z, Math.atan2(f.x, f.z));
  }

  private place(x: number, z: number, yaw: number): void {
    this.vehicle.reset(x, (this.world.groundAt?.(x, z) ?? 0) + 0.06, z, yaw);
    // 先空跑一小段让悬挂落稳，避免出场时弹一下
    for (let i = 0; i < 40; i++) {
      this.vehicle.step(NO_INPUT, PHYSICS_DT);
      this.physics.step();
    }
    this.afterTeleport();
  }

  private readBody(): void {
    const t = this.vehicle.body.translation();
    const r = this.vehicle.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  /** 调试用：不渲染，直接推进一段物理时间 */
  simulate(seconds: number, input: Partial<DriveInput> = {}): void {
    const inp = { ...NO_INPUT, ...input };
    const steps = Math.round(seconds / PHYSICS_DT);
    for (let i = 0; i < steps; i++) {
      this.vehicle.step(inp, PHYSICS_DT);
      this.physics.step();
    }
    this.readBody();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.acc = 0;
  }

  update(dt: number): void {
    if (!this.active || this.paused) return;
    this.time += dt;
    const v = this.vehicle;
    const race = this.race;
    const ctl = this.input.read();
    let drive: DriveInput = this.scriptedInput ?? ctl;
    if (this.autopilotOn && this.autopilot && !this.scriptedInput) {
      if (race) {
        // 比赛里：还要看着别的车、等发车信号、卡死了放回赛道，这些归 RacePilot 管
        if (this.racePilot && race.field.player?.human) {
          drive = this.racePilot.drive(dt);
          if (this.racePilot.respawned) {
            this.racePilot.respawned = false;
            this.afterTeleport();
          }
        }
      } else {
        const f = this.fwd.set(0, 0, 1).applyQuaternion(this.currQuat);
        drive = this.autopilot.update(v, this.currPos.x, this.currPos.z, Math.atan2(f.x, f.z), dt);
      }
    }
    // 赛前镜头期间：玩家的输入不管用（只认跳过键），油门由镜头脚本来踩——轰油门给镜头配声音
    const intro = this.intro;
    if (intro) {
      const skipKey = ctl.handbrake || ctl.nitro;
      if (!skipKey) this.introSkipArmed = true;
      else if (this.introSkipArmed) intro.skip();
      intro.update(dt);
      drive = { ...NO_INPUT, throttle: intro.throttle, steer: intro.steer };
      if (intro.pop) this.fx.pop(1);
      if (intro.cut) {
        this.hit = Math.max(this.hit, 0.3);
        this.audio.whoosh(0.8);
      }
    }
    // 积雪让所有车的轮胎都更滑；AI 和自动驾驶过弯、刹车也跟着多留余量
    const grip = 1 - SNOW_GRIP_LOSS * this.world.look.snow;
    v.surfaceGrip = grip;
    if (this.autopilot) this.autopilot.grip = grip;
    race?.field.setGrip(grip);
    // 冲线之后车交给 AI 开：这时玩家的车也由比赛那边推进
    const onAuto = race?.playerOnAuto ?? false;
    if (onAuto && race?.field.player) drive = race.field.player.input;

    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= PHYSICS_DT && steps < 12) {
      this.prevPos.copy(this.currPos);
      this.prevQuat.copy(this.currQuat);
      if (!onAuto) v.step(drive, PHYSICS_DT);
      race?.prePhysics(PHYSICS_DT);
      this.physics.step();
      this.readBody();
      race?.postPhysics();
      this.acc -= PHYSICS_DT;
      steps++;
    }
    if (steps === 12) this.acc = 0;

    const a = this.acc / PHYSICS_DT;
    this.renderPos.lerpVectors(this.prevPos, this.currPos, a);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.currQuat, a);

    const car = this.car;
    car.root.position.copy(this.renderPos);
    car.root.quaternion.copy(this.renderQuat);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      car.setWheelPose(i, w.travel, w.steer, w.spin);
    }

    // 物理上的侧倾和点头幅度很小，这里再叠一层夸张的视觉姿态，过弯和加减速更有重量感
    const k = 1 - Math.exp(-dt * 7);
    this.leanRoll += (clamp(v.lateralG, -2, 2) * 0.02 - this.leanRoll) * k;
    this.leanPitch += (clamp(-v.longG, -1.6, 1.6) * 0.014 - this.leanPitch) * k;
    car.setBodyLean(this.leanRoll, this.leanPitch);
    car.setBraking(v.braking || drive.handbrake);
    // 方向盘转角按前轮转角放大：低速大角度、高速小角度，漂移时能看到反打
    car.setSteeringWheel(clamp(v.steerAngle * 7, -2.3, 2.3));
    car.setDash(Math.abs(v.forwardSpeed) * 3.6, v.gear < 0 ? 'R' : String(v.gear), v.rpm / v.cfg.redline, v.nitro);
    // 特效要读碰撞和落地的冲击值，得赶在镜头把它们清零之前
    // 烟是不发光的实体：亮度跟着天光走
    this.smokeLight.copy(this.world.look.fogColor).multiplyScalar(0.95).addScalar(0.02);
    const key = this.world.keyLight;
    // 主光打在白色表面上反射出来的亮度大约是它的三分之一
    if (key) this.smokeKey.copy(key.color).multiplyScalar(0.3);
    this.fx.setLighting(this.smokeLight, this.world.look.night, key?.dir, key ? this.smokeKey : undefined);
    this.fx.setTailGlow(this.carLights.state.tailGlow * 2.4);
    this.fx.update(dt, v, drive.throttle, this.engine.camera, Math.max(this.world.look.wetness, this.world.look.snow));
    for (const e of this.fx.events) {
      if (e.type === 'backfire') this.audio.backfire(e.strength);
      else if (e.type === 'collision') {
        if (e.strength < 0.22) this.audio.scrape(e.strength * 3);
        else this.audio.impact(e.strength);
        this.hit = Math.max(this.hit, Math.min(1, e.strength * 1.5));
      } else this.audio.landing(e.strength);
    }
    this.hit *= Math.exp(-dt * 14);
    this.fx.events.length = 0;

    if (v.collisionImpact > 0.15) this.input.rumble(v.collisionImpact, 0.5, 180);
    if (v.landingImpact > 0.2) this.input.rumble(v.landingImpact * 0.8, 0.5, 220);

    this.chase.update(dt, this.renderPos, this.renderQuat, v, ctl.lookBack && !intro);
    this.updateCine(dt, !!intro);
    if (intro) this.applyIntro(intro, dt);
    this.world.update(dt, this.renderPos, this.engine.camera);
    this.applyLook();
    this.carLights.update(dt, this.world.look.night, v.braking || drive.handbrake, v.groundedCount > 0);
    this.world.setCarLighting?.(this.carLights.state);

    // 湿地面上的轮胎水雾
    const look = this.world.look;
    const lv = v.body.linvel();
    this.carVel.set(lv.x, lv.y, lv.z);
    this.mist.copy(look.fogColor).multiplyScalar(1.5 + 0.5 * look.snow).addScalar(0.015 + 0.03 * look.snow);
    // 雪地上卷起来的是雪粉：比水雾浓一些、白一些
    this.spray.update(dt, v.wheels, this.carVel, Math.max(look.wetness, look.snow), this.mist, this.carLights.state.tailGlow, 1 + 0.9 * look.snow);
    // 雪地上的车辙：玩家的车四个轮子都留，对手的车只留后轮的两条
    const tracks = this.world.snowTracks;
    if (tracks) {
      if (look.snow > 0.2) {
        const side = this.camRight.set(1, 0, 0).applyQuaternion(this.currQuat);
        tracks.mark(0, v.wheels, 0, side.x, side.z, v.cfg.wheelRadius * 0.56, look.snow);
        race?.rivals.forEach((r, i) => {
          side.set(1, 0, 0).applyQuaternion(r.currQuat);
          tracks.mark(i + 1, r.vehicle.wheels, 2, side.x, side.z, r.vehicle.cfg.wheelRadius * 0.56, look.snow);
        });
        tracks.commit();
      } else if (look.snow < 0.02 && tracks.mesh.visible) {
        // 雪化干净了：车辙也清掉，下一场雪从干净的雪面开始
        tracks.clear();
      }
    }
    // 镜头上的水滴：雨越大越多；开快了被风吹掉一部分
    const wind = Math.min(1, Math.abs(v.forwardSpeed) / 70);
    this.droplets += (look.rain * (1 - 0.45 * wind) - this.droplets) * (1 - Math.exp(-dt * 0.9));
    this.engine.post.droplets.value = this.droplets;
    this.hud.update(dt, v, this.engine.fps, this.input.gamepadActive, this.chase.modeName);

    /* ---- 比赛：对手车的画面、裁判、比赛界面 ---- */
    const camera = this.engine.camera;
    this.rivalSounds.length = 0;
    if (race) {
      race.frame(dt, a, camera, look.night);
      this.world.setRivalLighting?.(race.lighting(camera));
      for (const e of race.events) this.onRaceEvent(e, race);
      this.updateRaceHud(dt, race);
      // 只照对手车的大灯
      const cl = this.carLights.state;
      this.headLamp.position.copy(cl.headPos);
      this.headLamp.target.position.copy(cl.headPos).addScaledVector(cl.headDir, 12);
      this.headLamp.target.position.y -= 0.6;
      this.headLamp.intensity = cl.headlight * 260;
      // 对手的引擎声：远近、左右、多普勒
      this.camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      race.rivals.forEach((r, i) => {
        const p = r.visual.root.position;
        const dx = p.x - camera.position.x;
        const dy = p.y - camera.position.y;
        const dz = p.z - camera.position.z;
        const dist = Math.hypot(dx, dy, dz);
        const last = this.rivalDistance[i] ?? dist;
        this.rivalDistance[i] = dist;
        const closing = dt > 0 ? clamp((last - dist) / dt, -80, 80) : 0;
        this.rivalSounds.push({
          rpm: r.vehicle.rpm,
          distance: dist,
          pan: (dx * this.camRight.x + dy * this.camRight.y + dz * this.camRight.z) / (dist + 3),
          closing,
        });
      });
      if (this.finishTimer >= 0) {
        this.finishTimer -= dt;
        if (this.finishTimer < 0) this.hooks.onRaceFinished();
      }
    }

    let skid = 0;
    for (const w of v.wheels) if (w.grounded) skid = Math.max(skid, w.skid);
    this.audio.update(
      dt,
      {
        rpm: v.rpm,
        redline: v.cfg.redline,
        throttle: v.nitroActive ? 1 : drive.throttle,
        speed: v.speed,
        skid,
        wet: look.wetness,
        rain: look.rain,
        nitro: v.nitroActive,
        cockpit: this.chase.modeName === '驾驶室',
        grounded: v.groundedCount > 0,
        shifting: v.shifting,
      },
      this.rivalSounds,
    );

    if (v.stuckUpsideDown || this.currPos.y < (this.world.groundAt?.(this.currPos.x, this.currPos.z) ?? 0) - 15) {
      if (race) {
        race.respawnPlayer();
        this.afterTeleport();
      } else {
        this.upright();
      }
    }
  }

  /** 比赛里发生的事 → 界面上的字和提示音 */
  private onRaceEvent(e: RaceEvent, race: RaceSession): void {
    const hud = this.raceHud;
    const d = race.director;
    switch (e.type) {
      case 'count':
        hud?.count(String(e.n));
        this.audio.cue('count');
        break;
      case 'go':
        hud?.count('GO!', true);
        this.audio.cue('go');
        break;
      case 'gate':
        if (!e.racer.isPlayer) break;
        hud?.tell(`检查点 ${e.index + 1}/${d.gatesPerLap - 1} · ${formatTime(e.time)}`);
        this.audio.cue('gate');
        break;
      case 'lap':
        if (!e.racer.isPlayer || e.lap >= d.laps) break;
        hud?.tell(`第 ${e.lap} 圈 ${formatTime(e.time)}${e.best && e.lap > 1 ? ' · 最快圈' : ''}`, 3);
        this.audio.cue(e.best && e.lap > 1 ? 'bestLap' : 'lap');
        break;
      case 'finalLap':
        hud?.announce('最后一圈');
        this.audio.cue('finalLap');
        break;
      case 'finish':
        if (!e.racer.isPlayer) break;
        hud?.announce(`完赛 · 第 ${e.racer.position} 名`, 3.4, 'finish');
        hud?.warning('');
        this.audio.cue(e.racer.position === 1 ? 'win' : 'finish');
        this.finishTimer = 2.8;
        break;
      case 'position':
        // 起步那几秒名次乱跳，不提示
        if (d.time > 6) this.audio.cue(e.to < e.from ? 'up' : 'down');
        break;
      default:
        break;
    }
  }

  private updateRaceHud(dt: number, race: RaceSession): void {
    const hud = this.raceHud;
    if (!hud) return;
    const d = race.director;
    const player = d.player;
    if (player && d.phase === 'racing' && !player.finished) {
      // 逆行：车速方向和赛道方向相反超过一秒多
      const s = d.track.samples[player.progress.index];
      const lv = this.vehicle.body.linvel();
      const along = lv.x * s.dir.x + lv.z * s.dir.z;
      this.wrongWay = along < -4 ? this.wrongWay + dt : 0;
      if (player.progress.offTrack) hud.warning('偏离赛道 · 按 R 回到赛道');
      else if (this.wrongWay > 1.2) hud.warning('逆行');
      else hud.warning('');
    }
    // 小地图要的：车在哪、车头朝哪、实际往哪走
    const t = this.vehicle.body.translation();
    const q = this.vehicle.body.rotation();
    const carYaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const v = this.vehicle.body.linvel();
    const planar = Math.hypot(v.x, v.z);
    const velYaw = planar > 5 && this.vehicle.forwardSpeed > 0 ? Math.atan2(v.x, v.z) : carYaw;
    hud.update(dt, d, race.tags, player && !player.finished ? d.nextGate(player) : null, { x: t.x, z: t.z, carYaw, velYaw, speed: planar });
  }
}
