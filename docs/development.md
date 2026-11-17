# 自托管 ZCode —— 开发与验证指南

面向在本仓库上继续开发的人：目录结构、构建、测试门禁、代码约定、与上游的关系、已知边界与待办。

占位符沿用 `docs/architecture.md` 的约定：`<仓库根>`（本仓库根目录）、`<工作区>`（工作区根目录）、
`<部署目录>`（运行时安装目录）、`<数据目录>`（`ZCODE_DATA_BASE_DIR`）、`<配置目录>`（主机配置目录，
按 `/etc/zcode` 语义）、`<备份目录>`、`<部署域名>`（对外 HTTPS 入口）、`<Android 构建工具目录>`（隔离解包的
JDK/SDK/Gradle 工具链目录）。本文所有命令默认在 `<仓库根>` 下执行，另有注明的除外。

---

## 1. 目录结构

### 1.1 顶层目录

| 目录 | 内容 | 来源/归属 |
| --- | --- | --- |
| `packages/` | pnpm monorepo 主体：上游 ZCode 的 Web / 桌面 / 服务端 / 共享层（见 1.2） | 上游 fork 主体，本仓**直接修改** |
| `apps/zcode-cli/` | Agent CLI 与运行时；打包产物 `agent/zcode.cjs` 的来源 | 上游 fork 主体（本仓有改动） |
| `mobile/` | 自研手机侧：`android/`（Kotlin WebView 壳）、`handoff/`（壳与服务端的协议规格）、`verify/`（壳侧页面验证脚本） | 自研 |
| `relay/` | 自研远控 relay：官方闭源远控页的本地镜像伺服 + 门票模式中继；现役 `relay-v29.mjs`，`relay-v28.mjs` 为回滚件 | 自研 |
| `deploy/` | 部署件：`admin-cli.sh`、`zcode-web.service` / `zcode-relay.service`、`nginx-zcode.conf`、部署脚本、`e2e/`、`patches/`（历史补丁集的说明与附属物） | 自研，**面向具体环境** |
| `docs/` | 本仓文档（架构、部署、开发、运维手册、连接恢复分析） | 自研 |
| `e2e/` | 直连页连接恢复 E2E 脚本（Playwright 驱动，真浏览器） | 自研，**面向具体环境** |
| `scripts/` | 构建与工程脚本（`build-zcode.mjs`、架构检查、依赖图/引用查询等） | 仓库工程目录 |
| `config/` | 随客户端发布的默认配置（`default.json` 等） | 仓库工程目录 |
| `harness/` | 远端 harness（Dockerfile 等） | 仓库工程目录 |
| `patches/` | pnpm `patchedDependencies` 的依赖补丁（上游机制） | 仓库工程目录 |
| `public/`、`third-party/` | 静态图标资源；第三方组件/预构建清单 | 仓库资源目录 |
| `.agents/` | 仓库内技能定义（架构治理、依赖引用查询、UI 等领域技能） | 仓库技能目录 |
| `dist/` | 构建产物（`dist/zcode/` 为发行包输出），已 git 忽略 | 构建输出 |

“仓库工程目录/资源目录/技能目录”指随仓库发布的工程基础设施；其中哪些条目来自上游、哪些为本仓
增补，本轮未逐项区分，引用前先看文件内容与 `git log`。

纳入版本库的还有仓库根文档：`README.md`（结构概览）、`AGENTS.md`（编码规则）、
`DESIGN.md`（UI 设计规范）、`CONTEXT.md`（插件商店领域词汇）、`architecture-policy.yaml`
与 `.architecture-baseline.json`（架构策略与基线）、`.oxlintrc.json` / `.oxfmtrc.json`（lint/格式配置）。

构建与发布产物不进版本库：`.gitignore` 忽略 `dist/`、`mobile/android/app/build/`、
`mobile/android/.gradle/` 与 `*.apk`。

### 1.2 `packages/*` 与 `apps/*` 的职责

