# 记忆查看器在自托管 web 直连页可用

## 背景

记忆查看器（设置 → 记忆 → 已保存的工作区记忆）此前被
`SettingsPage.tsx` 的 `projectMemoryViewerAvailable={Boolean(isDesktop)}`
硬性限制在桌面端：web 平台一律显示"记忆详情仅支持在本地桌面端查看"。

该限制与实际架构不符：

- 服务端 `createLocalServices`（`packages/services/src/node.ts`）已在本地
  服务集合注册 `IMemoryService`；
- `/ws` 通道通过 `services.exposeOnChannelServer` 把全部注册服务暴露给
  浏览器（`packages/server/src/http.ts` 的 `setupChannelServer`）；
- web 客户端 `RemoteServiceAccess`（`packages/client/src/remoteServiceAccess.ts`)
  已建立 `memoryService` 代理；
- 记忆服务读取 `<dataBaseDir>/cli/memories/projects`——自托管部署里这正是
  server 所在机器，即 Agent 实际写记忆的位置，不存在"读本机以外数据"的错位。

开关本身（`memoryEnabled`）走 `settingService.update`，web 端此前已可用。

## 产品规则

- 记忆查看器在桌面端与自托管 web 直连页均可用；`projectMemoryViewerAvailable`
  恒为 true。
- 目录与文件读取始终经由 `/ws` 通道的 `IMemoryService`（即 server 本机数据），
  与"Memory catalog 始终使用本地 Host"的原有语义一致。

## 状态所有者

- 开关状态：`settingService`（shared settings），web/桌面共用。
- 目录/文件数据：server 端 `IMemoryService` 只读扫描
  `<dataBaseDir>/cli/memories/projects`，无客户端缓存所有者。

## 接口

- 无协议改动；仅 UI 装配参数从 `Boolean(isDesktop)` 改为恒可用。

## 验收场景

1. 自托管 web 直连页（手机）打开 设置 → 记忆：不再出现"仅支持本地桌面端"
   提示；记忆开关下方出现工作区记忆查看器。
2. 记忆关闭时：只有开关，无查看器（原有行为）。
3. 桌面端行为不变：查看器照常可用。
4. 查看器中选择工作区/文件可正常读取内容（走 RPC）。
5. 点击任一记忆文件行：应用内弹出内容预览（readProjectMemoryFile 经 /ws
   通道读取 server 本机文件）；加载中显示加载态，失败显示失败态与重试。
   此前文件行不可点击，唯一入口是 WorkspaceEditorButtonGroup 的桌面编辑器
   （web 平台 openInEditor 明确返回 Not supported），手机上完全无法查看内容。
