#!/usr/bin/env bash
# zcode-deploy-20261011.sh — ZCode 部署脚本
# 内容：备份 → 部署 web+server → relay 本地凭据生成 → 旧 token 清理 → 重启 → 健康检查 → 失败自动回滚
# 运行身份：root。不要在 zcode-web 服务内部执行（restart 会中断当前会话）。
set -euo pipefail
umask 077

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="<备份目录>/opt-zcode-deploy-$STAMP"
SRC="<工作区>/ZCode/dist/payload"   # 构建产物暂存处
LOG="<备份目录>/opt-zcode-deploy-$STAMP.log"
RELAY_ENV="<配置目录>/zcode-relay.env"
ADMIN_CLI="<工作区>/deploy/admin-cli.sh"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# ── 0. 前置检查 ─────────────────────────────────────────────
[ -d "$SRC/web" ] && [ -d "$SRC/server" ] || { log "❌ 构建产物缺失：$SRC"; exit 1; }
log "✅ 构建产物就绪"

# ── 1. 备份现场（可回滚的完整副本）──────────────────────────
mkdir -p "$BACKUP"
cp -a <部署目录>/web "$BACKUP/web"
cp -a <部署目录>/server "$BACKUP/server"
# relay 去 token 化回滚面：env 文件 + 当前生产 relay-v28 + 旧 token 本体
[ -f "$RELAY_ENV" ] && cp -a "$RELAY_ENV" "$BACKUP/zcode-relay.env.bak"
cp -a <工作区>/relay/relay-v28.mjs "$BACKUP/relay-v28.mjs"
[ -f <数据目录>/.zcode-token ] && cp -a <数据目录>/.zcode-token "$BACKUP/zcode-token.retired"
log "✅ 已备份当前线上 web+server（+relay env/v28/旧 token）到 $BACKUP"

# ── 2a. relay 本地凭据生成（去 token 化；先于 rsync）─────
# 顺序要求：凭据生成是「对 3030 现网的写操作」，失败即整体验止（set -e），此时
# 文件系统仍处于部署前状态（web/server 未动、env 未写、token 未删）——不需要回滚，
# 直接修好 3030/设备名额后重跑本脚本即可（本函数幂等）。
# 若放在 rsync 之后（旧版顺序），凭据失败会让脚本死在"rsync 已覆盖、服务未重启"
# 的中间态，还得手工回拷 web/server。挪前消除该窗口。
# relay-v29 / zusage-sidecar-v2 不再使用旧单 token：
#   - relay 的 collectBootstrap 改凭 "relay 系统设备" 的 deviceToken（env
#     ZCODE_RELAY_LOCAL_SESSION）调 /api/auth/renew 换会话，再带 Cookie 调 /api/server-info；
#   - zusage-sidecar 的快照鉴权改为透传浏览器会话 Cookie 校验（不需要本机凭据）。
# 幂等：RELAY_ENV 里已有 ZCODE_RELAY_LOCAL_SESSION 则跳过（重复执行部署不重发码）。
# 注意：admin-cli.sh code 会作废服务端当前未使用的配对码（单窗口语义）——本段
# 只在无凭据时执行一次，不影响用户配对；label 固定 "relay-system"（/devices 页可见）。
ensure_relay_local_session() {
  if grep -q '^ZCODE_RELAY_LOCAL_SESSION=' "$RELAY_ENV" 2>/dev/null; then
    log "✅ relay 本地凭据已存在（幂等跳过）：$RELAY_ENV"
    return 0
  fi
  [ -x "$ADMIN_CLI" ] || { log "❌ admin-cli 不可用：$ADMIN_CLI"; return 1; }
  log "生成 relay 系统设备配对码…"
  local code_json code
  code_json="$("$ADMIN_CLI" code relay-system)" || { log "❌ 配对码生成失败（admin-cli 退出码 $?）"; return 1; }
  code="$(printf '%s' "$code_json" | sed -n 's/.*"code"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$code" ] || { log "❌ 未能从 admin-cli 输出解析配对码"; return 1; }
  # 用配对码兑换设备凭据：POST /api/pairing/redeem 返回体里的 deviceToken 只回显一次。
  # 配对码经 0600 临时文件传给 curl（--data @file）——密钥类值不进 argv（ps 可见），
  # 对齐 admin-cli.sh 同一原则。redeem 的 Set-Cookie 对本脚本无意义。
  local body_file req_file resp
  body_file="$(mktemp)"
  req_file="$(mktemp)"
  chmod 600 "$req_file"
  printf '{"code":"%s","label":"relay-system"}' "$code" > "$req_file"
  resp="$(curl -sS --max-time 10 -o "$body_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --data @"$req_file" \
    http://127.0.0.1:3030/api/pairing/redeem)" || resp="000"
  rm -f "$req_file"
  if [ "$resp" != "200" ] && [ "$resp" != "201" ]; then
    rm -f "$body_file"
    log "❌ 配对码兑换失败 HTTP $resp（检查 3030 健康与设备数上限）"; return 1
  fi
  local device_token
  device_token="$(sed -n 's/.*"deviceToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file")"
  rm -f "$body_file"
  [ -n "$device_token" ] || { log "❌ 未能从 redeem 响应解析 deviceToken"; return 1; }
  printf '\n# relay 系统设备凭据（去 token 化）：relay-v29/zusage-sidecar-v2 用它\n# 走 /api/auth/renew 换会话；设备可在 /devices 管理页（label=relay-system）撤销。\nZCODE_RELAY_LOCAL_SESSION=%s\n' "$device_token" >> "$RELAY_ENV"
  chmod 600 "$RELAY_ENV"
  log "✅ relay 系统设备凭据已写入 $RELAY_ENV（ZCODE_RELAY_LOCAL_SESSION）"
}
ensure_relay_local_session

