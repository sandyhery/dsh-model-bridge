#!/usr/bin/env bash
# 把桥上当前模型同步成 Codex 的模型目录（model_catalog_json）。
# 桥加了渠道/模型、或插件升级后重跑一次，Codex 选择器就跟着更新。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BRIDGE_PORT:-18780}"
TOKEN="$(cat "$HOME/.dsh-model-bridge/token")"
OUT="$HOME/.codex/bridge-models.json"

curl -sf -m 10 "http://127.0.0.1:$PORT/v1/models" -H "Authorization: Bearer $TOKEN" > /tmp/.bridge-models.$$.json
BRIDGE_MODELS_TMP="/tmp/.bridge-models.$$.json" OUT="$OUT" python3 - <<'PY'
import json, os, pathlib

src = json.load(open(os.environ['BRIDGE_MODELS_TMP']))['data']
LABEL = {'workbuddy4': 'WorkBuddy AI 国际版', 'workbuddy1': 'WorkBuddy 国区', 'trae': 'Trae CN', 'qoder': 'Qoder CN'}
ORDER = {'workbuddy4': 0, 'workbuddy1': 1, 'trae': 2, 'qoder': 3}

models = []
for m in src:
    channel, upstream = m['id'].split('/', 1)
    models.append({
        'slug': m['id'],
        'display_name': f"{upstream} · {LABEL.get(channel, channel)}",
        'description': f"{LABEL.get(channel, channel)} via dsh-model-bridge",
        'base_instructions': 'You are Codex, a coding agent.',
        'context_window': 200000,
        'max_context_window': 1000000,
        'effective_context_window_percent': 95,
        'default_reasoning_level': 'none',
        'default_reasoning_summary': 'none',
        'supported_reasoning_levels': [
            {'effort': 'none', 'description': 'Think-Off'},
            {'effort': 'high', 'description': 'Deep'},
        ],
        'supports_reasoning_summaries': False,
        'supports_parallel_tool_calls': True,
        'support_verbosity': False,
        'supported_in_api': True,
        'input_modalities': ['text', 'image'],
        'experimental_supported_tools': [],
        'shell_type': 'shell_command',
        'truncation_policy': {'mode': 'bytes', 'limit': 10000},
        'visibility': 'list',
    })

models.sort(key=lambda e: (ORDER.get(e['slug'].split('/', 1)[0], 9), e['slug']))
for i, e in enumerate(models):
    e['priority'] = i

pathlib.Path(os.environ['OUT']).write_text(json.dumps({'models': models}, ensure_ascii=False, indent=2) + '\n')
print(f"已更新 {os.environ['OUT']}：{len(models)} 个模型")
PY
rm -f "/tmp/.bridge-models.$$.json"
