# 自托管 Web 设备凭据鉴权（Device Credential Auth）

> 本 spec 是 `mobile/handoff/zcode-device-credential-spec.md`（需求规格）的仓库内落地版，
> 直接替换旧单 token 模式，**不做兼容、不留开关**。参考实现：移动端接入方案的
> devices.json 注册表结构。

## 背景与问题

旧模型（`packages/server/specs/selfhosted-web-pairing.md` 所述架构）只有一把 bearer token：
它是服务端鉴权依据，也是每个客户端 Cookie 的值（`zcode_lite_token`）。拿到它 = 全部权限、
不可追溯、只能整体轮换（全端下线）。该 spec 已承认这是架构上限。

## 目标 / 非目标

**目标（唯一验收标准）**：任何一份**泄露的客户端凭据**都只能冒充**它所属的那一台设备**，
且可被**单独吊销**；服务端磁盘上不存在可用于直接冒充的明文长期凭据。

**非目标**：不改任务/会话业务逻辑；不保留旧单 token 模式的兼容开关；不做多租户；
手机壳的 Keystore 行为由 `mobile/android` 负责，不在本 spec 范围。

## 威胁模型

| 泄露面               | 攻击者得到                                    | 做不到                                 |
| -------------------- | --------------------------------------------- | -------------------------------------- |
| 浏览器 Cookie 被拷走 | 该浏览器那台设备的**短期会话**                | 拿到长期凭据、冒充其它设备、调管理接口 |
| 手机文件系统被读     | 该手机的设备凭据（壳内存 Keystore）或短期会话 | 伪造设备身份、逃避单台吊销             |
| URL 被截图/转发      | 无（长期凭据绝不进 URL，见不变量2）               | ——                                     |
| 服务端磁盘被读       | 只有 SHA-256 摘要                             | 反推凭据                               |
| 抓包 TLS 被破        | 该设备的短期会话                              | 管理员能力                             |

## 不变量（实现与测试都必须满足）

- **不变量1** 服务端只存**摘要**（SHA-256 hex），比较用常量时间；磁盘上不得出现明文 deviceToken。
- **不变量2** 长期凭据只通过 `POST` 请求体传输，**绝不**出现在 URL、Cookie 名值、Referer、日志。
- **不变量3** 长期凭据与会话凭据分离：Web/WebView 会话只承载**短期 sessionToken**（+ CSRF），
  到期用长期凭据 `renew` 换新会话；长期凭据寿命为**滑动窗口**（renew 顺延 DEVICE_TTL，自创建起 365 天绝对上限兜底），连续 DEVICE_TTL 天不活动才失效，过期必须重新配对。
- **不变量4** 撤销是**按设备**的，且立即生效：该设备后续请求 401、**已建立的 WS 被主动关闭**、
  其它设备不受影响。
- **不变量5** 管理操作（发配对码/列设备/撤销）只接受**本机 root-only** 通道，**拒绝网络来源**
  （含经 nginx 转发的请求）。
- **不变量6** 设备之间零共享：A 的会话/凭据不能读 B 的状态，也不能提升为管理权限
  （管理端点只认 admin secret，不认任何设备会话）。

## 凭据形态（写死，壳端正则按此实现）

| 项                                     | 形态                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| deviceToken / sessionToken / csrfToken | 43 字符 base64url（`randomBytes(32).toString("base64url")`） |
| deviceId                               | 32 hex（`randomBytes(16)`）                                  |
| instanceId                             | 64 hex，首次创建 devices.json 时生成并**固化在文件顶层**     |
| 配对码                                 | 12 字符 base64url（72 bit 熵）                               |

## 状态所有者与存储

| 状态                      | 所有者                    | 位置                                                                                             | 生命周期                                                                         |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 设备注册表                | `deviceCredentialAuth.ts` | `<dataBaseDir>/.zcode/devices.json`（600）                                                       | 持久化，重启不丢                                                                 |
| 短期会话                  | `deviceCredentialAuth.ts` | 内存 `Map<sha256(sessionToken), {deviceId, csrfDigest, expiresAt}>`（key 与 csrf 均存摘要） | ≤12h（封顶于设备寿命）；重启即失效（壳自动 renew，浏览器重新配对）               |
| 配对码                    | `deviceCredentialAuth.ts` | 内存 `Array<{digest, label, expiresAt}>`                                                         | 10 分钟、单次、只存摘要、**全局单窗口**                                   |
| 管理密钥                  | 文件系统                  | `ZCODE_ADMIN_SECRET_FILE`（缺省 `/etc/zcode/zcode-admin.secret`，600 root:root）                 | 与任何客户端凭据不同的一份秘密；每请求读文件，支持不重启轮换                     |
| redeem/renew/probe 限流表 | `deviceCredentialAuth.ts` | 内存 `Map<ip, timestamps[]>`                                                                     | 三件套独立计数：redeem 10 次/10 分钟/IP；renew、probe 各 30 次/10 分钟/IP |
| WS 注册表                 | `deviceCredentialAuth.ts` | 内存 `Map<sha256(sessionToken), Set<socket>>`                                                    | 跟随连接 close 自动摘除                                                          |

`dataBaseDir` = `getZCodeDataRootDir()`（`@zcode/services/node`），即 `ZCODE_DATA_BASE_DIR`（或 HOME）下的 `.zcode`。

`devices.json` 结构（epoch 毫秒）：

```json
{
  "version": 1,
  "instanceId": "<64 hex>",
  "devices": [
    {
      "id": "<32 hex>",
      "label": "<≤64 字符>",
      "tokenDigest": "<sha256 hex>",
      "createdAt": 0,
      "expiresAt": 0,
      "lastSeenAt": 0
    }
  ]
}
```

