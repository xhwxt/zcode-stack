import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

const STICKY_GROUP_HEADER_EXIT_MS = 150;

export function StickyGroupHeaderSlot({ header }: { header: ReactNode | null }) {
  const [renderedHeader, setRenderedHeader] = useState<ReactNode | null>(header);
  const [visible, setVisible] = useState(Boolean(header));

  useEffect(() => {
    if (header) {
      setRenderedHeader(header);
      const animationFrame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(animationFrame);
    }

    setVisible(false);
    const timeout = window.setTimeout(() => {
      setRenderedHeader(null);
    }, STICKY_GROUP_HEADER_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [header]);

  if (!renderedHeader) {
    return null;
  }

  return (
    <div
      className={cn(
        // 退场 150ms 内 opacity-0 的透明层不能拦截点击：只在可见期接收指针，
        // 否则全宽不可见层会吃掉其下方（列表行）的触摸。
        "absolute left-0 right-0 top-0 z-20 pt-1",
        "transition-[opacity,transform] duration-150 ease-out motion-reduce:translate-y-0 motion-reduce:transition-none",
        visible
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none -translate-y-1 opacity-0",
      )}
    >
      {renderedHeader}
    </div>
  );
}
