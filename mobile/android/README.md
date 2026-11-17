# ZCode Android shell

ZCode 手机的 APP 壳：一个独立 Android WebView 工程，包名 `io.github.xhwxt.zcodemobile`，应用名 **ZCode**，当前 versionName `0.1.7` / versionCode `29`（**已发布**：设备凭据协议层 + 壳侧续期注入 + 原生"配对码登录" + 前台服务保活速览 + 通知联动 + 下载请求转交系统浏览器 + probe 共享缓存与文本选择守卫 + 任务完成与待回复看门狗；已知缺口见文末）。设计规范见 [SPEC.md](SPEC.md)。

壳承载现有 ZCode Web（直连页 `/?token=…` 与远控页 `/web-remote?remoteControlToken=…` 两种链接），支持**多设备**保存与切换。自 0.6 起壳也负责**鉴权**：每台设备的长期凭据存进 Android Keystore（不可导出），进设备时先用它换短期会话、注入 Cookie，再加载页面；配对在壳内完成（设备名 ⋮ → 配对码登录），因此凭据不会落在页面存储里。会话/WS 的**应用**逻辑仍完全由 Web 端拥有，壳不做任何 reload 干预。

## 构建与测试

需要 JDK 17 与 Android SDK（compileSdk 36）。构建机没有系统级 Android 工具链时的做法见下文「构建环境」。

```bash
cd mobile/android
./gradlew --no-daemon :app:testDebugUnitTest   # JVM 单测（213 个，无需模拟器）
./gradlew --no-daemon :app:assembleRelease     # R8 压缩 + 资源收缩
```

- Gradle wrapper **8.11.1**，`gradle-wrapper.properties` 固定 `distributionSha256Sum`（官方真实值）
- AGP `8.10.1` + Kotlin `2.1.0`（根 `build.gradle.kts` plugins DSL 声明）
- 内存约束：`-Xmx1536M`、`workers.max=2`、`parallel=false`（见 `gradle.properties`）
- 依赖仅 4 个：`androidx.activity:activity-ktx`、`androidx.core:core-ktx`、`androidx.webkit:webkit`、`junit`（test）

### 签名

发布用自签 keystore 不入仓，密码也不入仓。发布流程：`assembleRelease` → `zipalign -f -p 4` → `apksigner sign --ks <发布用 keystore>`。使用同一签名密钥的版本可互相覆盖安装。

### 构建环境

JDK/SDK 均为隔离解包（未动系统）：`<Android 构建工具目录>/jdk/jdk-17.0.20.1+1`、`<Android 构建工具目录>/sdk`（platforms;android-36 + build-tools;36.0.0），构建时 `JAVA_HOME`/`ANDROID_HOME` 指过去。**注意临时目录易失**：重启后需按 `downloads.json` 的校验和重新下载；如需长期保留应放到持久目录。

## 代码结构与职责

