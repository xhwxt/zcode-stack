#!/usr/bin/env node
/**
 * ZCode 自建 relay v20 —— 最简干净架构
 * 页面(terminal) ↔ [relay: 3032] ↔ ZCode server /ws/host (3030)
 * 握手/配对/bootstrap 应答：照官方协议（已验证）
 * bridge：每 bridge 一条全新 server 连接，双向裸透传
 */
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from '<部署目录>/node_modules/ws/wrapper.mjs';
import { readFile, writeFile } from 'node:fs/promises';

const RELAY_PORT = Number(process.env.ZCODE_RELAY_PORT || 3032);
const ZCODE_ORIGIN = process.env.ZCODE_HOST_ORIGIN || 'http://127.0.0.1:3030';
const ZCODE_HOST_WS = process.env.ZCODE_HOST_WS_URL || 'http://127.0.0.1:3030/ws';
const ZCODE_SERVER_TOKEN = process.env.ZCODE_SERVER_TOKEN || '';
const STATE_PATH = process.env.ZCODE_RELAY_STATE || '<数据目录>/relay-state.json';
const DEVICE_NAME = process.env.ZCODE_RELAY_DEVICE_NAME || '<部署主机名>';

async function loadOrCreateSession() {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (s.sid && s.hash) return s;
  } catch {}
  const s = { sid: 'd_' + randomBytes(12).toString('base64url'), hash: randomBytes(32).toString('base64') };
  await writeFile(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}
const SESSION = await loadOrCreateSession();
const proof = (nonce, role, sid) =>
  createHmac('sha256', Buffer.from(SESSION.hash, 'utf8')).update(Buffer.from(nonce + '|' + role + '|' + sid, 'utf8')).digest('base64url');

// 每终端状态
const terminals = new Set();

async function serverInfo() {
  const res = await fetch(ZCODE_ORIGIN + '/api/server-info?token=' + encodeURIComponent(ZCODE_SERVER_TOKEN));
  return res.json();
}

// 为一个 bridge 建全新 server host 连接，双向裸透传
async function openHostBridge(ws, bridgeOpenPayload) {
  const host = new WebSocket(ZCODE_HOST_WS + '?token=' + encodeURIComponent(ZCODE_SERVER_TOKEN));
  host.on('open', () => { console.log('[relay-v20] host open for bridge', bridgeOpenPayload.bridgeSessionId);
    // server 主动推的 Initialize 等帧 → 裸透传给页面（rpc-frame 封装）
    // bridge-ready 应答
    ws.send(JSON.stringify({
      type: 'data',
      payload: {
        zcode_type: 'workspace-bridge-ready', requestId: bridgeOpenPayload.requestId,
        bridgeSessionId: bridgeOpenPayload.bridgeSessionId,
        bridgeGeneration: bridgeOpenPayload.bridgeGeneration || 1,
        bridge: {
          bridgeSessionId: bridgeOpenPayload.bridgeSessionId,
          bridgeGeneration: bridgeOpenPayload.bridgeGeneration || 1,
          kind: 'local', workspaceKey: bridgeOpenPayload.workspaceKey || '/', workspacePath: bridgeOpenPayload.workspaceKey || '/',
        },
      }, client_ts: Date.now(),
    }));
  });
  // server → 页面：裸透传（每帧独立 rpc-frame，页面 assembler 自己组）
  let sSeq = 0, sMsg = 0;
  host.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    console.log('[relay-v20] host→page frame', buf.length + 'B');
    sSeq++; sMsg++;
    ws.send(JSON.stringify({
      type: 'data',
      payload: {
        zcode_type: 'rpc-frame', bridgeSessionId: bridgeOpenPayload.bridgeSessionId,
        bridgeGeneration: bridgeOpenPayload.bridgeGeneration || 1,
        seq: sSeq, messageSeq: sMsg, fragmentIndex: 0, fragmentCount: 1,
        messageBytes: buf.length, checksum: { algorithm: 'crc32', value: crc32hex(buf) },
        dataBase64: buf.toString('base64'),
      }, client_ts: Date.now(),
    }));
  });
  host.on('close', (c) => console.log('[relay-v20] host closed', c));
  host.on('error', (e) => console.log('[relay-v20] host error:', e.message));
  // 页面 → server 的透传由 termCtx.host 引用处理
  return host;
}

// CRC32
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32hex = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 255]; return ((c ^ -1) >>> 0).toString(16).padStart(8, '0'); };

