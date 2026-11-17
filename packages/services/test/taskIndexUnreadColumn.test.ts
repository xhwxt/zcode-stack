/* 未读列持久化回归测试（任务完成未读提示间歇缺失的断点）：
 *
 * 断点：taskIndexRepo.applyAgentPatch（终态迁移写入方，zcodeTaskIndexSyncer 调用）
 * 分配了 unreadAt marker，但 writeRecord 调用没传 writeUnreadAt。writeRecord 的
 * ON CONFLICT 里 unread_at = CASE WHEN @write_unread_at=1 THEN excluded.unread_at
 * ELSE tasks.unread_at —— write=0 时已存在行的 unread_at 保持旧值（NULL），
 * 分配的 marker 只进 meta_json。结果：INSERT 分支（首现即完成）有未读、
 * UPDATE 分支（行已存在）永远没有，即该未读字段间歇缺失的表现。
 *
 * 五条断言分别钉住：
 * ① 已存在行 + 带 unreadAt 的 patch（终态迁移）→ 列落值、水位推进；
 * ② 已存在行 + 不带 unreadAt 的 patch（普通状态同步）→ 列保持不变；
 * ③ 显式 unreadAt: undefined（标为已读）→ 列清空、水位保留（防 marker 复用）；
 * ④ 新插入行（首现即完成）→ 未读列同样正确（对照组）；
 * ⑤ 行缺失 → 终态回源路径（syncSnapshotAndBroadcast + unreadSignal）建行时落列
 *   （buildMetaFromSnapshot 原先不读 unreadSignal，该分支漏落列）。
 *
 * 运行：pnpm --filter @zcode/services exec tsx --test test/taskIndexUnreadColumn.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
  type ZCodeSessionStateSnapshot,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { setDataBaseDir } from "../src/paths.js";

const WS_PATH = "/tmp/workspace-unread-test";
const TASK_ID = "sess-unread-regression";

function baseMeta(overrides?: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: TASK_ID,
    traceId: "trace-unread-regression",
    title: "未读列回归测试任务",
    workspacePath: WS_PATH,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    mode: "build",
    provider: "glm",
    ...overrides,
  };
}

/**
 * 直读 sqlite 列（不是 meta_json）：unread 断言必须针对 UI 实际消费的投影列。
 * getDatabase 是 private（编译期），运行时经桥接访问——与 writeRecord 同一连接，
 * 避免在测试里复刻 SQL 断言自己。
 */
function readRow(
  repo: TaskIndexRepo,
  taskId: string,
): {
  unread_at: number | null;
  last_unread_at: number;
  task_status: string | null;
  title: string;
} {
  type DbLike = {
    prepare(sql: string): {
      get(...args: unknown[]): unknown;
    };
  };
  const db = (repo as unknown as { getDatabase(): DbLike }).getDatabase();
  const row = db
    .prepare(
      "SELECT unread_at, last_unread_at, task_status, title FROM tasks WHERE task_id = ? AND workspace_key = ?",
    )
    .get(taskId, WS_PATH) as
    | { unread_at: number | null; last_unread_at: number; task_status: string | null; title: string }
    | undefined;
  if (!row) {
    throw new Error(`task 行不存在: ${taskId}`);
  }
  return row;
}

