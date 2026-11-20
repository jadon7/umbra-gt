import * as THREE from 'three/webgpu';

/** 店招图集的格子数。立面着色器按"第几家店"随机挑一格 */
export const SHOP_SIGN_COLS = 4;
export const SHOP_SIGN_ROWS = 10;

const CELL_W = 512;
const CELL_H = 96;

/** 店名。真实街道上的店招是杂的：字体、颜色、新旧都不一样 */
const NAMES: string[] = [
  'LAKESHORE DELI', '24H PHARMACY', "TONY'S PIZZA", 'COIN LAUNDRY', 'BARBER SHOP', "KIM'S MARKET", 'NOODLE HOUSE', 'PAWN & LOAN',
  'VINYL RECORDS', 'CAFE LUNA', 'ACE HARDWARE', 'LIQUOR · WINE', 'INK TATTOO', 'AUTO PARTS', 'BOOKS & COMICS', 'FLOWERS',
  'ALL NIGHT DINER', 'TAQUERIA', '便利店 MART', '深夜食堂', '茶 TEA BAR', 'BAKERY', 'CAMERA REPAIR', 'SHOE REPAIR',
  'IRON GYM 24/7', 'THRIFT STORE', 'ARCADE', 'DONUTS', 'BIKE SHOP', 'TAILOR', 'PHO 88', 'DRY CLEANERS',
  'GUITARS', 'OPTICAL', 'NAIL SALON', 'HOT DOGS', '牛肉面', 'CHECK CASHING', 'HOTEL', 'SMOKE SHOP',
];

/** [底色, 字色, 字体] */
const STYLES: [string, string, string][] = [
  ['#e9dfc4', '#a3201c', '900 62px "Arial Narrow", Impact, sans-serif'],
  ['#12301f', '#d8b45a', 'bold 56px Georgia, "Times New Roman", serif'],
  ['#0d0d0f', '#ecebe6', '900 58px "Helvetica Neue", Arial, sans-serif'],
  ['#9c1a16', '#f3ece0', '900 64px Impact, "Arial Narrow", sans-serif'],
  ['#15243f', '#e6e9ef', 'bold 54px "Futura", "Helvetica Neue", sans-serif'],
  ['#d9a514', '#16130c', '900 62px Impact, "Arial Narrow", sans-serif'],
  ['#e8e8e4', '#1d4f8f', 'bold 56px "Helvetica Neue", Arial, sans-serif'],
  ['#3a2415', '#e6d3ad', 'bold 54px Georgia, serif'],
  ['#0f4a4a', '#eef2ee', '900 58px "Futura", "Arial Narrow", sans-serif'],
  ['#4a1420', '#e9d9c0', 'italic bold 56px Georgia, serif'],
];

/**
 * 店招图集：一张画着四十块门头招牌的贴图。
 * 立面着色器在每家店的门楣上贴其中一块，所以整条街的店名、颜色各不相同。
 */
export function createShopSignAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * SHOP_SIGN_COLS;
  canvas.height = 1024;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, canvas.width, canvas.height);

  let seed = 20261111;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  NAMES.forEach((name, k) => {
    const col = k % SHOP_SIGN_COLS;
    const row = Math.floor(k / SHOP_SIGN_COLS);
    const x = col * CELL_W;
    const y = row * CELL_H;
    const [bg, fg, font] = STYLES[(k * 7 + row) % STYLES.length];
    g.save();
    g.beginPath();
    g.rect(x, y, CELL_W, CELL_H);
    g.clip();

    g.fillStyle = bg;
    g.fillRect(x, y, CELL_W, CELL_H);
    // 边框或者上下两道线
    g.strokeStyle = fg;
    g.globalAlpha = 0.7;
    if (k % 3 === 0) {
      g.lineWidth = 3;
      g.strokeRect(x + 7, y + 7, CELL_W - 14, CELL_H - 14);
    } else if (k % 3 === 1) {
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(x + 14, y + 11);
      g.lineTo(x + CELL_W - 14, y + 11);
      g.moveTo(x + 14, y + CELL_H - 11);
      g.lineTo(x + CELL_W - 14, y + CELL_H - 11);
      g.stroke();
    }
    g.globalAlpha = 1;

    const cjk = /[一-鿿]/.test(name);
    g.font = cjk ? font.replace(/"[^"]+"|Impact|Georgia/g, '"PingFang SC"').replace(/italic /, '') : font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = fg;
    // 字太长就压扁一点，保证整块招牌放得下
    const width = g.measureText(name).width;
    const fit = Math.min(1, (CELL_W - 56) / width);
    g.translate(x + CELL_W / 2, y + CELL_H / 2 + 3);
    g.scale(fit, 1);
    g.fillText(name, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);

    // 旧：整体压一层不均匀的污渍，再来几道雨水流下来的竖痕
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(0, 0, 0, ${0.03 + rnd() * 0.06})`;
      const sx = x + rnd() * CELL_W;
      g.fillRect(sx, y, 2 + rnd() * 14, CELL_H * (0.3 + rnd() * 0.7));
    }
    g.fillStyle = 'rgba(0, 0, 0, 0.16)';
    g.fillRect(x, y, CELL_W, 5);
    g.restore();
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** 图集里一格占整张贴图的比例（着色器换算坐标用） */
export const SHOP_SIGN_CELL = { u: 1 / SHOP_SIGN_COLS, v: CELL_H / 1024 };
