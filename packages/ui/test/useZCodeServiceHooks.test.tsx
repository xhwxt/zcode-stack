// useZCodeSessionService / useZCodeAgentService / useZCodeTaskService 的行为测试。
//
// 背景：这三个 hook 曾用 `workspacePath ? useWorkspaceServices(...) : useServices()`
// 条件调用两个不同的 hook。调用方（如 OnboardingDialog ← Root 的
// workspacePath={workspaceShellPath || undefined}）在启动期会把 workspacePath 从
// undefined 翻转为有值，hook 顺序改变导致 zustand useStore 的 useCallback 读到错位
// 槽位，抛 "Cannot read properties of undefined (reading 'length')"（渲染期崩溃）。
//
// 覆盖：
//   ① 取值语义：非空 workspacePath（含远程 identity）必须取按 workspace 身份解析出的
//      pathScoped services（远程 host），而不是 context services；
//   ② 取值语义：空 workspacePath 必须回落 context services；
//   ③ hook 数恒定：同一挂载实例上 workspacePath 从 undefined 翻转为有值（以及反向）
//      不得抛 hook 顺序错误，且取值随分支正确切换（钉住启动期渲染崩溃不回归）。
//
// 真实 React + 真实 hook 链（useWorkspaceServices → useResolvedRemoteWorkspaceSessionId
// → useTabStore / useRemoteWorkspaceSessionStore）；无 DOM 环境用最小 DOM 桩（同
// offPeakNotificationsWeb.test.ts 先例）。三个 service hook 仅取值表达式不同，取
// useZCodeAgentService 做代表；useZCodeSessionService/useZCodeTaskService 由同构保证。
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";

import { ServiceProvider } from "../src/hooks/useServices.js";
import { useZCodeAgentService } from "../src/hooks/useZCodeAgentService.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "../src/store/remoteWorkspaceSessionStore.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import type { IServiceAccessor } from "@zcode/services";

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

/** 生成可区分 host 的假 service accessor：各字段带 host 标记。 */
function makeAccessor(host: string): IServiceAccessor {
  const service = { host };
  return new Proxy({ zcodeAgentService: service }, {
    get(target, prop) {
      if (prop in target) {
        return (target as Record<PropertyKey, unknown>)[prop];
      }
      // 未列出的 service 也返回同一探针对象，避免 useZCodeTaskService 的
      // 类型守卫/services 其它读取路径抛错。
      return service;
    },
  }) as IServiceAccessor;
}

function getServiceHost(accessor: IServiceAccessor): string {
  return (accessor.zcodeAgentService as { host: string }).host;
}

interface HarnessProps {
  workspacePath?: string;
  workspaceIdentity?: string;
  onResolved: (host: string) => void;
}

function Harness({ workspacePath, workspaceIdentity, onResolved }: HarnessProps) {
  const agentService = useZCodeAgentService(workspacePath, undefined, workspaceIdentity);
  onResolved(getServiceHost({ zcodeAgentService: agentService } as IServiceAccessor));
  return null;
}

/** 组装与生产一致的 provider 树：context services = 远程 host 的 accessor。 */
async function renderHarness(props: HarnessProps): Promise<{ root: ReactDOMClient.Root }> {
  const container = makeFakeContainer();
  const root = ReactDOMClient.createRoot(container);
  const contextServices = makeAccessor("context-host");
  await React.act(async () => {
    root.render(
      React.createElement(
        ServiceProvider,
        { services: contextServices },
        React.createElement(
          TabStoreProvider,
          null,
          React.createElement(Harness, props),
        ),
      ),
    );
  });
  return { root };
}

