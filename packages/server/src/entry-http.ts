import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import { IWindowControllerService, IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";
import { createServerWindowControllerRuntime } from "./windowControllerShim.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  // 旧单 token 模式已删除（spec: packages/server/specs/device-credential-auth.md）：
  // 不再读 ZCODE_SERVER_AUTH_TOKEN / ZCODE_SERVER_TOKEN；鉴权恒开为设备凭据模型，
  // 部署引导只需保证管理密钥文件（<配置目录>/zcode-admin.secret）存在。
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    // 旧语义：有 token（真实部署）才注册 provisioning target。设备凭据模式下
    // 鉴权恒开，语义等价于恒注册；普通 Web 客户端仍被 http.ts 的 channel
    // override 拦截（仅 desktop-continuous 可用），不构成新的暴露面。
    providerProvisioningTargetEnabled: true,
  });

  // 修复依据：直连页侧栏「任务」分组查询 IWindowControllerService（channel
  // "window-controller"），该服务此前仅桌面 Host 注册，自托管 web 直连页任务列表恒空。
  // 这里注册 server 端 Window Controller（薄接线层，见 windowControllerShim.ts）。
  // agentService 供 sessions-index 观察器产出 live 事实（运行态/等待交互）——
  // existing-only，列表读取不会启动 Agent runtime。
  // 注册的是进程级单例（无连接上下文的调用方用）；客户端连接走
  // createConnectionScope() 的私有 attachment，见 http.ts（订阅随连接回收）。
  const windowController = createServerWindowControllerRuntime({
    taskService: services.get(IZCodeTaskService),
    agentService: services.get(IZCodeAgentService),
  });
  services.register(IWindowControllerService, windowController.service);

  // createHttpServer 现为异步：设备凭据鉴权器需要在启动时加载/初始化
  // devices.json；既无管理密钥也无注册表时这里直接抛错（不允许裸奔），
  // 由下方 main().catch 记录并退出。
  await createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    windowController,
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