- 撤销 = **删除该条记录**（不保留 tombstone：未知/已删凭据一律 401）。
- **原子写**：tmp 文件（`wx` flag、0600）→ 末尾 `\n` → `rename`；写入前拒绝符号链接目标；
  加载限 1MiB、lstat 拒符号链接、权限非 600 时 chmod 自愈；写入按 promise 链串行化。
- `lastSeenAt` 触碰（renew/probe 整表落盘；已鉴权请求 5 秒去抖落盘）。

**启用条件（不允许裸奔）**：创建鉴权器时要求 `admin secret 文件存在` **或** `devices.json 存在`；
两者皆无 → 构造时抛错、服务启动失败。不存在"关掉鉴权"的配置。

## 协议

| TTL                     | 值                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| 配对码                  | 10 分钟、单次、只存摘要、全局单窗口（新码作废旧码）                                      |
| 设备凭据（deviceToken） | 90 天，过期必须重新配对                                                                       |
| 会话（sessionToken）    | `min(now+12h, deviceExpiresAt)`；**renew 轮换**：旧会话立即作废；滑动窗口顺延设备 expiresAt |
| 限流                    | redeem/renew/probe 独立（见存储表）                                                           |

所有时间字段为 **epoch 毫秒数**。全部新端点 body 上限 16KiB，超限 413。

### 错误码（body 统一 `{error:"<code>"}`，错误码用固定字面量）

| 场景                                   | 状态 | error                                                                                                                             |
| -------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 配对码无效/过期/复用（不区分，防枚举） | 403  | `authentication_failed`                                                                                                           |
| 未知/已撤销 deviceToken（renew/probe） | 401  | `authentication_failed`                                                                                                           |
| 会话缺失/过期/设备已撤销（保护面）     | 401  | `authentication_failed`（无/过期会话或会话到期）/ `device_revoked`（设备被撤销）/ `device_expired`（设备凭据过期）——壳靠它区分 UI |
| CSRF 头缺失/不匹配（保护面 POST/PUT/PATCH/DELETE） | 403 | `forbidden`                                                                                                                       |
| 管理端点双闸未过                       | 403  | `forbidden`                                                                                                                       |
| 限流                                   | 429  | `rate_limited`                                                                                                                    |
| body 超 16KiB                          | 413  | `payload_too_large`                                                                                                               |

### 管理端点（双闸：必须同时满足「本机直连」+「x-zcode-admin = secret」，缺一 403）

| 方法/路径                        | body      | 响应                                                                            |
| -------------------------------- | --------- | ------------------------------------------------------------------------------- |
| `POST /api/admin/pairing-code`   | `{label}` | `{code, expiresAt}`（明文码只回显一次；发新码作废旧码）                         |
| `GET /api/admin/devices`         | ——        | `{devices:[{id,label,createdAt,expiresAt,lastSeenAt}]}`（**不含 tokenDigest**） |
| `POST /api/admin/devices/revoke` | `{id}`    | `{ok:true,id}`；未知 id → 404。**先落盘，再杀会话/WS**                   |

**本机判定**（`isAdminSourceLocal`）：socket `remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`
（真实请求必有 socket）；socket 为回环但 `x-real-ip` 声明外部来源（nginx 转发）→ 拒；
无 socket（仅测试 `app.request` 通道）时只信 `x-real-ip` 声明的回环；两者皆缺 → 拒（fail closed）。
**nginx 仍必须显式拒绝 `/api/admin/`**（不变量5 纵深防御，由 deploy 侧落实）。

secret 比较在**摘要层**做常量时间比较；secret 文件读失败视为无 secret → 403。

### 客户端端点（公开，无需凭据；响应键集为 ZCode 版）

