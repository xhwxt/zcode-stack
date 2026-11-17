
// 终端侧 ChannelClient 模拟：连 server /ws（terminal-client 角色），走 Initialize → 列 channels → 调用
import { WebSocket } from "<部署目录>/node_modules/ws/wrapper.mjs";
import { SocketProtocol, ChannelClient } from "<repo>/ZCode/packages/rpc/src/index.js";

const ws = new WebSocket("ws://127.0.0.1:3030/ws?token=" + process.env.TOK, { headers: {} });
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
console.log("ws open");

const socket = {
  onData: undefined, onEnd: undefined,
  fire: null,
};
// 用 rpc 包里 wrapWebSocket 的等价物
import { Emitter, VSBuffer } from "<repo>/ZCode/packages/rpc/src/index.js";
const onData = new Emitter();
const onClose = new Emitter();
const onEnd = new Emitter();
ws.on("message", (raw) => { onData.fire(VSBuffer.wrap(new Uint8Array(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)))); });
ws.on("close", () => { onClose.fire(); onEnd.fire(); });
const isock = {
  onData: onData.event, onClose: onClose.event, onEnd: onEnd.event,
  write(b) { if (ws.readyState === 1) ws.send(b.buffer); },
  end() { ws.close(); }, drain: async () => {}, dispose() { ws.close(); },
};

const proto = new SocketProtocol(isock);
const client = new ChannelClient(proto);
console.log("waiting initialized...");
ws.on("message", (raw) => { const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); console.log("RAW frame:", b.length, "B head:", b.slice(0, 13).toString("hex")); });
await new Promise(r => client.whenInitialized().then(r));
console.log("INITIALIZED");
// 尝试列一个已知 channel 的方法：settings 或 model-selection
try {
  const result = await client.requestPromise("model-selection", "getState", [{}]);
  console.log("RPC OK:", JSON.stringify(result).slice(0, 200));
} catch (e) {
  console.log("RPC ERR:", e.message.slice(0, 150));
}
setTimeout(() => { console.log("TIMEOUT-EXIT"); process.exit(2); }, 12000);
