#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PYTHONDONTWRITEBYTECODE=1

if [ -x /opt/homebrew/bin/python3 ]; then
  PYTHON_BIN=/opt/homebrew/bin/python3
elif [ -x /usr/local/bin/python3 ]; then
  PYTHON_BIN=/usr/local/bin/python3
elif [ -x /usr/bin/python3 ]; then
  PYTHON_BIN=/usr/bin/python3
else
  echo "python3 not found" >&2
  exit 1
fi

LOG_ROOT=${HOME:-/tmp}
LOG_DIR="$LOG_ROOT/Library/Logs/NetflixLocalDualSubtitles"
mkdir -p "$LOG_DIR"
exec "$PYTHON_BIN" "$SCRIPT_DIR/native_host.py" "$@" 2>>"$LOG_DIR/native-host.log"
