import * as THREE from 'three/webgpu';

/**
 * 分块：把覆盖全城的大网格按地面上的格子切开。
 *
 * 城市里同一种材质的东西原本合并成一整块网格（省绘制次数），但这样每画一遍——主画面、三级阴影、
 * 反射探针的每个面——都要把全城的顶点过一遍，哪怕镜头只看得到一个街口。
 * 切成格子以后，每块有自己的包围球，镜头（或者阴影、探针的视野）外的格子整块跳过。
 * 只切顶点多的网格；楼体立面、路面这些面数很少、花销在像素上的不用切。
 */

/** 格子的边长（米）：两个半街区。太小绘制次数会涨，太大裁不掉东西 */
export const CHUNK = 275;

export { DETAIL_LAYER } from '../core/layers.ts';

/** 把一块带索引的网格按三角形所在的格子切成几块。只有一格的话原样返回 */
export function splitGeometry(g: THREE.BufferGeometry, cell = CHUNK): THREE.BufferGeometry[] {
  const index = g.index;
  const pos = g.attributes.position;
  if (!index || !pos) return [g];
  const cells = new Map<number, number[]>();
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    const cx = Math.floor((pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 / cell);
    const cz = Math.floor((pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3 / cell);
    const key = (cx + 512) * 1024 + (cz + 512);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(a, b, c);
  }
  if (cells.size <= 1) return [g];

  const names = Object.keys(g.attributes);
  const out: THREE.BufferGeometry[] = [];
  for (const tris of cells.values()) {
    const remap = new Map<number, number>();
    const data: number[][] = names.map(() => []);
    const idx: number[] = [];
    for (const old of tris) {
      let n = remap.get(old);
      if (n === undefined) {
        n = remap.size;
        remap.set(old, n);
        names.forEach((name, k) => {
          const attr = g.attributes[name];
          const src = attr.array as ArrayLike<number>;
          for (let i = 0; i < attr.itemSize; i++) data[k].push(src[old * attr.itemSize + i]);
        });
      }
      idx.push(n);
    }
    const part = new THREE.BufferGeometry();
    names.forEach((name, k) => part.setAttribute(name, new THREE.Float32BufferAttribute(data[k], g.attributes[name].itemSize)));
    part.setIndex(idx);
    part.computeBoundingSphere();
    out.push(part);
  }
  g.dispose();
  return out;
}

/** 把一批东西按所在的格子分组（给"同一种东西画很多份"的实例化网格用：每个格子一组） */
export function groupByCell<T extends { x: number; z: number }>(items: T[], cell = CHUNK): T[][] {
  const cells = new Map<number, T[]>();
  for (const it of items) {
    const key = (Math.floor(it.x / cell) + 512) * 1024 + (Math.floor(it.z / cell) + 512);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(it);
  }
  return [...cells.values()];
}
