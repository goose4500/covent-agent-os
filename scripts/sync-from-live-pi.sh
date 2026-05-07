#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MODE=${1:---dry-run}
if [[ "$MODE" != "--dry-run" && "$MODE" != "--apply" ]]; then
  echo "Usage: $0 [--dry-run|--apply]" >&2
  exit 2
fi
RSYNC_FLAGS=(-a --delete --exclude node_modules/ --exclude .git/ --exclude .cache/ --exclude '*.log' --exclude '*.pid' --exclude '.env' --exclude '.env.*')
[[ "$MODE" == "--dry-run" ]] && RSYNC_FLAGS+=(--dry-run --itemize-changes)

rsync "${RSYNC_FLAGS[@]}" \
  --exclude '.slack/apps.json' --exclude '.slack/config.json' --exclude '.slack/cache/' \
  /home/jfloyd/.pi/agent/pi-mom/ "$ROOT/apps/pi-mom/"
rsync "${RSYNC_FLAGS[@]}" -L /home/jfloyd/.pi/agent/extensions/ "$ROOT/extensions/"
rsync "${RSYNC_FLAGS[@]}" /home/jfloyd/.pi/agent/lib/ "$ROOT/lib/"
rsync "${RSYNC_FLAGS[@]}" /home/jfloyd/.pi/agent/agents/ "$ROOT/agents/"
rsync "${RSYNC_FLAGS[@]}" /home/jfloyd/.pi/agent/skills/ "$ROOT/skills/"
rsync "${RSYNC_FLAGS[@]}" /home/jfloyd/.pi/agent/packages/pi-chrome-access/ "$ROOT/packages/pi-chrome-access/"

echo "sync-from-live-pi complete ($MODE)"
