import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { useState } from "react";
import { XIcon } from "lucide-react";
import {
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  type AttachmentHoverCardContentProps,
} from "@/components/ai-elements/attachments.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";

interface ContextAttachmentPillProps {
  children: ReactNode;
  contentAlign?: AttachmentHoverCardContentProps["align"];
  icon: ReactNode;
  label: string;
  onRemoveAll?: () => void;
  removeLabel: string;
  triggerProps?: Omit<HTMLAttributes<HTMLDivElement>, "children"> &
    Partial<Record<`data-${string}`, string | number>>;
}

// 触屏（无 hover 界面）上 Radix HoverCard 显式忽略 touch 指针
//（react-hover-card 的 excludeTouch），浮层打不开、附件详情不可达；触屏改用
// Popover 点击开合。判定沿用 SelectionActionMenu 等处的 "(hover: none)"
// 门控风格，惰性求值且 SSR 安全。
const isHoverNone = () =>
  typeof window === "undefined" ||
  typeof window.matchMedia !== "function" ||
  window.matchMedia("(hover: none)").matches;

export function ContextAttachmentPill({
  children,
  contentAlign = "start",
  icon,
  label,
  onRemoveAll,
  removeLabel,
  triggerProps,
}: ContextAttachmentPillProps) {
  // 设备级静态事实（hover 能力不随组件生命周期变化），useState 惰性初始化
  // 保证每次挂载取到当前设备状态且渲染间不抖动。
  const [touchMode] = useState(isHoverNone);

  // 触屏分支的键盘承接：div 上的 click 由 PopoverTrigger 接管开合，
  // Enter/Space 不会自动合成 click，这里显式补齐（Space 需阻断滚动）。
  const touchKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.currentTarget.click();
  };

  const pill = (
    <div
      {...triggerProps}
      aria-label={label}
      className={cn(
        "group flex h-8 max-w-full cursor-pointer select-none items-center gap-1.5 rounded-full border-0 bg-surface py-1.5 text-ui-base font-medium text-foreground transition-all hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        // 输入框与对话流共用该外壳，但只有输入框存在关闭按钮。
        // 无条件压缩右 padding 会让对话流 pill 视觉上偏右，因此按删除入口分流间距。
        onRemoveAll ? "pl-3 pr-1.5" : "px-3",
      )}
      role="button"
      tabIndex={0}
      onKeyDown={touchMode ? touchKeyDown : undefined}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {onRemoveAll ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          // 触屏没有 hover，opacity-0 的按钮不可见却仍接收点击：胶囊现在本身是
          // 点击目标，点右缘会静默"清空全部引用"。触屏常显（同引用条目单删按钮
          // 的既有处置），桌面保持 hover 浮现。
          className="size-5 shrink-0 rounded-full text-foreground-subtle opacity-100 transition-opacity hover:text-foreground group-hover:opacity-100 md:opacity-0 md:group-hover:opacity-100"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onRemoveAll();
          }}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );

  if (touchMode) {
    // 触屏：点击胶囊开合浮层。胶囊上 X 的 stopPropagation 挡住外层 toggle；
    // 浮层经 Portal 渲染，不在胶囊子树内，浮层里的按钮点击不会冒泡回胶囊，
    // 不会连带开合。删除后引用清空导致胶囊整体卸载、浮层随之关闭，属预期。
    return (
      <Popover>
        <PopoverTrigger asChild>{pill}</PopoverTrigger>
        <PopoverContent
          align={contentAlign}
          side="top"
          // 非模态 Popover 默认开时把焦点抢进浮层、关时移回胶囊，会打断输入框
          // 焦点（软键盘弹出/收起）；hover 路径焦点本就不动，这里保持一致。
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="w-80 rounded-xl border border-border bg-tooltip p-1 text-tooltip-foreground shadow-md ring-0"
        >
          <div className="max-h-64 overflow-y-auto">{children}</div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <AttachmentHoverCard>
      <AttachmentHoverCardTrigger asChild>{pill}</AttachmentHoverCardTrigger>
      <AttachmentHoverCardContent
        align={contentAlign}
        side="top"
        className="w-80 rounded-xl border border-border bg-tooltip p-1 text-tooltip-foreground shadow-md ring-0"
      >
        <div className="max-h-64 overflow-y-auto">{children}</div>
      </AttachmentHoverCardContent>
    </AttachmentHoverCard>
  );
}
