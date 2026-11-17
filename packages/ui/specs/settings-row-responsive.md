# 设置页 SettingsRow 响应式布局

## 背景
手机直连 web（视口 <768px）打开设置页时，`SettingsRow` 默认布局的控制列
固定 192px 且无断点回退。设置页窄屏内容列约 254px，扣除 192px 控制列与
gap 后标签列仅剩 ~46px，中文标签逐字竖排、控件悬浮错位。

## 规则
1. `SettingsRow`（`packages/ui/src/settings/SettingsPageParts.tsx`）是设置行
   布局的唯一所有者。默认（`controlLayout="default"`）与 `wide` 两种布局
   都必须窄屏单列、`sm:`（640px）起恢复双列网格：
   - default: `grid-cols-1 sm:grid-cols-[minmax(0,1fr)_192px]`
   - wide:    `grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px]`
2. 行内控件不得使用无断点回退的固定宽度（如裸 `w-[260px]`、`w-64`）；
   统一写成 `w-full min-w-0 justify-between sm:w-固定值`，窄屏占满单列，
   双列恢复后回到固定宽。
3. 桌面端（≥sm）渲染结果与改动前逐字节等价。

## 验收
- 390×844 视口：常规设置页所有行标签横排完整可读，控件占满单列宽度。
- 1280×800 视口：双列布局不变，控件 260px/192px/280px 宽度不变。
- typecheck / lint / architecture:check 通过。
