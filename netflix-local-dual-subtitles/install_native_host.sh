#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法：bash install_native_host.sh <Chrome 扩展 ID>" >&2
  exit 2
fi

EXTENSION_ID=$1
case "$EXTENSION_ID" in
  chrome-extension://*)
    EXTENSION_ID=${EXTENSION_ID#chrome-extension://}
    EXTENSION_ID=${EXTENSION_ID%%/*}
    ;;
esac
ORIGIN="chrome-extension://${EXTENSION_ID}/"

case "$EXTENSION_ID" in
  ''|*[!a-p0-9]*)
    echo "扩展 ID 格式看起来不正确，请从 chrome://extensions 复制完整 ID。" >&2
    exit 2
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST_NAME="com.netflix.local_dual_subtitles"
HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="$HOST_DIR/${HOST_NAME}.json"

mkdir -p "$HOST_DIR"
chmod +x "$SCRIPT_DIR/native_host.sh" "$SCRIPT_DIR/native_host.py"

PYTHONDONTWRITEBYTECODE=1 python3 - "$HOST_MANIFEST" "$ORIGIN" "$SCRIPT_DIR/native_host.py" "$HOST_NAME" <<'PY'
import json
import sys
from pathlib import Path

manifest_path, origin, executable, name = sys.argv[1:]
payload = {
    "name": name,
    "description": "Netflix Local Dual Subtitles native host",
    "path": executable,
    "type": "stdio",
    "allowed_origins": [origin if origin.endswith('/') else origin + '/'],
}
Path(manifest_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

echo "Native Messaging 宿主已安装：$HOST_MANIFEST"
echo "请回到 chrome://extensions，重新加载本扩展，然后使用“启动本地模型”按钮。"
