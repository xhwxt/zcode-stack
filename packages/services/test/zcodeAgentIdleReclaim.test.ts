/* 空闲回收控制面语义测试：
 * 1) countPendingInteractionEntries 按 workspaceKey 前缀统计挂起交互（权限/输入）；
 * 2) ZCodeAgentProcessManager.scheduleIdleReclaim 到点回收空闲进程
 *   （真实 spawn 常驻子进程 + 短 idleTimeoutMs）。
 * 运行：pnpm --filter @zcode/services exec tsx --test test/zcodeAgentIdleReclaim.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import test from "node:test";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";
import {
  countPendingInteractionEntries,
  pendingInteractionKeyFromResolvedEvent,
} from "../src/zcode-agent/zcodeAgentService.js";

const WS_A = "/tmp/workspace-a";
const WS_B = "/tmp/workspace-ab";
// 真实 spawn 以 workspacePath 作 cwd：目录缺失子进程起不来（/tmp 会被清理），测试自足建目录。
mkdirSync(WS_A, { recursive: true });
mkdirSync(WS_B, { recursive: true });

/* ---------- countPendingInteractionEntries ---------- */

test("countPendingInteractionEntries counts only entries under the workspace prefix", () => {
  const entries: Array<[string, "permission" | "userInput"]> = [
    [`${WS_A}\u0000session-1\u0000req-1`, "permission"],
    [`${WS_A}\u0000session-1\u0000req-2`, "permission"],
    [`${WS_A}\u0000session-2\u0000req-3`, "userInput"],
    [`${WS_B}\u0000session-9\u0000req-4`, "permission"], // 前缀恰好多一位，不得误配
  ];
  const counts = countPendingInteractionEntries(entries, WS_A);
  assert.deepEqual(counts, { permissionCount: 2, userInputCount: 1 });
});

test("countPendingInteractionEntries distinguishes workspace prefixes that are prefixes of each other", () => {
  const entries: Array<[string, "permission" | "userInput"]> = [
    [`${WS_A}\u0000s\u0000r1`, "permission"],
    [`${WS_B}\u0000s\u0000r2`, "permission"],
  ];
  assert.deepEqual(countPendingInteractionEntries(entries, WS_A), {
    permissionCount: 1,
    userInputCount: 0,
  });
  assert.deepEqual(countPendingInteractionEntries(entries, WS_B), {
    permissionCount: 1,
    userInputCount: 0,
  });
});

test("countPendingInteractionEntries returns zeros for unknown workspace", () => {
  const entries: Array<[string, "permission" | "userInput"]> = [
    [`${WS_A}\u0000s\u0000r1`, "permission"],
  ];
  assert.deepEqual(countPendingInteractionEntries(entries, "/other"), {
    permissionCount: 0,
    userInputCount: 0,
  });
});

test("countPendingInteractionEntries handles empty input", () => {
  assert.deepEqual(countPendingInteractionEntries([], WS_A), {
    permissionCount: 0,
    userInputCount: 0,
  });
});

/* ---------- scheduleIdleReclaim 的挂起 interaction 判定 ----------
 * 用真实 spawn：commandResolver 产出 node 常驻脚本（模拟 agent 不退出），
 * idleTimeoutMs 用 80ms 观察窗口。回收与否以 dispose 后进程是否被 kill 判定
 * 不可行（挂起场景我们不能 dispose），改为观测 onRuntimeLifecycle unavailable
 * 是否在窗口内到达：回收必然先 fire unavailable（reportRuntimeUnavailable 在
 * cleanup 之前）。
 */

/** 常驻子脚本：启动即发一帧 storage ready（触发 host 侧 publishStorage 排 idle 计时），
 * 之后静默存活、忽略 stdin（永不响应请求，保证没有 drain 事件干扰）。
 * 用数组 join 避免 -e 模板串里的转义坑；帧尾换行用 fromCharCode(10)。 */
const RESIDENT_SCRIPT = [
  "const frame = {",
  '  method: "startup/storageState",',
  "  params: {",
  "    schemaVersion: 1,",
  '    attemptId: "attempt-test",',
  "    sequence: 1,",
  '    databaseId: "db-test",',
  '    databaseKind: "session",',
  '    phase: "ready",',
  "    elapsedMs: 1,",
  "  },",
  "};",
  "process.stdout.write(JSON.stringify(frame) + String.fromCharCode(10));",
  "process.stdin.resume();",
  "setInterval(() => {}, 1000);",
].join("\n");

interface SpawnedManager {
  manager: ZCodeAgentProcessManager;
  waitAvailable: Promise<void>;
  dispose: () => Promise<void>;
}