| 文件 | 职责 |
| --- | --- |
| `EntryLinkPolicy.kt` | 纯 Kotlin 链接校验（无 Android 依赖，全 JVM 单测）：仅 HTTPS、host 合法性、端口 1–65535、路径仅 `/`、`/web-remote` 与 `/api/pairing/page`，且 `/`（无 query）与配对页（无 query）作为配对登录入口同样合法、`/?token=` 与 `/web-remote?remoteControlToken=` 必须且仅含对应凭据参数（同名至多一次、值非空）；`isSameOrigin`（scheme+host+端口，默认端口归一）；`hasCredentialInQuery` 凭据外发守卫。错误文案静态常量，绝不回显输入。 |
| `DeviceStore.kt` | 多设备存储：`devices.json` 明文元数据（名称/origin/类型/最近使用），`connections.enc` 单一 Keystore AES-256-GCM 加密载荷（随机 12B IV，临时文件+重命名原子落盘）。`save/delete/touch/list/linkOf/clearAll`，全部 `@Synchronized`；任何 Keystore 失败抛 `StoreException`，绝不降级明文。 |
| `DeviceAuthPolicy.kt` + `DeviceAuthClient.kt` | **每设备凭据协议层**（纯 JVM、无 Android 依赖，已接线）：路径/请求体/响应解析/失败归类/Cookie 组装全在这一层，字段改名只动一处；客户端用 `HttpURLConnection`，可在单测里对着本地假服务端验证 redeem/renew/probe 的成功、403、401、畸形响应与不可达。契约见 `handoff/zcode-device-credential-spec.md` §6。 |
| `DeviceCredentialStore.kt` | **凭据落盘**：每台设备一个 Keystore 别名（`zcode_device_v1_<deviceId>`，AES-256-GCM，不可导出），密文放该设备专属 SharedPreferences；任何 Keystore 失败抛 `StoreException`，**无明文降级**。短期会话 token 永不落盘——每次进设备用长期凭据现换。删除设备时一并清除。 |
| `showEditAddressDialog`（在 `MainActivity.kt`）| 动作面板里的"编辑地址"：预填当前链接、复用 `EntryLinkPolicy` 校验后**原地更新**该设备（`save(..., existingId)`），正在使用的那台自动重连。补它是为了不改动"添加设备表单"也能替换失效链接（例如服务端已停用的 `?token=` 旧链接），避免为此删了重加或同源留两条记录。 |
| `MainActivity.kt` | 唯一 Activity，三态：添加设备表单 / 设备列表 / WebView。壳配色**跟随页面主题**（zai-dark/zai-light，非系统日夜）：单一 `Theme.ZCode`（`values/` 浅色 + `values-night/` 深色）+ **全部 chrome 在代码里按 `ShellPalette`/`ShellUi` 现画**（不用运行时 `setTheme()`——Android 会按资源 id 缓存已上色的 drawable，正是早先浅/深混色的根因）；切换主题时原地重绘（`restyleCurrentScreen()`），不重新 inflate。鉴权：进设备先用 Keystore 凭据 `renew` 并注入会话/CSRF Cookie 再加载；`onResume` 会话临近到期时静默续期（不重载页面）；`renew` 返回 401 = 电脑端已移除 → 「此设备已被移除 + 重新配对」；设备动作面板含**配对码登录**（原生对话框 `redeem`，成功后凭据入 Keystore、入口规整成裸域名）。崩溃防护：未捕获异常写入 `last_crash.txt`，下次启动在表单页显示异常类名+消息（不含链接数据）。 |
| `DeviceListAdapter.kt` | 设备卡片渲染：名称（17sp 粗体）、`类型 · origin`、状态行（8dp 色点 + 相对时间），⋮ 操作按钮 + chevron。点击/长按挂在行上（不用 ListView item click——clickable 行会吞掉它）。 |
| `ThemeChannel.kt` | 页面→壳单向信号，双通道：主通道 console 消息前缀 `__zcode_shell__:`（`onConsoleMessage` 拦截，无特性依赖）；辅助通道 androidx.webkit `addWebMessageListener`（dsh-mobile 模式，限定本源）。页面侧脚本上报实时计算背景色/明暗 + 长按左上角侧栏按钮（`lucide-panel-left-*` 唯一锚点，已在真实页面端到端验证）500ms 发 `devices`。页面永远拿不到可调用的原生 API。**发送纪律（0.6.x）**：`PAGE_SIDE_JS` 的 `post()` 单通道发送——优先 `zcodeShell.postMessage`，失败才落 console；`NOTIFICATION_SHIM_JS` 的 post 同构。任务计数消息（`task-started`/`task-finished`）是**增量事件**，页面必须且只发一次；页面侧辅助入口 `window.zcodeShellTaskEvents.started()/finished()`。 |
| `UploadRequestState.kt` | 上传请求生命周期：单请求登记，`onActivityResult` 校验请求码+Activity 存活+connectionId 未变；连接切换/销毁统一 `invalidate()` 回调 null，不悬挂。 |
| `WebFiles.kt` | 选择器工具：多选判定、结果 Intent 提取 Uri 数组。 |
| `WindowInsets.kt` | dsh-mobile WindowInsets 移植（minSdk 29 裁剪）：`resolveTopSafeInset`（状态栏/刘海取高）、`resolveWebViewImeInset`（键盘）、`insetsForWebContent`（壳取走顶部后剩余转发页面）。 |

