# ZCode 自托管部署与运维手册

> 面向：在一台 Linux 服务器上从零部署 ZCode 自托管 Web 的运维者。
> 覆盖范围：直连页（ZCode server）、官方手机远控页（relay）、Token 状态栏旁挂（zusage）、
> APK 分发静态服务、nginx 站点、构建与更新、验证与回滚。
> 本文只写「装什么、配什么、怎么验证、怎么回滚、有哪些坑」，不按时间叙述。

---

## 0. 使用前必读：占位符必须替换

仓内部署件（`deploy/` 下的 systemd unit、nginx 站点、部署脚本）为公开口径做了**占位化**，
`<...>` 不是可直接使用的值。**照抄会导致服务起不来或行为异常。**

### 0.1 占位符对照表

| 占位符 | 含义 | 典型形态 |
|---|---|---|
| `<部署域名>` | 对外 HTTPS 入口域名（单域名；证书 SAN 需含它） | 形如 `example.com` |
| `<部署目录>` | **运行时根目录**：发行包解压出来的 `web/`、`server/`、`agent/`、`bin/`、`packages/` | 独立于源码树 |
| `<数据目录>` | `ZCODE_DATA_BASE_DIR`：运行时状态与日志（`devices.json`、`sessions.json`、`tasks-index.sqlite`、`server.log`、`relay.log`） | 必须持久化 |
| `<配置目录>` | 密钥文件与 env 文件的所在目录 | 见 0.3 |
| `<备份目录>` | 部署前备份的存放根（每次部署一个时间戳子目录） | 独立于被改文件 |
| `<镜像目录>` | 官方远控页的离线镜像（`index.html` + `remote/v4/<ver>/assets/…` + `client-configs.json`） | 由 relay 读取 |
| `<APK 分发目录>` | APK 分发服务的被服务目录；服务脚本与上传密钥在其同级或上层 | 见 2.7 |
| `<Android 构建工具目录>` | JDK 17 与 Android SDK（compileSdk 36）的解包位置 | 只在构建 APK 时需要 |
| `<Node 安装目录>` | Node 24 运行期安装目录（其 `bin/` 下有 `node`） | unit 的 `PATH`/`ExecStart` 用它 |
| `<CLI 数据目录>` | CLI 侧数据目录（`cli/db/db.sqlite`、`cli/rollout/*.jsonl`、`v2/setting.json`） | `HOME` 下的 `.zcode` |
| `<仓库根>` | 本仓库检出根（ZCode 源码 + 补丁集 + `deploy/`） | |
| `<工作区>` | 部署脚本与 relay 源码所在的上层工作区（含 `<工作区>/ZCode`、`<工作区>/relay`、`<工作区>/deploy`） | |
| `<relay 源码目录>` | 存放 `relay-v29.mjs` / `relay-v28.mjs` 的目录（自带 git 历史，便于回滚） | |
| `<nginx 站点配置>` | nginx 站点文件；仓内副本即 `deploy/nginx-zcode.conf` | |
| `<部署根>` | 部署脚本解压发行包时使用的目标根（与 `<部署目录>` 同义，替换成同一个值） | |

### 0.2 三条硬性要求

1. **路径不能含空格，含了就必须整体引用。** systemd 的 `ExecStart`/`Environment=` 会按空白分词
   （`<Node 安装目录>` 含空格时写成 `ExecStart=<Node 安装目录>/bin/node …` 会直接解析失败）；
   bash 里必须用双引号包住整个路径。
2. **部署脚本里存在未加引号的占位符**（形如 `cp -a <数据目录>/web …`）。
   `<` `>` 在 bash 里是重定向符号，未替换/未加引号会被当作重定向解析而不是路径。
   **先把占位符全部替换成真实路径并补好引号，再执行脚本。**
3. **不要依赖代码内的缺省值。** 源码里若干缺省路径同样是占位形态（管理密钥缺省路径、
   relay 的部分路径缺省）。关键路径一律通过 **systemd 环境变量 / env 文件** 显式给出；
   缺省值兜底时行为会静默降级（relay 表现为任务列表为空、回源官方站点）。

### 0.3 `<配置目录>` 的一致性

管理密钥路径被**两个地方**引用，必须指向同一份文件：

| 引用处 | 形式 | 处理 |
|---|---|---|
| 服务端缺省常量 `DEFAULT_ADMIN_SECRET_PATH`（`packages/server/src/deviceCredentialAuth.ts`） | 代码内置的固定路径 | 与你的 `<配置目录>` 不一致时，**必须显式设** `ZCODE_ADMIN_SECRET_FILE=<配置目录>/zcode-admin.secret` |
| `deploy/admin-cli.sh` 里的 `SECRET_FILE` | 脚本常量 | 改成你的真实路径 |

- 启动脚本 `scripts/zcode-distribution/runner.mjs` 在**缺省路径下找不到密钥文件时直接以退出码 1 结束**
  （不允许裸奔），所以这一步必须在首次启动前完成。
- `deploy/zcode-web.service` 用 `EnvironmentFile=<配置目录>/zcode-web.env` 引入这些变量。
- 该缺省路径属产品约定，**升级版本后请复核**（可能随版本变化）。

---

## 1. 拓扑与前置条件

### 1.1 组件与端口

| 组件 | 端口 | 监听 | 代码位置 | 职责 |
|---|---|---|---|---|
| `zcode-web.service` | 3030 | `127.0.0.1` | `<部署目录>/bin/zcode.mjs`（= 发行包的 `scripts/zcode-distribution/runner.mjs`）→ `<部署目录>/server/entry-http.js` | 直连页静态资源 + `/api/*` + 真 RPC 通道 `/ws`；**设备凭据鉴权**在服务端代码内（`packages/server/src/deviceCredentialAuth.ts`） |
| `zcode-relay.service` | 3032 | `127.0.0.1` | `<relay 源码目录>/relay-v29.mjs` | 官方手机远控页的桥：页面镜像/回源、`/api/remote-control/*`、控制通道 WS、bootstrap 下发任务与工作区、一次性门票签发与校验 |
| `zusage-sidecar.service` | 3033 | `127.0.0.1` | `zusage-sidecar.mjs` + 只读 python 子进程 | Token 状态栏数据泵（只读 SQLite；鉴权 = 透传浏览器会话 Cookie 到 3030 校验） |
| `zcode-apk.service` | 3035 | `127.0.0.1` | `<APK 分发目录>-server/server.py` | APK 下载（支持 Range 断点续传）+ 密钥保护的上传页 |
| nginx | 443 | `0.0.0.0` | `<nginx 站点配置>` | TLS 终止、路由、`sub_filter` 注入、`/api/admin/` 公网 403 |

