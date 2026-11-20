/**
 * 宣传片的每个镜头：在哪、什么天气、车怎么开、镜头怎么摆。
 *
 * 字段里的代码是在游戏页面里执行的（见 lib.ts 的 __P 工具）：
 *  - setup：录之前执行一次（放车、换天气、设好状态），可以 await
 *  - before(i)：每帧推进之前执行（i 从 -preroll 开始，0 是第一帧录下来的画面）
 *  - cam(i, cam)：自己的机位；不写就用游戏的镜头（追尾或电影镜头）
 *  - post(i, post)：改这一帧的后期参数（车库里也在这里摆镜头）
 *  - ready：before / cam / post 都装好以后、预跑之前再执行一次
 * 自己加的镜头运动一律匀速（线性插值），不加缓动；游戏自带的镜头（追尾、电影镜头、赛前镜头）照它自己的来。
 *
 * 赛道坐标：P.tp(s, x, y) = 赛道第 s 米、往左偏 x 米、离地 y 米。
 * 车身坐标：P.carPt(x, y, z) = x 左、y 上、z 前（车头方向）。
 */
export interface Shot {
  name: string;
  /** 地址栏参数（不带 q、px，录制时统一加 q=high&px=0） */
  query: string;
  frames: number;
  preroll?: number;
  setup: string;
  before?: string;
  cam?: string;
  post?: string;
  ready?: string;
  /** 试拍时存哪几帧 */
  scoutAt?: number[];
  log?: number;
  /** 慢动作倍数（录下来的每帧只推进 1/60 ÷ slow 秒） */
  slow?: number;
  /** 只把第 keep[0] 到 keep[1]-1 帧存进素材（其余照常推进、渲染，但不截屏）。不写就是全部 */
  keep?: [number, number];
}

const CITY = 'mode=drive&ui=0&map=city';
const NIGHT_RAIN = `${CITY}&time=night&weather=rain`;
const NIGHT_DRY = `${CITY}&time=night&weather=clear`;
const MTN = 'mode=drive&ui=0&map=mountain';
const MTN_DUSK = `${MTN}&time=dusk&weather=clear`;
const RACE_CITY = 'mode=race&map=city&time=night&weather=rain&laps=2&rivals=7&level=normal';

/** 停稳：拉着手刹不踩刹车（停稳后踩刹车是倒车） */
const PARK = `d.scriptedInput = { throttle: 0, brake: 0, steer: 0, handbrake: true, nitro: false };`;
/** 固定机位跟拍：镜头不动，只转向车（看向点 = 车身中部） */
const FOLLOW = (pos: string, fov: number, aimY = 0.7) => `P.look(cam, ${pos}, P.carPt(0, ${aimY}, 0), ${fov});`;
/** 交给自动驾驶，电影镜头只用这几种机位 */
const CINE = (kinds: string[]) => `P.pilot(true); P.cineKinds = ${JSON.stringify(kinds)};`;
/** 电影镜头（不是追尾）里不要贴在镜头上的速度流光，径向拉丝也收掉大半 */
const CINE_POST = `post.speed.value *= 0.3; d.fx.speedLines.mesh.visible = false;`;
/** 跟着自动驾驶开，但氮气一直开着（自动驾驶在拱桥前的发车直道上不开氮气） */
const AUTO_NITRO = `d.scriptedInput = { ...P.auto(), nitro: true };`;

/** 车库：围着车匀速转一段弧（角度单位度，0 = 正前方，90 = 左侧） */
const ORBIT = (from: number, to: number, frames: number, dist: number, h: number, aimY: number, fov: number) => `
  const t = Math.max(i, 0) / ${frames - 1};
  const a = (${from} + (${to} - ${from}) * t) * Math.PI / 180;
  const cam = E.camera;
  P.look(cam, new T.Vector3(Math.sin(a) * ${dist}, ${h}, Math.cos(a) * ${dist}), new T.Vector3(0, ${aimY}, 0), ${fov});
  post.focusDistance.value = ${dist};
  post.bokeh.value = 2.4;
`;

