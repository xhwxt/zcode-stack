# 直连页连接恢复 E2E 脚本

Playwright 驱动的真浏览器验证脚本，对应补丁功能清单中的「连接守卫」与
「心跳存活 + 热换底软重连」两项。这些脚本曾用于真机问题复现与修复回归，
现随补丁仓库发布，供部署者验证自己的环境。

## 用法

```bash
# 依赖：node >= 22，playwright-core，本机 Chromium（或用 CHROME_PATH 指定）
npm i playwright-core
export ZCODE_TOKEN=<你的服务端 token>
export ZCODE_ORIGIN=http://127.0.0.1:3030   # 默认值，可省
export CHROME_PATH=/path/to/chrome          # 可省，让 playwright 自行解析

node halfopen-verify.mjs blackhole   # 半开判死：应出现第 2 条 WS 且无整页 reload
node halfopen-verify.mjs healthy     # 健康连接：50s 内零重连零误判
node inplace-verify.mjs              # 原地恢复：重连后 React 树不重挂（DOM 节点身份保持）
node feel-verify.mjs                 # 体感验证：断网→恢复全程无刷新、消息流自动续上
node drop-test.mjs                   # 真断线（close 事件）恢复
node order-test.mjs                  # SW 缓存时序：注入脚本不被 cache-first 锁死
```

## 语义约定

- 「无整页 reload」是硬判定：脚本在 window 上打标记，reload 后标记消失即失败。
- 黑洞模式通过 `page.routeWebSocket` 掐断双向转发但不发 close，模拟移动网络下的半开。
