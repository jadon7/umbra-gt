/**
 * 性能测试：起一个无头 Chrome 打开游戏，在几个固定位置量每帧耗时。
 *
 * 为什么不直接在浏览器里量：页面不在前台（窗口被挡住、面板收起来）时浏览器会给它降速，
 * 数字会越量越大。无头浏览器没有"前台后台"，每次量出来的条件是一样的。
 *
 * 运行（先另开一个终端 npm run dev）：
 *   node scripts/perf.ts                 默认配置，夜雨 / 夜晴 / 白天各量三个位置
 *   node scripts/perf.ts "fx=-ssr"       带上地址栏参数（可以给多组，每组各量一遍）
 *   node scripts/perf.ts --parts         逐项关掉场景里的东西和后期效果，看各占多少
 *       可以加 --time=day --weather=clear --spot=40 换场景和位置，--only=阴影 只量名字里带这个词的项
 *
 * 量的是"不等屏幕刷新、连续出帧"的平均每帧耗时（CPU + GPU），单位毫秒；16.7 以下才稳得住 60 帧。
 * 画面大小固定 1280×720、两倍像素（实际渲染 2560×1440，和游戏默认的分辨率上限一样）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.GAME_URL ?? 'http://localhost:5173/';
const PORT = 9300 + Math.floor(Math.random() * 500);
const FRAMES = 90;

const args = process.argv.slice(2);
const parts = args.includes('--parts');
const configs = args.filter((a) => !a.startsWith('--'));
if (configs.length === 0) configs.push('');

const profile = mkdtempSync(join(tmpdir(), 'umbra-perf-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-webgpu',
    '--enable-features=WebGPU',
    '--ignore-gpu-blocklist',
    '--use-angle=metal',
    '--window-size=1280,720',
    '--force-device-scale-factor=2',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        return ws;
      }
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  throw new Error('连不上无头浏览器');
}

let nextId = 1;
const waiting = new Map<number, (v: unknown) => void>();

function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => waiting.set(id, resolve));
}

/** 在页面里跑一段脚本，拿回它返回的值 */
async function run(ws: WebSocket, expression: string): Promise<any> {
  const r = await send(ws, 'Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** 页面里的准备工作：等游戏加载完，定义"挪到赛道某处""量一次"这些函数 */
const SETUP = `
  for (let i = 0; i < 600 && !(window.__app && window.__app.drive); i++) await new Promise((r) => setTimeout(r, 100));
  if (!window.__app || !window.__app.drive) return { error: '游戏没加载出来' };
  const app = window.__app;
  const d = app.drive;
  d.world.flashTimer = 1e9;
  const samples = d.world.track.samples;
  // 把车放到赛道上离起点 s 米的地方，跑一秒让悬挂和镜头落稳，然后定住
  window.__goto = (s) => {
    const smp = samples.find((p) => p.s >= s) ?? samples[0];
    d.paused = false;
    d.scriptedInput = { throttle: 0, brake: 1, steer: 0, handbrake: true, nitro: false };
    d.vehicle.reset(smp.pos.x, smp.pos.y + 0.06, smp.pos.z, Math.atan2(smp.dir.x, smp.dir.z));
    if (d.afterTeleport) d.afterTeleport();
    for (let i = 0; i < 60; i++) d.update(1 / 60);
    d.paused = true;
  };
  window.__bench = async (frames) => +(await app.engine.benchmark(frames)).toFixed(2);
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  return { backend: app.engine.backendName, gpu: adapter && adapter.info ? [adapter.info.vendor, adapter.info.architecture, adapter.info.description].join(' ') : '?', size: [innerWidth, innerHeight, devicePixelRatio] };
`;

/** 三个位置：发车直道（高架下）、赛道中段、湖滨长弯 */
const SPOTS = [40, 950, 1900];
const SCENES: [string, string, string][] = [
  ['夜雨', 'night', 'rain'],
  ['夜晴', 'night', 'clear'],
  ['白天', 'day', 'clear'],
];

async function measureAll(ws: WebSocket): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const [name, time, weather] of SCENES) {
    out[name] = await run(
      ws,
      `window.__app.setScene('${time}', '${weather}'); await new Promise((r) => setTimeout(r, 300));
       const v = []; for (const s of ${JSON.stringify(SPOTS)}) { window.__goto(s); await window.__bench(40); v.push(await window.__bench(${FRAMES})); } return v;`,
    );
  }
  return out;
}

/**
 * 逐项归因：把场景里的一样东西（或者一个后期效果）关掉再量，和开着的时候比。
 * 机器上别的程序也在用显卡，耗时会成片地漂移，所以"开""关"交替着各量几次、各取中位数再相减。
 * 每一项给出：关掉以后的总耗时、省了多少、其中 CPU 这一侧（提交绘制指令）省了多少。
 */
const PAGE_AB = `
  const app = window.__app;
  const e = app.engine;
  const device = e.renderer.backend.device;
  // 量一次：返回 [总耗时, CPU 提交耗时]（毫秒 / 帧）
  window.__run = async (frames) => {
    for (let i = 0; i < 6; i++) { e.advanceFrame(); e.tick(e.last + 1000 / 60); }
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) { e.advanceFrame(); e.tick(e.last + 1000 / 60); }
    const t1 = performance.now();
    await device.queue.onSubmittedWorkDone();
    return [(performance.now() - t0) / frames, (t1 - t0) / frames];
  };
  const median = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  window.__ab = async (off, on, rounds, frames) => {
    const A = [], B = [], Ac = [], Bc = [];
    for (let k = 0; k < rounds; k++) {
      const a = await window.__run(frames); A.push(a[0]); Ac.push(a[1]);
      await off(); await window.__run(8);
      const b = await window.__run(frames); B.push(b[0]); Bc.push(b[1]);
      await on(); await window.__run(8);
    }
    return [median(A), median(B), median(Ac), median(Bc)].map((x) => +x.toFixed(2));
  };
  window.__hide = (test) => {
    const w = app.drive.world; const list = [];
    w.group.traverse((o) => { if (o.isMesh && o.visible && test(o, w)) list.push(o); });
    return [() => list.forEach((o) => (o.visible = false)), () => list.forEach((o) => (o.visible = true))];
  };
  window.__feature = (name) => [
    () => { e.features[name] = false; e.buildPipeline(); e.pipeline.outputNode = e.outputs[e.profile]; e.pipeline.needsUpdate = true; },
    () => { e.features[name] = true; e.buildPipeline(); e.pipeline.outputNode = e.outputs[e.profile]; e.pipeline.needsUpdate = true; },
  ];
  return true;
`;

