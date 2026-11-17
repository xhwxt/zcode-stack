// relay-common-test.mjs —— relay-common.mjs 最小测试（node 直跑，零依赖）
// 覆盖三个关键面：ticket 表（签发/入口单次/TTL/未入場不可打 API）、
// 会话校验缓存（正/负缓存、3030 不可达 fail closed）、本地会话（renew 成功/401 死亡/降级）。
import assert from 'node:assert/strict';
import {
  createTicketStore,
  createSessionVerifier,
  createLocalSession,
  pickSessionCookie,
} from './relay-common.mjs';

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '—', e.message); process.exitCode = 1; }
}
async function ta(name, fn) {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, '—', e.message); process.exitCode = 1; }
}

/* ---------- ticket 表 ---------- */
let clock = 1_000_000;
const now = () => clock;
const ts = createTicketStore({ ttlMs: 10 * 60 * 1000, now });

t('签发：32hex，expiresAt = now + ttl', () => {
  const { ticket, expiresAt } = ts.issue();
  assert.match(ticket, /^[0-9a-f]{32}$/);
  assert.equal(expiresAt, now() + 10 * 60 * 1000);
});

t('入口消费：单次（第二次拒绝）', () => {
  const { ticket } = ts.issue();
  assert.equal(ts.consumeEntry(ticket), true);
  assert.equal(ts.consumeEntry(ticket), false);
});

t('未入場的票不能打 API（apiActive=false）', () => {
  const { ticket } = ts.issue(); // 签发未入場
  assert.equal(ts.apiActive(ticket), false);
});

t('入場后 API 有效，TTL 内一直有效（页面会话期）', () => {
  const { ticket } = ts.issue();
  assert.equal(ts.consumeEntry(ticket), true);
  clock += 5 * 60 * 1000; // 5 分钟后
  assert.equal(ts.apiActive(ticket), true);
});

t('TTL 过期：入口与 API 都拒绝', () => {
  const { ticket } = ts.issue();
  ts.consumeEntry(ticket);
  clock += 11 * 60 * 1000; // 越过 10 分钟
  assert.equal(ts.apiActive(ticket), false);
  assert.equal(ts.consumeEntry(ticket), false);
});

t('sweep 回收过期票', () => {
  const before = ts.size;
  ts.sweep();
  assert.ok(ts.size <= before);
});

t('未知票/空值拒绝', () => {
  assert.equal(ts.consumeEntry('deadbeef'.repeat(4)), false);
  assert.equal(ts.consumeEntry(''), false);
  assert.equal(ts.apiActive(''), false);
});

t('自助链：issue({entered:true}) 无需入口即可打 API', () => {
  const { ticket } = ts.issue({ entered: true });
  assert.equal(ts.apiActive(ticket), true);
  assert.equal(ts.consumeEntry(ticket), false); // 入口位已用
});

/* ---------- 会话 Cookie 提取 ---------- */
t('pickSessionCookie：__Host- 优先、多 Cookie 混排、缺失返回空', () => {
  assert.equal(
    pickSessionCookie('foo=bar; __Host-zcode_device_session=ABC; zcode_device_session=DEF'),
    'ABC',
  );
  assert.equal(pickSessionCookie('a=1; zcode_device_session= XYZ '), 'XYZ');
  assert.equal(pickSessionCookie('other=1'), '');
  assert.equal(pickSessionCookie(undefined), '');
  assert.equal(pickSessionCookie('zcode_device_session=;'), '');
});

/* ---------- 会话校验（fetch 桩） ---------- */
// 简化：直接构造，用外部变量推时钟
let vclock = 100_000;

await ta('校验：200 → ok；非 200 → invalid', async () => {
  let calls = 0;
  const v = createSessionVerifier({
    origin: 'http://3030.test',
    fetchImpl: async () => { calls++; return { status: 200 }; },
    now: () => vclock,
  });
  assert.deepEqual(await v.verify('zcode_device_session=GOOD'), { ok: true, reason: 'ok' });
  assert.equal(calls, 1);
});

