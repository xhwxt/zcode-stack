# 自托管 ZCode —— 架构说明

面向第一次接触本部署的读者：说明这套自托管 ZCode 由哪些组件组成、各自的职责边界、
数据怎么流、鉴权怎么设计，以及已知的边界、权衡与陷阱。本文描述的是**当前实现的形态**，
不按时间顺序叙述演进过程。

**占位符约定**（本文与仓内其它运维文档统一使用）：

| 占位符 | 指代 |
| --- | --- |
| `<仓库根>` | 本仓库（ZCode fork）根目录 |
| `<工作区>` | 工作区根目录（含仓库、`mobile/`、`relay/`、`token-statusbar/`、`deploy/` 等） |
| `<部署目录>` | 运行时安装目录（web/server 构建产物与 `agent/`、`packages/` 在此） |
| `<数据目录>` | `ZCODE_DATA_BASE_DIR`，服务端运行时数据根（数据根 = `<数据目录>/.zcode`） |
| `<配置目录>` | 主机配置目录（systemd unit、管理密钥等；本文按 `/etc/zcode` 语义使用） |
| `<备份目录>` | 主机备份目录 |
| `<部署域名>` | 对外访问域名（HTTPS 入口） |
| `~/.zcode` | CLI/设置侧数据根（HOME 下的产品约定路径，与 `<数据目录>` 不是同一个根） |

---

## 1. 总览

### 1.1 这套部署是什么

自托管形态的 ZCode：把上游开源的 ZCode（AI 编程 agent 的 Web/桌面一体应用）改造成
**单人自用的、可供手机长期使用的服务器部署**。与官方托管的差别在于：

- 服务端、鉴权、账号、远控中转全部自持，不依赖官方云；
- 客户端是**手机浏览器 / 自研 Android WebView 壳**，不是桌面 Electron；
- 使用场景是"手机随身看/管"：看对话、收任务完成提醒、取回文件、开轻量预览。

部署由四类东西组成：

1. **服务端与前端**：上游 fork 构建出的 `packages/server` + `packages/web` 产物，由
   `zcode-web.service` 运行（连同常驻 agent 子进程），提供直连页、`/api/*` 与 `/ws` 真 RPC 通道。
2. **远控桥 `relay`**：让**官方闭源远控页**能跑在自托管服务上的本地中转（页面镜像 + 接口实现）。
3. **状态栏旁挂 `zusage`**：只读展示 token/用量状态栏的独立服务。
4. **手机壳（APK）**：Kotlin WebView 容器，负责设备凭据保管、会话注入、后台保活与通知。

另有一台 nginx（唯一公网入口）与一个 APK 分发服务；模型/推理网关属于外部链路，不在本仓库范围。

### 1.2 与上游的关系：fork，直接改上游文件

- 上游：`zai-org/ZCode`（Apache-2.0），本 fork 基线为 **v3.14.3（commit `29628c9`）**。
- 本 fork 采用**直接改上游文件**的形态，而不是"只在补丁里叠加"：`packages/ui`、
  `packages/services`、`packages/web`、`packages/server`、`packages/rpc`、`apps/zcode-cli` 等
  上游文件均有本项目的改动（改动量最大的单文件是
  `packages/server/src/deviceCredentialAuth.ts`）。
  - 因此"不动上游文案"是**行级**判断：在改过的文件里，上游原有行（含 i18n 字符串）保持逐字不变。
- 本仓库**不维护独立补丁集**：历史上曾有一份"把本仓库改动整体施加到干净上游树"的累积补丁
  （`zcode-selfhosted-web.patch` + 安装脚本）；在仓库已包含全部改动之后它成为冗余产物，
  且相对当时的树已打不上（陈旧），**已移除**。因此**本仓库本身就是唯一真源**：
  想复刻这套部署，直接使用本仓库即可，不需要再套一层补丁。
  `deploy/` 下的 unit / nginx 配置 / 部署脚本属**模板**（含占位符），
  使用前需按自己的环境替换。
- 仓库工程约束（`<仓库根>/AGENTS.md`）：新增或修改行为前先更新对应 spec；必须跑
  `pnpm typecheck` 与 `pnpm lint`（另有 `pnpm architecture:check --changed`、`pnpm knip`）；
  单文件 400 行上限（见 `.oxlintrc.json` 与 `architecture-policy.yaml`）。
  服务端逻辑规格在 `packages/server/specs/`，RPC 心跳规格在 `packages/rpc/specs/socket-keepalive.md`。

### 1.3 拓扑

```
手机壳 / 手机浏览器 / PC 浏览器
        │ 443（Let's Encrypt 证书）
        ▼
nginx（站点 <配置目录>/nginx/sites-available/zcode）
  ├─ ^~/app/                            → 3035 APK 分发服务（独立，404 即真 404）
  ├─ ^~/zusage/                         → 3033 zusage 状态栏旁挂
  ├─ =/login                            → 3030 内置配对页（/api/pairing/page）
  ├─ ^~/api/relay/                      → 3032 relay（一次性门票签发）
  ├─ ^~/web-remote、^~/remote/          → 3032 relay（官方远控页 + 资源镜像）
  ├─ ^~/api/remote-control/             → 3032 relay（bootstrap / bridge 等接口）
  ├─ ^~/ws/remote-control/              → 3032 relay（控制通道 WS）
  ├─ =/api/v1/client/configs            → 3032 relay（官方 UI 配置的本地镜像）
  ├─ ^~/api/admin/                      → 403（公网一律拒绝）
  └─ /（/、/api/*、/ws）                 → 3030 zcode-web
        │
zcode-web.service      127.0.0.1:3030  bin/zcode.mjs --web ...（鉴权在服务端代码内，无 --token）
zcode-relay.service    127.0.0.1:3032  relay-v29.mjs
zusage-sidecar.service 127.0.0.1:3033  zusage-sidecar.mjs
（APK 分发服务        127.0.0.1:3035）
```

所有服务本体只绑回环地址，公网访问**只能**经 nginx；这是"应用层鉴权是唯一闸门"的前提，
也是所有服务默认按"来自 nginx 的请求"处理转发头的原因（见 §3.5）。

---

## 2. 组件与职责

### 2.1 组件总表

| 组件 | 运行形态 | 职责 | 数据源 |
| --- | --- | --- | --- |
| nginx | 主机服务，唯一 443 入口 | 路由、TLS、注入脚本、管理面公网 403 | — |
| zcode-web | systemd，回环 3030 | 直连页静态资源、`/api/*`、`/ws` 真 RPC、设备凭据鉴权、任务列表通道 | devices/sessions JSON、tasks-index.sqlite、CLI 会话库 |
| agent（CLI） | zcode-web 的**子进程**（`app-server --stdio`） | Agent 运行时与会话执行 | CLI 会话库、rollout JSONL |
| relay | systemd，回环 3032 | 官方远控页本地伺服与桥接、门票签发、bootstrap 下发 | 远控页镜像、tasks-index.sqlite（只读） |
| zusage | systemd，回环 3033 | token/用量状态栏数据泵（只读） | CLI 会话库 `db.sqlite`（只读） |
| 手机壳 APK | Android 应用（WebView） | 设备凭据保管、会话注入、后台保活与通知、下载/上传衔接 | Android Keystore、SharedPreferences |
| APK 分发服务 | 回环 3035 | APK 下载（支持 Range）、受密钥保护的上传页 | APK 文件目录 |

