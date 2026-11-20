import * as THREE from 'three/webgpu';

const UP = new THREE.Vector3(0, 1, 0);
/** 上臂、前臂的长度（米） */
const UPPER = 0.3;
const FORE = 0.265;
/** 握在方向盘的十点和两点位置（从水平往上抬的角度）：再低就落到画面外面去了 */
const GRIP_ANGLE = 0.5;
/** 手腕相对握点的位置（手的本地坐标）：朝驾驶员一侧、略偏轮圈外沿 */
const WRIST = new THREE.Vector3(0, 0.016, 0.082);
/** 手最多跟着方向盘转多少（弧度） */
const MAX_FOLLOW = 0.5;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/** 一段手臂：一根两头粗细不同的圆柱，沿本地 +Y，长度为 1（用的时候按实际长度拉伸） */
function limb(r0: number, r1: number, material: THREE.Material): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r1, r0, 1, 16, 1);
  g.translate(0, 0.5, 0);
  return new THREE.Mesh(g, material);
}

/**
 * 一只握着方向盘的手。本地坐标：原点在轮圈管子的中心线上，
 * +X 沿轮圈的切线，+Y 朝轮圈外（离开方向盘中心），+Z 朝驾驶员。
 * @param thumb 拇指在切线的哪一侧（+1 / -1）：两只手的拇指都朝上
 */
function buildHand(glove: THREE.Material, pad: THREE.Material, thumb: number): THREE.Group {
  const g = new THREE.Group();
  const tube = 0.019;
  // 四根手指：从轮圈外沿绕过去，扣到背面
  for (let i = 0; i < 4; i++) {
    const r = 0.0098 - (i === 3 ? 0.0012 : 0);
    const finger = new THREE.TorusGeometry(tube + r + 0.001, r, 8, 14, Math.PI * 1.25);
    // 环面默认绕 Z 轴；转成绕 X 轴（轮圈的切线），再转到"从朝驾驶员的一面出发，往外、往背面绕"
    finger.rotateY(Math.PI / 2);
    finger.rotateX(-Math.PI * 0.12);
    const mesh = new THREE.Mesh(finger, glove);
    mesh.position.x = (i - 1.5) * 0.0205 * -thumb;
    g.add(mesh);
  }
  // 指根的四个关节：从驾驶员的角度看，手背前沿是一排鼓起来的指节
  for (let i = 0; i < 4; i++) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.0125 - (i === 3 ? 0.0015 : 0), 10, 8), glove);
    k.position.set((i - 1.5) * 0.0205 * -thumb, 0.031, 0.006);
    g.add(k);
  }
  // 手背：压扁的椭球，从指节一路铺到手腕
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), glove);
  palm.scale.set(0.044, 0.024, 0.05);
  palm.position.set(0, 0.027, 0.04);
  palm.rotation.x = -0.42;
  g.add(palm);
  // 手背上一条收紧用的搭扣带：一点颜色，手才不是黑乎乎的一团
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.006, 0.015), pad);
  strap.position.set(0, 0.043, 0.07);
  strap.rotation.x = -0.42;
  g.add(strap);
  // 拇指：贴着轮圈朝驾驶员的一面，顺着轮圈指向上方
  const th = new THREE.Mesh(new THREE.CapsuleGeometry(0.0105, 0.03, 4, 10), glove);
  th.position.set(thumb * 0.05, 0.002, 0.024);
  th.rotation.z = Math.PI / 2 - thumb * 0.2;
  g.add(th);
  // 手腕
  const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.033, 14, 10), glove);
  wrist.position.copy(WRIST).multiplyScalar(0.86);
  wrist.scale.set(1.05, 0.8, 1.0);
  g.add(wrist);
  return g;
}

interface Arm {
  upper: THREE.Mesh;
  fore: THREE.Mesh;
  cuff: THREE.Mesh;
  elbow: THREE.Mesh;
  hand: THREE.Group;
  /** 握点在方向盘平面里的方向（方向盘的本地坐标，跟着方向盘转） */
  grip: THREE.Vector3;
  shoulder: THREE.Vector3;
  /** 手肘往哪边撑 */
  pole: THREE.Vector3;
}

/**
 * 驾驶员的两条手臂，只在驾驶室视角里显示（镜头就是驾驶员的眼睛，所以没有头和身子）。
 * 双手握在方向盘十点和两点的位置，跟着方向盘一起转；肩膀固定在座椅上，
 * 手肘的位置每帧按"肩到手腕的距离"反推出来，所以打方向时小臂和上臂会自然地开合、交叉。
 *
 * 整组东西挂在方向盘转轴的父节点下面，和内饰在同一个坐标系里。
 */
export class DriverArms {
  readonly group = new THREE.Group();

  private readonly arms: Arm[] = [];

