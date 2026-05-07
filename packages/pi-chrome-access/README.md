# pi-chrome-access

Local Pi package for high-leverage Chrome browser agency.

It adds:

- `chrome_access_status` tool
- `chrome_access_install_config` tool
- `chrome_open_debug_setup` tool
- `/chrome-access` command
- `/chrome-open-debug-setup` command
- `chrome-browser-agent` skill
- a concise system-prompt hint telling Pi to use the `chrome-devtools` MCP server

Actual browser control comes from `pi-mcp-adapter` + `chrome-devtools-mcp` in `~/.pi/agent/mcp.json`.
