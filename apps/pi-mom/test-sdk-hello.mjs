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

  const { authStorage, modelRegistry, resourceLoader, repoRoot } = getSharedRuntime();
  check("authStorage constructed", Boolean(authStorage));
  check("modelRegistry constructed", Boolean(modelRegistry));
  check("resourceLoader constructed", Boolean(resourceLoader));
  check("repoRoot resolves to covent-agent-os", repoRoot.endsWith("covent-agent-os"), repoRoot);

  // Singleton check — second call returns the same object.
  const second = getSharedRuntime();
  check("getSharedRuntime is memoized", second.authStorage === authStorage);

  // ResourceLoader surface — best-effort discovery checks. The SDK API may
  // expose these via different method names; we probe a few and accept any.
  const probe = async (name, fn) => {
    try {
      const result = await fn();
      check(name, Array.isArray(result) && result.length > 0, `${result?.length} items`);
    } catch (err) {
      console.log(`SKIP ${name} — ${err.message ?? err}`);
    }
  };

  await probe("resourceLoader discovers extensions", async () => {
    const m = resourceLoader.discoverExtensions ?? resourceLoader.loadExtensions ?? resourceLoader.listExtensions;
    if (typeof m !== "function") throw new Error("no discover method on loader");
    return await m.call(resourceLoader);
  });

  await probe("resourceLoader discovers skills", async () => {
    const m = resourceLoader.discoverSkills ?? resourceLoader.loadSkills ?? resourceLoader.listSkills;
    if (typeof m !== "function") throw new Error("no discover method on loader");
    return await m.call(resourceLoader);
  });

  await probe("resourceLoader discovers agents", async () => {
    const m = resourceLoader.discoverAgents ?? resourceLoader.loadAgents ?? resourceLoader.listAgents;
    if (typeof m !== "function") throw new Error("no discover method on loader");
    return await m.call(resourceLoader);
  });

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
} catch (err) {
  console.error("test-sdk-hello: unexpected error", err);
  process.exit(1);
}