| 包 | 职责（一句话） |
| --- | --- |
| `packages/server` | Web 服务端：Hono HTTP + WS、设备凭据鉴权、remote（ssh/docker/wsl）后端、stdio 入口 |
| `packages/services` | 业务服务层：会话/任务/存储/窗口控制器/agent 进程管理/技能与插件等 |
| `packages/ui` | 共享 React 组件、hooks 与 Zustand store（web/desktop 共用） |
| `packages/web` | Web 客户端（Vite 构建的浏览器入口） |
| `packages/shared` | 共享协议与类型（含 `zcode-protocol-v4`、工作区身份） |
| `packages/rpc` | RPC 框架（ChannelServer/ChannelClient、协议帧、KeepAlive 探针） |
| `packages/client` | Agent 客户端 SDK（浏览器连接层） |
| `packages/desktop` | Electron main/host/renderer/preload/scheduler |
| `packages/provider`、`packages/provider-node` | 模型 provider 配置与解析（后者为 Node 侧） |
| `packages/model-option-map` | 模型选项 DSL 的解析/编译/求值 |
| `packages/zcode-server-cli` | server 的 supervisor / CLI / 打包（`@zcode/server-cli`） |
| `packages/zcode-cua` | 浏览器 CUA broker（预构建 JS，无源码脚本） |
| `packages/formal-proof` | 独立 Vite 应用（形式化证明 UI；本部署未涉及） |
| `apps/zcode-cli` | Agent CLI 与运行时；产出部署形态里的 `<部署目录>/agent/zcode.cjs` |

本仓的改动集中在 `packages/server`、`packages/services`、`packages/ui`、`packages/web`、
`packages/rpc`、`apps/zcode-cli`，其中改动量最大的单文件是
`packages/server/src/deviceCredentialAuth.ts`。

---

## 2. 环境与工具链

- **Node / pnpm**：仓库固定用 `mise.toml`（node `24.14.0`、pnpm `10.33.2`）；根 `package.json`
  的 `engines` 要求 Node `>=24`。若本机 Node 低于该版本，pnpm 会打印 `Unsupported engine`
  警告——实测该环境下 `typecheck` / `lint` / 单测仍可全绿，但版本以 `mise.toml` 为准。
- **依赖安装**：`pnpm install`；mise 用户可用 `mise run install` / `mise run bootstrap`。
- **Android 壳**：JDK 17、Android SDK（`compileSdk 36`、build-tools 36.0.0）、Gradle wrapper
  `8.11.1`（`distributionSha256Sum` 固定）、AGP `8.10.1`、Kotlin `2.1.0`。工具链为隔离解包，
  装在 `<Android 构建工具目录>`（`jdk/jdk-17.0.20.1+1`、`sdk`、`gradle-home`），不动系统环境；
  构建内存约束见 `mobile/android/gradle.properties`（`-Xmx1536M`、`workers.max=2`、`parallel=false`）。
- **提交信息风格**：Conventional Commits + 作用域，描述用中文，例如
  `feat(server,services): probe 返回待回复交互的脱敏摘要 pendingDigest`。

---

## 3. 开发流程

1. **先改规格，再改实现**（见 §6.1）：新增或修改行为前，先更新对应 `specs/` 文档，明确产品规则、
   状态所有者、接口与验收场景。
2. **起开发环境**：`pnpm dev:web` = 并行跑 `@zcode/server dev`（tsup watch + 直接启动
   `dist/entry-http.js`）与 `@zcode/web dev`（vite dev server）。
3. **改代码**：遵守 §6 的约定；修复 bug 时用中文注释写明原因与修复依据。
4. **跑门禁**：提交前至少 `pnpm typecheck` + `pnpm lint`；涉及被测包时跑对应单测（§5）。
   仓库另有 `pnpm verify:pre-push`（= `lint` + `architecture:check --changed`）。

---

## 4. 构建与产物

### 4.1 全量发行包

```bash
pnpm build:zcode --base-url https://<部署域名>/dist/
```

脚本 `scripts/build-zcode.mjs` 依次做：

