/* 回合开始 running 落库回归测试（probe "运行中 N" 滞后到下一次快照回源才反映的断点）：
 *
 * 断点：sessions-index delta（回合开始的第一现场，毫秒级到达）此前只被
 * zcodeTaskIndexSyncer.processSummary 用于内存 running 计数，不写 task index
 * sqlite；task_status 的 running 只能靠 resume/setModel 等生命周期 op 的快照回源
 * 带入。表现：手机探针的"运行中 N"在 turn 开始后不涨，直到某次快照回源才修正。
 *
 * 修复：processSummary 的 running 差量分支（非运行 → 运行、基线已建立）追加一次
 * applyAgentPatch({ status: "running", updatedAt: 摘要活动时刻 })。三条断言分别钉住：
 * ① 回合开始差量 → sqlite task_status 落 running（updatedAt 取摘要活动时刻）；
 * ② 行已收敛 completed 后收到迟到的 running 差量 → 保持 completed（终态保护；
 *    updatedAt 用摘要活动时刻而非 Date.now()，迟到差量的活动时刻早于完成写入）；
 * ③ 行不存在 → 跳过不抛错（建行由 becameVisibleTask 回源路径负责）。
 *
 * 运行：pnpm --filter @zcode/services exec tsx --test test/taskIndexRunningStart.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  V4_WIRE_PROTOCOL_VERSION,
  sessionsIndexTopic,
} from "@zcode/shared/zcode-protocol-v4";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { setDataBaseDir } from "../src/paths.js";

const WS_PATH = "/tmp/workspace-running-start-test";
const TASK_ID = "sess-running-start-regression";

/** 直读 sqlite 列：running 断言必须针对 probe 实际消费的投影列（task_status）。 */
function readRow(
  repo: TaskIndexRepo,
  taskId: string,
): { task_status: string | null; updated_at: number } {
  type DbLike = {
    prepare(sql: string): {
      get(...args: unknown[]): unknown;
    };
  };
  const db = (repo as unknown as { getDatabase(): DbLike }).getDatabase();
  const row = db
    .prepare("SELECT task_status, updated_at FROM tasks WHERE task_id = ? AND workspace_key = ?")
    .get(taskId, WS_PATH) as { task_status: string | null; updated_at: number } | undefined;
  if (!row) {
    throw new Error(`task 行不存在: ${taskId}`);
  }
  return row;
}

/** 轮询等待行达到期望状态：写链是 fire-and-forget patch + 惰性打开 sqlite，
 * 固定 sleep 在负载下不够时 readRow 会扑到尚未初始化的 DB（多文件同跑实测竞态）。 */
