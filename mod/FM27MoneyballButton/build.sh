#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BEPINEX_DIR="${FM27_BEPINEX_DIR:-$HOME/Library/Application Support/Steam/steamapps/common/Football Manager 27/FM27-BepInEx/BepInEx}"

if [ ! -d "$BEPINEX_DIR/interop" ]; then
  echo "Missing $BEPINEX_DIR/interop"
  echo "Install [FM27] BepInEx 6 IL2CPP for macOS and launch FM27 once first."
  exit 1
fi

FM27_BEPINEX_DIR="$BEPINEX_DIR" dotnet build "$SCRIPT_DIR/FM27MoneyballButton.csproj" -c Release

mkdir -p "$BEPINEX_DIR/plugins"
cp "$SCRIPT_DIR/bin/Release/net6.0/FM27MoneyballButton.dll" "$BEPINEX_DIR/plugins/"

if [ -x "$REPO_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$REPO_DIR/.venv/bin/python"
elif [ -x "$HOME/.local/share/fmsave-venv/bin/python" ]; then
  PYTHON_BIN="$HOME/.local/share/fmsave-venv/bin/python"
else
  PYTHON_BIN="$(command -v python3)"
fi

cat > "$BEPINEX_DIR/plugins/moneyball.config.txt" <<EOF
python=$PYTHON_BIN
server=$REPO_DIR/scouting/server.py
EOF

echo "Installed FM27MoneyballButton.dll and moneyball.config.txt into $BEPINEX_DIR/plugins/"
