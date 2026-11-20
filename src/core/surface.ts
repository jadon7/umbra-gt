import { Fn, property } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 屏幕空间反射用的两个"每个像素一份"的量。
 * 默认按材质的粗糙度和金属度自动推算（玻璃、水面、车漆会反射，砖墙沥青不会）；
 * 个别材质想自己指定时，用 withSurface() 把颜色包一层；反射率给 -1 表示这个像素不参与屏幕空间反射。
 */
export const surfaceReflect: N = property('float', 'SurfaceReflect');
export const surfaceBlur: N = property('float', 'SurfaceBlur');

/**
 * 返回和 color 一样的节点，但顺带把这个材质的反射率和反射模糊度写进去。
 * 用法：material.colorNode = withSurface(color, 0.1, 0.5)
 */
export function withSurface(color: N, reflect: N, blur: N): N {
  return Fn(() => {
    surfaceReflect.assign(reflect);
    surfaceBlur.assign(blur);
    return color;
  })();
}