### 2.2 nginx

职责与要点：

- **路由表**见 §1.3。`^~` 前缀匹配用于保证专用 location 不被 `location /` 吞掉；
  `/api/admin/` 用 `return 403` 做管理面的第二道闸（第一道在服务端，见 §3.6）。
- **页面注入**：对 `location /`、`^~/web-remote`、`^~/remote/` 三处用
  `sub_filter '</head>' '<script src="/zcode-boot-probe.js"></script><script src="/zusage/boot.js"></script></head>'`
  注入两个脚本（探针 + 状态栏数据泵）。两者解耦：停用状态栏不影响 SW 与诊断。
  - `proxy_set_header Accept-Encoding ""` 是 sub_filter 的硬要求（上游压缩后就匹配不到 `</head>`）；
    出站压缩由 nginx 的 gzip 负责，不冲突。sub_filter 默认只作用于 `text/html`，
    5.94 MB 的主 bundle 不会被扫描。
- **超时**：`location /` 的 `proxy_read_timeout`/`proxy_send_timeout` 为 3600s（长连 WS 保活）；
  relay 的远控页与接口段为 300s；`/ws/remote-control/` 为 3600s。
- **`X-Real-IP` 透传**：`/`、`/zusage/` 等段显式设置（限流按 IP 归属的前提；不透传则服务端退回
  socket 地址 = 127.0.0.1，所有人共享一个限流桶）。
- **证书**：Let's Encrypt 正式证书（非自签）。

### 2.3 zcode-web（server + web 构建产物）

入口是 `<部署目录>/bin/zcode.mjs --web`：校验管理密钥文件存在 → 以子进程方式拉起
`server/entry-http.js`，并把 `ZCODE_AGENT_SERVER_ARGS_JSON`（agent 入口 + `app-server --stdio`）、
静态根、workspace 等通过环境注入。**`--token` 已废弃且值被忽略**，鉴权恒开（见 §3）。

服务端（`packages/server/src/http.ts`，鉴权逻辑集中在 `deviceCredentialAuth.ts`）承担：

| 面 | 端点 | 说明 |
| --- | --- | --- |
| 元信息 | `GET /api/server-info` | `authRequired` 恒 `true`；宣告 workspace（`workspacePurpose:"conversation"` 用于"不在项目中工作"）与 capabilities |
| RPC 票据 | `POST /api/rpc-host-capability` | 一次性 capability 票（`/ws/host` 用） |
| 主实时通道 | `GET /ws` | 浏览器/手机的主 RPC 通道（`terminal-client` 角色） |
| 受信 host 通道 | `GET /ws/host` | capability 票 + Origin 校验；本部署无桌面客户端，无实际流量 |
| 远程连接 | `POST /api/connect-remote`、`GET /ws/remote/:id` | 一次性 id 桥接远程（ssh/docker/wsl）服务 |
| 机器人回调 | `POST /api/bots/:provider[/:botId]` | 业务鉴权用 `x-zcode-bot-secret` |
| 设备自助 | `/api/me/*` | 见 §3.3、§4.4 |
| 静态 | `GET *` | SPA fallback；`index.html` 与 `sw.js` 为 `no-cache`，其余 hash 资源 immutable；未登录访问入口页 302 到配对页 |

任务列表的数据源是 `tasks-index.sqlite`。桌面版该列表走"桌面 Host 独有的 window-controller
RPC 通道"，自托管 server 靠 `windowControllerShim.ts` 注册同名服务补齐；核心实现已下沉到
`packages/services/src/window-controller/`（desktop 与 server 只留 `resolveSource` 接线），
直连页因此获得与桌面同源的 live 事实（运行中/等待回答状态、pending interaction、真实 deltas、
gap resync、搜索片段）。

**订阅与连接同生命周期**：进程级单例的订阅表不随连接回收，会累积死订阅并按订阅数重复下发，
同时构成跨客户端信息泄漏。现实现给**每条客户端 WS 连接**建一个私有 attachment
（`createConnectionScope()` 注入 `window-controller` 频道），`socket.onClose` 即 `dispose()`；
同一 attachment 同 topic 重订阅 = 替换。回归测试在
`packages/services/test/windowControllerSubscriptionScope.test.ts` 与
`packages/server/test/windowControllerConnectionScope.test.ts`。

Agent 进程模型：**每个 workspace 一个常驻 CLI 进程**（进程内承载该 workspace 下全部会话），
由 `packages/services/src/zcode-agent/` 的进程管理器建表管理；不启用按墙钟的空闲回收
（见 §5.1）。

### 2.4 relay（官方远控页的本地桥）

官方远控页（`/remote/v4`）是闭源产物，原本只连官方云。relay 让它跑在自托管服务上：

- **页面离线化**：HTML 与资源镜像在本地目录，relay 本地伺服、miss 才回源；
  页面里硬编码的官方配置请求被重定向到本域（relay 用镜像的 `client-configs.json` 应答），
  实测无头浏览器对官方域 0 请求。升级 server 版本时需同步重镜像。
- **页面版本固定**：官方按 query `app_version` 下发不同版本的页面 bundle；版本不匹配时，
  页面端 display 判别 union 不认识新工具卡，一帧混入即整帧拒收（表现为 `recoveryFailed`）。
  relay 因此把 `app_version` 固定为与服务端配套的版本。
- **门票模式（v29）**：relay 入口去 token 化，三条入口链殊途同归到官方 bundle 要求的
  `?remoteControlToken=<票值>` 参数：
  1. 主链：已配对浏览器 `POST /api/relay/ticket`（relay 透传请求 Cookie 到 3030 校验）
     → 32 hex 一次性票（10 分钟）→ `GET /web-remote?ticket=<票>` → 消费后 302 到参数模式；
  2. 自助链：裸 `/web-remote` 且带有效会话 Cookie → 签发"签发即入场"的票并 302；
  3. 兼容链：`?remoteControlToken=<旧 token>` 过渡期仍可进，命中记 `legacy token entry`。
- **端点双因子**：`/api/remote-control/*` 与 `/ws/remote-control/*` 校验"路径值 == 已入场的有效票
  **且**请求带有效设备会话 Cookie"；票是入口引导凭据，Cookie 才是真凭据。
- **bootstrap**：任务列表与 workspace 由 relay 只读查询 `tasks-index.sqlite` 后下发
  （页面侧是严格 zod schema，见 §6.4）。
