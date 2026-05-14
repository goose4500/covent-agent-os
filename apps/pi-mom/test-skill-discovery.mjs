import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { clearSkillCache, resolveSkillPath } from "pi-subagents/src/agents/skills.ts";
import { buildResourceLoaderOptions, resolveProjectSkillsDir } from "./lib/pi-sdk-runner.mjs";

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
];

const agentDir = mkdtempSync(join(tmpdir(), "pi-mom-agent-"));
try {
  const options = await buildResourceLoaderOptions({
    cwd: appCwd,
    agentDir,
    env: { PI_MOM_SUBAGENTS_ENABLED: "false" },
  });
  assert.equal(options.noExtensions, true, "ambient extensions stay disabled");
  assert.equal(options.noSkills, true, "ambient user/global skill discovery stays disabled");
  assert.deepEqual(options.additionalSkillPaths, [projectSkillsDir], "parent skills load from explicit repo-owned path");

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
    assert.ok(skill, `DefaultResourceLoader should load ${skillName} from apps/pi-mom cwd`);
    assert.ok(isUnderDir(skill.filePath, projectSkillsDir), `${skillName} should resolve under repo skills/, got ${skill.filePath}`);
  }
  for (const skill of loaded.skills) {
    assert.ok(isUnderDir(skill.filePath, projectSkillsDir), `loaded skill must be repo-owned, got ${skill.filePath}`);
  }

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
