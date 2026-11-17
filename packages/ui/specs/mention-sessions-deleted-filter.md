# @ 菜单会话候选过滤已删除/已归档会话

## 背景

@ 菜单的"会话"分组（`sessionsMentionProvider.ts`）从 v4 sessions-index
（`useWorkspaceSessionsIndexItems`，与侧栏同源）取候选。sessions-index 的
权威数据源是 CLI session store（`<数据目录>/cli/db/db.sqlite` 的 session 表），
该表**没有 deleted 列**——会话删除的持久语义落在 tasks-index.sqlite 的
`deleted=1` 行（tasks-index 是列表组织的权威，session store 只存会话本体）。

因此已删除会话仍满足 sessions-index 的可见条件（interactive、未归档），
继续出现在 @ 菜单候选里。

侧栏列表没有这个问题：`fetchTaskListMembershipSets` 会调
`zcodeTaskService.listDeletedTaskIds` 拉取 tombstone，`buildGroupedTaskViewFromSessions`
对命中行做负向过滤（"tasks-index 持久删除 tombstone；优先于所有列表 kind"）。
@ 菜单 provider 是唯一没有接入 tombstone 的 sessions-index 消费点。

## 产品规则

- 已删除会话（tasks-index `deleted=1`）不得出现在 @ 菜单会话候选中，
  与侧边栏行为一致。
- 已归档会话不得出现在 @ 菜单会话候选中，与侧边栏一致。归档的持久
  语义同样落在 tasks-index（archived 分区，`listArchivedTasks`），provider
  按 scope 平行拉取并把 taskId 并入同一负向集合；读取失败降级为该 scope
  不过滤（与 tombstone 同一降级纪律）。
- tombstone 读取按 scope（workspacePath + workspaceIdentity）与候选聚合
  使用相同的 workspace 集合；服务不可用（`listDeletedTaskIds` 缺失或 RPC
  失败）时**降级为不过滤**——宁多显示不可引用的候选，不因负向 join 失败
  把整个 @ 菜单打挂。
- 过滤作用于 mention 候选聚合阶段（`collectSessionMentionItems` 之后），
  不写入 Lexical node / canonical mention。

## 状态所有者

- 删除事实：tasks-index.sqlite（服务端权威，`listDeletedTaskIds` 只读暴露）。
- 归档事实：tasks-index.sqlite（服务端权威，`listArchivedTasks` 只读暴露）。
- 候选列表：sessions-index（会话本体事实源）。
- 过滤时机：provider 内 join；刷新跟随 `useTaskListMembershipVersion`
  （task_deleted/task_archived 等归属事件会 bump 该版本，与侧栏同一刷新信号）。

## 接口

- 无协议改动；`listDeletedTaskIds` 已存在（IZCodeTaskService，tasks-index
  实现 + RemoteServiceAccess 整服务代理，`/ws` 与桌面 channel 均可达）。

## 验收场景

1. 删除一个会话后打开 @ 菜单：该会话不再出现在"会话"分组（含搜索命中）。
2. 未删除会话照常出现；标题/排序行为不变。
3. 服务端 `listDeletedTaskIds` 不可用（老版本/异常）时：@ 菜单照常出候选
   （降级不过滤），不报错、不打挂面板。
4. 删除会话后不需要重启/整页刷新：task_deleted 事件 bump membership
   version，provider 重拉 tombstone 后下一轮候选即已过滤。
5. 归档一个会话后打开 @ 菜单：该会话不再出现在"会话"分组（含搜索命中）；
   取消归档后恢复出现（membership version bump 触发重拉，同场景 4 机制）。
6. 侧栏行为零变化（同一 tombstone/archived 机制，未触碰）。
