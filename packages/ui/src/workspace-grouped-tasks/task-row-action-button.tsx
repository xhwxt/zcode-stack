import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

function TaskRowActionButton({
  label,
  children,
  className,
  onClick,
  showTooltip = false,
  disabledReason,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  showTooltip?: boolean;
  disabledReason?: string;
  testId?: string;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      // 触屏命中区：icon-sm 视觉 24px 固定盒（Button size-* 是 border-box，加 padding
      // 不扩命中区），max-md 下用 after 伪元素纵向外扩到 24×32（与 switch.tsx 同款思路）。
      // 这类按钮总是与相邻图标按钮只隔 gap-0.5/gap-1 并排，伪元素绘制在 DOM 前位兄弟之上，
      // 横向外扩会把左侧按钮的点击吃成本按钮（行头里即"点文件树却新建对话"）；
      // 纵向 ±4px 恰好补足行高触点且不出行，桌面零变化、不重排行布局。
      className={cn(
        "max-md:relative max-md:after:absolute max-md:after:-inset-y-1 max-md:after:inset-x-0 max-md:after:content-['']",
        className,
      )}
      disabled={Boolean(disabledReason)}
      // 行头点按判定（row-tap-activation）用该标记排除起始于操作区的 pointer：
      // 按钮 mousedown/pointerdown 的 stopPropagation 拦不住行头上的原生 pointer 监听。
      data-sidebar-row-action="true"
      data-testid={testId}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (!disabledReason) {
          onClick(event);
        }
      }}
      aria-label={label}
    >
      {children}
    </Button>
  );
  if (!showTooltip) {
    return button;
  }
  return (
    <ControlHintTooltip title={disabledReason ?? label} side="top" sideOffset={2}>
      {/* 本地 absolute tooltip 会被分组折叠容器的 overflow-hidden 裁剪；
          使用可接收指针的真实 trigger 包裹 disabled button，再由共享 Portal 渲染提示。 */}
      <span className="inline-flex shrink-0">{button}</span>
    </ControlHintTooltip>
  );
}

export { TaskRowActionButton };