# ── 2b. 部署（rsync --delete：同步产物+清除历史残留 bundle）─────
rsync -a --delete "$SRC/web/" <部署目录>/web/
rsync -a --delete "$SRC/server/" <部署目录>/server/
log "✅ web+server 已同步（含残留清理）"

# ── 2b-2. agent bundle 覆盖（CLI 缩略图生成端必须随本次部署上线）──
# 缩略图改动在 apps/zcode-cli（CLI runtime = agent/zcode.cjs），只更 web/server 不生效。
# 已知边界（00-部署阶段完整记录「陷阱」）：新 bundle 的 guide 插件 requiredSeedPaths
# 指向 commands/workflow.md + skills/dynamic-workflows/*，而现网官方发行包布局里这些
# 文件在 bundled-skills 插件下 → guide seed 会报 SEED_INCOMPLETE 跳过。语义已核实
# （bundled-plugins.ts:124）：跳过=拒绝写缓存并回退既有缓存，**不删除**用户缓存 →
# zcode-guide 的 5 个诊断技能继续可用（版本停留），dynamic-workflows（bundled-skills
# 四件齐）正常。接受该边界；勿在 seed 报错时回滚本步骤。
RELEASE_TARBALL="<工作区>/ZCode/dist/zcode/releases/3.14.3/zcode-3.14.3.tar.gz"
if [ -f "$RELEASE_TARBALL" ]; then
  cp -a <部署目录>/agent/zcode.cjs "$BACKUP/zcode.cjs.bak" 2>/dev/null || true
  EXTRACT_TMP=$(mktemp -d)
  tar -xzf "$RELEASE_TARBALL" -C "$EXTRACT_TMP" zcode/agent/zcode.cjs zcode/agent/THIRD-PARTY-NOTICES.md
  cp -a "$EXTRACT_TMP/zcode/agent/zcode.cjs" <部署目录>/agent/zcode.cjs
  cp -a "$EXTRACT_TMP/zcode/agent/THIRD-PARTY-NOTICES.md" <部署目录>/agent/THIRD-PARTY-NOTICES.md
  chmod 755 <部署目录>/agent/zcode.cjs
  rm -rf "$EXTRACT_TMP"
  log "✅ agent/zcode.cjs 已更新（缩略图生成端上线；原文件备份：$BACKUP/zcode.cjs.bak）"
  log "ℹ 预期告警：启动日志可能出现 zcode-guide SEED_INCOMPLETE（已知边界，缓存保留，勿回滚）"
