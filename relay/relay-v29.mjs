#!/usr/bin/env node
// ZCode 远控桥 v29 —— /web-remote 直连流（官方远控 UI + 自建服务端）· 一次性门票版
// 入口（去 token 化后）：
//   1) 推荐链：已配对浏览器 POST /api/relay/ticket（凭设备会话 Cookie，relay 透传
//      3030 /api/server-info 校验）→ 拿到 10 分钟单次 ticket → GET /web-remote?ticket=<t>
//      → relay 消费入口 → 302 到 /web-remote?remoteControlToken=<同值 t>。
//   2) 兼容链（过渡期）：GET /web-remote?remoteControlToken=<旧 ZCODE_REMOTE_TOKEN>
//      仍可进（手机书签等既有入口链接带它），命中即记一条 "legacy token entry"。
//   3) 自助链：裸 GET /web-remote 且带有效设备会话 Cookie → relay 直接签发
//      "签发即入場" 的票并 302 到 remoteControlToken=<t>（无该参数官方 bundle 直连流
//      根本不启动：fHn() `if(!t)return`，见 relay 提交历史）。
// 页面(官方 bundle G4t 直连流)会依次调用（<t> 即上面入口消费的票值）:
//   GET  /api/remote-control/windows/bootstrap/<t>
//   WS   /ws/remote-control/window/<t>                (控制通道, 回 window-control-ready)
//   POST /api/remote-control/windows/<t>/workspace-bridge   (我们下发 wsUrl)
//   POST /api/remote-control/windows/<t>/mobile-view-state
//   POST /api/remote-control/platform/<t>
//   —— 这些端点不再做旧 token 等值比较，改为「路径值 == 有效票（已入場、10 分钟内）」
//      且同时要求请求带有效设备会话 Cookie（双因子：票是入口引导凭据，Cookie 是真凭据）。
//   然后页面用 wsUrl(= wss://本域/ws，不再带 ?token= —— 3030 新模型已不认 query token，
//   浏览器凭同源设备会话 Cookie 连接) 原生 ChannelServer RPC 直连 server(3030)
//   —— RPC 零桥接：与直连页同源同数据。
//
// relay→3030 服务端调用（collectBootstrap 的 server-info）：旧 ?token=<LITE_TOKEN> 已死。
//   改用 ZCODE_RELAY_LOCAL_SESSION（= 部署脚本为 "relay 系统设备" 生成的 deviceToken，
//   写入 <配置目录>/zcode-relay.env）走 POST /api/auth/renew 换会话，带 Cookie 调
//   server-info；凭据缺失/失效时降级（declared 为空，任务列表仍可用，版本退默认值）。
//
// ★ bootstrap 的 workspaces+tasks 是远控页任务列表的唯一数据源（bundle O4t 实证：
//   页面 fetch bootstrap 后直接消费，空列表仅重试 3×300ms）。因此必须在这里
//   与直连页同源读 tasks-index.sqlite（WAL 只读，与 server 共享），不能写死 []。
//   字段映射到页面严格 zod schema（og）：
//   tasks: {taskId,title,workspacePath,workspaceLabel,workspaceKind:'local',
//           createdAt,updatedAt,provider,displayStatus:'idle'|'running'|'completed'|'error',
//           pinned?,archived?}；workspaceKey 规则两端一致 = workspaceIdentity||workspacePath。
import http from 'node:http';
import https from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createTicketStore, createSessionVerifier, createLocalSession } from './relay-common.mjs';
// ws 依赖解析：ZCODE_WS_MODULE → 常规包解析 → 安装目录自带副本。
async function loadWsModule() {
  const candidates = [process.env.ZCODE_WS_MODULE, 'ws', '<部署目录>/node_modules/ws/wrapper.mjs']
    .filter(Boolean);
  for (const spec of candidates) {
    try {
      return await import(spec);
    } catch {}
  }
  throw new Error('未找到 ws 模块：请在 relay 目录执行 `npm i ws`，或用 ZCODE_WS_MODULE 指向 ws 入口');
}
const { WebSocketServer } = await loadWsModule();