1. `pnpm --filter @zcode/cli... build`（Agent CLI 及依赖）；
2. 清空 `packages/server/dist` 后 `pnpm --filter @zcode/server build`（tsup + remote 后端）；
3. `pnpm --filter @zcode/web build`（vite）；
4. 组装 staging 包（`web/`、`server/`、`agent/`（含 `zcode.cjs` 与 provider 配置）、
   `bin/zcode.mjs`、TUI runtime、运行时 node_modules）；
5. 打成 tarball。

产物与副产物：

| 路径 | 内容 |
| --- | --- |
| `dist/zcode/releases/<version>/zcode-<version>.tar.gz` | 发行包（`<version>` 取自根 `package.json`） |
| `dist/zcode/releases/<version>/sha256.txt` | 发行包校验和 |
| `dist/zcode/latest.json` | 版本、tarball 名、sha256、`--base-url` |
| `dist/zcode/install.sh` | 面向 `--base-url` 的安装脚本 |

`--skip-build` 复用已有 web/server/agent 产物；不传 `--base-url` 且未配置
`ZCODE_DIST_BASE_URL` 时脚本直接报错。

### 4.2 分项构建

```bash
pnpm --filter @zcode/web build       # vite build，产物 packages/web/dist
pnpm --filter @zcode/server build    # tsup，产物 packages/server/dist（entry-http.js 等）
pnpm --filter @zcode/server lint
```

### 4.3 部署产物怎么进 `<部署目录>`

两条路（详见 `docs/deployment.md`）：

- **整包**：`tar -xzf dist/zcode/releases/<ver>/zcode-<ver>.tar.gz -C <部署目录>/..`；
- **省事**：只覆盖两个子目录——`cp -a packages/web/dist/. <部署目录>/web/` 与
  `cp -a packages/server/dist/. <部署目录>/server/`。

三条硬约束：

1. **不要覆盖 `<部署目录>/agent/`**：部署里的插件目录来自官方发行包，与源码构建的
   `requiredSeedPaths` 可能不一致，覆盖 agent bundle 会让插件播种被整插件跳过（表现=指南/技能消失）。
2. **禁止直接部署 `public/` 源文件**：`packages/web/public/sw.js` 与探针脚本含
   `__SW_CACHE_VERSION__` 占位符，只有经 vite build 才被替换为构建时刻 UTC 戳；手工拷贝会让
   Service Worker 版本恒定不换版。
3. **重启服务 = 中断在线会话**：部署动作应在能承受中断的运维执行环境里进行；部署脚本、回滚与
   健康检查见 `docs/deployment.md`。

### 4.4 APK（`mobile/android`）

```bash
cd mobile/android
JAVA_HOME=<Android 构建工具目录>/jdk/jdk-17.0.20.1+1 \
GRADLE_USER_HOME=<Android 构建工具目录>/gradle-home \
ANDROID_HOME=<Android 构建工具目录>/sdk \
./gradlew --no-daemon :app:testDebugUnitTest    # JVM 单测
./gradlew --no-daemon :app:assembleRelease      # R8 + 资源收缩
```

签名：`assembleRelease` → `zipalign -f -p 4` → `apksigner sign --ks
<Android 构建工具目录>/zcode-release.keystore`（个人自签、所有已发布版本同一指纹，可互相覆盖安装；
密码不入仓）。版本号只递增最后一位（当前源码 `versionName 0.1.7` / `versionCode 29`），
变更权归负责人。产物不入库（`*.apk` 忽略）。

---

## 5. 测试门禁

仓库**没有统一的测试命令**（`AGENTS.md` 明示）：测试入口以目标包 `package.json` 的脚本与实际测试
文件为准。各门禁如下（“实测”列为本轮在本机复跑的结果，命令未注明者均从 `<仓库根>` 执行）：

