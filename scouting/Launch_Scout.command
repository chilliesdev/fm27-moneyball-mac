#!/usr/bin/env bash
set -euo pipefail

SCOUT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCOUT_DIR/.." && pwd)"

if [ -x "$REPO_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$REPO_DIR/.venv/bin/python"
elif [ -x "$HOME/.local/share/fmsave-venv/bin/python" ]; then
  PYTHON_BIN="$HOME/.local/share/fmsave-venv/bin/python"
else
  PYTHON_BIN="python3"
fi

if ! nc -z 127.0.0.1 8727 2>/dev/null; then
  nohup "$PYTHON_BIN" "$SCOUT_DIR/server.py" >/tmp/fm27_moneyball_server.log 2>&1 &
  sleep 1
fi

open "http://127.0.0.1:8727/?auto_refresh=1"
