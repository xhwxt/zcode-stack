// 触屏行头「点按 vs 滚动/拖拽」判定共用的阈值：
// 位移 < 8px 才算点按（与 dnd-kit PointerSensor 的 activationConstraint.distance
// 一致；桌面鼠标行为不变）。
//
// 故意不设按压时长上限（触屏 400ms 上限不可取）：拖拽是否激活由 dnd 的
// {delay:400, tolerance:6} 决定——按住不动（无位移）永远不会激活拖拽，所以
// "按住很久但几乎没动就松开"（手机上常见的慢点按）就是一次点按，不该被吞掉。
// 时长本身不区分手势，真正区分滚动/拖拽与点按的只有三条判据：
// 位移 <8px、未被 pointercancel 打断、按压期间滚动容器未发生滚动。
export const SIDEBAR_ROW_TAP_DISTANCE_PX = 8;

export interface SidebarRowTapHandlers {
  /**
   * 判定为一个真实点按时回调（位移 < 8px、未被 pointercancel/scroll 取消；
   * 不设按压时长上限——按住不动不激活拖拽，慢点按就是点按）。
   * 参数是触发判定的 PointerEvent：行头同时保留桌面 click 通道的组件（grouped 组头）
   * 用 pointerType === "mouse" 区分两条通道，避免桌面双 toggle。
   */
  onTap: (event: PointerEvent) => void;
  /**
   * 手势期间的滚动取消通道：传入本行所在的滚动容器（或其祖先），容器在按压期间
   * 发生 scroll（含另一根手指/惯性滚动）时立即取消候选点按。不传则跳过该通道。
   */
  scrollContainer?: () => HTMLElement | null;
}

interface SidebarRowTapController {
  /**
   * 每次渲染调用，刷新 onTap / scrollContainer 闭包（纯字段赋值，不是 hook；
   * 本控制器绝不能内部调用 useRef/useMemo 等 React hook——它会被调用方包进
   * useMemo，工厂不重执行会导致挂载/更新两轮 hook 数不一致而崩溃）。
   */
  update(handlers: SidebarRowTapHandlers): void;
  /** 行头挂接点：在 ref 回调里调用；传 null 时摘掉监听与滚动取消通道。 */
  attach(node: HTMLElement | null): void;
}

/**
 * 行头点按判定控制器。用原生 addEventListener 而不是 React onPointerDown/up
 * props：行头 JSX 会展开 dnd-kit 的 {...listeners}（onPointerDown），React props
 * 同名覆盖会打掉我们自己的合成事件处理器（会让 tap 失效）；原生监听与
 * React 合成层互不干扰，dnd-kit 照常工作。键盘通道无冲突，仍走 onKeyDown。
 *
 * 判定规则：pointerdown 记录起点；pointerup 时位移 < 8px 且未被
 * pointercancel/scroll 打断才回调 onTap。不设按压时长上限（触屏 400ms 上限
 * 不可取）：按住不动不会激活 dnd 的 delay 约束拖拽，慢点按必须放行为点按。
 * - pointercancel：触屏滚动被浏览器抢占（touch-action:auto 下判定 pan）时派发，
 *   手势作废。
 * - scroll：按压期间滚动容器发生滚动（含另一根手指/惯性滚动）即时取消候选点按；
 *   覆盖"先点住再滚"和"手指几乎没动但列表因惯性滚动"两类漏网。
 * - 起始于行内操作区（data-sidebar-row-action 或原生交互元素）的 pointer 直接
 *   忽略：这些 pointer 归各按钮的 click 通道，不能被当成行头点按。
 *
 * 桌面鼠标：点按位移为 0，行为与原 click 等价；
 * 桌面滚轮滚动不产生行头 pointerdown，零影响。
 */
export function createSidebarRowTapController(initial: SidebarRowTapHandlers): SidebarRowTapController {
  let onTap = initial.onTap;
  let getScrollContainer = initial.scrollContainer;
  let rowNode: HTMLElement | null = null;
  let press: { x: number; y: number; pointerId: number } | null = null;
  let scrollNode: HTMLElement | null = null;

  const detachScroll = () => {
    if (scrollNode) {
      scrollNode.removeEventListener("scroll", handleScroll);
      scrollNode = null;
    }
  };

  const handleScroll = () => {
    if (!press) {
      return;
    }
    // 按压期间滚动容器发生滚动（非本指针触发的 pan 也会走这里）：
    // 手势语义已变成"滚动"，立即取消候选点按。
    press = null;
    detachScroll();
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    // 排除起始于行内操作区的 pointer（行尾 + 新建对话 / 文件树 / 菜单等）：
    // 这些按钮在 React 合成层对 mousedown stopPropagation，但本判定是行头上的
    // 原生 pointer 监听（挂得更"浅"，原生事件先冒泡过行头才到 React 根容器），
    // 按钮的 stopPropagation 拦不住它。不排除的话，点 + 会被当成行头点按先 toggle
    // 折叠，随后 click 通道的新建草稿又把行展开（activateTabByPath 的
    // ensureWorkspaceExpanded），表现为"先折叠再展开"的闪动。
    // 行内操作按钮统一挂 data-sidebar-row-action 标记。
    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest("[data-sidebar-row-action]") ?? target.closest("button, a, input, textarea, select, label"))
    ) {
      return;
    }
    press = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
    };
    const container = getScrollContainer?.() ?? null;
    if (container && container !== scrollNode) {
      if (scrollNode) {
        scrollNode.removeEventListener("scroll", handleScroll);
      }
      container.addEventListener("scroll", handleScroll, { passive: true });
      scrollNode = container;
    }
  };

  const handlePointerCancel = () => {
    // 滚动抢占（pointercancel）后不再有 pointerup：清掉起点，防止下一次
    // pointerup 用陈旧起点算出小位移。手势被取消 = 不是点按。
    press = null;
    detachScroll();
  };

  const handlePointerUp = (event: PointerEvent) => {
    const origin = press;
    press = null;
    detachScroll();
    if (!origin || event.pointerId !== origin.pointerId) {
      return;
    }
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    // 位移超限归滚动/拖拽，不是点按。不设时长上限：按住不动（位移 0）不会
    // 激活 dnd 的 delay 拖拽，"按住很久才松开"的慢点按就是一次点按。
    if (Math.hypot(dx, dy) >= SIDEBAR_ROW_TAP_DISTANCE_PX) {
      return;
    }
    onTap(event);
  };

  return {
    update(handlers) {
      onTap = handlers.onTap;
      getScrollContainer = handlers.scrollContainer;
    },
    attach(node) {
      if (rowNode === node) {
        return;
      }
      if (rowNode) {
        rowNode.removeEventListener("pointerdown", handlePointerDown);
        rowNode.removeEventListener("pointerup", handlePointerUp);
        rowNode.removeEventListener("pointercancel", handlePointerCancel);
      }
      rowNode = node;
      if (rowNode) {
        rowNode.addEventListener("pointerdown", handlePointerDown);
        rowNode.addEventListener("pointerup", handlePointerUp);
        rowNode.addEventListener("pointercancel", handlePointerCancel);
      }
      if (!rowNode) {
        detachScroll();
      }
    },
  };
}