| 门禁 | 命令 | 通过标准 | 实测 |
| --- | --- | --- | --- |
| 服务端单测 | `pnpm --filter @zcode/server test`（= `tsx --test test/*.test.ts`） | 全过、0 失败 | **76/76 通过**（`test/` 下 4 个文件） |
| 服务端单测（单文件） | `pnpm --filter @zcode/server exec tsx --test test/<file>.test.ts` | 同上 | 可按文件跑 |
| `packages/services` 测试 | `pnpm --filter @zcode/services exec tsx --test test/<file>.test.ts` | 全过、0 失败 | 抽跑 1 个文件 **5/5**；该包无 `test` 脚本，需显式指定文件 |
| `packages/ui` 测试 | `pnpm --filter @zcode/ui exec tsx --test test/<file>.test.ts` | 全过、0 失败 | 抽跑 1 个文件 **6/6**；该包无 `test` 脚本 |
| 壳 JVM 单测 | `./gradlew --no-daemon :app:testDebugUnitTest`（在 `mobile/android`，需 §4.4 环境变量） | 全过、0 失败 | **13 个测试类 / 213 个用例全过**（建议加 `--rerun-tasks` 防缓存假绿） |
| 类型检查（全仓） | `pnpm typecheck`（`tsc -b` 一串 project references） | 退出码 0、无诊断 | **通过（无输出）** |
| 类型检查（ui 单包） | `npx tsc --noEmit -p packages/ui` | 退出码 0 | 可作为 ui 包快速门禁（ui 无独立 test 脚本） |
| Lint（全仓） | `pnpm lint`（oxlint） | 目标 **0 error** | **通过：0 error + 118 warning**（警告多为存量 `no-unused-vars`） |
| Lint（分仓） | `pnpm --filter @zcode/{server,web,ui} lint` | 0 error | 三个包均 **0 error**（server 2 / web 11 / ui 39 条存量警告） |
| 架构检查 | `pnpm architecture:check --changed` | 相对 `.architecture-baseline.json`（当前为空）无新增违例 | 基线文件 `{"version":1,"violations":[]}` |
| 格式检查 | `pnpm fmt:check`（oxfmt） | 无差异 | — |
| 未用依赖/导出 | `pnpm knip` | 无新增未用项 | — |
| 提交前 | `pnpm verify:pre-push` | = `lint` + `architecture:check --changed` 通过 | — |
| APK 发布前 | §4.4 单测全绿 + `assembleRelease` 成功 | 两者都要 | — |

判据与注意事项：

- 单文件 400 行上限是硬约束（oxlint `max-lines` + `architecture-policy.yaml` 的 `maxFileLines`），
  仅 `*.test.ts(x)`/`*.spec.ts(x)`、`i18n/locales/*.ts`，以及 `relay/*.mjs`、`*/e2e/*.mjs`
  这类**单文件入口脚本**豁免（对它们是误报，见 `.oxlintrc.json` 的 override 注释）。
  改动 `packages/*` 下的生产代码时，400 行上限照常适用。
- 测试要**真跑**：报告真实结果，不把已有失败写成通过（`AGENTS.md`）；Gradle 加 `--rerun-tasks`，
  避免 up-to-date 缓存导致的假绿。

---

## 6. 代码约定（这个 fork 的规矩）

### 6.1 spec 优先，规格集中在 `packages/*/specs/`

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建（`AGENTS.md`）。
- 现有规格：`packages/server/specs/`（`device-credential-auth.md`、`selfhosted-web-pairing.md`）、
  `packages/ui/specs/`（10 份 UI 行为规格）、`packages/rpc/specs/socket-keepalive.md`。
- spec 要写清四件事：产品规则、**状态所有者**、接口、验收场景。服务端鉴权 spec 还列了
  实现与测试都必须满足的六条不变量（只存摘要、长期凭据只走 POST body、长期/会话凭据分离、
  按设备即时撤销、管理端点只认本机 root-only、设备之间零共享），实现文件头逐条回指这些不变量。
- **测试与实现同步演进**：改了行为就补测试或改测试；服务端测试有直接读
  sqlite 列做断言的做法，用于钉住持久化语义而不是内存态。

### 6.2 改上游文件的注意事项

- 本仓**直接改上游文件**（不是"只在补丁里叠加"）。因此"跟随上游"是**行级**判断：
  在改过的文件里，上游原有行（含 i18n 字符串）保持逐字不变，自研改动尽量独立成块。