> 除 nginx 外，所有服务都只监听回环；对外只经 443 暴露。

### 1.2 请求路由（nginx）

| location | 上游 | 说明 |
|---|---|---|
| `^~ /app/` | 3035 | APK 分发；**404 就是真 404**（不放进 ZCode server 的静态目录，避免 SPA fallback 把过期链接返回成网页） |
| `^~ /zusage/` | 3033 | 状态栏静态脚本与快照接口；必须透传 `X-Real-IP`（会话校验在 3030 侧按 IP 限流） |
| `= /login` | 3030 `/api/pairing/page` | 配对登录短地址 |
| `^~ /api/relay/` | 3032 | `POST /api/relay/ticket` 门票签发；**必须 `^~` 且先于 `location /` 命中** |
| `^~ /web-remote` | 3032 | 远控页入口（`?ticket=<票>` 主链 / `?remoteControlToken=<旧token>` 过渡链） |
| `^~ /remote/` | 3032 | 远控页静态资源（`/remote/v4/<ver>/assets/*`） |
| `^~ /api/remote-control/` | 3032 | relay 的直连流接口（bootstrap / workspace-bridge / mobile-view-state / platform） |
| `= /api/v1/client/configs` | 3032 | 远控页离线化的 UI 配置镜像 |
| `^~ /ws/remote-control/` | 3032 | 控制通道 WebSocket（**必须带 Upgrade 头**） |
| `^~ /api/admin/` | — | `return 403`：公网一律拒绝（第二道闸；第一道在服务端「本机直连 + 密钥」） |
| `/` | 3030 | 直连页、`/api/*`、`/ws`；`sub_filter` 注入探针与状态栏脚本 |

### 1.3 前置条件

| 项 | 要求 | 依据 |
|---|---|---|
| OS | Linux + systemd（本部署为 systemd 直跑，无容器） | `deploy/*.service` |
| Node | **24+**（`node:sqlite` 等）；仓库 `engines.node >= 24.0.0`，`mise.toml` 固定 `24.14.0` | `package.json`、`mise.toml` |
| pnpm | `10.33.2`（仓库 `packageManager`） | `package.json` |
| nginx | 需 `sub_filter`（http_sub_module）与 HTTP/2；无则页面注入不生效 | `deploy/nginx-zcode.conf` |
| 证书 | 站点目录使用 Let's Encrypt 的 `fullchain.pem` / `privkey.pem`，**SAN 必须含 `<部署域名>`** | `deploy/nginx-zcode.conf` |
| 系统工具 | `curl`、`tar`、`rsync`、`openssl`、`git`；`jq` 可选（`admin-cli.sh` 有则美化输出） | `deploy/*.sh` |
| 构建环境（仅构建时需要） | JDK 17 + Android SDK（compileSdk 36）解包于 `<Android 构建工具目录>`；`JAVA_HOME`/`ANDROID_HOME`/`GRADLE_USER_HOME` 指向该处 | APK 壳工程说明 |

### 1.4 目录约定

| 目录 | 内容 | 注意 |
|---|---|---|
| `<部署目录>` | `web/`、`server/`、`agent/`、`bin/`、`packages/`、`node_modules/` | 由发行包解压；`packages/`（官方插件包）只在发行物里，源码构建不产出 |
| `<数据目录>` | `devices.json`、`sessions.json`、`tasks-index.sqlite`、`server.log`、`relay.log`、`workspace/default/` | 与源码/部署目录分离；重建部署时**不得清空** |
| `<配置目录>` | `zcode-web.env`、`zcode-relay.env`、`zcode-admin.secret` | 全部 `600 root:root` |
| `<备份目录>` | 每次部署一个 `…-<时间戳>/` 子目录 + 日志 | 备份只放这里，不在被改文件旁造 `.bak` |

---

## 2. 组件部署

### 2.1 源码基线

- 上游基线：**v3.14.3**（本仓库是在其之上的 fork）。**直接用本仓库部署即可**，
  不需要额外套补丁——本仓库本身就是完整源码。
- `deploy/` 下的 unit / nginx 配置 / 部署脚本是**模板**，含占位符（见 §0），使用前必须替换。
- 回滚：未提交时 `git checkout -- .`；已提交用 `git revert`。
- 补丁只含源码改动，**不含**任何环境特定值。

### 2.2 构建产物

```bash
pnpm install
pnpm typecheck && pnpm lint              # 门禁，必须通过
pnpm build:zcode --base-url https://<部署域名>/dist/
```

产物在 `dist/zcode/`：

| 产物 | 说明 |
|---|---|
| `releases/<version>/zcode-<version>.tar.gz` | 发行包（内含 `zcode/` 下的 `web`、`server`、`agent`、`bin` 及运行期依赖） |
| `releases/<version>/sha256.txt` | 发行包校验和 |
| `latest.json`、`install.sh` | 下载基址与安装脚本（按 `--base-url` 生成） |

> **构建不产出 `<部署目录>/packages/` 下的官方插件包**（插件、bundled-skills 等），
> 它们只随官方发行物提供。因此部署目录里的 `packages/` 必须保持完整——
> 用 `tar` 解压不会删除已有文件，但 `rsync --delete` 或手工清目录会丢；
> 该问题是运行期才暴露的（插件商店与相关技能直接缺失）。
> `agent/zcode.cjs` 虽由构建产出，但**覆盖它另有陷阱**，见第 8 节第 6 条。

