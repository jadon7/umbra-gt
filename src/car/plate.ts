import * as THREE from 'three/webgpu';

/** 用画布生成车牌贴图（原模型的车牌是 Khronos 标志，已去掉） */
export function makePlateTexture(text = 'UMB·001', region = 'NEON BAY'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d')!;

  g.fillStyle = '#eeeeea';
  g.fillRect(0, 0, c.width, c.height);

  // 左侧色条
  g.fillStyle = '#f2d400';
  g.fillRect(0, 0, 150, c.height);
  g.fillStyle = '#111';
  g.font = '900 34px "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(75, 128);
  g.rotate(-Math.PI / 2);
  g.fillText(region, 0, 0);
  g.restore();

  // 边框
  g.strokeStyle = '#111';
  g.lineWidth = 12;
  g.strokeRect(10, 10, c.width - 20, c.height - 20);

  // 号码
  g.fillStyle = '#111';
  g.font = 'italic 900 168px Impact, "Arial Black", sans-serif';
  g.fillText(text, 150 + (c.width - 150) / 2, 138);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false; // glTF 的 UV 约定
  tex.anisotropy = 8;
  return tex;
}
