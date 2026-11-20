import * as THREE from 'three/webgpu';

/**
 * 仪表屏：用画布实时绘制车速、挡位、转速、氮气，作为仪表面板的发光贴图。
 * 驾驶室视角下这块屏就在方向盘后面，所以要显示真实数据。
 */
export class DashDisplay {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly w = 1024;
  private readonly h = 256;
  private last = '';

  constructor() {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    this.ctx = c.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false; // glTF 的 UV 约定
    this.texture.anisotropy = 8;
    this.draw(0, 'P', 0.12, 1);
  }

  /**
   * @param kmh 车速
   * @param gear 挡位文字（1–6、R、P）
   * @param rpm 转速占红线的比例 0–1
   * @param nitro 氮气余量 0–1
   */
  draw(kmh: number, gear: string, rpm: number, nitro: number): void {
    const speed = Math.round(kmh);
    const rpmSeg = Math.round(rpm * 24);
    const nitroSeg = Math.round(nitro * 20);
    const key = `${speed}|${gear}|${rpmSeg}|${nitroSeg}`;
    if (key === this.last) return;
    this.last = key;

    const g = this.ctx;
    const { w, h } = this;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);

    // 转速条：一排斜切的小格，最后几格是红区
    const segs = 24;
    const x0 = 250;
    const segW = 21;
    for (let i = 0; i < segs; i++) {
      const on = i < rpmSeg;
      const red = i >= segs - 4;
      g.fillStyle = on ? (red ? '#ff3b30' : i >= segs - 8 ? '#ffb224' : '#f2f2ee') : '#1c1c1f';
      const x = x0 + i * segW;
      g.beginPath();
      g.moveTo(x + 8, 26);
      g.lineTo(x + 8 + segW - 5, 26);
      g.lineTo(x + segW - 5, 58);
      g.lineTo(x, 58);
      g.closePath();
      g.fill();
    }

    // 车速
    g.fillStyle = '#f2f2ee';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = 'italic 900 150px Impact, "Arial Black", sans-serif';
    g.fillText(String(speed), w / 2 - 10, 208);
    g.font = '700 26px "Helvetica Neue", Arial, sans-serif';
    g.fillStyle = '#8a8a86';
    g.fillText('KM/H', w / 2 + 170, 204);

    // 挡位
    g.fillStyle = '#ffb224';
    g.fillRect(96, 78, 112, 132);
    g.fillStyle = '#000';
    g.font = 'italic 900 118px Impact, "Arial Black", sans-serif';
    g.fillText(gear, 152, 190);

    // 氮气
    g.font = '800 24px "Helvetica Neue", Arial, sans-serif';
    g.fillStyle = '#1fdcff';
    g.textAlign = 'left';
    g.fillText('N2O', 792, 108);
    for (let i = 0; i < 20; i++) {
      g.fillStyle = i < nitroSeg ? '#1fdcff' : '#12222a';
      g.fillRect(792 + i * 7, 122, 5, 70);
    }

    this.texture.needsUpdate = true;
  }
}
