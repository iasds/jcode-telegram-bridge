#!/usr/bin/env bash
# Install jcode Telegram bridge as systemd user services.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --omit=dev
npm run build
mkdir -p ~/.config/systemd/user
cp deploy/jcode-api-bridge.service deploy/jcode-tg-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jcode-api-bridge.service jcode-tg-bridge.service
echo "Services installed. Enable reboot autostart with: sudo loginctl enable-linger \"$USER\""
