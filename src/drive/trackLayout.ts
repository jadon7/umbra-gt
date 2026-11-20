import { CatmullRomCurve3, Vector3 } from 'three';

/**
 * 测试场赛道的中心线。平地赛道，坐标单位米。
 * 车头朝 +Z 时左手边是 +X，所以这条线整体是一圈左弯，中间夹一段 S 弯。
 */
const WAYPOINTS: [number, number][] = [
  [0, -300], // 主直道起点
  [0, -100],
  [0, 100],
  [0, 300], // 主直道终点
  [30, 400], // 高速左弯
  [120, 465],
  [235, 435],
  [295, 340],
  [275, 230], // S 弯
  [205, 150],
  [195, 55],
  [262, -25],
  [300, -125],
  [282, -235], // 回头弯前的减速区
  [205, -310],
  [120, -375],
  [40, -395], // 回头弯
];

export const TRACK_HALF_WIDTH = 7.5;

export interface TrackSample {
  /** 沿赛道的累计距离 */
  s: number;
  pos: Vector3;
  /** 行进方向（单位向量，y = 0） */
  dir: Vector3;
  /** 左侧方向（单位向量） */
  left: Vector3;
}

export interface TrackLayout {
  samples: TrackSample[];
  length: number;
  /** 出发点和车头朝向（绕 Y 轴，0 = +Z） */
  start: { x: number; z: number; yaw: number };
}

/** 按固定间距采样赛道中心线 */
export function buildTrackLayout(spacing = 3): TrackLayout {
  const curve = new CatmullRomCurve3(
    WAYPOINTS.map(([x, z]) => new Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  const length = curve.getLength();
  const n = Math.round(length / spacing);
  const samples: TrackSample[] = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const pos = curve.getPointAt(u);
    const dir = curve.getTangentAt(u).setY(0).normalize();
    const left = new Vector3().crossVectors(up, dir).normalize();
    samples.push({ s: u * length, pos, dir, left });
  }
  // 出发点：主直道上，起点线后面一点
  const start = { x: 0, z: -250, yaw: 0 };
  return { samples, length, start };
}
