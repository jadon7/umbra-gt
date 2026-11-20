/**
 * 检查「装到手机上」要用的那几样东西在正式版里是不是好的：应用清单、图标、离线缓存。
 * 起一个无头 Chrome（按手机横屏的大小、带触屏），打开构建好的版本，然后：
 *  1. 看离线缓存脚本有没有装上、接管页面；
 *  2. 看这一趟下载的东西（页面、脚本、样式、车的模型）有没有存下来；
 *  3. 断网，重新打开页面，看游戏还能不能起来。
 *
 * 运行：先 npm run build，然后 npm run pwa-check。
 * 脚本自己把 dist 目录托管在本机的一个端口上；到「断网」那一步直接把这个服务关掉——服务都没了，是真的取不到。
 * （只在页面上模拟断网不算数：离线缓存脚本自己的网络请求不受那个开关管，照样取得到。）
 *
 * 也可以用环境变量 GAME_URL 指到别的地址（比如线上）：这时关不了人家的服务，
 * 改成给页面和离线缓存脚本都打上「断网」的开关，再用「没存过的地址取不到」来确认开关真的生效了。
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REMOTE = process.env.GAME_URL;
const DIST = join(import.meta.dirname, '..', 'dist');
const PORT = 9800 + Math.floor(Math.random() * 150);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

/** 把 dist 托管起来（只听本机），返回服务和地址 */
async function host(): Promise<{ server: Server; base: string }> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('没有 dist/index.html，先 npm run build');
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = normalize(join(DIST, path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, base: `http://localhost:${port}/` };
}

/** 把服务彻底关掉：不再接新连接，已经连着的也断开 */
async function unplug(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 给浏览器里所有的离线缓存脚本打上「断网」（它们各是各的调试目标，页面上的开关管不到） */
async function unplugWorkers(): Promise<number> {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const workers = list.filter((t) => t.type === 'service_worker');
  for (const w of workers) {
    const ws = new WebSocket(w.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const done = new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        if (JSON.parse(String(e.data)).id === 2) resolve();
      };
    });
    ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'Network.emulateNetworkConditions', params: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 } }));
    await Promise.race([done, sleep(3000)]);
    // 连接留着不关：关了开关就跟着没了
  }
  return workers.length;
}

const profile = mkdtempSync(join(tmpdir(), 'umbra-pwa-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal', '--window-size=844,390', '--mute-audio', '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 80; i++) {
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
async function run(ws: WebSocket, expression: string): Promise<any> {
  const r = await send(ws, 'Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** 等游戏的主菜单出来（车库场景加载完） */
const READY = `
  for (let i = 0; i < 900; i++) {
    const l = document.getElementById('loading');
    if (window.__app && l && l.classList.contains('done')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
`;

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `：${detail}` : ''}`);
};

let site: Server | null = null;
try {
  let BASE = REMOTE ?? '';
  if (!REMOTE) {
    const h = await host();
    site = h.server;
    BASE = h.base;
  }
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
  await send(ws, 'Network.enable');
  // 手机横屏的大小，带触屏
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
  await send(ws, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`打开 ${BASE}`);
  await send(ws, 'Page.navigate', { url: BASE });
  await sleep(1500);
  const first = await run(
    ws,
    `${READY}
    const m = await fetch('/manifest.webmanifest').then((r) => r.json());
    const icons = await Promise.all(m.icons.map((i) => fetch(i.src).then((r) => r.status)));
    const reg = await navigator.serviceWorker.ready;
    // 等它把这一趟下载的东西存完
    await new Promise((r) => setTimeout(r, 4000));
    const stored = {};
    for (const k of await caches.keys()) stored[k] = (await (await caches.open(k)).keys()).map((q) => new URL(q.url).pathname);
    return {
      touch: document.documentElement.className,
      canvas: [document.getElementById('stage').width, document.getElementById('stage').height],
      backend: window.__app.engine ? '' : '',
      manifest: { name: m.name, display: m.display, orientation: m.orientation, start: m.start_url },
      icons,
      sw: reg.active && reg.active.scriptURL,
      stored,
    };`,
  );
  check(first.touch.includes('touch') && first.touch.includes('compact'), '按触屏、小屏幕的样子布局', first.touch);
  check(first.canvas[0] * first.canvas[1] <= 1.05e6, '渲染分辨率是手机的那一档', `${first.canvas[0]}×${first.canvas[1]}`);
  check(first.manifest.display === 'fullscreen' && first.manifest.orientation === 'landscape', '应用清单：全屏、横屏', JSON.stringify(first.manifest));
  check(first.icons.every((s: number) => s === 200), '图标都取得到', first.icons.join(' '));
  check(!!first.sw, '离线缓存脚本装上了', first.sw ?? '');
  const app = Object.keys(first.stored).find((k) => k.startsWith('umbra-app-'));
  const models = first.stored['umbra-models-1'] ?? [];
  const files: string[] = app ? first.stored[app] : [];
  check(files.includes('/') && files.some((f) => f.endsWith('.js')) && files.some((f) => f.endsWith('.css')), '页面、脚本、样式存下来了', `${app}：${files.length} 个文件`);
  check(models.length > 0, '车的模型存下来了', models.join(' '));

  // 断网，重新打开
  if (site) {
    await unplug(site);
    site = null;
    console.log('本机的服务关掉了，重新打开页面');
  } else {
    await send(ws, 'Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    console.log(`给页面和 ${await unplugWorkers()} 个离线缓存脚本打上了断网，重新打开页面`);
  }
  await send(ws, 'Page.navigate', { url: `${BASE}?mode=drive` });
  await sleep(1500);
  const offline = await run(
    ws,
    `${READY}
    for (let i = 0; i < 600 && !(window.__app && window.__app.drive && window.__app.drive.active); i++) await new Promise((r) => setTimeout(r, 100));
    const online = await fetch('/manifest.webmanifest?nocache=' + Date.now()).then(() => true, () => false);
    return { title: document.title, driving: !!(window.__app && window.__app.drive && window.__app.drive.active), online, pad: !!document.querySelector('.touch-pad') };`,
  );
  check(!offline.online, '确实是断网的（没存过的地址取不到）');
  check(offline.driving, '断网后重新打开，游戏照样能进到开车', offline.title);
  check(offline.pad, '触屏按钮在');
  await send(ws, 'Browser.close').catch(() => {});
} catch (e) {
  failed++;
  console.log(`✗ 出错了：${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (site) await unplug(site);
  // 只结束自己起的这一个浏览器进程
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* 临时目录没删干净不要紧，系统会清 */
  }
}
console.log(failed ? `有 ${failed} 项没过` : '全部通过');
process.exitCode = failed ? 1 : 0;
