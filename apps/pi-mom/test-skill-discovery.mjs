import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { clearSkillCache, resolveSkillPath } from "pi-subagents/src/agents/skills.ts";
import { buildResourceLoaderOptions, resolveProjectSkillsDir, resolveWebAccessResourcePaths } from "./lib/pi-sdk-runner.mjs";

function isUnderDir(filePath, dir) {
  const rel = relative(dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const appCwd = process.cwd();
const projectSkillsDir = resolveProjectSkillsDir();
assert.equal(projectSkillsDir, resolve(appCwd, "..", "..", "skills"), "project skills dir should resolve from app cwd to repo skills/");

const representativeSkills = [
  "covent-project-context-primer",
  "repo-worker",
  "critical-thinking-logical-reasoning",
  "slack-mcp-agent-ux",
];

const agentDir = mkdtempSync(join(tmpdir(), "pi-mom-agent-"));
try {
  const options = await buildResourceLoaderOptions({
    cwd: appCwd,
    agentDir,
    env: { PI_MOM_SUBAGENTS_ENABLED: "false" },
  });
  const webSkillsDir = resolveWebAccessResourcePaths().skillsPath;
  assert.equal(options.noExtensions, true, "ambient extension auto-discovery stays disabled in favor of app-approved explicit paths");
  assert.equal(options.noSkills, false, "skills are enabled by default");
  assert.deepEqual(options.additionalSkillPaths, [projectSkillsDir, webSkillsDir], "parent skills load from repo and app-approved package paths");

  const loader = new DefaultResourceLoader({
    ...options,
    // Skill discovery is the unit under test; skip inline extension loading here.
    extensionFactories: [],
  });
  await loader.reload();

  const loaded = loader.getSkills();
  const byName = new Map(loaded.skills.map((skill) => [skill.name, skill]));
  for (const skillName of representativeSkills) {
    const skill = byName.get(skillName);
    assert.ok(skill, `DefaultResourceLoader should load ${skillName} from apps/pi-mom cwd or ambient skill paths`);
  }
  assert.ok(isUnderDir(byName.get("covent-project-context-primer").filePath, projectSkillsDir), "Covent project primer remains repo-owned");
  assert.ok(byName.has("librarian"), "pi-web-access package skill should also be loaded");

  clearSkillCache();
  for (const skillName of representativeSkills) {
    const resolved = resolveSkillPath(skillName, appCwd);
    assert.ok(resolved, `pi-subagents should resolve ${skillName} from apps/pi-mom cwd`);
    assert.equal(resolved.source, "project-package", `${skillName} should come from apps/pi-mom package.json#pi.skills`);
    assert.ok(isUnderDir(resolved.path, projectSkillsDir), `${skillName} should resolve under repo skills/, got ${resolved.path}`);
  }
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}

console.log("skill discovery tests passed");
