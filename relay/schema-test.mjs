import { z } from "<repo>/ZCode/node_modules/zod/index.js";
const Zv = z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/u);
const Xv = z.number().int().nonnegative().max(2**53-1);
const Yv = z.number().int().positive().max(2**53-1);
const $v = z.object({algorithm:z.literal('crc32'), value:z.string()});
const ty = z.object({zcode_type:z.literal('rpc-frame'), bridgeSessionId:Zv, bridgeGeneration:Xv.optional(), recoveryId:Zv.optional(),
  seq:Yv, messageSeq:Yv, fragmentIndex:z.number().int().nonnegative().max(255), fragmentCount:z.number().int().positive(),
  messageBytes:z.number().int().positive(), checksum:$v, dataBase64:z.string().min(4)}).strict();
const mbLocal = z.object({bridgeSessionId:Zv, bridgeGeneration:Xv.optional(), recoveryId:Zv.optional(), kind:z.literal('local'), workspaceKey:z.string(), workspacePath:z.string(), initialTaskId:z.string().optional()});
const ready = z.object({zcode_type:z.literal('workspace-bridge-ready'), requestId:z.string(), bridgeSessionId:Zv, bridgeGeneration:Xv.optional(), recoveryId:Zv.optional(), bridge:mbLocal}).strict();

// relay 实际发出的 bridge-ready 帧含 recoveryId: null
const readyFrame = {zcode_type:'workspace-bridge-ready', requestId:'x', bridgeSessionId:'bridge-abc', bridgeGeneration:1, recoveryId:null, bridge:{bridgeSessionId:'bridge-abc', bridgeGeneration:1, recoveryId:null, kind:'local', workspaceKey:'/', workspacePath:'/'}};
const r1 = ready.safeParse(readyFrame);
console.log('bridge-ready(含null):', r1.success ? 'PASS' : 'FAIL ' + JSON.stringify(JSON.parse(JSON.stringify(r1.error.issues))).slice(0, 300));

const readyFrame2 = {zcode_type:'workspace-bridge-ready', requestId:'x', bridgeSessionId:'bridge-abc', bridgeGeneration:1, bridge:{bridgeSessionId:'bridge-abc', bridgeGeneration:1, kind:'local', workspaceKey:'/', workspacePath:'/'}};
const r2 = ready.safeParse(readyFrame2);
console.log('bridge-ready(省略null):', r2.success ? 'PASS' : 'FAIL');

const rpcFrame = {zcode_type:'rpc-frame', bridgeSessionId:'bridge-abc', bridgeGeneration:1, seq:1, messageSeq:1, fragmentIndex:0, fragmentCount:1, messageBytes:19, checksum:{algorithm:'crc32', value:'abcdef12'}, dataBase64:'AQAAAAAAAAAAAAAAAAAAAAEG'};
const r3 = ty.safeParse(rpcFrame);
console.log('rpc-frame:', r3.success ? 'PASS' : 'FAIL ' + JSON.stringify(JSON.parse(JSON.stringify(r3.error.issues))).slice(0, 400));
