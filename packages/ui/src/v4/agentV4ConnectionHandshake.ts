// 每个 RPC service proxy 对应一个 attachment；hello/clientHello 只做一次，所有
// conversation/sessions-index transport 共享该 Promise，避免并发首订阅重复握手。
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  hostSupportsWorkflowRunDeltas,
  type ClientHello,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

const handshakes = new WeakMap<object, { epoch: number; promise: Promise<HelloMessage> }>();
// 传输热换底代际：socket 换新后 server 端是新 connection scope（握手状态归零），
// 必须重发 hello+initialize。递增代际使旧缓存的握手 Promise 失效。
let handshakeEpoch = 0;
export function bumpAgentV4HandshakeEpoch(): void {
  handshakeEpoch += 1;
}
export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  // 缓存条目携带创建时的代际：bump（热换底）后旧条目直接作废——
  // 修复此前 bump 只递增数字、查找路径不比对代际导致缓存永不失效的漏洞
  //（服务器端实锤：同一 scope 上 subscribe 反复被拒而 hello 从未到达）。
  const cached = handshakes.get(key);
  if (cached && cached.epoch === handshakeEpoch) return cached.promise;
  const epoch = handshakeEpoch;

  const handshake = (async () => {
    // 握手 RPC 超时（8s）：底层传输处于无 Initialize 的僵尸态时 hello 会永久挂起，
    // 缓存 promise 不落定 → 后续所有重试都命中这份 pending 缓存、永不重发 hello。
    // 超时 reject 使缓存按失败语义删除，下一次重试重新走完整握手。
    const withTimeout = <T,>(p: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("handshake timeout")), 8_000);
        p.then(
          (v) => { clearTimeout(timer); resolve(v); },
          (e) => { clearTimeout(timer); reject(e); },
        );
      });
    const hello = helloMessageSchema.parse(await withTimeout(service.helloConversationV4()));
    // `workflowRunDeltas` 的声明是**单向**的：只有 Host 先在 hello 里宣告，客户端才能回声明。
    // clientHello 的 capabilities 是 `.strict()` 的，向老 Host 发一个它不认识的键会让整条
    // clientHello 解析失败、连接握不上手——这不是降级，是整个会话面板打不开。
    const capabilities: NonNullable<ClientHello["capabilities"]> = {
      workspaceHookReviewUi: true,
      ...(hostSupportsWorkflowRunDeltas(hello.capabilities) ? { workflowRunDeltas: true } : {}),
    };
    await withTimeout(
      service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        // handshake 与 commandFactory 曾各生成一套页面 clientId，facade
        // 无法验证 command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
        clientId: getV4ClientId(),
        clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
        appVersion: "unknown",
        capabilities,
      }),
    );
    return hello;
  })();
  handshakes.set(key, { epoch, promise: handshake });
  void handshake.catch(() => {
    if (handshakes.get(key)?.promise === handshake) handshakes.delete(key);
  });
  return handshake;
}