- 改动集中在少数包（见 §1.2）：加新逻辑时优先落在自研模块（如
  `packages/server/src/deviceCredentialAuth.ts`），经 `http.ts` 一类装配点接线，避免扩散。
- 明确边界，不用超时掩盖同步问题：状态要有唯一所有者与单一写入路径；事件顺序与幂等边界要写清。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。
- hooks 中含 JSX 的文件用 `.tsx`；跨包导入走公开入口，遵守现有路径别名。

### 6.3 日志与敏感信息

- UI 日志走 `packages/ui/src/logger.ts`；服务日志走 `createServiceLogger(scope)`；不直接 `console.log`。
- `debug` 只用于高频诊断（协议原始数据、流式 chunk），生产不落盘；`info` 用于生命周期类事件；
  `warn`/`error` 分别给可恢复异常与不可恢复错误。
- 不在日志、示例、提交、文档中写入凭据、真实用户数据与内部服务地址；磁盘上设备凭据只存
  SHA-256 摘要；keystore 与密码不入仓（仓库根 `README.md` 的敏感边界）。

### 6.4 鉴权相关的硬约定（`packages/server`）

- 鉴权模型是**设备凭据**：配对码 → 长期设备凭据（滑动 90 天、365 天绝对上限）→ 12h 会话 +
  续期 Cookie 静默自愈；旧单 token 已整体删除，**不留兼容开关**。
- 长期凭据只通过 `POST` body 传输，绝不进 URL / Cookie 名值 / Referer / 日志；服务端只存摘要，
  比较用常量时间。
- 保护面（`/api/*` 与 `/ws*`）内所有带 Cookie 会话的 `POST/PUT/PATCH/DELETE` 必须带
  `x-zcode-csrf`（摘要层常量时间比对）；**新增 POST 端点前先确认它在保护面还是豁免面**
  （豁免面的既有理由：公开自救通道凭 body 凭据、admin 双闸、bots webhook 凭业务 secret、
  `/ws/host` 凭 capability 票）。回退开关 `ZCODE_CSRF_ENFORCE=0` 只用于应急，正常部署不设。
- WS 升级走 Origin 白名单（默认"同源"判定）：请求视角的 host/scheme 默认只信 `Host` 头；
  只有在部署方显式设置 `ZCODE_TRUST_PROXY=1` 时才采信 `X-Forwarded-Host`/`X-Forwarded-Proto`
  ——开启前提是 nginx 已用 `proxy_set_header` 覆写这两个头（见 `deploy/nginx-zcode.conf`）。
  跨域部署用 `ZCODE_WS_ALLOWED_ORIGINS` 追加。
- 管理端点（`/api/admin/*`）双闸：本机 socket 判定 + `x-zcode-admin` 密钥；nginx 另有
  403 兜底。新端点的限流器沿用有界工厂（key 表 4096 上限、满表 fail-closed）。
- 错误码用固定字面量（`authentication_failed` / `forbidden` / `device_revoked` /
  `device_expired` / `rate_limited` / `payload_too_large` 等），壳与页面靠它们区分 UI 行为，
  不要复用或改名。

### 6.5 验证纪律

- **UI 几何类问题先读实况**：空白/错位/截断类报告先取截图做几何解读（或 390×844 无头复现），
  再做代码推演；禁止只做"收缩让位"式改动——hover 专用留白在触屏是浪费，要重排
  （右面板实机宽度 `min(85vw,480px)`，实机 360–400px）。
- 数量/状态/清单类结论先实查再写；测试未被真正执行时如实说明。
- 触屏与桌面语义可能不同（系统会接管选择事件、`pointer`/`click` 通道差异），桌面结论不能直接
  搬到手机；涉及连接/时序/远端同步的改动，应给出状态所有者与事件顺序。

---

## 7. 与上游的关系与升级

### 7.1 关系

