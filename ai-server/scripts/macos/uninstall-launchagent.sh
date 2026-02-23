#!/usr/bin/env bash
set -euo pipefail

LABEL="com.focustrace.ai-server"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
launchctl disable "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true

if [[ -f "${PLIST_PATH}" ]]; then
  rm -f "${PLIST_PATH}"
fi

echo "Uninstalled launch agent: ${LABEL}"