const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  let nonce = '', paired = false, host = null, bridgeId = null;
  let tSeq = 0; // 页面→server 帧序（透传计数）
  terminals.add(ws);

  ws.on('message', async (raw) => {
    let f; try { f = JSON.parse(raw.toString()); } catch { return; }
    switch (f.type) {
      case 'auth_init': {
        if (f.role !== 'terminal' || f.device_sid !== SESSION.sid) return ws.close(4004, 'session-not-found');
        nonce = randomBytes(16).toString('base64url');
        ws.send(JSON.stringify({ type: 'auth_challenge', nonce, server_ts: Date.now() }));
        break;
      }
      case 'auth_response': {
        const a = Buffer.from(String(f.proof || '')); const b = Buffer.from(proof(nonce, 'terminal', SESSION.sid));
        if (a.length !== b.length || !timingSafeEqual(a, b)) return ws.close(4013, 'invalid-mobile-connection');
        // 顶号
        for (const t of terminals) { if (t !== ws && t.paired) { try { t.send(JSON.stringify({ type: 'error', code: 'KICKED', message: 'duplicate' })); t.close(4009, 'session-conflict'); } catch {} } }
        ws.paired = true;
        ws.send(JSON.stringify({ type: 'auth_ack', pair_status: 'matched', server_ts: Math.floor(Date.now() / 1000), device_sid: SESSION.sid, terminal_sid: 't_' + randomBytes(12).toString('base64url') }));
        break;
      }
      case 'pair_status_query':
        ws.send(JSON.stringify({ type: 'pair_status_ack', pair_status: paired ? 'matched' : 'waiting', server_ts: Date.now() }));
        break;
      case 'data': {
        if (!ws.paired) return;
        const p = f.payload || {};
        switch (p.zcode_type) {
          case 'bootstrap-request': {
            const info = await serverInfo().catch(() => ({ version: '3.14.3', workspaces: [{ path: '/', label: '/' }] }));
            ws.send(JSON.stringify({ type: 'data', payload: {
              zcode_type: 'bootstrap-response', requestId: p.requestId, success: true,
              result: {
                windowControlSessionId: randomUUID(),
                desktopAppVersion: '3.14.3',
                mobileViewState: { activeWorkspaceKey: '/', updatedAt: Date.now() },
                workspaces: [{ workspaceKey: '/', workspacePath: '/', kind: 'local', taskCount: 0, label: '/', updatedAt: Date.now() }],
                tasks: [],
              },
            }, client_ts: Date.now() }));
            break;
          }
          case 'workspace-list-request': {
            const info = await serverInfo().catch(() => ({ workspaces: [{ path: '/', label: '/' }] }));
            ws.send(JSON.stringify({ type: 'data', payload: {
              zcode_type: 'workspace-list-response', requestId: p.requestId, success: true,
              result: { workspaces: (info.workspaces || []).map(w => ({ workspacePath: w.path, workspaceIdentity: w.workspaceIdentity || w.path, label: w.label || w.path, kind: 'local', connectionState: 'connected' })), tasks: [] },
            }, client_ts: Date.now() }));
            break;
          }
          case 'workspace-bridge-open': {
            if (host) { try { host.close(); } catch {} host = null; }
            host = await openHostBridge(ws, p);
            bridgeId = p.bridgeSessionId;
            break;
          }
          case 'workspace-reconnect-request':
            ws.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'workspace-reconnect-response', requestId: p.requestId, workspaceKey: p.workspaceKey, success: true }, client_ts: Date.now() }));
            break;
          case 'rpc-frame': {
            if (!host) return;
            const chunk = Buffer.from(p.dataBase64, 'base64');
          console.log('[relay-v20] PAGE→SERVER frame hex:', chunk.toString('hex').slice(0, 100));
            host.send(chunk);
            ws.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'rpc-frame-ack', bridgeSessionId: p.bridgeSessionId, ackMessageSeq: p.messageSeq }, client_ts: Date.now() }));
            break;
          }
          case 'platform-request':
            ws.send(JSON.stringify({ type: 'data', payload: { zcode_type: 'platform-response', requestId: p.requestId, method: p.method, success: true, result: null }, client_ts: Date.now() }));
            break;
          // mobile-view-state-update / telemetry-report / mobile-diagnostic / rpc-frame-ack：忽略
        }
        break;
      }
    }
  });
  ws.on('close', () => { terminals.delete(ws); if (host) { try { host.close(); } catch {} } });
  ws.on('error', () => {});
});

server.listen(RELAY_PORT, '127.0.0.1', () => {
  console.log('[relay-v20] listening 127.0.0.1:' + RELAY_PORT);
  console.log('[relay-v20] link: https://zcode.example.com/remote/v4?sid=' + SESSION.sid + '&hash=' + encodeURIComponent(SESSION.hash) + '&t=' + Date.now() + '&mid=<部署主机名>&name=<部署主机名>&app_version=3.14.0');
});