## 资源

- `res/values/colors.xml`：两套调色板颜色值（亮=页面 zai-light token：#f8f8f8/#0d0d0d；暗=zai-dark：#161616/#fafafa；主按钮用同色系 tonal 面，不做纯反色）
- `res/values/themes.xml` + `res/values-night/themes.xml`：单主题 `Theme.ZCode` 的亮/暗两个变体，跟随**系统**日夜——WebView 的 `prefers-color-scheme` 会参考应用主题，之前强制深色父主题会让页面「跟随系统」判成暗色
- `res/layout/`：连接表单、设备列表（卡片行 item_device + 空状态 + 底部添加按钮）、WebView 容器（FrameLayout 根——insets 监听器赋 FrameLayout.LayoutParams 不会 ClassCastException）、错误页
- `res/drawable/`：全部为纯白可着色图标（`ic_server`/`ic_more_vert`/`ic_chevron_right`/`ic_brand`/`ic_notification`（`ic_add` 已随"添加设备按钮去掉 + 号"一并删除）），颜色由代码 `setColorFilter` 施加；卡片/按钮/输入框形状由 `ShellUi` 在代码里构建（无主题化 XML drawable）
- `res/layout/view_connecting.xml`：连接覆盖层（慢网回退入口）
- `TaskNotifier.kt` + `NotificationTextPolicy.kt`：后台任务完成通知。页面自己会调 `new window.Notification(...)`（`ZCode/packages/web/src/main.tsx`，仅在页面失焦时），但 Android WebView 没有 Web Notifications API，于是页面静默放弃；壳按 dsh-mobile 的做法补上——`ThemeChannel.NOTIFICATION_SHIM_JS` 在 document-start 定义 `window.Notification` 并把 `{title,body}` 转发给壳，壳走原生 `NotificationChannel`（IMPORTANCE_DEFAULT、点击打开应用、空文本不发；渠道被单独关闭时视为不可用）。shim 同时把 `document.hasFocus()` 绑定到 `document.hidden`——页面 gate 判的是焦点，而 dsh-mobile 的页面侧通知器用的是可见性（`dsh-mobile/src/task-notify.ts:382,414`），后台文档声称"有焦点"本身也不成立。文本清洗（标题 80、正文 200 码点，单行化、去控制符、不劈代理对）在纯 JVM 策略里，可单测。
- `res/mipmap-*`：启动图标 = ZCode 真实 favicon 的白色 Z 字标提取 + #161616 底
- `res/xml/`：`network_security_config`（仅系统 CA、禁明文）、`backup_rules` + `data_extraction_rules`（排除 `connections.enc` 与 `devices.json`，新旧双覆盖）

Manifest：`INTERNET` 权限、`allowBackup=false`、`usesCleartextTraffic=false`、Activity `configChanges` 全覆盖（旋转/键盘不重建不 reload）、`windowSoftInputMode=adjustResize`。

## JVM 单测

`EntryLinkPolicyTest`（55）：合法两形态、端口边界（0 拒/1 过/65535 过/65536 拒）、userinfo、http/javascript/data/file/intent scheme 拒、路径与 query 全规则、相似域/后缀欺骗、凭据外发守卫、host 边界、**错误文案不回显输入**。
`NavigationPolicyTest`（7）：origin 构建、返回导航同源判定。
`KeepaliveStatusPolicyTest`：速览文案映射——运行中优先、断连（连续失败 ≥2）、无凭据、已完成、空闲的优先级与回退，连接态映射 `connectionFor`（阈值 2、NO_CREDENTIAL 压过 streak）、计数 reducer（floor 0 / 只增到消费）。

**注意**：纯策略逻辑可单测；`MainActivity`/`DeviceStore`/`ThemeChannel` 依赖 Android framework/Keystore/WebView，为真机验证范围（见下）。

## 常驻通知速览与任务计数（0.6.x 协议）

