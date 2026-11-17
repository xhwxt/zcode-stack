#!/usr/bin/env node
/**
 * ZCode 远控桥 v27 —— /m 入口（官方页面 Web+Server 直连模式）
 *
 * 架构（比 rpc-frame 透传方案简单一个数量级）：
 *   手机 → https://zcode.example.com/m
 *     ├─ relay(3032)：反代官方 /remote/v4 页面 + 种 zcode_lite_token cookie
 *     └─ 页面自身走 M4t() 分支：fetch /api/server-info（本域→3030）→ 连 wss://本域/ws（本域→3030）
 *         = 原生 ChannelServer RPC（与直连页同源同数据）+ 原生前后台恢复
 *     页面静态资源（remote/v4 下 assets）→ relay 原样反代官方 CDN，不落地不修改
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const RELAY_PORT = Number(process.env.ZCODE_RELAY_PORT || 3032);
const ZCODE_ORIGIN = process.env.ZCODE_HOST_ORIGIN || 'http://127.0.0.1:3030';
const UPSTREAM = 'https://zcode.z.ai';
const PAGE_PATH = '/remote/v4';
let liteToken = '';
try {
  liteToken = (await readFile('<数据目录>/.zcode-token', 'utf8')).trim();
} catch {}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── HTTP 服务：/m 与 /remote/* 反代官方页面；其余 404（直连/API 由 nginx 直接给 3030）──
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${RELAY_PORT}`);
  const path = url.pathname;
  log(`HTTP ${req.method} ${path.replace(/\/[A-Za-z0-9_~.+-]{16,}$/, '/<token>')}`);

  const isMobileEntry = path === '/m' || path.startsWith('/m/');
  const isRemoteAsset = path.startsWith('/remote/');

  if (isMobileEntry || isRemoteAsset) {
    const target = isMobileEntry ? PAGE_PATH + url.search : path + url.search;
    // /m 的 HTML 要种 cookie，但不改内容；资源原样直通
    const fwdHeaders = { ...req.headers, host: 'zcode.z.ai' };
    const proxyReq = https.request(new URL(target, UPSTREAM), { method: req.method, headers: fwdHeaders }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      // 丢厂商 cookie（acw_tc 等），只留我们自己的 lite_token
      delete headers['set-cookie'];
      if (isMobileEntry && liteToken) {
        headers['set-cookie'] = [`zcode_lite_token=${liteToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`];
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => { log('反代失败', e.message); res.writeHead(502).end('upstream error'); });
    req.pipe(proxyReq);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('relay: not found ' + path);
});

server.listen(RELAY_PORT, '127.0.0.1', () => {
  log(`桥监听 http://127.0.0.1:${RELAY_PORT}（/m 入口，/remote/* 资源反代）`);
});