### 2.3 zcode-web.service

要点（完整样例见 `deploy/zcode-web.service`）：

```ini
[Service]
WorkingDirectory=<部署目录>
Environment=HOME=<运行用户的家目录>
Environment=PATH=<Node 安装目录>/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=ZCODE_DATA_BASE_DIR=<数据目录>
Environment=PORT=3030
Environment=ZCODE_DYNAMIC_WORKFLOW_MODE=alwaysOn
EnvironmentFile=<配置目录>/zcode-web.env        # 密钥类变量只走文件
UMask=0077
ExecStart=<Node 安装目录>/bin/node <部署目录>/bin/zcode.mjs --web \
  --workspace <数据目录>/.zcode/workspace/default --host 127.0.0.1 --port 3030 --no-open
Restart=always
RestartSec=3
StandardOutput=append:<数据目录>/server.log
StandardError=append:<数据目录>/server.log
```

- **`HOME` 必须是拥有 `<CLI 数据目录>` 的那个账号的家目录**：server 与 Agent 同 `HOME`，
  CLI 侧的会话库（`<CLI 数据目录>/cli/db/db.sqlite`）、`cli/rollout/*.jsonl`、
  `v2/setting.json` 都按它定位；`HOME` 写错会表现为用量统计/会话存档读不到。
- **`ExecStart` 里不要再写 `--token`**：设备凭据模型下 token 不是客户端凭据，
  `--token` 的值被忽略；而且它会出现在 `ps` / `/proc/<pid>/cmdline` 里。
- `--workspace` 决定 `server-info` 宣告的工作区。指向
  `<数据目录>/.zcode/workspace/default` 时带 `workspacePurpose: "conversation"`，
  页面显示「不在项目中工作」；真实项目由使用者在界面上新建，不预置。
- **启动硬前置**：管理密钥文件必须存在，否则 runner 打印错误并以退出码 1 结束
  （不允许裸奔）。首次启动前先创建，见 4.3。

### 2.4 relay（手机远控页桥）

要点（完整样例见 `deploy/zcode-relay.service`，端点与环境变量见 `docs/architecture.md` 的 relay 一节）：

```ini
[Unit]
After=network.target zcode-web.service
Requires=zcode-web.service            # 停 zcode-web 会连带停 relay

[Service]
Environment=ZCODE_RELAY_PORT=3032
Environment=ZCODE_BRIDGE_PUBLIC_WS=wss://<部署域名>/ws
Environment=ZCODE_HOST_ORIGIN=http://127.0.0.1:3030
Environment=ZCODE_DATA_BASE_DIR=<数据目录>
Environment=ZCODE_REMOTE_MIRROR=<镜像目录>
EnvironmentFile=<配置目录>/zcode-relay.env     # 密钥类变量只走文件
UMask=0077
ExecStart=<Node 安装目录>/bin/node <relay 源码目录>/relay-v29.mjs
```

依赖与运行要求：

- Node 24+（用到 `node:sqlite`）；WebSocket 库 `ws` 由 `ZCODE_WS_MODULE` 指定，
  否则从 `node_modules` 解析。
- 任务列表读 `ZCODE_DATA_BASE_DIR` 下的 `tasks-index.sqlite`（**只读**）；
  工作区默认取 `<数据目录>/.zcode/workspace/default`（可用 `ZCODE_TASKS_DB`、
  `ZCODE_CONVERSATION_WORKSPACE` 显式指定）。
- 一个 relay 服务一台 server，与 server 同机部署。

**门票与双因子**（relay-v29）：

1. 主链：已配对浏览器 `POST /api/relay/ticket`（relay 透传请求 Cookie 到 3030
   `/api/server-info` 校验）→ 得 32hex 一次性票（10 分钟有效）→
   `GET /web-remote?ticket=<票>` → relay 消费入口（单次）→ 302 到参数模式。
2. 自助链：直接打开 `/web-remote` 且带有效会话 Cookie → 签发「签发即入场」的票并 302。
3. 兼容链：`?remoteControlToken=<旧 token>` 过渡期仍可进，命中会记录 legacy 入口日志。

`/api/remote-control/*` 与 `/ws/remote-control/*` 的校验是**双因子**：
路径里的值必须等于已入场的有效票（或旧 token）**且**请求携带有效设备会话 Cookie；
缺一即 401/403。票只是入口引导凭据，Cookie 才是真凭据。

`relay` 还需要一条**本地凭据**才能拉取 bootstrap：

- `ZCODE_RELAY_LOCAL_SESSION` = 一台「relay 系统设备」的 `deviceToken`
  （label 固定 `relay-system`，在 `/devices` 页可见、可撤销）。
- relay 用它 `POST /api/auth/renew` 换会话，再带 Cookie 调 `/api/server-info`。
- 该值经部署脚本用 `admin-cli.sh` 生成后写入 `<配置目录>/zcode-relay.env`（见 4.5）。
  缺失时 relay 仍能跑，但 `server-info` 宣告降级为空（任务列表仍可用）；
  journal 出现 `local-session:renew-failed` 即凭据失效（设备被撤销等）。

### 2.5 远控页离线镜像

官方远控页是闭源页面，relay 按 `app_version` 固定版本下发并**本地伺服镜像，miss 才回源**。
镜像目录需要保持官方 URL 布局：

```
<镜像目录>/index.html                          # 对应官方 /remote/v4?app_version=<ver>
<镜像目录>/remote/v4/<ver>/assets/…            # HTML 引用的全部资源（约 2480 个文件）
<镜像目录>/client-configs.json                 # 官方 /api/v1/client/configs 的镜像应答
```

- 抓取一次即可（任何递归镜像工具，保留上述路径）。
- **版本必须与 server 版本配套**：官方按 `app_version` 下发不同版本页面 bundle；
  页面版本比 server 旧会不认识新的工具卡，表现为整帧拒收 / `recoveryFailed`。
  升级 server 版本时要**同步重镜像**（入口 URL + 引用的 assets 全量）。