- **workspace-bridge**：把 `wsUrl`（指向本域 `/ws`，**不带 query token**）交给页面；
  页面随后原生建连、直接与服务端做 ChannelServer RPC —— 远控页的 RPC 与直连页走同一条链路。
- **mobile-view-state**：记住当前 workspace/任务，页面 reload 后回到原会话
  （与 workspace-bridge 回放 `initialTaskId` 的两处格式兼容代码不可删）。
- **恢复 shim**：注入远控页 HTML 的少量脚本，处理页面自身的 WS 生命周期
  （横幅 + 限频 reload）；它不碰对话内容。
- **本地凭据**：env `ZCODE_RELAY_LOCAL_SESSION`（一个系统设备的 deviceToken）用于
  `POST /api/auth/renew` 换会话，调 server-info 取 bootstrap；401 即标记失效并降级为空列表。

### 2.5 zusage（token 状态栏旁挂）

把 `zcode-token-usage-statusbar` 这个插件的数据用到网页上，独立于 ZCode 源码：

- 只读 CLI 会话库 `db.sqlite`（经强制只读包装：连接强制 `mode=ro` + `query_only`；
  上游实现有"只读失败回退可写句柄"的路径，必须由包装器拦住——ZCode 正在写这个库，
  不能有第二个写者）。
- 页面侧由 nginx 注入 `boot.js`（数据泵）+ `overlay.js`（渲染，窄屏一行 / 宽屏密集条）。
  数据契约是 `window.__zusageUpdate(payload)`；本会话靠页面 DOM 的 `[data-session-id]` 匹配，
  取不到就显示零值，**绝不串显别的会话**。
- 断点与页面同值（`(max-width: 767.5px)`），否则会出现"布局已切换、状态栏没切换"的错帧。
- 对页面 DOM 的**唯一写操作**是给输入框视觉卡片设 `marginBottom`（让位），其余全部只读。
- **鉴权**：不自己发凭据；把浏览器会话 Cookie 透传到 3030 校验（带正/负缓存，fail closed）。
  旧单 token 通道（`.zcode-token`）已不再使用。
- 出站脱敏：删除会话标题等可能泄露对话内容的字段；token/凭据不落盘。
- 回退不需要重启 zcode-web 或 relay（改 nginx 注入或停 sidecar 即可）。

### 2.6 手机壳（APK）

Kotlin WebView 容器（独立 Android 工程，包名与签名见 `mobile/android/README.md`；
壳工程**不在 git 内**，改动前需备份）。壳的职责刻意收窄为"承载页面 + 保管凭据 + 原生能力"：

- **加载远端 origin**（不是打包本地前端），所以前端可以独立于壳发版；`allowFileAccess` 关闭、
  禁明文流量、`cacheMode` 默认。
- **鉴权在壳内完成**：持久化设备凭据 + 进设备前 `renew` + 注入会话 Cookie（含 `__Host-` 变体）
  再加载页面；页面/WS 的全部应用逻辑仍归 Web 端。
- **`onResume` 刻意不 reload**（保会话与阅读位置），只静默续期。
- **页面 ↔ 壳单向信号**：主通道是 console 消息前缀，辅助通道是 `addWebMessageListener`；
  页面永远拿不到可调用的原生 API。用于主题跟随、长按侧栏跳转、任务计数（`task-started`/
  `task-finished`）与通知转发。
- **通知 shim**：WebView 没有 Web Notifications API，页面 `new window.Notification(...)`
  会被 shim 转成原生通知（渠道被单独关闭时视为不可用）。
- **前台服务（FGS）**：保活 + 30s 探针（`/api/auth/probe`，凭据在请求体）+ 常驻速览通知
  （运行中 / 待回复 / 空闲等文案映射），带电池优化豁免与开机自启。
- 复用第三方参考项目 `dsh-mobile`（Apache-2.0）的若干做法与文件（如 WindowInsets 移植），
  文件头已注明来源。

### 2.7 APK 分发服务

nginx `/app/` 指向独立的 3035 服务（支持 Range 断点续传；另有一个受 key 保护的上传页）。
**刻意不放进 ZCode server 的静态目录**：那边对 miss 做 SPA fallback（返回 `index.html`），
过期链接会被当成网页打开；独立服务里文件删了就是真 404。

### 2.8 数据与存储

| 状态 | 位置 | 所有者 / 生命周期 |
| --- | --- | --- |
| 设备注册表 | `<数据目录>/.zcode/devices.json`（600） | `deviceCredentialAuth.ts`；持久，重启不丢，含顶层 `instanceId` |
| 会话持久化 | `<数据目录>/.zcode/sessions.json`（600） | 同上；磁盘只有 `sha256(sessionToken)` 与 `csrfDigest`；过期会话不恢复 |
| 任务索引 | `<数据目录>/.zcode/v2/tasks-index.sqlite` | 任务列表唯一真相源（WAL）；直连页与 relay 同源 |
| 配对码窗口 | 内存 | 10 分钟、单次、只存摘要、**全局单窗口** |
| 会话表 / 限流表 / WS 注册表 | 内存 | 见 §3.2；会话表启动时从 sessions.json 恢复 |
| 管理密钥 | `<配置目录>/zcode-admin.secret`（600 root:root） | 与任何客户端凭据不同的一份秘密；每请求读文件，可轮换 |
| CLI 会话库 | `~/.zcode/cli/db/db.sqlite` | Agent 与 CLI 侧；`zusage` 与 `/api/me/usage-summary` 只读打开 |
| CLI 会话存档 | `~/.zcode/cli/rollout/*.jsonl` | Agent 侧转录 |
| 远控页镜像 | 本地镜像目录 | relay 伺服 |
| 旧单 token 文件 | `<数据目录>/.zcode-token` | 已退役；relay/zusage 现役实现不再读它（文件是否仍存在、是否仍有引用**待核实**） |

注意两个根不要混：`<数据目录>`（`ZCODE_DATA_BASE_DIR`，服务端运行时数据）与 `~/.zcode`
（CLI/设置侧）。物理删除一个会话需要三处一起清：tasks-index 行、CLI 会话库、rollout 文件。

写入纪律：`devices.json`/`sessions.json` 一律**原子写**（临时文件 `wx`+0600 → 结尾换行 → rename，
写前拒符号链接，加载限 1 MiB、权限非 600 时 chmod 自愈，写操作按 promise 链串行）；
结构非法**拒绝启动**（fail-closed），不静默跳过坏记录。

---

## 3. 鉴权与安全模型

### 3.1 威胁模型与不变量

唯一验收标准：**任何一份泄露的客户端凭据都只能冒充它所属的那一台设备，且可被单独吊销；
服务端磁盘上不存在可用于直接冒充的明文长期凭据。**

