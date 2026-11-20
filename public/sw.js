/*
 * 离线缓存（装到手机主屏幕上以后，断网也能打开游戏）。
 *
 * 存两份：
 *  - 这一版的程序（页面、脚本、样式、图标）：按版本号分开存。页面注册这个文件时在地址后面带着版本号（sw.js?v=0.11.0），
 *    发了新版，版本号一变，浏览器就把它当成新的缓存脚本装上，旧版本的那一份随后清掉。
 *  - 车的模型（三十多兆）：单独存一份，不跟着版本号清——每发一版都让手机重新下三十多兆不合适。
 *    模型文件真的换了（重新导出过 public/models 里的 glb）的时候，把下面的 MODELS 加一。
 *
 * 取东西的规矩：打开页面本身先走网络（这样一联网就能拿到新版），断网了才用存着的；
 * 其余的文件（名字里带着内容的指纹，或者不常变）先看存着的，没有再走网络、顺手存下来。
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const APP = `umbra-app-${VERSION}`;
const MODELS = 'umbra-models-1';

const bucket = (url) => (new URL(url, self.location.origin).pathname.startsWith('/models/') ? MODELS : APP);

self.addEventListener('install', () => {
  // 新版装好就上岗，不等旧页面都关掉
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('umbra-') && key !== APP && key !== MODELS) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

/** 把一批地址存下来（已经有的跳过；哪个失败了不影响别的） */
async function keep(urls) {
  for (const url of urls) {
    try {
      const cache = await caches.open(bucket(url));
      if (await cache.match(url)) continue;
      const res = await fetch(url);
      if (res.ok) await cache.put(url, res);
    } catch {
      /* 这一个没存上：下次用到的时候再存 */
    }
  }
}

// 页面第一次打开时这个脚本还没接管它，那一趟下载的东西没经过这里：页面加载完会把清单发过来补存
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'keep' && Array.isArray(event.data.urls)) event.waitUntil(keep(event.data.urls));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 打开页面：先走网络；断网了用存着的首页（地址栏里的参数不影响页面内容）
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP);
        try {
          const res = await fetch(req);
          if (res.ok) await cache.put('/', res.clone());
          return res;
        } catch {
          return (await cache.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(bucket(req.url));
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
      return res;
    })(),
  );
});