function spawnResidentAgent(options: {
  idleTimeoutMs: number;
  workspacePath: string;
}): SpawnedManager {
  const manager = new ZCodeAgentProcessManager({
    commandResolver: () => ({
      command: process.execPath,
      args: ["-e", RESIDENT_SCRIPT],
      cwd: options.workspacePath,
    }),
    idleTimeoutMs: options.idleTimeoutMs,
  });
  let resolveAvailable!: () => void;
  const waitAvailable = new Promise<void>((resolve) => {
    resolveAvailable = resolve;
  });
  manager.onRuntimeLifecycle((event) => {
    if (event.state === "available") resolveAvailable();
  });
  let cleanup: Promise<void> | null = null;
  return {
    manager,
    waitAvailable,
    dispose: () => {
      cleanup ??= manager.disposeAllAndWait();
      return cleanup;
    },
  };
}

test("idle reclaim reclaims an idle workspace", async () => {
  const spawned = spawnResidentAgent({
    idleTimeoutMs: 80,
    workspacePath: WS_A,
  });
  const { manager, waitAvailable, dispose } = spawned;
  let unavailable = false;
  manager.onRuntimeLifecycle((event) => {
    if (event.state === "unavailable") unavailable = true;
  });
  const client = await manager.getClient({ workspacePath: WS_A });
  await waitAvailable;
  // storage gate：supportsStorageStartup 未声明时不等待（requireStorageStartup=false），
  // publishStorage 首次回调即满足"ready && 0 in-flight"→ 排 idle 计时；80ms 后应回收。
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(unavailable, true, "idle reclaim fires unavailable");
  assert.equal(client.isDisposed, true);
  await dispose();
});

/* ---------- resolved 事件删除挂起条目 ----------
 * createZCodeAgentService 依赖真实子进程，无法整体实例化；登记 key 构造已提为
 * 纯函数 pendingInteractionKeyFromResolvedEvent（与生产 handleSessionEvent 同一实现），
 * 这里验证 key 与登记侧（permissionRequestKey 同源前缀）双向对齐 + 删除语义。
 */
test("resolved 事件的登记 key 与 permissionRequestKey 同源（roundtrip 删除）", () => {
  const workspace = { workspacePath: WS_A };
  const sessionId = "sess-pending";
  const requestId = "req-pending";
  // resolved 事件 → key（新函数）。
  const resolved = pendingInteractionKeyFromResolvedEvent(workspace, {
    type: "permission.resolved",
    sessionId,
    payload: { requestId, toolCallId: "tc1", toolName: "Bash", decision: "allow" },
  });
  assert.ok(resolved, "带 requestId 的 resolved 事件必须产出 key");
  assert.equal(resolved.map, "permission");
  // 登记侧：反向请求登记用的 key（与 host zcodeAgentService 内 permissionRequestKey 同构）。
  const registeredKey = `${WS_A}\u0000${sessionId}\u0000${requestId}`;
  assert.equal(resolved.key, registeredKey, "resolved 提取的 key 必须命中登记 key");
  // Map 语义验证：登记 → resolved → 删除命中。
  const pendingPermissions = new Map<string, unknown>();
  pendingPermissions.set(registeredKey, { client: {}, protocolRequestId: 1 });
  const resolvedAgain = pendingInteractionKeyFromResolvedEvent(workspace, {
    type: "permission.resolved",
    sessionId,
    payload: { requestId, toolCallId: "tc1", toolName: "Bash", decision: "allow" },
  });
  assert.equal(pendingPermissions.delete(resolvedAgain!.key), true, "resolved 后挂起条目必须被删除");
  assert.equal(pendingPermissions.size, 0);
  // userInput 同构。
  const userInputResolved = pendingInteractionKeyFromResolvedEvent(workspace, {
    type: "userInput.resolved",
    sessionId,
    payload: { requestId, value: {} },
  });
  assert.ok(userInputResolved);
  assert.equal(userInputResolved.map, "userInput");
  assert.equal(userInputResolved.key, registeredKey);
});

test("resolved 事件缺 requestId 时保守不动表（返回 null）", () => {
  const workspace = { workspacePath: WS_A };
  // permission.resolved 的 requestId 是 optional；缺省时不能瞎删。
  const noId = pendingInteractionKeyFromResolvedEvent(workspace, {
    type: "permission.resolved",
    sessionId: "sess-pending",
    payload: { toolCallId: "tc1", decision: "deny" },
  });
  assert.equal(noId, null, "缺 requestId 必须返回 null（保守口径）");
  // 非目标类型一律 null。
  const wrongType = pendingInteractionKeyFromResolvedEvent(workspace, {
    type: "userInput.resolved",
    sessionId: "sess-pending",
    payload: { toolCallId: "tc1", decision: "deny" },
  });
  assert.equal(wrongType, null, "userInput.resolved 的 payload 无 requestId 字段解析不到 → null");
});
