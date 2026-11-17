# ZCode 设备凭据模型（替换单 token；直接切换，不做兼容）

> 本文件是交付给 ZCode 服务端/Web 侧的需求规格。参考实现是**参考项目 dsh-mobile 的手机接入**，
> 可直接对照：`<dsh-mobile 部署目录>/mobile-access/remote/devices.json`（设备注册表结构）、
> `<dsh-mobile 部署目录>/profiles/web/node_modules/dsh-mobile/lib/index.mjs`（服务端实现）、
> 客户端 `<upstream-dsh-mobile>/apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/`
> （`NativeAuthClient.kt` / `DeviceCredentialStore.kt` / `NativeSessionCookies.kt`），
> 以及 `README.md` 关于"电脑端撤销"的语义（`:215-219`）。

## 1. 目标 / 非目标

**目标（唯一验收标准）**：任何一份**泄露的客户端凭据**都只能冒充**它所属的那一台设备**，且可被**单独吊销**；
服务端磁盘上不存在可用于直接冒充的明文长期凭据。

**非目标**：不改任务/会话业务逻辑；**不保留**旧单 token 模式的兼容开关（旧通道直接删除，见 §7）；
不做多租户。

## 2. 现状根因（为什么必须换模型）

ZCode 自托管 Web 目前只有一把 bearer token：它既是服务端鉴权依据，**也是每个客户端 Cookie 的值**
（`packages/server/src/http.ts:251` `zcodeLiteTokenCookieName`、`:440-456` `hasValidLiteToken`、
`:552` `Set-Cookie ... = authToken`），保护面覆盖全部 `/api/*` 与 `/ws`（`:458-460`）；
`/api/pairing/code` 也由这同一把 token 授权（`:560-566`）。后果：拿到它 = 全部权限、不可追溯、
只能整体轮换（全端下线）；`packages/server/specs/selfhosted-web-pairing.md:60-66` 已承认这是架构上限。

## 3. 威胁模型

| 泄露面 | 换模型后攻击者得到 | 做不到 |
|---|---|---|
| 浏览器 Cookie（被拷走） | 该浏览器那一台设备的**短期会话** | 拿到长期凭据、冒充其它设备、调管理接口 |
| 手机文件系统被读 | 该手机的设备凭据（**存在 Keystore，不可导出**）或短期会话 | 伪造设备身份、逃避单台吊销 |
| URL 被截图/转发 | 无（长期凭据绝不进 URL，见 I2） | —— |
| 服务端磁盘被读 | 只有 SHA-256 摘要 | 反推凭据 |
| 抓包 TLS 被破 | 该设备的短期会话 | 管理员能力 |

## 4. 不变量（实现与测试都必须满足）

- **不变量1** 服务端只存**摘要**（SHA-256 hex），比较用常量时间；磁盘上不得出现明文 deviceToken。
- **不变量2** 长期凭据只通过 `POST` 请求体传输，**绝不**出现在 URL、Cookie 名值、Referer、日志。
- **I3** 长期凭据与"会话凭据"分离：Web/WebView 会话只承载**短期 sessionToken**（+ CSRF），
  到期用长期凭据换新会话；长期凭据自身有独立有效期，过期必须重新配对。
- **不变量4** 撤销是**按设备**的，且立即生效：该设备后续请求 401、**已建立的 WS 被主动关闭**、其它设备不受影响。
- **不变量5** 管理操作（发配对码/列设备/撤销）只接受**本机 root-only** 通道，**拒绝网络来源**（含经 nginx 的请求）。
- **不变量6** 设备之间零共享：A 的会话/凭据不能读 B 的状态，也不能提升为管理权限。

## 5. 状态所有者与存储

- **设备注册表（持久化，重启不丢）**：`<ZCODE_DATA_BASE_DIR>/.zcode/devices.json`，600，结构照 dsh-mobile：
  ```json
  { "version": 1, "devices": [
    { "id": "<32 hex>", "label": "<≤64>", "tokenDigest": "<sha256 hex>",
      "createdAt": 0, "expiresAt": 0, "lastSeenAt": 0 } ] }
  ```
  撤销 = **删除该条记录**（不保留 tombstone：未知/已删凭据一律 401，与 dsh-mobile 一致）。
- **会话（内存态可接受）**：`sessionToken → {deviceId, csrfToken, expiresAt}`；服务重启后会话失效，
  手机壳会自动 `renew` 恢复，浏览器需重新续期（可接受）。
- **管理密钥**：`<配置目录>/zcode-admin.secret`（600 root:root，与任何客户端凭据**不同**的一份秘密）。

## 6. 协议

TTL 建议（可按实际调整，但必须写进 spec）：配对码 10 分钟/单次；设备凭据 90 天；会话 12 小时。

**管理端点（仅本机；必须同时满足"直连本机"且带管理密钥）**
- `POST /api/admin/pairing-code`  body `{label}` → `{code, expiresAt}`：一次性配对码（服务端只存摘要，10 分钟、单次）
- `GET  /api/admin/devices` → 设备列表（id/label/createdAt/expiresAt/lastSeenAt，**不含凭据**）
- `POST /api/admin/devices/revoke` body `{id}` → 删记录 + 终止该设备所有会话 + 关闭其 WS
- 鉴权：`x-zcode-admin: <zcode-admin.secret 内容>`，且请求必须来自本机直连；
  **nginx 必须显式拒绝 `/api/admin/`**（否则经 443 也能打到本机）。

