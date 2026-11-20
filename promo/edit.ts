/**
 * 剪辑：按下面的时间线把 $PROMO_WORK/clips/ 里的素材、标题字幕、结尾卡和配乐拼成成片。
 *
 * 一拍 = 0.5 秒 = 30 帧（配乐 120 拍/分钟），镜头长度都是整拍或半拍（15 帧），剪辑点踩在拍子上。
 * 转场：硬切，或者线性的叠化 / 淡入淡出（叠化在两段之间各让出一半，不改总长）。
 *
 * 成片规格：2560×1440、60 帧/秒恒定、H.264 High 4:2:0、BT.709、CRF 15 / preset slow；
 * AAC 320 kbps、48 kHz 立体声，响度 −14 LUFS、真峰值 ≤ −1 dBTP（两遍 loudnorm）。元数据里只写标题。
 *
 * 运行：node promo/edit.ts  → promo/umbra-gt-promo.mp4、promo/poster.jpg
 * （先跑 node promo/record.ts、node promo/cards.ts、node promo/music.ts）
 * 加 --out=路径 可以先写到别处（检查完再覆盖正式文件）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { WORK } from './browser.ts';
import { SHOTS } from './shots.ts';

const PROMO = decodeURIComponent(new URL('.', import.meta.url).pathname);
const CLIPS = join(WORK, 'clips');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FPS = 60;
const W = 2560;
const H = 1440;

export interface Seg {
  /** 素材名（clips/<名字>.mp4），或者 'end' 结尾卡 */
  src: string;
  /** 从素材的第几帧开始用 */
  from?: number;
  /** 用多少帧 */
  len: number;
  /** 这一段的说明（汇报用的镜头清单） */
  note: string;
  /** 开头从黑场淡入 / 结尾淡出到黑（帧数） */
  fadeIn?: number;
  fadeOut?: number;
  /** 和下一段叠化多少帧（线性）：这一段多录 xfade/2 帧、下一段提前 xfade/2 帧开始 */
  xfade?: number;
  /** 叠标题字幕：从这一段的第几帧开始淡入、淡入多长、停多久、淡出多长 */
  title?: { at: number; fadeIn: number; hold: number; fadeOut: number };
}