- relay 内注入的 shim 会把页面里硬编码的官方 configs 请求重定向到本域，
  relay 用镜像里的 `client-configs.json` 应答——因此浏览器不直连官方主机。
- 这些页面资源属于上游，建议只为自己部署抓取，不再分发。

### 2.6 zusage（Token 状态栏旁挂）

- 形态：`zusage-sidecar.service`（127.0.0.1:3033）只读 `db.sqlite`，
  经 nginx 反代到 `/zusage/`；页面侧由 `sub_filter` 注入 `/zusage/boot.js`。
- 鉴权（v2）：透传浏览器设备会话 Cookie 到 3030 `/api/server-info` 校验
  （30s 正缓存 / 5s 负缓存，**fail closed**）。未配对浏览器访问快照接口 401，
  前端 `boot.js` 自动退避 30s。
- 环境变量：`ZUSAGE_PORT`（默认 3033）、`ZUSAGE_HOST`（默认 127.0.0.1）、
  `ZCODE_DATA_BASE_DIR`（或 `ZUSAGE_DATA_DIR`）、`ZCODE_HOST_ORIGIN`。
- 与主链路解耦：停用它只影响状态栏，不影响 ZCode 的 Service Worker 与诊断探针。
- 回退（都不需要重启 ZCode）：
  - 页面不再出现状态条：注释掉 nginx 里的 3 处 `sub_filter`，`nginx -t && systemctl reload nginx`；
  - 接口整体关闭：`systemctl disable --now zusage-sidecar`。

### 2.7 APK 分发静态服务

- 独立静态服务 `zcode-apk.service`（127.0.0.1:3035）+ nginx `/app/` 反代。
- 下载地址固定为 `https://<部署域名>/app/zcode-mobile-<version>.apk`；只保留最新版。
- 下载支持 Range（断点续传）；上传页 `/app/upload?key=<token>`，token 放在
  **不被服务目录覆盖**的位置（`<APK 分发目录>-server/upload-token`，`0600`）。
- 不放进 ZCode server 的静态目录：那边的 SPA fallback 会把 404 变成 `index.html`，
  过期链接会被当成网页打开。
- APK 本体由壳工程构建（JDK 17 + Android SDK，`./gradlew --no-daemon :app:testDebugUnitTest`
  与 `assembleRelease`），签名后上传到本服务。

### 2.8 nginx 站点

- 仓内副本：`deploy/nginx-zcode.conf`；**运行生效的是 `<nginx 站点配置>` 那份副本**，
  两份需保持一致。更新流程：复制过去 → `nginx -t` → `systemctl reload nginx`（reload 不断连接）。
- 三处 location（`/`、`/web-remote`、`/remote/`）都要配 `sub_filter` 注入：

  ```nginx
  proxy_set_header Accept-Encoding "";      # sub_filter 必须在未压缩明文上匹配 </head>
  sub_filter_once on;
  sub_filter '</head>' '<script src="/zcode-boot-probe.js"></script><script src="/zusage/boot.js"></script></head>';
  ```

  `sub_filter` 默认只作用于 `text/html`，JS/CSS 资源不受影响。
- `proxy_set_header Host $host` 与 `X-Real-IP $remote_addr` 必须配：
  后者是 `/api/pairing/redeem` 等按 IP 限流的前提（不透传就全部落到 127.0.0.1 一个桶）。
- 证书路径写死为 Let's Encrypt 的 live 目录（`fullchain.pem` / `privkey.pem`）；
  换证书或换路径时必须改这两行，并 reload nginx。

---

## 3. 环境变量与密钥

### 3.1 zcode-web

| 变量 | 位置 | 含义 |
|---|---|---|
| `HOME` | unit | 进程 HOME；决定 `<CLI 数据目录>`（`~/.zcode`） |
| `PATH` | unit | 必须含 `<Node 安装目录>/bin` |
| `ZCODE_DATA_BASE_DIR` | unit | 运行时数据根（设备注册表、会话、任务索引、日志） |
| `PORT` | unit | 3030 |
| `ZCODE_DYNAMIC_WORKFLOW_MODE` | unit | 动态工作流模式，合法值 `disabled` / `onDemand` / `alwaysOn` |
| `ZCODE_ADMIN_SECRET_FILE` | env 文件 | 管理密钥路径（缺省见 0.3） |
| `ZCODE_TRUST_PROXY` | env 文件 / drop-in | 未设时服务端**忽略** `X-Forwarded-Host` / `X-Forwarded-Proto`（这两个头默认会被 nginx 透传、可被客户端伪造）；设为 `1` 后按转发头视角判定同源。**开启前必须先在 nginx 用 `proxy_set_header` 显式设置这两个头，顺序不可反**（**待核实**：源码中 WS Origin 检查处的注释仍表述为「反代头优先」，与上述默认语义不一致；启用前请在目标版本上实测） |
| `ZCODE_WS_ALLOWED_ORIGINS` | env 文件 / drop-in | 逗号分隔的额外 WS Origin 白名单；默认判定是「同源」，源码不硬编码任何站点域名，跨域部署才需要 |
| `ZCODE_CSRF_ENFORCE` | env 文件 / drop-in | 取值 `0`/`false`/`off` 时关闭 CSRF 强制（应急回退）；正常部署不需要 |
| `ZCODE_AGENT_CHAT_IDLE_TIMEOUT_MS` | unit（由部署脚本写入） | 空闲回收窗口。部署脚本会把它设为 `5400000`（90 分钟），以覆盖手机切后台再回来的场景；仓内 unit 样例未含该行，**当前是否生效以运行副本为准（待核实）** |

> 密钥类变量**不要**写在 `Environment=` 里：`systemctl show -p Environment` 会把它完整打印给任何本地用户。
> 一律走 `EnvironmentFile=`（`600 root:root`）。unit 里的 `UMask=0077` 保证服务新建的文件默认 `600`
> （含 SQLite 的 `-wal`/`-shm`、日志）。

