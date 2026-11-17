/*
 * WS 字节计量台（只读）：以「手机档（replayable）」订阅者的身份打开真实会话，
 * 用 CDP 抓 WebSocket 帧并逐帧归账，回答「手机到底收了多少字节、都是些什么」。
 *
 * 为什么用它：协议帧是二进制 RPC（13 字节头 + JSON body），CLI/服务端都只有调用耗时
 * 遥测、没有字节遥测；nginx/网卡口径又会混进别的东西。只有 CDP 的
 * webSocketFrameReceived 是「手机实际收到的那些帧」的直接证据。
 *
 * 两个口径：
 *  - recv.bytes  = 手机实际收到的全部字节（用户看到的流量）
 *  - uniqueBytes = 按 (topic,toSeq) 去重后「真正不同的内容」字节；
 *    比值 recv/unique 就是**同一条 delta 被重复下发的倍数**（订阅泄漏的直接量化）。
 *
 * 用法：
 *   WS_METER_SID=sess_xxx WS_METER_SECONDS=90 node ws-meter.mjs
 *   WS_METER_NO_OPEN=1        # 不打开会话，只量基线
 *   WS_METER_RECORD_LOAD=1    # 连页面加载期一起录（看订阅是何时建出来的）
 *   WS_METER_DUMP=8           # 打印未归类帧的头 300 字节
 *   WS_METER_OUT=/tmp/x.json  # 明细落盘
 * profile 必须先做副本（Chromium ProcessSingleton 锁），脚本自建 /tmp/ws-meter-profile。
 *
 * 已知读数（线上实测，修复前基线，供对照）：
 *   收 14,053,430 字节 / 90s = 152.5KB/s；controller/tasks-index 占 97%（13.67MB / 14094 帧）
 *   该主题 subscriptions=423、distinctDeltas=34、uniqueBytes=33KB → duplicateFactor 414.5
 * 修复（订阅随连接回收 + 同主题重订阅替换）上线后重跑，
 * duplicateFactor 应≈1、总速率降到 KB/s 量级。
 */
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';

const { chromium } = await import(process.env.WS_METER_PW_CORE ?? 'playwright-core');

const ORIGIN = process.env.WS_METER_ORIGIN ?? 'https://<部署域名>';
const SID = process.env.WS_METER_SID ?? '';
const SECONDS = Number(process.env.WS_METER_SECONDS ?? 90);
const NO_OPEN = process.env.WS_METER_NO_OPEN === '1';
const PROFILE_SRC = process.env.WS_METER_PROFILE_SRC ?? '/tmp/profile-src';
const PROFILE = process.env.WS_METER_PROFILE ?? '/tmp/ws-meter-profile';
const OUT = process.env.WS_METER_OUT ?? '';
const DUMP_N = Number(process.env.WS_METER_DUMP ?? 0);

