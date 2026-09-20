#!/usr/bin/env bash
# Node-to-Proxy 代理端口防火墙规则下发
# 用法: firewall.sh --allowlist <json> --web-port <port> --ports <p1,p2>
# 生成独立的 nftables 表（不影响 docker/wg-quick 的既有表），幂等可重复执行。
set -euo pipefail

ALLOWLIST=""
WEB_PORT=""
PORTS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allowlist) ALLOWLIST="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --ports) PORTS="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -f "$ALLOWLIST" ]] || { echo "allowlist 文件不存在: $ALLOWLIST" >&2; exit 1; }
[[ -n "$PORTS" ]] || { echo "缺少 --ports" >&2; exit 2; }

# 从 allowlist.json 提取 cidr 值（应用层已做格式校验）
V4=()
V6=()
while IFS= read -r cidr; do
  [[ -z "$cidr" ]] && continue
  case "$cidr" in
    *:*) V6+=("$cidr") ;;
    *)   V4+=("$cidr") ;;
  esac
done < <(grep -oE '"cidr"[[:space:]]*:[[:space:]]*"[^"]+"' "$ALLOWLIST" | sed -E 's/.*"[^"]*"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/')

TABLE="node2proxy_in"
RULESET_FILE=$(mktemp)
trap 'rm -f "$RULESET_FILE"' EXIT

{
  echo "table inet ${TABLE} {"
  echo "  chain input {"
  echo "    type filter hook input priority filter - 10; policy accept;"
  echo "    iifname \"lo\" accept"
  echo "    ct state established,related accept"
  if [[ ${#V4[@]} -gt 0 || ${#V6[@]} -gt 0 ]]; then
    PORT_SET="{ ${PORTS//,/ , } }"
    for cidr in "${V4[@]}"; do
      echo "    ip saddr ${cidr} tcp dport ${PORT_SET} accept"
    done
    for cidr in "${V6[@]}"; do
      echo "    ip6 saddr ${cidr} tcp dport ${PORT_SET} accept"
    done
  fi
  # 其余来源对代理端口：限速（防风暴）+ RST 拒绝
  for p in ${PORTS//,/ }; do
    echo "    tcp dport ${p} limit rate 3/minute"
    echo "    tcp dport ${p} reject with tcp reset"
  done
  echo "  }"
  echo "}"
} > "$RULESET_FILE"

nft delete table inet "${TABLE}" 2>/dev/null || true
nft -f "$RULESET_FILE"
echo "ok v4=${#V4[@]} v6=${#V6[@]} web=${WEB_PORT} ports=${PORTS}"