### 3.2 relay

| 变量 | 位置 | 含义 |
|---|---|---|
| `ZCODE_RELAY_PORT` | unit | 3032 |
| `ZCODE_BRIDGE_PUBLIC_WS` | unit | 下发给页面的 WS 地址，TLS 由 nginx 终止时必须显式设为 `wss://<部署域名>/ws` |
| `ZCODE_HOST_ORIGIN` | unit | 本机 server，`http://127.0.0.1:3030` |
| `ZCODE_DATA_BASE_DIR` | unit | 同上；用于推导任务库与对话工作区 |
| `ZCODE_REMOTE_MIRROR` | unit | 远控页镜像目录；未设 = 不使用本地镜像，改为直接代理上游页面（仍可用，但不是离线） |
| `ZCODE_TASKS_DB` / `ZCODE_CONVERSATION_WORKSPACE` | 可选 | 显式指定任务库与对话工作区 |
| `ZCODE_WS_MODULE` | 可选 | 指定 `ws` 包入口 |
| `ZCODE_RELAY_LOCAL_SESSION` | **env 文件** | relay 系统设备的 `deviceToken`（必需，见 2.4） |
| `ZCODE_REMOTE_TOKEN` | env 文件 | 旧单 token，过渡期仅用于 `?remoteControlToken=` 兼容入口 |
| `ZCODE_SERVER_TOKEN` | env 文件 | 已退役；保留变量名只为 env 文件兼容 |

> 页面版本常量（`PAGE_VERSION`）在 relay 源码里，必须与 server 版本配套。

### 3.3 zusage

`ZUSAGE_PORT`（3033）、`ZUSAGE_HOST`（127.0.0.1）、`ZCODE_DATA_BASE_DIR` / `ZUSAGE_DATA_DIR`、
`ZCODE_HOST_ORIGIN`。本服务不需要任何凭据文件。

### 3.4 密钥清单

| 密钥/凭据 | 存放 | 权限 | 说明 |
|---|---|---|---|
| 管理密钥 | `<配置目录>/zcode-admin.secret` | `600 root:root`，建议由 `umask 077` + `openssl rand -hex 32` 生成 | 管理端点用 `x-zcode-admin` 头携带；与任何客户端凭据不同源 |
| relay 本地凭据 | `<配置目录>/zcode-relay.env` 内的 `ZCODE_RELAY_LOCAL_SESSION` | env 文件 `600 root:root` | 一台可撤销的「系统设备」的 deviceToken |
| 设备凭据 | 服务端磁盘 `<数据目录>/.zcode/devices.json` **只存 sha256 摘要** | `600`（服务启动时会自愈权限） | 明文只在客户端（手机 Keystore / 浏览器 Cookie） |
| 会话 | `<数据目录>/.zcode/sessions.json` **只存摘要** | `600` | 12h；服务重启后凭摘要恢复 |
| APK 上传密钥 | `<APK 分发目录>-server/upload-token` | `0600`，且不在被服务的目录内 | 上传页 `/app/upload?key=<token>` |

统一做法：**值放文件，不写进 unit；不进 URL；不进 argv**（`admin-cli.sh` 也是把密钥写进
`0600` 临时头文件、用 `curl -H @file` 传递，避免出现在 `ps` 输出里）。

---

## 4. 首次部署步骤

按下面的顺序执行。小节内的条目是操作步骤，跨小节的先后关系不可颠倒（尤其是密钥先于启动、
凭据先于 relay、nginx 先于服务端信任反代头）。

### 4.1 系统与入口

- 安装 Node 24 到 `<Node 安装目录>`，确认 `<Node 安装目录>/bin/node -v` 输出 24.x。
- 安装 nginx（含 `sub_filter`），把站点配置放到 `<nginx 站点配置>`，
  证书（含 `<部署域名>` 的 SAN）就位；`nginx -t` 通过后 reload。

### 4.2 目录与持久化

- 创建 `<部署目录>`、`<数据目录>`、`<配置目录>`、`<备份目录>`、`<镜像目录>`；
  `<数据目录>` 放在持久化盘上，并确保只有运行账号可读写。

### 4.3 管理密钥（**先于任何服务启动**）

```bash
umask 077
mkdir -p <配置目录>
openssl rand -hex 32 > <配置目录>/zcode-admin.secret
chmod 600 <配置目录>/zcode-admin.secret
```

（缺这个文件时 `zcode-web` 启动即失败退出。）

### 4.4 源码与构建

- 取源码（本仓库，基线 v3.14.3）→
  `pnpm install` → `pnpm typecheck && pnpm lint` → `pnpm build:zcode --base-url https://<部署域名>/dist/`。
- 解压发行包到 `<部署目录>`。**不要动已有的 `packages/`**（官方插件包只有发行物里才有，
  源码构建不产出；缺失会导致插件商店与技能缺失），`agent/zcode.cjs` 的覆盖规则见第 8 节第 6 条。

### 4.5 服务与凭据

- 写 `<配置目录>/zcode-web.env`（至少 `ZCODE_ADMIN_SECRET_FILE=<配置目录>/zcode-admin.secret`），
  `chmod 600`。
- 安装 `deploy/zcode-web.service` 到 `/etc/systemd/system/`，替换全部占位符（含路径引号），
  `systemctl daemon-reload`，`systemctl enable --now zcode-web`。
- 等 3030 起来，做一次健康检查（见 5.1）。
- 生成 relay 本地凭据并写进 `<配置目录>/zcode-relay.env`（`chmod 600`）：

```bash
<工作区>/deploy/admin-cli.sh code relay-system        # 取一次性配对码
curl -sS -H 'Content-Type: application/json' \
  --data '{"code":"<配对码>","label":"relay-system"}' \
  http://127.0.0.1:3030/api/pairing/redeem            # 响应体里的 deviceToken 只回显一次
# 把 deviceToken 以 ZCODE_RELAY_LOCAL_SESSION=<值> 追加进 <配置目录>/zcode-relay.env
```