/** [名字, 页面里返回 [关, 开] 两个函数的表达式] */
const ITEMS: [string, string][] = [
  ['分辨率降到 100 万像素', `(() => { const m = window.__app.engine.maxPixels; return [() => { window.__app.engine.maxPixels = 1e6; window.__app.engine.resize(); }, () => { window.__app.engine.maxPixels = m; window.__app.engine.resize(); }]; })()`],
  ['后期：屏幕空间反射', `window.__feature('ssr')`],
  ['后期：环境光遮蔽', `window.__feature('ao')`],
  ['后期：运动模糊', `window.__feature('motionBlur')`],
  ['后期：镜头（色散、水滴、颗粒）', `window.__feature('lens')`],
  ['后期：多重采样', `window.__feature('msaa')`],
  ['阴影', `(() => { const r = window.__app.engine.renderer; return [() => { r.shadowMap.enabled = false; }, () => { r.shadowMap.enabled = true; }]; })()`],
  ['车身反射探针', `(() => { const d = window.__app.drive; const f = d.updateProbe; return [() => { d.updateProbe = () => {}; }, () => { d.updateProbe = f; }]; })()`],
  ['整座城市', `(() => { const w = window.__app.drive.world; return [() => { w.group.visible = false; }, () => { w.group.visible = true; }]; })()`],
  ['楼体立面', `window.__hide((o, w) => o.material === w.mats.facade)`],
  ['路面', `window.__hide((o, w) => o.material === w.mats.road)`],
  ['人行道', `window.__hide((o, w) => o.material === w.mats.sidewalk)`],
  ['停着的车', `window.__hide((o) => o.material && /^Parked/.test(o.material.name || ''))`],
  ['树', `window.__hide((o, w) => o.material === w.mats.leaves || o.material === w.mats.trunk)`],
  ['钢结构（高架、桥）', `window.__hide((o, w) => o.material === w.mats.steelDark || o.material === w.mats.steelRed || o.material === w.mats.wood)`],
  ['金属杂件（防火梯、灯杆）', `window.__hide((o, w) => o.material === w.mats.metal)`],
  ['城市特效（雨、光晕、蒸汽）', `(() => { const w = window.__app.drive.world; return [() => { w.fxGroup.visible = false; }, () => { w.fxGroup.visible = true; }]; })()`],
  ['主角车', `(() => { const c = window.__app.car.root; return [() => { c.visible = false; }, () => { c.visible = true; }]; })()`],
];

async function measureParts(ws: WebSocket, time: string, weather: string, spot: number, only: string | undefined): Promise<void> {
  await run(ws, PAGE_AB);
  await run(ws, `window.__app.setScene('${time}', '${weather}'); await new Promise((r) => setTimeout(r, 300)); window.__goto(${spot}); await window.__run(40); return 1;`);
  console.log(`  场景：${time} ${weather}，赛道 ${spot} 米处。每项：开着 → 关掉（省多少；CPU 侧省多少），单位毫秒/帧`);
  for (const [name, expr] of ITEMS) {
    if (only && !name.includes(only)) continue;
    const r = (await run(ws, `const [off, on] = ${expr}; return await window.__ab(off, on, 5, 30);`)) as number[];
    console.log(`  ${name.padEnd(16, '　')} ${r[0].toFixed(2).padStart(6)} → ${r[1].toFixed(2).padStart(6)}   省 ${(r[0] - r[1]).toFixed(2).padStart(5)}   CPU ${r[2].toFixed(2)} → ${r[3].toFixed(2)}`);
  }
}

try {
  const ws = await connect();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)!(msg.result ?? msg.error);
      waiting.delete(msg.id);
    }
  };
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  // 无头模式下窗口大小不等于页面大小，这里把页面大小钉死
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  for (const cfg of configs) {
    const url = `${BASE}?mode=drive&ui=0&time=night&weather=rain${cfg ? `&${cfg}` : ''}`;
    await send(ws, 'Page.navigate', { url });
    await sleep(1500);
    const info = await run(ws, SETUP);
    if (info.error) throw new Error(info.error);
    console.log(`\n配置：${cfg || '默认'}    ${info.backend} · ${info.gpu} · ${info.size[0]}×${info.size[1]} ×${info.size[2]}`);
    if (parts) {
      const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
      await measureParts(ws, opt('time') ?? 'night', opt('weather') ?? 'rain', Number(opt('spot') ?? 950), opt('only'));
      continue;
    }
    const r = await measureAll(ws);
    for (const [name, v] of Object.entries(r)) {
      const avg = v.reduce((a, b) => a + b, 0) / v.length;
      console.log(`  ${name}  ${v.map((x) => x.toFixed(2)).join(' / ')}   平均 ${avg.toFixed(2)} 毫秒`);
    }
  }
  await send(ws, 'Browser.close').catch(() => {});
} finally {
  // 只结束自己起的这一个浏览器进程
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