export const TIMELINE: Seg[] = [
  // 0–6 秒：雨夜开场
  { src: 'open_street', from: 10, len: 180, fadeIn: 45, xfade: 20, note: '城市·雨夜：贴着湿路面慢推向停在高架下的 UMBRA GT，车灯和霓虹倒影' },
  { src: 'open_tail', from: 15, len: 90, xfade: 20, note: '城市·雨夜：GT 车尾特写，贯穿式尾灯、雨点、车漆，镜头匀速横移' },
  { src: 'open_arrow', from: 15, len: 90, note: '城市·雨夜：第一个直角弯的 LED 箭头屏、大箭头和红叉屏，湿路面上的倒影，匀速前推' },
  // 6–10 秒：标题
  { src: 'open_launch', from: 0, len: 240, title: { at: 80, fadeIn: 24, hold: 106, fadeOut: 30 }, note: '城市·雨夜：GT 从镜头前起步冲进高架下的长街，叠标题 UMBRA GT / 街头赛车' },
  // 10–15 秒：赛前镜头（游戏自己的电影黑边、字幕和名牌）
  { src: 'race_intro', from: 36, len: 90, note: '比赛·城市雨夜：发车线全景，赛事字幕「街头赛」' },
  { src: 'race_intro', from: 185, len: 60, note: '比赛：排头对手 NOVA 的车头特写和名牌' },
  { src: 'race_intro', from: 272, len: 30, note: '比赛：对手 AURUM（NOMAD 皮卡）车尾和名牌' },
  { src: 'race_intro', from: 345, len: 60, note: '比赛：自己的 GT，车头斜前方低机位' },
  { src: 'race_intro', from: 452, len: 30, note: '比赛：前轮特写' },
  { src: 'race_intro', from: 512, len: 30, note: '比赛：车尾特写（在排气回火过曝之前切走）' },
  // 15–19 秒：倒数 3、2、1、GO（GO 在 18 秒整），起步
  { src: 'race_start', from: 100, len: 240, note: '比赛界面：八车发车格、倒数、GO、起步，尾灯拖光' },
  // 19–25 秒：城里直角弯的漂移
  { src: 'drift_chase', from: 100, len: 120, xfade: 8, note: '城市·夜晴：GT 追尾近镜头，冲向箭头屏，带手刹甩进第一个直角左弯' },
  { src: 'drift_trackside', from: 190, len: 75, xfade: 8, note: '城市·夜晴：RS（冰川白）漂移中的侧面跟拍，背后是箭头屏和红叉屏' },
  { src: 'drift_front', from: 185, len: 90, xfade: 8, note: '城市·夜晴：ST（幻彩紫）车头前机位，横着漂过路口，烟和箭头屏' },
  { src: 'drift_wheel', from: 215, len: 75, xfade: 8, note: '城市·夜晴：XR（毒液绿）轮边机位，出弯的烟' },
  // 25–28 秒：氮气和尾灯拖光
  { src: 'trail_brute', from: 30, len: 90, xfade: 8, note: '城市·夜晴：BRUTE 开氮气，侧后方跟拍，六道竖条尾灯拉出光轨' },
  { src: 'trail_ronin', from: 45, len: 90, xfade: 20, note: '城市·夜晴：RONIN 开氮气，车尾跟拍，圆环尾灯拖出空心光管' },
  // 28–36 秒：山路·黄昏
  { src: 'm_tower', from: 15, len: 90, xfade: 10, note: '山路·黄昏：湖边发车直道，摄像塔机位，RS 高速掠过' },
  { src: 'm_hairpin_heli', from: 150, len: 90, xfade: 10, note: '山路·黄昏：LM 航拍，第一个发卡弯整段漂过去，一路白烟' },
  { src: 'm_hairpin_front', from: 175, len: 60, xfade: 10, note: '山路·黄昏：GT 车头前机位，第二个发卡弯入弯甩尾' },
  { src: 'm_hairpin_front', from: 245, len: 60, xfade: 10, note: '山路·黄昏：GT 轮边机位，发卡弯里补氮气，烟从镜头前冒过' },
  { src: 'm_tunnel', from: 150, len: 90, xfade: 10, note: '山路·黄昏：NOMAD 从隧道口冲出来（钠灯、瓷砖墙）' },
  { src: 'm_bridge', from: 200, len: 90, xfade: 10, note: '山路·黄昏：橙红钢拱高架桥，GT 过桥擦着镜头冲过去' },
  // 36–39 秒：山路上的多车比赛
  { src: 'm_race_pack', from: 290, len: 90, xfade: 10, note: '比赛·山路黄昏：八车发车格航拍，发车' },
  { src: 'm_race_pack', from: 450, len: 90, xfade: 12, note: '比赛·山路黄昏：路边机位，一群车贴着冲过去' },
  // 39–43 秒：时段和天气
  { src: 'w_day', from: 30, len: 60, xfade: 12, note: '城市·白天晴：LM 在高架下的发车直道掠过' },
  { src: 'w_fog', from: 24, len: 60, xfade: 12, note: '城市·黄昏雾：BRUTE 亮着大灯从雾里冲出来，在路口甩尾' },
  { src: 'w_snow', from: 10, len: 60, xfade: 12, note: '城市·雪夜：NOMAD 顶着车顶射灯冲过飘雪' },
  { src: 'w_mtn_day', from: 20, len: 60, xfade: 12, note: '山路·白天晴：XR 在山脊上，摄像塔机位' },
  // 43–46 秒：车库
  { src: 'garage_gt', from: 10, len: 45, xfade: 12, note: '车库：UMBRA GT 熔岩红' },
  { src: 'garage_brute', from: 10, len: 45, xfade: 12, note: '车库：BRUTE 落日橙' },
  { src: 'garage_ronin', from: 10, len: 45, xfade: 12, note: '车库：RONIN 电光蓝' },
  { src: 'garage_nomad', from: 10, len: 45, note: '车库：NOMAD 哑光灰' },
  // 46–48 秒：冲过镜头
  { src: 'hero_end', from: 50, len: 120, note: '城市·雨夜：开着氮气的 GT 冲着贴地镜头过来、擦身而过' },
  // 48–55 秒：结尾卡
  { src: 'end', len: 420, fadeIn: 20, fadeOut: 90, note: '结尾卡：UMBRA GT + 标语「城市与山路，一路漂过去」（底部一行车辆模型署名小字）' },
];

