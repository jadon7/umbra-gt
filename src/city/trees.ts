import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** 固定种子的随机数 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按位置算出来的随机数：同一个位置永远得到同一个值（接缝两边的顶点挪动得一样，不会裂开） */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export interface TreeGeometry {
  trunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
}

/**
 * 一棵树的两块几何体：树干（主干加三四根斜着伸出去的枝）和树冠。
 * 树冠不是一个球，是八九团大小不一、表面坑坑洼洼的叶团挤在一起：顶上一团，中间一圈，下面垂着两三团。
 * 这样轮廓是起伏的，团和团之间有阴影。按 1 倍大小建（高约 6.5 米），用的时候整体缩放。
 */
export function createTree(seed: number): TreeGeometry {
  const rnd = rng(seed);

  /* 树干和枝 */
  const wood: THREE.BufferGeometry[] = [];
  const trunkH = 3.3;
  const trunk = new THREE.CylinderGeometry(0.1, 0.2, trunkH, 7, 3);
  trunk.translate(0, trunkH / 2, 0);
  // 主干不是笔直的：中间稍微弯一下
  {
    const p = trunk.attributes.position;
    const bendX = (rnd() - 0.5) * 0.3;
    const bendZ = (rnd() - 0.5) * 0.3;
    for (let i = 0; i < p.count; i++) {
      const k = Math.sin((p.getY(i) / trunkH) * Math.PI);
      p.setX(i, p.getX(i) + bendX * k);
      p.setZ(i, p.getZ(i) + bendZ * k);
    }
  }
  wood.push(trunk);
  const branches = 3 + Math.floor(rnd() * 2);
  const tips: THREE.Vector3[] = [];
  for (let b = 0; b < branches; b++) {
    const len = 1.5 + rnd() * 0.9;
    const g = new THREE.CylinderGeometry(0.04, 0.085, len, 5);
    g.translate(0, len / 2, 0);
    const tilt = 0.55 + rnd() * 0.45;
    const azimuth = (b / branches) * Math.PI * 2 + rnd() * 0.8;
    const y = 2.5 + rnd() * 0.7;
    g.rotateZ(-tilt);
    g.rotateY(azimuth);
    g.translate(0, y, 0);
    wood.push(g);
    tips.push(new THREE.Vector3(Math.sin(tilt) * len, Math.cos(tilt) * len, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), azimuth).add(new THREE.Vector3(0, y, 0)));
  }

  /* 树冠 */
  const blobs: THREE.BufferGeometry[] = [];
  const blob = (x: number, y: number, z: number, rx: number, ry: number, rz: number) => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const px = p.getX(i);
      const py = p.getY(i);
      const pz = p.getZ(i);
      // 每个顶点沿半径方向进进出出一点；底下压扁（叶团的下沿比较平）
      const k = 0.8 + hash3(px + seed, py, pz) * 0.42;
      const flat = py < 0 ? 0.72 : 1;
      p.setXYZ(i, x + px * rx * k, y + py * ry * k * flat, z + pz * rz * k);
    }
    blobs.push(g);
  };
  // 顶上一团
  blob((rnd() - 0.5) * 0.4, 5.25, (rnd() - 0.5) * 0.4, 1.35, 1.2, 1.35);
  // 中间一圈
  const ringCount = 5 + Math.floor(rnd() * 2);
  for (let k = 0; k < ringCount; k++) {
    const a = (k / ringCount) * Math.PI * 2 + rnd() * 0.5;
    const r = 1.15 + rnd() * 0.4;
    const s = 1.05 + rnd() * 0.4;
    blob(Math.cos(a) * r, 4.25 + rnd() * 0.55, Math.sin(a) * r, s, s * 0.85, s);
  }
  // 枝梢上各挂一团小的
  for (const t of tips) {
    const s = 0.75 + rnd() * 0.3;
    blob(t.x, Math.max(t.y, 3.5), t.z, s, s * 0.8, s);
  }

  const merged = (list: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    // 只留位置，合并后把重合的顶点焊起来再算法线：每一团表面是圆滑的
    const plain = list.map((g) => {
      const out = new THREE.BufferGeometry();
      const src = g.index ? g.toNonIndexed() : g;
      out.setAttribute('position', src.attributes.position.clone());
      return out;
    });
    const all = mergeVertices(mergeGeometries(plain), 1e-4);
    all.computeVertexNormals();
    all.computeBoundingSphere();
    return all;
  };
  return { trunk: merged(wood), crown: merged(blobs) };
}
