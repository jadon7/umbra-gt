import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 开发用截图接口：页面把当前帧 POST 到 /__snap?name=xxx，
 * 原尺寸 PNG 存到项目的 .snaps/ 目录。
 */
function snapPlugin(): Plugin {
  return {
    name: 'dev-snap',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__snap', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = (url.searchParams.get('name') ?? 'snap').replace(/[^a-zA-Z0-9_-]/g, '') || 'snap';
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = path.resolve(process.cwd(), '.snaps');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  // 版本号填进代码里：离线缓存按版本号分开存，发新版时旧的那一份自动清掉（见 public/sw.js）
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [snapPlugin()],
  server: { port: 5173, strictPort: true },
  build: { target: 'esnext' },
});
