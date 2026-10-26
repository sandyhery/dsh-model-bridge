#!/usr/bin/env bash
# 生成/读取桥的对外 token（客户端拿它当 api key）
set -euo pipefail
dir="$HOME/.dsh-model-bridge"
file="$dir/token"
mkdir -p "$dir"; chmod 700 "$dir" 2>/dev/null || true
if [[ ! -s "$file" ]]; then
  printf 'brg-%s\n' "$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)" > "$file"
  chmod 600 "$file"
  echo "已生成 token → $file" >&2
fi
cat "$file"
