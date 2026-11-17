import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannel,
  type IChannelClient,
  type IHandler,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

enum State {
  Uninitialized,
  Idle,
}

export class ChannelClient implements IChannelClient, IDisposable {
  private state = State.Uninitialized;
  private isDisposed = false;
  private activeRequests = new Set<IDisposable>();
  private handlers = new Map<number, IHandler>();
  // Promise 请求和事件监听共用 handlers，但只有前者需要在连接终结时 reject。
  // 单独维护 reject map，避免 dispose 把事件订阅误当成挂起的 RPC 请求。
  private pendingRejections = new Map<number, (error: Error) => void>();
  private lastRequestId = 0;
  /**
   * 活跃事件订阅（listen）的重发清单：id → 请求参数。
   * 热换底（resetTransport）后 server 端新 scope 不持有任何订阅状态，
   * 必须按此清单重发 EventListen——否则 UI 永远收不到事件流（消息帧、
   * 会话更新全部静默断流）。onDidRemoveLastListener 时移除。
   */
  private activeEventSubscriptions = new Map<
    number,
    { channelName: string; name: string; arg?: any }
  >();
  private protocolListener: IDisposable | null;

  // 非 readonly：resetTransport 换底时会整体重建（事件身份随传输换代）。
  private _onDidInitialize = new Emitter<void>();
  onDidInitialize = this._onDidInitialize.event;

  private protocol: IMessagePassingProtocol;

