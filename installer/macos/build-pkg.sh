#!/bin/bash
# Build an unsigned .pkg on a Mac (pkgbuild is not available on Linux CI).
# Gatekeeper will block a double-click of an unsigned package. JP can install
# the product of this script with:
#   sudo installer -pkg dist/ComfyAEBridge-unsigned.pkg -target /
# A signed installer needs an Apple Developer ID Installer certificate:
#   productsign --sign "Developer ID Installer: …" dist/ComfyAEBridge-unsigned.pkg dist/ComfyAEBridge.pkg
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-pkg.sh must be run on macOS (it calls pkgbuild)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d)"
PAYLOAD="$STAGE/payload"
SCRIPTS="$STAGE/scripts"
mkdir -p "$PAYLOAD" "$SCRIPTS" "$ROOT/dist"

cp -R "$ROOT/panel/." "$PAYLOAD/"

cat > "$SCRIPTS/postinstall" << 'EOF'
#!/bin/bash
set -euo pipefail
for ver in 11 12; do
  defaults write "/Library/Preferences/com.adobe.CSXS.${ver}" PlayerDebugMode -int 1
done
# Also the user who launched the installer, when installer preserves HOME.
if [[ -n "${USER:-}" && "$USER" != "root" ]]; then
  sudo -u "$USER" defaults write "com.adobe.CSXS.11" PlayerDebugMode 1 || true
  sudo -u "$USER" defaults write "com.adobe.CSXS.12" PlayerDebugMode 1 || true
fi
exit 0
EOF
chmod +x "$SCRIPTS/postinstall"

pkgbuild \
  --root "$PAYLOAD" \
  --scripts "$SCRIPTS" \
  --identifier org.comfy.aemcp \
  --version 0.1.0 \
  --install-location "/Library/Application Support/Adobe/CEP/extensions/com.comfy.aemcp" \
  "$ROOT/dist/ComfyAEBridge-unsigned.pkg"

rm -rf "$STAGE"
echo "Wrote $ROOT/dist/ComfyAEBridge-unsigned.pkg"
echo "This package is unsigned. See README, Signing."