- 该步骤是幂等的：`ZCODE_RELAY_LOCAL_SESSION` 已存在就跳过（重复部署不会重发码）。
- 注意配对码是**全局单窗口**语义：生成新码会使未使用的旧码立即作废，
  所以生成前不要有正在等待输入的配对页。
- 想少踩坑就直接跑部署脚本：它按同样的顺序做备份、同步、凭据、重启、健康检查与回滚。

- 安装 `deploy/zcode-relay.service`（替换占位符）→ `daemon-reload` → `enable --now zcode-relay`。
- 安装 `zusage-sidecar.service` 与 `zcode-apk.service`（各自替换占位符）→ `enable --now`。
- 把 nginx 站点副本同步到 `<nginx 站点配置>`（确认含 `^~ /api/relay/`、
  `/zusage/`、`/api/v1/client/configs`、`/api/admin/` 403 四处）→ `nginx -t && systemctl reload nginx`。
- 准备远控页镜像（可选但推荐，见 2.5），确认 relay 指向 `<镜像目录>`。

### 4.6 配对与验收

- 生成第一枚配对码：`<工作区>/deploy/admin-cli.sh code <设备名>`，
  手机/浏览器打开 `https://<部署域名>/login` 输入配对码完成配对（换 90 天设备凭据 + 12h 会话）。
- 完整走一遍 5.1–5.3 的验证。
- 记录本次的备份目录与回滚点。

> **部署动作本身会中断当前正在进行的会话**（`systemctl restart zcode-web`）。
> 若是在同一台机器上通过本服务自己的终端执行，重启会打断执行流程——
> 部署应交给独立运维通道执行。

---

## 5. 验证

### 5.1 健康检查（服务器本机 curl）

| 目标 | 预期 | 含义 |
|---|---|---|
| `http://127.0.0.1:3030/api/server-info` | **401** | 无凭据被拒 = 服务健康（鉴权恒开） |
| `http://127.0.0.1:3030/api/pairing/page` | **200** | 配对页可用（自救通道） |
| `http://127.0.0.1:3032/api/v1/client/configs` | **200** | relay 存活 |
| `http://127.0.0.1:3033/zusage/health` | **200** | 状态栏旁挂存活 |
| `https://<部署域名>/login` | **200** | 公网入口 + 证书 + 路由整链正常 |
| `systemctl is-active zcode-web zcode-relay zusage-sidecar` | `active` | — |
| `journalctl -u zcode-relay -n 20 \| grep local-session` | 无 `local-session:renew-failed` | relay 本地凭据有效 |

### 5.2 安全语义自检（本机 curl）

先造一个**临时设备**会话（用完即撤，不要动使用者的设备）：

```bash
SECRET=$(cat <配置目录>/zcode-admin.secret)
CODE=$(curl -s http://127.0.0.1:3030/api/admin/pairing-code \
  -H "x-zcode-admin: $SECRET" -H 'content-type: application/json' \
  -d '{"label":"selfcheck","ttlHours":1}' | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
CREDS=$(curl -s -c /tmp/selfcheck-cookie.txt http://127.0.0.1:3030/api/pairing/redeem \
  -H 'content-type: application/json' -d "{\"code\":\"$CODE\",\"label\":\"selfcheck\"}")
CSRF=$(echo "$CREDS" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
```

> `ttlHours`（1–168）用于把兑换出的设备标记为**临时设备**（到期自灭、renew 不顺延）。
> 不支持的实现会忽略该字段而建成正式设备——所以无论哪种情况，下面的清理步骤都不能省。

| 检查 | 命令要点 | 预期 |
|---|---|---|
| 正常客户端可用 | 带 `-b /tmp/selfcheck-cookie.txt -H "x-zcode-csrf: $CSRF"` `POST /api/rpc-host-capability` | 200 |
| CSRF 强制生效 | 同上一行但不带 `x-zcode-csrf` 头 | 403 `{"error":"forbidden"}` |
| 错 CSRF 值被拒 | 带 `x-zcode-csrf: deadbeef` | 403 |
| GET 不受影响 | `GET /api/server-info`（带 Cookie） | 200 |
| 公开豁免面 | `POST /api/auth/probe`，凭据在 body、不带 Cookie | 200 |
| WS Origin 拒绝 | 带 `Upgrade: websocket` 等头 + `Origin: https://evil.example` | 403，日志出现 `ws upgrade rejected: Origin not allowed` |
| WS 无 Origin 放行 | 同上但去掉 Origin（非浏览器客户端语义） | 101 |
| 反代视角同源 | 加 `X-Forwarded-Host: <部署域名>`、`X-Forwarded-Proto: https`、`Origin: https://<部署域名>` | 101（**前提是已开启 `ZCODE_TRUST_PROXY=1`**；未开启时转发头被忽略、按请求 Host 判定，此时 Origin 与 Host 不一致会被判 403——这正是要按 3.1 的顺序显式开启它的原因） |
| 普通 GET `/ws` | 不带 upgrade 头 | 426 `{"error":"expected_websocket_upgrade"}` |
| 管理端点公网拒绝 | 经 443 访问 `/api/admin/*` | 403 |

清理：

```bash
curl -s http://127.0.0.1:3030/api/admin/devices -H "x-zcode-admin: $SECRET"   # 找到 selfcheck 的 id
curl -s http://127.0.0.1:3030/api/admin/devices/revoke -H "x-zcode-admin: $SECRET" \
  -H 'content-type: application/json' -d '{"id":"<32hex>"}'
rm -f /tmp/selfcheck-cookie.txt
```

### 5.3 端到端（手机/浏览器）

1. APK 打开对话页发一条消息：WS/RPC 通道正常、无断连横幅。
2. `/devices` 页 rename 一次设备：管理页 + CSRF + 会话链路正常。
3. 打开一次远控页 `/web-remote`：自助签票 → bootstrap → WS 就绪 → RPC 正常。
4. 切后台再回前台：页面原地恢复，不整页重载。

