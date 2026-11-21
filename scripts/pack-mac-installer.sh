#!/bin/bash
# Zip the panel and the double-click installer. Works on Linux CI and on a Mac.
# Output: dist/Comfy-AE-Bridge-mac.zip
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
DEST="$STAGE/Comfy-AE-Bridge-mac"
mkdir -p "$DEST/panel" "$ROOT/dist"
cp -R "$ROOT/panel/." "$DEST/panel/"
cp "$ROOT/installer/macos/install.command" "$DEST/install.command"
chmod +x "$DEST/install.command"
cat > "$DEST/README-INSTALL.txt" << 'EOF'
Comfy AE Bridge — macOS panel install

1. Double-click install.command. If macOS blocks it, right-click the file,
   choose Open, and confirm. You can also run: xattr -d com.apple.quarantine install.command
2. Quit After Effects completely, then reopen it.
3. Window > Extensions > Comfy AE Bridge
   (If it is missing, check Window > Extensions (Legacy).)
4. In the panel, copy the connector URL.
5. Claude > Settings > Connectors > Add custom connector, paste the URL.

The relay must already be running. For a first test on your own Mac that is
   npm run relay
in this repo, and leave the panel's relay field at ws://127.0.0.1:8787/ws.
Claude.ai in the cloud cannot reach 127.0.0.1. Deploy the relay first
(see the repository README) and paste its wss:// URL into the panel.

This installer is unsigned. It enables PlayerDebugMode so After Effects will
load the panel. A signed ZXP is still required before a public release.
EOF
(
  cd "$STAGE"
  rm -f "$ROOT/dist/Comfy-AE-Bridge-mac.zip"
  zip -r "$ROOT/dist/Comfy-AE-Bridge-mac.zip" "Comfy-AE-Bridge-mac"
)
rm -rf "$STAGE"
echo "Wrote $ROOT/dist/Comfy-AE-Bridge-mac.zip"