- 上游是开源的 `zai-org/ZCode`（Apache-2.0）；本 fork 基线为上游 **v3.14.3（commit `29628c9`）**，
  fork 之后采用**直接改上游文件**的形态（`packages/ui`、`packages/services`、`packages/web`、
  `packages/server`、`packages/rpc`、`apps/zcode-cli` 均有本项目改动）。
  > 说明：本仓经过一次历史重写/清洗，仓内标签 `v3.14.3` 指向重写后的提交
  > `055569935b53933d95542e03ec9ebfadf2d4e7b1`；它与上游 `29628c9` 的对应关系**待核实**。
- 本仓库**不维护独立补丁集**：历史上有过一份"把改动整体施加到干净上游树"的累积补丁，
  在仓库已包含全部改动后成为冗余产物且已陈旧，**已移除**。**本仓库即唯一真源**。
- `deploy/` 下与具体环境相关的 unit / nginx 配置 / 部署脚本是**模板**（含占位符），
  使用前按自己的环境替换。

### 7.2 升级上游版本时要做什么

1. 取新上游 tag，先做**行级 diff**：把 `packages/*`、`apps/zcode-cli` 的自研改动重放到新基线
   （rebase/合并），逐块保留上游原文，冲突处按 §6.2 处理。
2. 同步 spec 与测试：行为变化先落到 `specs/`，再改实现；补测被上游重构影响的断言。
3. 跑全部门禁（§5）：`pnpm typecheck`、`pnpm lint`、`pnpm --filter @zcode/server test`，
   涉及壳协议时跑 `:app:testDebugUnitTest`。
4. 重建产物（§4.1），并按需同步版本敏感点：
   - relay 固定下发的远控页 `app_version` 必须与 server 版本配套，升级 server 后要重新镜像官方
     远控页资源（`docs/deployment.md` 的组件部署节）；
   - Service Worker 缓存戳由构建自动替换，禁止手工拷贝 `public/`；
   - 覆盖 `<部署目录>/agent/` 前核对插件目录与源码 `requiredSeedPaths` 是否同版（否则整插件跳过）。
5. 若同时维护补丁集：重新生成补丁并重验"干净基线 + apply → 树哈希一致"。

---

## 8. 已知边界与待办

### 8.1 已知限制（当前源码中仍成立）

> 只收录在当前源码里核实到的行为；历史上出现、后续已修掉的问题不再列入。

**布局与交互**

- 触屏或窄视口下（`isHoverNone || isNarrowViewport`），点 workspace 行头只展开/收起任务列表，
  不再"打开工作区"；新建对话只走行尾 `+` 按钮。判定含纯视口宽度，**桌面窄窗口（<768px）同样进入
  该语义**（`packages/ui/src/WorkspaceSidebarItem.tsx`）。
- 长按选字：`useTextSelection.close()` 只在选区 anchor 与 focus **都在** root 内时才清除浏览器
  选区；选区一端拖出 root 时只清 snapshot、高亮可能残留（保守设计，避免误清别处选区，
  见 `packages/ui/src/hooks/useTextSelection.ts` 注释）。

**连接与平台**

- 手机浏览器切后台被系统冻结/回收 WebSocket 是 OS 行为，页面无法阻止；现有机制只保证"判死 +
  原地软重连"，不保证不断（`docs/architecture.md`）。
- WebView 整页丢弃（`document.wasDiscarded`）仍会产生一次页面加载（依赖本地缓存秒开）。
- 半开判死必须在"应用正在用的那条连接"上收发心跳：换连接的探测（HTTP fetch、另开 WS）测不出半开
  ——新增恢复逻辑时不要退回 HTTP 探测（`packages/rpc/specs/socket-keepalive.md`）。
- WS Origin 判定中 scheme 不参与比较（默认端口归一下同 host 跨 scheme 判同源）；spec 将其登记为
  已接受的宽松面。
- 壳的前台服务（FGS）只保活 + 探测连通性，**无法感知任务完成**：页面冻结/进程被杀期间的完成通知会丢
  （计数保留在 SharedPreferences）。服务端已提供 `/api/me/pending-summary` 与 probe 的
  `pendingDigest`，壳侧是否消费、是否已部署**待核实**（`mobile/android/README.md` 与
  `packages/server/specs/device-credential-auth.md` 的记载不一致）。