### 5.4 部署脚本自带检查

`deploy/` 下的部署脚本（`zcode-deploy-*.sh`）在重启后会连跑同款检查（401 / 配对页 200 /
公网 `/login` 200 / relay 与 zusage 可达 / 两个 unit `is-active` /
relay journal 无 `local-session:renew-failed`），任一失败即自动回滚（见 7.1）。

---

## 6. 版本更新部署

### 6.1 推荐路径（只覆盖 web/server）

```bash
cd <仓库根>
pnpm typecheck && pnpm lint
pnpm build:zcode --base-url https://<部署域名>/dist/
systemctl stop zcode-web                  # 会连带停 relay（Requires=）
cp -a packages/web/dist/.    <部署目录>/web/
cp -a packages/server/dist/. <部署目录>/server/
systemctl start zcode-web zcode-relay
```

- 只动 `web/` 与 `server/`，**不碰 `agent/` 与 `packages/`**，可绕开插件 seed 陷阱（见第 8 节第 6 条）。
- 用 `rsync -a --delete` 同步更干净（会清掉历史残留 bundle）。

### 6.2 跑部署脚本（有备份 + 自动回滚）

`deploy/` 下的部署脚本（`zcode-deploy-*.sh`）做的是：备份现状 → 幂等生成 relay 凭据 →
同步 `web`/`server` → 更新 `agent/zcode.cjs` → 退役旧 token 文件 → 同步 relay unit →
`daemon-reload`（以 `NeedDaemonReload=no` 为门禁）→ 重启三个服务 → 健康检查 →
失败自动回滚。使用前必须完成 0.2 的占位符替换与引号修补。

---

## 7. 回滚

### 7.1 部署脚本自动回滚

健康检查失败时脚本会依次还原：`web`/`server`（整目录回拷）→ relay unit（或把 `ExecStart`
指回 `relay-v28.mjs`）→ `zcode-relay.env` → 旧 token 文件 → `agent/zcode.cjs` → `zcode-web.service`，
然后重启服务并复检 `3030/api/server-info == 401`。备份保留在 `<备份目录>/…-<时间戳>/`。

回滚态的**预期现象**（不是新故障，别据此二次排障）：旧 relay（v28）用
`/api/server-info?token=<旧token>` 拉宣告，而新 3030 已不认 query token，必然 401、
按设计降级为空宣告——**远控页的工作区宣告为空**，但任务列表（来自本机 `tasks-index.sqlite`）仍正常。
彻底恢复 = 重新部署 v29。

### 7.2 手工回滚（等价做法）

1. 恢复 `<部署目录>/web`、`<部署目录>/server` 到备份副本；
2. 恢复 `<配置目录>/zcode-relay.env`，并把 relay unit 的 `ExecStart` 指回
   `relay-v28.mjs`（relay 源码目录有 git 历史，必要时 `git revert`）；
3. 若回滚到读旧 token 的版本，需把旧 token 文件放回并 `chmod 600`；
4. `systemctl daemon-reload && systemctl restart zcode-web zcode-relay zusage-sidecar`；
5. 复跑 5.1 健康检查。

### 7.3 开关级回退（不必回退整个版本）

| 目标 | 做法 | 备注 |
|---|---|---|
| 关掉 CSRF 强制 | `systemctl edit zcode-web` 加 `Environment=ZCODE_CSRF_ENFORCE=0` → restart | 只影响带 Cookie 会话的写请求校验这一项；鉴权本体与 `/api/me` 通道不变 |
| 放宽 WS Origin | `ZCODE_WS_ALLOWED_ORIGINS` 追加域名 | 无需改代码 |
| 回退 `ZCODE_TRUST_PROXY` | 删掉 drop-in 里的该项并 restart | 判定退回按 Host 头；此时经 nginx 的请求若 Origin 与 Host 不一致会被拒，必要时用 `ZCODE_WS_ALLOWED_ORIGINS` 显式列入部署域名 |
| 停状态栏 | 注释 nginx 的 3 处 `sub_filter` → reload；或 `systemctl disable --now zusage-sidecar` | 不影响主链路 |

---

## 8. 陷阱与注意

1. **注意：占位符未替换就使用。** `deploy/` 下的 unit、nginx 站点、部署脚本都是公开口径的占位形态；
   未替换会启动失败或误路由。bash 里 `<数据目录>` 这类未加引号的写法会被当成重定向。见第 0 节。
2. **注意：unit 里的路径不能含空格。** systemd 按空白分词，含空格的 `<Node 安装目录>`
   必须整体加引号，否则 `ExecStart` 解析失败。
3. **注意：`--token` 不要出现在 `ExecStart`。** `/proc/<pid>/cmdline` 与 `ps` 会明文暴露；
   设备凭据模型下该参数的值也被忽略。
4. **注意：密钥不要写在 `Environment=`。** `systemctl show -p Environment` 对任何本地用户可见；
   统一走 `EnvironmentFile=`（600），并保持 `UMask=0077`，让服务新建的文件（含日志、SQLite 附属文件）默认 600。
5. **注意：`daemon-reload` 必须在所有 unit 改动之后。** 早于 unit 修改执行会让 restart
   使用旧定义。可靠门禁：reload 后检查 `systemctl show zcode-web -p NeedDaemonReload --value` 为 `no`。
6. **注意：不要用源码构建的 agent bundle 覆盖 `<部署目录>/agent/zcode.cjs`。**
   插件定义声明了 `requiredSeedPaths`，启动时逐路径核对磁盘上的插件拷贝；
   缺任一文件即记 `ZCODE_PLUGIN_SEED_INCOMPLETE` 并**整插件跳过 seeding**（表现为该插件技能消失）。
   部署目录里的 `packages/` 来自官方发行包，与源码树布局可能不一致。
   要重建 agent 时，先把插件目录同步到与源码版本匹配。