| 泄露面 | 攻击者得到 | 做不到 |
| --- | --- | --- |
| 浏览器 Cookie 被拷走 | 该浏览器那台设备的**短期会话** | 拿长期凭据、冒充其它设备、调管理接口 |
| 手机文件系统被读 | 该设备的设备凭据（Keystore，不可导出）或短期会话 | 伪造设备身份、逃避单台吊销 |
| URL 被截图/转发 | 无（长期凭据绝不进 URL） | — |
| 服务端磁盘被读 | 只有 SHA-256 摘要 | 反推凭据 |
| TLS 被破 | 该设备的短期会话 | 管理员能力 |

实现必须满足的不变量（`packages/server/specs/device-credential-auth.md`）：

1. 服务端只存**摘要**（SHA-256 hex），比较用常量时间；磁盘上不得出现明文 deviceToken。
2. 长期凭据只通过 `POST` 请求体传输，绝不进 URL、Cookie 名值、Referer、日志。
3. 长期凭据与会话凭据分离：Web/WebView 只承载短期 sessionToken（+ CSRF）。
4. 撤销是**按设备**的且立即生效：后续请求 401、**已建立的 WS 被主动关闭**、其它设备不受影响。
5. 管理操作（发配对码/列设备/撤销）只接受**本机 root-only** 通道，拒绝网络来源（含经 nginx 的请求）。
6. 设备之间零共享，且设备会话不能提升为管理权限。

### 3.2 凭据形态与生命周期

| 项 | 形态 |
| --- | --- |
| deviceToken / sessionToken / csrfToken | 43 字符 base64url（`randomBytes(32)`） |
| deviceId | 32 hex（`randomBytes(16)`） |
| instanceId | 64 hex，首次创建 `devices.json` 时生成并固化在文件顶层 |
| 配对码 | 12 字符 base64url（72 bit 熵） |

| 凭据 | TTL / 语义 |
| --- | --- |
| 配对码 | 10 分钟、单次、只存摘要、全局单窗口（发新码作废旧码） |
| deviceToken | 90 天**滑动窗口**（renew 顺延），自创建起 365 天绝对上限；连续 90 天不活动才失效 |
| sessionToken | `min(now+12h, deviceExpiresAt)`；renew 轮换（旧会话立即作废）；会话上限 16 条/设备，超出淘汰最旧 |
| 续期 Cookie | `zcode_device_renew`（值 = deviceToken，HttpOnly）；**只能调 renew**，不能访问业务面；泄露等级与壳内 Keystore 凭据同级 |
| 限流 | 三套独立计数、窗口 10 分钟、按 IP：redeem 100 次；renew、probe 各 600 次（表有界，见 §6.2） |

