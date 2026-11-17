import assert from "node:assert/strict";
import test from "node:test";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ProtocolMessageType,
  type ISocket,
} from "../src/index.js";
import { ProtocolMessage, writeProtocolMessage } from "../src/protocol.js";

/**
 * 测试用对连线：返回两端 SocketProtocol 与「向指定端手工喂帧」的函数。
 * write 写出的帧按 wire 格式异步回放给对端（模拟真实 socket），
 * feed 则绕过 write 直接灌原始字节（用于构造异常/回显帧）。
 */
function createLoopbackPair(): {
  a: SocketProtocol;
  b: SocketProtocol;
  feedA: (frame: VSBuffer) => void;
  feedB: (frame: VSBuffer) => void;
} {
  const dataA = new Emitter<VSBuffer>();
  const dataB = new Emitter<VSBuffer>();
  const closeA = new Emitter<void>();
  const closeB = new Emitter<void>();
  const makeSocket = (incoming: Emitter<VSBuffer>, outgoing: Emitter<VSBuffer>): ISocket => ({
    onData: incoming.event,
    onClose: closeA.event,
    onEnd: closeA.event,
    write(buffer: VSBuffer) {
      setTimeout(() => outgoing.fire(buffer), 0);
    },
    end() {},
    drain() {
      return Promise.resolve();
    },
    dispose() {},
  });
  void closeB;
  const a = new SocketProtocol(makeSocket(dataA, dataB));
  const b = new SocketProtocol(makeSocket(dataB, dataA));
  return {
    a,
    b,
    feedA: (frame) => dataA.fire(frame),
    feedB: (frame) => dataB.fire(frame),
  };
}

function keepAliveFrame(ack: number): VSBuffer {
  return writeProtocolMessage(
    new ProtocolMessage(ProtocolMessageType.KeepAlive, 0, ack, VSBuffer.alloc(0)),
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

test("KeepAlive 探针恰好得到一次回显（一问一答，无风暴）", async () => {
  const { a, b } = createLoopbackPair();
  let aSeen = 0;
  let bSeen = 0;
  a.onKeepAlive(() => {
    aSeen += 1;
  });
  b.onKeepAlive(() => {
    bSeen += 1;
  });

  a.sendKeepAlive();
  await flush();
  // b 恰好收到 1 根探针；a 恰好收到 1 根回显——任何一侧出现第 2 帧即回显风暴。
  assert.equal(bSeen, 1, "对端应恰好收到 1 根探针");
  assert.equal(aSeen, 1, "探针方应恰好收到 1 根回显（不应再被回显）");
});

test("回显帧（ack=1）不再被回显", async () => {
  const { b, feedA } = createLoopbackPair();
  let bSeen = 0;
  b.onKeepAlive(() => {
    bSeen += 1;
  });

  // 直接向 a 灌一根回显帧（ack=1），验证 a 不回显——b 不应收到任何 KeepAlive。
  feedA(keepAliveFrame(1));
  await flush();
  assert.equal(bSeen, 0, "回显帧不应触发再回显");
});

test("Regular 消息收发不受 KeepAlive 处理影响", async () => {
  const { a, b } = createLoopbackPair();
  const received: string[] = [];
  b.onMessage((body) => received.push(Buffer.from(body.buffer).toString("utf8")));

  // SocketProtocol.send 只接受 VSBuffer（序列化由 ChannelClient 完成，测试直接给字节）。
  a.send(VSBuffer.fromString("hello"));
  a.sendKeepAlive();
  a.send(VSBuffer.fromString("world"));
  await flush();
  assert.deepEqual(received, ["hello", "world"]);
});

test("带 body 的 KeepAlive 帧：body 丢弃且不进 onMessage", async () => {
  const { b, feedB } = createLoopbackPair();
  let keepAlives = 0;
  let messages = 0;
  b.onKeepAlive(() => {
    keepAlives += 1;
  });
  b.onMessage(() => {
    messages += 1;
  });

  // 探针格式（ack=0）携带非空 body：应触发 KeepAlive 事件、body 不进 onMessage。
  feedB(
    writeProtocolMessage(
      new ProtocolMessage(ProtocolMessageType.KeepAlive, 0, 0, VSBuffer.fromString("junk")),
    ),
  );
  await flush();
  assert.equal(keepAlives, 1, "KeepAlive 事件仍应触发");
  assert.equal(messages, 0, "KeepAlive body 不得进入 onMessage");
});

test("分片到达的 KeepAlive 探针也能正确回显", async () => {
  const dataB = new Emitter<VSBuffer>();
  let echoed: VSBuffer | null = null;
  const socketB: ISocket = {
    onData: dataB.event,
    onClose: new Emitter<void>().event,
    onEnd: new Emitter<void>().event,
    write(buffer: VSBuffer) {
      echoed = buffer;
    },
    end() {},
    drain() {
      return Promise.resolve();
    },
    dispose() {},
  };
  const b = new SocketProtocol(socketB);

  // 把 13 字节帧拆成 5+8 两片喂入，验证 ChunkStream 攒齐后统一处理。
  const frame = keepAliveFrame(0);
  dataB.fire(frame.slice(0, 5));
  dataB.fire(frame.slice(5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(echoed, "应回显探针");
  const echoedFrame = echoed as VSBuffer;
  assert.equal(echoedFrame.readUInt8(0), ProtocolMessageType.KeepAlive);
  assert.equal(echoedFrame.readUInt32BE(5), 1, "回显帧 ack 必须为 1");
  void b;
});