const PORT = Number(process.env.ZCODE_RELAY_PORT || 3032);
const ZCODE_ORIGIN = process.env.ZCODE_HOST_ORIGIN || 'http://127.0.0.1:3030';
const UPSTREAM = 'https://zcode.z.ai';
const PAGE_PATH = '/remote/v4';
// 官方按请求里的 app_version 参数下发不同版本的远控页 bundle：/remote/v4（无版本段）跳 latest
// （3.14.0，display 判别 union 不认识 3.14.3 的工作流工具卡，会整帧拒收 → recoveryFailed）；
// /remote/v4/<version>/ 才是与 server 配套的页面（实测 /remote/v4/3.14.3/assets/index-NjWRUABD.js
// 含 eval_workflow_snippet 渲染器）。此处固定走 3.14.3，与自建 server 版本一致。
const PAGE_VERSION = '3.14.3';
// 下发给页面的 WS 地址。留空时按请求 Host 推导（wss://<host>/ws）；
// 反向代理终止 TLS 时用 ZCODE_BRIDGE_PUBLIC_WS 显式覆盖。
const PUBLIC_WS = (process.env.ZCODE_BRIDGE_PUBLIC_WS || '').trim().replace(/\/+$/, '');
// 旧单 token（过渡期兼容入口）：ZCODE_REMOTE_TOKEN 仍可用于 /web-remote 入口；
// ZCODE_SERVER_TOKEN 已废弃（3030 不再认 query token），保留读取仅为兼容 env 文件不炸，不参与任何校验。
const REMOTE_TOKEN = process.env.ZCODE_REMOTE_TOKEN || '';
const TASKS_DB = process.env.ZCODE_TASKS_DB || '<数据目录>/.zcode/v2/tasks-index.sqlite';
// relay 系统设备凭据（部署脚本经 admin-cli.sh 生成并写入 <配置目录>/zcode-relay.env；
// collectBootstrap 凭它 renew 出的会话调 3030 /api/server-info）。
const LOCAL_DEVICE_TOKEN = (process.env.ZCODE_RELAY_LOCAL_SESSION || '').trim();
// 「不在项目中工作」的共享对话目录（语义同桌面端 {dataBaseDir}/.zcode/workspace/default）。
const CONVERSATION_WORKSPACE =
  process.env.ZCODE_CONVERSATION_WORKSPACE || '<数据目录>/.zcode/workspace/default';
// 官方远控页镜像根目录（可选离线化；缺失时按 UPSTREAM 回源）。
const REMOTE_MIRROR_ROOT = process.env.ZCODE_REMOTE_MIRROR || '<镜像目录>';

/* ---------- v29 鉴权组件（可测试核心在 relay-common.mjs） ---------- */
const tickets = createTicketStore({ ttlMs: Number(process.env.ZCODE_RELAY_TICKET_TTL_MS) || 10 * 60 * 1000 });
const sessionVerifier = createSessionVerifier({ origin: ZCODE_ORIGIN });
const localSession = createLocalSession({
  origin: ZCODE_ORIGIN,
  deviceToken: LOCAL_DEVICE_TOKEN,
  onEvent: (kind, msg) => log(`[local-session:${kind}]`, msg),
});


