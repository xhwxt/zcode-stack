// 闲时任务终态通知 hook 的行为测试（spec: packages/ui/specs/offpeak-notifications-web.md）。
// 真实 React + 真实 useOffPeakTaskNotifications + 真实 zh-CN 文案；无 DOM 环境用最小
// DOM 桩满足 react-dom client 初始化与提交路径的读取面（见下方 window/document 桩）。
// 轮询节拍用 node:test mock.timers 假时钟推进（hook 用 setInterval，不为其改代码）。
//
// 覆盖：
//   ① enabled 时 running→completed / running→failed 边沿各触发一次通知，标题/正文为 i18n 文案；
//   ② 首次见到即终态不补发历史；
//   ③ 非终态（queued/paused/running/cancelled）不触发；
//   ④ 同一任务不因持续轮询重复通知（含 cancelled 终态）；
//   ⑤ enabled=false（用户关通知）时不发。
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { window?: unknown }).window = {
  event: undefined,
  HTMLIFrameElement: function FakeIFrame(this: unknown) {},
  document: {
    activeElement: {
      tagName: "BODY",
      style: {},
      hasAttribute: () => false,
      getAttribute: () => null,
    },
    documentElement: { style: {} },
  },
};

import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import { useOffPeakTaskNotifications } from "../src/hooks/useOffPeakTaskNotifications.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import type { IOffPeakTaskService } from "@zcode/services";
import type { ZCodeOffPeakTask, ZCodeOffPeakTaskStatus } from "@zcode/shared";

const POLL_MS = 30_000;

interface NotificationCall {
  taskId: string;
  status: "completed" | "failed";
  title: string;
  body: string;
}

function makeTask(
  offPeakTaskId: string,
  status: ZCodeOffPeakTaskStatus,
  title = `任务-${offPeakTaskId}`,
): ZCodeOffPeakTask {
  return {
    offPeakTaskId,
    title,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ZCodeOffPeakTask;
}

function makeService(initial: ZCodeOffPeakTask[]): {
  service: IOffPeakTaskService;
  setTasks(next: ZCodeOffPeakTask[]): void;
} {
  let tasks = initial;
  return {
    service: {
      list: async () => tasks,
      getCodingPlanSupport: async () => {
        throw new Error("not used in test");
      },
      getTakeNumberAvailability: async () => {
        throw new Error("not used in test");
      },
      createTask: async () => {
        throw new Error("not used in test");
      },
      cancelTask: async () => null,
      pauseTask: async () => null,
      continueTask: async () => null,
      deleteTask: async () => {},
      deleteHistory: async () => null,
      updateTask: async () => null,
      get: async () => null,
    } as unknown as IOffPeakTaskService,
    setTasks(next) {
      tasks = next;
    },
  };
}

function makeIntl() {
  return {
    formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => {
      let msg = zhCN[descriptor.id] ?? descriptor.id;
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          msg = msg.replaceAll(`{${key}}`, String(value));
        }
      }
      return msg;
    },
  };
}

function makeFakeContainer(): HTMLElement {
  const base = {
    nodeType: 1,
    tagName: "DIV",
    style: {},
    children: [],
    setAttribute() {},
    hasAttribute: () => false,
    getAttribute: () => null,
    focus() {},
    blur() {},
    contains: () => false,
    dispatchEvent: () => true,
    addEventListener() {},
    removeEventListener() {},
    ownerDocument: {
      createElement: () => ({ style: {}, setAttribute() {} }),
      addEventListener() {},
      removeEventListener() {},
      documentElement: { style: {} },
      defaultView: undefined,
    },
  };
  return base as unknown as HTMLElement;
}