async function waitForRow(
  repo: TaskIndexRepo,
  taskId: string,
  predicate: (row: { task_status: string | null; updated_at: number }) => boolean,
  timeoutMs = 3_000,
): Promise<{ task_status: string | null; updated_at: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const row = readRow(repo, taskId);
      if (predicate(row)) return row;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForRow 超时：${taskId} 未在 ${timeoutMs}ms 内达到期望状态`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function summary(overrides?: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: TASK_ID,
    workspaceId: WS_PATH,
    title: "回合开始运行态回归任务",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** syncer 构造所需的最小 agentService 假件：runtime 立即可用（lifecycle 先 fire
 * available，订阅真正建立），帧由测试经 onDynamicSessionsIndexFrame 暴露的发射器手工驱动。 */
function makeSilentAgentService(): {
  service: Record<string, unknown>;
  fireIndexFrame: (frame: unknown) => void;
} {
  const disposable = () => ({ dispose() {} });
  let indexFrameListener: ((frame: unknown) => void) | null = null;
  const service = {
    subscribeSessionsIndexV4: async () => ({
      ack: { subscriptionId: "sub-idx", mode: "snapshot" as const, logEpoch: "epoch-test" },
    }),
    unsubscribeSessionsIndexV4: async () => undefined,
    subscribeWorkspaceConfigV4: async () => ({
      ack: { subscriptionId: "sub-cfg", mode: "snapshot" as const, logEpoch: "epoch-test" },
    }),
    unsubscribeWorkspaceConfigV4: async () => undefined,
    resyncSessionsIndexV4: async () => ({
      ack: { subscriptionId: "sub-idx", mode: "resume" as const, logEpoch: "epoch-test" },
    }),
    resyncWorkspaceConfigV4: async () => ({
      ack: { subscriptionId: "sub-cfg", mode: "resume" as const, logEpoch: "epoch-test" },
    }),
    onDynamicSessionsIndexFrame: () => (listener: (frame: unknown) => void) => {
      indexFrameListener = listener;
      return disposable();
    },
    onDynamicWorkspaceConfigFrame: () => () => disposable(),
    onAgentRuntimeRestarted: () => disposable(),
    onAgentRuntimeLifecycle: (listener: (event: unknown) => void) => {
      // runtime 立即可用：syncer 只有在收到 available 后才会建立订阅（dormant 占位
      // 不订阅）；监听安装与 fire 同步完成，ensureWorkspaceSubscription 在此之后调用。
      listener({
        workspacePath: WS_PATH,
        workspaceKey: WS_PATH,
        runtimeIdentity: { generation: 1, identity: "runtime-test" },
        state: "available",
      });
      return disposable();
    },
    readSession: async () => {
      throw new Error("断言不应触发 readSession（行存在，走 patch 路径）");
    },
    disposeAll() {},
  };
  return {
    service,
    fireIndexFrame: (frame: unknown) => {
      if (!indexFrameListener) {
        throw new Error("index 帧监听器尚未安装");
      }
      indexFrameListener(frame);
    },
  };
}

/** 构造一帧完整的 sessions-index snapshot（首帧 = 静默基线，建立 seeded 基线与
 * 帧水位；基线里会话处于指定 phase，行由 seedTaskMetaIfMissing 原子补齐）。 */
function snapshotFrame(session: SessionSummary, frameTopic: string): unknown {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: "initial",
    logicalFrameId: "logical-baseline",
    logicalFrameOrdinal: 1,
    topic: frameTopic,
    subscriptionId: "sub-idx",
    frame: {
      topic: frameTopic,
      subscriptionId: "sub-idx",
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1_700_000_000_000,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: WS_PATH,
          logEpoch: "epoch-test",
          sessions: [session],
        },
      },
    },
  };
}

/** 构造一帧 online deltas（回合开始 = 基线之后的 session.upserted 差量）。 */
function deltasFrame(
  session: SessionSummary,
  frameTopic: string,
  seq: number,
): unknown {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: `logical-${seq}`,
    logicalFrameOrdinal: seq + 1,
    topic: frameTopic,
    subscriptionId: "sub-idx",
    frame: {
      topic: frameTopic,
      subscriptionId: "sub-idx",
      fromSeq: seq,
      toSeq: seq + 1,
      sentAt: session.lastActivityAt,
      payload: {
        kind: "deltas",
        deltas: [{ op: "session.upserted", session }],
      },
    },
  };
}

test("① 基线完成 → 回合开始差量（running）→ sqlite 落 running、updatedAt 取摘要活动时刻", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-running-start-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo();
  const { service, fireIndexFrame } = makeSilentAgentService();
  const syncer = createZCodeTaskIndexSyncer({
    agentService: service as never,
    taskIndexRepo: repo,
  });
  try {
    syncer.ensureWorkspaceSubscription({ workspacePath: WS_PATH });
    const topic = sessionsIndexTopic(WS_PATH);
    const baselineAt = 1_700_000_010_000;
    // 首帧静默基线：会话处于完成态，行被原子补齐（seedTaskMetaIfMissing）。
    fireIndexFrame(snapshotFrame(summary({ lastActivityAt: baselineAt }), topic));
    // 等待基线补齐写链与订阅激活落定（轮询等待，固定 sleep 在负载下有竞态）。
    const seeded = await waitForRow(repo, TASK_ID, () => true);
    assert.equal(seeded.task_status, "completed", "前置：基线行处于完成态");

    // 回合开始：phase 完成 → running，活动时刻晚于基线。
    const turnStartedAt = 1_700_000_020_000;
    fireIndexFrame(
      deltasFrame(
        summary({ phase: "running", sessionEnded: false, lastActivityAt: turnStartedAt }),
        topic,
        1,
      ),
    );
    const row = await waitForRow(repo, TASK_ID, (r) => r.task_status === "running");
    console.log(
      `① 回合开始落库：task_status=${row.task_status} updated_at=${row.updated_at}（摘要活动时刻=${turnStartedAt}）`,
    );
    assert.equal(row.task_status, "running", "回合开始差量必须把 task_status 落成 running");
    assert.equal(
      row.updated_at,
      turnStartedAt,
      "updatedAt 必须取摘要活动时刻（时间戳保护的事实基础），不能用本机时间",
    );
  } finally {
    syncer.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("② 已 completed 的行收到迟到的 running 差量 → 保持 completed（终态保护）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-running-late-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo();
  const { service, fireIndexFrame } = makeSilentAgentService();
  const syncer = createZCodeTaskIndexSyncer({
    agentService: service as never,
    taskIndexRepo: repo,
  });
  try {
    syncer.ensureWorkspaceSubscription({ workspacePath: WS_PATH });
    const topic = sessionsIndexTopic(WS_PATH);
    // 基线即完成态（completedAt 为完成收敛时刻）。
    const completedAt = 1_700_000_030_000;
    fireIndexFrame(
      snapshotFrame(summary({ lastActivityAt: completedAt }), topic),
    );
    // 基线只补缺失行，完成态列以快照回源写入对齐真实生产时序：
    // applyTerminalTransition 在真实链路写终态列；测试直接用同入口写入。
    await repo.applyAgentPatch({
      workspacePath: WS_PATH,
      taskId: TASK_ID,
      patch: { status: "completed", lastError: undefined, updatedAt: completedAt },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readRow(repo, TASK_ID).task_status, "completed", "前置：行已收敛 completed");

    // 迟到的 running 差量：活动时刻早于完成写入（快照重放/断档恢复的典型形状）。
    const staleRunningAt = 1_700_000_025_000;
    fireIndexFrame(
      deltasFrame(
        summary({ phase: "running", sessionEnded: false, lastActivityAt: staleRunningAt }),
        topic,
        1,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const row = readRow(repo, TASK_ID);
    console.log(
      `② 迟到 running 差量：task_status=${row.task_status}（差量活动时刻=${staleRunningAt} < 完成写入=${completedAt}）`,
    );
    assert.equal(
      row.task_status,
      "completed",
      "迟到的 running 差量不得把已收敛的 completed 打回运行态",
    );
  } finally {
    syncer.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("③ 行不存在 → running 差量跳过不抛错（建行归回源路径）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-running-miss-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo();
  const { service, fireIndexFrame } = makeSilentAgentService();
  const syncer = createZCodeTaskIndexSyncer({
    agentService: service as never,
    taskIndexRepo: repo,
  });
  try {
    syncer.ensureWorkspaceSubscription({ workspacePath: WS_PATH });
    const topic = sessionsIndexTopic(WS_PATH);
    // 基线快照为空（workspace 尚无任何可见会话），seeded 仍成立。
    fireIndexFrame(snapshotFrame(summary({ sessionId: "sess-other-baseline" }), topic));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 无基线行的新会话直接以 running 进入差量：applyAgentPatch 行缺失返回 null，
    // 建行由 becameVisibleTask 的回源路径负责，本分支必须静默跳过。
    fireIndexFrame(
      deltasFrame(
        summary({ phase: "running", sessionEnded: false, lastActivityAt: 1_700_000_040_000 }),
        topic,
        1,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 无任何异常逃逸（fire 是同步调用，到这里没有抛错即通过）；确认没有半建行。
    const db = (repo as unknown as { getDatabase(): { prepare(s: string): { all(...a: unknown[]): unknown } } }).getDatabase();
    const rows = db
      .prepare("SELECT task_id FROM tasks WHERE task_id = ?")
      .all(TASK_ID) as unknown[];
    console.log(`③ 行缺失差量：残留行数=${rows.length}（应为 0，建行归回源路径）`);
    assert.equal(rows.length, 0, "行缺失时 running 差量不得半建行");
  } finally {
    syncer.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
