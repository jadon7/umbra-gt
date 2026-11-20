/**
 * 宣传片录制用的无头 Chrome：起浏览器、连 DevTools 协议、在页面里跑脚本、截屏。
 * 做法照 scripts/perf.ts。只结束自己起的那一个浏览器进程。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const BASE = process.env.GAME_URL ?? 'http://localhost:5173/';
/** 中间文件（素材、试拍、配乐、文字卡）放哪：不要放进项目目录（被网盘同步、文件又大） */
export const WORK = process.env.PROMO_WORK ?? join(tmpdir(), 'umbra-gt-promo-work');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Browser {
  private chrome!: ChildProcess;
  private profile!: string;
  private ws!: WebSocket;
  private nextId = 1;
  private waiting = new Map<number, (v: any) => void>();
  readonly logs: string[] = [];

  readonly width: number;
  readonly height: number;
  readonly scale: number;

  constructor(width = 1920, height = 1080, scale = 1) {
    this.width = width;
    this.height = height;
    this.scale = scale;
  }

  async start(): Promise<void> {
    const port = 9300 + Math.floor(Math.random() * 500);
    this.profile = mkdtempSync(join(tmpdir(), 'umbra-promo-'));
    this.chrome = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profile}`,
        '--enable-unsafe-webgpu',
        '--enable-features=WebGPU',
        '--ignore-gpu-blocklist',
        '--use-angle=metal',
        `--window-size=${this.width},${this.height}`,
        `--force-device-scale-factor=${this.scale}`,
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    console.log(`  无头 Chrome PID ${this.chrome.pid}`);
    for (let i = 0; i < 80; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        const page = list.find((t) => t.type === 'page');
        if (page) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
          });
          break;
        }
      } catch {
        /* 浏览器还没起来 */
      }
      await sleep(250);
    }
    if (!this.ws) throw new Error('连不上无头浏览器');
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)!(msg.error ? { __error: msg.error } : msg.result);
        this.waiting.delete(msg.id);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ');
        this.logs.push(`[${msg.params.type}] ${text}`);
        if (msg.params.type === 'error' || msg.params.type === 'warning') console.log(`  页面${msg.params.type === 'error' ? '报错' : '警告'}：${text.slice(0, 300)}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.log(`  页面异常：${msg.params.exceptionDetails?.exception?.description?.slice(0, 400)}`);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: this.scale, mobile: false });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.waiting.set(id, (v) => {
        if (v && v.__error) reject(new Error(`${method}: ${JSON.stringify(v.__error)}`));
        else resolve(v);
      }),
    );
  }

  /** 在页面里跑一段（可以 await 的）脚本，拿回返回值 */
  async eval(body: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async open(query: string): Promise<void> {
    await this.send('Page.navigate', { url: `${BASE}?${query}` });
    await sleep(1500);
  }

  /** 截屏（画布加上面盖的网页界面），返回 JPEG（试拍用） */
  async shot(quality = 94): Promise<Buffer> {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: false, captureBeyondViewport: false });
    return Buffer.from(r.data, 'base64');
  }

  /** 无损截屏：PNG（optimizeForSpeed 只是换一档更快的压缩，仍然无损），尺寸 = 页面 × 像素倍率 */
  async png(): Promise<Buffer> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false });
    return Buffer.from(r.data, 'base64');
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.send('Browser.close'), sleep(1500)]);
    } catch {
      /* 已经关了 */
    }
    if (this.chrome.exitCode === null) this.chrome.kill();
    // 等浏览器真的退出了再删它的临时配置目录（还在写文件的话会删不干净）
    for (let i = 0; i < 50 && this.chrome.exitCode === null && this.chrome.signalCode === null; i++) await sleep(100);
    try {
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
      console.log(`  临时目录没删干净：${this.profile}（${(e as Error).message}）`);
    }
  }
}