export const SHOTS: Shot[] = [
  /* ---------------- 开场：雨夜的街 ---------------- */
  {
    name: 'open_street',
    keep: [0, 200],
    query: `${NIGHT_RAIN}&car=gt`,
    frames: 200,
    preroll: 90,
    setup: `P.launch(120, 0); ${PARK}`,
    cam: `const t = Math.max(i, 0) / 199; P.look(cam, P.tp(P.lerp(131, 127, t), 1.1, 0.3), P.tp(119, 0, 0.62), 30);`,
    post: `P.still(post);`,
    scoutAt: [0, 100, 199],
  },
  {
    name: 'open_tail',
    keep: [0, 120],
    query: `${NIGHT_RAIN}&car=gt`,
    frames: 120,
    preroll: 90,
    setup: `P.launch(120, 0); ${PARK}`,
    cam: `const t = Math.max(i, 0) / 119; P.look(cam, P.carPt(P.lerp(1.3, -0.4, t), 0.82, -3.7), P.carPt(P.lerp(0.4, -0.1, t), 0.68, -2.0), 30);`,
    post: `P.still(post);`,
    scoutAt: [0, 119],
  },
  {
    // 第一个直角弯（588 米，左转）的箭头屏：镜头贴着湿路面匀速往前推
    name: 'open_arrow',
    keep: [0, 120],
    query: `${NIGHT_RAIN}&car=gt`,
    frames: 120,
    preroll: 90,
    setup: `P.launch(60, 0); ${PARK}`,
    cam: `const t = Math.max(i, 0) / 119; const a = P.at(548); P.look(cam, P.tp(P.lerp(538, 548, t), -1.2, 0.45), a.pos.clone().addScaledVector(a.dir, 70).setY(a.pos.y + 3.2), 30);`,
    post: `P.still(post);`,
    scoutAt: [0, 60, 119],
  },
  {
    // 标题垫底：车从镜头前起步冲出去，尾灯拉出光轨
    name: 'open_launch',
    keep: [0, 240],
    query: `${NIGHT_RAIN}&car=gt`,
    frames: 240,
    preroll: 90,
    setup: `P.launch(120, 0); ${PARK}`,
    before: `if (i >= 40) ${AUTO_NITRO.replace('nitro: true', 'nitro: i >= 70')}`,
    cam: FOLLOW(`P.tp(112, 1.2, 0.55)`, 34, 0.6),
    post: `P.still(post, 1 / 60);`,
    scoutAt: [0, 40, 80, 120, 180, 239],
  },

  /* ---------------- 比赛：赛前镜头、发车 ---------------- */
  {
    name: 'race_intro',
    keep: [0, 760],
    query: `${RACE_CITY}&car=gt`,
    frames: 760,
    preroll: 0,
    setup: `
      d.startRace({ ...d.race.options, intro: true });
      for (let k = 0; k < 40; k++) await app.rec.frame();
      d.startRace({ ...d.race.options, intro: true });
    `,
  },
  {
    name: 'race_start',
    keep: [100, 400],
    query: `${RACE_CITY}&car=gt&intro=0`,
    frames: 600,
    preroll: 0,
    setup: `
      d.startRace({ ...d.race.options, intro: false });
      for (let k = 0; k < 20; k++) await app.rec.frame();
      d.startRace({ ...d.race.options, intro: false });
      d.scriptedInput = null;
      d.setAutopilot(true);
      d.setCine(false);
      d.chase.setMode('far');
    `,
  },

  /* ---------------- 城里的直角弯：箭头屏、漂移 ---------------- */
  {
    name: 'drift_chase',
    keep: [90, 300],
    query: `${NIGHT_DRY}&car=gt`,
    frames: 300,
    preroll: 30,
    setup: `P.launch(420, 140); P.pilot(false); d.chase.setMode('near');`,
  },
  {
    name: 'drift_front',
    keep: [170, 290],
    query: `${NIGHT_DRY}&car=st`,
    frames: 300,
    preroll: 30,
    setup: `P.launch(420, 140); ${CINE(['front'])}`,
    post: CINE_POST,
  },
  {
    name: 'drift_trackside',
    keep: [160, 280],
    query: `${NIGHT_DRY}&car=rs`,
    frames: 300,
    preroll: 30,
    setup: `P.launch(420, 140); ${CINE(['trackside'])}`,
    post: CINE_POST,
  },
  {
    name: 'drift_wheel',
    keep: [190, 300],
    query: `${NIGHT_DRY}&car=xr`,
    frames: 300,
    preroll: 30,
    setup: `P.launch(420, 140); ${CINE(['wheel'])}`,
    post: CINE_POST,
  },

  /* ---------------- 氮气、尾灯拖光 ---------------- */
  {
    name: 'trail_brute',
    keep: [20, 140],
    query: `${NIGHT_DRY}&car=brute`,
    frames: 200,
    preroll: 60,
    setup: `P.launch(10, 110);`,
    before: AUTO_NITRO,
    cam: `const t = Math.max(i, 0) / 199; P.look(cam, P.carPt(4.6, 1.5, P.lerp(0.8, -0.6, t)), P.carPt(0, 0.55, -2.2), 50);`,
    post: `post.speed.value *= 0.3; d.fx.speedLines.mesh.visible = false;`,
    scoutAt: [0, 60, 120, 199],
  },
  {
    name: 'trail_ronin',
    keep: [30, 150],
    query: `${NIGHT_DRY}&car=ronin`,
    frames: 200,
    preroll: 60,
    setup: `P.launch(10, 110);`,
    before: AUTO_NITRO,
    cam: `const t = Math.max(i, 0) / 199; P.look(cam, P.carPt(-1.4, 2.3, P.lerp(-8.6, -7.8, t)), P.carPt(0, 0.6, 0.5), 38);`,
    post: `post.speed.value *= 0.3; d.fx.speedLines.mesh.visible = false;`,
    scoutAt: [0, 60, 120, 199],
  },

  /* ---------------- 山路，黄昏 ---------------- */
  {
    name: 'm_hairpin_heli',
    keep: [130, 280],
    query: `${MTN_DUSK}&car=lm`,
    frames: 420,
    preroll: 30,
    setup: `P.launch(1215, 150); ${CINE(['heli'])}`,
    post: CINE_POST,
  },
  {
    name: 'm_hairpin_front',
    keep: [160, 330],
    query: `${MTN_DUSK}&car=gt`,
    frames: 420,
    preroll: 30,
    setup: `P.launch(1600, 150); ${CINE(['front', 'wheel'])}`,
    post: CINE_POST,
  },
  {
    name: 'm_tower',
    keep: [0, 120],
    query: `${MTN_DUSK}&car=rs`,
    frames: 420,
    preroll: 30,
    setup: `P.launch(150, 170); ${CINE(['tower', 'trackside'])}`,
    post: CINE_POST,
  },
  {
    name: 'm_bridge',
    keep: [180, 300],
    query: `${MTN_DUSK}&car=gt`,
    frames: 300,
    preroll: 30,
    setup: `P.launch(3030, 150); P.pilot(false);`,
    cam: FOLLOW(`P.tp(3234, -8.5, 1.2)`, 30, 0.6),
    post: `P.still(post, 1 / 80);`,
  },
  {
    name: 'm_tunnel',
    keep: [130, 260],
    query: `${MTN_DUSK}&car=nomad`,
    frames: 300,
    preroll: 30,
    setup: `P.launch(2805, 150); P.pilot(false);`,
    cam: FOLLOW(`P.tp(2950, 3.5, 0.9)`, 32, 0.8),
    post: `P.still(post, 1 / 80);`,
  },
  {
    // 山路上的多车比赛：电影镜头的航拍
    name: 'm_race_pack',
    keep: [230, 600],
    query: 'mode=race&ui=0&map=mountain&time=dusk&weather=clear&laps=2&rivals=7&level=hard&car=gt&intro=0',
    frames: 900,
    preroll: 0,
    setup: `
      d.startRace({ ...d.race.options, intro: false });
      for (let k = 0; k < 20; k++) await app.rec.frame();
      d.startRace({ ...d.race.options, intro: false });
      d.scriptedInput = null;
      d.setAutopilot(true);
      P.cineKinds = ['heli', 'trackside'];
    `,
    post: CINE_POST,
  },

  /* ---------------- 时段和天气 ---------------- */
  {
    name: 'w_day',
    keep: [20, 110],
    query: `${CITY}&time=day&weather=clear&car=lm`,
    frames: 200,
    preroll: 60,
    setup: `P.launch(20, 150); P.pilot(false);`,
    cam: FOLLOW(`P.tp(110, -5.5, 0.6)`, 30, 0.6),
    post: `P.still(post, 1 / 80);`,
  },
  {
    name: 'w_fog',
    keep: [0, 90],
    query: `${CITY}&time=dusk&weather=fog&car=brute`,
    frames: 300,
    preroll: 60,
    setup: `P.launch(2380, 120); ${CINE(['trackside'])}`,
    post: CINE_POST,
  },
  {
    name: 'w_snow',
    keep: [0, 90],
    query: `${CITY}&time=night&weather=snow&car=nomad`,
    frames: 300,
    preroll: 60,
    setup: `P.launch(470, 120); ${CINE(['trackside'])}`,
    post: CINE_POST,
  },
  {
    name: 'w_mtn_day',
    keep: [0, 110],
    query: `${MTN}&time=day&weather=clear&car=xr`,
    frames: 420,
    preroll: 60,
    setup: `P.launch(2200, 170); ${CINE(['tower', 'heli', 'trackside'])}`,
    post: CINE_POST,
  },

  /* ---------------- 车库 ---------------- */
  {
    name: 'garage_gt',
    keep: [0, 90],
    query: 'ui=0&still=1&view=front&car=gt',
    frames: 90,
    preroll: 40,
    setup: ``,
    post: ORBIT(24, 36, 90, 5.6, 0.7, 0.5, 21),
    scoutAt: [0, 89],
  },
  {
    name: 'garage_brute',
    keep: [0, 90],
    query: 'ui=0&still=1&view=front&car=brute',
    frames: 90,
    preroll: 40,
    setup: ``,
    post: ORBIT(-152, -140, 90, 6.4, 0.85, 0.6, 21),
    scoutAt: [0, 89],
  },
  {
    name: 'garage_ronin',
    keep: [0, 90],
    query: 'ui=0&still=1&view=front&car=ronin',
    frames: 90,
    preroll: 40,
    setup: ``,
    post: ORBIT(-36, -48, 90, 5.4, 0.75, 0.6, 21),
    scoutAt: [0, 89],
  },
  {
    name: 'garage_nomad',
    keep: [0, 90],
    query: 'ui=0&still=1&view=front&car=nomad',
    frames: 90,
    preroll: 40,
    setup: ``,
    post: ORBIT(138, 126, 90, 7.4, 1.1, 0.9, 22),
    scoutAt: [0, 89],
  },

  /* ---------------- 收尾：冲过镜头 ---------------- */
  {
    name: 'hero_end',
    keep: [30, 190],
    query: `${NIGHT_RAIN}&car=gt`,
    frames: 200,
    preroll: 120,
    setup: `P.launch(40, 140);`,
    before: AUTO_NITRO,
    cam: FOLLOW(`P.tp(215, -2.2, 0.4)`, 30, 0.6),
    post: `P.still(post, 1 / 80);`,
    scoutAt: [0, 40, 80, 120, 160, 199],
  },
];
