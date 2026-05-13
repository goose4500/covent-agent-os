import assert from "node:assert/strict";
import { discoverAgents } from "pi-subagents/src/agents/agents.ts";

const { agents } = discoverAgents(process.cwd(), "project");
const byName = new Map(agents.map((agent) => [agent.name, agent]));

for (const name of ["team-scout", "team-planner", "team-reviewer-readonly"]) {
  assert.ok(byName.has(name), `${name} should be discoverable as a project subagent from apps/pi-mom cwd`);
  const agent = byName.get(name);
  assert.equal(agent.source, "project", `${name} must be project-scoped, not user/builtin`);
  assert.equal(agent.disabled, undefined, `${name} should be executable`);
  const tools = new Set(agent.tools || []);
  for (const forbidden of ["bash", "edit", "write", "mcp", "contact_supervisor", "intercom"]) {
    assert.ok(!tools.has(forbidden), `${name} must not expose ${forbidden}`);
  }
  for (const required of ["read", "grep", "find", "ls"]) {
    assert.ok(tools.has(required), `${name} should expose ${required}`);
  }
}

console.log("subagent project agent tests passed");
