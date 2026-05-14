import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "pi-subagents/src/agents/agents.ts";
import { clearSkillCache, resolveSkillPath } from "pi-subagents/src/agents/skills.ts";

const { agents } = discoverAgents(process.cwd(), "project");
const byName = new Map(agents.map((agent) => [agent.name, agent]));
const READONLY_LOCAL_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READONLY_WEB_TOOLS = new Set(["web_search", "get_search_content", "code_search"]);
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
  assert.equal(agent.inheritSkills, false, `${name} must not blindly inherit all parent/user skills`);
  assert.deepEqual(agent.skills || [], expectedSkills.get(name), `${name} should declare only reviewed project-owned skills`);

  const tools = new Set(agent.tools || []);
  for (const forbidden of ["bash", "edit", "write", "mcp", "contact_supervisor", "intercom"]) {
    assert.ok(!tools.has(forbidden), `${name} must not expose ${forbidden}`);
  }
  assert.deepEqual(agent.mcpDirectTools || [], [], `${name} must not expose direct MCP tools`);
  for (const required of READONLY_LOCAL_TOOLS) {
    assert.ok(tools.has(required), `${name} should expose ${required}`);
  }

  if (name === "team-scout") {
    for (const tool of READONLY_WEB_TOOLS) {
      assert.ok(tools.has(tool), `team-scout should expose bounded read-only web tool ${tool}`);
    }
    assert.deepEqual(agent.extensions, ["extensions/pi-web-access-child.ts"], "team-scout should load the explicit safe pi-web-access child extension");
    assert.match(agent.systemPrompt, /do not search secrets/i);
    assert.match(agent.systemPrompt, /Direct URL fetch is not exposed/);
  } else {
    for (const tool of READONLY_WEB_TOOLS) {
      assert.ok(!tools.has(tool), `${name} should stay local-only by default`);
    }
    assert.deepEqual(agent.extensions, ["extensions/noop-child.ts"], `${name} should force --no-extensions via the no-op child extension`);
  }

  for (const tool of tools) {
    assert.ok(
      READONLY_LOCAL_TOOLS.has(tool) || (name === "team-scout" && READONLY_WEB_TOOLS.has(tool)),
      `${name} exposes only approved read-only tools (${tool})`,
    );
  }

  for (const skillName of agent.skills || []) {
    const resolved = resolveSkillPath(skillName, process.cwd());
    assert.ok(resolved, `${name} skill ${skillName} should resolve from apps/pi-mom cwd`);
    assert.ok(projectSkillSources.has(resolved.source), `${name} skill ${skillName} should be project-owned, got ${resolved.source}`);
    assert.ok(isUnderDir(resolved.path, projectSkillsDir), `${name} skill ${skillName} should resolve under repo skills/, got ${resolved.path}`);
  }
}

// Child extension smoke: the static frontmatter path loads through the SDK loader
// without ambient extension discovery, and only registers pi-web-access tools
// when the shared feature flag is enabled in the child environment.
{
  const scout = byName.get("team-scout");
  const previousFlag = process.env.PI_MOM_WEB_ACCESS_ENABLED;
  try {
    delete process.env.PI_MOM_WEB_ACCESS_ENABLED;
    const disabledLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: "/tmp/pi-agent-team-scout-web-disabled-test",
      noExtensions: true,
      additionalExtensionPaths: scout.extensions,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await disabledLoader.reload();
    assert.deepEqual(disabledLoader.getExtensions().errors, [], "team-scout child extension should load disabled stubs cleanly when disabled");
    const disabledTools = new Set(disabledLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]));
    for (const tool of READONLY_WEB_TOOLS) {
      assert.ok(disabledTools.has(tool), `team-scout child extension registers disabled stub for ${tool}`);
    }

    process.env.PI_MOM_WEB_ACCESS_ENABLED = "true";
    const enabledLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: "/tmp/pi-agent-team-scout-web-enabled-test",
      noExtensions: true,
      additionalExtensionPaths: scout.extensions,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await enabledLoader.reload();
    assert.deepEqual(enabledLoader.getExtensions().errors, [], "team-scout pi-web-access child extension should load cleanly when enabled");
    const registeredTools = new Set(enabledLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]));
    for (const tool of READONLY_WEB_TOOLS) {
      assert.ok(registeredTools.has(tool), `team-scout child extension registers ${tool}`);
    }
  } finally {
    if (previousFlag === undefined) delete process.env.PI_MOM_WEB_ACCESS_ENABLED;
    else process.env.PI_MOM_WEB_ACCESS_ENABLED = previousFlag;
  }
}

console.log("subagent project agent tests passed");
