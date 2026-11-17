// Server 端 Window Controller：自托管 web（无桌面 Host）的 IWindowControllerService 实现。
//
// 重构说明：此前本文件是桌面 host 的「第二份实现」——订阅/帧通道/
// overlay 投影/membership 各自为政，从 148 行涨到 344 行，仍缺桌面端的
// 真实 deltas、gap resync、membership 精确失效、live overlays。
// 根因是桌面核心本就可移植：windowHostControllerService + windowHostControllerProjection
// 零 electron 依赖、环境输入全走 DI（createId/resolveSource/onSourceError）。
// 两者已下沉到 packages/services/src/window-controller/（与 sessionsIndexObserver 同层），
// desktop 与 server 各自只保留 resolveSource 接线；本文件随之退化为薄接线层：
// server 侧单源（同进程 taskService/agentService）、恒 online、无 remote 路由。
// 桌面端能力（live overlays、gap resync、membership 精确失效、真实 deltas、
// refresh flight 去重）由共享 runtime 提供，不再是本文件里的第二份实现。
import { randomUUID } from "node:crypto";
import {
  IWindowControllerService,
  type IZCodeAgentService,
  type IZCodeTaskService,
} from "@zcode/services";
import { createWindowHostControllerRuntime } from "@zcode/services/window-controller/windowHostControllerService.js";

function shimLogWarn(message: string, meta?: Record<string, unknown>): void {
  console.log("[window-controller-shim][warn]", message, ...(meta ? [JSON.stringify(meta)] : []));
}

/**
 * 一条客户端 WS 连接持有的 Controller 面。
 *
 * 依据：进程级单例 attachment 上的订阅表从不随连接回收会持续累积死订阅；投影按 subscriber 逐条打帧，于是同一条 tasks-index delta（971 字节）
 * 会被按订阅数重复下发。订阅必须与连接同生命周期：
 * 每条连接一个 attachment，连接关闭即 dispose，帧只进本连接的 emitter。
 */
export interface ServerWindowControllerConnectionScope {
  service: IWindowControllerService;
  dispose(): void;
}

export interface ServerWindowControllerRuntime {
  /** RPC 注册用的进程级单例（无连接上下文的调用方用）。 */
  service: IWindowControllerService;
  /** 每条客户端连接各建一个：订阅表与帧 emitter 都是连接私有的。 */
  createConnectionScope(): ServerWindowControllerConnectionScope;
}

export function createServerWindowControllerRuntime(options: {
  taskService: IZCodeTaskService;
  // sessions-index 观察器的数据源（existing-only，不会启动 Agent runtime）。
  // 缺省时列表只有 SQLite meta 投影，运行态/等待交互不可见（桌面 host 均注入）。
  agentService?: IZCodeAgentService;
}): ServerWindowControllerRuntime {
  const runtime = createWindowHostControllerRuntime({
    createId: randomUUID,
    onSourceError: (_scope, operation, error) => {
      shimLogWarn(`Controller source ${operation} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    },
    resolveSource: (scope) => {
      // server 侧单源：同进程 taskService/agentService，恒 online。
      return {
        scope: {
          kind: "local" as const,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
        taskService: options.taskService,
        agentService: options.agentService,
        sourceAvailability: "online" as const,
      };
    },
  });

  return {
    service: runtime.service,
    createConnectionScope() {
      const attachment = runtime.createAttachmentService();
      return {
        service: attachment,
        dispose: () => attachment.dispose(),
      };
    },
  };
}
