/* 回归：window-controller 订阅作用域（连接私有 attachment + 同主题替换）
 *
 * 依据（deploy/e2e/ws-meter.mjs 逐帧计量）：进程级单例 attachment 的订阅表
 * 不随连接回收，订阅表会持续累积死订阅；投影按 subscriber 逐条打帧，于是一条很小的 delta 会被复制成很多份下发。
 *
 * 本测试锁定两条不变量：
 *  1) 订阅与帧 emitter 属 attachment 私有：一条连接的订阅不把帧发到别的 attachment；
 *     dispose() 后必须停止产帧（连接关闭 = 订阅回收，死订阅不得继续复制 delta）。
 *  2) 同一 attachment 同一 topic 只保留最新一条订阅（重订阅 = 替换），不叠加下发份数。
 *
 * 运行：pnpm --filter @zcode/services exec tsx --test test/windowControllerSubscriptionScope.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createWindowHostControllerRuntime } from "../src/window-controller/windowHostControllerService.js";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import type {
  WindowHostControllerFrame,
  WindowHostControllerTaskFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeTaskMeta } from "@zcode/shared";

const WORKSPACE = "/tmp/window-controller-scope-workspace";

function task(taskId: string, pinned = false): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: WORKSPACE,
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    pinned,
  } as unknown as ZCodeTaskMeta;
}

/** 只实现 runtime 真正调用的那几个方法；其余成员用 as 收口（测试替身，不是生产实现）。 */
function createTaskServiceStub(state: { rows: ZCodeTaskMeta[] }) {
  return {
    async listTasks() {
      return state.rows.filter((row) => !row.pinned);
    },
    async listPinnedTasks() {
      return state.rows.filter((row) => row.pinned);
    },
    async listArchivedTasks() {
      return [];
    },
    async setTaskPinned(params: { taskId: string; pinned: boolean }) {
      state.rows = state.rows.map((row) =>
        row.taskId === params.taskId ? { ...row, pinned: params.pinned } : row,
      );
    },
    onDynamicWorkspaceEvent() {
      return () => ({ dispose() {} });
    },
    onError() {
      return { dispose() {} };
    },
  } as unknown as IZCodeTaskService;
}

function createHarness() {
  let serial = 0;
  const state = { rows: [task("t1")] };
  const runtime = createWindowHostControllerRuntime({
    createId: () => `id-${(serial += 1)}`,
    resolveSource: () => ({
      scope: { kind: "local", workspacePath: WORKSPACE },
      taskService: createTaskServiceStub(state),
      sourceAvailability: "online",
    }),
  });
  return { runtime, state };
}

function collectFrames(scope: { onDynamicControllerFrame(): unknown }) {
  const frames: WindowHostControllerTaskFrame[] = [];
  const listener = (
    scope.onDynamicControllerFrame as () => (
      cb: (frame: WindowHostControllerFrame) => void,
    ) => { dispose(): void }
  )()((frame) => {
    frames.push(frame as WindowHostControllerTaskFrame);
  });
  return { frames, listener };
}

function framesFor(frames: WindowHostControllerTaskFrame[], subscriptionId: string) {
  return frames.filter((frame) => frame.subscriptionId === subscriptionId);
}

function taskDeltaFrames(frames: WindowHostControllerTaskFrame[]) {
  return frames.filter((frame) => frame.payload.kind === "deltas");
}

async function registerSource(scope: {
  listTaskList(query: unknown): Promise<unknown>;
}): Promise<void> {
  await scope.listTaskList({
    kind: "active",
    workspaceScopes: [{ workspacePath: WORKSPACE }],
    sortBy: "updated",
  });
}

test("同一 topic 重复订阅 = 替换：只有最新 subscriptionId 收到帧", async () => {
  const { runtime, state } = createHarness();
  const scope = runtime.createAttachmentService();
  const { frames } = collectFrames(scope);
  try {
    await registerSource(scope);

    const first = await scope.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });
    const second = await scope.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });
    assert.notEqual(first.ack.subscriptionId, second.ack.subscriptionId);

    frames.length = 0;
    state.rows = [task("t1", true)];
    await scope.mutateTask({
      address: { taskId: "t1", workspacePath: WORKSPACE },
      mutation: { kind: "pin", pinned: true },
    });

    const deltas = taskDeltaFrames(frames);
    assert.equal(
      deltas.length,
      1,
      `同一 topic 两条订阅不得各发一份（实际收到 ${deltas.length} 帧）`,
    );
    assert.equal(deltas[0]!.subscriptionId, second.ack.subscriptionId);
    assert.equal(framesFor(frames, first.ack.subscriptionId).length, 0);
  } finally {
    scope.dispose();
  }
});

test("订阅作用域按 attachment 隔离，dispose 后不再产帧", async () => {
  const { runtime, state } = createHarness();
  const scopeA = runtime.createAttachmentService();
  const scopeB = runtime.createAttachmentService();
  const a = collectFrames(scopeA);
  const b = collectFrames(scopeB);
  try {
    await registerSource(scopeA);
    const ackA = await scopeA.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });
    const ackB = await scopeB.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });

    a.frames.length = 0;
    b.frames.length = 0;
    state.rows = [task("t1", true)];
    await scopeA.mutateTask({
      address: { taskId: "t1", workspacePath: WORKSPACE },
      mutation: { kind: "pin", pinned: true },
    });

    // 每条订阅只在自己 attachment 的 emitter 上收到一份；不串到别的 attachment。
    assert.equal(framesFor(a.frames, ackB.ack.subscriptionId).length, 0);
    assert.equal(framesFor(b.frames, ackA.ack.subscriptionId).length, 0);
    assert.equal(taskDeltaFrames(a.frames).length, 1);
    assert.equal(taskDeltaFrames(b.frames).length, 1);

    // 连接关闭 = attachment dispose：死订阅必须停止产帧。
    scopeA.dispose();
    a.frames.length = 0;
    b.frames.length = 0;
    state.rows = [task("t1")];
    await scopeB.mutateTask({
      address: { taskId: "t1", workspacePath: WORKSPACE },
      mutation: { kind: "pin", pinned: false },
    });
    assert.equal(
      a.frames.length,
      0,
      `dispose 后本连接不得再收帧（实际收到 ${a.frames.length} 帧）`,
    );
    assert.equal(taskDeltaFrames(b.frames).length, 1);
  } finally {
    scopeA.dispose();
    scopeB.dispose();
    a.listener.dispose();
    b.listener.dispose();
  }
});
