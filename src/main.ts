import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Engine } from './core/Engine';
import { captureWithUi } from './core/capture.ts';
import { fitFov } from './core/fov.ts';
import { Garage } from './showroom/Garage';
import { Car } from './car/Car';
import { PAINTS } from './car/paint';
import { DriveMode, type MapId } from './drive/DriveMode.ts';
import { GameAudio } from './audio/GameAudio.ts';
import { LEVELS, type RaceLevel } from './race/roster.ts';
import { DEFAULT_RACE, Menu, TRACKS, type RaceConfig, type ResultRow } from './ui/menu.ts';
import { goFullscreen, isRotated, keepAwake } from './core/viewport.ts';
import { QUALITY, saveQuality } from './core/quality.ts';

/** 版本号（构建时从 package.json 填进来，见 vite.config.ts） */
declare const __APP_VERSION__: string;
import { formatTime } from './ui/raceHud.ts';
import { buildUI, type ViewDef } from './ui/ui';
import { FX_THEMES } from './fx/themes.ts';
import { CAR_MODELS, carModel, type CarModel } from './car/models.ts';
import { loadLook, saveLook, type CarLook } from './car/looks.ts';

interface View extends ViewDef {
  pos: [number, number, number];
  target: [number, number, number];
  /** 该视角下前轮打向哪边（让轮毂正面朝向镜头） */
  steer: number;
}

const STEER = 0.26;

const VIEWS: View[] = [
  { id: 'front', name: '前侧', pos: [4.15, 1.22, 5.35], target: [0, 0.56, 0.1], steer: -STEER },
  { id: 'side', name: '侧面', pos: [7.2, 0.95, 0.15], target: [0, 0.58, -0.1], steer: 0 },
  { id: 'rear', name: '后侧', pos: [-3.9, 1.45, -5.6], target: [0, 0.58, -0.25], steer: -STEER },
  { id: 'wheel', name: '轮毂', pos: [2.55, 0.52, 2.95], target: [0.96, 0.4, 1.5], steer: -STEER },
  { id: 'top', name: '俯视', pos: [3.3, 4.7, 4.4], target: [0, 0.3, -0.1], steer: -STEER },
];

/** 镜头活动范围（留在车库内、灯带和横梁以下） */
const CAM_MIN = new THREE.Vector3(-10.2, 0.12, -12.2);
const CAM_MAX = new THREE.Vector3(10.2, 5.0, 14.2);

const loadingEl = document.getElementById('loading')!;
const loadingFill = document.getElementById('loading-fill')!;
const loadingText = document.getElementById('loading-text')!;