/** 挂载真实 hook，返回通知调用记录、推进一轮轮询的句柄与卸载函数。 */
async function mountHook(params: {
  service: IOffPeakTaskService;
  enabled: boolean;
}): Promise<{
  calls: NotificationCall[];
  advancePoll: () => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const calls: NotificationCall[] = [];
  const platform = {
    showTaskNotification: (payload: NotificationCall) => {
      calls.push({ ...payload });
    },
  };
  const intl = makeIntl();

  function Harness() {
    useOffPeakTaskNotifications({
      offPeakTaskService: params.service,
      platform:
        platform as unknown as Parameters<typeof useOffPeakTaskNotifications>[0]["platform"],
      enabled: params.enabled,
      formatMessage: intl.formatMessage,
    });
    return null;
  }

  const container = makeFakeContainer();
  const root = ReactDOMClient.createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  // 挂载 effect 的首轮 tick 是异步 list；让出微任务等它落地。
  await sleep(0);

  return {
    calls,
    advancePoll: async () => {
      await React.act(async () => {
        mock.timers.tick(POLL_MS);
      });
      // tick 触发的 tick() 里有 await offPeakTaskService.list()；让出微任务。
      await sleep(0);
    },
    unmount: async () => {
      await React.act(async () => {
        root.unmount();
      });
    },
  };
}

test("① running→completed/failed 边沿各触发一次通知，标题/正文为 i18n 文案", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { service, setTasks } = makeService([makeTask("t1", "running")]);
  const { calls, advancePoll, unmount } = await mountHook({ service, enabled: true });
  try {
    assert.equal(calls.length, 0, "初始 running 不应通知");

    setTasks([makeTask("t1", "completed")]);
    await advancePoll();
    assert.equal(calls.length, 1, "completed 边沿应通知一次");
    assert.equal(calls[0]?.status, "completed");
    assert.equal(calls[0]?.title, zhCN["offPeak.notify.completed.title"]);
    assert.equal(calls[0]?.body, zhCN["offPeak.notify.completed.body"].replaceAll("{title}", "任务-t1"));
    assert.equal(calls[0]?.taskId, "t1");

    setTasks([makeTask("t1", "failed")]);
    await advancePoll();
    assert.equal(calls.length, 2, "failed 边沿应再通知一次");
    assert.equal(calls[1]?.status, "failed");
    assert.equal(calls[1]?.title, zhCN["offPeak.notify.failed.title"]);
    assert.equal(calls[1]?.body, zhCN["offPeak.notify.failed.body"].replaceAll("{title}", "任务-t1"));
  } finally {
    await unmount();
  }
});

test("② 首次见到即终态不补发历史", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { service } = makeService([makeTask("done-already", "completed")]);
  const { calls, advancePoll, unmount } = await mountHook({ service, enabled: true });
  try {
    await advancePoll();
    await advancePoll();
    assert.equal(calls.length, 0, "存量终态任务不应补发通知");
  } finally {
    await unmount();
  }
});

test("③ 非终态（queued/paused/running/cancelled）不触发", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { service, setTasks } = makeService([
    makeTask("a", "queued"),
    makeTask("b", "paused"),
    makeTask("c", "running"),
    makeTask("d", "cancelled"),
  ]);
  const { calls, advancePoll, unmount } = await mountHook({ service, enabled: true });
  try {
    await advancePoll();
    // 状态在非终态之间迁移也不触发
    setTasks([makeTask("a", "paused"), makeTask("b", "running"), makeTask("c", "queued")]);
    await advancePoll();
    assert.equal(calls.length, 0, "非终态及非终态间迁移不应通知");
  } finally {
    await unmount();
  }
});

test("④ 同一任务不因持续轮询重复通知", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { service, setTasks } = makeService([makeTask("t1", "running")]);
  const { calls, advancePoll, unmount } = await mountHook({ service, enabled: true });
  try {
    setTasks([makeTask("t1", "completed")]);
    await advancePoll();
    assert.equal(calls.length, 1);
    // 终态保持不变，继续轮询多轮
    await advancePoll();
    await advancePoll();
    assert.equal(calls.length, 1, "状态不变时不得重复通知");
  } finally {
    await unmount();
  }
});

test("⑤ enabled=false（用户关闭通知）时不发", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { service, setTasks } = makeService([makeTask("t1", "running")]);
  const { calls, advancePoll, unmount } = await mountHook({ service, enabled: false });
  try {
    setTasks([makeTask("t1", "completed")]);
    await advancePoll();
    assert.equal(calls.length, 0, "通知关闭时不应调用 platform");
  } finally {
    await unmount();
  }
});