| 方法/路径                  | body             | 响应                                                                                                                                                                              |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pairing/redeem` | `{code, label?}` | `{instanceId, deviceId, deviceToken, deviceExpiresAt, sessionToken, csrfToken, sessionExpiresAt, sessionCookieName, csrfCookieName}` + 会话 Cookie（deviceToken 仅此一次回显，spec 有意选择，配对页已带 CSP；响应体显式告知 Cookie 名——手机壳原生 redeem 后照名字注入 WebView，Set-Cookie 到不了 WebView 的 Cookie 罐） |
| `POST /api/auth/renew`     | `{deviceToken}`  | `{instanceId, deviceId, sessionToken, csrfToken, sessionExpiresAt}` + 新会话 Cookie（轮换；lastSeenAt 更新并整表落盘；**滑动窗口顺延 expiresAt**）；未知/过期 → 401。凭据来源：body.deviceToken 优先，缺省回退续期 Cookie `zcode_device_renew`（方案 A）                      |
| `POST /api/auth/probe`     | `{deviceToken}`  | `{instanceId, deviceId, deviceExpiresAt}`（**无 reachable 字段，200 即可达**；更新 lastSeenAt 但不开会话）；未知/已撤销 → 401                                                |
| `GET /api/pairing/page`    | ——               | 配对页 HTML（页面 fetch 调 `/api/pairing/redeem`；文案由 deploy 侧修订）                                                                                                          |

### 会话承载与 CSRF（Cookie 四件套）

成功配对/续期同时下发：

- `zcode_device_session=<sessionToken>; Path=/; Secure; SameSite=Strict; Max-Age=<会话剩余秒>; HttpOnly`
- `__Host-zcode_device_session=<sessionToken>; …同上; HttpOnly`
- `zcode_device_csrf=<csrfToken>; Path=/; Secure; SameSite=Strict; Max-Age=<…>`（**非 HttpOnly**，供页面 JS 读取）
- `__Host-zcode_device_csrf=<csrfToken>; …同上`

会话读取优先普通名、其次 `__Host-` 变体（壳注入 `__Host-` 变体）。

**续期 Cookie（方案 A，仅浏览器流）**：redeem 时额外下发
`zcode_device_renew=<deviceToken>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<设备剩余秒>`。
浏览器日常凭它静默调 `/api/auth/renew` 换新会话（90 天不用重配）；它**只能**调 renew，
不能当会话访问业务面。泄露等级与手机壳 Keystore 凭据同级：每设备、可单独撤销、立即失效。
`renew` 凭据来源优先 body.deviceToken（手机壳），缺省回退该 Cookie（浏览器）；
设备撤销/过期时 renew 失败并顺带清掉该 Cookie。

- **保护面**：`/api/*` 与 `/ws*`。会话缺失/过期/设备已撤销/设备已过期 → 401（并下发过期 Cookie 清理）。
- **CSRF 强制（已生效，取代"只下发暂不强制"）**：保护面内所有**带 Cookie 会话**的
  状态变更请求（POST/PUT/PATCH/DELETE）必须带 `x-zcode-csrf` 头，值与该会话的 csrfToken 一致
  （比较为**摘要层**常量时间匹配）；缺失/不匹配 → 403 `forbidden`，handler 不执行（无副作用）。
  GET/HEAD/OPTIONS 不校验（下载/预览/轮询的导航型请求不带自定义头；WS 升级是 GET 语义，
  其 CSRF 防线由 WS Origin 白名单承担，见下节）。前端义务：页面 JS 读非 HttpOnly 的
  `zcode_device_csrf` cookie → 写 `x-zcode-csrf` 头（`DeviceManagerPage.tsx`、
  `workspaceFileTransfer.ts` 已实现）。
  **豁免面（不进保护中间件，逐条理由）**：
  - `/api/pairing/redeem`、`/api/auth/renew`、`/api/auth/probe`——公开自救通道，凭据
    （deviceToken）在 body；调用方（APK 原生 HttpURLConnection、relay 本地会话）无 Cookie、
    无会话，双提交无从谈起；CSRF 防护由"凭据不自动携带"承担。
  - `/api/pairing/page`（GET 页面）、`/api/admin/*`（管理双闸，不认会话）、
    `/api/bots/*`（外部机器人平台 webhook 回调，业务鉴权 `x-zcode-bot-secret`，
    调用方永不持有设备会话）、`/ws/host`（capability 票鉴权，与设备会话正交）。
  **应急回退开关**：env `ZCODE_CSRF_ENFORCE=0`（或 `false`/`off`）→ 回到"只下发不强制"
  旧语义（改 systemd 环境后重启生效；正常部署不需要，关着它就是留着 CSRF 未强制的洞）。
  `/api/me` 通道的 CSRF 强制**不受**该开关影响（它独立强制）。
- **WS 升级 Origin 白名单（CSWSH 主防线）**：`/ws`、`/ws/host`、
  `/ws/remote/:id` 升级前校验 `Origin`（缺失时回退 `Referer` 的 origin 部分）；判定不过
  → 403 `origin_not_allowed` 拒绝升级并记日志。**默认判定是「同源」**（不硬编码站点域名，
  任何自部署无需改源码）：Origin 的 host:port 必须与本次请求视角的 Host 一致——存在
  `X-Forwarded-Host`/`X-Forwarded-Proto`（nginx 反代）时以它们为准，缺省回退 `Host` 头；
  80/443 默认端口归一后比较。显式例外只留**本机调试入口**（Origin host 为
  localhost/127.0.0.1/[::1] 且端口属 {5173, 3030}）。跨域部署用 env
  `ZCODE_WS_ALLOWED_ORIGINS`（逗号分隔 origin）追加。**缺失 Origin/Referer 放行**：
  浏览器（CSWSH 的唯一威胁载体）握手恒带 Origin 且页面 JS 不可伪造，"带 Origin 但不过
  判定"才是攻击形态；缺失 = 非浏览器客户端（CLI/本机工具/测试台），其 Cookie 获取与
  Origin 无关，会话校验（逐请求重查注册表）+ SameSite=Strict 仍是闸门——拒绝缺失只会
  误杀本机/CLI 合法客户端，不构成新的绕过口。Origin 头存在但非法（不能 URL 解析）→ 拒。
  已登记的宽松面：scheme 降级（Origin http vs 请求 https）在默认端口归一下 authority
  相同会判同源——浏览器 Origin scheme 恒等于页面 scheme，该形态只在构造请求中出现，
  且 Cookie 有 SameSite=Strict + 会话校验兜底。
- `/api/server-info` 在保护面内（登录后可达），`authRequired` 恒为 true。
- **WS 撤销**：`/ws`、`/ws/host`、`/ws/remote/:id` 升级成功后把 socket 注册进
  `sha256(sessionToken) → socket` 注册表；撤销设备时服务端逐个 `close()`（不变量4，close code 4401）。
- 会话校验逐请求重查设备注册表——撤销/过期即时生效的机制保证。
  实现说明：撤销时**保留**该设备的内存会话记录（设备已从注册表删除，记录恒判
  `device_revoked`，由自身 expiresAt 自然清理），不物理删除——否则首查之后
  错误码退化为 `authentication_failed`，错误码的可区分语义失效。访问拒绝语义不变。

## 旧模式删除清单（本仓库服务端）

`hasValidLiteToken`、`zcodeLiteTokenCookieName`、`?token=` Cookie 下发、Cookie 值=服务端 token、
`ZCODE_PAIRING` 开关、`/api/pairing/code`、`/api/pairing/pair`、`/api/pairing/status`、
内存观测设备表（(IP,UA) 指纹）、`--token`/`ZCODE_SERVER_TOKEN`/`ZCODE_SERVER_AUTH_TOKEN`
作为客户端凭据的一切用法。entry-http 不再读 `ZCODE_SERVER_AUTH_TOKEN`。

## 模块划分

- **`src/deviceCredentialAuth.ts`**（新建，全部逻辑）：`createDeviceCredentialAuth(options)`，
  options = `{ dataBaseDir, adminSecretPath?, now? }`（`now` 供测试注入时钟；
  adminSecretPath 缺省读 env `ZCODE_ADMIN_SECRET_FILE`，再缺省 `/etc/zcode/zcode-admin.secret`）。
  返回 `{ routes, middleware, wsGuard: {assertValid, registerSocket}, sessionTokenFromContext, isAuthenticatedRequest }`：
  - `routes`：上述公开 + 管理端点（自带鉴权语义），必须在保护中间件**之前**挂载；
  - `middleware`：会话 Cookie + CSRF 保护面（覆盖 `/api/*` 与 `/ws*`，含 WS 升级前置 401）；
  - `wsGuard.registerSocket(sessionToken, socket)`：WS 注册表，返回解绑函数；
    socket 需支持 `on("close", …)` 与 `close()`（`ws` 库 WebSocket 天然满足）。
- **`src/http.ts`**（只做接线）：创建鉴权器 → `app.route("/", auth.routes)` →
  `app.use("*", auth.middleware)` → 三个 WS 工厂里捕获 sessionToken 并在 onOpen 注册 socket →
  SPA 入口未登录 302 `/api/pairing/page`（用 `isAuthenticatedRequest` 判定）。
- **`test/deviceCredentialAuth.test.ts`**：node:test，从 `packages/server` 目录
  `../../node_modules/.bin/tsx --test test/deviceCredentialAuth.test.ts` 运行。

## 部署顺序（不可颠倒）

1. 服务端落地本 spec 并删除旧模式；**root 先创建管理密钥文件（600）**，否则服务拒启。
2. 用 root 在本机调 `POST /api/admin/pairing-code` 创建第一条配对码。
3. 手机/浏览器用该码配对；所有旧 Cookie 与旧 token 一律 401（无过渡期）。
4. 手机壳升级到需求规格 §8 的实现（解析器按键集 + 43 字符 token 形态适配）。
   > 第 1→4 步之间手机连不上（一次性窗口），这是"直接切掉"的既定代价。

## 验收场景（对应 test/deviceCredentialAuth.test.ts）

- 旧 token 任何形式（URL `?token=` / Cookie `zcode_lite_token` / 头 `x-zcode-lite-token`）→ 401。
- 配对码过期 → 403；同码二次使用 → 403；未知 deviceToken renew/probe → 401。
- 设备 A/B 独立：撤销 A 后 B 的会话仍 200；A 的凭据 renew → 401。
- 撤销即时：A 新请求 401；A 的活跃 WS（注册表内 mock）被 `close()`。
- `devices.json` 序列化后不含明文 deviceToken（只有 tokenDigest），文件权限 600。
- 管理端点双闸各测一遍：本机 + 正确 secret → 200；缺密钥 / 错密钥 / 非本机 / secret 缺失 → 403。
- 会话 Cookie 值 ≠ deviceToken（结构性断言）；撤销设备后该 sessionToken 全部失效。
- **补充**：会话寿命封顶——renew 后 `sessionExpiresAt ≤ deviceExpiresAt`。

（手机壳行为见需求规格 §8，由 `mobile/android` 落地，不在服务端测试范围。）

## 跨团队待办（服务端不改，需对应队友落实）

- ~~**web/ui**：页面 JS 需读 `zcode_device_csrf` cookie 并在所有 POST 请求加 `x-zcode-csrf` 头~~
  （**已收口**：现有 POST 调用面均已带该头或落在豁免面——`DeviceManagerPage.tsx`
  与 `workspaceFileTransfer.ts` 已实现读 cookie 写头；`/api/auth/renew` 在公开豁免面；
  WS 升级是 GET 语义走 Origin 白名单。服务端 CSRF 已强制，新增 POST 端点时必须带该头）。
- **deploy/nginx**：显式拒绝 `/api/admin/`（443 不得打到本机管理端点）；转发需带 `x-real-ip`；
  创建 `/etc/zcode/zcode-admin.secret`（600）并通过 `ZCODE_ADMIN_SECRET_FILE` 告知路径（如非默认）。
- **部署引导（mobile handoff runner）**：仍向服务端传 `--token`/`ZCODE_SERVER_AUTH_TOKEN`，
  服务端已忽略；改为保证管理密钥文件存在并以 root 启动。
- **旧 spec 归档**：`packages/server/specs/selfhosted-web-pairing.md` 描述的模型已整体删除，归档/标注方式待定。
- **配对页 CSP**：redeem 响应体含 deviceToken 是 spec 有意选择，配对页 CSP 待补。

## 追加：会话持久化 / 服务端静默自愈 / 临时设备 / /api/me 通道

> 背景：服务重启后所有设备被迫重新配对；页面 6h 定时续期覆盖不了所有客户端
> （官方远控页不跑本项目的页面 JS）；无法在网页上管理设备。约定：**续期是服务端的职责，客户端无需配合**。

### 会话持久化 sessions.json

- 路径 `<dataBaseDir>/.zcode/sessions.json`，与 devices.json 同目录、同一套原子写
  （tmp wx+0600 → 末尾换行 → rename；写前 lstat 拒符号链接；1MiB 上限；同一 writeChain 串行）。
- 结构 `{ "version": 1, "sessions": [{ "key": "<sha256(sessionToken) hex>", "deviceId": "<32hex>",
  "csrfDigest": "<sha256 hex>", "expiresAt": <ms> }] }`。**磁盘上绝不出现明文 token**（不变量1 延伸）。
- 落盘时机：createSession / 会话淘汰/ 撤销设备（三步序第二步）/ 周期清理（有删除才写）。
- 启动加载：文件缺失 = 空表（不报错）；结构非法抛错拒启（fail-closed，与 devices.json 一致）；
  单条畸形跳过；**已过期会话不恢复**。权限非 600 时 chmod 自愈。
- 每 6h 或创建会话时顺带 prune 过期会话。
- 撤销设备顺序（不可反）：devices.json 落盘删记录 → 内存 + sessions.json 移除该设备全部会话 →
  killDeviceSessions 关 WS。撤销后会话记录物理删除，保护面错误码为 `authentication_failed`
  （`device_revoked` 只在"崩溃残留：恢复的会话指向已消失设备"时出现）。
- `createDeviceCredentialAuth` 返回值新增 `dispose()`：停周期任务并等待写链排空（测试/优雅关闭用）。

### 服务端静默自愈（trySilentRenew）

- 会话失效（缺失/过期）但请求带续期 Cookie `zcode_device_renew` 且设备健在 → 服务端隐式
  执行一次 renew 语义（lastSeenAt、滑动顺延、createSession、会话 Cookie 四件套、重发续期
  Cookie），请求放行。正常路径（会话有效）零开销。
- 触发点：① 会话保护 middleware（/api/* 与 /ws*，含 WS 升级——升级工厂从同一 Context 取
  token，自愈换发的新 token 经 WeakMap 对同请求可见，socket 注册的是新凭据）；② SPA 入口页
  判定 `admitOrRenew(c)`（http.ts 静态处理器，替代 isAuthenticatedRequest 的调用点；
  isAuthenticatedRequest 本身保留为纯查询）。101 握手响应带不进 Set-Cookie（ws 库直写握手头），
  客户端下一个普通请求即收到新会话 Cookie。
- 无凭据请求照旧 401，错误码语义不变；设备撤销/过期时自愈拒绝并顺带清续期 Cookie。
- 自愈不调 renewLimiter.hit（它是请求自身的隐式续期，不占显式 renew 的限流配额）。

### 临时设备（temporary）

- `DeviceRecord.temporary: boolean`；devices.json 老记录缺省 false；写入总带字段。
- `/api/admin/pairing-code` 与 `/api/me/pairing-code` 接受 `ttlHours`：正整数 1..168；提供即
  临时码（响应带 `temporary:true, ttlHours`），redeem 出的设备 temporary=true 且
  `expiresAt = now + ttlHours*3600_000`（忽略 90 天滑动窗口）。
- 临时设备 renew：只更新 lastSeenAt + 换发会话，**不顺延 expiresAt、不重发续期 Cookie**；
  redeem 时仍种续期 Cookie（Max-Age = 剩余寿命），短命期内自愈可用。
- 临时设备访问 `/api/me/*` 一律 403 `forbidden`（fail-closed）。
- GET /api/admin/devices 与 GET /api/me/devices 的条目均带 `temporary`。

### /api/me/* 设备自助管理通道（meRoutes）

- 第二个 Hono 实例，http.ts 在 `app.use("*", middleware)` **之后** `app.route("/", meRoutes)`；
  中间件限定 `/api/me/*`（不误伤 bots webhook 等同 app 路由）。
- 路由：`GET /api/me/devices`；`POST /api/me/devices/revoke {id}`（撤销"当前自己"允许）；
  `POST /api/me/devices/rename {id,label}`；`POST /api/me/pairing-code {label,ttlHours?}`。
- 自身校验：会话必须有效；设备 temporary → 403；POST 必须带 `x-zcode-csrf` 且与会话
  csrfDigest 摘要层常量时间匹配（GET 不要求）。CSRF 对 /api/me **强制**——新通道只影响
  本管理页；middleware 对既有保护面的「暂不强制」保持不变。

### 记录与 socket 的生命周期对齐

| 事件 | 记录（sessions Map / sessions.json） | socket（wsRegistry） |
| ---- | ---- | ---- |
| 撤销设备 | devices.json 落盘 → removeSessionsForDevice（内存+磁盘） | killDeviceSessions 全部 close(4401)（最后一步） |
| 会话过期（prune，6h 周期或 createSession 触发） | 删除记录，有删除才落盘 | closeSocketsForKey 同步 close(4401, "session expired") |
| 会话淘汰（每设备 16 条上限） | 删除最旧记录并落盘 | closeSocketsForKey 同步 close(4401) |
| 活 WS 兜底（http.ts ping 循环，30s） | —— | 每 ping 周期 `wsGuard.assertValid`（= resolveSession 全链：会话过期/设备撤销/设备含临时设备到期）失败即 close(4401) |

### 新增验收（test/deviceCredentialAuth.test.ts）

- **T-restart** 重启恢复：同 dataDir 重建实例后旧 sessionToken 仍 200；过期会话不恢复；
  撤销后 sessions.json 无残留。
- **T-heal** 自愈：会话不存在 + 续期 Cookie → 200 + Set-Cookie 新会话，老会话共存。
- **T-heal-negative** 无凭据/无效凭据/被撤销设备 → 照旧 401，续期 Cookie 被清。
- **T-disk-no-plaintext** sessions.json 无明文 token、key/csrfDigest 均 64 hex、权限 600。
- **WS 对齐**：过期会话 socket 被 close(4401, "session expired")；撤销关全部。
- **临时设备矩阵**：非法 ttlHours 400；redeem → temporary=true；renew 不顺延不重发续期
  Cookie；/api/me 403；probe 200；到期 401 device_expired。
- **/api/me 矩阵**：无会话 401；GET ok；POST 无/错 CSRF 403；revoke/rename/pairing-code 生效；
  撤销自己后立即 401。
