import * as THREE from 'three/webgpu';
import { cameraFar, cameraNear, perspectiveDepthToViewZ, positionView, screenUV, smoothstep, texture } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * 主画面的深度图。引擎建好后期管线之后会把真正的贴图换进来。
 *
 * 雨丝、水雾、闪电这类半透明的特效不放在主场景里，而是放进引擎的"特效叠加层"单独渲染：
 * 主画面同时还在输出法线、反射参数、运动速度，半透明的东西画进去会把这些信息盖掉。
 * 叠加层没有自己的深度，所以特效材质要自己查这张图，判断有没有被主画面里的东西挡住。
 */
export const sceneDepth: N = texture(new THREE.DepthTexture(1, 1));

/**
 * 特效材质用：被主画面挡住的部分不画，贴近遮挡物的地方渐隐（避免生硬的切边）。
 * @param soft 离遮挡物多近开始变淡（米）
 */
export function fxDepthFade(soft = 0.4): N {
  const sceneZ: N = perspectiveDepthToViewZ(sceneDepth.sample(screenUV).x, cameraNear, cameraFar);
  // 视图空间里 z 是负的，越远越小；特效在遮挡物前面时差值为正
  return smoothstep(0.0, soft, positionView.z.sub(sceneZ));
}

