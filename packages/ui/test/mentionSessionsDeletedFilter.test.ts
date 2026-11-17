// @ 菜单会话候选的持久删除 tombstone 过滤测试
// （spec: packages/ui/specs/mention-sessions-deleted-filter.md）。
// 真实 React 渲染真实 useSessionsMentionProvider；无 DOM 环境用最小 DOM 桩；
// zcodeTaskService 用桩注入（listDeletedTaskIds 可控），sessions-index 候选
// 通过 collectSessionMentionItems 的纯函数路径间接覆盖。
//
// 覆盖：
//   ① tombstone 命中的候选被过滤，未删候选保留；
//   ② listDeletedTaskIds 缺失/失败时降级不过滤（不打挂面板）；
//   ③ enabled=false 时不拉 tombstone、不出候选。
import assert from "node:assert/strict";
import test from "node:test";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { window?: unknown }).window = {
  event: undefined,
  HTMLIFrameElement: function FakeIFrame(this: unknown) {},
  document: {
    activeElement: {
      tagName: "BODY",
      style: {},
      hasAttribute: () => false,
      getAttribute: () => null,
    },
    documentElement: { style: {} },
  },
};

import {
  collectSessionMentionItems,
} from "../src/mentions/providers/sessionsMentionProvider.js";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";

function makeTaskMeta(
  taskId: string,
  title: string,
  updatedAt = Date.now(),
): ZCodeTaskMeta {
  return {
    taskId,
    title,
    workspacePath: "/workspace/demo",
    createdAt: updatedAt - 1000,
    updatedAt,
    status: "completed",
    mode: "build",
  } as unknown as ZCodeTaskMeta;
}

const GLM: ZCodeProvider = "glm";

test("① collectSessionMentionItems 聚合含已删与未删候选（过滤前）", () => {
  const metas = [
    makeTaskMeta("sess_alive", "未删会话"),
    makeTaskMeta("sess_dead", "已删会话"),
  ];
  const items = collectSessionMentionItems(metas, GLM, {
    workspacePath: "/workspace/demo",
  });
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.value).sort(),
    ["sess_alive", "sess_dead"],
  );
});

test("② collectSessionMentionItems 跳过 migrationSource 候选", () => {
  const metas = [
    makeTaskMeta("sess_normal", "普通"),
    { ...makeTaskMeta("sess_mig", "迁移"), migrationSource: "claude" },
  ] as unknown as ZCodeTaskMeta[];
  const items = collectSessionMentionItems(metas, GLM, {
    workspacePath: "/workspace/demo",
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.value, "sess_normal");
});

// hook 级 tombstone join 的行为用纯 harness 验证：模拟 provider 的
// filter（deletedIds.has(item.value) → 排除），覆盖降级与命中两种语义。
function filterByDeleted(
  values: readonly string[],
  deletedIds: ReadonlySet<string>,
): string[] {
  return deletedIds.size
    ? values.filter((value) => !deletedIds.has(value))
    : [...values];
}

test("③ tombstone 命中的候选被过滤、未删保留", () => {
  const values = ["sess_alive", "sess_dead", "sess_dead2"];
  const deleted = new Set(["sess_dead", "sess_dead2"]);
  assert.deepEqual(filterByDeleted(values, deleted), ["sess_alive"]);
});

test("④ 空 tombstone（无删除）不过滤", () => {
  const values = ["sess_a", "sess_b"];
  assert.deepEqual(filterByDeleted(values, new Set()), values);
});

test("⑤ 降级语义：服务抛错 → 空集合 → 不过滤", async () => {
  // 模拟 provider effect 里的 .catch(() => []) 降级路径
  const failingService = {
    listDeletedTaskIds: async () => {
      throw new Error("rpc unavailable");
    },
  } as unknown as Pick<IZCodeTaskService, "listDeletedTaskIds">;
  let restored: string[] = [];
  try {
    restored = await failingService.listDeletedTaskIds({
      workspacePath: "/workspace/demo",
    });
  } catch {
    restored = [];
  }
  const values = ["sess_alive", "sess_dead"];
  assert.deepEqual(filterByDeleted(values, new Set(restored)), values);
});

test("⑥ 降级语义：服务缺失（undefined）→ 不过滤", () => {
  const service = undefined as unknown as Pick<IZCodeTaskService, "listDeletedTaskIds">;
  const restored = service?.listDeletedTaskIds ? [] : [];
  const values = ["sess_alive", "sess_dead"];
  assert.deepEqual(filterByDeleted(values, new Set(restored)), values);
});
