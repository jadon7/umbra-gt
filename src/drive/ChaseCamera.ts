import * as THREE from 'three/webgpu';
import { fitFov } from '../core/fov.ts';
import type { Vehicle } from './Vehicle.ts';
import type { Car } from '../car/Car';
import { CAR_BASES, carLength, type CarModel } from '../car/models.ts';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
/** 两个角度之差，折到 [-π, π] */
const angleDiff = (a: number, b: number) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

interface ChaseSetup {
  name: string;
  dist: number;
  height: number;
  look: number;
  /** 越过车顶要能看见车前多少米以外的路面（镜头按它抬高，见 ChaseCamera.fitCar） */
  clear: number;
}

const SETUPS: ChaseSetup[] = [
  { name: '追尾（远）', dist: 5.7, height: 1.55, look: 0.95, clear: 15 },
  { name: '追尾（近）', dist: 4.3, height: 1.22, look: 0.85, clear: 22 },
];
/** 追尾机位是照着原型车定的：它有这么长 */
const BASE_LENGTH = 4.6;
const BASE_ROOF = 1.15;

/**
 * 从车后面看过去，这台车最高的地方离地多高：车顶，加上车顶上面支出来的东西（高尾翼、皮卡的防滚架和射灯）。
 * 镜头要比它高出一截，不然路的尽头正好被车挡住
 */
function sightHeight(model: CarModel): number {
  const base = CAR_BASES[model.base];
  const extra = model.base === 'nomad' ? 0.22 : model.base === 'ronin' ? 0.1 : model.base === 'brute' ? 0.06 : model.kit.wing === 'gt' ? 0.12 : 0;
  return (base ? base.height : BASE_ROOF) + extra;
}
/** 车头视角：架在引擎盖前段上方，画面下沿能看到一点车头 */
const HOOD = { name: '车头', offset: new THREE.Vector3(0, 0.93, 1.62) };
/** 驾驶室视角：中置驾驶位的眼点（方向盘中心在 z = 0.94，眼睛在它后面约半米） */
const COCKPIT = { name: '驾驶室', eye: new THREE.Vector3(0, 1.0, 0.5), pitch: -0.015 };

const HOOD_MODE = SETUPS.length;
const COCKPIT_MODE = SETUPS.length + 1;
const MODE_COUNT = SETUPS.length + 2;

const _fwd = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const FLIP_Y = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);

/**
 * 试驾镜头，四个机位：追尾（远/近）、车头、驾驶室。
 *  - 追尾：朝向取"车头"和"行进方向"之间，漂移时能看到车身角度，同时仍大致看着前路
 *  - 驾驶室：视线会往弯里带一点；漂移时转向行进方向（就像真人漂移时看着侧窗外的去向）
 *  - 速度越高视野越广，氮气瞬间再拉一截；加减速、过弯、落地、碰撞都有相应的镜头反馈
 */
export class ChaseCamera {
  mode = 0;

  private readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private y = 0;
  private fov = 58;
  private roll = 0;
  private lag = 0;
  private trauma = 0;
  private nitroKick = 0;
  /**
   * 氮气把镜头甩在后面的程度（0 = 没开，1 = 稳定拉远）。它是一根弹簧：从零起步、先慢后快地拉出去，
   * 大约三分之二秒到位，略微冲过头再回到 1——车是「加速窜出去」的，不是画面一下子跳到远处。
   * 松开氮气后更慢地收回来。视野、压低、抖动都跟着它
   */
  private surge = 0;
  private surgeVel = 0;
  /** 过弯时镜头往弯里歪的角度（平滑过的） */
  private bank = 0;
  private headYaw = 0;
  private time = 0;
  /** 驾驶室眼点、车头机位：换车型的时候跟着座舱和车头挪 */
  private readonly eye = COCKPIT.eye.clone();
  private readonly hood = HOOD.offset.clone();
  /** 这台车从后面看有多高；比原型车高、长的车，追尾机位再往后退多少 */
  private roof = BASE_ROOF;
  private back = 0;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** 换了车型：重新算驾驶室和车头两个机位 */
  fitCar(car: Car): void {
    car.cameraPoint('cockpit', this.eye);
    car.cameraPoint('hood', this.hood);
    // 追尾机位：又高又长的车往后退一些。抬多高在 update 里按「越过车顶看得见路」算
    this.roof = sightHeight(car.model);
    this.back = Math.max(0, carLength(car.model) - BASE_LENGTH) * 0.5 + Math.max(0, this.roof - 1.2) * 1.0;
  }

