/**
 * 车辆调校参数。坐标约定：车身局部 +X 向左、+Y 向上、+Z 向前，
 * 原点在车辆中心正下方的地面上（静止时四个轮胎接地点所在平面）。
 * 单位：米、千克、秒、牛、弧度。
 */
export interface VehicleConfig {
  mass: number;
  /** 质心（局部坐标） */
  com: [number, number, number];
  /** 绕质心的主转动惯量：[俯仰(绕X), 偏航(绕Y), 侧倾(绕Z)] */
  inertia: [number, number, number];

  /** 车身碰撞盒：中心与半尺寸 */
  bodyCenter: [number, number, number];
  bodyHalf: [number, number, number];

  /** 轮心静止位置（局部坐标）：左前、右前、左后、右后 */
  wheelPos: [number, number, number][];
  wheelRadius: number;

  /* 悬挂 */
  suspBump: number; // 从静止位置向上的压缩行程
  suspDroop: number; // 从静止位置向下的伸展行程
  suspFreqFront: number; // 固有频率 Hz
  suspFreqRear: number;
  suspDampBump: number; // 阻尼比
  suspDampRebound: number;

  /* 轮胎 */
  muLatFront: number;
  muLatRear: number;
  muLong: number;
  /** 侧向力达到峰值时的侧偏角 */
  slipPeakFront: number;
  slipPeakRear: number;
  /** 完全滑动时相对峰值的比例 */
  slideRatio: number;
  /** 载荷敏感度：载荷越大，摩擦系数略降 */
  loadSensitivity: number;
  /** 纵向力占满时侧向抓地被削弱的程度（0 不削弱，1 完全按摩擦圆） */
  frictionCoupling: number;
  /** 轮胎力作用点从地面抬高到质心高度的比例：越大，加减速点头和侧倾越小 */
  forceHeight: number;

  /* 转向 */
  steerMax: number; // 低速最大转角
  steerMin: number; // 高速最大转角
  steerSpeedRef: number; // 转角随速度衰减的参考速度 m/s
  steerRate: number; // 输入打满所需速度（1/秒）
  steerReturn: number; // 回正速度（1/秒）

  /* 动力 */
  driveSplitFront: number; // 前轴驱动力占比（0 = 后驱）
  torqueCurve: [number, number][]; // [转速, 扭矩 N·m]
  idleRpm: number;
  redline: number;
  gears: number[];
  reverseGear: number;
  finalDrive: number;
  driveEfficiency: number;
  shiftUpRpm: number;
  shiftDownRpm: number;
  shiftTime: number;
  engineBrake: number; // 收油时的发动机制动力（牛，满转速时）

  /* 制动 */
  brakeForce: number; // 总制动力（牛）
  brakeBiasFront: number;
  handbrakeForce: number;

  /* 空气动力 */
  drag: number; // F = drag · v²
  downforce: number; // F = downforce · v²
  rollingResistance: number;

  /* 氮气 */
  nitroForce: number; // 额外推力（牛）
  nitroTorqueBoost: number; // 发动机扭矩倍率增量
  nitroDuration: number; // 满罐可用秒数
  nitroRegen: number; // 每秒自然回充（占满罐比例）
  nitroDriftRegen: number; // 漂移时每秒额外回充
  nitroAirRegen: number; // 腾空时每秒额外回充

