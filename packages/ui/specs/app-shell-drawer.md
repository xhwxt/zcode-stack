# app-shell 手机端抽屉化（左侧栏 + 右侧面板）

## 背景
直连 web 手机视口（<768px）下，左侧栏与右侧面板均为流内分栏，展开时挤压
会话区。需求：手机上全部改为叠层抽屉，会话区恒定全宽；
桌面端布局不变。左上角需有与右侧面板按钮对称的侧栏开合按钮。

## 规则
1. 窄屏判定唯一所有者：`useIsNarrowViewport`（matchMedia max-width: 767.5px，
   事件驱动，SSR 安全）。抽屉模式 = isNarrowViewport === true。
2. 抽屉模式下侧栏容器脱离 flex 流：`absolute inset-y-0 left-0 z-30`，
   宽度 = min(85vw, var(--workspace-sidebar-width))；滑入/滑出 200ms。
   会话列不再被分宽。拖拽分隔条在抽屉模式不渲染。
3. 抽屉模式下右侧面板不渲染 ResizableHandle/ResizablePanel，
   改为 `absolute inset-y-0 right-0 z-30 w-[min(85vw,480px)]` 滑入浮层；
   内容（tabs/browser/git/code-viewer）原样复用。45% 流内分栏不再生效。
4. 任一抽屉打开时渲染全屏半透明遮罩（z-20，bg-black/40），点击遮罩
   收起对应抽屉。遮罩属于 WorkspaceShellLayout，不进入内容组件。
5. 左上角侧栏按钮：DesktopTopOverlay 增加 web 分支（isDesktop 为 false
   时也渲染侧栏开合按钮），图标 PanelLeftClose/PanelLeftOpen，
   交互与右上角 WorkspaceSidePaneToggleButton 对称。
6. 状态所有者不变：isSidebarVisible / isSidePaneOpen 仍由 useAppPanels
   拥有；抽屉化只改渲染形态，不新增可见性状态、不复制开关命令。
   互斥收敛在状态所有者内部，双向对称，且**只在抽屉视口生效**
   （事件回调内实时读 NARROW_VIEWPORT_QUERY，非 hook）：
   - 抽屉视口下展开右侧面板（handleToggleSidePaneCollapse → !collapsed）
     时收起左栏；
   - 抽屉视口下打开左栏（handleToggleSidebar → visible=true）时收起
     右侧面板（setIsSidePaneCollapsed(true) + owner 偏好持久化，
     与顶部收起语义一致）。
   关闭方向（收起任一浮层）不做联动；宽视口（桌面/平板）左右可同开，
   与桌面分栏语义一致。理由：DesktopTopOverlay（z-40）悬在抽屉（z-30）
   之上，浮层按钮在任一抽屉打开时都可点击，互斥若只挂在部分入口上，
   按钮路径会重新造出双浮层叠加；而宽视口下不存在浮层抽屉，
   强制互斥反而破坏桌面「侧栏 + 面板同开」的原有行为。
7. 自动收起逻辑（CONVERSATION_AUTO_COLLAPSE_*）在抽屉模式下天然不触发
   （会话区恒全宽），保留原实现不动。
8. 桌面（isNarrowViewport=false）渲染路径与现状逐字节等价。

## 验收
- 390×844 视口：左右抽屉互斥不挤压会话区；点遮罩/按钮均可收起。
  任一抽屉打开时，左上角侧栏按钮/新建对话按钮点击后不产生双浮层叠加
  （开左栏 = 右抽屉收起；开右抽屉 = 左栏收起）。
- 桌面 1280×800：布局与改动前一致（截图对比）。
- typecheck / lint / architecture:check 通过。