- **速览文案优先级**（`KeepaliveStatusPolicy.summaryLine`）：运行中 N（`运行中 N · 已完成 M`）＞ 连续 2 次 probe 失败（`连接断开，重试中`）＞ probe 无凭据（`未配对或凭据失效，请在 App 内重新配对`）＞ 已完成未读（`已完成 M，点开查看`）＞ 空闲（`已连接，空闲中`）。单次 probe 失败不改变文案（防抖）。
- **probe 凭据来源（0.1.3）**：probe 优先使用 `ProbeTargetCache`（进程内共享缓存，`MainActivity` 在 connectToDevice / 续期成功 / 配对成功时写入页面主流程已验证的 deviceToken+origin，`dropCredential` 与 probe 401=REVOKED 时清除，token 只在内存、永不落盘/进日志）；缓存为空（冷启动 FGS 先于页面运行）才回退旧链路（DeviceStore → linkOf → link 校验 → Keystore 逐次解密）。这修掉了"页面正常聊天、速览却报未配对"——旧链路任何一环瞬时 Keystore 失败都会让 probe 与页面用的内存凭据脱节。
- **任务计数协议**（页面侧对齐用）：消息经 ThemeChannel 单通道发送（优先 `window.zcodeShell.postMessage`，异常才 console `__zcode_shell__:` 前缀，**禁止双发**——计数是增量事件）：
  - `task-started`：页面确认一个任务开始运行时发一次 → 壳 running+1；
  - `task-finished`：页面确认一个任务到达终态时发一次 → 壳 running−1（floor 0）、completedUnread+1；
  - `tasks-consumed` / `notify-clear`：语义不变（清零已完成未读 / 清通知）；
  - 壳在每次主文档开始加载（`onPageStarted`）把 running 清零：页面（重）连后重发 task-started 不会双计；
  - 无壳环境两个消息静默 no-op。
- **FGS 边界**：前台服务只保活 + 探测连通性，无法感知任务完成（设备凭据下没有任务状态端点，probe 只回答 reachable/instanceId）。后台完成通知仍依赖页面的 Notification shim；WebView 被冻结/进程被杀期间完成的任务，其通知会丢失（计数保留在 SharedPreferences，回 App 可见）。完整方案需要服务端提供设备凭据可用的 pending-count 轮询端点（属服务端工作，未实装）。

## 分发

发布地址固定格式：`https://<部署域名>/app/zcode-mobile-<version>.apk`（独立静态服务 + nginx `/app/` 反代，404 即真 404；只保留最新版）。历史 APK 在部署机的 APK 分发目录与 `mobile/` 根目录留档。

## 已验证 / 真机待验

**宿主已验证**：213 单测全过（含设备凭据协议层——测试里起本地 HTTP 服务端验证 redeem/renew/probe 的成功、403、401、畸形响应与不可达；含前台服务速览与通知联动策略、probe 共享缓存回退语义）；release 构建可复现（产物哈希与发布件一致）；解包核对主题/布局/图标/注入脚本进包；长按跳转与主题上报脚本在真实页面（390×844 移动仿真）端到端验证，含负对照。

**真机待验**：Keystore 落盘与重启恢复、配对码登录（原生 redeem）、进设备自动续期、被撤销时的「此设备已被移除」、设备切换/重命名/编辑地址/删除、长按侧栏跳转、状态栏颜色与图标明暗、上传选择器、渲染进程回收重建、前台服务常驻通知的运行中/已完成计数、通知栏任务提醒与自动消失。装上后如有异常，表单页会显示「上次异常：类名+消息」，便于定位。

**历史缺口已闭合（原 0.6.1 记载）**：「App 开着时服务端重启不自动续期」已由设备凭据自愈机制修复（服务端静默换发 + 页面软重连 401 处理 + 壳侧续期 Cookie 注入），不再是缺口。

## 归属说明

`gradlew`/`gradlew.bat`/`gradle-wrapper.jar` 复制自 dsh-mobile 的 Gradle wrapper（Gradle 官方生成文件，Apache-2.0，见 [LICENSE](LICENSE)）。`WindowInsets.kt` 与状态栏图标对比阈值同源于 dsh-mobile（Apache-2.0），文件头已注明。
