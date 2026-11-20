/**
 * 宣传片的素材录制：起无头 Chrome 打开游戏，每个镜头按 shots.ts 里写的摆好场景，
 * 然后逐帧推进（每帧正好 1/60 秒）、逐帧无损截屏（PNG），直接喂给 ffmpeg 缩小、压成一段素材。
 *
 * 运行（开发服务器要跑着，地址用 GAME_URL 指定；中间文件放 PROMO_WORK 指的目录，不要放进项目里）：
 *   node promo/record.ts                     录全部镜头 → $PROMO_WORK/clips/<名字>.mp4
 *   node promo/record.ts drift nitro         只录这几个
 *   node promo/record.ts --scout drift       试拍：1 倍像素，只存几张静帧到 $PROMO_WORK/scout/，看机位用
 *   node promo/record.ts --scout --every=30 drift   试拍时每 30 帧存一张
 *
 * 镜头写了 keep 的，素材里只有那一段（第 keep[0] 帧是素材的第 0 帧），前面的照常推进、渲染但不截屏。
 *
 * 画面：页面 2560×1440、像素倍率 PROMO_SCALE（默认 2，即按 5120×2880 渲染），游戏用最高画质档（q=high）、
 * 不限渲染分辨率（px=0）；截屏是 PNG（无损），ffmpeg 用 lanczos 缩到 2560×1440。
 * 素材压成接近无损的 H.264 4:4:4（CRF 7），剪辑时再统一转 4:2:0。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser, WORK } from './browser.ts';
import { PAGE_LIB } from './lib.ts';
import { SHOTS, type Shot } from './shots.ts';

const W = 2560;
const H = 1440;
const SCALE = Number(process.env.PROMO_SCALE ?? 2);
const args = process.argv.slice(2);
const scout = args.includes('--scout');
const every = Number(args.find((a) => a.startsWith('--every='))?.slice(8) ?? 0);
const names = args.filter((a) => !a.startsWith('--'));
const list = SHOTS.filter((s) => names.length === 0 || names.includes(s.name));
if (list.length === 0) throw new Error(`没有这些镜头：${names.join(' ')}`);

/** 正在写的那个 ffmpeg（出错时要结束它） */
let current: { ff: ReturnType<typeof spawn> } | null = null;

const PRE = 'const P = window.__P; const { app, d, E, T } = P;';

function encoder(file: string) {
  // PNG 是全范围 RGB：缩小以后按 BT.709 转成有限范围的 YUV 4:4:4
  const vf = `scale=${W}:${H}:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuv444p`;
  const ff = spawn(
    '/opt/homebrew/bin/ffmpeg',
    [
      '-y', '-loglevel', 'error', '-threads', '4', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '60', '-i', '-',
      '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '7', '-profile:v', 'high444', '-x264-params', 'rc-lookahead=20',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', file,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const done = new Promise<void>((resolve, reject) => ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${c}`)))));
  return { ff, done };
}

/** 一步最多等多久：页面卡住（比如显卡出错、承诺一直不兑现）时抛错，外面换一个新浏览器重录这个镜头 */
function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(new Error(`${what} 超过 ${ms / 1000} 秒没有返回`)), ms)))]).finally(() => clearTimeout(t));
}

const INFO = `${PRE} if (!d) return {}; const v = d.vehicle; return { s: Math.round(P.where()), kmh: +(v.speed * 3.6).toFixed(0), drift: v.drifting, nitro: v.nitroActive, cine: d.cineOn ? P.cineName() : '' };`;

async function record(b: Browser, shot: Shot): Promise<void> {
  const t0 = performance.now();
  await b.open(`${shot.query}&q=high&px=0`);
  await timed(b.eval(PAGE_LIB), 150000, "等游戏加载");
  await timed(b.eval(`${PRE} P.cam = null; P.post = null; P.before = null; P.cineKinds = null; ${shot.setup}`), 120000, '摆场景');
  if (shot.before) await b.eval(`${PRE} P.before = (i) => { ${shot.before} };`);
  if (shot.cam) await b.eval(`${PRE} P.cam = (i, cam) => { ${shot.cam} };`);
  if (shot.post) await b.eval(`${PRE} P.post = (i, post) => { ${shot.post} };`);
  if (shot.ready) await b.eval(`${PRE} ${shot.ready}`);
  // 预跑：着色器编译、阴影和反射探针稳定、特效进入状态（出画面但不录）
  const pre = shot.preroll ?? 30;
  for (let i = -pre; i < 0; i++) await timed(b.eval(`await window.__P.step(${i});`), 60000, `预跑第 ${i} 帧`);

  const frames = shot.frames;
  // 录下来的这一段每帧推进多少秒：比 1/60 小就是慢动作（预跑总是正常速度）
  const dt = 1 / 60 / (shot.slow ?? 1);
  if (scout) {
    const dir = join(WORK, 'scout');
    mkdirSync(dir, { recursive: true });
    const picks = every ? Array.from({ length: Math.ceil(frames / every) }, (_, k) => k * every) : (shot.scoutAt ?? [0, Math.floor(frames / 2), frames - 1]);
    for (let i = 0; i < frames; i++) {
      await b.eval(`await window.__P.step(${i}, ${dt});`);
      if (picks.includes(i)) {
        writeFileSync(join(dir, `${shot.name}-${String(i).padStart(4, '0')}.jpg`), await b.shot(85));
        console.log(`    帧 ${i}：${JSON.stringify(await b.eval(INFO))}`);
      }
    }
    console.log(`  ${shot.name}：试拍 ${picks.length} 张，${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
    return;
  }
  const dir = join(WORK, 'clips');
  mkdirSync(dir, { recursive: true });
  const { ff, done } = encoder(join(dir, `${shot.name}.mp4`));
  current = { ff };
  let size = '';
  const [k0, k1] = shot.keep ?? [0, frames];
  for (let i = 0; i < k1; i++) {
    await timed(b.eval(`await window.__P.step(${i}, ${dt});`), 60000, `第 ${i} 帧`);
    if (i < k0) continue;
    const png = await timed(b.png(), 60000, `第 ${i} 帧截屏`);
    if (!size) size = `${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`;
    if (!ff.stdin!.write(png)) await new Promise((r) => ff.stdin!.once('drain', r));
    if (shot.log && i % shot.log === 0) console.log(`    帧 ${i}：${JSON.stringify(await b.eval(INFO))}`);
  }
  ff.stdin!.end();
  await done;
  current = null;
  const sec = (performance.now() - t0) / 1000;
  console.log(`  ${shot.name}：存了第 ${k0}–${k1 - 1} 帧（截屏 ${size} PNG），${sec.toFixed(0)} 秒，每帧 ${((sec * 1000) / (k1 - k0)).toFixed(0)} 毫秒`);
}

let b = new Browser(W, H, scout ? 1 : SCALE);
await b.start();
const all = performance.now();
try {
  for (const shot of list) {
    console.log(`镜头 ${shot.name}`);
    try {
      await record(b, shot);
    } catch (e) {
      // 卡住或出错：关掉这个浏览器（连同还开着的 ffmpeg 一起结束），换一个新的重录一次
      console.log(`  ${shot.name} 出错：${(e as Error).message}，换一个浏览器重录`);
      current?.ff.kill();
      await b.close();
      b = new Browser(W, H, scout ? 1 : SCALE);
      await b.start();
      await record(b, shot);
    }
  }
} finally {
  await b.close();
  console.log(`共 ${((performance.now() - all) / 60000).toFixed(1)} 分钟`);
}