7. **注意：不要直接部署 `packages/web/public/` 下的源文件。** `sw.js` 与
   `zcode-boot-probe.js` 源文件含 `__SW_CACHE_VERSION__` 占位符，必须经
   `pnpm --filter @zcode/web build` 替换为构建时刻时间戳（两者同值）。
   手工拷源文件会让 SW 版本恒定不换版（退化为旧缓存语义）。
   正常 `build` → `cp dist` 的流程天然安全。
8. **注意：nginx 漏配 `^~ /api/relay/` 的后果不是 404。** 该请求会落到 3030
   被会话中间件拦下，返回 **401** `authentication_failed`——直连页无法自助签发门票
   （远控页自助链与 legacy 链不受影响）。
9. **注意：漏配 `/api/v1/client/configs` 的后果。** 会落到 3030（401），远控页启动链路每次报错。
10. **注意：`sub_filter` 需要未压缩的上游。** 必须 `proxy_set_header Accept-Encoding ""`，
    否则上游压缩后的 HTML 里匹配不到 `</head>`。出站压缩交给 nginx 的 gzip，互不冲突。
11. **注意：反代头必须「设置」而不是「透传」。** nginx 默认原样透传客户端带来的
    `X-Forwarded-Host` / `X-Forwarded-Proto`，可被伪造；要用 `$host` / `$scheme` 显式覆盖。
    服务端在 `ZCODE_TRUST_PROXY` 未设时忽略这两个头（纵深）；要开启信任，
    **先 nginx 后服务端**，顺序不可反。
12. **注意：证书路径写死在站点配置里。** 换成自签或别处的证书必须改
    `ssl_certificate` / `ssl_certificate_key` 两行；换证后 reload nginx。
13. **注意：`zcode-relay` 不会随 `zcode-web` 自动回来。** relay 的 unit 有
    `Requires=zcode-web.service`，`systemctl stop zcode-web` 会连带停 relay；
    重启机器不受影响（已 enable）。手工 stop 后需显式 `systemctl start zcode-relay`。
14. **注意：远控页版本敏感。** relay 固定 `app_version`，镜像 HTML 要与之一致；
    server 升级后必须同步重镜像，否则新工具卡会让页面整帧拒收（`recoveryFailed`）。
15. **注意：locale 跟随配置。** 远控页按 `<CLI 数据目录>/v2/setting.json` 的
    `locale` 与 `localePreference`（两键都须为 `zh-CN`）；无头浏览器会把 locale 写成 `en-US`，
    测试脚本要带 `--lang=zh-CN` 并在事后核查该文件。
16. **注意：bootstrap 是严格 schema。** 任务条目缺字段/多字段/类型错都会被整条静默丢弃；
    为空时页面只重试 3×300ms 就显示 0，看起来像「任务列表坏了」。
17. **注意：`--workspace` 决定页面语义。** 必须指向对话后台目录，否则页面不会进入
    「不在项目中工作」的草稿态；项目目录由使用者自建，不预置。

---

## 9. 已知边界

- **服务重启会打断进行中的对话**：`tasks-index.sqlite` 会留下 `running` 孤儿任务。
  手工修法：把 `task_status` 置为 `completed`，`meta_json.status` 同步改。
- **手机切后台被杀 WS 是浏览器 OS 级行为**，网页无法阻止。现有恢复链：
  直连页软重连（socket 死后 1/2/4/8s 退避原地重建 React 树，退避耗尽才整页 reload）；
  远控页靠注入 shim（hidden 期间死 socket → visible 时自动 reload）。
- **半开连接判死**：客户端 15s 探针 / 30s 无帧判死（判死先触发 `onHeartbeatDead` 再 close，
  顺序不可反）；服务端 `/ws` 有 RFC 6455 ping（30s 周期，连续 4 次无 pong 才 terminate，
  为手机后台省电放宽）。页面守卫回前台用 socket 活性判定，**不要用 HTTP fetch**
  （换连接测不出半开）。
- **会话/任务彻底删除**：列表隐藏只是 `deleted=1`；会话存档在
  `<CLI 数据目录>/cli/db/db.sqlite` 与 `<CLI 数据目录>/cli/rollout/*.jsonl`。
  物理删除需三处一起清，然后重启 `zcode-web`。
- **@ 菜单里 Enter 只换行不发送**（官方页面设计），发送点右下角按钮。
- 服务端 ping 循环同时覆盖直连页与远控页（远控页的 RPC 也是页面直连 3030 `/ws`，
  relay 只负责下发 `wsUrl`）。

---

## 10. 相关文件

| 路径 | 内容 |
|---|---|
| `deploy/zcode-web.service` / `deploy/zcode-relay.service` | 两个服务的 systemd unit 样例 |
| `deploy/nginx-zcode.conf` | nginx 站点完整样例（路由 + 注入 + 管理端点拒绝） |
| `deploy/zcode-deploy-*.sh` | 部署脚本（备份 → 同步 → 凭据 → 重启 → 健康检查 → 回滚） |
| `deploy/admin-cli.sh` | 设备管理 CLI（发配对码/列设备/撤销） |
| `deploy/zcode-builtin-provider.json` | 供应商/模型模板快照（当前未接线，接线方式见下条） |
| `relay/` | relay 源码（端点、环境变量与恢复逻辑见其文件头注释与 `docs/architecture.md`） |
| `deploy/e2e/` | 真浏览器验证脚本（半开判死、原地恢复、体感、SW 时序） |
| `packages/server/specs/` | 配对登录与设备凭据的规格（产品规则、接口、验收场景） |
| `packages/server/src/deviceCredentialAuth.ts` | 设备凭据鉴权的实现（TTL、限流、Cookie、管理端点） |

> 供应商模板快照 `deploy/zcode-builtin-provider.json` 目前未接线：要启用需把
> client configs 的 `builtin_provider_config_json` 指向本地 HTTPS 地址（客户端要求绝对 HTTPS），
> 或直接用 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向本地文件；修改后需递增文件内的 `revision`
> 才会被客户端接受。