端点（客户端侧）：

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/pairing/redeem` | `{code,label?}` → 设备凭据 + 首个会话 + Cookie（**deviceToken 仅此一次回显**，手机壳原生 redeem 后照响应体告知的 Cookie 名注入 WebView） |
| `POST /api/auth/renew` | `{deviceToken}`（缺省回退续期 Cookie）→ 新会话（轮换）；更新 `lastSeenAt`、滑动顺延设备寿命 |
| `POST /api/auth/probe` | `{deviceToken}` → `{instanceId,deviceId,deviceExpiresAt}`（**无 reachable 字段，200 即可达**；不开会话） |
| `GET /api/pairing/page` | 配对页 HTML（页面 fetch 调 redeem），永远可访问（自救通道） |
| `POST /api/me/pairing-code` 等 `/api/me/*` | 设备自助管理（见下） |

错误码一律 `{error:"<code>"}`：配对码无效/过期/复用 → 403 `authentication_failed`（不区分，防枚举）；
未知/已撤销 deviceToken → 401 `authentication_failed`；受保护面区分 `device_revoked`/`device_expired`
（手机壳靠它切 UI 状态）；CSRF 头缺失/不匹配 → 403 `forbidden`；管理双闸未过 → 403；
限流 → 429 `rate_limited`；body 超 16 KiB → 413 `payload_too_large`。

### 3.3 配对、会话与自愈

- **启用条件（不允许裸奔）**：创建鉴权器时要求"管理密钥文件存在"**或**"`devices.json` 存在"，
  两者皆无则构造时抛错、服务启动失败；不存在"关掉鉴权"的配置。
- **撤销**：删除该条设备记录（不保留 tombstone）。顺序**不可反**：
  `devices.json` 落盘删记录 → 内存与 `sessions.json` 移除该设备全部会话 → 关闭其全部 WS
  （close code 4401）。撤销后保护面错误码退化为 `authentication_failed`（`device_revoked` 只在
  "崩溃残留：恢复的会话指向已消失设备"时出现）。
- **会话校验逐请求重查设备注册表**——这是撤销即时生效的机制保证，即使事件通知没跑到，
  任何带会话的请求都会因设备记录消失而被拒。
- **静默自愈（trySilentRenew）**：会话失效但请求带续期 Cookie 且设备健在时，服务端隐式执行一次
  renew 语义（顺延、发新会话 Cookie）并放行请求；SPA 入口页与 WS 升级同样受益
  （101 响应头带不进 `Set-Cookie` 无妨，客户端下一个普通请求即收到新会话 Cookie）。
  正常路径（会话有效）零开销；自愈不占显式 renew 的限流配额。
  **CSRF 校验位于自愈分支之前**：会话失效 + 续期 Cookie 的 mutating 请求一律 403，
  状态变更走显式 renew（公开豁免面、凭据在 body）。
- **临时设备**：发配对码可带 `ttlHours`（1–168）→ 设备 `temporary=true` 且寿命为固定小时数
  （忽略 90 天滑动窗口）；renew 只更新 `lastSeenAt`、不顺延、不重发续期 Cookie；
  临时设备访问 `/api/me/*` 一律 403（fail-closed）。
- **`/api/me/*`（设备自助管理）**：本设备维度的列表/撤销/改名/发配对码。会话必须有效、
  临时设备 403、POST 必须带 `x-zcode-csrf`（GET 不要求）。

### 3.4 Cookie 与 CSRF

成功配对/续期同时下发四条：`zcode_device_session` 与 `__Host-zcode_device_session`
（`Path=/; Secure; HttpOnly; SameSite=Strict`）、`zcode_device_csrf` 与 `__Host-zcode_device_csrf`
（同上但**非 HttpOnly**，供页面 JS 读取）。会话读取优先普通名、其次 `__Host-` 变体
（手机壳注入的是 `__Host-` 变体）。

- **保护面**：`/api/*` 与 `/ws*`；无/过期会话、设备撤销或过期 → 401（并下发过期 Cookie 清理）。
- **CSRF 强制**：保护面内所有**带 Cookie 会话**的 POST/PUT/PATCH/DELETE 必须带
  `x-zcode-csrf` 头，值与 `zcode_device_csrf` cookie 一致（比较在摘要层做常量时间）。
  GET/HEAD/OPTIONS 豁免（导航型请求不带自定义头；WS 升级是 GET 语义，由 Origin 白名单承担）。
- **豁免面**（不进保护中间件）：`redeem`/`renew`/`probe`（公开自救通道，凭据在 body，
  调用方无 Cookie）、`/api/pairing/page`、`/api/admin/*`（管理双闸，不认会话）、
  `/api/bots/*`（业务凭据是 bot secret）、`/ws/host`（capability 票）。
  **新增带 Cookie 的 POST 端点时必须带该头，或明确落入豁免面。**
- **应急回退开关**：env `ZCODE_CSRF_ENFORCE=0`（改 systemd 环境后重启生效）回到"只下发不强制"
  的旧语义；正常部署不需要，关着它就是留着 CSRF 未强制的洞。`/api/me` 通道的 CSRF 强制
  **不受**该开关影响。

### 3.5 WS 升级 Origin 白名单（CSWSH 主防线）

`/ws`、`/ws/host`、`/ws/remote/:id` 升级前校验 `Origin`（缺失时回退 `Referer` 的 origin）；
判定不过 → 403 `origin_not_allowed` 并记日志。

- **默认判定是"同源"**：Origin 的 host:port 必须与"本次请求视角"的 Host 一致
  （默认端口归一后比较）。不硬编码站点域名，任何自部署无需改源码。
- **反代头默认不被信任**：`X-Forwarded-Host`/`X-Forwarded-Proto` 默认被 nginx 原样透传、
  客户端可伪造，因此**只在显式设置 `ZCODE_TRUST_PROXY=1` 时**才作为请求视角的权威来源。
  开启的前提是部署侧先在 nginx 上显式 `proxy_set_header` 覆盖这两个头（**顺序不可反**：
  先 nginx、后服务端）。不开 TRUST_PROXY 时退回 Host 头判定，仍然安全（少一层交叉验证）。
- **显式例外**：本机调试入口（Origin host 为 localhost/127.0.0.1/[::1] 且端口属 {5173,3030}）；
  跨域部署用 env `ZCODE_WS_ALLOWED_ORIGINS`（逗号分隔）追加。
- **缺失 Origin/Referer 放行**：浏览器握手恒带 Origin 且页面 JS 不可伪造，"带 Origin 但不过判定"
  才是攻击形态；缺失 = 非浏览器客户端（CLI/本机工具），其 Cookie 获取与 Origin 无关，
  会话校验 + `SameSite=Strict` 仍是闸门。拒绝缺失只会误杀本机/CLI 合法客户端。
- 已登记的宽松面：scheme 降级（Origin `http` vs 请求 `https`）在默认端口归一下 authority 相同
  会判同源——浏览器 Origin 的 scheme 恒等于页面 scheme，该形态只在构造请求中出现，
  且有 `SameSite=Strict` + 会话校验兜底。
- 已建立的 WS 由撤销注册表与 30s ping 循环复验兜底（见 §4.1）。

### 3.6 管理面双闸

`/api/admin/*`（发配对码 / 列设备 / 撤销）必须**同时**满足：

1. **本机直连**：socket `remoteAddress` 属于回环；socket 是回环但 `x-real-ip` 声明外部来源
   （nginx 转发）→ 拒；无 socket（仅测试通道）时只信 `x-real-ip` 声明的回环；两者皆缺 → 拒（fail closed）。
2. **`x-zcode-admin` 头 == 管理密钥内容**（摘要层常量时间比较；密钥文件读失败视为无密钥 → 403）。

nginx 的 `location ^~ /api/admin/ { return 403; }` 是纵深防御的第二道闸——经 443 的请求
根本不进 3030。任一本机用户仍可通过命令行工具 `deploy/admin-cli.sh` 管理设备（root 本机 + 密钥，
密钥不进 argv/日志）。

### 3.7 旁挂服务的鉴权

| 服务 | 鉴权 |
| --- | --- |
| relay 接口/控制通道 | "有效票（或过渡期旧 token）**且**有效设备会话 Cookie"双因子 |
| relay 取数据（bootstrap） | 本地系统设备凭据换会话（`/api/auth/renew`），401 即降级为空列表 |
| zusage | 透传浏览器会话 Cookie 到 3030 校验（正/负缓存，fail closed）；不自己收凭据 |

### 3.8 已知信任假设与取舍

- **12h 会话 + 90 天滑动窗口**长于业界参考值（OWASP 对传统表单应用建议 idle 15–30 分钟）。
  可取之处是会话由可单独撤销的设备凭据随时换发、且封顶于设备寿命；压到 30 分钟只会导致频繁重配。
- **renew 不轮换 deviceToken**：长期凭据在原值上沿用至 90/365 天。泄漏的 deviceToken 在手动撤销前
  一直可用；单设备撤销与磁盘只存摘要是现有缓解，缺的是被动失效路径。
- **公网全量暴露**：应用层鉴权是唯一闸门（无 VPN/隧道层、nginx 无网络层限速/封禁）。
  因此每个新端点的鉴权语义都必须自查——历史上同类产品的洞集中在"某个端点忘了挂中间件"。
- **设备自助端点**允许已配对设备把任意**真实存在**的目录注册进下载/预览根集合（上限 64、
  注册即 realpath 归一）。即"已配对设备 ≈ 可读其所在账号全部 workspace"这一档；若要压缩到
  "仅启动时宣告的根"，应改为服务端白名单收口。
- **bots webhook 豁免面**：webhook bot 未配置 secret → 401（fail-closed）；显式 botId 查无此 bot → 404。
- 管理密钥与任何客户端凭据是两份不同的秘密；密钥文件路径可由 `ZCODE_ADMIN_SECRET_FILE` 指定。

---

## 4. 数据流

### 4.1 页面 ↔ server（直连页）

```
页面启动 ── GET /api/server-info（会话鉴权，拿 workspace 与 capabilities）
         └─ new WebSocket(/ws)（浏览器握手带 Origin → Origin 白名单 → 会话校验）
              └─ SocketProtocol：13 字节帧头 │type(1)│id(4)│ack(4)│length(4)│body│
                   └─ ChannelServer/ChannelClient：按 channel 暴露服务（RPC 与事件订阅）
                        └─ 订阅会话 topic：携 base={logEpoch,seq} 水位
                             ├─ 在保留窗内 → resume（重放 delta）
                             └─ 越界/断档 → snapshot（仅带 60 行尾窗，更早历史走 rows/range 分页）
```

存活检测（两层）：

| 层 | 参数 | 判死动作 |
| --- | --- | --- |
| 客户端协议层 | 15s 发 KeepAlive 探针；30s 无任何帧判死 | 先触发 `onHeartbeatDead` **再** close（顺序不可反：监视器自己的 close 是干净关闭，会被守卫当"主动登出"跳过） |
| 页面守卫 | 回前台用**同 socket 活性**判定（`lastReceivedAt` 20s 内算健康；过期补发探针等 3s 回显） | 判死走软重连：1/2/4/8s 退避原地重建连接（React 树不重挂），退避耗尽才整页 reload |
| 服务端 | RFC 6455 ping，30s 一次、连续 4 个周期无 pong → terminate | 清理服务端半开 + 触发浏览器 close → 客户端软重连 |
| 服务端 ping 循环顺带 | 每周期 `wsGuard.assertValid`（会话过期/设备撤销/临时设备到期） | 失败即 close(4401) |

**为什么必须"同 socket"判定**：半开是 **per-connection** 的——HTTP `fetch`（换连接）或另开一个 WS
都测不出当前这根已经死了。历史实现用 `/api/server-info` 探测 + 4s 超时，恰好落在"HTTP 通、socket 死"
的盲区里，页面看着正常、所有新 RPC 静默失败。同类坑还有：编辑过的文件打不开（附件是多次往返的
分块读）、握手结果按 service 对象身份缓存（旧 service 直接复用当年那次握手）。

服务端这条 ping 同时覆盖远控页——relay 只是把 `wsUrl` 交给页面，远控页的 RPC 也是页面直连 server `/ws`。

### 4.2 relay 的门票链与双通道

```
浏览器 ── POST /api/relay/ticket ──▶ relay（透传 Cookie 到 3030 校验）→ 32hex 一次性票
       ── GET /web-remote?ticket=… ─▶ relay 消费票 → 302 → /web-remote?remoteControlToken=<票>
                                         │
远控页加载（本地镜像）◀────────────────┘
   ├─ GET /api/remote-control/windows/bootstrap/<token> → relay 只读 tasks-index.sqlite → 任务列表
   ├─ WS  /ws/remote-control/window/<token>            → 控制通道（window-control-ready）
   └─ POST /api/remote-control/windows/<token>/workspace-bridge → 返回 wsUrl（本域 /ws）
         └─ 页面原生建连 server /ws（会话 Cookie）→ 与直连页同源的真 RPC
```

- relay 的角色是"页面宿主机 + 数据源 + 入口鉴权"：**不保存**任务队列/快照等业务状态，
  任务列表是只读查询，view-state 只在内存。
- 上传等 HTTP 请求走 `workspace-bridge` 同域接口（nginx 转发到 relay），因此**整页重载会把
  `<input type=file>` 已选中的文件丢掉**——远控页的"断连即刷新"体验问题由此被放大。

### 4.3 手机壳的凭据与注入

```
配对（壳内原生）：POST /api/pairing/redeem → deviceToken 存 Android Keystore（不可导出，AES-GCM）
                                           → deviceId/label/expiresAt/instanceId 存普通偏好
进设备：读 Keystore → POST /api/auth/renew → CookieManager.setCookie(会话 + CSRF，含 __Host- 变体)
        → 再加载页面（保证导航前会话已注入）
续期：onResume 会话临近到期静默续期（不 reload）；401 device_revoked → 「电脑端已移除」+ 重新配对
后台：FGS 每 30s POST /api/auth/probe（凭据在 body，不经 Cookie）
      → 差分出完成/待回复 → 原生通知（可选卡片正文来自 probe 的 pendingDigest）
```

要点：

- 长期凭据**永不进 URL/WebView 存储**；短期会话 token 也永不落盘（每次现换）。
- 同一 origin 上多设备的 Cookie 是**按 origin 共享**的：切设备必须先 renew 该设备的会话并注入其
  Cookie（覆盖上一条），否则会出现"切过去还是上一台的登录态"。
- 探针凭据在请求体、不在 Cookie——**不能**用浏览器会话来复刻 probe（只会 401）。
- 壳侧链接校验只接受 HTTPS、受限路径与受控 query（凭据外发守卫）；错误文案不回显输入。

### 4.4 下发与更新

- **Web**：Service Worker 策略为"导航 network-first、hash 资源 cache-first、入口与 `sw.js` no-cache、
  注入脚本 network-first"。SW 版本串是构建时把源文件里的 `__SW_CACHE_VERSION__` 占位符替换成
  构建时刻 UTC 戳（`sw.js` 与探针同值），SW 注册的唯一入口是注入的探针脚本。
- **壳**：WebView 加载远端 origin，壳本身不含前端逻辑；`onResume` 刻意不 reload，
  也**没有**"检查更新 + 择机刷新"的替代路径 → 更新检查只在导航时发生，而壳几乎不导航。
  这是"长时间跑旧前端"的机制根因（见 §5.4）。
- **APK**：目前是手动链路（下载 → 点开安装，需允许未知来源）。侧载分发不受商店政策约束。

### 4.5 实测流量口径（用于回归对照）

| 指标 | 实测值 |
| --- | --- |
| 修复订阅泄漏前 / 后（同一口径） | 152.5 KB/s → **5.9 KB/s**；`controller/tasks-index` 订阅数 423 → 1，duplicateFactor 414.5 → 1.00 |
| 后续整包复测 | 约 11.6 KB/s（含页面加载一次性突发；稳态 2–5 KB/s + 偶发配置快照） |
| 冷订阅首帧 snapshot | 218–251 KB（60 行尾窗含工具输出；另有 provider 模板快照 ~99 KB、providers 配置快照 ~24.7 KB） |
| 静态资源 | 主 bundle 5.94 MB，nginx gzip 后约 1.67 MB；WS 帧**不压缩** |
| 半开判死恢复 | 黑洞场景 30–40s 内自动软重连，无整页 reload；真机断网 close→新连接 6.1–7.3s |

---

## 5. 已知边界与设计权衡

### 5.1 会话 / 进程生命周期

- 形态：**每个 workspace 一个常驻 CLI 进程**，进程内承载该 workspace 下全部会话；
  会话状态落盘（CLI 会话库 + rollout + tasks-index），"进程死 ≠ 会话死"。
- 已裁定：**去掉按墙钟的空闲回收**，保留常驻；内存兜底交给真实资源压力（实测服务端 cgroup
  常驻 2 GB 量级、峰值 3 GB 量级，未发生 OOM）。不采用"会话按需起停 + 从磁盘恢复"。
- 理由（对照业界）：主流 agent 工具没有一家用"常驻 supervisor + 纯内存会话 + 墙钟回收 + 快照重建"；
  全部把会话状态放盘上、把进程当作执行载体。墙钟回收的判据缺口在于"有客户端正在看"不计入，
  纯阅读的客户端会被误判空闲而触发重建（表现为横幅连闪、滚动位置变化）。
- 残留边界：server 重启会打断进行中的对话，`tasks-index` 可能留下 `status=running` 的孤儿行
  （需手工订正）；会话级删除要三处一起清。

### 5.2 移动端后台

- 网络层：无 FCM（自托管无法使用官方推送通道）；Android Doze 会"suspend network access"，
  官方形态是"后台无常驻实时通道 + 高优先级推送唤醒"，此处改用**前台服务 + 轮询**换后台存活。
- 代价：常驻通知、耗电、厂商 ROM 兼容性。实测厂商冻结会造成 39s/83s/182s 的探针空档
  （整进程被冻结，连 Handler 时钟一并停摆），冻结期间完成的任务通知会**迟到**而不是丢失
  （差分基线还在）。这是该形态的固有上限，不是 bug。
- 通知链单点依赖：WebView `onPause` 后页面 JS 停摆（原生通知 shim 失效），后台通知 100% 依赖
  FGS 探针差分；探针被冻结/401/无凭据时通知链即断。
- 轮询地板：WorkManager 周期任务最小 15 分钟、Doze 下 AlarmManager 约 9 分钟/次——
  **都不是"提醒"级**，只能当进程死后的迟到补报。
- 前台服务类型：运行时用 `specialUse`（无时长配额）；Manifest 里保留的 `dataSync` 分支只在
  低版本设备生效，**不要**把它简化成唯一运行时类型（Android 15+ 的 6h/24h 平台配额与
  BOOT_COMPLETED 限制会直接打崩，且平台行为不分发渠道）。

### 5.3 传输层

- 单一 WebSocket（无 SSE/长轮询回退）：自控两端、单人自部署，无企业代理兼容压力，
  与业界"WS 优先"一致。
- **零压缩**：ws 库服务端 `perMessageDeflate` 默认关闭，JSON 帧原样过网；移动蜂窝下
  首帧与稳态流量均按 3–8 倍白付。开启 `permessage-deflate`（配 `serverNoContextTakeover`）
  是协议零改动的小改法，尚未做。
- **协议层重放层未接线**：`PersistentProtocol`（未 ACK 消息重放 + 拥塞水位，缓冲上限 8 MiB、
  时间宽限 45s）全仓只有桌面 remote 一处使用；浏览器/手机主链路的 `/ws` 走**裸 `SocketProtocol`**
  （`packages/server/src/http.ts` 中 `new SocketProtocol(socket)`）。后果：每次切网/短断都要走
  "断→重连→重握手→携水位重订阅"整条链，恢复成本高于业界同类（SignalR 的 stateful reconnect、
  SSE 的 `Last-Event-ID` 都是有界重放）。语义层的水位裁决（保留窗 2000 条、logEpoch 代际、
  原子 snapshot 回退）成熟度不低，缺的只是传输层重放这一环。
- 心跳有三套参数（服务端 RFC6455 ping 30s×4、客户端协议层探针 15s/30s、PersistentProtocol
  内部 5s/20s）；两端参数独立演化，改动须两端联动。

### 5.4 版本下发与可见性

- SW 更新检查只在**导航**时发生；壳刻意不 reload-on-resume + 前台服务保活 → 单页生命周期极长，
  检查点几乎不出现 → 用户长时间停留在旧前端。
- 发布是 `rsync --delete` 原地覆盖（非原子），且立即删除旧 hash 资源 → 仍在运行旧页面的客户端
  lazy chunk 会 404（表现为"某功能突然坏"）；回滚 = 整目录拷回 + 重启。业界做法是
  `releases/<ts>/ + current symlink` 原子切换、保留上一版资源。
- 缺少"更新可见性三件套"：更新条幅、UI 版本显示、版本遥测。`/api/server-info` 已带
  `version/protocolVersion/capabilities`，但前端不消费（半成品）。
- APK 更新是 4–6 步手动链路且失败静默；应用内安装（`PackageInstaller`）可降到 1–2 步，未做。

### 5.5 安全姿态

- 暴露面选择是"反代 + 应用层鉴权"（业界排序里的第 3 档，低于 VPN/Tunnel），意味着**全部安全
  押在应用层**；nginx 无 WAF/限速层，爆破防护只剩应用内限流器。
- 证书是正规 Let's Encrypt（"自签"的说法与仓内配置不符）。
- Cookie 形态、凭据熵、撤销语义、管理双闸都对齐或强于业界 BCP/OWASP 的对应条目；
  已知欠账是 deviceToken 不轮换与 12h 会话（§3.8）。

### 5.6 上游平台限制（自托管形态自身带来）

- 定时/自动化任务：调度器只在桌面版（Electron fork）内，`zcode --web` 没有 → DB 里的定时任务
  永不运行（"立即运行"会报 dispatcher 不可用）。
- 官方远控页没有原生恢复协调器（那条能力只在其 QR/workspace-bridge 流上），本部署走的是
  token 直连流 → 恢复靠 relay 注入的 shim（横幅 + 限频 reload），与直连页的软重连不同级。

---

## 6. 注意事项与陷阱清单

### 6.1 部署与构建

| # | 现象 / 机制 | 处置 |
| --- | --- | --- |
| 1 | 官方插件定义含 `requiredSeedPaths`，启动时逐路径核对磁盘上的插件拷贝，缺任一文件即 `ZCODE_PLUGIN_SEED_INCOMPLETE` 并**整插件跳过 seeding**（表现为技能消失） | **不要**用源码构建的 agent bundle 覆盖 `<部署目录>/agent/zcode.cjs`；`<部署目录>/packages/*` 来自官方发行包、源码树没有。日常只覆盖 `web`、`server` 两个子目录 |
| 2 | `packages/web/public/sw.js` 与 `zcode-boot-probe.js` 含 `__SW_CACHE_VERSION__` 占位符 | 必须经 `pnpm --filter @zcode/web build` 的产物部署；手工拷 `public/` 会让 SW 版本串恒定不换版 |
| 3 | 文档/部署件里的 `<…>` 占位符（`<部署域名>`、`<数据目录>` 等） | 照抄到实际配置前逐一替换。未加引号的占位符在 shell 里会被当重定向、在 systemd unit 里含空格路径会被分词（现状**待核实**：清洗后仓内 unit/脚本的占位符是否已回退为字面值） |
| 4 | 部署是 `rsync --delete` 原地覆盖：非原子；旧 hash 资源被立即删除 | 长活页面会 lazy chunk 404；回滚靠整目录备份 + 重启 |
| 5 | `stop zcode-web` 会连带停 relay（unit 的 `BindsTo`/`PartOf`），且 relay 不会自启 | 启停成对操作；机器重启无此问题（relay 已 enable） |
| 6 | 服务重启会中断正在进行的会话（连执行部署的那条会话本身也在其中） | 部署由独立运维会话执行；脚本备好回滚与验证清单 |

### 6.2 服务与进程

| # | 现象 / 机制 | 处置 |
| --- | --- | --- |
| 7 | server 重启打断进行中对话 → `tasks-index` 留 `status=running` 孤儿 | 手工订正 `task_status` 与 `meta_json.status`；会话级删除要清三处（索引/CLI 库/rollout） |
| 8 | 撤销设备的三步顺序（先落盘、再清会话、最后关 WS）**不可反** | 反了会在崩溃时复活已删凭据，或留下"记录已删但会话仍有效"的窗口 |
| 9 | `devices.json`/`sessions.json` 结构非法即拒启（fail-closed） | 备份与恢复按整文件处理；写入始终原子（临时文件 + rename） |
| 10 | 探针（`/api/auth/probe`）凭据在**请求体**、不在 Cookie | 用浏览器 Cookie 或 CSRF 头复刻 probe 只会得到 401；取样要用设备自己的 deviceToken |
| 11 | 打包时 tsup/esbuild 会把动态 `import("node:sqlite")` 改写成 `import("sqlite")` → 运行时 `Cannot find package` | 新增 Node 内置模块的动态 import 一律走 `createRequire(import.meta.url)(...)` |
| 12 | 限流器 key 表有 4096 上限，表满时**新 key 不被计数**（fail-closed 的对象是"记录"而非"请求"） | 已有 key 正常计数、新 key 不被锁死；单人部署正常流量远达不到 |

### 6.3 前端与缓存

| # | 现象 / 机制 | 处置 |
| --- | --- | --- |
| 13 | SW 是 cache-first：不注销它，第二次导航仍回放旧 bundle（现象隐蔽：请求数为 0、其实在跑旧构建）；Playwright 的 `serviceWorkers:'block'` 对**已注册**的 SW 不生效 | 预览验证台必须先导航一次 → 页内 `getRegistrations().unregister()` + `caches.delete()` → 再导航 |
| 14 | Chromium 磁盘缓存同样绕过路由拦截 | 启动参数 `--disable-http-cache --disk-cache-size=1` |
| 15 | 注入脚本必须在应用建连**之前**同步执行（`type="module"` 的应用脚本会延迟执行，经典脚本立即执行） | 注入的 `<script>` 不加 `defer`，放在 `</head>` 前；这是"替换 `window.WebSocket` / 钩首次建连"方案成立的前提 |
| 16 | `sw.js` 必须返回 `no-cache` | SW 更新检查依赖字节对比；immutable 会让缓存版本永远无法失效 |
| 17 | 静态入口只注册 `GET *`，HEAD 请求的响应行为与 GET 不同 | 健康检查/探活一律用 GET |
| 18 | 探针/注入脚本是"所有页面共用"的敏感文件 | 改它必须走 network-first 白名单路径（历史上曾因缓存把它锁死） |

### 6.4 协议与接口

| # | 现象 / 机制 | 处置 |
| --- | --- | --- |
| 19 | 远控页 bootstrap 是严格 zod schema：tasks 条目缺字段/多字段/类型错会被**整条静默丢弃**；tasks 为空时页面只重试 3×300ms 就显示 0 | 改任务行结构时同步核对页面 schema |
| 20 | 远控页面版本敏感：`app_version` 必须与 server 配套，混入新工具卡会导致整帧拒收（`recoveryFailed`） | relay 固定 `app_version`；升级 server 后同步重镜像页面 |
| 21 | `/api/v1/client/configs` 漏配 → 落到 server 被 401，远控页启动链每次都报错 | nginx 必须保留该精确 location 指向 relay |
| 22 | `/api/relay/` 漏配 → 落 server 得 404，直连页无法自助签发门票 | 同上，`^~` 前缀要写在 `location /` 之前 |
| 23 | 反代头（`X-Forwarded-Host`/`Proto`）默认被 nginx 原样透传、客户端可伪造 | 服务端默认不信；要开启 `ZCODE_TRUST_PROXY=1` 必须**先**在 nginx 上显式 `proxy_set_header` 覆盖（顺序不可反） |
| 24 | CSRF 校验必须位于自愈分支**之前** | 否则"会话失效 + 续期 Cookie"的 mutating 请求会被静默放行；新增端点时同步检查豁免面与带头义务 |
| 25 | 远控页 reload 后回原会话依赖 `mobile-view-state` + `workspace-bridge` 回放 `initialTaskId` 的两处格式兼容代码 | 不可删；删了会退化成"恢复后跑到新建对话" |
| 26 | 回滚到旧版 relay 时，旧版下发的 `wsUrl` 仍拼旧 token 查询串 | 应急场景可接受，但会暴露旧 token 常量；恢复远控页前先确认模型 |
| 27 | 流量计量工具（`deploy/e2e/ws-meter.mjs`）的 DUMP/OUT 产物含 apiKey 帧头 | 脚本头已注明"即用即删"，产物不要留盘 |

### 6.5 验证手段（用来复现上述结论）

- **连接恢复**：`deploy/e2e/` 下的 Playwright 脚本（半开黑洞、原地恢复、体感、真断线、SW 时序），
  判定"无整页 reload"的硬口径是"脚本在 window 上打标记，reload 后标记消失即失败"。
- **候选构建预览**：用已配对的浏览器 profile 打开真实 origin，把同源静态资源替换成本地构建目录，
  不部署、不重启即可跑新 UI（必须用 profile **副本**：共享的浏览器 context 不能 close）。
- **断连实验的两条硬事实**：CDP `Network.emulateNetworkConditions{offline:true}` **不会断开已建立的
  WebSocket**（只让新建连接失败）；Playwright `routeWebSocket` 的 kill 会被透传成 clean close(1000)，
  而页面把 `wasClean` 当登出语义**故意不重连** → 用它测"断线恢复"会得到伪结论。
- **门禁**：`pnpm --filter @zcode/server test`、`pnpm typecheck`、`pnpm lint`、
  `pnpm architecture:check --changed`；壳侧 `./gradlew --no-daemon :app:testDebugUnitTest`。
  新增端点的鉴权断言要成对写（正常客户端可用 / 伪造请求被拒）。

---

## 7. 延伸阅读（仓内）

| 文件 | 内容 |
| --- | --- |
| `packages/server/specs/device-credential-auth.md` | 设备凭据鉴权的完整规格：不变量、协议、端点、错误码、存储、CSRF 与 WS Origin |
| `packages/server/specs/selfhosted-web-pairing.md` | 早期单 token 配对登录规格（模型已删除，保留作背景） |
| `packages/rpc/specs/socket-keepalive.md` | WS KeepAlive 探针/回显协议与心跳监视器规格 |
| `deploy/nginx-zcode.conf` | 线上站点配置的仓内副本（路由、注入、超时、管理面 403） |
| `deploy/admin-cli.sh`、`deploy/zcode-web.service`、`deploy/zcode-relay.service` | 管理 CLI 与两个 unit（含环境变量与依赖关系） |
| `deploy/e2e/README.md` 与 `deploy/e2e/*.mjs` | 连接恢复与验收脚本 |
| `mobile/android/README.md`、`mobile/android/SPEC.md` | 手机壳的架构、职责表、构建/签名与协议层说明 |
| `mobile/handoff/zcode-device-credential-spec.md` | 服务端 ↔ 手机壳的设备凭据协议契约（威胁模型、I1–I6、壳侧职责） |
| `docs/deployment.md` | 运维手册：拓扑、关键机制、日常运维命令、已知边界 |
