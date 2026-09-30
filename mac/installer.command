#!/bin/bash
#
# HatchConnect for macOS — bootstrap installer.
#
# This script is the Mac equivalent of the Windows /launch VBS: the customer
# downloads it, right-clicks → Open, Terminal runs it, and the agent is installed
# into the user's account with no admin password required.
#
# Contract with the relay:
#   * The relay serves this same script from /launch-command/<key>, with the
#     download filename set to  support-<key>.command  (per-key via
#     Content-Disposition, same pattern as the Windows /launch endpoint).
#   * The script reads its own filename (${0}) to recover the key — identical
#     mechanism to the Windows NSIS installer reading $EXEFILE.
#   * A single un-signed HatchConnect.app.tgz sits in Backblaze; every customer
#     downloads the same tarball, and the KEY is written into the app's config at
#     install time from this script's filename.
#
# NO admin password is required. Everything installs into the current user's
# ~/Applications, ~/Library/Application Support, and ~/Library/LaunchAgents.

set -e
set -u
set -o pipefail

RELAY_HOST="aegis-relay-production.up.railway.app"
APP_URL="https://s3.us-east-005.backblazeb2.com/supportttt/HatchConnect.app.tgz"

# --- 1. Recover the enrollment key from this script's own filename ------------
# Filename pattern from the relay: <appName>-<key>.command  (e.g. "newest-2DmH...XZ5.command")
# Also handles browser dupes: "newest-XYZ (1).command", "newest-XYZ (1) (2).command", etc.
BASENAME="$(basename "${0}" .command)"
# Strip one or more trailing " (N)" the browser adds on re-download
while [[ "$BASENAME" =~ \ \([0-9]+\)$ ]]; do
  BASENAME="${BASENAME% \([0-9]*\)}"
done
# Key is the last 20 chars, matching the Windows NSIS convention
KEY="${BASENAME: -20}"

if [ -z "$KEY" ] || [ "${#KEY}" -ne 20 ]; then
  echo "ERROR: Could not extract enrollment key from filename '$0'."
  echo "Please re-download the installer from your support link."
  read -rp "Press Return to close."
  exit 1
fi

# --- 2. Prepare install locations under $HOME (no admin required) -------------
APP_DIR="$HOME/Applications/HatchConnect.app"
SUPPORT_DIR="$HOME/Library/Application Support/HatchConnect"
AGENT_PLIST="$HOME/Library/LaunchAgents/app.hatchconnect.support.plist"

mkdir -p "$HOME/Applications"
mkdir -p "$SUPPORT_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

echo "Installing HatchConnect…"

# --- 3. Kill any running agent from a prior install ---------------------------
if [ -f "$AGENT_PLIST" ]; then
  launchctl unload "$AGENT_PLIST" 2>/dev/null || true
fi
pkill -x HatchConnect 2>/dev/null || true
sleep 1

# --- 4. Download the app tarball ----------------------------------------------
TGZ="$(mktemp -t HatchConnect).tgz"
if ! curl -fsSL --retry 3 --max-time 300 -o "$TGZ" "$APP_URL"; then
  echo "ERROR: Could not download HatchConnect from $APP_URL"
  echo "Check your internet connection and try again."
  read -rp "Press Return to close."
  exit 1
fi

# Refuse a suspiciously short download so we never install a truncated bundle
TGZ_SIZE=$(stat -f%z "$TGZ" 2>/dev/null || stat -c%s "$TGZ" 2>/dev/null || echo 0)
if [ "$TGZ_SIZE" -lt 10000000 ]; then   # 10 MB minimum
  echo "ERROR: Download was incomplete ($TGZ_SIZE bytes). Aborting install."
  rm -f "$TGZ"
  read -rp "Press Return to close."
  exit 1
fi

# --- 5. Unpack into ~/Applications --------------------------------------------
rm -rf "$APP_DIR"
mkdir -p "$HOME/Applications"
tar -xzf "$TGZ" -C "$HOME/Applications"
rm -f "$TGZ"

if [ ! -x "$APP_DIR/Contents/MacOS/HatchConnect" ]; then
  echo "ERROR: HatchConnect.app appears to be broken after unpack."
  read -rp "Press Return to close."
  exit 1
fi

# --- 6. Strip the quarantine attribute so Gatekeeper stops checking it --------
# The right-click-Open the customer did was for THIS script, not for the app
# bundle we just unpacked. The bundle still has the quarantine bit from the
# tarball download, which would trigger Gatekeeper on every launch. Removing it
# once here means launchd (and every subsequent boot) launches it silently.
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true

# --- 7. Write the enrollment config -------------------------------------------
cat > "$SUPPORT_DIR/config.json" <<EOF
{
  "relay": "wss://${RELAY_HOST}",
  "key":   "${KEY}",
  "enabled": true
}
EOF

# --- 8. Install the LaunchAgent so the agent runs at every login --------------
cat > "$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>app.hatchconnect.support</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP_DIR}/Contents/MacOS/HatchConnect</string>
    <string>--startup</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>ProcessType</key>    <string>Interactive</string>
  <key>StandardErrorPath</key> <string>${SUPPORT_DIR}/agent.err.log</string>
  <key>StandardOutPath</key>   <string>${SUPPORT_DIR}/agent.out.log</string>
</dict>
</plist>
EOF

launchctl unload "$AGENT_PLIST" 2>/dev/null || true
launchctl load "$AGENT_PLIST"

echo ""
echo "HatchConnect is installed and running."
echo ""
echo "It will now open a small window asking to grant two permissions:"
echo "  • Screen Recording"
echo "  • Accessibility"
echo ""
echo "Please follow its prompts — a technician will be able to help you"
echo "as soon as both are green."
echo ""
echo "You can close this Terminal window."

# Give the launched agent a beat to open its onboarding window,
# then exit cleanly.
sleep 2
