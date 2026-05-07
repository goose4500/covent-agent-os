#!/usr/bin/env python3
"""Slack CLI get-manifest hook: print manifest.yaml as JSON."""
import json
from pathlib import Path
import sys

try:
    import yaml
except Exception as exc:
    print(f"PyYAML is required for get-manifest: {exc}", file=sys.stderr)
    raise SystemExit(1)

manifest_path = Path(__file__).resolve().parents[1] / "manifest.yaml"
with manifest_path.open() as f:
    manifest = yaml.safe_load(f)
print(json.dumps(manifest, separators=(",", ":")))