/** 封面取成片里的哪一秒 */
export const POSTER_AT = 21.75;

function build(out: string, TL: Seg[]): void {
  const inputs: string[] = [];
  const filters: string[] = [];
  const index = new Map<string, number>();
  const input = (file: string, image: boolean) => {
    if (index.has(file)) return index.get(file)!;
    if (image) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', '12', '-i', file);
    else inputs.push('-i', file);
    index.set(file, index.size);
    return index.size - 1;
  };
  const titleIn = input(join(WORK, 'title.png'), true);
  let total = 0;
  const parts: { label: string; len: number; xfade: number }[] = [];
  TL.forEach((s, k) => {
    const image = s.src === 'end';
    const n = input(image ? join(WORK, `${s.src}.png`) : join(CLIPS, `${s.src}.mp4`), image);
    // 叠化：和上一段重叠的那半段从前面借，和下一段重叠的那半段往后多取
    const prevX = k > 0 ? (TL[k - 1].xfade ?? 0) : 0;
    const nextX = s.xfade ?? 0;
    // from 是镜头里的帧号；素材只存了 keep 那一段，换算成素材里的帧号
    const keep0 = SHOTS.find((x) => x.name === s.src)?.keep?.[0] ?? 0;
    const from = (s.from ?? 0) - keep0 - prevX / 2;
    const len = s.len + prevX / 2 + nextX / 2;
    if (from < 0) throw new Error(`${s.src} 从第 ${s.from} 帧开始：素材前面不够（叠化要往前借 ${prevX / 2} 帧）`);
    const keep = SHOTS.find((x) => x.name === s.src)?.keep;
    if (keep && from + len > keep[1] - keep[0]) throw new Error(`${s.src} 从第 ${s.from} 帧开始用 ${s.len} 帧：素材后面不够`);
    // 时间基统一成 1/60（素材的时间基各不相同，xfade 要求两边一样）
    let f = `[${n}:v]trim=start_frame=${from}:end_frame=${from + len},setpts=PTS-STARTPTS,fps=${FPS},settb=1/${FPS}`;
    if (image) f += `,scale=${W}:${H}:flags=lanczos:out_color_matrix=bt709:out_range=tv`;
    f += `,format=yuv444p,setsar=1`;
    if (s.fadeIn) f += `,fade=t=in:st=0:d=${s.fadeIn / FPS}`;
    if (s.fadeOut) f += `,fade=t=out:st=${(len - s.fadeOut) / FPS}:d=${s.fadeOut / FPS}`;
    if (s.title) {
      const t = s.title;
      const a = (t.at + prevX / 2) / FPS;
      const tl = `t${k}`;
      filters.push(
        `[${titleIn}:v]trim=end_frame=${t.fadeIn + t.hold + t.fadeOut},setpts=PTS-STARTPTS+${a}/TB,format=rgba,` +
          `fade=t=in:st=${a}:d=${t.fadeIn / FPS}:alpha=1,fade=t=out:st=${a + (t.fadeIn + t.hold) / FPS}:d=${t.fadeOut / FPS}:alpha=1[${tl}]`,
      );
      filters.push(`${f}[b${k}]`);
      f = `[b${k}][${tl}]overlay=0:0:eof_action=pass:format=yuv444,format=yuv444p`;
    }
    filters.push(`${f}[v${k}]`);
    parts.push({ label: `v${k}`, len, xfade: nextX });
    total += s.len;
  });
  // 串起来：有叠化的两段用 xfade（线性的 fade），其余直接接
  let cur = parts[0].label;
  let curLen = parts[0].len;
  for (let k = 1; k < parts.length; k++) {
    const x = parts[k - 1].xfade;
    const o = `c${k}`;
    if (x > 0) filters.push(`[${cur}][${parts[k].label}]xfade=transition=fade:duration=${x / FPS}:offset=${(curLen - x) / FPS}[${o}]`);
    else filters.push(`[${cur}][${parts[k].label}]concat=n=2:v=1:a=0,fps=${FPS},settb=1/${FPS}[${o}]`);
    curLen += parts[k].len - x;
    cur = o;
  }
  filters.push(`[${cur}]format=yuv420p[vout]`);
  const sec = total / FPS;
  console.log(`时间线 ${TL.length} 段，共 ${sec} 秒（${total} 帧）`);
  const audio = join(WORK, 'music-norm.wav');
  inputs.push('-i', audio);
  const audioIn = index.size;
  filters.push(`[${audioIn}:a]atrim=0:${sec},asetpts=PTS-STARTPTS[aout]`);
  execFileSync(
    FFMPEG,
    [
      '-y', '-hide_banner', '-loglevel', 'warning',
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-profile:v', 'high', '-level', '5.1', '-pix_fmt', 'yuv420p',
      '-x264-params', 'keyint=120:min-keyint=60:colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-r', String(FPS), '-fps_mode', 'cfr',
      '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2',
      '-map_metadata', '-1', '-metadata', 'title=UMBRA GT',
      '-movflags', '+faststart',
      out,
    ],
    { stdio: 'inherit' },
  );
  console.log(`成片：${out}`);
}