- **限流隔离**：连续自愈不消耗 renewLimiter 配额，显式 renew 不被挤占。

## 追加：CSRF 强制 + WS Origin 白名单

> 背景：CSRF"只下发不强制"是唯一一处业界 MUST、本部署明确
> 搁置的项；WS 握手无 Origin 校验（OWASP 把 Origin 白名单列为 CSWSH 主防线，现有实现只有
> SameSite=Strict 单层）。本次收口，前置依据是调用面穷举（无既有客户端会被 403 锁死）。

### CSRF 强制语义

- `middleware` 对保护面（/api/* 与 /ws*，会话有效路径）的 POST/PUT/PATCH/DELETE 强制
  `x-zcode-csrf` 双提交校验（摘要层常量时间）；失败 403 `forbidden`，handler 不执行。
  **校验位置在自愈分支之前**：`trySilentRenew` 静默换发只服务
  GET 语义（页面轮询/SPA 入口页）；"会话失效 + 续期 Cookie"的 mutating 请求一律 403，
  状态变更走显式 renew（公开豁免面，凭据在 body）——自愈分支不再可能放行有副作用的请求。
- GET/HEAD/OPTIONS 豁免；豁免路径同上（公开自救通道凭 body 凭据、bots webhook 凭
  bot-secret、admin 双闸、/ws/host capability 票）。**bots webhook 豁免的边界**（实现在 botsService.processProviderCallback）：显式 botId 查无
  此 bot → 404；webhook bot 未配置 secret → 401（fail-closed，配置 secret 前端点不可用）；
  已配置 secret 的路径不变（逐条常量比较，业务鉴权原语义）。
- **回退开关**：`ZCODE_CSRF_ENFORCE=0`（或 `false`/`off`）→ 恢复"只下发不强制"。
  测试注入用 `DeviceCredentialAuthOptions.csrfEnforce`（缺省读 env，env 缺省 = 强制）。
- 前端不感知：`DeviceManagerPage.tsx`（/api/me 管理页）与 `workspaceFileTransfer.ts`
  （workspaces/register）早已带头；其余 POST 均在豁免面（穷举见部署说明）。

### WS Origin 白名单

- 模块级纯函数 `isWsOriginAllowed(req, origin?, referer?)` 导出（单测直测）+ 实例方法
  `auth.isWsOriginAllowed(c)`（http.ts 三处升级用）。
- **默认判定是「同源」**（不硬编码站点域名）：Origin 的 host:port 与请求视角 Host 一致
  （80/443 默认端口归一）。请求视角的 host/scheme **只在显式开启 `ZCODE_TRUST_PROXY=1`
  时才读 `X-Forwarded-Host`/`X-Forwarded-Proto`**（这两个头默认
  被 nginx 原样透传、客户端可伪造——默认不信，即使反代侧漏配也不会被伪造头绕过；
  开启前提是部署方确认反代已 `proxy_set_header` 显式覆盖，步骤见部署说明）。
- 显式例外：本机调试入口（Origin host ∈ localhost/127.0.0.1/[::1] 且端口 ∈ {5173,3030}）；
  跨域部署用 `ZCODE_WS_ALLOWED_ORIGINS`（逗号分隔）追加。
- http.ts 接线：`app.use("/ws", …)` / `app.use("/ws/host", …)`（capability 闸之后）/
  `app.use("/ws/remote/:id", …)`——独立中间件在升级工厂之前注册，响应即短路；
  拒绝时 403 `{error:"origin_not_allowed"}` 并记日志。附带把"普通 GET /ws"从 404
  改为 426 `expected_websocket_upgrade`（升级工厂对非 upgrade 请求调 next() 后的落点）。
- **已知信任假设（不改行为）**：`POST /api/me/workspaces/register` 允许已配对
  设备把任意**真实存在**的目录注册进 download/preview 的根集合（上限 64、注册即
  realpath 归一）。即：**已配对设备本就等价于"可读其所在账号全部 workspace"这一档**，
  该端点不扩大到全盘只读——注册仍不绕过"目录必须真实存在"与文件级校验链。若未来
  需要压缩到"仅启动时宣告的根"，应改为服务端白名单收口（当前单人自部署按已配对
  设备 = 受信设备处理）。

### 新增验收（test/deviceCredentialAuth.test.ts + services test/botsWebhookCallbackAuth.test.ts）

- **CSRF 矩阵**：保护面 POST 无头 403 / 错头 403 / 正确头 200；GET 无头 200；
  公开面（redeem/renew/probe）无头 200；bots webhook 无头 200；`csrfEnforce:false`
  注入后无头 POST 照旧 200（回退开关生效）。
- **自愈被 CSRF 覆盖**：会话失效 + 续期 Cookie 的 POST（无 CSRF 头）→ 403
  `forbidden`（不再静默换发放行）；同条件的 GET 仍 200（自愈语义保留）。
- **Origin 判定矩阵**：同源 origin 通过（含默认端口归一与显式端口）；跨域 origin 拒绝
  （含后缀钓鱼、同 host 异端口）；非法 origin 拒绝；缺失 Origin/Referer 放行；
  **反代头两种模式**：默认（ZCODE_TRUST_PROXY 未设）伪造 `X-Forwarded-Host` 无效、
  判定退回 Host 头；`ZCODE_TRUST_PROXY=1` 时转发头优先（多值取第一、不认 Host 旧值、
  伪造头变有效 = 部署责任面已声明）；回环例外（localhost/127.0.0.1 限 {5173,3030} 端口，
  其余回环端口拒绝）；仅 Referer 命中/不命中各自 true/false；env 追加白名单生效。
- **webhook 收口（services 测试）**：webhook bot 未配置 secret → 401；显式 botId
  查无此 bot → 404；已配置 secret 且错误 secret → 原语义 webhookSecretInvalid 回复
  （不执行业务）。

## 追加节：/api/me 扩展端点（APK 前台服务与文件取回）

> 三个新端点都挂在 meRoutes（会话鉴权内建、GET 豁免 CSRF、POST 强制 CSRF），数据源由
> http.ts 装配层经 `DeviceCredentialAuthOptions` 注入。APK 壳侧消费按本节形状对接。

### GET /api/me/pending-summary

APK 前台服务在 WebView 冻结时感知"有没有任务完成/待处理"的轻量轮询端点。

| 状态 | 响应体 | 语义 |
| ---- | ------ | ---- |
| 200 | `{ pendingInteractions: number, runningTasks: number, completedUnread: number }` | 三类计数，均非负整数 |
| 401 | `{ error: "authentication_failed" \| ... }` | 无/失效会话（中间件统一语义） |
| 500 | `{ error: "summary_failed" }` | 数据源运行时抛错（fail loud，不喂假零） |
| 503 | `{ error: "summary_unavailable" }` | 部署未装配数据源（`pendingSummarySource` 未注入） |

计数语义：

- `pendingInteractions` = 该 workspace 挂起的反向交互总数（权限确认 + 用户输入，来自
  `IZCodeAgentService.countPendingInteractions` 内存事实，不启动 runtime）；
- `runningTasks` = tasks-index sqlite 中 `status=running` 的任务数（`IZCodeTaskService.listTasks`）；
- `completedUnread` = `status=completed` 且 `unreadAt != null` 的任务数（**error 状态不并入**）。

轮询建议：前台服务 15-30s 一次；三个计数全为 0 才可判定"无事发生"。

### GET /api/me/files/download?path=<绝对路径>

agent 产物/报告的手机侧取回。仅单文件；目录列举与通配一律拒绝。

| 状态 | `error` 码 | 语义 |
| ---- | ---------- | ---- |
| 200 | —— | 文件流；`Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>`（RFC 5987，非 ASCII 文件名安全）；`Content-Type: application/octet-stream`；`X-Content-Type-Options: nosniff`；`Content-Length` 为文件字节数 |
| 400 | `invalid_path` | 缺 `path` 参数或非绝对路径 |
| 403 | `forbidden` | realpath 解析后不落任何工作区根内（含 `..` 穿越与 symlink 逃逸——同一响应，不泄露目标存在性） |
| 404 | `not_found` | 目标不存在、非普通文件（目录/设备文件）、realpath 失败 |
| 413 | `too_large` | 文件 > 100MB |
| 429 | `rate_limited` | 30 次 / 10 分钟 / IP |
| 503 | `download_unavailable` | 部署未装配 `workspaceRootsProvider` |

允许的根集合（http.ts 注入）：本部署宣告的 workspace 路径 + 会话后台目录
（`getConversationWorkspaceDir()`）。校验顺序：`resolve` → `realpath`（符号链接在此消解）
→ 根包含判定（`relative` 无 `..` 前缀）。

### GET /api/me/preview/proxy?url=<本机地址>（服务端半边）

agent 起的 dev server / 产出的 HTML 在手机 WebView 的代理通道。SSRF 防线：仅 http/https；
hostname 经 DNS 解析后**每个**结果都必须是回环地址（127.0.0.0/8 / ::1；`localhost` 直接放行）；
重定向不跟随（30x 透传给调用方）；响应体 ≤ 100MB。

| 状态 | `error` 码 | 语义 |
| ---- | ---------- | ---- |
| 200 | —— | 非 HTML：body 原样流式透传，`Content-Type` 透传上游，`Cache-Control: no-store`。HTML（content-length ≤2MB，或无声明且实测 ≤2MB）：读全量注入 `<base href="<scheme>//<host><dir>/">` 后以 `text/html` 返回；上游已带 `<base>` 时不注入（双 base 解析未定义，以页面为准）。HTML >2MB（预判或实测）：**原样透传不注入**——body 只消费一次（预判超限走未读原生流；无 content-length 时读全量后若超限，把已读 buffer 原样返回） |
| 301/302/303/307/308 | `{ error: "upstream_redirect", location }` | 重定向透传（不自动跟随） |
| 400 | `invalid_url` | URL 解析失败或非 http/https |
| 403 | `forbidden_target` | 目标解析到非回环地址 |
| 413 | `too_large` | 上游声明 > 100MB |
| 429 | `rate_limited` | 60 次 / 10 分钟 / IP（页面子资源也走代理，档位高于下载） |
| 502 | `upstream_unreachable` | 连接拒绝/DNS 失败等 |
| 504 | `upstream_timeout` | 上游 15s 未响应 |

前端接入建议：绝对路径资源（`/static/...`）会被 `<base>` 修正为指向上游主机而不是代理
路径——WebView 半边应把页面内 `src`/`href` 声明为相对路径消费，或对这类资源再走一次本
端点（把绝对路径换成 `url` 参数的完整上游 URL）。

### GET /api/me/preview/file/<encodeURIComponent(绝对路径)>

workspace 内文件的内容预览（前端传的是 workspace 文件绝对路径
`row.path`/`target.path`，不是 http URL，`?url=` 端点接不了）。与
`/api/me/files/download` 共用同一条校验链（resolve → realpath → workspaceRootsProvider
包含判定；穿越/symlink 逃逸 403/404 不区分存在性），区别只在响应处置：
inline 预览而非 attachment 下载。

**两个预览入口的分工**：`?url=` 走回环代理（agent 起的 dev server，SSRF 五道防线）；
`/file/` 走工作区静态文件（agent 产出的 HTML 报告/页面，无 SSRF 面——路径在校验链内闭环）。

**路径段而非 query 的原因（关键设计）**：HTML 预览注入的 `<base href>` 指向「所在目录的
路径段形式端点」——query 形式在浏览器相对解析时丢 query（`URL("css/x.css",
"https://h/api/me/preview/proxy?path=/dir/")` → `/api/me/preview/css/x.css`，资源回不来）；
路径段形式下相对资源 `css/app.js` 自动解析为
`/api/me/preview/file/<encoded-dir>/css/app.js`，服务端解码该段拼出文件路径再走同一条
校验链，资源闭环。

- `.html`/`.htm` 且 ≤2MB：读全量注入 `<base href="/api/me/preview/file/<encodeURIComponent(所在目录)>/">` 后返回 `text/html`；
- 非 HTML 与 >2MB HTML：按扩展名 Content-Type 白名单原样返回（无需 base；未知扩展名
  `application/octet-stream` + `nosniff`）。

| 状态 | `error` 码 | 语义 |
| ---- | ---------- | ---- |
| 200 | —— | 内容（HTML 注入 base；其余原样） |
| 400 | `invalid_path` | 最后一段解码失败或非绝对路径 |
| 403 | `forbidden` | realpath 后不落任何工作区根内（含穿越） |
| 404 | `not_found` | 不存在/非普通文件/realpath 失败 |
| 413 | `too_large` | > 100MB（与下载同档） |
| 429 | `rate_limited` | 与 preview/proxy 共用 60 次 / 10 分钟 / IP 限流器 |

### GET /api/me/usage-summary

UI /usage 页的手机端轻量聚合。GET（CSRF 豁免）、60 次 / 10 分钟 / IP、鉴权同其他 /api/me。

**数据源（勘察结论）**：`model_usage` / `turn_usage` 表在 Agent（CLI）的会话库
`~/.zcode/cli/db/db.sqlite`（CLI `getDefaultSessionDbPath()`，无环境变量覆盖；本部署
`storage.sessionDbPath` 未配置）。server 进程用 `node:sqlite DatabaseSync({readOnly: true})`
直接打开：该库 WAL 模式，readOnly 连接与 Agent 写者并发安全，且本端点绝不是第二个写方。
不走 RPC（`v4/usage/stats` 要求活跃 workspace client，空闲回收后取不到）。聚合口径对齐
CLI 侧 `queryAppUsage`：token = `computed_total_tokens`，请求数 = `model_usage` 行数。
库打不开/缺表 → 500（fail loud，不喂假零）；部署未装配 → 503。

| 状态 | 响应体 | 语义 |
| ---- | ------ | ---- |
| 200 | `{ todayTokens: number, todayRequests: number, rpm: number, tpm: number, hourly24h: [{ hourISO: string, tokens: number }], generatedAt: number }` | `hourly24h` 固定 24 桶（含当前小时向前 24 桶，无数据补零）；`hourISO` 为带本地时区偏移的 ISO 8601（如 `2026-01-01T00:00:00+08:00`），前端 `new Date(hourISO)` 直接本地渲染，桶锚定本地整点；today 聚合锚定服务器本地时区今日 00:00；rpm/tpm 为最近 60 分钟滑动窗口（请求数/token 数）；`generatedAt` 为服务端 epoch ms |
| 401 | 中间件统一语义 | 无/失效会话 |
| 429 | `{ error: "rate_limited" }` | 60 次 / 10 分钟 / IP |
| 500 | `{ error: "usage_failed" }` | 数据源抛错（库缺失/损坏） |
| 503 | `{ error: "usage_unavailable" }` | 部署未装配数据源 |

### 限流器 key 表有界化

`makeRateLimiter`（redeem/renew/probe/download/preview 共用工厂）的 attempts Map 加上限
4096 key：满时**拒绝新 key**（fail-closed，对齐 dsh-mobile `BoundedRateLimiter`；已有 key
计数不受影响）。`hit()` 满时先做一轮过期清扫，仍满则丢弃本次计数（调用序 `limited()` 已
先返回 true，攻击流量进不到这里）。`limited()` 每 64 次调用顺带做一次全表过期清扫，避免
"来过一次就消失"的 IP 长期占位。误伤边界：4096 个不同源 IP 在同一窗口内真实竞争时第
4097 个新 IP 被拒——单人自部署正常流量远达不到，宁 fail-closed 不给攻击者无界内存。

### 新增验收（test/meExtendedEndpoints.test.ts）

- **pending-summary 矩阵**：无会话 401；数据源未装配 503；正式设备 200 形状逐字段核对；
  数据源抛错 500（不降级为零值）；GET 豁免 CSRF。
- **files/download 矩阵**：无会话 401；缺参/相对路径 400；工作区内文件 200 且
  Content-Disposition 为 attachment + filename*；工作区外 403；不存在 404；`..` 穿越、
  编码穿越（%2e%2e）、symlink 逃逸全部拒绝；目录 404；根集合未装配 503。
- **preview/proxy 矩阵**：非回环 IP/域名 403；非法 URL 与非 http(s) 400；真实回环上游
  200 透传；HTML 注入 `<base>`；上游不可达 502；开关关闭 503；61 次内必现 429。
- **preview/file 矩阵**：HTML 注入所在目录的路径段 `<base>`；相对资源
  （css/js 及嵌套子目录）经路径段端点回环命中；非 HTML 按扩展名 MIME 原样返回；中文/空格
  路径编码往返命中；越界 403；穿越到真实越界文件 403（不存在则 404，realpath 先行）；
  无会话 401；不存在 404。
- **usage-summary 矩阵**：无会话 401；未装配 503；200 形状 deepEqual（24 桶、
  补零、hourISO 带时区偏移且锚定整点）；数据源抛错 500；61 次内必现 429。
- **限流器有界**：4096 个不同 IP 后表封顶、新 key 不占位、老 key 计数不受影响、过期
  清扫后新 key 可重新接纳；limited-only 洪水下表满后 `limited()` 不再 set 新 key、
  无历史 key 判定照旧放行、空数组 key 被 sweep 消化（峰值 ≤ sweep 周期）。
- **preview/proxy >2MB HTML**：3MB 上游 200 完整透传且不注入 base（body 单次消费）。
- **preview/proxy 上游自带 base**：不叠加第二个 `<base>`。
- workspace 根本身为 symlink 时，realpath 下的合法文件可下载；越界拒绝不放松。
- **services 测试**：resolved 事件提取的登记 key 与 permissionRequestKey 同源
  （roundtrip 删除）；缺 requestId 保守返回 null 不动表。
