import { WebSocket } from "<部署目录>/node_modules/ws/wrapper.mjs";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Emitter, VSBuffer, SocketProtocol, ChannelClient } from "<repo>/ZCode/packages/rpc/src/index.ts";

const SESSION = JSON.parse(readFileSync("<数据目录>/relay-state.json", "utf8"));
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32hex = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 255]; return ((c ^ -1) >>> 0).toString(16).padStart(8, "0"); };

const ws = new WebSocket("ws://127.0.0.1:3032/ws?mid=full-page-sim");
const onData = new Emitter();
let bridgeId = null;
let sendSeq = 0, sendMsgSeq = 0;
let initialized = false;
const assembler = new Map();

const onDataEvent = onData.event;
const proto = new SocketProtocol({
  onData: onDataEvent,
  onClose: new Emitter().event,
  onEnd: new Emitter().event,
  write(b) {
    sendSeq++; sendMsgSeq++;
    const bytes = b instanceof VSBuffer ? b.buffer : b;
    const payload = { zcode_type: "rpc-frame", bridgeSessionId: bridgeId, bridgeGeneration: 1, seq: sendSeq, messageSeq: sendMsgSeq, fragmentIndex: 0, fragmentCount: 1, messageBytes: bytes.length, checksum: { algorithm: "crc32", value: crc32hex(bytes) }, dataBase64: bytes.toString("base64") };
    console.log("[sim] OUT rpc frame:", bytes.length + "B head=" + bytes.slice(0, 13).toString("hex")); ws.send(JSON.stringify({ type: "data", payload, client_ts: Date.now() }));
  },
  end() { ws.close(); }, drain: async () => {}, dispose() { ws.close(); },
});
const client = new ChannelClient(proto);
client.whenInitialized().then(async () => {
  console.log("[sim] ChannelClient INITIALIZED over relay bridge");
  try {
    const res = await client.requestPromise("model-selection", "listModels", [{}]);
    console.log("[sim] RPC OK:", JSON.stringify(res).slice(0, 120));
  } catch (e) {
    console.log("[sim] RPC ERR (expected if method wrong):", e.message.slice(0, 100));
  }
  process.exit(0);
});

ws.on("open", () => ws.send(JSON.stringify({ type: "auth_init", role: "terminal", device_sid: SESSION.sid, meta: { platform: "web", version: "3.14.0", name: "mobile-browser" }, client_ts: Date.now() })));
ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.type === "auth_challenge") {
    const proof = createHmac("sha256", Buffer.from(SESSION.hash, "utf8")).update(Buffer.from(f.nonce + "|terminal|" + SESSION.sid, "utf8")).digest("base64url");
    ws.send(JSON.stringify({ type: "auth_response", device_sid: SESSION.sid, proof, client_ts: Date.now() }));
  } else if (f.type === "auth_ack" && f.pair_status === "matched") {
    ws.send(JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-request", requestId: "b1" }, client_ts: Date.now() }));
  } else if (f.type === "data") {
    const p = f.payload;
    if (p.zcode_type === "bootstrap-response") {
      console.log("[sim] bootstrap OK");
      bridgeId = "br-sim-1";
      ws.send(JSON.stringify({ type: "data", payload: { zcode_type: "workspace-bridge-open", requestId: "g1", bridgeSessionId: bridgeId, bridgeGeneration: 1, workspaceKey: "/" }, client_ts: Date.now() }));
    } else if (p.zcode_type === "workspace-bridge-ready") {
      console.log("[sim] bridge ready");
    } else if (p.zcode_type === "rpc-frame") {
      console.log("[sim] IN rpc-frame seq=" + p.messageSeq + " len=" + p.messageBytes);
      const fr = assembler.get(p.messageSeq) || { count: p.fragmentCount, parts: new Array(p.fragmentCount) };
      fr.parts[p.fragmentIndex] = Buffer.from(p.dataBase64, "base64");
      assembler.set(p.messageSeq, fr);
      if (fr.parts.every(Boolean)) {
        assembler.delete(p.messageSeq);
        const buf = Buffer.concat(fr.parts);
        ws.send(JSON.stringify({ type: "data", payload: { zcode_type: "rpc-frame-ack", bridgeSessionId: p.bridgeSessionId, ackMessageSeq: p.messageSeq }, client_ts: Date.now() }));
        onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
      }
    }
  }
});
setTimeout(() => { console.log("[sim] TIMEOUT - initialized=" + initialized); process.exit(2); }, 15000);