  /**
   * @param accent 手套护垫和袖口条纹的颜色
   */
  constructor(accent: THREE.ColorRepresentation = '#d2222a') {
    const sleeve = new THREE.MeshStandardMaterial({ color: '#1d1e24', roughness: 0.78, metalness: 0.0, name: 'Driver_Sleeve' });
    const glove = new THREE.MeshStandardMaterial({ color: '#101013', roughness: 0.5, metalness: 0.0, name: 'Driver_Glove' });
    const pad = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.45, metalness: 0.1, name: 'Driver_Pad' });
    for (const side of [1, -1]) {
      const upper = limb(0.062, 0.05, sleeve);
      const fore = limb(0.05, 0.036, sleeve);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.0385, 0.04, 0.014, 16), pad);
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.051, 14, 10), sleeve);
      // 左手（side = +1，车身 +X 一侧）的拇指朝上：切线方向由握点算出来，这里先按左右给符号
      const hand = buildHand(glove, pad, side);
      for (const o of [upper, fore, cuff, elbow, hand]) this.group.add(o);
      this.arms.push({ upper, fore, cuff, elbow, hand, grip: new THREE.Vector3(), shoulder: new THREE.Vector3(), pole: new THREE.Vector3() });
    }
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.frustumCulled = false;
      }
    });
    this.group.visible = false;
    this.group.name = 'DriverArms';
  }

  /**
   * 按这辆车的座舱摆好肩膀和握点。坐标都在方向盘转轴的父节点坐标系里。
   * @param left 车身朝左的方向；up 车身朝上的方向
   * @param eye 驾驶员眼睛的位置
   * @param pivotQuat 方向盘没打方向时转轴的朝向
   */
  fit(eye: THREE.Vector3, left: THREE.Vector3, up: THREE.Vector3, pivotQuat: THREE.Quaternion): void {
    const inv = _q.copy(pivotQuat).invert();
    // 方向盘平面里的"左"和"上"（转轴的本地坐标）
    const u = _a.copy(left).applyQuaternion(inv).setZ(0).normalize().clone();
    const w = _b.copy(up).applyQuaternion(inv).setZ(0).normalize().clone();
    const back = _c.crossVectors(up, left).normalize(); // 朝车尾
    this.arms.forEach((arm, k) => {
      const s = k === 0 ? 1 : -1;
      arm.grip.copy(u).multiplyScalar(s * Math.cos(GRIP_ANGLE)).addScaledVector(w, Math.sin(GRIP_ANGLE));
      arm.shoulder.copy(eye).addScaledVector(left, s * 0.215).addScaledVector(up, -0.235).addScaledVector(back, 0.1);
      arm.pole.copy(left).multiplyScalar(s * 0.75).addScaledVector(up, -0.66);
    });
  }

  /**
   * 每帧：方向盘转到哪了，手就跟到哪。
   * @param pivotPos,pivotQuat 方向盘转轴此刻的位置和朝向（已经包含打方向的转角）
   * @param rim 轮圈半径
   * @param angle 方向盘此刻打了多少（弧度）。手最多跟着转 MAX_FOLLOW 那么多，再往下打方向盘就在手里滑过去
   *   （不然方向打满时一只手会举到方向盘正上方，把仪表和前面的路挡住）
   */
  update(pivotPos: THREE.Vector3, pivotQuat: THREE.Quaternion, rim: number, angle = 0): void {
    if (!this.group.visible) return;
    const slip = angle - Math.max(-MAX_FOLLOW, Math.min(MAX_FOLLOW, angle));
    const cs = Math.cos(-slip);
    const sn = Math.sin(-slip);
    for (const arm of this.arms) {
      // 握点和手的朝向。握点先在方向盘平面里往回转掉"滑过去"的那部分
      const gx = arm.grip.x * cs - arm.grip.y * sn;
      const gy = arm.grip.x * sn + arm.grip.y * cs;
      const radial = _a.set(gx, gy, 0).applyQuaternion(pivotQuat);
      const axis = _b.set(0, 0, 1).applyQuaternion(pivotQuat);
      const tangent = _c.crossVectors(radial, axis).normalize();
      arm.hand.position.copy(pivotPos).addScaledVector(radial, rim);
      _m.makeBasis(tangent, radial, axis);
      arm.hand.quaternion.setFromRotationMatrix(_m);

      // 手腕：前臂接在这里
      const wrist = _a.copy(WRIST).applyQuaternion(arm.hand.quaternion).add(arm.hand.position);
      const s = arm.shoulder;
      _dir.subVectors(wrist, s);
      const reach = Math.min(_dir.length(), (UPPER + FORE) * 0.995);
      _dir.normalize();
      // 两段手臂加上"肩到手腕"构成一个三角形：手肘到这条连线的垂足和垂距
      const along = (UPPER * UPPER - FORE * FORE + reach * reach) / (2 * reach);
      const off = Math.sqrt(Math.max(0, UPPER * UPPER - along * along));
      _n.copy(arm.pole).addScaledVector(_dir, -arm.pole.dot(_dir)).normalize();
      const elbow = _c.copy(s).addScaledVector(_dir, along).addScaledVector(_n, off);

      arm.elbow.position.copy(elbow);
      arm.upper.position.copy(s);
      _dir.subVectors(elbow, s);
      arm.upper.scale.set(1, _dir.length(), 1);
      arm.upper.quaternion.setFromUnitVectors(UP, _dir.normalize());
      arm.fore.position.copy(elbow);
      _dir.subVectors(wrist, elbow);
      const len = _dir.length();
      arm.fore.scale.set(1, len, 1);
      arm.fore.quaternion.setFromUnitVectors(UP, _dir.normalize());
      // 袖口：前臂靠近手腕的一圈
      arm.cuff.position.copy(elbow).addScaledVector(_dir, len - 0.03);
      arm.cuff.quaternion.copy(arm.fore.quaternion);
    }
  }
}