else
  log "⚠️ 发行包缺失：$RELEASE_TARBALL —— agent bundle 未更新（缩略图不生效），继续部署 web/server"
fi

# ── 2c. 旧单 token 退役（relay-v29 / zusage-sidecar-v2 均已不读）────────
# <数据目录>/.zcode-token：server/web 源码、relay-v29、zusage-sidecar 均无读取
# （逐文件核查；relay 测试脚本 direct-rpc/host-rpc/frame-capture 仍引用，
#  属调试工具，失效不影响生产）。删除前先备份到本次备份目录。
if [ -f <数据目录>/.zcode-token ]; then
  rm -f <数据目录>/.zcode-token
  log "✅ 旧单 token 文件已退役（备份已在此前步骤存入 $BACKUP/zcode-token.retired）"
else
  log "ℹ <数据目录>/.zcode-token 不存在（已退役过，幂等跳过）"
fi

# ── 2d. unit 文件同步（relay-v29 / unit 注释更新 + 状态栏死引用清理）────────────
# 仓内 deploy/zcode-relay.service 的 ExecStart 已指向 relay-v29.mjs；运行副本需同步，
# 否则重启后仍跑 v28（读旧 token 语义）。先备份运行副本。
if [ -f /etc/systemd/system/zcode-relay.service ]; then
  cp -a /etc/systemd/system/zcode-relay.service "$BACKUP/zcode-relay.service.bak"
fi
cp -a <工作区>/deploy/zcode-relay.service /etc/systemd/system/zcode-relay.service
# zusage-sidecar.service 的 ZUSAGE_TOKEN_FILE=<数据目录>/.zcode-token 已成死引用
# （sidecar-v2 不再读该文件/变量）：sed 删除该行 + 备份原件，免改 unit 文件本体。
if [ -f /etc/systemd/system/zusage-sidecar.service ] && grep -q '^Environment=ZUSAGE_TOKEN_FILE=' /etc/systemd/system/zusage-sidecar.service; then
  cp -a /etc/systemd/system/zusage-sidecar.service "$BACKUP/zusage-sidecar.service.bak"
  sed -i '/^Environment=ZUSAGE_TOKEN_FILE=/d' /etc/systemd/system/zusage-sidecar.service
  log "✅ zusage-sidecar.service 死引用 ZUSAGE_TOKEN_FILE 已移除（备份：$BACKUP/zusage-sidecar.service.bak）"
fi
log "✅ zcode-relay.service 已同步到 v29（daemon-reload 统一挪到 §2e 之后）"

# ── 2e. zcode-web 空闲回收窗口 30min → 90min（症状：切后台回来再切会话，长时间才加载）──
# 根因：30min 空闲回收杀掉 CLI → 回来切会话触发冷启动（实测 6-12s 才有内容，最长 104s）。
# 单用户手机场景切后台通常几分钟到一小时内回来，90min 覆盖绝大多数；内存代价多保留
# 2-3 个空闲 CLI（≈1GB，16 核 15G 可承受）。幂等：已存在则替换值，无则追加。
WEB_UNIT=/etc/systemd/system/zcode-web.service
if [ -f "$WEB_UNIT" ]; then
  cp -a "$WEB_UNIT" "$BACKUP/zcode-web.service.bak"
  if grep -q '^Environment=ZCODE_AGENT_CHAT_IDLE_TIMEOUT_MS=' "$WEB_UNIT"; then
    sed -i 's/^Environment=ZCODE_AGENT_CHAT_IDLE_TIMEOUT_MS=.*/Environment=ZCODE_AGENT_CHAT_IDLE_TIMEOUT_MS=5400000/' "$WEB_UNIT"
  else
    sed -i '/^Environment=ZCODE_DYNAMIC_WORKFLOW_MODE=/a Environment=ZCODE_AGENT_CHAT_IDLE_TIMEOUT_MS=5400000' "$WEB_UNIT"
  fi
  log "✅ zcode-web 空闲回收窗口已设为 90min（备份：$BACKUP/zcode-web.service.bak）"