function publicWsFor(req) {
  if (PUBLIC_WS) return PUBLIC_WS;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(
    req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`,
  ).split(',')[0].trim();
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}/ws`;
}

const WINDOW_ID = 'wcs-' + randomUUID();
let lastViewState = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 注入到官方远控页 HTML 的恢复 shim（见反代处注释）。策略（自愈优先，默认不刷新）：
// - WS 非正常 close：只挂横幅 + 每 2s 观测页面状态。
//   官方页面（nginx 日志实证）WS close 后会**自行重连**（5 条 101 同刻重建），
//   此时撤横幅、什么都不做——用户无感。这是默认路径，绝大多数切后台场景走这里。
// - 仅当页面进入不可恢复错误屏（RPC 通道放弃重连，body 出现
//   "Web remote control relay connection closed." 文案）才 reload 兜底，
//   且 reload 前先探测网络可达（避免弱网下 reload 后再次失败形成连环刷新）。
// - 正常关闭（1000/1001）完全不干预。
const RECOVERY_SHIM_JS = `
(function(){
  if (window.__ZCODE_RC_RECOVERY__) return; window.__ZCODE_RC_RECOVERY__ = true;
  var KEY='zcode-rc-guard-reloads', WIN=60000, MAX=3;
  var broken=false, reloading=false;
  function allowed(){ try{
    var now=Date.now(), s=JSON.parse(sessionStorage.getItem(KEY)||'[]')
      .filter(function(t){return now-t<WIN;});
    if(s.length>=MAX) return false; s.push(now);
    sessionStorage.setItem(KEY, JSON.stringify(s)); return true;
  }catch(e){ return true; } }
  function banner(){ var el=document.getElementById('zcode-rc-recover');
    if(!el){ el=document.createElement('div'); el.id='zcode-rc-recover';
      el.textContent='\\u8fde\\u63a5\\u4e2d\\u65ad\\uff0c\\u6b63\\u5728\\u81ea\\u52a8\\u6062\\u590d\\u2026';
      el.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 16px;'+
        'text-align:center;background:#b91c1c;color:#fff;font:13px/1.4 system-ui,sans-serif;';
      (document.body||document.documentElement).appendChild(el); } }
  function unbanner(){ var el=document.getElementById('zcode-rc-recover'); if(el) el.remove(); }
  function reloadIfAllowed(){ if(reloading) return; if(allowed()){ reloading=true;
      try{ sessionStorage.setItem('zcode-rc-recover','1'); }catch(e){}
      location.reload(); } }
  function netReachable(){ return new Promise(function(resolve){
    var done=false, to=setTimeout(function(){ if(!done){done=true;resolve(false);} },1200);
    try{ fetch(location.origin+'/zusage/boot.js?rcprobe='+Date.now(),{cache:'no-store'})
      .then(function(r){ if(!done){done=true;clearTimeout(to);resolve(r.ok);} })
      .catch(function(){ if(!done){done=true;clearTimeout(to);resolve(false);} });
    }catch(e){ if(!done){done=true;clearTimeout(to);resolve(false);} }
  }); }
  // 错误屏特征：官方 bundle 在 RPC 通道放弃恢复时渲染该英文文案。
  function errorScreenUp(){ return (document.body?document.body.innerText:'')
    .indexOf('Web remote control relay connection closed.')>=0; }
  function markBroken(){ if(broken) return; broken=true; banner();
    setTimeout(function(){ if(!broken) return; observe(); }, 3000); }
  function observe(){ if(reloading||!broken) return;
    if(errorScreenUp()){
      // 页面已放弃自愈：网络可达才刷新（一次成功，不再连环）。
      netReachable().then(function(ok){ if(ok) reloadIfAllowed(); else setTimeout(observe,1500); });
      return;
    }
    // 页面仍在自行重连：检查是否已恢复（新 WS OPEN 且无错误屏）。
    netReachable().then(function(ok){
      if(ok && !errorScreenUp()){ broken=false; unbanner(); return; }
      setTimeout(observe, 2000);
    });
  }
  try{ if(sessionStorage.getItem('zcode-rc-recover')==='1'){ sessionStorage.removeItem('zcode-rc-recover'); banner();
      setTimeout(function(){ var el=document.getElementById('zcode-rc-recover'); if(el) el.remove(); }, 4000); } }catch(e){}
  var OW=window.WebSocket;
  function Wrapped(url, protocols){ var ws = protocols===undefined ? new OW(url) : new OW(url, protocols);
    ws.addEventListener('close', function(ev){
      if(ev.wasClean || ev.code===1000 || ev.code===1001) return;
      markBroken();
    });
    return ws; }
  Wrapped.prototype=OW.prototype;
  Wrapped.CONNECTING=OW.CONNECTING; Wrapped.OPEN=OW.OPEN; Wrapped.CLOSING=OW.CLOSING; Wrapped.CLOSED=OW.CLOSED;
  window.WebSocket=Wrapped;
  // 离线化收尾：页面 JS 硬编码向 https://zcode.z.ai/api/v1/client/configs 拉 UI 配置。
  // relay 已镜像该响应（client-configs.json），这里把该请求重定向到本域同路径，浏览器
  // 从此对 z.ai 零请求。其余 z.ai 域名请求（无）不受影响。
  var OF=window.fetch;
  window.fetch=function(input, init){
    try{
      var u = typeof input==='string' ? input : (input && input.url) || '';
      if(u.indexOf('https://zcode.z.ai/')===0){
        input = u.replace('https://zcode.z.ai', window.location.origin);
        if(init && init.mode==='cors') init = Object.assign({}, init, {mode:'same-origin'});
      }
    }catch(e){}
    return OF.call(this, input, init);
  };
})();`;

function tokenOk(given) {
  if (!REMOTE_TOKEN || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(REMOTE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- v29 端点鉴权（替换 v28 的 tokenOk 单因子） ----------
 * 三选一：
 *   a) 路径值是「已入場的有效票」且请求带有效设备会话 Cookie（门票流，主路径）；
 *   b) 路径值 == 旧 REMOTE_TOKEN（legacy 过渡期；真凭据同样是请求 Cookie ——
 *      旧 token 只是入口门票，3030 数据面早已不认它）；命中记 legacy 日志。
 * Cookie 校验带 30s 正缓存（页面一个加载周期多次端点调用不重复打 3030）。
 * 会话校验不可达（3030 挂）时 fail closed 但区分 502，页面可见「上游不可达」。 */
async function authorizeEndpoint(pathValue, req, res) {
  if (tokenOk(pathValue)) {
    log('legacy token entry:', req.socket?.remoteAddress || '?');
  } else if (!tickets.apiActive(pathValue)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid ticket' }));
    return false;
  }
  const verdict = await sessionVerifier.verify(req.headers.cookie);
  if (verdict.ok) return true;
  const code = verdict.reason === 'server-unreachable' ? 502 : 401;
  log('端点拒绝:', verdict.reason);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: verdict.reason }));
  return false;
}