/**
 * 配乐响度归一到 −14 LUFS、真峰值不超过 −1 dBTP：先量一遍，整体加减增益，
 * 再过一道限幅（限在 −2 dBFS，给采样点之间的真峰值留余量），量一遍、差多少再补一次增益。
 */
function normalize(): void {
  const src = join(WORK, 'music.wav');
  const dst = join(WORK, 'music-norm.wav');
  let gain = -14 - measureLoud(src).I;
  for (let pass = 0; pass < 3; pass++) {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.7943:attack=1:release=60:level=false:asc=true`, '-ar', '48000', '-c:a', 'pcm_s24le', dst]);
    const m = measureLoud(dst);
    console.log(`  配乐：增益 ${gain.toFixed(2)} dB → ${m.I.toFixed(1)} LUFS，真峰值 ${m.TP.toFixed(1)} dBTP`);
    if (Math.abs(m.I + 14) < 0.25 && m.TP <= -1) return;
    gain += -14 - m.I;
  }
}

/** 量响度：积分响度（LUFS）和真峰值（dBTP），ebur128 的结果在 stderr 里 */
export function measureLoud(file: string): { I: number; TP: number } {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const text = r.stderr;
  const sum = text.slice(text.lastIndexOf('Summary:'));
  const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1]);
  const TP = Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum.slice(sum.indexOf('True peak')))?.[1]);
  return { I, TP };
}

if (process.argv[1] && process.argv[1].endsWith('edit.ts')) {
  const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? join(PROMO, 'umbra-gt-promo.mp4');
  // --first=N：只剪前 N 段（试剪时用）
  const first = Number(process.argv.find((a) => a.startsWith('--first='))?.slice(8) ?? 0);
  normalize();
  build(out, first ? TIMELINE.slice(0, first) : TIMELINE);
  // 封面放在成片旁边（--out 写到别处时封面也跟过去）
  const poster = join(dirname(out), 'poster.jpg');
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(POSTER_AT), '-i', out, '-frames:v', '1', '-vf', 'scale=in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=yuvj444p', '-q:v', '1', poster]);
  console.log(`封面：${poster}`);
}