**客户端端点（公开，无需凭据）**
- `POST /api/pairing/redeem` body `{code, label}` →
  `{deviceId, deviceToken, deviceExpiresAt, sessionToken, sessionExpiresAt, csrfToken,
    sessionCookieName?, csrfCookieName?}`
  （一次性码换"设备凭据 + 首个短期会话"；`code` 单次、10 分钟、只存摘要、按 IP 限流。
  过期时间接受 epoch 毫秒或 ISO-8601 字符串——客户端两种都认。
  两个 Cookie 名可选，缺省 `zcode_device_session` / `zcode_device_csrf`；因为**是手机壳原生发起
  redeem/renew 并把会话注入 WebView**，服务端响应里的 Set-Cookie 到不了 WebView 的 Cookie 罐，
  所以必须由响应体显式告知 Cookie 名，壳照名字注入。）
- `POST /api/auth/renew` body `{deviceToken}` → `{sessionToken, sessionExpiresAt, csrfToken}`（不重复下发 deviceToken）
  （**不延长设备凭据寿命**）
- `POST /api/auth/probe` body `{deviceToken}` → `{reachable:true, instanceId}`（可达性；被撤销 → 401）

**会话承载**
- 会话 Cookie（名字以响应体为准，缺省 `zcode_device_session`）：`Path=/; HttpOnly; Secure; SameSite=Strict`；
  CSRF Cookie 同名规则但不带 `HttpOnly`（页面可读）。**Cookie 值是短期 session，不是长期凭据。**
- `/ws` 用该会话 Cookie 鉴权；撤销时服务端主动关闭该设备的 WS。
- **CSRF 只下发、暂不强制校验**：ZCode 页面目前不发送 CSRF 头，服务端若强制校验会直接打挂应用。
  等页面侧实现（读 CSRF cookie → 写请求头）之后再开启校验；在那之前该 cookie 仅作预留。

## 7. 直接切换（旧模式删除，不做兼容）

**删除项**：`--token`/`ZCODE_SERVER_TOKEN` 作为客户端凭据的一切用法；`?token=` Cookie 下发；
Cookie 值=token；`/api/pairing/code` 与 `/api/pairing/pair`（被 §6 取代）；内存观测设备表。

**切换步骤（部署顺序不可颠倒）**
1. 服务端 + Web 落地 §5/§6 并删除 §7 删除项。
2. 用 root 在本机创建**第一条**配对码（`/api/admin/pairing-code`）。
3. 手机/浏览器用该码配对；**所有旧 Cookie 与旧 token 一律 401**（无过渡期）。
4. 手机壳升级到 §8 的实现。
> 第 1→4 步之间手机连不上（一次性窗口）。这是"直接切掉"的既定代价。

## 8. 手机壳契约（本仓 `mobile/android` 负责实现）

- 配对：壳内完成 `POST /api/pairing/redeem`，`deviceToken` 存 **Android Keystore（不可导出，AES-GCM）**，
  `deviceId/label/expiresAt` 存普通偏好；**绝不**把 deviceToken 放进 URL 或 WebView 存储。
- 会话：启动与续期时壳自己 `renew`，再 `CookieManager.setCookie(...)` 注入会话 Cookie（含 `__Host-` 变体），
  并在导航前确保已注入。
- 撤销/过期：`renew`/`probe` 返回 401 → 状态置为"电脑端已移除"，停止自动重连，提供"重新配对/删除本地记录"。
- 多设备：每台设备一条独立记录与独立 Keystore 别名（参照 dsh-mobile 的 `slot` 做法）。
- **同源多设备**（同一 host 上两台设备/两个凭据）：WebView 的 Cookie 是**按 origin 共享**的，
  不是按"设备条目"隔离的。因此**切换设备时必须先 `renew` 该设备的会话并注入其 Cookie**，
  覆盖同源上一条会话（dsh-mobile 的 `nativeSessionCookies` 就是这个做法）；否则会出现
  "切过去还是上一台的登录态"或互相顶掉。不同 host 的设备天然互不影响。

## 9. 验收场景

- **A1** 旧 token（URL/Cookie/header 任一形式）→ 401。
- **A2** 配对码过期或二次使用 → 403；未知 deviceToken → 401。
- **A3** 设备 A 与 B 各自独立：撤销 A 不影响 B，A 的会话不能读 B 的状态。
- **A4** 撤销即时生效：A 的新请求 401、A 的活跃 WS 被断开。
- **A5** 服务端磁盘检查：`devices.json` 内不含任何明文 deviceToken（只有摘要）。
- **A6** 管理端点的网络可达性：经 443/nginx 访问 `/api/admin/*` 被拒；本机 root 带密钥可用。
- **A7** 手机壳：杀进程重启后凭 Keystore 凭据自动 renew，无需重新配对；被撤销后显示"电脑端已移除"。
- **A8** 会话 Cookie 被拷到另一台机器单独使用：只能得到该设备的会话，且可被系统按设备撤销。
