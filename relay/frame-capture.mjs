import { readFileSync } from "node:fs";
import { Emitter, VSBuffer, SocketProtocol, ChannelClient } from "<repo>/ZCode/packages/rpc/src/index.ts";
import { WebSocket } from "<部署目录>/node_modules/ws/wrapper.mjs";
const token = readFileSync("<数据目录>/.zcode-token", "utf8").trim();
const ws = new WebSocket("ws://127.0.0.1:3030/ws?token=" + token);
const onData = new Emitter();
const sent = [];
const proto = new SocketProtocol({
  onData: onData.event, onClose: new Emitter().event, onEnd: new Emitter().event,
  write(b) {
    const buf = b instanceof VSBuffer ? b.buffer : b;
    sent.push(Buffer.from(buf.buffer ?? buf).slice(buf.byteOffset ?? 0, (buf.byteOffset ?? 0) + buf.byteLength));
    ws.send(buf);
  },
  end() {}, drain: async () => {}, dispose() {},
});
ws.on("message", (raw) => { const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); onData.fire(VSBuffer.wrap(new Uint8Array(b))); });
ws.on("open", () => console.log("open"));
const client = new ChannelClient(proto);
client.whenInitialized().then(async () => {
  console.log("INIT");
  client.requestPromise("model-selection", "listModels", [{}]).catch(e => console.log("ERR:", e.message.slice(0, 80)));
  setTimeout(() => {
    console.log("请求帧数:", sent.length);
    for (const f of sent) console.log(f.length + "B:", f.toString("hex").slice(0, 90));
    process.exit(0);
  }, 4000);
});
setTimeout(() => process.exit(2), 12000);
