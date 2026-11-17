#!/usr/bin/env bash
# admin-cli.sh — ZCode 设备凭据管理（root 本机专用）
# 用法：
#   admin-cli.sh code <label>        # 生成一次性配对码（10 分钟）
#   admin-cli.sh devices             # 列出已配对设备
#   admin-cli.sh revoke <deviceId>   # 撤销设备（删记录+终止其会话+关 WS）
#
# 端点与鉴权依据 mobile/handoff/zcode-device-credential-spec.md §6：
#   POST /api/admin/pairing-code      body {"label": ...}  → {"code","expiresAt"}
#   GET  /api/admin/devices                                 → {"devices":[...]}
#   POST /api/admin/devices/revoke  body {"id": "<32hex>"}  → 200
# 鉴权：x-zcode-admin 头 = <配置目录>/zcode-admin.secret 内容（600 root:root，
#       与任何客户端凭据不同源）。密钥只经 0600 临时头文件传给 curl（-H @file），
#       不出现在 argv / 环境变量 / 本脚本任何输出中。
# 容错：服务端若仍是旧单 token 模式，新端点返回 404 —— 属预期，提示后以专码退出。
#
# 退出码：0 成功 | 1 用法/参数错误 | 2 管理密钥文件不可用 | 3 服务不可达
#         4 端点 404（服务端未部署新模型）| 5 鉴权失败(401/403) | 6 服务端错误(5xx)
#         7 请求被拒(400/409/429，如 device_limit/rate_limited) | 8 其它意外状态
#
# 安全注意（勿改动语义）：
#   - 绝不 echo/cat 密钥；不使用 set -x/-v。
#   - 管理端点只接受本机直连（spec I5），本脚本固定打 127.0.0.1:3030。
#   - 同一时刻服务端只保留一枚配对码：生成新码会使未使用的旧码立即作废（单窗口语义）。

set -euo pipefail
umask 077

BASE_URL="http://127.0.0.1:3030"
SECRET_FILE="<配置目录>/zcode-admin.secret"

header_file=""
body_file=""
cleanup() { rm -f "${header_file:-}" "${body_file:-}"; }
trap cleanup EXIT

die() { # die <exit_code> <message...>
	local c="$1"; shift
	echo "admin-cli: $*" >&2
	exit "$c"
}

usage() {
	echo "用法：" >&2
	echo "  admin-cli.sh code <label>        # 生成配对码" >&2
	echo "  admin-cli.sh devices             # 列设备" >&2
	echo "  admin-cli.sh revoke <deviceId>   # 撤销设备" >&2
	exit 1
}

pretty() { # pretty <file> — stdout 输出 body，有 jq 则美化
	if command -v jq >/dev/null 2>&1; then
		jq . "$1" 2>/dev/null || cat "$1"
	else
		cat "$1"
	fi
}

load_secret() {
	[ -f "$SECRET_FILE" ] || die 2 "管理密钥文件不存在：$SECRET_FILE（服务端部署时由 root 创建）"
	[ -r "$SECRET_FILE" ] || die 2 "管理密钥文件不可读：$SECRET_FILE"
	local size
	size=$(stat -c '%s' "$SECRET_FILE") || die 2 "无法读取密钥文件元数据"
	[ "$size" -gt 0 ] && [ "$size" -le 4096 ] || die 2 "密钥文件大小异常（${size}B）"
	local mode
	mode=$(stat -c '%a' "$SECRET_FILE")
	[ "$mode" = "600" ] || echo "admin-cli: 警告：$SECRET_FILE 权限为 $mode（应为 600）" >&2

	# 只去 \r/\n，得到单行密钥；校验为无空白的可打印 ASCII（16..512 字符）。
	secret=$(tr -d '\r\n' < "$SECRET_FILE")
	case "$secret" in
		'' ) die 2 "密钥文件为空" ;;
		*[!\!-~]* ) die 2 "密钥含空白或非可打印字符，拒绝使用" ;;
	esac
	local len=${#secret}
	[ "$len" -ge 16 ] && [ "$len" -le 512 ] || die 2 "密钥长度异常（${len} 字符）"

	# 经 0600 临时头文件传给 curl，避免密钥进入 curl argv（ps 可见）。
	printf 'x-zcode-admin: %s\n' "$secret" > "$header_file"
}

