// Explicit no-op child extension for read-only team agents that do not need
// package tools. Its presence in agent frontmatter makes pi-subagents pass
// `--no-extensions` to the child Pi CLI while still allowing the mandatory
// subagent prompt-runtime extension.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function noopChildExtension(_pi: ExtensionAPI) {}
