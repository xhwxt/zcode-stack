import { readFileSync } from "node:fs";
import { Emitter, VSBuffer, SocketProtocol, ChannelClient } from "<repo>/ZCode/packages/rpc/src/index.ts";
import { WebSocket } from "<部署目录>/node_modules/ws/wrapper.mjs";
const token = readFileSync("<数据目录>/.zcode-token", "utf8").trim();
const cap = await (await fetch("http://127.0.0.1:3030/api/rpc-host-capability?token=" + token, { method: "POST" })).json();
console.log("[host-test] capability OK");
const ws = new WebSocket("ws://127.0.0.1:3030/ws/host?token=" + token, { headers: { "x-zcode-rpc-host-capability": cap.capability } });
const onData = new Emitter();
const proto = new SocketProtocol({
  onData: onData.event,
  onClose: new Emitter().event,
  onEnd: new Emitter().event,
  write(b) { const buf = b instanceof VSBuffer ? b.buffer : b; console.log("[host-test] OUT:", buf.length + "B head=" + Buffer.from(buf.buffer ?? buf).slice(0, 13).toString("hex")); ws.send(buf); },
  end() { ws.close(); }, drain: async () => {}, dispose() { ws.close(); },
});
ws.on("message", (raw) => { const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); console.log("[host-test] IN:", b.length + "B head=" + b.slice(0, 13).toString("hex")); onData.fire(VSBuffer.wrap(new Uint8Array(b))); });
ws.on("open", () => console.log("[host-test] ws open"));
const client = new ChannelClient(proto);
client.whenInitialized().then(async () => {
  console.log("[host-test] INITIALIZED");
  try {
    const res = await client.requestPromise("settings-sync", "getSnapshot", [{}]);
    console.log("[host-test] RPC OK:", JSON.stringify(res).slice(0, 120));
  } catch (e) {
    console.log("[host-test] RPC ERR:", e.message.slice(0, 100));
  }
  process.exit(0);
});
setTimeout(() => { console.log("[host-test] TIMEOUT"); process.exit(2); }, 12000);
