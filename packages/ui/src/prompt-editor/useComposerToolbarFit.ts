import { useLayoutEffect, useRef } from "react";

/**
 * 手机直连 web 抽屉视口（<768px）：工具条恒定收成小图标档，不再走 overflow 梯度。
 * 修复依据（草稿态与运行态的模型控件呈现不一致）——
 * 草稿态比运行态少一个 context usage 图标（28px），同一 390px 视口下运行态
 * 溢出触达 model-icon 档而草稿态停在 provider-compact 档，同一屏两个状态
 * 模型控件呈现不一致。与抽屉视口共用同一判定（spec: packages/ui/specs/app-shell-drawer.md）。
 */
const NARROW_VIEWPORT_QUERY = "(max-width: 767.5px)";

function isNarrowViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches
    : false;
}

/** 仅拥有 DOM 布局投影；权限、Plan 和 CUA 业务状态仍由原有 hooks 管理。 */
function fitComposerToolbar(root: HTMLElement) {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return;
  const controls = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
  // 每次从完整布局测量，避免各按钮独立 observer 互相抢空间，也覆盖语言与异步入口变化。
  delete root.dataset.composerModelIcon;
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  // 窄屏视口：跳过 overflow 梯度，直接收成小图标档（草稿/运行态呈现一致）。
  // 注意：除模型/前缀两档外，还必须给全部 collapse-priority 控件（CUA、mode、
  // plan、think）置 composerCompact——否则权限/模式/思考深度保持文字展开
  // （实测：手机上"完全访问""最高"整串文字挤出工具条）。与宽屏
  // 梯度的最终态一致：所有可收控件都收。
  if (isNarrowViewport()) {
    root.dataset.composerProviderCompact = "true";
    root.dataset.composerModelIcon = "true";
    for (const control of controls) {
      control.dataset.composerCompact = "true";
    }
    const thought = root.querySelector<HTMLElement>("[data-composer-thought-control]");
    if (thought) thought.dataset.composerCompact = "icon";
    return;
  }
  const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
  const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 12;
  const overflow = () =>
    Math.max(
      0,
      content.getBoundingClientRect().width - available.getBoundingClientRect().width,
      trailing
        ? content.getBoundingClientRect().width +
            trailing.getBoundingClientRect().width +
            gap -
            root.getBoundingClientRect().width
        : 0,
    );
  // 前四档依次收起 Computer、mode、Plan、think 文字，不能合并裁决。
  for (const priority of ["0", "1", "2", "3"]) {
    if (overflow() <= 0) return;
    for (const control of controls) {
      if (control.dataset.composerCollapsePriority === priority) {
        control.dataset.composerCompact = "true";
      }
    }
  }
  if (overflow() <= 0) return;
  if (root.querySelector(".composer-provider-prefix")) {
    root.dataset.composerProviderCompact = "true";
  }
  if (overflow() <= 0) return;
  const thought = root.querySelector<HTMLElement>("[data-composer-thought-control]");
  if (thought) thought.dataset.composerCompact = "icon";
  // think 去掉绿条后重新测量；只差这点宽度时应保留完整模型名。
  if (overflow() <= 0) return;
  root.dataset.composerModelIcon = "true";
}

export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      if (!root.parentElement || root.getBoundingClientRect().width <= 0) return;
      // 在不可见副本上尝试展开，避免真实按钮测量时来回移动、丢失 hover 或关闭 Tooltip。
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${root.getBoundingClientRect().width}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        fitComposerToolbar(probe);
        for (const key of ["composerModelIcon", "composerProviderCompact"]) {
          if (probe.dataset[key]) root.dataset[key] = probe.dataset[key];
          else delete root.dataset[key];
        }
        const live = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        const measured = probe.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        live.forEach((control, index) => {
          if (measured[index]?.dataset.composerCompact) {
            control.dataset.composerCompact = measured[index].dataset.composerCompact;
          } else delete control.dataset.composerCompact;
        });
      } finally {
        probe.remove();
      }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(root);
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]",
      ))
        resize?.observe(element);
      update();
    };
    // 不观察布局属性自身，防止写 data-composer-compact 引起递归测量。
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    // 窄屏判定随视口/旋转变化：跨过 767.5px 边界时重算（窄屏直收 icon 档，宽屏走梯度）。
    const narrowQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(NARROW_VIEWPORT_QUERY)
        : null;
    const handleNarrowChange = () => update();
    narrowQuery?.addEventListener("change", handleNarrowChange);
    observe();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
      narrowQuery?.removeEventListener("change", handleNarrowChange);
    };
  }, []);
  return ref;
}
