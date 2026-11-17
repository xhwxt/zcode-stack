/* 待回复摘要（/api/auth/probe 的 pendingDigest）纯函数测试。
 * 覆盖：userInput 取首题文本（拼选项 label）、permission 取 reason（空退工具名）、
 * sensitive 载荷省略正文、单行化与截断、无内容 → null。
 * 运行：pnpm --filter @zcode/services exec tsx --test test/pendingInteractionDigest.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodePermissionRequestParams, ZCodeUserInputRequestParams } from "@zcode/shared";
import {
  buildPermissionDigestText,
  buildUserInputDigestText,
  isSensitiveInteractionPayload,
  PENDING_INTERACTION_DIGEST_MAX_CHARS,
  PENDING_INTERACTION_SENSITIVE_PLACEHOLDER,
} from "../src/zcode-agent/zcodeAgentService.js";

function userInput(
  partial: Partial<ZCodeUserInputRequestParams> &
    Pick<ZCodeUserInputRequestParams, "requestId" | "sessionId">,
): ZCodeUserInputRequestParams {
  return partial;
}

function permission(
  partial: Partial<ZCodePermissionRequestParams> &
    Pick<ZCodePermissionRequestParams, "requestId" | "sessionId">,
): ZCodePermissionRequestParams {
  return {
    toolCallId: "call-1",
    toolName: "Bash",
    riskLevel: "low",
    input: {},
    options: [{ optionId: "allow", label: "Allow", kind: "allowOnce" }],
    ...partial,
  } as ZCodePermissionRequestParams;
}

/* ---------- userInput ---------- */

test("userInput：取首题文本，选项 label 用「/」拼上", () => {
  const text = buildUserInputDigestText(
    userInput({
      requestId: "r1",
      sessionId: "s1",
      questions: [
        {
          question: "用哪个日期格式化库？",
          header: "Library",
          options: [
            { value: "date-fns", label: "date-fns" },
            { value: "dayjs", label: "dayjs" },
          ],
        },
      ],
    }),
  );
  assert.equal(text, "用哪个日期格式化库？ date-fns/dayjs");
});

test("userInput：首题无选项时只用问题文本", () => {
  const text = buildUserInputDigestText(
    userInput({
      requestId: "r1",
      sessionId: "s1",
      questions: [{ question: "继续吗？", header: "确认", options: [] }],
    }),
  );
  assert.equal(text, "继续吗？");
});

test("userInput：多题只取第一题，不带计数后缀", () => {
  const text = buildUserInputDigestText(
    userInput({
      requestId: "r1",
      sessionId: "s1",
      questions: [
        { question: "第一题？", header: "A", options: [{ value: "y", label: "是" }] },
        { question: "第二题？", header: "B", options: [{ value: "n", label: "否" }] },
      ],
    }),
  );
  assert.equal(text, "第一题？ 是");
});

test("userInput：无 questions 时退 prompt", () => {
  const text = buildUserInputDigestText(
    userInput({ requestId: "r1", sessionId: "s1", prompt: "请补充说明" }),
  );
  assert.equal(text, "请补充说明");
});

test("userInput：无 questions 也无 prompt → null", () => {
  const text = buildUserInputDigestText(userInput({ requestId: "r1", sessionId: "s1" }));
  assert.equal(text, null);
});

/* ---------- sensitive ---------- */

test("userInput：顶层 sensitive 标记 → 固定占位，不含原文", () => {
  const request = userInput({
    requestId: "r1",
    sessionId: "s1",
    questions: [{ question: "请输入 API Key", header: "Key", options: [] }],
    // sensitive 不在 host 侧 params schema 里，但摘要函数按 schema 字段名防御式识别。
    sensitive: true,
  } as unknown as ZCodeUserInputRequestParams);
  const text = buildUserInputDigestText(request);
  assert.equal(text, PENDING_INTERACTION_SENSITIVE_PLACEHOLDER);
  assert.equal(text?.includes("API Key"), false);
});

test("userInput：sensitive 嵌在 input 子对象 → 固定占位", () => {
  const request = userInput({
    requestId: "r1",
    sessionId: "s1",
    prompt: "输入密钥",
    input: { sensitive: true, secret: "sk-xxx" },
  } as unknown as ZCodeUserInputRequestParams);
  assert.equal(buildUserInputDigestText(request), PENDING_INTERACTION_SENSITIVE_PLACEHOLDER);
});

test("isSensitiveInteractionPayload：仅 sensitive===true 判敏感", () => {
  assert.equal(isSensitiveInteractionPayload({ sensitive: true }), true);
  assert.equal(isSensitiveInteractionPayload({ input: { sensitive: true } }), true);
  assert.equal(isSensitiveInteractionPayload({ schema: { sensitive: true } }), true);
  assert.equal(isSensitiveInteractionPayload({ sensitive: false }), false);
  assert.equal(isSensitiveInteractionPayload({ sensitive: "true" }), false);
  assert.equal(isSensitiveInteractionPayload(null), false);
  assert.equal(isSensitiveInteractionPayload([{ sensitive: true }]), false);
});

/* ---------- permission ---------- */

test("permission：取 reason 作为摘要", () => {
  const text = buildPermissionDigestText(
    permission({ requestId: "r1", sessionId: "s1", reason: "需要执行 rm -rf build" }),
  );
  assert.equal(text, "需要执行 rm -rf build");
});

test("permission：reason 为空时退工具名", () => {
  const text = buildPermissionDigestText(
    permission({ requestId: "r1", sessionId: "s1", reason: "  ", toolName: "Bash" }),
  );
  assert.equal(text, "Bash");
});

test("permission：sensitive 标记 → 固定占位", () => {
  const request = permission({
    requestId: "r1",
    sessionId: "s1",
    reason: "写入凭证文件",
    input: { sensitive: true },
  });
  assert.equal(buildPermissionDigestText(request), PENDING_INTERACTION_SENSITIVE_PLACEHOLDER);
});

/* ---------- 单行化与截断 ---------- */

test("摘要折叠为单行（换行/制表符 → 空格）", () => {
  const text = buildPermissionDigestText(
    permission({ requestId: "r1", sessionId: "s1", reason: "第一行\n第二行\t第三行" }),
  );
  assert.equal(text, "第一行 第二行 第三行");
});

test("摘要截断到上限并以省略号结尾", () => {
  const long = "字".repeat(PENDING_INTERACTION_DIGEST_MAX_CHARS + 50);
  const text = buildPermissionDigestText(
    permission({ requestId: "r1", sessionId: "s1", reason: long }),
  );
  assert.ok(text);
  assert.equal(text.length, PENDING_INTERACTION_DIGEST_MAX_CHARS);
  assert.ok(text.endsWith("…"));
});
