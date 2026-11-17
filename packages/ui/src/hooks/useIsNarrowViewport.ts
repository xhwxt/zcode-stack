import { useEffect, useState } from "react";

export const NARROW_VIEWPORT_QUERY = "(max-width: 767.5px)";

// 抽屉模式的唯一判定来源：左右面板何时从流内分栏切换为浮层抽屉。
// 事件驱动而不是读取一次 innerWidth，避免旋转/软键盘弹出后判定过期。
export function useIsNarrowViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsNarrow(event.matches);
    };
    setIsNarrow(query.matches);
    query.addEventListener("change", handleChange);
    return () => {
      query.removeEventListener("change", handleChange);
    };
  }, []);

  return isNarrow;
}
