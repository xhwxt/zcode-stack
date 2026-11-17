import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 两个分支必须无条件都调用：本 hook 的调用方（如 OnboardingDialog ← Root 的
  // workspacePath={workspaceShellPath || undefined}）传入的 workspacePath 会在启动期
  // 从 undefined 翻转为有值，若按条件只调其一，hook 顺序改变会让后续 useTabStore
  // 的 useCallback 读到错位槽位，抛 "Cannot read properties of undefined (reading 'length')"。
  // 取值仍按原语义：非空 path 用按 workspace 身份解析出的服务（跨 workspace/远程
  // 场景它与 context 服务可能是不同 host），空 path 才回落 context。
  const pathScopedServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  const services = workspacePath ? pathScopedServices : contextServices;
  return services.zcodeSessionService;
}