if (!existsSync(PROFILE_SRC)) {
  console.error(`profile src missing: ${PROFILE_SRC}`);
  process.exit(2);
}
rmSync(PROFILE, { recursive: true, force: true });
cpSync(PROFILE_SRC, PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 帧归类：按 payload 文本里的协议标记判定，逐个 op/用途归账。 */
function classify(text) {
  const has = (s) => text.includes(s);
  if (has('"kind":"snapshot"') && has('/conversation/')) return '会话快照(全量)';
  if (has('"op":"task.upserted"') || has('"op":"task.removed"')) return 'controller/tasks-index(任务行)';
  if (has('"op":"row.delta"')) {
    if (has('"path":"output.text"')) return 'row.delta/output.text(工具输出流)';
    if (has('"path":"inputText"')) return 'row.delta/inputText';
    if (has('"path":"summaryText"')) return 'row.delta/summaryText';
    return 'row.delta/text(正文流)';
  }
  if (has('"op":"row.upserted"')) {
    if (has('"outputPreview"')) return 'row.upserted/toolProgress(带预览整行)';
    if (has('"kind":"toolCall"')) return 'row.upserted/toolCall(工具行终态)';
    return 'row.upserted/其他';
  }
  if (has('"op":"row.appended"')) {
    if (has('"kind":"toolCall"')) return 'row.appended/toolCall(新工具行)';
    if (has('"kind":"assistantText"')) return 'row.appended/assistantText';
    return 'row.appended/其他';
  }
  if (has('"op":"state.updated"')) return 'state.updated(状态补丁)';
  if (has('"op":"row.removed"')) return 'row.removed';
  if (has('"kind":"snapshot"')) return '快照(其他主题)';
  if (has('workflowRun.')) return 'workflowRun.*';
  if (has('/sessions-index')) return 'sessions-index(会话列表)';
  if (has('/workspace-config')) return 'workspace-config';
  return '其他';
}

/** 抽 topic/订阅号/水位，用于「同一条 delta 被下发几次」的去重口径。 */
function extractFrame(text) {
  const start = text.indexOf('{"topic"');
  if (start < 0) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj.topic !== 'string') return null;
  return {
    topic: obj.topic,
    subscriptionId: typeof obj.subscriptionId === 'string' ? obj.subscriptionId : null,
    toSeq: typeof obj.toSeq === 'number' ? obj.toSeq : null,
  };
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  executablePath: process.env.WS_METER_CHROME ?? undefined,
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  locale: 'zh-CN',
  serviceWorkers: 'block',
  args: ['--no-sandbox', '--lang=zh-CN', '--disable-http-cache', '--disk-cache-size=1'],
});
const page = context.pages()[0] ?? (await context.newPage());

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');

const buckets = new Map(); // class -> {frames, bytes}
const topicStats = new Map(); // topic -> {frames, bytes, subs:Set, deltas:Set, uniqueBytes}
const conns = new Map(); // requestId -> frames
const rawDumps = [];
const samples = [];
let recvFrames = 0;
let recvBytes = 0;
let sentFrames = 0;
let sentBytes = 0;
let recording = false;
let startedAt = 0;
const subFirstSeen = new Map(); // subscriptionId -> ms since start
const timeBuckets = []; // {t, frames, bytes, newSubs}

cdp.on('Network.webSocketCreated', (e) => conns.set(e.requestId, 0));

cdp.on('Network.webSocketFrameReceived', (e) => {
  if (!recording) return;
  const payload = e.response?.payloadData ?? '';
  const isBinary = e.response?.opcode === 2;
  const buf = isBinary ? Buffer.from(payload, 'base64') : Buffer.from(payload, 'utf8');
  recvFrames += 1;
  recvBytes += buf.byteLength;
  conns.set(e.requestId, (conns.get(e.requestId) ?? 0) + 1);
  const text = buf.toString('utf8');
  const cls = classify(text);
  const b = buckets.get(cls) ?? { frames: 0, bytes: 0 };
  b.frames += 1;
  b.bytes += buf.byteLength;
  buckets.set(cls, b);

  if (startedAt) {
    const slot = Math.floor((Date.now() - startedAt) / 5000);
    const bucket = timeBuckets[slot] ?? { t: slot * 5, frames: 0, bytes: 0, newSubs: 0 };
    bucket.frames += 1;
    bucket.bytes += buf.byteLength;
    bucket.newSubs = subFirstSeen.size;
    timeBuckets[slot] = bucket;
  }
  const meta = extractFrame(text);
  if (meta) {
    const t = topicStats.get(meta.topic) ?? {
      frames: 0,
      bytes: 0,
      subs: new Set(),
      deltas: new Map(),
    };
    t.frames += 1;
    t.bytes += buf.byteLength;
    if (meta.subscriptionId) {
      t.subs.add(meta.subscriptionId);
      if (!subFirstSeen.has(meta.subscriptionId)) {
        subFirstSeen.set(meta.subscriptionId, Date.now() - startedAt);
      }
    }
    if (meta.toSeq !== null) {
      const key = `${meta.toSeq}`;
      if (!t.deltas.has(key)) t.deltas.set(key, buf.byteLength);
    }
    topicStats.set(meta.topic, t);
  } else if (cls === '其他' && rawDumps.length < DUMP_N) {
    rawDumps.push({
      bytes: buf.byteLength,
      head: buf.subarray(0, 300).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
    });
  }
  if (buf.byteLength > 4096 && samples.length < 30) {
    samples.push({
      bytes: buf.byteLength,
      cls,
      topic: meta?.topic ?? null,
      sub: meta?.subscriptionId ?? null,
      toSeq: meta?.toSeq ?? null,
    });
  }
});

