# 文档索引

本目录（`docs/`）汇总自托管 ZCode 的架构、部署与开发文档，以及仓库内其它规格与说明的位置。

**与上游的关系**：本仓是开源 `zai-org/ZCode`（Apache-2.0）的 fork，基线为 v3.14.3；自研改动
**直接落在上游文件里**（不是纯补丁式），因此"跟随上游"是行级判断——详见 `docs/development.md` §7。

**部署件占位符必须替换**：`deploy/`、`relay/` 等部署件为公开口径做了占位化，`<...>` 不是可直接
使用的值，照抄会起不来或静默降级；替换规则、路径与引号要求见 `docs/deployment.md` 第 0 节。

---

## 一、`docs/` 目录内的文档

| 文档 | 一句话说明 | 适合谁看 |
| --- | --- | --- |
| `docs/architecture.md` | 架构总览：这套自托管 ZCode 由哪些组件组成、职责边界、数据流、鉴权设计与已知陷阱 | 第一次接触本部署的人；改服务端/鉴权前 |
| `docs/deployment.md` | 部署与运维手册：占位符替换、拓扑与前置条件、安装配置、构建与更新、验证与回滚 | 在一台 Linux 服务器上从零部署/维护它的人 |
| `docs/development.md` | 开发与验证指南：目录结构、构建、测试门禁、代码约定、与上游的关系、已知边界与待办 | 在本仓写代码、改上游文件的人 |
| `docs/requirements.md` | 自托管改造的需求清单（需求本身；实现过程见提交历史） | 想了解"要解决什么"的人 |
| `docs/README.md` | 本索引 | 所有人 |

## 二、仓库其它文档

### 仓库根

| 文档 | 一句话说明 | 适合谁看 |
| --- | --- | --- |
| `README.md` | 仓库结构概览与敏感边界（keystore 与密码不入仓、磁盘上的设备凭据只存摘要） | 所有人（入口） |
| `AGENTS.md` | 仓库编码规则：核心原则、命令表、实现与验证要求、UI/协议/日志约定 | 动代码前；人与编码代理都适用 |
| `DESIGN.md` | UI 设计规范（含强制的排版尺度约定），改 UI 前先读 | 改界面的开发者 |
| `CONTEXT.md` | 插件商店（Plugin Store）领域词汇表 | 改插件商店相关 UI 前 |

### 手机壳与服务端协议

| 文档 | 一句话说明 | 适合谁看 |
| --- | --- | --- |
| `mobile/android/README.md` | APK 壳的结构/职责表、构建与签名流程、JVM 单测清单、已验与真机待验项 | 改 APK 壳、做发布的人 |
| `mobile/android/SPEC.md` | 壳的产品边界、状态所有者、安全与交互边界、逐条验收标准（英文） | 壳的设计评审与验收 |
| `mobile/handoff/zcode-device-credential-spec.md` | 设备凭据模型的需求规格（替换单 token；含端点与不变量），交付服务端/Web 侧 | 做服务端与壳协议对接的人 |

### 包内规格（`packages/*/specs/`）

| 文档 | 一句话说明 | 适合谁看 |
| --- | --- | --- |
| `packages/server/specs/device-credential-auth.md` | 鉴权的落地规格：六条不变量、凭据形态、TTL/错误码、管理端点、会话持久化与自愈、`/api/me` 扩展端点 | 改鉴权、加服务端端点前必读 |
| `packages/server/specs/selfhosted-web-pairing.md` | 单 token 时代的配对登录规格；其描述的模型已整体删除，仅作迁移背景参考 | 了解历史设计与迁移的人 |
| `packages/rpc/specs/socket-keepalive.md` | SocketProtocol 的 KeepAlive 探针/回显与 WS 半开判死机制 | 改 RPC、连接保活层的人 |
| `packages/ui/specs/web-recovery.md` | 直连页恢复三问题：header 标题偏移、滚动记忆持久化、软重连 | 改 web 恢复/滚动行为的人 |
| `packages/ui/specs/app-shell-drawer.md` | 手机端侧栏与右面板抽屉化（<768px 叠层、遮罩、互斥） | 改移动布局的人 |
| `packages/ui/specs/base-service-replace.md` | base service 换代的原地恢复（软重连不整树重挂） | 改连接换代/投影 store 的人 |
| `packages/ui/specs/composer-attachment-upload-recovery.md` | 附件上传的断连自愈（选择器期间断连后自动续传） | 改上传链路的人 |
| `packages/ui/specs/directory-browser-create-folder.md` | 目录浏览器"新建文件夹"能力与校验规则 | 改目录选择/文件服务的人 |
| `packages/ui/specs/memory-viewer-web.md` | 记忆查看器在自托管 web 直连页可用 | 改设置页/记忆服务的人 |
| `packages/ui/specs/mention-sessions-deleted-filter.md` | @ 菜单过滤已删除/已归档会话（接入 tasks-index tombstone） | 改 @ 菜单候选来源的人 |
| `packages/ui/specs/mobile-enter-newline.md` | 手机 composer 裸 Enter 换行、发送只走发送键 | 改输入框行为的人 |
| `packages/ui/specs/offpeak-notifications-web.md` | 闲时任务终态通知在桌面与 Web 双端启用 | 改通知逻辑的人 |
| `packages/ui/specs/settings-row-responsive.md` | 设置页 SettingsRow 的响应式布局（窄屏单列） | 改设置页布局的人 |

### 部署与验证辅助

| 文档 | 一句话说明 | 适合谁看 |
| --- | --- | --- |
| `deploy/e2e/README.md`、`e2e/README.md` | 连接恢复 E2E 脚本用法（半开黑洞、原地恢复、SW 缓存时序）；脚本仍以 `ZCODE_TOKEN` 配置入口，可能属旧鉴权模型残留，使用前先核对 | 验证连接恢复的人 |
| `config/README.md` | 内置默认配置与 `client/configs` 回退链（社群/反馈入口） | 改默认配置与社群入口的人 |
| `mobile/verify/` | 壳侧页面验证脚本（无头浏览器注入验证）；当前脚本仍以 `<数据目录>/.zcode-token` + `?token=` 进入页面，与现行设备凭据鉴权不符，需适配后再用 | 验证壳注入/主题/离线信号的人 |

## 三、维护约定

- **先改规格再改实现**：新增或修改行为前，更新对应 `packages/*/specs/*.md`（或新建），再动代码。
- **文档与实况保持一致**：命令、数字、版本号、测试数量以实际运行为准；文档过时就在同一改动里更正
  （当前已知过时项见 `docs/development.md` §8.4）。
- **不写敏感信息**：真实域名、主机路径、凭据、keystore 与密码一律不入文档；文档统一使用
  `<占位符>`（对照表见 `docs/deployment.md` 第 0 节）。
