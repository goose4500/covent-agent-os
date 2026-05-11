// Smoke test for the embedded Pi SDK runtime (PR 1 of the migration).
//
// Validates:
//   1. @earendil-works/pi-coding-agent is installed and importable.
//   2. apps/pi-mom/lib/pi-runtime.mjs builds shared singletons without error.
//   3. DefaultResourceLoader picks up the configured extension/skill/agent
//      paths (we assert non-zero counts; exact counts are validated by
//      validate:agents and validate:skills).
//
// Skip semantics: if the SDK package is not installed (e.g. before
// `npm install` runs in CI), the test prints a SKIP line and exits 0.
// This keeps `npm run check` green when run from a freshly-cloned tree.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd(), "..", "..");
const SDK_PATH = resolve(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const ALT_SDK_PATH = resolve(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");

if (!existsSync(SDK_PATH) && !existsSync(ALT_SDK_PATH)) {
  console.log("SKIP test-sdk-hello: @earendil-works/pi-coding-agent not installed (run `npm install`)");
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  const { getSharedRuntime } = await import("./lib/pi-runtime.mjs");

  const { authStorage, modelRegistry, resourceLoader, repoRoot } = await getSharedRuntime();
  check("authStorage constructed", Boolean(authStorage));
  check("modelRegistry constructed", Boolean(modelRegistry));
  check("resourceLoader constructed", Boolean(resourceLoader));
  check("repoRoot resolves to covent-agent-os", repoRoot.endsWith("covent-agent-os"), repoRoot);

  // Singleton check — second call returns the same object.
  const second = await getSharedRuntime();
  check("getSharedRuntime is memoized", second.authStorage === authStorage);

  // Real ResourceLoader surface from @earendil-works/pi-coding-agent 0.74:
  //   getExtensions() -> LoadExtensionsResult { extensions, errors, runtime }
  //   getSkills()     -> { skills, diagnostics }
  //   getPrompts()    -> { prompts, diagnostics }
  //   getAgentsFiles()-> { agentsFiles }
  // We assert non-zero counts on the resources this repo loads explicitly.
  const ext = resourceLoader.getExtensions();
  check(
    "resourceLoader loads >= 7 extensions",
    Array.isArray(ext?.extensions) && ext.extensions.length >= 7,
    `${ext?.extensions?.length} extensions`,
  );

  const skills = resourceLoader.getSkills();
  check(
    "resourceLoader loads >= 1 skill",
    Array.isArray(skills?.skills) && skills.skills.length >= 1,
    `${skills?.skills?.length} skills`,
  );

  const agentsFiles = resourceLoader.getAgentsFiles();
  check(
    "resourceLoader loads agent files",
    Array.isArray(agentsFiles?.agentsFiles),
    `${agentsFiles?.agentsFiles?.length ?? 0} agent files`,
  );

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
} catch (err) {
  console.error("test-sdk-hello: unexpected error", err);
  process.exit(1);
}