# request <method> <path> <json_body 或 "">
# 输出：body 写入 $body_file；HTTP 状态码打印到 stderr（"admin-cli: HTTP <code>"）。
request() {
	local method="$1" path="$2" data="$3"
	local url="${BASE_URL}${path}"
	local args=(-sS -o "$body_file" -w '%{http_code}' --max-time 10
		-H "@${header_file}" -H 'Content-Type: application/json'
		-X "$method" "$url")
	[ -n "$data" ] && args+=(--data "$data")

	local code
	code=$(curl "${args[@]}" 2>/dev/null) || code="000"
	echo "admin-cli: HTTP $code $method $path" >&2
	echo "$code"
}

handle_status() { # handle_status <code>
	case "$1" in
		200|201)
			pretty "$body_file"
			exit 0
			;;
		000)
			die 3 "无法连接 ${BASE_URL}（服务未运行？）"
			;;
		404)
			die 4 "端点不存在：服务端很可能仍运行旧单 token 模式，设备凭据端点（spec §6）尚未部署。这是部署前的预期状态。"
			;;
		401|403)
			pretty "$body_file" >&2 || true
			die 5 "鉴权失败：管理密钥不符，或请求未被判定为本机直连（spec I5）。"
			;;
		400|409|429)
			pretty "$body_file" >&2 || true
			# 400 invalid_request；409 device_limit；429 rate_limited（设备凭据端点错误码语义）
			die 7 "请求被服务端拒绝（400/409/429）。"
			;;
		5*)
			pretty "$body_file" >&2 || true
			die 6 "服务端内部错误。"
			;;
		*)
			pretty "$body_file" >&2 || true
			die 8 "意外状态码 $1。"
			;;
	esac
}

main() {
	header_file=$(mktemp) || die 6 "无法创建临时文件"
	body_file=$(mktemp) || die 6 "无法创建临时文件"

	[ $# -ge 1 ] || usage
	cmd="$1"; shift

	case "$cmd" in
		code)
			[ $# -eq 1 ] || usage
			label=$(printf '%s' "$1" | tr -d '\r\n')
			[ -n "$label" ] || die 1 "label 不能为空"
			[ "${#label}" -le 64 ] || die 1 "label 超过 64 字符"
			case "$label" in
				*'"'*|*'\'*) die 1 "label 不能包含引号或反斜杠" ;;
			esac
			load_secret
			code=$(request POST /api/admin/pairing-code "{\"label\":\"${label}\"}")
			if [ "$code" = "200" ] || [ "$code" = "201" ]; then
				echo "admin-cli: 注意：服务端同一时刻只保留一枚配对码，生成新码会使未使用的旧码立即作废。" >&2
			fi
			handle_status "$code"
			;;
		devices)
			[ $# -eq 0 ] || usage
			load_secret
			code=$(request GET /api/admin/devices "")
			handle_status "$code"
			;;
		revoke)
			[ $# -eq 1 ] || usage
			device_id=$(printf '%s' "$1" | tr -d '\r\n' | tr 'A-F' 'a-f')
			if ! printf '%s' "$device_id" | grep -Eq '^[a-f0-9]{32}$'; then
				die 1 "deviceId 必须是 32 位小写 hex（可从 admin-cli.sh devices 的 id 字段获取）"
			fi
			load_secret
			code=$(request POST /api/admin/devices/revoke "{\"id\":\"${device_id}\"}")
			handle_status "$code"
			;;
		*)
			usage
			;;
	esac
}

main "$@"
