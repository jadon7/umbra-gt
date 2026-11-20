/**
 * 无头脚本共用：按名字建一张地图的碰撞体，给出它的赛道。
 * 命令行里写 map=mountain 选山路，不写就是城市。
 */
import { addCityColliders, buildStructures } from '../../src/city/cityPhysics.ts';
import { buildCityTrack, type CityTrack } from '../../src/city/cityLayout.ts';
import { addMountainColliders } from '../../src/mountain/mountainPhysics.ts';
import { buildMountainTrack } from '../../src/mountain/mountainLayout.ts';
import { PhysicsWorld } from '../../src/drive/PhysicsWorld.ts';

export interface LoadedMap {
  name: string;
  label: string;
  physics: PhysicsWorld;
  track: CityTrack;
  /** 起点的路面高度 */
  startY: number;
  /** 一句话说明碰撞体的规模 */
  info: string;
}

export function mapArg(): string {
  return process.argv.find((a) => a.startsWith('map='))?.slice(4) ?? 'city';
}

export async function loadMap(name = mapArg()): Promise<LoadedMap> {
  const physics = await PhysicsWorld.create();
  if (name === 'mountain') {
    physics.beginGroup('mountain');
    addMountainColliders(physics);
    const track = buildMountainTrack();
    return { name, label: '云岭山道', physics, track, startY: track.start.y, info: `隧道和桥 ${track.spans.length} 处` };
  }
  physics.beginGroup('city');
  const st = buildStructures();
  addCityColliders(physics, st);
  const track = buildCityTrack();
  const info = `街区 ${st.blocks.length}、楼 ${st.blocks.reduce((k, b) => k + b.buildings.length, 0)}、护栏 ${st.barriers.length}、墙段 ${st.walls.length}、立柱 ${st.elevatedColumns.length + st.lowerColumns.length}`;
  return { name: 'city', label: '霓虹湾', physics, track, startY: 0, info };
}
