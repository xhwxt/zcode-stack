import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 两个分支必须无条件都调用：workspacePath 启动期会从 undefined 翻转为有值，
  // 条件分支会让 hook 顺序改变（见 useZCodeSessionService.ts 内同名注释）。
  // 取值仍按原语义：非空 path 用按 workspace 身份解析出的服务，空 path 才回落 context。
  const pathScopedServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  const services = workspacePath ? pathScopedServices : contextServices;
  return services.zcodeAgentService;
}
