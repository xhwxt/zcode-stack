#!/usr/bin/env node
/**
 * ZCode 自建 relay— terminal(官方远控页) ↔ 本服务 ↔ ZCode server /ws/host
 * 协议依据：官方 bundle + zemote 双向核实
 */
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from '<部署目录>/node_modules/ws/wrapper.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const RELAY_PORT = Number(process.env.ZCODE_RELAY_PORT || 3032);
const ZCODE_ORIGIN = process.env.ZCODE_HOST_ORIGIN || 'http://127.0.0.1:3099';
const ZCODE_HOST_WS = process.env.ZCODE_HOST_WS_URL || 'http://127.0.0.1:3099/ws/host';
const ZCODE_SERVER_TOKEN = process.env.ZCODE_SERVER_TOKEN || '';
const STATE_PATH = process.env.ZCODE_RELAY_STATE || '<数据目录>/relay-state.json';

async function loadOrCreateSession() {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (s.sid && s.hash) return s;
  } catch {}
  const s = { sid: 'd_' + randomBytes(12).toString('base64url'), hash: randomBytes(32).toString('base64') };
  await writeFile(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  console.log('[relay] generated fixed session');
  return s;
}
const SESSION = await loadOrCreateSession();

const calculateProof = (passHash, nonce, role, deviceSid) =>
  createHmac('sha256', Buffer.from(passHash, 'utf8'))
    .update(Buffer.from(nonce + '|' + role + '|' + deviceSid, 'utf8'))
    .digest('base64url');

// ---------- CRC32（rpc-frame 校验，与官方/zemote 一致） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32hex = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return ((c ^ -1) >>> 0).toString(16).padStart(8, '0');
};

let seqCounter = 0, msgSeq = 0;
let activeTerminal = null;
let hostSock = null;
let currentBridge = null;
let hostReady = false;
const pendingOutgoing = []; // host 未就绪时排队的终端帧
const hostInitFrames = []; // {bridgeSessionId, bridgeGeneration} — terminal 开的 bridge
let bridgeTerminal = null; // 开启 bridge 的那个 terminal

const sendJson = (ws, obj) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const s = JSON.stringify(obj);
    if (obj.type === 'data' && obj.payload && obj.payload.zcode_type !== 'rpc-frame') console.log('[relay] T←:', s.slice(0, 250));
    ws.send(s);
  }
};

function sendRpcFrameToTerminal(data) {
  if (!activeTerminal || !currentBridge) { console.log('[relay] rpc drop: activeTerminal=' + Boolean(activeTerminal) + ' currentBridge=' + Boolean(currentBridge)); return; }
  console.log('[relay] rpc sending len=' + data.length + ' bridge=' + currentBridge.bridgeSessionId + ' readyState=' + activeTerminal.readyState);
  const payload = {
    zcode_type: 'rpc-frame',
    bridgeSessionId: currentBridge.bridgeSessionId,
    bridgeGeneration: currentBridge.bridgeGeneration,
    seq: ++seqCounter,
    messageSeq: ++msgSeq,
    fragmentIndex: 0,
    fragmentCount: 1,
    messageBytes: data.length,
    checksum: { algorithm: 'crc32', value: crc32hex(data) },
    dataBase64: data.toString('base64'),
  };
  sendJson(activeTerminal, { type: 'data', payload, client_ts: Date.now() });
}

let serverInfoCache = { data: null, at: 0 };
async function serverInfo() {
  if (serverInfoCache.data && Date.now() - serverInfoCache.at < 5000) return serverInfoCache.data;
  const res = await fetch(ZCODE_ORIGIN + '/api/server-info?token=' + encodeURIComponent(ZCODE_SERVER_TOKEN));
  if (!res.ok) throw new Error('server-info HTTP ' + res.status);
  const data = await res.json();
  serverInfoCache = { data, at: Date.now() };
  return data;
}
function platformMethod(method) {
  // 官方 terminal 会经 platform 桥调用桌面能力；服务器环境下先返回空实现，具体 method 按需补
  return null;
}
const DEVICE_NAME = process.env.ZCODE_RELAY_DEVICE_NAME || '<部署主机名>';
const WIN_SESSION_ID = randomUUID();

async function fetchHostCapability() {
  const res = await fetch(ZCODE_ORIGIN + '/api/rpc-host-capability?token=' + encodeURIComponent(ZCODE_SERVER_TOKEN), { method: 'POST' });
  if (!res.ok) throw new Error('capability HTTP ' + res.status);
  return res.json();
}