cdp.on('Network.webSocketFrameSent', (e) => {
  if (!recording) return;
  const payload = e.response?.payloadData ?? '';
  const isBinary = e.response?.opcode === 2;
  sentFrames += 1;
  sentBytes += isBinary
    ? Buffer.from(payload, 'base64').byteLength
    : Buffer.byteLength(payload, 'utf8');
});
cdp.on('Network.webSocketClosed', () => {});

async function gotoApp() {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();
    const keys = await caches.keys();
    for (const key of keys) await caches.delete(key);
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
}

async function openSession(sid) {
  await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="切换侧边栏"]');
    if (b) b.click();
  });
  await sleep(1200);
  for (let i = 0; i < 20; i += 1) {
    const ok = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="task-item-${id}"]`);
      if (el) {
        el.click();
        return true;
      }
      return false;
    }, sid);
    if (ok) return true;
    await page.evaluate(() => {
      const list = Array.from(document.querySelectorAll('div')).find((d) =>
        /(auto|scroll)/.test(getComputedStyle(d).overflowY),
      );
      if (list) list.scrollTop = list.scrollHeight;
    });
    await sleep(700);
  }
  return false;
}

const report = () => {
  const elapsed = (Date.now() - startedAt) / 1000;
  const rows = [...buckets.entries()]
    .map(([cls, v]) => ({ cls, ...v, kbPerSec: +(v.bytes / 1024 / elapsed).toFixed(1) }))
    .sort((a, b) => b.bytes - a.bytes);
  const topics = [...topicStats.entries()]
    .map(([topic, v]) => {
      const uniqueBytes = [...v.deltas.values()].reduce((a, b) => a + b, 0);
      return {
        topic,
        frames: v.frames,
        bytes: v.bytes,
        subscriptions: v.subs.size,
        distinctDeltas: v.deltas.size,
        uniqueBytes,
        duplicateFactor: uniqueBytes > 0 ? +(v.bytes / uniqueBytes).toFixed(2) : null,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
  const uniqueTotal = topics.reduce((a, t) => a + t.uniqueBytes, 0);
  const out = {
    origin: ORIGIN,
    sessionId: SID || null,
    opened: !NO_OPEN,
    seconds: +elapsed.toFixed(1),
    connections: [...conns.values()],
    recv: {
      frames: recvFrames,
      bytes: recvBytes,
      kbPerSec: +(recvBytes / 1024 / elapsed).toFixed(1),
    },
    dedup: {
      uniqueTopicBytes: uniqueTotal,
      duplicateFactor: uniqueTotal > 0 ? +(recvBytes / uniqueTotal).toFixed(2) : null,
    },
    sent: { frames: sentFrames, bytes: sentBytes },
    byClass: rows,
    byTopic: topics,
    subscriptionTimeline: {
      total: subFirstSeen.size,
      firstSeenMs: [...subFirstSeen.values()].sort((a, b) => a - b).slice(0, 600),
    },
    timeBuckets: timeBuckets.filter(Boolean),
    samples,
    rawDumps,
  };
  console.log(JSON.stringify(out, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
};

const RECORD_LOAD = process.env.WS_METER_RECORD_LOAD === '1';
if (RECORD_LOAD) {
  recording = true;
  startedAt = Date.now();
}
await gotoApp();
if (!NO_OPEN && SID) {
  const opened = await openSession(SID);
  console.log(`# openSession(${SID}) => ${opened}`);
  await sleep(1500);
}
if (!recording) {
  recording = true;
  startedAt = Date.now();
}
console.log(`# recording ${SECONDS}s ...`);
await sleep(SECONDS * 1000);
recording = false;
report();
await context.close();
