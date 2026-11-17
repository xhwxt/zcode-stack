# 手机 composer 裸 Enter 换行（发送只走发送键）

## 背景
手机直连 web 上，输入法软键盘的"回车"就是物理 Enter 事件。`enterSubmits=true`
时裸 Enter 直接触发发送，手机上无法输入多行内容。

## 规则
1. 判定唯一所有者：`isCoarseTouchDevice()`（`packages/ui/src/lib/pickerFocus.ts`，
   `(hover: none) and (pointer: coarse)`）。命中即视为手机触控设备。
2. `ConversationComposer` 的 `enterSubmits = !isCoarseTouchDevice()`：
   - 手机：裸 Enter 不发送，放行 Lexical 默认行为（插入换行/新段落）。
   - 桌面：Enter 发送行为与现状逐字节等价。
3. 发送键不受影响：send 按钮走 form submit（`ChatPromptEditor.handleSubmit`），
   不经过 `enterSubmits` 门禁；快捷键改绑的非 Enter 发送键同理
   （LexicalChatInput `handleNonEnterScopedKeydown` 不受视口门禁）。
4. Shift+Enter 在两端均为换行；`onModifiedSubmit`（反转投递）在手机上仍可用。
5. 判定在 composer render 时执行（非响应式）：设备触控属性运行期不变，
   无需订阅 matchMedia change；跨设备场景是整页重载，判定自然刷新。

## 验收
- 手机视口（hover:none + coarse）：输入文本按 Enter → 输入框内插入换行，消息不发送；
  点发送键 → 正常发送。
- 桌面（hover:hover）：Enter 发送、Shift+Enter 换行，与现状一致。
- typecheck / lint 通过。
