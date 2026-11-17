/* 回归：server 壳给每条客户端连接发独立 Window Controller attachment
 *
 * 依据（同一 delta 会按订阅数重复下发）：进程级单例 attachment 被所有连接共用，
 * 订阅表不随连接回收 → 一条 971 字节 delta 被复制 425 份下发。http.ts 现在每连接
 * createConnectionScope() 并在 socket close 时 dispose；本测试锁定 shim 侧的三个前提，
 * 漏掉任何一个都会退回旧行为（服务端把窗口控制器单例当连接作用域用）：
 *  1) createConnectionScope() 不得返回进程级单例（否则又变成全局共用订阅表）；
 *  2) 不同连接的订阅互不投递（帧只进本连接的 emitter）；
 *  3) dispose 后本连接不再收帧（订阅随连接回收）。
 *
 * 运行：pnpm --filter @zcode/server test
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IZCodeTaskService } from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  type WindowHostControllerFrame,
  type WindowHostControllerTaskFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createServerWindowControllerRuntime } from "../src/windowControllerShim.js";

const WORKSPACE = "/tmp/server-controller-scope-workspace";

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

function createTaskServiceStub(state: { rows: ZCodeTaskMeta[] }): IZCodeTaskService {
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

test("每条连接一个 attachment：不复用单例、互不投递、dispose 后停止收帧", async () => {
  const state = { rows: [task("t1")] };
  let serial = 0;
  const runtime = createServerWindowControllerRuntime({
    taskService: createTaskServiceStub(state),
  });
  const scopeA = runtime.createConnectionScope();
  const scopeB = runtime.createConnectionScope();
  const a = collectFrames(scopeA.service);
  const b = collectFrames(scopeB.service);
  try {
    assert.notEqual(scopeA.service, runtime.service, "连接作用域不得是进程级单例");
    assert.notEqual(scopeA.service, scopeB.service, "两条连接不得共用同一 attachment");

    await scopeA.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      sortBy: "updated",
    });
    const ackA = await scopeA.service.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });
    const ackB = await scopeB.service.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });

    a.frames.length = 0;
    b.frames.length = 0;
    state.rows = [task("t1", true)];
    await scopeA.service.mutateTask({
      address: { taskId: "t1", workspacePath: WORKSPACE },
      mutation: { kind: "pin", pinned: true },
    });

    const deltasA = a.frames.filter((frame) => frame.payload.kind === "deltas");
    const deltasB = b.frames.filter((frame) => frame.payload.kind === "deltas");
    assert.equal(deltasA.length, 1, `本连接订阅应恰好收到 1 帧（实际收到 ${deltasA.length}）`);
    assert.equal(deltasA[0]!.subscriptionId, ackA.ack.subscriptionId);
    assert.equal(
      a.frames.some((frame) => frame.subscriptionId === ackB.ack.subscriptionId),
      false,
      "别条连接的订阅帧不得进入本连接",
    );
    assert.equal(deltasB.length, 1);
    assert.equal(deltasB[0]!.subscriptionId, ackB.ack.subscriptionId);

    scopeA.dispose();
    a.frames.length = 0;
    state.rows = [task("t1")];
    await scopeB.service.mutateTask({
      address: { taskId: "t1", workspacePath: WORKSPACE },
      mutation: { kind: "pin", pinned: false },
    });
    assert.equal(a.frames.length, 0, `连接关闭后不得再收帧（实际收到 ${a.frames.length}）`);
    assert.equal(b.frames.filter((frame) => frame.payload.kind === "deltas").length, 2);
  } finally {
    scopeA.dispose();
    scopeB.dispose();
    a.listener.dispose();
    b.listener.dispose();
  }
});