function setProgress(ratio: number, text?: string): void {
  loadingFill.style.width = `${Math.round(ratio * 100)}%`;
  if (text) loadingText.textContent = text;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  // 地址栏 fx=-ao,-ssr,-mb,-dof,-lens 可以关掉对应的后期效果；prof=1 统计 GPU 耗时
  const boot = new URLSearchParams(location.search);
  const fxOff = (boot.get('fx') ?? '')
    .split(',')
    .filter((x) => x.startsWith('-'))
    .map((x) => x.slice(1));
  // px=渲染分辨率上限（百万像素），默认 3.7（2560×1440）；px=0 按屏幕原生分辨率，截图时用
  const px = boot.get('px');
  // 没在地址栏指定的话，分辨率上限和关掉哪些效果按画质档位来（手机默认是「流畅」，见 quality.ts）
  const engine = new Engine(canvas, [...fxOff, ...QUALITY.fxOff], boot.get('prof') === '1', px === null ? QUALITY.maxPixels : Number(px) * 1e6);
  setProgress(0.05, '正在启动渲染器…');
  await engine.init();
  const { scene, camera, renderer } = engine;

  scene.background = new THREE.Color(0x020203);
  scene.fog = new THREE.FogExp2(0x030408, 0.018);

  setProgress(0.15, '正在布置车库灯光…');
  const garage = new Garage();
  scene.add(garage.group);
  const env = garage.buildEnvironment(renderer);
  scene.environment = env;
  // 环境光整体压到 0.55：再高的话白色、黄色这类非金属亮色漆会过曝发白
  scene.environmentIntensity = 0.55;

  const car = await Car.load((r) => setProgress(0.2 + r * 0.7, '正在把车开进来…'));
  car.setEnvironment(env);
  scene.add(car.root);

  // 地址栏参数（方便截图和录屏固定机位）：?view=rear&still=1&paint=volt&ui=0
  const params = new URLSearchParams(location.search);
  const still = params.get('still') === '1';
  const paintId = params.get('paint');
  const startPaint = PAINTS.find((p) => p.id === paintId);
  // 车型：地址栏 car=gt / rs / lm / st / xr，否则用上次选的
  let savedCar: string | null = null;
  try {
    savedCar = localStorage.getItem('umbra.car');
  } catch {
    /* 隐私模式下读不了，就用默认的 */
  }
  const startModel = carModel(params.get('car') ?? savedCar);
  if (startModel !== CAR_MODELS[0]) car.setModel(startModel);
  // 每款车有自己的一套外观（出厂配色，或者玩家上次给它选的）：换到哪台就换上哪台的
  const looks = new Map<string, CarLook>();
  const lookOf = (m: CarModel): CarLook => {
    let look = looks.get(m.id);
    if (!look) {
      look = loadLook(m.id);
      looks.set(m.id, look);
    }
    return look;
  };
  car.applyLook(lookOf(startModel), true);
  // 地址栏 paint= 只是这一次临时换个漆（截图用），不记到车上
  if (startPaint) car.paint.apply(startPaint, true);
  if (params.get('ui') === '0') {
    document.getElementById('ui')!.style.display = 'none';
    document.getElementById('hud')!.style.display = 'none';
  }

  /* 镜头 */
  const first = VIEWS.find((v) => v.id === params.get('view')) ?? VIEWS[0];
  camera.position.set(...first.pos);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(...first.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 2.2;
  controls.maxDistance = 11;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI / 2 - 0.035;
  controls.autoRotate = !still;
  controls.autoRotateSpeed = 0.55;
  controls.update();

  let autoRotate = !still;
  let steerEnabled = true;
  let currentSteer = first.steer;
  let resumeAt = 0;
  car.setSteer(currentSteer, true);

  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    tween = null;
  });
  controls.addEventListener('end', () => {
    resumeAt = performance.now() + 3500;
  });

  /* 视角切换：位置和注视点一起缓动 */
  let tween: { t: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const camDir = new THREE.Vector3();

  /**
   * 一个机位对着当前这台车该摆在哪：机位是按原型车定的，
   * 别的车身大小不一样（皮卡高出一大截），镜头要跟着退后、抬高；看轮毂的机位对着这台车真正的前轮。
   */
  const viewPose = (v: View) => {
    const base = car.model.base;
    const k = base === 'nomad' ? 1.32 : base === 'brute' ? 1.1 : 1;
    const lift = base === 'nomad' ? 0.36 : base === 'ronin' ? 0.08 : base === 'brute' ? 0.04 : 0;
    const target = new THREE.Vector3(...v.target);
    const offset = new THREE.Vector3(...v.pos).sub(target);
    if (v.id === 'wheel') {
      const w = car.wheels[0].steer.position;
      target.set(w.x - 0.02, w.y, w.z);
      offset.multiplyScalar(w.y / 0.384);
    } else {
      target.y += lift;
      offset.multiplyScalar(k);
    }
    // 大车的俯视机位会顶到天花板的横梁：高度封顶，改成往外退，离车的远近不变
    const top = CAM_MAX.y - 0.2;
    if (target.y + offset.y > top) {
      const dist = offset.length();
      const dy = top - target.y;
      const flat = Math.hypot(offset.x, offset.z);
      const k2 = Math.sqrt(Math.max(dist * dist - dy * dy, 0.01)) / Math.max(flat, 1e-3);
      offset.set(offset.x * k2, dy, offset.z * k2);
    }
    return { pos: target.clone().add(offset), target };
  };
  let currentView = VIEWS[0].id;
  const setView = (id: string) => {
    const v = VIEWS.find((x) => x.id === id);
    if (!v) return;
    currentView = id;
    const pose = viewPose(v);
    tween = {
      t: 0,
      fromPos: camera.position.clone(),
      toPos: pose.pos,
      fromTarget: controls.target.clone(),
      toTarget: pose.target,
    };
    controls.autoRotate = false;
    currentSteer = v.steer;
    car.setSteer(steerEnabled ? currentSteer : 0);
  };

  /* ---------- 声音 ---------- */
  const audio = new GameAudio();
  try {
    const saved = localStorage.getItem('umbra.volume');
    if (saved !== null) audio.volume = Math.min(1, Math.max(0, Number(saved)));
    audio.muted = localStorage.getItem('umbra.muted') === '1';
  } catch {
    // 读不到就用默认音量
  }
  const saveAudio = () => {
    try {
      localStorage.setItem('umbra.volume', String(audio.volume));
      localStorage.setItem('umbra.muted', audio.muted ? '1' : '0');
    } catch {
      // 存不了就算了
    }
  };
  // 浏览器要求先有一次点击或按键才能出声
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  // 切到别的标签页时不要让引擎声一直响着
  document.addEventListener('visibilitychange', () => audio.suspend(document.hidden));

  /* ---------- 三种状态：主菜单（背景是车库）、车库（改装）、开车（自由驾驶或比赛） ---------- */
  const uiRoot = document.getElementById('ui')!;
  const hudRoot = document.getElementById('hud')!;
  const uiHidden = params.get('ui') === '0';
  const garageFog = scene.fog;
  const garageBackground = scene.background;
  let mode: 'menu' | 'garage' | 'drive' = 'menu';
  let drive: DriveMode | null = null;
  // 特效配色跟着车走（地址栏 theme= 可以临时指定）
  const themeOf = (m: CarModel) => FX_THEMES.find((t) => t.id === (params.get('theme') ?? lookOf(m).fx)) ?? FX_THEMES[0];
  let fxTheme = themeOf(startModel);
  let switching = false;
  let raceConfig: RaceConfig | null = null;
  let resultsTimer = 0;

  const showGarageUi = (on: boolean) => {
    uiRoot.style.display = on && !uiHidden ? '' : 'none';
  };

  const showMenu = () => {
    mode = 'menu';
    showGarageUi(false);
    // 界面隐藏时（截图、录屏）没有菜单挡着，镜头照常可以拖
    controls.enabled = uiHidden;
    controls.autoRotate = autoRotate;
    if (!uiHidden) menu.show('main');
  };

  const openGarage = () => {
    mode = 'garage';
    menu.show(null);
    showGarageUi(true);
    controls.enabled = true;
  };

  /** 从开车状态回到车库场景（不决定之后显示菜单还是改装界面） */
  const leaveDrive = () => {
    if (mode !== 'drive' || !drive) return;
    window.clearInterval(resultsTimer);
    drive.exit();
    keepAwake(false);
    garage.group.visible = true;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    scene.fog = garageFog;
    scene.background = garageBackground;
    car.setEnvironment(env);
    engine.resetLook();
    engine.setProfile('garage');
    camera.near = 0.1;
    camera.far = 300;
    camera.fov = 32;
    camera.updateProjectionMatrix();
    {
      const pose = viewPose(VIEWS[0]);
      camera.position.copy(pose.pos);
      controls.target.copy(pose.target);
    }
    controls.update();
    car.setSteer(steerEnabled ? currentSteer : 0, true);
  };

  const exitDrive = () => {
    if (mode !== 'drive') return;
    leaveDrive();
    showMenu();
  };

  /** 把比赛结果填进结算页 */
  const fillResults = () => {
    const d = drive?.race?.director;
    const player = d?.player;
    if (!d || !player) return;
    const rows: ResultRow[] = d.order.map((r) => ({
      position: r.position,
      name: r.name,
      color: r.color,
      time: r.finished ? formatTime(r.finishTime) : '比赛中…',
      best: formatTime(r.best),
      isPlayer: r.isPlayer,
    }));
    const levelName = LEVELS.find((l) => l.id === drive?.race?.options.level)?.name ?? '';
    menu.setResults(player.position, d.racers.length, `${d.laps} 圈 · ${levelName} · 用时 ${formatTime(player.finishTime)}`, rows);
  };

  // 触屏：自动油门开没开（默认开）
  let autoThrottle = true;
  try {
    autoThrottle = localStorage.getItem('umbra.autoThrottle') !== '0';
  } catch {
    /* 读不了就用默认的 */
  }

  const menu = new Menu(document.getElementById('app')!, {
    startRace: (cfg) => {
      goFullscreen();
      void enterDrive(cfg);
    },
    freeDrive: () => {
      goFullscreen();
      void enterDrive(null);
    },
    setQuality: (id) => {
      saveQuality(id);
      location.reload();
    },
    getAutoThrottle: () => autoThrottle,
    setAutoThrottle: (on) => {
      autoThrottle = on;
      drive?.touch?.setAuto(on);
      try {
        localStorage.setItem('umbra.autoThrottle', on ? '1' : '0');
      } catch {
        /* 存不了就算了 */
      }
    },
    driveOption: (kind, act) => drive?.option(kind, act) ?? '',
    openGarage,
    resume: () => {
      menu.show(null);
      drive?.setPaused(false);
    },
    restart: () => {
      window.clearInterval(resultsTimer);
      menu.show(null);
      if (!drive) return;
      drive.setPaused(false);
      if (drive.race && raceConfig) {
        // 重新开始不再放一遍赛前镜头：刚看过，直接倒数
        drive.startRace({ ...raceConfig, intro: false });
        drive.input.enabled = true;
      } else {
        drive.respawn();
      }
    },
    quit: () => {
      drive?.setPaused(false);
      exitDrive();
    },
    getVolume: () => audio.volume,
    setVolume: (v) => {
      audio.setVolume(v);
      if (v > 0 && audio.muted) audio.setMuted(false);
      saveAudio();
    },
    isMuted: () => audio.muted,
    setMuted: (m) => {
      audio.setMuted(m);
      saveAudio();
    },
    sound: (kind) => {
      audio.unlock();
      audio.cue(kind);
    },
  });

  // M：静音开关（任何时候）
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat) return;
    audio.setMuted(!audio.muted);
    saveAudio();
    drive?.hud.flash(audio.muted ? '静音' : '声音 开');
  });

  const driveHooks = {
    onPause: () => {
      if (!drive || drive.paused || menu.visible) return;
      drive.setPaused(true);
      menu.showPause(!!drive.race);
    },
    onExit: () => exitDrive(),
    onRaceFinished: () => {
      if (!drive?.race || uiHidden) return;
      drive.input.enabled = false;
      fillResults();
      menu.show('results');
      // 对手陆续冲线，结算表跟着更新
      window.clearInterval(resultsTimer);
      resultsTimer = window.setInterval(() => {
        if (menu.screen === 'results') fillResults();
      }, 500);
    },
  };

  /**
   * 进入开车状态。cfg 给了就是比赛，null 是自由驾驶。
   * 第一次进入某张地图时才生成它。
   */
  const enterDrive = async (cfg: RaceConfig | null) => {
    if (switching) return;
    switching = true;
    try {
      menu.show(null);
      // 去哪张地图：比赛按设置里选的赛道，自由驾驶也用菜单上选中的那一条。
      // 地址栏 map=test 可以进灰盒测试场（调手感用）
      const map: MapId = params.get('map') === 'test' ? 'test' : (cfg?.map ?? menu.config.map);
      // time=day / dusk / night 指定起始时段（默认夜晚）；weather=clear / rain / fog / snow 指定起始天气（默认下雨）
      const time = cfg?.time ?? params.get('time');
      const weather = cfg?.weather ?? params.get('weather');
      // 这张地图还没生成过：要花几秒钟，先把"正在生成"画出来再开始干活
      const building = !drive || !drive.hasMap(map);
      if (building) {
        loadingEl.classList.remove('done');
        setProgress(0.6, map === 'mountain' ? '正在生成山路…' : map === 'test' ? '正在生成测试场…' : '正在生成城市…');
        await new Promise((r) => window.setTimeout(r, 30));
      }
      if (!drive) {
        drive = await DriveMode.create(engine, car, hudRoot, driveHooks, audio, map, time, weather);
        drive.fx.setTheme(fxTheme);
        drive.touch?.setAuto(autoThrottle);
        // 地址栏可以指定起始机位：cam=far / near / hood / cockpit
        const cam = params.get('cam');
        if (cam) drive.chase.setMode(cam);
      } else {
        drive.setMap(map, time, weather);
      }
      if (building) {
        setProgress(1, '就绪');
        window.setTimeout(() => loadingEl.classList.add('done'), 250);
      }
      if (cfg) {
        drive.world.setTime?.(cfg.time, true);
        drive.world.setWeather?.(cfg.weather, true);
      }
      if (mode !== 'drive') {
        mode = 'drive';
        tween = null;
        // 让按钮失焦，否则空格（手刹）会被浏览器当成再次点击按钮
        (document.activeElement as HTMLElement | null)?.blur();
        garage.group.visible = false;
        showGarageUi(false);
        controls.enabled = false;
        engine.setProfile('drive');
        car.setLights(true);
        camera.near = 0.2;
        camera.far = 3000;
        camera.updateProjectionMatrix();
        drive.enter();
        // 手机上：开车的时候别让屏幕自己熄掉
        keepAwake(true);
      }
      raceConfig = cfg;
      if (cfg) {
        // 测试场没有赛道数据，比不了赛：退回自由驾驶
        // 地址栏带 intro=0 就不放赛前的特写镜头（自动化测试用）
        if (!drive.startRace({ laps: cfg.laps, rivals: cfg.rivals, level: cfg.level, intro: params.get('intro') !== '0' })) drive.hud.flash('这张图不能比赛');
      } else {
        drive.endRace();
      }
      drive.input.enabled = true;
    } finally {
      switching = false;
    }
  };

  engine.onUpdate((dt) => {
    car.update(dt);
    if (mode === 'drive') {
      drive?.update(dt);
      return;
    }

    const fov = fitFov(32, camera.aspect);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    if (tween) {
      tween.t = Math.min(tween.t + dt / 1.25, 1);
      const k = ease(tween.t);
      camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
      if (tween.t >= 1) {
        tween = null;
        resumeAt = performance.now() + 2500;
      }
    } else if (autoRotate && !controls.autoRotate && resumeAt > 0 && performance.now() > resumeAt) {
      controls.autoRotate = true;
      resumeAt = 0;
    }
    controls.update();
    // 景深：焦点跟着镜头看的那个点（车身）
    engine.post.focusDistance.value = camera.position.distanceTo(controls.target);
    engine.post.bokeh.value = 2.4;

    // 镜头越界时沿视线拉回，避免穿墙或钻进天花板
    const p = camera.position;
    if (p.x < CAM_MIN.x || p.x > CAM_MAX.x || p.y < CAM_MIN.y || p.y > CAM_MAX.y || p.z < CAM_MIN.z || p.z > CAM_MAX.z) {
      const t = controls.target;
      // 先把「注视点 → 镜头」这段方向记下来，再去动镜头的位置
      // （以前是先把镜头挪到注视点上再算方向，结果方向是零，镜头被吸到车顶正上方）
      camDir.subVectors(p, t);
      let k = 1;
      for (const ax of ['x', 'y', 'z'] as const) {
        const d = camDir[ax];
        if (d > 1e-6) k = Math.min(k, (CAM_MAX[ax] - t[ax]) / d);
        else if (d < -1e-6) k = Math.min(k, (CAM_MIN[ax] - t[ax]) / d);
      }
      p.copy(t).addScaledVector(camDir, Math.max(k, 0.05));
    }
  });

  buildUI(document.getElementById('ui')!, {
    car,
    views: VIEWS,
    initialView: first.id,
    initialAutoRotate: !still,
    setView,
    setAutoRotate: (on) => {
      autoRotate = on;
      controls.autoRotate = on;
      resumeAt = 0;
    },
    setSteer: (on) => {
      steerEnabled = on;
      car.setSteer(on ? currentSteer : 0);
    },
    getStats: () => ({ fps: engine.fps, backend: engine.backendName }),
    startDrive: () => void enterDrive(null),
    setModel: (m) => {
      const changedBody = m.base !== car.model.base;
      car.setModel(m);
      // 换上这款车自己的那套外观和特效配色
      car.applyLook(lookOf(m), true);
      fxTheme = themeOf(m);
      drive?.fx.setTheme(fxTheme);
      drive?.setCarModel();
      // 换了车身：镜头按新车的大小重新摆一下
      if (changedBody) setView(currentView);
      try {
        localStorage.setItem('umbra.car', m.id);
      } catch {
        /* 存不了就算了 */
      }
    },
    setFxTheme: (t) => {
      fxTheme = t;
      drive?.fx.setTheme(t);
    },
    getLook: () => lookOf(car.model),
    setLook: (patch) => {
      const look = lookOf(car.model);
      Object.assign(look, patch);
      saveLook(car.model.id, look);
    },
  });
  // 车库页左上角的"返回"：回主菜单
  const back = document.createElement('button');
  back.className = 'garage-back';
  back.textContent = '◀ 返回';
  back.addEventListener('click', () => {
    audio.cue('back');
    showMenu();
  });
  uiRoot.appendChild(back);

  /*
   * 手机竖着拿的时候界面是转过来的（见 viewport.ts），指针事件的坐标也跟着转了：
   * 轨道控制器会把左右拖当成上下拖。这种情况下抢在它前面把拖动接过来，自己绕着车转镜头。
   */
  {
    let drag: { id: number; x: number; y: number } | null = null;
    const offset = new THREE.Vector3();
    const sph = new THREE.Spherical();
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (!isRotated() || !controls.enabled) return;
        e.stopImmediatePropagation();
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        controls.autoRotate = false;
      },
      { capture: true },
    );
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // 界面里的左右是屏幕上的上下，界面里的上下是屏幕上的右左
      const dx = e.clientY - drag.y;
      const dy = -(e.clientX - drag.x);
      drag.x = e.clientX;
      drag.y = e.clientY;
      offset.subVectors(camera.position, controls.target);
      sph.setFromVector3(offset);
      sph.theta -= dx * 0.008;
      sph.phi = Math.min(controls.maxPolarAngle, Math.max(controls.minPolarAngle, sph.phi - dy * 0.008));
      camera.position.copy(controls.target).add(offset.setFromSpherical(sph));
    });
    const end = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) drag = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // 正式版里注册离线缓存（装到手机主屏幕上以后，断网也能打开）。开发时不注册：会和热更新打架
  if ((import.meta as unknown as { env: { PROD: boolean } }).env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker
      .register(`/sw.js?v=${__APP_VERSION__}`)
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // 这一趟已经下载过的东西（脚本、样式、车的模型）让它存一份：第一次打开时它还没接管页面，没来得及存
        const urls = performance
          .getEntriesByType('resource')
          .map((r) => r.name)
          .filter((u) => u.startsWith(location.origin));
        reg.active?.postMessage({ type: 'keep', urls: [location.origin + '/', ...urls] });
      })
      .catch(() => {});
  }

  engine.start();
  // 地址栏 map=city / mountain 指定赛道（不写就用上次在菜单里选的）
  {
    const urlMap = params.get('map');
    if (urlMap && TRACKS.some((t) => t.id === urlMap)) menu.setMap(urlMap);
  }
  // 地址栏 mode=drive 直接进自由驾驶；mode=race 直接开一场比赛（laps / rivals / level 可选）；默认是主菜单
  const startMode = params.get('mode');
  showMenu();
  if (startMode === 'drive') {
    await enterDrive(null);
  } else if (startMode === 'race') {
    const level = params.get('level') as RaceLevel | null;
    await enterDrive({
      ...DEFAULT_RACE,
      map: menu.config.map,
      laps: Number(params.get('laps') ?? DEFAULT_RACE.laps),
      rivals: Number(params.get('rivals') ?? DEFAULT_RACE.rivals),
      level: level && LEVELS.some((l) => l.id === level) ? level : DEFAULT_RACE.level,
      time: params.get('time') ?? DEFAULT_RACE.time,
      weather: params.get('weather') ?? DEFAULT_RACE.weather,
    });
  } else {
    setProgress(1, '就绪');
    // 等首帧编译完着色器再揭幕
    window.setTimeout(() => loadingEl.classList.add('done'), 500);
  }

  // 调试入口；snap('名字') 把当前帧原尺寸存到项目的 .snaps/ 目录
  const snap = async (name = 'snap') => {
    const blob = await engine.capture();
    await fetch(`/__snap?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return `${name}.png ${canvas.width}x${canvas.height}`;
  };
  /** 和 snap 一样，但把比赛界面、菜单这些网页元素也一起截进去 */
  const snapUi = async (name = 'snap') => {
    const blob = await captureWithUi(engine);
    await fetch(`/__snap?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return `${name}.png ${canvas.width}x${canvas.height}`;
  };
  /**
   * 开车状态下把镜头摆到任意位置截一张图（游戏会先暂停，截完保持暂停）。
   * 对比画面改动前后用：同一个机位、同一个时段天气，前后各截一张。
   */
  const viewShot = async (name: string, pos: [number, number, number], target: [number, number, number], fov = 55, withUi = false) => {
    if (!drive) return 'not driving';
    drive.paused = true;
    camera.position.set(...pos);
    camera.fov = fov;
    camera.near = 0.2;
    camera.updateProjectionMatrix();
    camera.lookAt(...target);
    drive.world.update(0, camera.position, camera);
    return withUi ? snapUi(name) : snap(name);
  };
  /** 立刻切到某个时段和天气（不走过渡），截图前用 */
  const setScene = (time: string, weather: string) => {
    if (!drive) return;
    drive.world.setTime?.(time, true);
    drive.world.setWeather?.(weather, true);
    for (let i = 0; i < 4; i++) drive.world.update(0.5, camera.position, camera);
  };

  /** 直接切到某个机位（可选换漆）并截图，不走缓动 */
  const shot = async (name: string, viewId: string, paintId?: string) => {
    const v = VIEWS.find((x) => x.id === viewId) ?? VIEWS[0];
    tween = null;
    controls.autoRotate = false;
    const pose = viewPose(v);
    camera.position.copy(pose.pos);
    controls.target.copy(pose.target);
    car.setSteer(v.steer, true);
    const p = PAINTS.find((x) => x.id === paintId);
    if (p) car.paint.apply(p, true);
    return snap(name);
  };
  /**
   * 调试用：把车放到赛道第 s 米处停好（游戏保持暂停）。只在有赛道的地图里有用
   */
  const goto = (s: number) => {
    if (!drive) return;
    const track = (drive.world as unknown as { track?: { samples: { s: number; pos: THREE.Vector3; dir: THREE.Vector3 }[] } }).track;
    if (!track) return;
    const smp = track.samples.find((p) => p.s >= s) ?? track.samples[0];
    drive.paused = false;
    drive.scriptedInput = { throttle: 0, brake: 1, steer: 0, handbrake: true, nitro: false };
    drive.vehicle.reset(smp.pos.x, smp.pos.y + 0.06, smp.pos.z, Math.atan2(smp.dir.x, smp.dir.z));
    (drive as unknown as { afterTeleport(): void }).afterTeleport();
    for (let i = 0; i < 60; i++) drive.update(1 / 60);
    drive.paused = true;
  };
  /** 调试用：按给定的输入让游戏同步地往前跑若干秒（不出画面），跑完保持暂停 */
  const run = (seconds: number, input: Partial<{ throttle: number; brake: number; steer: number; handbrake: boolean; nitro: boolean }> = {}) => {
    if (!drive) return;
    drive.paused = false;
    drive.scriptedInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, ...input };
    for (let i = 0; i < Math.round(seconds * 60); i++) drive.update(1 / 60);
    drive.paused = true;
  };
  /**
   * 录制用（promo/ 里的宣传片脚本）：停掉页面自己的动画循环，改成手动逐帧推进。
   * frame() 让游戏正好走 dt 秒、渲染一帧，等 GPU 画完再返回；之后读画布或截屏拿到的就是这一帧。
   * 只管出帧的节奏，不碰玩法和画面。
   */
  const rec = {
    manual: () => renderer.setAnimationLoop(null),
    auto: () => engine.start(),
    frame: async (dt = 1 / 60) => {
      const e = engine as unknown as { advanceFrame(): void; last: number };
      e.advanceFrame();
      engine.tick(e.last + dt * 1000);
      const device = (renderer.backend as unknown as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
      await device?.queue.onSubmittedWorkDone();
    },
  };
  Object.assign(window, {
    __app: {
      rec,
      goto,
      run,
      engine,
      garage,
      car,
      controls,
      setView,
      snap,
      snapUi,
      viewShot,
      setScene,
      shot,
      enterDrive: (cfg: RaceConfig | null = null) => enterDrive(cfg),
      exitDrive,
      menu,
      audio,
      get drive() {
        return drive;
      },
      THREE,
    },
  });
}

main().catch((err) => {
  console.error(err);
  loadingText.classList.add('error');
  loadingText.textContent = `启动失败：${err instanceof Error ? err.message : String(err)}`;
});
