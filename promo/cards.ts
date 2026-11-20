/**
 * 标题字幕和结尾卡：用无头 Chrome 把一小段 HTML 排好版截成 2560×1440 的 PNG（字体是系统自带的苹方和 Avenir Next）。
 * 先按两倍像素渲染再缩小，字边更干净。
 *
 * - title.png：透明底，剪辑时叠在画面上
 * - end.png：黑底的结尾卡，只有游戏名和一句标语
 *
 * 画面里不放任何网址、域名、二维码和「去哪儿搜」之类的话（发到平台会被限流）。
 * 唯一的小字是车辆模型的署名：它是 CC BY 4.0 授权的素材，公开发布要署名（只有作者和授权名，没有链接）。
 *
 * 运行：node promo/cards.ts  → $PROMO_WORK/title.png、$PROMO_WORK/end.png
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser, WORK } from './browser.ts';

/** 结尾卡上要不要带车辆模型的署名小字 */
const CREDIT = true;

const BASE_CSS = `
  html, body { margin: 0; width: 2560px; height: 1440px; overflow: hidden; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; color: #f2f0eb;
         font-family: 'PingFang SC', 'Hiragino Sans GB', sans-serif; -webkit-font-smoothing: antialiased; }
  .logo { font-family: 'Avenir Next', 'Helvetica Neue', sans-serif; letter-spacing: 0.3em; margin-right: -0.3em; line-height: 1; white-space: nowrap; }
  .logo .u { font-weight: 300; }
  .logo .gt { font-weight: 800; font-style: italic; letter-spacing: 0.08em; margin-left: 0.18em; }
  .rule { width: 128px; height: 3px; background: #ff3b2f; }
`;

const TITLE = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  html, body { background: transparent; }
  body { text-shadow: 0 0 40px rgba(0,0,0,0.55), 0 4px 18px rgba(0,0,0,0.5); justify-content: flex-start; padding-top: 210px; box-sizing: border-box; }
  .logo { font-size: 224px; }
  .logo .u { font-weight: 400; }
  .rule { margin: 70px 0 54px; box-shadow: 0 0 24px rgba(0,0,0,0.5); }
  .sub { font-size: 56px; font-weight: 300; letter-spacing: 0.7em; margin-right: -0.7em; color: #e6e2da; }
</style></head><body>
  <div class="logo"><span class="u">UMBRA</span><span class="gt">GT</span></div>
  <div class="rule"></div>
  <div class="sub">街头赛车</div>
</body></html>`;

const END = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  html, body { background: #000; }
  .logo { font-size: 200px; }
  .rule { margin: 64px 0 56px; }
  .line { font-size: 60px; font-weight: 300; letter-spacing: 0.4em; margin-right: -0.4em; color: #ece9e2; }
  .credit { position: absolute; bottom: 64px; left: 0; right: 0; text-align: center; font-size: 26px; font-weight: 300; color: #77746d; letter-spacing: 0.02em; }
</style></head><body>
  <div class="logo"><span class="u">UMBRA</span><span class="gt">GT</span></div>
  <div class="rule"></div>
  <div class="line">城市与山路，一路漂过去</div>
  ${CREDIT ? '<div class="credit">车辆模型基于 Car Concept（Eric Chadwick，© 2024 Darmstadt Graphics Group GmbH，CC BY 4.0），有修改</div>' : ''}
</body></html>`;

mkdirSync(WORK, { recursive: true });
const b = new Browser(2560, 1440, 2);
await b.start();
try {
  for (const [name, html, transparent] of [
    ['title', TITLE, true],
    ['end', END, false],
  ] as const) {
    await b.send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
    await b.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await new Promise((r) => setTimeout(r, 800));
    await b.eval(`await document.fonts.ready; return true;`);
    const r = await b.send('Page.captureScreenshot', { format: 'png' });
    const big = join(WORK, `${name}@2x.png`);
    writeFileSync(big, Buffer.from(r.data, 'base64'));
    execFileSync('magick', [big, '-filter', 'Lanczos', '-resize', '2560x1440', join(WORK, `${name}.png`)]);
    console.log(`${name}.png`);
  }
} finally {
  await b.close();
}
