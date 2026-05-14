import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";
import { discoverAgents } from "pi-subagents/src/agents/agents.ts";
import { clearSkillCache, resolveSkillPath } from "pi-subagents/src/agents/skills.ts";

const { agents } = discoverAgents(process.cwd(), "project");
const byName = new Map(agents.map((agent) => [agent.name, agent]));
const CHILD_EXTENSION_PATHS = [
  "../../extensions/linear-tools.ts",
  "../../extensions/slack-interactive-tools.ts",
  "../../extensions/browser-use-tools.ts",
  "../../extensions/git-checkpoint.ts",
  "node_modules/pi-web-access/index.ts",
];
const expectedSkills = new Map([
  ["team-scout", ["covent-project-context-primer"]],
  ["team-planner", ["covent-project-context-primer"]],
  ["team-reviewer-readonly", ["covent-project-context-primer"]],
]);
const projectSkillSources = new Set(["project", "project-package", "project-settings"]);

function isUnderDir(filePath, dir) {
  const rel = relative(dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

clearSkillCache();
const projectSkillsDir = new URL("../../skills/", import.meta.url).pathname;

for (const name of ["team-scout", "team-planner", "team-reviewer-readonly"]) {
  assert.ok(byName.has(name), `${name} should be discoverable as a project subagent from apps/pi-mom cwd`);
  const agent = byName.get(name);
  assert.equal(agent.source, "project", `${name} must be project-scoped, not user/builtin`);
  assert.equal(agent.model, "openai-codex/gpt-5.5", `${name} should pin the deployed Codex model for child CLI runs`);
  assert.equal(agent.disabled, undefined, `${name} should be executable`);
  assert.equal(agent.inheritSkills, true, `${name} should inherit the default skill surface`);
  assert.deepEqual(agent.skills || [], expectedSkills.get(name), `${name} should still inject the Covent project primer`);
  assert.deepEqual(agent.tools || [], [], `${name} should not carry a child tool allowlist`);
  assert.deepEqual(agent.mcpDirectTools || [], [], `${name} should not carry direct MCP tool restrictions`);
  assert.deepEqual(agent.extensions || [], CHILD_EXTENSION_PATHS, `${name} should load the same app-approved child extension surface`);
  assert.match(agent.systemPrompt, /All default Pi tools may be available/i);
  if (name === "team-scout") {
    assert.match(agent.systemPrompt, /do not search secrets/i);
  }

  for (const skillName of agent.skills || []) {
    const resolved = resolveSkillPath(skillName, process.cwd());
    assert.ok(resolved, `${name} skill ${skillName} should resolve from apps/pi-mom cwd`);
    assert.ok(projectSkillSources.has(resolved.source), `${name} skill ${skillName} should be project-owned, got ${resolved.source}`);
    assert.ok(isUnderDir(resolved.path, projectSkillsDir), `${name} skill ${skillName} should resolve under repo skills/, got ${resolved.path}`);
  }
}

console.log("subagent project agent tests passed");
