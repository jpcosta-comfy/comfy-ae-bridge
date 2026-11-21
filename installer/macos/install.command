#!/bin/bash
# One-step panel install for macOS. Double-click, or run from Terminal.
# Unsigned prototype: this turns on PlayerDebugMode so After Effects will load
# the extension without an Adobe signature. See the README for what signing
# still needs before this can ship outside the team.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# The packed zip has ./panel next to this script. A checkout has panel/ at the repo root.
if [[ -d "$HERE/panel/CSXS" ]]; then
  SRC="$HERE/panel"
elif [[ -d "$HERE/../../panel/CSXS" ]]; then
  SRC="$(cd "$HERE/../../panel" && pwd)"
else
  echo "Could not find the panel folder next to this installer." >&2
  exit 1
fi

TARGET="$HOME/Library/Application Support/Adobe/CEP/extensions/com.comfy.aemcp"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$SRC/." "$TARGET/"

# AE 2025 reads CSXS 11. AE 2026 may read CSXS 12. Set both.
for ver in 11 12; do
  defaults write "com.adobe.CSXS.${ver}" PlayerDebugMode 1
done
killall -u "$(whoami)" cfprefsd >/dev/null 2>&1 || true

echo ""
echo "Comfy AE Bridge panel installed."
echo "Quit After Effects completely, reopen it, then choose:"
echo "  Window > Extensions > Comfy AE Bridge"
echo "If it is not listed, also look under Window > Extensions (Legacy)."
echo ""
echo "In the panel, copy the connector URL and paste it into"
echo "Claude > Settings > Connectors > Add custom connector."
echo ""
read -r -p "Press return to close…" _ || true