// 与 server taskIndexRepo 同规则的只读任务查询（deleted=0，updated_at 倒序）
function readTasks() {
  try {
    const db = new DatabaseSync(TASKS_DB, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT workspace_path, workspace_identity, task_id, title, task_status,
                provider, pinned, archived, created_at, updated_at
         FROM tasks
         WHERE deleted = 0
         ORDER BY updated_at DESC, created_at DESC, task_id DESC
         LIMIT 300`,
      ).all();
      return rows;
    } finally { db.close(); }
  } catch (e) {
    log('读任务库失败（降级为空列表）:', e.message);
    return [];
  }
}

// meta.status（last prompt 结果）→ 页面 displayStatus 枚举
function toDisplayStatus(taskStatus) {
  if (taskStatus === 'running') return 'running';
  if (taskStatus === 'error') return 'error';
  return 'completed';
}

function labelFor(path) {
  if (!path) return '/';
  const parts = String(path).replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.at(-1) ?? String(path);
}

// bootstrap 数据：workspaces = server-info 宣告 ∪ 任务行出现过的 workspace（与直连页同源）
async function collectBootstrap() {
  let version = PAGE_VERSION;
  let declared = [];
  // v29：server-info 只认设备会话 Cookie（旧 ?token= 已死）。凭 relay 系统设备凭据
  // （ZCODE_RELAY_LOCAL_SESSION）renew 出的会话调用；无凭据/失效时降级为空宣告
  // （任务列表仍可用——它来自本机 tasks-index.sqlite），仅 workspace 宣告缺失。
  try {
    const cookie = await localSession.cookieHeader();
    const r = await fetch(ZCODE_ORIGIN + '/api/server-info', {
      headers: cookie ? { cookie } : {},
    });
    if (r.status === 401 && cookie) {
      // 会话过期：作废缓存重换发一次，再试一回
      localSession.invalidate();
      const retryCookie = await localSession.cookieHeader();
      if (retryCookie) {
        const r2 = await fetch(ZCODE_ORIGIN + '/api/server-info', { headers: { cookie: retryCookie } });
        if (r2.ok) {
          const j = await r2.json();
          version = j.version || version;
          if (Array.isArray(j.workspaces)) declared = j.workspaces;
        }
      }
    } else if (r.ok) {
      const j = await r.json();
      version = j.version || version;
      if (Array.isArray(j.workspaces)) declared = j.workspaces;
    }
  } catch (e) { log('server-info 失败:', e.message); }

  const taskRows = readTasks();
  // workspaceKey 两端同规则：workspaceIdentity?.trim() || workspacePath（shared/task-realtime-core.ts resolveWorkspaceKey）
  const seenKeys = new Set();
  const workspaces = [];
  const pushWs = (path, identity) => {
    const key = (identity && identity.trim()) || path;
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    // 桌面端语义（services/src/paths.ts getConversationWorkspaceDir）：{dataBaseDir}/.zcode/workspace/default
    // 是"非项目对话共享工作目录"，UI 归为「不在项目中工作」（workspacePurpose: conversation），
    // 只有用户显式创建的目录才是 project。按同一路径规则判定，不写死。
    const isConversation =
      String(path).replace(/\/+$/, '') === CONVERSATION_WORKSPACE.replace(/\/+$/, '');
    workspaces.push({
      kind: 'local',
      label: labelFor(path),
      workspacePath: path,
      workspacePurpose: isConversation ? 'conversation' : 'project',
    });
  };
  for (const w of declared) pushWs(w.path, undefined);
  for (const t of taskRows) pushWs(t.workspace_path, t.workspace_identity);

  const tasks = taskRows.map(t => ({
    taskId: t.task_id,
    title: t.title ?? '',
    workspacePath: t.workspace_path,
    workspaceLabel: labelFor(t.workspace_path),
    workspaceKind: 'local',
    createdAt: Number(t.created_at) || Date.now(),
    updatedAt: Number(t.updated_at) || Date.now(),
    provider: 'glm',
    displayStatus: toDisplayStatus(t.task_status),
    pinned: t.pinned === 1 ? true : undefined,
    archived: t.archived === 1 ? true : undefined,
  }));

  const firstKey = workspaces[0]?.workspacePath ?? '/';
  const mv = lastViewState || { activeWorkspaceKey: firstKey, updatedAt: Date.now() };
  return {
    desktopAppVersion: version,
    windowControlSessionId: WINDOW_ID,
    mobileViewState: mv,
    workspaces,
    tasks,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean);

  // ── v29 门票签发：POST /api/relay/ticket ──
  // 鉴权 = 浏览器设备会话 Cookie（relay 透传给 3030 /api/server-info，200 即有效）。
  // 返回 { ticket, expiresAt, entryUrl }；票 10 分钟、入口单次。同源下 Cookie 自动携带
  // （nginx /api/relay/ → relay 的路由见 deploy/nginx-zcode.conf，运维侧另有同步运行副本）。
  if (path === '/api/relay/ticket' && req.method === 'POST') {
    const verdict = await sessionVerifier.verify(req.headers.cookie);
    if (!verdict.ok) {
      const code = verdict.reason === 'server-unreachable' ? 502 : 401;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: verdict.reason }));
      return;
    }
    const { ticket, expiresAt } = tickets.issue();
    log('ticket issued (ip=' + (req.socket?.remoteAddress || '?') + ')');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ticket, expiresAt, entryUrl: '/web-remote?ticket=' + ticket }));
    return;
  }

  // ── v29 入口：/web-remote?ticket=<t> 或 ?remoteControlToken=<旧token/票> ──
  // 官方 bundle 硬性要求 URL 带 remoteControlToken 参数（fHn: if(!t)return 直连流不启动），
  // 故 ticket 入口消费后 302 到 remoteControlToken=<同值>；裸访问（无任何参数）时若
  // 浏览器已配对（有会话 Cookie）→ 自助签发「签发即入場」的票并 302。三种链殊途同归。
  if (path === '/web-remote' || path === '/web-remote/') {
    const ticketParam = url.searchParams.get('ticket') || '';
    const legacyParam = url.searchParams.get('remoteControlToken') || '';
    if (ticketParam) {
      if (!tickets.consumeEntry(ticketParam)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('relay: 门票无效或已使用/过期。请从直连页重新进入远控页。');
        return;
      }
      log('ticket entry consumed, redirect to param mode');
      res.writeHead(302, { Location: '/web-remote?remoteControlToken=' + encodeURIComponent(ticketParam) });
      res.end();
      return;
    }
    if (legacyParam && tokenOk(legacyParam)) {
      log('legacy token entry: /web-remote (remoteControlToken param)');
      // 旧入口直落参数模式：页面会把该值带进各端点，端点侧 tokenOk() 认它（authorizeEndpoint）。
      // 不在这里拦截，交给下方正常伺服分支。
    } else if (!legacyParam) {
      // 裸访问：浏览器已配对才自助发票；未配对 401 引导去 /login 配对。
      const verdict = await sessionVerifier.verify(req.headers.cookie);
      if (!verdict.ok) {
        const code = verdict.reason === 'server-unreachable' ? 502 : 401;
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(code === 502 ? 'relay: 上游鉴权服务不可达，请稍后再试。' : 'relay: 未配对。请先访问 /login 完成设备配对。');
        return;
      }
      const { ticket } = tickets.issue({ entered: true });
      log('self-service ticket issued on bare /web-remote');
      res.writeHead(302, { Location: '/web-remote?remoteControlToken=' + encodeURIComponent(ticket) });
      res.end();
      return;
    }
    // legacyParam 有效或已消费票的参数模式 → 落到下方页面伺服（镜像/回源）
  }

  // ── relay 直连流接口（v29：token 位置=票值或旧 token；鉴权见 authorizeEndpoint）──
  if (path.startsWith('/api/remote-control/')) {
    const token = seg[2] === 'windows' ? (seg[3] === 'bootstrap' ? seg[4] : seg[3]) : seg[seg.length - 1];
    if (!(await authorizeEndpoint(token, req, res))) return;

    if (seg[3] === 'bootstrap') {
      const b = await collectBootstrap();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(b));
      return;
    }
    if (seg[4] === 'workspace-bridge') {
      const body = await readBody(req);
      // 会话保持（断线 reload 恢复回原会话）：页面重走 bootstrap 后发来的 bridge 请求 body.taskId
      // 为空（rHn 选择函数不消费 mobileViewState），导致恢复后落入「新建对话」。
      // 修复：页面运行时通过 mobile-view-state 上报了当前所在会话（activeTaskId），
      // 这里在其缺位时用 lastViewState.activeTaskId 兜底下发 initialTaskId；
      // 页面渲染链 initialTaskId: bridge.initialTaskId 原生支持，直接回到原会话。
      // 仅在 workspaceKey 与 viewState 记录一致时回放，避免串会话。
      const fallbackTaskId = lastViewState?.activeTaskId;
      const wsMatch =
        !fallbackTaskId ||
        !body.workspaceKey ||
        !lastViewState?.activeWorkspaceKey ||
        body.workspaceKey === lastViewState.activeWorkspaceKey;
      const initialTaskId = body.taskId || (wsMatch ? fallbackTaskId : undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        // v29：不再带 ?token= —— 3030 设备凭据模型的 /ws 只认会话 Cookie（http.ts 已无
        // query token 读取，实测 grep 证实）。页面与 3030 同源，浏览器自动带 Cookie。
        wsUrl: publicWsFor(req),
        bridgeGeneration: 1,
        bridgeSessionId: 'bridge-' + randomUUID(),
        kind: 'local',
        workspaceKey: body.workspaceKey || '/',
        workspacePath: body.workspaceKey || '/',
        ...(initialTaskId ? { initialTaskId } : {}),
      }));
      return;
    }
    if (seg[4] === 'mobile-view-state') {
      const body = await readBody(req);
      // 兼容两种页面版本：官方 latest(3.14.0) 包装为 {viewState:{...}}；3.14.3 版(ZVn)直接
      // 发扁平 {activeWorkspaceKey, activeTaskId?, updatedAt, deviceInfo}。此前只认包装形式，
      // 3.14.3 页面的视图上报被整个丢弃 → reload 后无 activeTaskId 可回放，落到「新建对话」。
      const vs = body.viewState ?? body;
      if (vs && vs.activeWorkspaceKey) lastViewState = vs;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (seg[2] === 'platform') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: null }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not implemented' }));
    return;
  }

  // ── 页面与资源：本地镜像优先（离线化：浏览器不再连 zcode.z.ai），缺失才回源 ──
  // 镜像来源：官方 /remote/v4?app_version=3.14.3 的 HTML 及其 3.14.3/assets/*（2480 文件，
  // 与自建 server 版本配套，含工作流工具卡渲染器）。镜像完整性由 scripts 校验（referenced
  // 2467/2467 + 12 非 JS 资源）。页面 JS 运行时对 z.ai 无 API 调用（已无头审计：唯一外域
  // 请求是静态资源本体），会话数据全部走本域 ws/api。
  if (path === '/web-remote' || path === '/web-remote/' || path.startsWith('/remote/')) {
    const mirrorRoot = REMOTE_MIRROR_ROOT;
    const serveMirror = (absFile, mime) => {
      const stream = createReadStream(absFile);
      const headers = { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' };
      stream.on('error', () => { try { res.writeHead(500).end('mirror read error'); } catch {} });
      res.writeHead(200, headers);
      stream.pipe(res);
    };
    const MIME = {
      '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
      '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8',
      '.webmanifest': 'application/manifest+json', '.json': 'application/json',
    };
    // 1) 入口 HTML（镜像里的 index.html = 官方 3.14.3 版，含恢复 shim 注入）
    if (path === '/web-remote' || path === '/web-remote/' || path === '/remote/v4' || path === '/remote/v4/') {
      const abs = join(mirrorRoot, 'index.html');
      if (existsSync(abs)) {
        let html = readFileSync(abs, 'utf8');
        const idx = html.toLowerCase().lastIndexOf('</head>');
        if (idx >= 0) html = html.slice(0, idx) + '<script>' + RECOVERY_SHIM_JS + '</script>' + html.slice(idx);
        else html += '<script>' + RECOVERY_SHIM_JS + '</script>';
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }
      // 镜像缺失 → 回退回源（保可用性）
      log('镜像缺失 index.html，回源');
    } else if (path.startsWith('/remote/v4/3.14.3/assets/')) {
      // 2) 静态资源：路径与官方一致，直接映射镜像目录
      const rel = normalize(path).replace(/^(\.\.[/\\])+/, ''); // 防 path traversal
      const abs = join(mirrorRoot, rel);
      if (existsSync(abs) && statSync(abs).isFile()) {
        serveMirror(abs, MIME[extname(abs)] || 'application/octet-stream');
        return;
      }
      log('镜像缺失资源，回源:', path);
    } else if (path === '/api/v1/client/configs') {
      // 3) 官方 client/configs：页面启动时必调（提供方列表等 UI 配置）。镜像官方响应，
      //    避免浏览器直连 z.ai 拿这份 JSON（阻断测试证明降级可用，但本地应答更干净）。
      const abs = join(mirrorRoot, 'client-configs.json');
      if (existsSync(abs)) {
        serveMirror(abs, 'application/json');
        return;
      }
    }

    // 3) 回源反代（镜像 miss 时的兜底；正常情况不会走到）
    const target =
      path === '/web-remote' || path === '/web-remote/'
        ? `${PAGE_PATH}?app_version=${PAGE_VERSION}${url.search ? '&' + url.search.slice(1) : ''}`
        : path + url.search;
    const proxyReq = https.request(new URL(target, UPSTREAM), {
      method: req.method,
      // HTML 分支要缓冲文本做注入，必须拿到未压缩明文：identity 让上游不回 gzip
      // （gzip 字节 toString('utf8') 会产生乱码文档）。其它资源不受影响。
      headers: { ...req.headers, host: 'zcode.z.ai', 'accept-encoding': 'identity' },
    }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers['set-cookie']; // 不种厂商 cookie；本流程凭 remoteControlToken + wsUrl query token
      // 恢复 shim 仅注入 HTML 文档（/web-remote 与 /remote/v4 的 index.html）。
      // 依据：官方 QR 流页面装有 e4t 挂起/恢复协调器（visibilitychange→onRecover），
      // 而 remoteControlToken 直连流（G4t）没有——任一 WS 在手机后台被冻结回收后
      // close(1006) 直接进错误屏（relay-unavailable「中转异常」）。shim 在文档层补齐
      // 等价恢复：异常 close 时提示，回前台整页 reload 重走 G4t bootstrap（服务端
      // 是事实源，快照补齐），正常 close(1000/1001) 与切工作流不受影响。
      // reload 频控 3 次/60s：超限停在官方错误屏（自带重试按钮）。
      const isHtmlDocument =
        path === '/web-remote' || path === '/web-remote/' ||
        (path === '/remote/v4' || path === '/remote/v4/');
      const contentType = String(proxyRes.headers['content-type'] || '');
      if (isHtmlDocument && proxyRes.statusCode === 200 && contentType.includes('text/html')) {
        delete headers['content-length'];
        // 上游按 Accept-Encoding 返回 gzip；缓冲解包后必须同步删除压缩头，
        // 否则浏览器按 gzip 解码我们写入的明文 → ERR_CONTENT_DECODING_FAILED。
        delete headers['content-encoding'];
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8');
          // 注入点必须是文档流内（doctype 之前的前置 script 会阻断解析进 quirks 模式），
          // 放到 </head> 前最早执行且不阻塞后续资源。
          const idx = html.toLowerCase().indexOf('</head>');
          const out = idx >= 0
            ? html.slice(0, idx) + '<script>' + RECOVERY_SHIM_JS + '</script>' + html.slice(idx)
            : html + '<script>' + RECOVERY_SHIM_JS + '</script>';
          res.writeHead(proxyRes.statusCode ?? 502, headers);
          res.end(out);
        });
        proxyRes.on('error', () => { try { res.writeHead(502).end(); } catch {} });
        return;
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
      return;
    });
    proxyReq.on('error', (e) => { log('反代失败:', e.message); res.writeHead(502).end('upstream error'); });
    req.pipe(proxyReq);
    return;
  }

  // ── 官方 client/configs：页面启动时必调（提供方列表等 UI 配置）。镜像官方响应，
  //    避免浏览器直连 z.ai（阻断测试证明缺省降级可用，本地应答更干净）。
  if (path === '/api/v1/client/configs') {
    const abs = join(REMOTE_MIRROR_ROOT, 'client-configs.json');
    if (existsSync(abs)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      createReadStream(abs).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('relay: not found');
});

// ── 控制通道 WS：连上立刻回 window-control-ready，之后页面才 POST workspace-bridge ──
// v29：鉴权 = 路径末段是有效票/旧 token，且升级请求带有效设备会话 Cookie。
// WS 升级没有响应体可写：拒绝即 destroy socket（官方页面按 relay-unavailable 处理）。
const wssControl = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (!url.pathname.startsWith('/ws/remote-control/window/')) { socket.destroy(); return; }
  const token = url.pathname.split('/').filter(Boolean).at(-1);
  const legacyOk = tokenOk(token);
  if (legacyOk) log('legacy token entry: ws upgrade');
  else if (!tickets.apiActive(token)) { socket.destroy(); return; }
  const verdict = await sessionVerifier.verify(req.headers.cookie);
  if (!verdict.ok) { socket.destroy(); return; }
  wssControl.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({
      type: 'window-control-ready',
      windowControlSessionId: WINDOW_ID,
      mobileConnectionId: 'mcc-' + randomUUID(),
    }));
    ws.on('message', () => {});
    ws.on('error', () => {});
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log('桥监听 127.0.0.1:' + PORT + '（v29 一次性门票）');
  log('入口: /web-remote?ticket=<票>（主）| ?remoteControlToken=<旧token>（过渡兼容）');
  log('门票签发: POST /api/relay/ticket（设备会话 Cookie）；本地凭据:',
    localSession.hasCredential ? '已配置' : '未配置（server-info 宣告降级为空）');
  log('旧 token 入口兼容:', REMOTE_TOKEN ? '开（legacy token entry 会记日志）' : '关');
});
