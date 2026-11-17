// webhook 回调入口鉴权收口的服务级测试。
// 直接驱动 createBotsService().handleProviderCallbackResponse（与 http.ts
// /api/bots/* handler 同一入口），fixture 用 setDataBaseDir 指向临时目录，
// 预置 bot-config.v3.json 与 credentials.json（真实 credentialService，
// ZCODE_CREDENTIAL_SECRET 固定使加解密在测试内自洽）。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBotsService } from "../src/node.js";
import { setDataBaseDir } from "../src/paths.js";
import { createCredentialService } from "../src/credential/credentialService.js";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import { DEFAULT_BOT_COMMANDS } from "@zcode/shared";
import type { IZCodeTaskService, IModelSelectionService } from "../src/index.js";

const SECRET_VALUE = "test-webhook-secret-0123456789";

interface Fixture {
  service: ReturnType<typeof createBotsService>;
  dataDir: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(
  bots: Array<Record<string, unknown>>,
  credentials: Record<string, string> = {},
): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-bots-webhook-auth-"));
  // setDataBaseDir 优先级高于 import 时固化的 env 读取（envDataBaseDir 在模块加载时
  // 取值，测试运行期再改 env 无效），且不污染其它并行读 HOME 的模块状态。
  setDataBaseDir(dataDir);
  const prevCipherSecret = process.env.ZCODE_CREDENTIAL_SECRET;
  process.env.ZCODE_CREDENTIAL_SECRET = "test-cipher-secret";

  const v2Dir = join(dataDir, ".zcode", "v2");
  await mkdir(v2Dir, { recursive: true });
  await writeFile(
    join(v2Dir, "bot-config.v3.json"),
    JSON.stringify({ version: 3, bots }),
  );
  // 凭据文件用同一 cipherProvider 加密写入（服务读到的就是明文 SECRET_VALUE）
  const cipher = createCredentialCipherProvider();
  const encrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    encrypted[key] = cipher.encrypt(value);
  }
  await writeFile(join(v2Dir, "credentials.json"), JSON.stringify(encrypted));

  const stubTaskService = {
    initialize: async () => ({ available: false }),
  } as unknown as IZCodeTaskService;
  const stubModelSelection = {
    getView: async () => ({ revision: 0, providers: [] }),
  } as unknown as IModelSelectionService;

  const service = createBotsService({
    credentialService: createCredentialService(),
    zcodeTaskService: stubTaskService,
    modelSelectionService: stubModelSelection,
    runStartupBackgroundTasks: false,
  });
  return {
    service,
    dataDir,
    cleanup: async () => {
      await service.disposeAllAndWait();
      setDataBaseDir(null);
      if (prevCipherSecret === undefined) {
        delete process.env.ZCODE_CREDENTIAL_SECRET;
      } else {
        process.env.ZCODE_CREDENTIAL_SECRET = prevCipherSecret;
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** webhook bot 的最小合法配置（botConfigSchema 必填集 + DEFAULT_BOT_COMMANDS）。 */
function webhookBot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bot-webhook",
    name: "测试 webhook bot",
    provider: "webhook",
    enabled: true,
    allowedWorkspaces: [],
    allowedCommands: { ...DEFAULT_BOT_COMMANDS },
    currentOptions: {},
    replyMode: "assistant_changes",
    ...overrides,
  };
}

test("webhook bot 未配置 secret → 401（fail-closed，匿名回调不再 200）", async () => {
  const fx = await makeFixture([webhookBot()]); // 无 webhookSecretRef
  try {
    const result = await fx.service.handleProviderCallbackResponse("webhook", {
      botId: "bot-webhook",
      userId: "attacker",
      text: "hello",
    });
    assert.equal(result.status, 401, `无 secret 必须拒绝（实际 ${result.status}）`);
    assert.equal(result.ok, false);
  } finally {
    await fx.cleanup();
  }
});

test("显式 botId 查无此 bot → 404（不泄露存在性）", async () => {
  const fx = await makeFixture([webhookBot()]); // 配置里只有 bot-webhook
  try {
    const result = await fx.service.handleProviderCallbackResponse("webhook", {
      botId: "bot-nonexistent",
      userId: "attacker",
      text: "hello",
    });
    assert.equal(result.status, 404, `未知 botId 必须 404（实际 ${result.status}）`);
    assert.equal(result.ok, false);
  } finally {
    await fx.cleanup();
  }
});

test("已配置 secret 的 webhook bot：错误 secret 仍按原语义拒绝（业务鉴权不变）", async () => {
  const fx = await makeFixture(
    [webhookBot({ webhookSecretRef: "bots/webhook/secret" })],
    { "bots/webhook/secret": SECRET_VALUE },
  );
  try {
    const result = await fx.service.handleProviderCallbackResponse("webhook", {
      botId: "bot-webhook",
      userId: "u1",
      text: "hello",
      webhookSecret: "wrong-secret",
    });
    // 原语义：secret 不匹配 → 推送 webhookSecretInvalid 回复、不执行业务
    //（ok 不变 false/503 与否不是判定点；判定点是回复内容里出现"校验失败"且不产生业务文本回复）
    const replyTexts = result.replies.map((reply) => reply.text ?? "").join("|");
    assert.ok(
      replyTexts.includes("Webhook secret 校验失败"),
      `错误 secret 应得到 webhookSecretInvalid 回复（实际：${replyTexts}）`,
    );
    assert.ok(!replyTexts.includes("hello"), "不得把匿名消息当作业务执行");
  } finally {
    await fx.cleanup();
  }
});