else
  log "⚠️ 未找到 $WEB_UNIT，跳过空闲回收窗口调整"
fi

# daemon-reload 必须在**所有**单元文件修改之后：
# 早于单元改动执行会让 restart 用到旧定义且打印 unit-changed 警告——本次无害，
# 但属通用陷阱。reload 后以 NeedDaemonReload=no 作为门禁，异常即中止。
systemctl daemon-reload
if [ "$(systemctl show zcode-web -p NeedDaemonReload --value)" != "no" ]; then
  log "❌ daemon-reload 后 zcode-web 仍标记 NeedDaemonReload，中止（不重启）"
  exit 1
fi
log "✅ daemon-reload 完成（NeedDaemonReload=no 门禁通过）"

# ── 3. 重启（会中断当前会话几秒）────────────────────────────
systemctl restart zcode-web zcode-relay zusage-sidecar
sleep 6
log "✅ 服务已重启"

# ── 4. 健康检查（任一失败 → 回滚）───────────────────────────
# 注意：旧脚本此处曾 T=$(cat <数据目录>/.zcode-token)——该文件已在 2c 退役，
# 且健康检查本就不需要凭据（用的都是无凭据 401 判定与匿名端点）。
check() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
FAIL=0
[ "$(check http://127.0.0.1:3030/api/server-info)" = "401" ] || { log "❌ 未带凭据应为 401"; FAIL=1; }
[ "$(check "http://127.0.0.1:3030/api/pairing/page")" = "200" ] || { log "❌ 配对页 200 异常"; FAIL=1; }
[ "$(check "https://<部署域名>/login")" = "200" ] || { log "❌ 公网入口异常"; FAIL=1; }
[ "$(check "http://127.0.0.1:3032/api/v1/client/configs")" != "000" ] || { log "❌ relay 不可达"; FAIL=1; }
[ "$(check "http://127.0.0.1:3033/zusage/health")" != "000" ] || { log "❌ zusage-sidecar 不可达"; FAIL=1; }
systemctl is-active --quiet zcode-web || { log "❌ zcode-web 非 active"; FAIL=1; }
systemctl is-active --quiet zcode-relay || { log "❌ zcode-relay 非 active"; FAIL=1; }
# relay 本地凭据链路：journal 里若见 [local-session:renew-failed] 即凭据失效（设备被撤销等）
if journalctl -u zcode-relay --since "30 seconds ago" --no-pager 2>/dev/null | grep -q "local-session:renew-failed"; then
  log "❌ relay 本地会话换发失败（ZCODE_RELAY_LOCAL_SESSION 失效？）"; FAIL=1
fi

# ── 5. 失败回滚 ──────────────────────────────────────────────
if [ "$FAIL" = "1" ]; then
  log "⚠️ 健康检查失败，执行回滚"
  rm -rf <部署目录>/web <部署目录>/server
  cp -a "$BACKUP/web" <部署目录>/web
  cp -a "$BACKUP/server" <部署目录>/server
  # relay 去 token 化回滚（两段）：
  #   a) env 还原（ZCODE_RELAY_LOCAL_SESSION 移除/还原 + .zcode-token 放回）+ unit 还原；
  #   b) relay/zusage 换回旧版（relay-v28 + zusage-sidecar 旧版）——旧代码读 .zcode-token，
  #      回滚后旧 token 必须在场；旧 relay 入口仍走 remoteControlToken=<旧token>。
  #   relay-v28 备份在 relay 仓 git 历史与 §1 的 $BACKUP 副本。
  cp -a "$BACKUP/relay-v28.mjs" <工作区>/relay/relay-v28.mjs 2>/dev/null || true
  if [ -f "$BACKUP/zcode-relay.service.bak" ]; then
    cp -a "$BACKUP/zcode-relay.service.bak" /etc/systemd/system/zcode-relay.service
    systemctl daemon-reload
  else
    # 无备份（unit 部署前未变过）时手动指回 v28
    sed -i 's#relay/relay-v29.mjs#relay/relay-v28.mjs#' /etc/systemd/system/zcode-relay.service
    systemctl daemon-reload
  fi
  if [ -f "$BACKUP/zcode-relay.env.bak" ]; then
    cp -a "$BACKUP/zcode-relay.env.bak" "$RELAY_ENV"
  else
    sed -i '/^ZCODE_RELAY_LOCAL_SESSION=/d' "$RELAY_ENV" 2>/dev/null || true
  fi
  if [ -f "$BACKUP/zcode-token.retired" ]; then
    cp -a "$BACKUP/zcode-token.retired" <数据目录>/.zcode-token
    chmod 600 <数据目录>/.zcode-token
  fi
  # agent bundle 与 zcode-web unit 还原（原回滚块漏了 §2b-2/§2e 两个改动面——漏还原
  # 会让"回滚态"仍跑新 CLI + 被改的 unit，误以为已完全回退）。无备份时显式告警，不静默。
  if [ -f "$BACKUP/zcode.cjs.bak" ]; then
    cp -a "$BACKUP/zcode.cjs.bak" <部署目录>/agent/zcode.cjs
    chmod 755 <部署目录>/agent/zcode.cjs
    log "✅ agent/zcode.cjs 已还原至部署前版本"
  else
    log "⚠️ 无 $BACKUP/zcode.cjs.bak，agent/zcode.cjs 保持本次部署版本（请人工核对）"
  fi
  if [ -f "$BACKUP/zcode-web.service.bak" ]; then
    cp -a "$BACKUP/zcode-web.service.bak" /etc/systemd/system/zcode-web.service
    systemctl daemon-reload
    log "✅ zcode-web.service 已还原至部署前版本"
  else
    log "⚠️ 无 $BACKUP/zcode-web.service.bak，unit 保持本次部署版本（请人工核对）"
  fi
  systemctl restart zcode-web zcode-relay zusage-sidecar
  sleep 6
  if [ "$(check http://127.0.0.1:3030/api/server-info)" = "401" ]; then
    log "✅ 回滚完成，服务恢复（relay 已还原 v28 + 旧 token；git revert relay 仓可选）"
    # 防误判二次排障：v28 的 collectBootstrap 调
    # /api/server-info?token=<旧token>——设备凭据模型的 3030 已不认 query token，必 401，
    # v28 降级为空宣告。因此回滚后远控页任务列表的「工作区宣告」为空（任务列表本身来自
    # 本机 tasks-index.sqlite，仍正常）是**预期态**，不是新故障，不要据此再排障。
    log "ℹ 预期态说明：回滚后远控页 workspace 宣告为空（v28 的 server-info?token= 对新模型"
    log "  必 401、按设计降级）——任务列表仍可用；彻底修复 = 重新部署 v29。"
  else
    log "🚨 回滚后仍异常！人工介入：systemctl status zcode-web + journalctl -u zcode-web -n 50"
  fi
  exit 2
fi

log "✅ 部署完成"
log "   备份保留于 $BACKUP（确认稳定后可删）"
# nginx 同步提醒改条件判断：运行副本已含 /api/relay/ location 时不再输出假待办；
# 文案同步更正——本机漏配实测落 3030 被会话中间件拦下返回 401 authentication_failed，
# 不是 404。
if ! grep -q 'location \^~ /api/relay/' /etc/nginx/sites-available/zcode 2>/dev/null; then
  log "⚠ nginx 运行副本缺 /api/relay/ location（门票签发端点）。需把仓内副本"
  log "  deploy/nginx-zcode.conf 同步到 /etc/nginx/sites-available/zcode 并 nginx -t && reload，"
  log "  否则直连页调 POST /api/relay/ticket 会落 3030 返回 401 authentication_failed"
  log "  （入口自助链与 legacy 链不受影响）。"
else
  log "✅ nginx 运行副本已含 /api/relay/ location（无需同步）"
fi