  /* 辅助 */
  /** 偏航稳定：把实际偏航角速度拉向"按方向盘应有的角速度"的强度（1/秒） */
  yawAssist: number;
  /** 漂移判定：进入/退出的车身侧滑角 */
  driftEnter: number;
  driftExit: number;
  /** 漂移时后轮侧向抓地倍率 */
  driftRearGrip: number;
  /** 漂移时前轮自动反打的比例（0–1） */
  driftCounterSteer: number;
  /** 漂移中松开方向盘时保持的侧滑角 */
  driftAngleHold: number;
  /** 漂移中往弯里打满时的侧滑角 */
  driftAngleMax: number;
  /** 拉着手刹漂移时的侧滑角（比打满还大，用来过回头弯） */
  driftAngleBrake: number;
  /**
   * 车身甩到 driftAngleMax 时，行进路线每秒往弯里拐多少（弧度/秒）。角度小的时候按比例减小。
   * 管的是「拐多快」而不是「横向多大力」：所以车速高的时候一样拐得动，漂移才是过弯的主要手段
   * （按固定的横向力算的话，车速翻一倍、拐弯就慢一半，高速时漂了等于没漂）
   */
  driftTurnMax: number;
  /** 上面那个比例的指数：1 = 角度和拐弯快慢成正比，大于 1 = 小角度时拐得更缓 */
  driftLatCurve: number;
  /** 漂移时横向加速度的上限（单位 g）：车速很高时拐弯速度被它压住，得先把车速滑下来 */
  driftLatMax: number;
  /**
   * 收车的快慢（1/秒）：车身的角度比目标大的时候（反打、松油、松开方向），
   * 不是把车头摆回行进方向，而是让行进方向追上车头——车头指到哪，车最后就往哪走
   */
  driftAlign: number;
  /** 收车时稳住车头的力度（1/秒） */
  driftNoseHold: number;
  /**
   * 收车时「行进方向追车头」占多少（0–1），剩下的是「车头往回摆」。
   * 1 = 车头不动、行进方向全追过去（车头指哪走哪，但松手后还要再拐一大截，很难停）；
   * 0 = 行进方向不动、车头全摆回来（一松手就不拐了，但车头白指了）
   */
  driftNoseShare: number;
  /** 漂移掉速系数：减速度 = driftScrub × sin(侧滑角) × g ×（0.25 + (车速 / 38)²） */
  driftScrub: number;
  /**
   * 漂移中踩着油门时，沿车头方向额外给的推力（单位 g，全油门、车身已经甩出角度时给足）。
   * 车头指向弯内，所以这股力一边把车往弯里带，一边补上横滑掉的车速：油门踩得越深，车越往车头指的方向走
   */
  driftPush: number;
  /** 上面那股推力从多快开始减弱、到多快完全没有（米/秒） */
  driftPushFade: [number, number];
  /** 路线提前量：车身还没甩到目标角度时，先按目标角度的这个比例拐弯（0 = 完全等车身甩出去） */
  driftLead: number;
  /** 漂移中驱动力保留的比例 */
  driftDrive: number;
  /** 漂移中轮胎侧向力让位给线路控制的比例（0–1） */
  driftTireCut: number;
  /** 往弯里打时漂移线路的响应速度（1/秒；反打时为它的两倍）。越小越柔，键盘按住方向时角度是渐进加大的 */
  driftLineRate: number;
  /** 漂移角度控制器的比例、微分增益 */
  driftKp: number;
  driftKd: number;
  /** 非漂移状态下侧滑的回正强度 */
  slideRecover: number;
  /** 点刹入弯时推车尾的偏航角加速度（弧度/秒²） */
  kickYaw: number;
  /** 腾空姿态稳定强度 */
  airStabilize: number;
}

export const DEFAULT_CONFIG: VehicleConfig = {
  mass: 1450,
  com: [0, 0.36, 0.03],
  inertia: [3200, 2500, 950],

  bodyCenter: [0, 0.58, 0.24],
  bodyHalf: [0.97, 0.33, 2.16],

  wheelPos: [
    [0.976, 0.384, 1.485],
    [-0.976, 0.384, 1.485],
    [0.982, 0.384, -1.314],
    [-0.982, 0.384, -1.314],
  ],
  wheelRadius: 0.384,

  suspBump: 0.1,
  suspDroop: 0.12,
  suspFreqFront: 2.3,
  suspFreqRear: 2.2,
  suspDampBump: 0.55,
  suspDampRebound: 0.8,

  muLatFront: 1.5,
  muLatRear: 1.75,
  muLong: 1.5,
  slipPeakFront: 0.12,
  slipPeakRear: 0.11,
  slideRatio: 0.8,
  loadSensitivity: 0.1,
  frictionCoupling: 0.45,
  forceHeight: 0.55,

  steerMax: 0.58,
  steerMin: 0.055,
  steerSpeedRef: 17,
  steerRate: 5.0,
  steerReturn: 7.0,

  driveSplitFront: 0.0,
  torqueCurve: [
    [1000, 410],
    [2500, 560],
    [4000, 660],
    [5500, 690],
    [7000, 660],
    [8200, 585],
  ],
  idleRpm: 1000,
  redline: 8200,
  gears: [3.25, 2.15, 1.58, 1.22, 0.98, 0.84],
  reverseGear: 3.0,
  finalDrive: 3.55,
  driveEfficiency: 0.9,
  shiftUpRpm: 7700,
  shiftDownRpm: 3600,
  shiftTime: 0.11,
  engineBrake: 1800,

  brakeForce: 21000,
  brakeBiasFront: 0.62,
  handbrakeForce: 9000,

  drag: 0.47,
  downforce: 1.1,
  rollingResistance: 180,

  nitroForce: 10500,
  nitroTorqueBoost: 0.4,
  nitroDuration: 3.4,
  nitroRegen: 0.04,
  nitroDriftRegen: 0.22,
  nitroAirRegen: 0.15,

  yawAssist: 3.0,
  driftEnter: 0.2,
  driftExit: 0.1,
  driftRearGrip: 0.8,
  driftCounterSteer: 0.6,
  driftAngleHold: 0.5,
  driftAngleMax: 0.86,
  driftAngleBrake: 1.02,
  driftTurnMax: 1.5,
  driftLatCurve: 1.3,
  driftLatMax: 3.2,
  driftAlign: 9,
  driftNoseHold: 9,
  driftNoseShare: 0.5,
  driftScrub: 1.1,
  driftPush: 0.6,
  driftPushFade: [30, 46],
  driftLead: 0.45,
  driftDrive: 0.6,
  driftTireCut: 0.9,
  driftLineRate: 2.4,
  driftKp: 16,
  driftKd: 6.5,
  slideRecover: 6,
  kickYaw: 5.5,
  airStabilize: 4.0,
};
