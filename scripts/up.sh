#!/usr/bin/env bash
# 一条命令起桥：生成 token → 起容器 → 打印客户端要用的两个值
set -euo pipefail
cd "$(dirname "$0")/.."
tok="$(bash scripts/token.sh)"
printf 'BRIDGE_TOKEN=%s\n' "$tok" > .env
docker compose up -d --build
echo
echo "等就绪…"
for i in $(seq 1 30); do
  if curl -sf -m 2 "http://127.0.0.1:18780/healthz" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -s http://127.0.0.1:18780/healthz | python3 -m json.tool 2>/dev/null || true
echo
echo "BRIDGE_API_KEY=$tok"
echo "ANTHROPIC_BASE_URL=http://127.0.0.1:18780"
echo "ANTHROPIC_AUTH_TOKEN=$tok"
