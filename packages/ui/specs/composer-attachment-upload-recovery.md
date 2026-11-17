# 会话附件上传的断连自愈（直连页 / 手机场景）

## 背景
手机上添加附件时，若停留在系统文件选择器的时间较久，页面进后台被浏览器冻结，
WebSocket 断开；回到页面确认选择后上传失败。预期行为：文件选择动作不受断连影响，
恢复后上传自动完成。

## 根因
上传是分块事务（attachmentBegin/Chunk/Commit，走 agentService 的 WS RPC）。
断连时 in-flight chunk 收到 `ConnectionClosed`（fail-closed 语义），被
`isTransientAttachmentUploadError` 判为可重试，但：

1. 自动重试预算只有 **1 次**（`autoRetryCount < 1`）。弱网下软重连退避
   （0.5/1.5/4/8s）+ 8s 握手超时的组合，两次尝试都落在连接恢复前 → 终态 failed。
2. 失败即终止，与 runtime 换代的处理不对称：runtime 换代有
   `runtimeRebuildRetryCount`（限额 5）+ waitingSession 降级 + 会话可用后自动
   重新入队的完整自愈；断连没有。

## 规则
1. 断连类错误（`ConnectionClosed`、`handshake timeout`、其它 `fault.connection*`）
   一律视为 transient，复用既有 transient 判定/文案链路。
2. transient 自动重试预算与 runtime 换代对齐：`autoRetryCount < 5`
   （复用 COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT，不新增常量）。
   重试延迟保持 500ms；第 N 次失败仍落在断连窗口内则继续排队重试，预算耗尽才
   落 failed 终态。
3. 超限/权限/不支持等结构性错误（黑名单）保持立即 failed，不消耗重试预算。
4. 用户手动重试（点击失败的附件）不计入自动预算（入队时归零 autoRetryCount，
   维持现状）。

## 验收
- 手机：添加附件后停留在文件选择器 >30s（页面后台、WS 必断），回页面确认选择，
  上传应自动完成（期间状态可在 uploading/queued 间摆动），无需手动重试。
- 桌面/无断连环境：行为不变（transient 重试存在但通常一次成功）。
- 超限大文件：仍立即 failed，不重试。
