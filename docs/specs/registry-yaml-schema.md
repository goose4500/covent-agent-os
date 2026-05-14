# Deprecated: `control-plane/registry.yaml`

> **Status:** historical reference only. The YAML control plane was removed from the live `apps/pi-mom` path.

Live route configuration now lives in:

- [`apps/pi-mom/lib/routes.mjs`](../../apps/pi-mom/lib/routes.mjs)
- [`apps/pi-mom/lib/pi-sdk-runner.mjs`](../../apps/pi-mom/lib/pi-sdk-runner.mjs)

Current behavior:

- Route prefixes shape workflow instructions/help/status only.
- Routes do **not** carry tool allowlists.
- Normal Pi-backed Slack turns activate every registered SDK tool by default.
- `DefaultResourceLoader` keeps ambient extension auto-discovery off but explicitly loads app-approved factories/paths: Linear, Slack UI, Browser Use, git checkpoint, `pi-subagents`, and app-pinned `pi-web-access`.
- Skills are default-on; repo skills plus `pi-web-access/skills` are loaded explicitly, and normal SDK skill discovery remains enabled.
- `PI_OFFLINE=1` remains required so the SDK does not auto-install user-scope packages.

If you are adding or changing a route, edit `apps/pi-mom/lib/routes.mjs` and the route/config tests under `apps/pi-mom/test-route-config.mjs`. Do not recreate a YAML registry unless there is a new explicit design decision.
