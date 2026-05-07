// node-compat: no Bun APIs — Pi's jiti loader runs extensions under Node
/**
 * pi-ext-env-guard
 *
 * Blocks writes to secret-bearing files via tool_call interception.
 *
 * Patterns blocked (any tool_call whose target path matches):
 *   - *.env, .env, .env.*
 *   - ~/.secrets/**
 *   - **\/credentials.json, **\/credentials.yaml, **\/credentials.yml
 *   - auth.json (when under ~/.pi/agent/ or ~/.claude/)
 *
 * Allowlist (never blocked):
 *   - .env.example, .env.sample, .env.template
 *   - .env.schema.json (per PEP 723 / uv-scripts pattern discussion)
 *
 * Behavior:
 *   - bash tool: scans event.input.command for `> .env` / `>> .env` / `echo ... > .env`
 *                / `sed -i ... .env` / `tee .env` / `cat > .env`
 *   - write / edit tools: scans event.input.path or event.input.file_path
 *
 * Interactive mode: uses ctx.ui.select to prompt "allow once?" / "always allow?" / "block"
 * Non-interactive mode: blocks by default with a descriptive reason.
 *
 * Framework context: this is a Tier-2 extension in Jake's Capability/Primitive
 * Stack (07_Solutions/synthesis/pi-capability-primitive-stack-2026-04-19.md).
 * It exists because safety gates REQUIRE Pi's mutable `tool_call.event.input`
 * primitive — which cannot be replicated as a Tier-1 capability.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BLOCKED_PATH_PATTERNS: RegExp[] = [
    /(^|\/)\.env($|\.)/, // .env, .env.local, .env.production, etc.
    /(^|\/)\.secrets(\/|$)/, // any path inside a .secrets/ dir
    /(^|\/)credentials\.(json|ya?ml|env)$/,
    /(^|\/)auth\.json$/, // catches ~/.pi/agent/auth.json, ~/.claude/auth.json
    /(^|\/)\.aws\/credentials$/,
    /(^|\/)\.gnupg\/.+/,
];

const ALLOWLISTED_PATH_PATTERNS: RegExp[] = [
    /\.env\.(example|sample|template|schema\.json)$/,
];

// Bash command patterns that write to .env-like targets.
// We use a looser regex here since bash is harder to statically analyze.
const BLOCKED_BASH_PATTERNS: RegExp[] = [
    /[>]+\s*\.env\b/, // > .env or >> .env
    /[>]+\s*[^\s]*\/\.env\b/, // > path/.env
    /\btee\s+[^|&;]*\.env\b/,
    /\bsed\s+-i[^|&;]*\.env\b/,
    /\brm\s+[^|&;]*\/\.secrets\b/,
    /\b(cp|mv)\s+[^|&;]+\s+[^|&;]*\.env\b/,
];

function isAllowlisted(path: string): boolean {
    return ALLOWLISTED_PATH_PATTERNS.some((re) => re.test(path));
}

function isBlockedPath(path: string): boolean {
    if (!path) return false;
    if (isAllowlisted(path)) return false;
    return BLOCKED_PATH_PATTERNS.some((re) => re.test(path));
}

function isBlockedBashCommand(command: string): boolean {
    if (!command) return false;
    return BLOCKED_BASH_PATTERNS.some((re) => re.test(command));
}

export default function extension(pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        const toolName = event.toolName;

        let candidatePath: string | undefined;
        let candidateKind: "path" | "bash" | undefined;

        if (toolName === "write" || toolName === "edit") {
            const input = event.input as Record<string, unknown>;
            candidatePath =
                (input?.path as string | undefined) ??
                (input?.file_path as string | undefined) ??
                (input?.filename as string | undefined);
            candidateKind = "path";

            if (!candidatePath || !isBlockedPath(candidatePath)) {
                return undefined;
            }
        } else if (toolName === "bash") {
            const cmd = (event.input as Record<string, unknown>)?.command as string | undefined;
            if (!cmd || !isBlockedBashCommand(cmd)) {
                return undefined;
            }
            candidatePath = cmd;
            candidateKind = "bash";
        } else {
            return undefined;
        }

        const reason =
            candidateKind === "path"
                ? `pi-ext-env-guard: write/edit to ${candidatePath} blocked (matches secret-bearing path pattern)`
                : `pi-ext-env-guard: bash command targets secret-bearing path: ${candidatePath}`;

        if (!ctx.hasUI) {
            return { block: true, reason };
        }

        const choice = await ctx.ui.select(
            `⚠️  env-guard: ${
                candidateKind === "path" ? `write to ${candidatePath}` : `bash: ${candidatePath}`
            }\n\nAllow?`,
            ["No, block", "Yes, allow this once"],
        );

        if (choice === "No, block" || choice === undefined) {
            return { block: true, reason: "blocked by user via env-guard prompt" };
        }

        return undefined;
    });
}
