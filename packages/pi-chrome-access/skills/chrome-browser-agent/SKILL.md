---
name: chrome-browser-agent
description: Use when the user asks Pi to operate, inspect, debug, automate, or browse with their local Google Chrome/Chromium browser, especially the real logged-in profile via Chrome DevTools MCP.
---

# Chrome Browser Agent

Pi has Chrome access through the Pi MCP adapter server `chrome-devtools`.

Default high-leverage mode for this machine is **real-profile autoConnect**:

- Server: `chrome-devtools`
- Backend: `chrome-devtools-mcp@latest --autoConnect --user-data-dir=/mnt/c/Users/Jfloy/AppData/Local/Google/Chrome/User Data --experimental-vision` on this WSL machine unless `PI_CHROME_USER_DATA_DIR` overrides it.
- Expected user flow: keep the native Windows Chrome profile open, enable/allow remote debugging at `chrome://inspect/#remote-debugging`, then approve Chrome's visible permission dialog.

## Tool workflow

1. If status is unclear, call `chrome_access_status`.
2. If the Chrome permission setup page is needed, call `chrome_open_debug_setup`.
3. Connect/use browser tools through MCP:
   - `mcp({ connect: "chrome-devtools" })`
   - `mcp({ search: "chrome_devtools snapshot screenshot navigate click type console network" })`
   - call the relevant `chrome_devtools_*` tool.
4. Prefer `take_snapshot` before DOM actions.
5. Use screenshots for visual confirmation.
6. Use console/network tools for debugging web apps.
7. Keep output compact; do not dump full DOM/network bodies unless needed.

## Agency principle

The user wants high-agency visible browser automation in their real profile. Act decisively and use the browser when it creates leverage. Still avoid needless credential/cookie/header exfiltration, keep actions visible, and narrate high-risk actions before doing them when practical.
