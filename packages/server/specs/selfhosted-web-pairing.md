# 自托管 Web 配对登录（Pairing Login）

## 背景与问题

ZCode 自托管 Web 在 `--token` 模式下只有一种进入方式：把 token 放进 URL
（`/?token=<64hex>`）。由此产生两个问题：

1. **凭证长期暴露在 URL 中**——浏览器历史、同步、截图、误分享都会扩散这把
   永不过期的服务端唯一凭证。
2. token 换来的 Cookie 是**会话级**（无 Max-Age），浏览器一关就丢，用户只能
   反复使用带 token 的长链接，形成路径依赖。

目标：日常入口收敛为「无 token 的站点根 URL + 长期安全 Cookie」，
一次性配对码换 90 天登录；**同时让 URL 携带 token 的直连方式可关闭**
（这是引入配对的意义所在：若 token 直连仍然放行，配对只是形式）。

## 产品规则

- **凭证通道（优先级从高到低）**：
  1. `ZCODE_PAIRING=1` 时：仅接受 Cookie（`zcode_lite_token`）与配对码换取流程；
     URL `?token=` 对 `/api/*`、`/ws` 一律 401（静态资源不受影响）。
  2. `ZCODE_PAIRING=0` 或未设置：保持原生行为（`?token=` 或 Cookie 均可），
     已有部署升级零风险。
- **配对码**：服务端生成，仅存 SHA-256 摘要于内存；10 分钟有效、单次使用、
  常量时间比较。生成接口 `/api/pairing/code` 仅持 token 者可调（即管理员/
  AI 代理通道），响应明文码只出现一次，不落日志。
- **配对成功**：种 90 天 Cookie（`HttpOnly; Secure; SameSite=Lax`）并 303 回 `/`。
  已持有有效 Cookie 的浏览器访问配对页时仍展示表单（允许升级临时会话），
  不做 302 弹回（历史教训：弹回会让持有旧会话 Cookie 的用户永远无法配对）。
- **设备可观测性**：按 (IP, User-Agent) 指纹记录 firstSeen/lastSeen/hits，
  仅供持 token 的 `/api/pairing/status` 查询；单 token 架构下这是近似识别，
  语义是「哪些浏览器环境在用」，不是精确设备身份。
- **限速**：配对提交每 IP 每窗口 10 次，超限 429（纵深防御；72-bit 随机码
  本身不可爆破）。
- **降级**：`ZCODE_PAIRING=1` 但未配对且无 Cookie 时，`/api/*` 与 `/ws` 返回
  401，与 token 模式原生行为一致；配对页本身永远可访问（它是自救通道）。

## 接口

| 方法/路径 | 鉴权 | 行为 |
|---|---|---|
| `GET /api/pairing/page` | 无 | 配对页 HTML（无依赖单页） |
| `POST /api/pairing/pair` | 配对码 | 校验通过 → Set-Cookie(90d) + 303 `/`；失败 403 |
| `POST /api/pairing/code` | token | 生成一次性码，返回明文一次 |
| `GET /api/pairing/status` | token | 设备清单 + 活跃配对码数 |

## 验收场景

1. `ZCODE_PAIRING=1`：旧链接 `/?token=X` → 页面可开但 `/api/server-info` 401，
   `/ws` 升级 401 → 直连被拦。
2. `ZCODE_PAIRING=1`：输码 → Cookie 种下 → `/api/server-info` 200、`/ws` 正常。
2b. `ZCODE_PAIRING=1`：未持 Cookie 的浏览器打开 `/`（或任意 SPA 路由，即解析落到
    index.html 的导航）→ 302 `/api/pairing/page`——用户被引导到登录页，而不是
    卡在「连接断开」的报错界面（要求：被拦时应跳登录页）。静态
    资源（bundle/sw.js/图标）与 API/WS 的 401 语义不变。
3. 配对码 10 分钟后过期；同码第二次提交 403。
4. `ZCODE_PAIRING` 未设置：一切行为与原生 token 模式逐字节一致（回归保护）。
5. 远控链路（relay 下发 `/ws?token=`）：`ZCODE_PAIRING=1` 时同样被拦——
   relay 场景应保持 `ZCODE_PAIRING` 关闭，或由 relay 改发 Cookie（超出本 spec）。

## 状态所有者

- 配对码与设备表：`packages/server/src/http.ts` 内模块级内存态
  （重启即清，配对码本就 10 分钟寿命；设备表为观测数据，可接受）。
- Cookie 值仍为服务端 `--token` 本体（ZCode 单 token 架构上限，
  单设备吊销需改协议，超出本 spec）。