  /** 此刻的视野（度，还没按画面宽高比换算）。赛前镜头把机位交回来的时候用 */
  get baseFov(): number {
    return this.fov;
  }

  get modeName(): string {
    if (this.mode === COCKPIT_MODE) return COCKPIT.name;
    if (this.mode === HOOD_MODE) return HOOD.name;
    return SETUPS[this.mode].name;
  }

  nextMode(): void {
    this.mode = (this.mode + 1) % MODE_COUNT;
  }

  /** 按名字切机位：'far' | 'near' | 'hood' | 'cockpit' */
  setMode(name: string): void {
    const i = ['far', 'near', 'hood', 'cockpit'].indexOf(name);
    if (i >= 0) this.mode = i;
  }

  /** 立即对准车尾（复位时用） */
  snap(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    _fwd.set(0, 0, 1).applyQuaternion(quat);
    this.yaw = Math.atan2(_fwd.x, _fwd.z);
    this.y = pos.y;
    this.fov = 58;
    this.roll = 0;
    this.lag = 0;
    this.trauma = 0;
    this.nitroKick = 0;
    this.surge = 0;
    this.surgeVel = 0;
    this.bank = 0;
    this.headYaw = 0;
  }

  update(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion, v: Vehicle, lookBack: boolean): void {
    const cam = this.camera;
    this.time += dt;
    const t = this.time;
    const cockpit = this.mode === COCKPIT_MODE;

    _fwd.set(0, 0, 1).applyQuaternion(quat);
    const carYaw = Math.atan2(_fwd.x, _fwd.z);
    const lv = v.body.linvel();
    const planar = Math.hypot(lv.x, lv.z);

    let targetYaw = carYaw;
    if (planar > 6 && v.forwardSpeed > 0) {
      const velYaw = Math.atan2(lv.x, lv.z);
      targetYaw = carYaw + angleDiff(velYaw, carYaw) * 0.55;
    }
    if (lookBack) targetYaw += Math.PI;
    this.yaw += angleDiff(targetYaw, this.yaw) * damp(lookBack ? 16 : 6, dt);

    // 冲击只取一次，之后按时间衰减
    this.trauma = Math.max(this.trauma, v.landingImpact * 0.9, v.collisionImpact * 0.85);
    v.landingImpact = 0;
    v.collisionImpact = 0;
    this.trauma = Math.max(0, this.trauma - dt * 1.7);

    const speedN = clamp(v.speed / 92, 0, 1);
    this.nitroKick += ((v.nitroActive ? 1 : 0) - this.nitroKick) * damp(v.nitroActive ? 4 : 3, dt);
    // 氮气的拉远：一根略微欠阻尼的弹簧。开着氮气时朝 1 走（冲过头一成多再回来），松开后慢慢回零、不过冲
    {
      const target = v.nitroActive ? 1 : 0;
      const w = v.nitroActive ? 5.2 : 2.2;
      const zeta = v.nitroActive ? 0.55 : 1;
      // 步长大的时候（掉帧）分两小步积分，免得弹簧算飞
      const sub = dt > 0.02 ? 2 : 1;
      const h = dt / sub;
      for (let i = 0; i < sub; i++) {
        this.surgeVel += (w * w * (target - this.surge) - 2 * zeta * w * this.surgeVel) * h;
        this.surge += this.surgeVel * h;
      }
    }
    const surge = clamp(this.surge, 0, 1.3);
    const shake = this.trauma * this.trauma + speedN * speedN * 0.07 + this.nitroKick * 0.2 + Math.abs(this.surgeVel) * 0.06;

    const speedCurve = speedN * speedN * (3 - 2 * speedN);
    // 视野：越快越广，氮气再拉宽一截（广角下路边的东西掠过得更快，是速度感的主要来源）
    const fovTarget = cockpit ? 66 + 14 * speedCurve + surge * 9 : Math.min(56 + 20 * speedCurve + surge * 15, 96);
    this.fov += (fovTarget - this.fov) * damp(6, dt);

    // 加速时车往前窜、镜头被甩在后面；刹车时镜头往前贴
    this.lag += (clamp(v.longG * 1.25, -0.9, 1.7) - this.lag) * damp(4, dt);
    // 过弯：镜头往弯里歪，弯越急、越快歪得越多（最多六度左右），漂移时按车身甩出去的角度再加一点
    const bankTarget = clamp(v.lateralG * 0.042 - v.sideSlip * 0.05 * clamp(planar / 20, 0, 1), -0.11, 0.11);
    this.bank += (bankTarget - this.bank) * damp(3.6, dt);
    this.roll = this.bank * (cockpit ? 0.35 : 1);
    this.y += (pos.y - this.y) * damp(9, dt);

    // 驾驶室视线：过弯时往弯里带一点；侧滑时转向实际行进方向
    const lookTarget = planar > 2 ? clamp(v.sideSlip * 0.7 + v.steerAngle * 0.3, -0.75, 0.75) : 0;
    this.headYaw += (lookTarget - this.headYaw) * damp(5, dt);

    if (cockpit) {
      // 头部跟着车身走，但加减速和过弯时有一点惯性位移
      _eye.copy(this.eye);
      _eye.z -= clamp(this.lag * 0.05, -0.03, 0.045);
      _eye.x -= clamp(v.lateralG, -2, 2) * 0.012;
      cam.position.copy(_eye).applyQuaternion(quat).add(pos);
      _yawQ.setFromAxisAngle(UP, this.headYaw + (lookBack ? Math.PI : 0));
      cam.quaternion.copy(quat).multiply(_yawQ).multiply(FLIP_Y); // 相机默认朝 -Z，车头是 +Z
      cam.rotateX(COCKPIT.pitch);
      cam.rotateZ(this.roll);
    } else if (this.mode === HOOD_MODE) {
      cam.position.copy(this.hood).applyQuaternion(quat).add(pos);
      _q.copy(quat).multiply(FLIP_Y);
      if (lookBack) _q.multiply(FLIP_Y);
      cam.quaternion.copy(_q);
    } else {
      const s = SETUPS[this.mode];
      // 镜头距离：车速越高拉得越远，开氮气再拉远一大截（有个从慢到快的过程，见 surge）；
      // 同时压低，贴着路面更显快
      const base = s.dist + this.back;
      const dist = base + this.lag + speedCurve * 1.6 + surge * 3.3;
      // 镜头至少要高到：视线擦着车顶过去，落在车前 clear 米的路面上。
      // 原型车又矮又窄，照原来的高度就差不多；掀背车、皮卡这种又高又方的不抬的话，路的尽头正好被车挡死
      const stand = Math.max(s.height, (this.roof * (s.clear + base)) / s.clear);
      const height = stand - speedCurve * 0.16 - surge * 0.3;
      _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      cam.position.set(pos.x - _dir.x * dist, Math.max(this.y + height, 0.35), pos.z - _dir.z * dist);
      // 抬高了以后视线也跟着抬一半：不然画面里全是地面，天只剩一条
      _look.set(pos.x + _dir.x * 2.2, this.y + s.look + (stand - s.height) * 0.55, pos.z + _dir.z * 2.2);
      cam.lookAt(_look);
      cam.rotateZ(this.roll);
    }

    if (shake > 0.001) {
      const n = (f: number, p: number) => Math.sin(t * f + p) * 0.6 + Math.sin(t * f * 2.31 + p * 1.7) * 0.4;
      // 驾驶室里参照物很近，同样的位移看起来更晃，幅度减半
      const amp = Math.min(shake, 1.2) * (cockpit ? 0.5 : 1);
      cam.translateX(n(37, 0.3) * amp * 0.05);
      cam.translateY(n(43, 2.1) * amp * 0.06);
      cam.rotateX(n(31, 4.2) * amp * 0.008);
      cam.rotateZ(n(29, 1.4) * amp * 0.01);
    }

    // 驾驶室里方向盘、仪表离眼睛很近，近裁剪面要拉近
    const near = cockpit ? 0.06 : 0.2;
    const fov = fitFov(this.fov, cam.aspect);
    if (Math.abs(cam.fov - fov) > 0.01 || cam.near !== near) {
      cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }
}
