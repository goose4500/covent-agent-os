#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# Prefer gitleaks if installed. Keep custom scan as baseline either way.
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source . --redact --no-banner
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Strict token patterns. Examples/placeholders intentionally do not match.
rg -n --hidden --no-messages \
  --glob '!.git/**' \
  --glob '!node_modules/**' \
  --glob '!**/node_modules/**' \
  --glob '!package-lock.json' \
  --glob '!*.png' --glob '!*.jpg' --glob '!*.jpeg' --glob '!*.gif' --glob '!*.webp' \
  'xox[baprs]-[0-9A-Za-z-]{20,}|xapp-[0-9]+-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9_]{30,}|AIza[0-9A-Za-z_-]{30,}' . > "$TMP" || true

if [ -s "$TMP" ]; then
  echo "Potential secrets found. Redacted locations:" >&2
  cut -d: -f1-2 "$TMP" | sort -u >&2
  exit 1
fi

echo "secret-scan: ok"
