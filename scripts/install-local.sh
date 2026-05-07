#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if ! command -v pi >/dev/null 2>&1; then
  echo "pi CLI not found on PATH" >&2
  exit 1
fi

npm run check
pi install "$ROOT"
echo "Installed Pi package from $ROOT. Run 'pi /reload' in active Pi sessions if needed."