async function connectHost() {
  try {
    const cap = await fetchHostCapability();
    const url = ZCODE_HOST_WS + '?token=' + encodeURIComponent(ZCODE_SERVER_TOKEN);
    const ws = new WebSocket(url, { headers: { 'x-zcode-rpc-host-capability': cap.capability } });
    ws.on('open', () => { console.log('[relay] host connected'); hostSock = ws; hostReady = true; for (const f of pendingOutgoing.splice(0)) { try { ws.send(f); } catch {} } });
    return new Promise((res) => { const check = setInterval(() => { if (hostSock === ws && ws.readyState === WebSocket.OPEN) { clearInterval(check); res(); } }, 50); });
    hostInitFrames.length = 0;
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      console.log('[relay] H→ ' + (currentBridge ? 'bridge' : 'buf') + ' len=' + buf.length + ' head=' + buf.slice(0, 13).toString('hex'));
      if (!hostReady || !currentBridge) {
        // server 的初始化推送先于 terminal bridge —— 缓存待 bridge-ready 后重放
        if (hostInitFrames.length < 64) hostInitFrames.push(buf);
        console.log('[relay] H→ buffered init frame len=' + buf.length);
        return;
      }
      sendRpcFrameToTerminal(buf);
    });
    ws.on('close', (code) => {
      console.error('[relay] host closed', code);
      if (hostSock === ws) { hostSock = null; hostReady = false; }
      setTimeout(connectHost, 3000);
    });
    ws.on('error', (e) => console.error('[relay] host ws error:', e.message));
  } catch (e) {
    console.error('[relay] host connect failed:', e.message, '- retry in 3s');
    setTimeout(connectHost, 3000);
  }
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ts: Date.now() }));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const mid = url.searchParams.get('mid');
  let lastNonce = '';
  let paired = false;
  console.log('[relay] terminal connected mid=' + (mid || 'none'));

  ws.on('message', async (raw) => {
    try {
      console.log('[relay] raw:', raw.toString().slice(0, 110));
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    switch (frame.type) {
      case 'auth_init': {
        if (frame.role !== 'terminal') return ws.close(4013, 'invalid role');
        if (frame.device_sid !== SESSION.sid) return ws.close(4004, 'session-not-found');
        lastNonce = randomBytes(16).toString('base64url');
        sendJson(ws, { type: 'auth_challenge', nonce: lastNonce, server_ts: Date.now() });
        break;
      }
      case 'auth_response': {
        const expect = calculateProof(SESSION.hash, lastNonce, 'terminal', SESSION.sid);
        const a = Buffer.from(String(frame.proof || ''));
        const b = Buffer.from(expect);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return ws.close(4013, 'invalid-mobile-connection');
        if (activeTerminal && activeTerminal !== ws && activeTerminal.readyState === WebSocket.OPEN) {
          sendJson(activeTerminal, { type: 'error', code: 'KICKED', message: 'duplicate terminal connection' });
          activeTerminal.close(4009, 'session-conflict');
        }
        activeTerminal = ws;
        paired = true;
        seqCounter = 0; msgSeq = 0; // 每个新 terminal 的 rpc-frame 序号独立（官方桌面端行为）
        sendJson(ws, { type: 'auth_ack', pair_status: 'matched', server_ts: Date.now() });
        console.log('[relay] terminal paired');
        break;
      }
      case 'pair_status_query':
        sendJson(ws, { type: 'pair_status_ack', pair_status: paired ? 'matched' : 'waiting', server_ts: Date.now() });
        break;
      case 'data': {
        if (!paired) return;
        const p = frame.payload;
        if (!p || typeof p !== 'object') return;
        if (p.zcode_type !== 'rpc-frame') console.log('[relay] T→:', JSON.stringify(p).slice(0, 200));
        if (p.zcode_type === 'rpc-frame') {
          // bridge 会话的 rpc-frame：把 terminal 的 ChannelClient 帧原样发给 server（ChannelServer）
          const chunk = Buffer.from(p.dataBase64, 'base64');
          console.log('[relay] T→rpc forwarding len=' + chunk.length + ' bridge=' + p.bridgeSessionId + ' hostReady=' + hostReady);
          if (hostReady && hostSock && hostSock.readyState === WebSocket.OPEN) {
            hostSock.send(chunk);
          } else {
            pendingOutgoing.push(chunk);
          }
          sendJson(ws, { type: 'data', payload: { zcode_type: 'rpc-frame-ack', bridgeSessionId: p.bridgeSessionId, ackMessageSeq: p.messageSeq }, client_ts: Date.now() });
          break;
        }
        // ---- 应用层（官方桌面端闭源，本服务实现 host 侧）----
        switch (p.zcode_type) {
          case 'bootstrap-request': {
            const info = await serverInfo();
            sendJson(ws, { type: 'data', payload: {
              zcode_type: 'bootstrap-response', requestId: p.requestId, success: true,
              result: {
                windowControlSessionId: WIN_SESSION_ID,
                desktopAppVersion: info.version || '3.14.3',
                workspaces: (info.workspaces || []).map(w => ({
                  workspacePath: w.path, workspaceIdentity: w.workspaceIdentity || w.path,
                  label: w.label || w.path, kind: 'local', connectionState: 'connected',
                })),
                tasks: [],
              },
            }, client_ts: Date.now() });
            break;
          }
          case 'workspace-list-request': {
            const info = await serverInfo();
            sendJson(ws, { type: 'data', payload: {
              zcode_type: 'workspace-list-response', requestId: p.requestId, success: true,
              result: {
                workspaces: (info.workspaces || []).map(w => ({
                  workspacePath: w.path, workspaceIdentity: w.workspaceIdentity || w.path,
                  label: w.label || w.path, kind: 'local', connectionState: 'connected',
                })),
                tasks: [],
              },
            }, client_ts: Date.now() });
            break;
          }
          case 'workspace-bridge-open': {
            const bridgeSessionId = p.bridgeSessionId;
            currentBridge = { bridgeSessionId, bridgeGeneration: p.bridgeGeneration || 1 };
            bridgeTerminal = ws;
            // 每个新 bridge 使用全新 host 连接（等待建立后才回 bridge-ready，避免半开/时序问题）
            if (hostSock) { try { hostSock.close(); } catch {} hostSock = null; hostReady = false; }
            await connectHost();
            // 单 host 连接承载全部 bridge 的 RPC 帧（server 的 ChannelServer 按 channel 复用）
            sendJson(ws, { type: 'data', payload: {
              zcode_type: 'workspace-bridge-ready', requestId: p.requestId,
              bridgeSessionId, bridgeGeneration: p.bridgeGeneration || 1, ...(p.recoveryId ? { recoveryId: p.recoveryId } : {}),
              bridge: { bridgeSessionId, bridgeGeneration: p.bridgeGeneration || 1, ...(p.recoveryId ? { recoveryId: p.recoveryId } : {}), kind: 'local', workspaceKey: p.workspaceKey || '/', workspacePath: p.workspaceKey || '/' },
            }, client_ts: Date.now() });
            console.log('[relay] bridge opened:', bridgeSessionId, 'replaying', hostInitFrames.length, 'init frame(s)');
            console.log('[relay] BRIDGE-READY-RAW:', JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-bridge-ready', requestId: p.requestId, bridgeSessionId, bridgeGeneration: p.bridgeGeneration || 1, ...(p.recoveryId ? { recoveryId: p.recoveryId } : {}), bridge: { bridgeSessionId, bridgeGeneration: p.bridgeGeneration || 1, ...(p.recoveryId ? { recoveryId: p.recoveryId } : {}), kind: 'local', workspaceKey: p.workspaceKey || '/', workspacePath: p.workspaceKey || '/' } } }));
            for (const buf of hostInitFrames) sendRpcFrameToTerminal(buf); // 保留缓存：每个 bridge 都需要一份 Initialize
            break;
          }
          case 'workspace-reconnect-request': {
            sendJson(ws, { type: 'data', payload: {
              zcode_type: 'workspace-reconnect-response', requestId: p.requestId, workspaceKey: p.workspaceKey, ok: true,
            }, client_ts: Date.now() });
            break;
          }
          case 'platform-request': {
            sendJson(ws, { type: 'data', payload: {
              zcode_type: 'platform-response', requestId: p.requestId, method: p.method, success: true, result: platformMethod(p.method, p.args),
            }, client_ts: Date.now() });
            break;
          }
          case 'mobile-view-state-update':
          case 'telemetry-report':
          case 'mobile-diagnostic':
            break; // 单向通知
          default:
            console.log('[relay] unhandled zcode_type:', p.zcode_type);
        }
        break;
      }
    }
    } catch (e) { console.error('[relay] handler error:', e.message); }
  });

  ws.on('close', () => {
    if (activeTerminal === ws) activeTerminal = null;
    if (bridgeTerminal === ws) { currentBridge = null; bridgeTerminal = null; }
    console.log('[relay] terminal disconnected');
  });
  ws.on('error', (e) => console.error('[relay] terminal ws error:', e.message));
});

server.listen(RELAY_PORT, '127.0.0.1', () => {
  console.log('[relay] listening 127.0.0.1:' + RELAY_PORT);
  console.log('[relay] link: https://zcode.example.com/remote/v4?sid=' + SESSION.sid + '&hash=' + encodeURIComponent(SESSION.hash) + '&t=' + Date.now() + '&mid=<部署主机名>&name=<部署主机名>&app_version=3.14.0');
  connectHost();
});
