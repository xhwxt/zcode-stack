import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 统一鼠标、键盘和触控选区的监听；作用域变化后旧选区不能路由到新任务。 */
export function useTextSelection<T>({
  rootRef,
  enabled,
  inspect,
  scopeKey,
  observeSelectionChange = false,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  inspect: () => T | null;
  scopeKey: unknown;
  observeSelectionChange?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: unknown; value: T } | null>(null);
  const frameRef = useRef(0);
  const close = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current);
    setSnapshot(null);
    // 动作完成后同时收掉浏览器选区：只清 snapshot 时，安卓 WebView 的选中
    // 高亮和系统 ActionMode（复制/全选菜单）会一直挂着，表现为选完引用后
    // 仍保持长按状态、仍可继续点选。收起选区后 selectionchange 走 isCollapsed
    // 分支，ActionMode 由系统自动收回。
    //
    // 释放只针对本 hook 管辖的 root（时间线/预览面板）。键盘收起状态下长按
    // composer（contenteditable）时，WebView 让编辑区获焦弹 IME → 视口 resize
    // 走到这里；composer 选区不在 root 内，必须原样保留，否则正在成型的长按
    // 选择被清掉、手势作废（键盘半弹时选不成）。root 缺失或选区不可读时
    // 保守不动（只清 snapshot），绝不清空别处的选区。
    const selection = window.getSelection();
    const root = rootRef.current;
    if (
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      root &&
      root.isConnected &&
      selection.anchorNode != null &&
      selection.focusNode != null &&
      root.contains(selection.anchorNode) &&
      root.contains(selection.focusNode)
    ) {
      selection.removeAllRanges();
    }
  }, []);
  useEffect(() => {
    close();
    const root = rootRef.current;
    if (!root || !enabled) return;
    const schedule = () => {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        const value = inspect();
        setSnapshot(value ? { scopeKey, value } : null);
      });
    };
    const onKey = (event: KeyboardEvent) => (event.key === "Escape" ? close() : schedule());
    const onSelection = () => {
      if (window.getSelection()?.isCollapsed) close();
      else if (observeSelectionChange) schedule();
    };
    root.addEventListener("mouseup", schedule);
    root.addEventListener("touchend", schedule, { passive: true });
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onSelection);
    root.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      window.cancelAnimationFrame(frameRef.current);
      root.removeEventListener("mouseup", schedule);
      root.removeEventListener("touchend", schedule);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onSelection);
      root.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [close, enabled, inspect, observeSelectionChange, rootRef, scopeKey]);
  return {
    state: enabled && snapshot && snapshot.scopeKey === scopeKey ? snapshot.value : null,
    close,
  };
}
