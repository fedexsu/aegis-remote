#!/bin/bash
#
# Builds the un-signed HatchConnect.app bundle + the tarball that Backblaze
# serves. RUN ON A MAC.
#
# Requirements:
#   • macOS 12.3+  (ScreenCaptureKit minimum for future phases)
#   • Node.js 20+  (for `npm install ws`)
#   • Xcode Command Line Tools  (for xattr, plutil)
#   • Internet   (downloads a matching Electron .zip if not cached)
#
# Output:
#   build/HatchConnect.app        — universal2 bundle (arm64 + x64)
#   build/HatchConnect.app.tgz    — the tarball you upload to Backblaze
#   build/installer.command       — generic bootstrap (upload as launcher.command)

set -e
set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
ELECTRON_VER="33.2.0"                 # keep aligned with Windows agent's electron
ELECTRON_ZIP_ARM="electron-v${ELECTRON_VER}-darwin-arm64.zip"
ELECTRON_ZIP_X64="electron-v${ELECTRON_VER}-darwin-x64.zip"
ELECTRON_BASE="https://github.com/electron/electron/releases/download/v${ELECTRON_VER}"

mkdir -p "$BUILD"

# --- 1. Fetch Electron (arm64 only for MVP — universal2 comes later) -----------
if [ "$(uname -m)" = "arm64" ]; then
  ZIP="$ELECTRON_ZIP_ARM"
else
  ZIP="$ELECTRON_ZIP_X64"
fi
if [ ! -f "$BUILD/$ZIP" ]; then
  echo "Downloading Electron ${ELECTRON_VER}…"
  curl -fL --retry 3 -o "$BUILD/$ZIP" "$ELECTRON_BASE/$ZIP"
fi

# --- 2. Unpack Electron.app and rename to HatchConnect.app ---------------------
rm -rf "$BUILD/Electron.app" "$BUILD/HatchConnect.app"
(cd "$BUILD" && unzip -q "$ZIP")
mv "$BUILD/Electron.app" "$BUILD/HatchConnect.app"

APP="$BUILD/HatchConnect.app"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"
MACOS="$CONTENTS/MacOS"

# --- 3. Rename the main executable so ps / Activity Monitor shows "HatchConnect"
mv "$MACOS/Electron" "$MACOS/HatchConnect"

# --- 4. Overwrite Info.plist and remove Electron's default asar --------------
cp "$HERE/agent/Info.plist" "$CONTENTS/Info.plist"
rm -f "$RES/default_app.asar" "$RES/electron.icns"

# --- 5. Copy our agent JS into Contents/Resources/app ------------------------
APP_DIR="$RES/app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp "$HERE/agent/main.js"        "$APP_DIR/"
cp "$HERE/agent/preload.js"     "$APP_DIR/"
cp "$HERE/agent/onboarding.html" "$APP_DIR/"
cp "$HERE/agent/package.json"    "$APP_DIR/"

# --- 6. Install runtime deps (currently only `ws`) directly into the bundle ---
# We do NOT run scripts, matching the Windows build convention.
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --ignore-scripts )

# --- 7. Icon: user drops a 1024x1024 icon.png in mac/agent/, we build .icns ---
if [ -f "$HERE/agent/icon.png" ]; then
  ICONSET="$BUILD/icon.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  for sz in 16 32 64 128 256 512; do
    sips -z $sz $sz "$HERE/agent/icon.png" --out "$ICONSET/icon_${sz}x${sz}.png" > /dev/null
    dbl=$((sz * 2))
    sips -z $dbl $dbl "$HERE/agent/icon.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" > /dev/null
  done
  iconutil -c icns -o "$RES/icon.icns" "$ICONSET"
fi

# --- 8. Strip any inherited quarantine bit so the tarball is Gatekeeper-clean --
xattr -cr "$APP"

# --- 9. Tar it up. `--no-mac-metadata` keeps AppleDouble crap out of the tar --
( cd "$BUILD" && tar --no-mac-metadata -czf HatchConnect.app.tgz HatchConnect.app )
ls -lh "$BUILD/HatchConnect.app.tgz"

# --- 10. Ship the bootstrap alongside the tarball ----------------------------
cp "$HERE/installer.command" "$BUILD/installer.command"
chmod +x "$BUILD/installer.command"

echo ""
echo "Done."
echo "  Upload $BUILD/HatchConnect.app.tgz  →  Backblaze bucket  supportttt / HatchConnect.app.tgz"
echo "  Upload $BUILD/installer.command     →  Backblaze bucket  supportttt / launcher.command"
