import assert from "node:assert/strict";
import test from "node:test";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  ChannelServer,
  ProtocolMessage,
  ProtocolMessageType,
  writeProtocolMessage,
  type ISocket,
} from "../src/index.js";

function mkSocket(incoming: Emitter<VSBuffer>, outgoing: Emitter<VSBuffer>): ISocket {
  return {
    onData: incoming.event,
    onClose: new Emitter<void>().event,
    onEnd: new Emitter<void>().event,
    write: (b) => setTimeout(() => outgoing.fire(b), 0),
    end() {},
    drain() {
      return Promise.resolve();
    },
    dispose() {},
  };
}

test("resetTransport 重发活跃事件订阅到新 server", async () => {
  // ---- 第一个 server ----
  const toClient1 = new Emitter<VSBuffer>();
  const toServer1 = new Emitter<VSBuffer>();
  let server1Listens = 0;
  const clientProto1 = new SocketProtocol(mkSocket(toClient1, toServer1));
  const serverProto1 = new SocketProtocol(mkSocket(toServer1, toClient1));
  const client = new ChannelClient(clientProto1);
  new ChannelServer(serverProto1, "server").registerChannel("test", {
    listen: (_ctx, name) => {
      server1Listens += 1;
      const e = new Emitter<string>();
      setTimeout(() => e.fire(`s1-${name}`), 5);
      return e.event;
    },
    call: async () => "ok",
  });
  await new Promise((r) => setTimeout(r, 20)); // Initialize

  const ch = client.getChannel("test");
  const got: string[] = [];
  ch.listen("onChange")((e: unknown) => got.push(String(e)));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(server1Listens, 1);

  // ---- 热换底到第二个 server ----
  const toClient2 = new Emitter<VSBuffer>();
  const toServer2 = new Emitter<VSBuffer>();
  let server2Listens = 0;
  // 新 protocol 出生即缓冲（对齐生产：main.tsx onOpenProtocol 里注册缓冲）
  const clientProto2 = new SocketProtocol(mkSocket(toClient2, toServer2));
  const buffered: VSBuffer[] = [];
  clientProto2.onMessage((f) => buffered.push(f));
  const serverProto2 = new SocketProtocol(mkSocket(toServer2, toClient2));
  new ChannelServer(serverProto2, "server").registerChannel("test", {
    listen: (_ctx, name) => {
      server2Listens += 1;
      const e = new Emitter<string>();
      setTimeout(() => e.fire(`s2-${name}`), 5);
      return e.event;
    },
    call: async () => "ok",
  });

  // resetTransport + 重放
  (client as unknown as { resetTransport: (p: unknown, f: VSBuffer[]) => void }).resetTransport(
    clientProto2,
    buffered.splice(0),
  );

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(server2Listens, 1, `重发 listen 到达新 server（got=${server2Listens}）`);
  assert.ok(got.some((g) => g.startsWith("s2-")), `客户端收到新 server 帧: ${got.join(",")}`);
});