### 8.2 待办（未实装 / 未落地）

- 下一批部署待执行：内存回收改为**由真实资源压力触发**（去掉墙钟回收）、清理 unit 中已失效的
  `ZCODE_AGENT_CHAT_IDLE_TIMEOUT_MS`、隐私清理、配置快照重推排查。
- 通知正文批次（probe 可选 `pendingDigest`）代码已合入、**待部署**；`onPause` 真机 A/B 待测。
- 后台推送方案未定：不做厂商推送通道，前台服务保活是当前边界。
- `client/configs` 自建未开工。
- 用于冒烟验证的测试设备（`e2e-smoke`）是否撤销待定。
- 会话分享不恢复：不豁免 `/share` 门禁、不建公开预览路由（不扩大匿名公开面）。
- WSL 远程类型永久不做；`relay`/`zusage` 属独立生态，本轮不动（`zusage` 仍依赖旧的
  `<数据目录>/.zcode-token`，待随设备会话鉴权对齐）。
- 触屏选区菜单（桌面同款框选菜单在手机上可用）记为后续项。

### 8.3 安全边界现状

**已收口**

- CSRF 强制（保护面）已生效；WS 升级 Origin 白名单默认生效，且默认**不信任**可伪造的
  `X-Forwarded-*`（`ZCODE_TRUST_PROXY=1` 才采信，部署侧必须同时覆写这两个头）。
- `/api/bots/*` webhook：未配置 secret 的 bot → 401（fail-closed），未知 botId → 404。
- 限流器 key 表有界（4096，满表拒绝新 key）；管理端点双闸 + nginx 403 兜底；静态文件与
  预览代理的路径/SSRF 校验链完整。

**仍未收口 / 属设计取舍**

- 长期设备凭据 renew 时**不轮换**：泄漏的 deviceToken 在设备被手动撤销前始终可用（窗口 90–365 天）。
- 公共服务面全量暴露于公网，nginx 层无限速/封禁，鉴权层是唯一闸门；若收敛到 VPN/隧道，攻击面可归零。
- 会话 12h 长于常见参考值（有续期 Cookie 与静默自愈兜底，属可辩护取舍）。
- 配对码字符集含易混字符（体验问题，熵足够）。
- `POST /api/me/workspaces/register` 允许已配对设备把任意**真实存在**的目录加入下载/预览根集合
  ——已配对设备等价于受信设备，这是 spec 明确登记的信任假设。

### 8.4 文档/口径已过时，使用前需核对

- `mobile/android/README.md` 与 `SPEC.md` 仍写版本 `0.1.3`/`versionCode 25` 与旧测试数（125/130），
  与源码（`0.1.7`/`29`）和实测（213 用例）不符（**待核实**：以 `app/build.gradle.kts` 与实跑为准）。
- `mobile/verify/` 的部分脚本（如 `console-check.mjs`）仍以 `<数据目录>/.zcode-token` + `?token=`
  进入页面，与现行设备凭据鉴权不符（历史脚本，未实跑，**待核实**）。
- `e2e/` 与 `deploy/e2e/` 脚本说明仍用 `ZCODE_TOKEN` 环境变量配置鉴权，可能同属旧模型残留
  （未实跑，**待核实**）。

---

## 9. 相关文档

- 文档总索引：`docs/README.md`
- 架构说明：`docs/architecture.md`；部署指南：`docs/deployment.md`
- 运维手册（拓扑、关键机制、日常运维、发布物）：`docs/deployment.md`
- 连接恢复专题（半开判死、软重连、QR 流可行性）：`docs/architecture.md`
- 仓库编码规则：`README.md`、`AGENTS.md`；UI 设计规范：`DESIGN.md`
- 服务端鉴权规格：`packages/server/specs/device-credential-auth.md`
- 壳与服务端协议：`mobile/handoff/zcode-device-credential-spec.md`、`mobile/android/README.md`