test("① 已存在任务行 + 带 unreadAt 的终态 patch → unread_at 落列、水位推进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-col-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    // 行先以 running 状态存在（became-visible / 首标题先于完成落库的正常时序）。
    await repo.syncTaskMeta({ meta: baseMeta({ status: "running" }) });

    const completedAt = 1_700_000_050_000;
    const meta = await repo.applyAgentPatch({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { status: "completed", lastError: undefined, updatedAt: completedAt, unreadAt: completedAt },
    });

    const row = readRow(repo, TASK_ID);
    console.log("① 已存在行终态迁移：", JSON.stringify(row));
    console.log(
      `① unread_at=${String(row.unread_at)} last_unread_at=${row.last_unread_at}（返回 meta.unreadAt=${String(meta.unreadAt)}）`,
    );
    assert.equal(row.task_status, "completed");
    assert.equal(
      typeof row.unread_at,
      "number",
      `已存在行的 unread_at 必须落列，实际=${String(row.unread_at)}`,
    );
    assert.equal(row.unread_at, meta.unreadAt, "列值必须与返回 meta 的 marker 一致");
    assert.ok(
      row.unread_at !== null && row.unread_at > completedAt,
      `marker 必须严格大于请求时间戳（毫秒碰撞递增），实际=${String(row.unread_at)}`,
    );
    assert.ok(
      row.last_unread_at >= (row.unread_at ?? 0),
      `水位必须同步推进到 >= marker，实际 last_unread_at=${row.last_unread_at}`,
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("② 已存在任务行 + 不带 unreadAt 的普通 patch → unread_at 列保持不变", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-col-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta: baseMeta({ status: "completed" }) });
    // 行持有未读 marker 用 updateTaskState（unread 专属写路径）；syncTaskMeta 的
    // INSERT/回源语义本来就不带 unreadAt（回归基线里它也不能带）。
    await repo.updateTaskState({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { unreadAt: 1_700_000_055_000 },
    });
    const seeded = readRow(repo, TASK_ID);
    assert.ok(seeded.unread_at !== null, `前置：先让行持有未读 marker，实际=${String(seeded.unread_at)}`);
    const before = seeded.unread_at;

    // 模拟标题/状态类普通 patch（applyAgentPatch 的其他调用方：title change、
    // session_info_update、task_complete 等都不带 unreadAt）。
    await repo.applyAgentPatch({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { title: "改名后的标题", updatedAt: 1_700_000_060_000 },
    });

    const row = readRow(repo, TASK_ID);
    console.log(
      `② 普通 patch 前后：unread_at ${String(before)} → ${String(row.unread_at)} last_unread_at=${row.last_unread_at}`,
    );
    assert.equal(row.unread_at, before, "不带 unreadAt 的 patch 不得动未读列");
    assert.equal(row.title, "改名后的标题", "patch 的其他字段仍要生效");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("③ 显式 unreadAt: undefined（标为已读）→ 列清空、last_unread_at 水位保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-col-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta: baseMeta({ status: "completed" }) });
    // updateTaskState 是 UI 已读/未读按钮的写入方（writeUnreadAt=mutatingUnreadAt 语义）。
    const marked = await repo.updateTaskState({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { unreadAt: 1_700_000_070_000 },
    });
    assert.ok(marked.unreadAt !== undefined, "前置：先写入未读 marker");

    await repo.updateTaskState({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { unreadAt: undefined },
    });

    const row = readRow(repo, TASK_ID);
    console.log(
      `③ 已读清除后：unread_at=${String(row.unread_at)} last_unread_at=${row.last_unread_at}`,
    );
    assert.equal(row.unread_at, null, "显式清除后列必须为 NULL");
    assert.ok(
      row.last_unread_at >= 1_700_000_070_000,
      `水位必须保留（防下一代 marker 复用旧值被 CAS 误吞），实际=${row.last_unread_at}`,
    );

    // 清除后再来一次同毫秒终态信号：新 marker 必须严格大于旧水位。
    const next = await repo.applyAgentPatch({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { status: "completed", updatedAt: 1_700_000_070_000, unreadAt: 1_700_000_070_000 },
    });
    console.log(`③ 清除后二次完成：新 marker=${String(next.unreadAt)}`);
    assert.ok(
      next.unreadAt !== undefined && next.unreadAt > 1_700_000_070_000,
      `清除后同毫秒信号必须分配更新的 marker，实际=${String(next.unreadAt)}`,
    );
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("④ 新插入任务行首现即完成（INSERT 分支）→ 未读列正确（对照组）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-col-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    // 行不存在，applyAgentPatch 是首次写入（断档后新出现的历史会话收口等场景）。
    const completedAt = 1_700_000_080_000;
    const meta = await repo.applyAgentPatch({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { status: "completed", updatedAt: completedAt, unreadAt: completedAt },
    });
    assert.equal(meta, null, "行不存在时 applyAgentPatch 返回 null（由回源 snapshot 建行）");

    // 回源路径：syncTaskMeta 带上 unreadAt 的 meta（syncer 行缺失时把同一 signal
    // 交给回源结果的既有约定）。
    await repo.syncTaskMeta({ meta: baseMeta({ status: "completed", updatedAt: completedAt, unreadAt: completedAt }) });
    const row = readRow(repo, TASK_ID);
    console.log(
      `④ INSERT 分支：unread_at=${String(row.unread_at)} last_unread_at=${row.last_unread_at} task_status=${row.task_status}`,
    );
    assert.equal(row.task_status, "completed");
    assert.equal(row.unread_at, completedAt, "INSERT 分支必须落列（修前也正确的对照组）");
    assert.equal(row.last_unread_at, completedAt, "INSERT 分支水位同步推进");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- ⑤ 终态回源路径（syncSnapshotAndBroadcast）携带 unreadSignal ----------
 * 生产链路：applyTerminalTransition → applyAgentPatch 行缺失返回 null →
 * resyncTaskIndexRowFromAgent(unreadSignal) → syncSnapshotAndBroadcast(snapshot,
 * { unreadSignal }) → buildMetaFromSnapshot → syncTaskMeta。buildMetaFromSnapshot
 * 原先不读 options.unreadSignal，meta 不带 unreadAt → 回源建行时 unread_at=NULL，
 * "错过广播的客户端重连后仍能看到未读"的承诺在这一分支落空。
 * 本断言复刻 syncer 层调用（不经 repo 手工拼 meta）：未修代码必须在此失败。 */

/** syncer 构造所需的最小 agentService 假件：syncSnapshotAndBroadcast 只用
 * getWorkspaceEmitter（emitter 惰性创建），订阅/readSession 均不触达。 */
function makeSyncerOnlyAgentService(): Record<string, unknown> {
  const disposable = () => ({ dispose() {} });
  return {
    subscribeSessionsIndexV4: async () => ({
      ack: { subscriptionId: "sub", mode: "snapshot" as const, logEpoch: "epoch" },
    }),
    unsubscribeSessionsIndexV4: async () => undefined,
    subscribeWorkspaceConfigV4: async () => ({
      ack: { subscriptionId: "sub-cfg", mode: "snapshot" as const, logEpoch: "epoch" },
    }),
    unsubscribeWorkspaceConfigV4: async () => undefined,
    resyncSessionsIndexV4: async () => ({
      ack: { subscriptionId: "sub", mode: "resume" as const, logEpoch: "epoch" },
    }),
    resyncWorkspaceConfigV4: async () => ({
      ack: { subscriptionId: "sub-cfg", mode: "resume" as const, logEpoch: "epoch" },
    }),
    onDynamicSessionsIndexFrame: () => () => disposable(),
    onDynamicWorkspaceConfigFrame: () => () => disposable(),
    onAgentRuntimeRestarted: () => disposable(),
    onAgentRuntimeLifecycle: () => disposable(),
    readSession: async () => {
      throw new Error("⑤ 断言不应触发 readSession（syncSnapshotAndBroadcast 直接喂 snapshot）");
    },
    disposeAll() {},
  };
}

/** 终态完成的 session snapshot（schema.parse 保证形状与生产一致）。 */
function completedTerminalSnapshot(): ZCodeSessionStateSnapshot {
  const sessionId = TASK_ID;
  return zcodeSessionStateSnapshotSchema.parse({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId,
      workspace: {
        workspacePath: WS_PATH,
        workspaceKey: WS_PATH,
      },
      sessionKind: "interactive",
      title: "回源未读回归任务",
      mode: "build",
      status: "completed",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_090_000,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId,
      status: "completed",
      mode: "build",
      turnCount: 1,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
    messages: [],
  });
}

test("⑤ 行缺失 → 回源路径（syncSnapshotAndBroadcast + unreadSignal）建行时未读落列", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-col-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo();
  const syncer = createZCodeTaskIndexSyncer({
    agentService: makeSyncerOnlyAgentService() as never,
    taskIndexRepo: repo,
  });
  try {
    const snapshot = completedTerminalSnapshot();

    const persisted = await syncer.syncSnapshotAndBroadcast(snapshot, {
      broadcastReason: "task_status_changed",
      unreadSignal: "background_terminal",
    });

    const row = readRow(repo, persisted.taskId);
    console.log(
      `⑤ 回源建行：unread_at=${String(row.unread_at)} last_unread_at=${row.last_unread_at} task_status=${row.task_status}`,
    );
    assert.equal(row.task_status, "completed", "终态快照 → 行状态 completed");
    assert.equal(
      typeof row.unread_at,
      "number",
      `回源建行必须把 unreadSignal 落成 unread_at 列值，实际=${String(row.unread_at)}`,
    );
    assert.equal(row.unread_at, persisted.unreadAt, "列值与返回 meta 的 marker 一致");
    assert.ok(
      row.unread_at !== null && row.unread_at > 0,
      `marker 必须是真实时间戳量级，实际=${String(row.unread_at)}`,
    );
    assert.ok(
      row.last_unread_at >= (row.unread_at ?? 0),
      `水位同步推进：last_unread_at=${row.last_unread_at} >= unread_at=${String(row.unread_at)}`,
    );
  } finally {
    syncer.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