  constructor(protocol: IMessagePassingProtocol) {
    this.protocol = protocol;
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        if (this.isDisposed) {
          return Promise.reject(new Error("ChannelClient is disposed"));
        }
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) => {
        if (this.isDisposed) {
          return Event.None;
        }
        return this.requestEvent(channelName, event, arg);
      },
    } as T;
  }

  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    const id = this.lastRequestId++;

    if (cancellationToken.isCancellationRequested) {
      return Promise.reject(new Error("Cancelled"));
    }

    let disposable: IDisposable | undefined;
    const result = new Promise<any>((resolve, reject) => {
      this.pendingRejections.set(id, reject);
      const doRequest = () => {
        // dispose/cancel 可能发生在 Initialize 之前；此时不能再把已经 rejected
        // 的请求发送到新连接或已终结的传输上。
        if (this.isDisposed || !this.pendingRejections.has(id)) {
          return;
        }

        const handler: IHandler = (response) => {
          switch (response.type) {
            case ResponseType.PromiseSuccess:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              resolve(response.data);
              return;
            case ResponseType.PromiseError: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              const error = new Error(response.data.message) as Error & Record<string, unknown>;
              error.name = response.data.name;
              if (response.data.stack) {
                error.stack = response.data.stack.join("\n");
              }
              const passthroughKeys = [
                "code",
                "kind",
                "status",
                "retryAfterMs",
                "data",
                "detail",
                "details",
                "taskId",
                "traceId",
              ] as const;
              for (const key of passthroughKeys) {
                const value = response.data[key];
                if (value !== undefined) {
                  error[key] = value;
                }
              }
              reject(error);
              return;
            }
            case ResponseType.PromiseErrorObj:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(response.data);
              return;
          }
        };

        this.handlers.set(id, handler);
        this.sendRequest(RequestType.Promise, id, channelName, name, arg);
      };

      if (this.state === State.Idle) {
        doRequest();
      } else {
        this.whenInitialized().then(doRequest);
      }

      disposable = cancellationToken.onCancellationRequested(() => {
        if (!this.pendingRejections.has(id)) {
          return;
        }
        this.sendCancelOrDispose(RequestType.PromiseCancel, id);
        this.handlers.delete(id);
        this.pendingRejections.delete(id);
        reject(new Error("Cancelled"));
      });
      this.activeRequests.add(disposable);
    });

    return result.finally(() => {
      disposable?.dispose();
      if (disposable) {
        this.activeRequests.delete(disposable);
      }
    });
  }

  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    const id = this.lastRequestId++;
    const emitter = new Emitter<any>({
      onWillAddFirstListener: () => {
        const doRequest = () => {
          this.activeRequests.add(emitter);
          this.activeEventSubscriptions.set(id, { channelName, name, arg });
          this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
        };

        if (this.state === State.Idle) {
          doRequest();
        } else {
          this.whenInitialized().then(doRequest);
        }
      },
      onDidRemoveLastListener: () => {
        this.activeRequests.delete(emitter);
        this.activeEventSubscriptions.delete(id);
        this.sendCancelOrDispose(RequestType.EventDispose, id);
        this.handlers.delete(id);
      },
    });

    this.handlers.set(id, (response) => {
      emitter.fire((response as { data: any }).data);
    });

    return emitter.event;
  }

  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg?: any,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, arg);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private sendCancelOrDispose(
    type: RequestType.PromiseCancel | RequestType.EventDispose,
    id: number,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id]);
    serialize(writer, undefined);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onBuffer(message: VSBuffer): void {
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as ResponseType;

    switch (type) {
      case ResponseType.Initialize:
        this.onResponse({ type: ResponseType.Initialize });
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.onResponse({
          type,
          id: header[1],
          data: body,
        } as IRawResponse);
        return;
    }
  }

  private onResponse(response: IRawResponse): void {
    if (response.type === ResponseType.Initialize) {
      this.state = State.Idle;
      this._onDidInitialize.fire();
      return;
    }

    this.handlers.get(response.id)?.(response);
  }

  private whenInitialized(): Promise<void> {
    if (this.state === State.Idle) {
      return Promise.resolve();
    }
    return Event.toPromise(this.onDidInitialize);
  }

  /**
   * 原地换底：替换底层传输并 fail-closed 所有挂起请求，**不改变本对象身份**。
   *
   * 修复依据：切后台回前台不得出现整树重建的视觉变化。软重连若
   * 更换 ChannelClient/ServiceAccessor 对象，React context value 变化会让整棵
   * 消费树重渲（视觉上等同界面闪一下重建）。本方法让上层在重连成功后
   * 仅替换传输层：挂起的 in-flight 请求按断连语义立即 reject（fail-closed，
   * 与 dispose 相同的收敛保证），事件订阅（requestEvent 的 listen 请求）在
   * 新连接 Initialize 后自动重发，从而上层对象身份与订阅生命周期完全稳定。
   *
   * 事件重发实现：listen 请求（activeRequests 里的 emitter 句柄）不能像 dispose
   * 那样直接 dispose（那会终止订阅语义），这里逐个记录其 (type,id,channel,name)
   * 并在新连接 Initialize 后重新 sendRequest(EventListen)。
   */
  resetTransport(protocol: IMessagePassingProtocol, bufferedFrames?: VSBuffer[]): void {
    if (this.isDisposed) {
      return;
    }
    // 1. fail-closed 挂起的 Promise 请求（与 dispose 同语义，但不终止对象）。
    //    注意：只 reject pendingRejections（Promise 请求）——事件订阅的 emitter
    //    绝不能 dispose（dispose 会触发 onDidRemoveLastListener 清掉
    //    activeEventSubscriptions，重发循环就空了）。
    const rejection = new Error("ConnectionClosed");
    rejection.name = "ConnectionClosed";
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }

    // 2. 换传输：解绑旧 protocolListener，绑定新的。
    this.protocolListener?.dispose();
    this.protocol = protocol;
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));

    // 3. 重置握手状态：等待新连接的 Initialize。
    this.state = State.Uninitialized;
    this._onDidInitialize = new Emitter<void>();
    this.onDidInitialize = this._onDidInitialize.event;

    // 4. 重放缓冲帧。关键时序：server 的 Initialize 在 WS open 时立即到达，
    //    而 ChannelClient 绑定新 protocol 发生在其后的 resetTransport——
    //    若不重放，Initialize 已丢失，state 永远停在 Uninitialized，
    //    所有后续请求（含握手 hello）永久排队 → fault.connection.handshakeRequired。
    for (const frame of bufferedFrames ?? []) {
      this.onBuffer(frame);
    }

    // 5. 重发全部活跃事件订阅：server 新 scope 不持有旧订阅状态，
    //    不重发 = UI 永远收不到事件流（消息帧静默断流）。
    //    使用原 id（handlers 对应关系保持），server 端新 scope 以新订阅处理。
    for (const [id, params] of this.activeEventSubscriptions) {
      this.sendRequest(RequestType.EventListen, id, params.channelName, params.name, params.arg);
    }
  }

  dispose(reason?: Error): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.protocolListener?.dispose();
    this.protocolListener = null;

    const rejection = reason ?? new Error("ChannelClient disposed");
    if (!reason) {
      rejection.name = "ConnectionClosed";
    }
    // 传输已终结时，所有已发出以及排队等待 Initialize 的 Promise 请求都必须
    // fail-closed。否则上层的 in-flight 去重 Promise 会永久占用 workspace key。
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }
    for (const disposable of this.activeRequests) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    this.pendingRejections.clear();
    this._onDidInitialize.dispose();
  }
}
