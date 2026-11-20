#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

find_python() {
  for bin in python3.14 python3.13 python3.12 python3; do
    if command -v "$bin" >/dev/null 2>&1; then
      if "$bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'; then
        command -v "$bin"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON_BIN="$(find_python)" || {
  echo "Python 3.12+ is required. Install with: brew install python@3.14"
  exit 1
}

if [ ! -d "$REPO_DIR/.venv" ]; then
  "$PYTHON_BIN" -m venv "$REPO_DIR/.venv"
fi

"$REPO_DIR/.venv/bin/pip" install --upgrade pip
"$REPO_DIR/.venv/bin/pip" install -e "$REPO_DIR"

GAMES_DIR="$HOME/Library/Application Support/Sports Interactive/Football Manager 27/games"
if [ "${1:-}" != "--skip-build" ] && ls "$GAMES_DIR"/*.fm >/dev/null 2>&1; then
  "$REPO_DIR/.venv/bin/python" "$REPO_DIR/scouting/build_moneyball.py"
fi

BEPINEX_DIR="${FM27_BEPINEX_DIR:-$HOME/Library/Application Support/Steam/steamapps/common/Football Manager 27/FM27-BepInEx/BepInEx}"
if [ -d "$BEPINEX_DIR/interop" ] && command -v dotnet >/dev/null 2>&1; then
  "$REPO_DIR/mod/FM27MoneyballButton/build.sh"
else
  echo "Skipping mod build (run ./mod/FM27MoneyballButton/build.sh after FM27-BepInEx generates interop/ and dotnet is installed)."
fi

echo "Setup complete. Start dashboard with: $REPO_DIR/scouting/Launch_Scout.command"
