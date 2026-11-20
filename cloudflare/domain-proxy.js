/**
 * 自定义域名的转发：把 umbra.dsxzai.com 收到的请求原样转给 Cloudflare Pages 上的游戏。
 *
 * 游戏本体发布在 Pages（umbra-gt.pages.dev，`npm run deploy`）。Pages 绑自定义域名要在域名的解析里加一条
 * CNAME，命令行的登录凭证没有改解析的权限；Workers 绑自定义域名时 Cloudflare 会自动建好解析和证书，
 * 所以用这个只有几行的 Worker 站在域名上做转发。它不存任何东西，游戏更新后不用重新发布它。
 *
 * 发布：npx wrangler deploy -c wrangler.worker.jsonc
 */
const ORIGIN = 'umbra-gt.pages.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = ORIGIN;
    url.port = '';
    return fetch(new Request(url.toString(), request));
  },
};