test("① 非空 workspacePath + 远程 identity：取按 workspace 身份解析出的远程 host 服务，而非 context", async () => {
  const remoteAccessor = makeAccessor("remote-host");
  const baseAccessor = makeAccessor("base-host");
  const session: RemoteWorkspaceSession = {
    sessionId: "remote-session-1",
    services: remoteAccessor,
  };

  const previousState = useRemoteWorkspaceSessionStore.getState();
  useRemoteWorkspaceSessionStore.setState({
    baseServices: baseAccessor,
    sessionsById: { "remote-session-1": session },
    sessionIdByWorkspaceIdentity: { "ssh@remote:/repo": "remote-session-1" },
    sessionIdByWorkspacePath: {},
  });

  const hosts: string[] = [];
  const { root } = await renderHarness({
    workspacePath: "/repo",
    workspaceIdentity: "ssh@remote:/repo",
    onResolved: (host) => hosts.push(host),
  });
  try {
    assert.equal(
      hosts.at(-1),
      "remote-host",
      "非空 path + identity 时必须用 pathScoped（远程 host）服务，而不是 context 服务",
    );
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    useRemoteWorkspaceSessionStore.setState(previousState);
  }
});

test("② 空 workspacePath：回落 context services", async () => {
  const baseAccessor = makeAccessor("base-host");
  const previousState = useRemoteWorkspaceSessionStore.getState();
  useRemoteWorkspaceSessionStore.setState({
    baseServices: baseAccessor,
    sessionsById: {},
    sessionIdByWorkspaceIdentity: {},
    sessionIdByWorkspacePath: {},
  });

  const hosts: string[] = [];
  const { root } = await renderHarness({ onResolved: (host) => hosts.push(host) });
  try {
    assert.equal(
      hosts.at(-1),
      "context-host",
      "空 path 时必须回落 context（ServiceProvider）服务",
    );
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    useRemoteWorkspaceSessionStore.setState(previousState);
  }
});

test("③ workspacePath 从 undefined 翻转为有值再翻回：不抛 hook 顺序错误，取值随分支切换", async () => {
  const remoteAccessor = makeAccessor("remote-host");
  const baseAccessor = makeAccessor("base-host");
  const session: RemoteWorkspaceSession = {
    sessionId: "remote-session-1",
    services: remoteAccessor,
  };

  const previousState = useRemoteWorkspaceSessionStore.getState();
  useRemoteWorkspaceSessionStore.setState({
    baseServices: baseAccessor,
    sessionsById: { "remote-session-1": session },
    sessionIdByWorkspaceIdentity: { "ssh@remote:/repo": "remote-session-1" },
    sessionIdByWorkspacePath: {},
  });

  const hosts: string[] = [];
  const container = makeFakeContainer();
  const root = ReactDOMClient.createRoot(container);
  const contextServices = makeAccessor("context-host");
  const renderWith = (next: { workspacePath?: string; workspaceIdentity?: string }) =>
    React.act(async () => {
      root.render(
        React.createElement(
          ServiceProvider,
          { services: contextServices },
          React.createElement(
            TabStoreProvider,
            null,
            React.createElement(Harness, { ...next, onResolved: (host) => hosts.push(host) }),
          ),
        ),
      );
    });

  try {
    // 首渲染：无 path（对应启动期 OnboardingDialog 无 workspace 阶段）。
    await React.act(async () => {
      renderWith({});
    });
    assert.equal(hosts.at(-1), "context-host");

    // 翻转为有值（对应 tab 恢复完成）：上述崩溃就发生在这一步之后的渲染。
    await React.act(async () => {
      renderWith({ workspacePath: "/repo", workspaceIdentity: "ssh@remote:/repo" });
    });
    assert.equal(hosts.at(-1), "remote-host", "path 出现后应切到 pathScoped 服务且不抛 hook 错误");

    // 翻回无 path（对应 tab 关闭）。
    await React.act(async () => {
      renderWith({});
    });
    assert.equal(hosts.at(-1), "context-host", "path 清空后应切回 context 服务且不抛 hook 错误");
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    useRemoteWorkspaceSessionStore.setState(previousState);
  }
});
