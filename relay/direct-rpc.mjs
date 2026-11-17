import { readFileSync } from "node:fs";
import { Emitter, VSBuffer, SocketProtocol, ChannelClient } from "<repo>/ZCode/packages/rpc/src/index.ts";
import { WebSocket } from "<部署目录>/node_modules/ws/wrapper.mjs";
const token = readFileSync("<数据目录>/.zcode-token", "utf8").trim();
const ws = new WebSocket("ws://127.0.0.1:3030/ws?token=" + token);
const onData = new Emitter();
const proto = new SocketProtocol({
  onData: onData.event,
  onClose: new Emitter().event,
  onEnd: new Emitter().event,
  write(b) { const buf = b instanceof VSBuffer ? b.buffer : b; console.log("[direct] OUT:", buf.length + "B"); ws.send(buf); },
  end() { ws.close(); }, drain: async () => {}, dispose() { ws.close(); },
});
ws.on("message", (raw) => { const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); onData.fire(VSBuffer.wrap(new Uint8Array(b))); });
ws.on("open", () => console.log("[direct] ws open"));
const client = new ChannelClient(proto);
client.whenInitialized().then(async () => {
  console.log("[direct] INITIALIZED");
  try {
    const res = await client.requestPromise("model-selection", "getState", [{}]);
    console.log("[direct] RPC OK:", JSON.stringify(res).slice(0, 150));
  } catch (e) {
    console.log("[direct] RPC ERR:", e.message.slice(0, 120));
  }
  process.exit(0);
});
setTimeout(() => { console.log("[direct] TIMEOUT"); process.exit(2); }, 12000);