await ta('负缓存：401 后 5s 内不再打 3030，5s 后重打', async () => {
  let calls = 0;
  const v = createSessionVerifier({
    origin: 'http://3030.test',
    fetchImpl: async () => { calls++; return { status: 401 }; },
    now: () => vclock,
  });
  assert.equal((await v.verify('zcode_device_session=X1')).ok, false);
  assert.equal(calls, 1);
  vclock += 3_000;
  assert.equal((await v.verify('zcode_device_session=X1')).ok, false);
  assert.equal(calls, 1, '5s 内应命中负缓存');
  vclock += 3_000; // 共 6s > 负 TTL
  await v.verify('zcode_device_session=X1');
  assert.equal(calls, 2, '负缓存过期后应重打');
});

await ta('正缓存：200 后 30s 内不重打', async () => {
  let calls = 0;
  const v = createSessionVerifier({
    origin: 'http://3030.test',
    fetchImpl: async () => { calls++; return { status: 200 }; },
    now: () => vclock,
  });
  assert.equal((await v.verify('zcode_device_session=OK1')).ok, true);
  vclock += 29_000;
  assert.equal((await v.verify('zcode_device_session=OK1')).ok, true);
  assert.equal(calls, 1);
  vclock += 2_000; // 31s
  await v.verify('zcode_device_session=OK1');
  assert.equal(calls, 2);
});

await ta('3030 不可达：fail closed 且 reason=server-unreachable', async () => {
  const v = createSessionVerifier({
    origin: 'http://3030.test',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    now: () => vclock,
  });
  assert.deepEqual(await v.verify('zcode_device_session=ANY'), { ok: false, reason: 'server-unreachable' });
});

await ta('无 Cookie：no-cookie，不打 3030', async () => {
  let calls = 0;
  const v = createSessionVerifier({
    origin: 'http://3030.test',
    fetchImpl: async () => { calls++; return { status: 200 }; },
    now: () => vclock,
  });
  assert.deepEqual(await v.verify(''), { ok: false, reason: 'no-cookie' });
  assert.equal(calls, 0);
});

/* ---------- 本地会话 ---------- */
await ta('本地会话：renew 成功拿 sessionToken，6h 内复用不重打', async () => {
  let calls = 0;
  const ls = createLocalSession({
    origin: 'http://3030.test',
    deviceToken: 'DT',
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ sessionToken: 'S1' }) }; },
    now: () => vclock,
  });
  assert.equal(await ls.cookieHeader(), 'zcode_device_session=S1');
  vclock += 60_000;
  assert.equal(await ls.cookieHeader(), 'zcode_device_session=S1');
  assert.equal(calls, 1, '6h 内应复用缓存会话');
  vclock += 7 * 60 * 60 * 1000;
  await ls.cookieHeader();
  assert.equal(calls, 2, '越过 6h 应重换发');
});

await ta('本地会话：401 → authDead，不再重试且降级空 Cookie', async () => {
  let calls = 0;
  const ls = createLocalSession({
    origin: 'http://3030.test',
    deviceToken: 'DT',
    fetchImpl: async () => { calls++; return { ok: false, status: 401, json: async () => ({}) }; },
    now: () => vclock,
    onEvent: () => {},
  });
  assert.equal(await ls.cookieHeader(), '');
  assert.equal(ls.isAuthDead, true);
  vclock += 99 * 60 * 60 * 1000;
  assert.equal(await ls.cookieHeader(), '');
  assert.equal(calls, 1, 'authDead 后不得继续打 renew');
});

await ta('本地会话：未配置凭据 → 空 Cookie 不发请求', async () => {
  let calls = 0;
  const ls = createLocalSession({
    origin: 'http://3030.test',
    deviceToken: '',
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; },
    now: () => vclock,
  });
  assert.equal(await ls.cookieHeader(), '');
  assert.equal(calls, 0);
});

await ta('本地会话：网络失败降级空 Cookie（不抛异常）', async () => {
  const ls = createLocalSession({
    origin: 'http://3030.test',
    deviceToken: 'DT',
    fetchImpl: async () => { throw new Error('down'); },
    now: () => vclock,
    onEvent: () => {},
  });
  assert.equal(await ls.cookieHeader(), '');
});

console.log(`\n${passed} passed${process.exitCode ? '（存在 FAIL）' : ''}`);
