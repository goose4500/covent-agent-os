// Tests for extensions/github-pr-tools.ts.
//
// The factory registers FOUR tools: github_get_pr, github_pr_comment,
// github_create_pr, github_merge_pr. Tests inject a fake `pi`
// ExtensionAPI + a fake fetch + an env snapshot, then drive each tool's
// execute() with crafted GitHub API responses. The two mutating tools
// also receive a fake ctx.ui with a stubbed confirmWithPreview so we can
// exercise the approval gate.

import assert from "node:assert/strict";
import { createGitHubPrToolsFactory } from "../../extensions/github-pr-tools.ts";

function makeFakePi() {
  const registered = [];
  return {
    registered,
    registerTool: (definition) => registered.push(definition),
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({}),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "high",
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  };
}

function findTool(pi, name) {
  const tool = pi.registered.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

const baseEnv = {
  GITHUB_MCP_PAT: "ghp_TEST_TOKEN_12345",
  GITHUB_OWNER: "goose4500",
  GITHUB_REPO: "covent-agent-os",
};

function makeFakeFetch(handler, recorded = []) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    recorded.push({ url, init, body, method: init?.method || "GET" });
    const response = await handler({ url, body, method: init?.method || "GET" }, recorded.length);
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      async text() { return JSON.stringify(response.payload ?? {}); },
    };
  };
}

function ctxWithUI(uiOverrides = {}) {
  return {
    ui: {
      confirmWithPreview: async () => true,
      ...uiOverrides,
    },
  };
}

// Case 1: factory registers exactly four tools with the expected names + required params.
{
  const fakePi = makeFakePi();
  createGitHubPrToolsFactory({ env: baseEnv })(fakePi);
  assert.equal(fakePi.registered.length, 4, "four tools registered");
  assert.deepEqual(
    fakePi.registered.map((t) => t.name).sort(),
    ["github_create_pr", "github_get_pr", "github_merge_pr", "github_pr_comment"],
  );
  assert.deepEqual(findTool(fakePi, "github_get_pr").parameters.required, ["pull_number"]);
  assert.deepEqual(findTool(fakePi, "github_pr_comment").parameters.required, ["issue_number", "body"]);
  assert.deepEqual(findTool(fakePi, "github_create_pr").parameters.required, ["title", "body", "head"]);
  assert.deepEqual(findTool(fakePi, "github_merge_pr").parameters.required, ["pull_number"]);
}

// Case 2: github_get_pr happy path returns parsed metadata + correct URL.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      number: 122,
      title: "ADR 0010",
      body: "Body",
      state: "open",
      merged: false,
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      head: { ref: "claude/x", sha: "abc123", label: "goose4500:claude/x" },
      base: { ref: "main", sha: "def456", label: "goose4500:main" },
      html_url: "https://github.com/goose4500/covent-agent-os/pull/122",
    },
  }), calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const get = findTool(fakePi, "github_get_pr");
  const r = await get.execute("tc2", { pull_number: 122 }, undefined, undefined, ctxWithUI());
  assert.equal(r.isError, undefined);
  assert.equal(r.details.number, 122);
  assert.equal(r.details.head.ref, "claude/x");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/repos\/goose4500\/covent-agent-os\/pulls\/122$/);
  assert.match(calls[0].init.headers.Authorization, /^Bearer ghp_/);
  assert.match(r.content[0].text, /goose4500\/covent-agent-os#122/);
}

// Case 3: github_pr_comment posts to the issues endpoint (PRs/issues share namespace) — no approval gate.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { id: 999, html_url: "https://github.com/goose4500/covent-agent-os/pull/122#issuecomment-999" },
  }), calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const comment = findTool(fakePi, "github_pr_comment");
  let confirmCalls = 0;
  const r = await comment.execute(
    "tc3",
    { issue_number: 122, body: "LGTM" },
    undefined,
    undefined,
    ctxWithUI({ confirmWithPreview: async () => { confirmCalls += 1; return true; } }),
  );
  assert.equal(r.isError, undefined);
  assert.equal(confirmCalls, 0, "comment must NOT show an approval card");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/repos\/goose4500\/covent-agent-os\/issues\/122\/comments$/);
  assert.equal(calls[0].body.body, "LGTM");
  assert.equal(r.details.html_url, "https://github.com/goose4500/covent-agent-os/pull/122#issuecomment-999");
}

// Case 4: github_create_pr blocks GitHub call when the user rejects the approval card.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => {
    throw new Error("GitHub MUST NOT be called when approval is rejected");
  }, calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "github_create_pr");
  const r = await create.execute(
    "tc4",
    { title: "T", body: "B", head: "feat/x" },
    undefined,
    undefined,
    ctxWithUI({ confirmWithPreview: async () => false }),
  );
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  assert.match(r.content[0].text, /rejected|timeout/);
  assert.match(r.content[0].text, /not approved/);
}

// Case 5: github_create_pr happy path — approval card preview includes head/base/title/body, then POST /pulls.
{
  const fakePi = makeFakePi();
  const calls = [];
  let captured;
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      number: 200,
      title: "Feat X",
      html_url: "https://github.com/goose4500/covent-agent-os/pull/200",
    },
  }), calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "github_create_pr");
  const r = await create.execute(
    "tc5",
    { title: "Feat X", body: "Summary\n\nTest plan", head: "feat/x", base: "main", draft: true },
    undefined,
    undefined,
    ctxWithUI({
      confirmWithPreview: async (title, summary, previewMd) => {
        captured = { title, summary, previewMd };
        return true;
      },
    }),
  );
  assert.equal(r.isError, undefined);
  assert.equal(r.details.number, 200);
  assert.equal(calls.length, 1, "exactly one GitHub call after approval");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/repos\/goose4500\/covent-agent-os\/pulls$/);
  assert.equal(calls[0].body.title, "Feat X");
  assert.equal(calls[0].body.head, "feat/x");
  assert.equal(calls[0].body.base, "main");
  assert.equal(calls[0].body.draft, true);
  assert.match(captured.title, /Open PR/);
  assert.match(captured.previewMd, /feat\/x/);
  assert.match(captured.previewMd, /main/);
  assert.match(captured.previewMd, /Feat X/);
  assert.match(captured.previewMd, /Summary/);
}

// Case 6: github_create_pr without ctx.ui errors out (matches ADR 0010: no Slack ⇒ no write).
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => {
    throw new Error("GitHub MUST NOT be called without Slack-bound approval");
  }, calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "github_create_pr");
  const r = await create.execute(
    "tc6",
    { title: "T", body: "B", head: "feat/x" },
    undefined,
    undefined,
    {}, // no ctx.ui
  );
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  assert.match(r.content[0].text, /Slack-bound/);
}

// Case 7: github_merge_pr — fetches the PR first, builds preview from server-truth title/head/base@sha, then PUT /merge pinned to head sha.
{
  const fakePi = makeFakePi();
  const calls = [];
  let captured;
  const headSha = "1234567890abcdef1234567890abcdef12345678";
  const fakeFetch = makeFakeFetch(({ method, url }) => {
    if (method === "GET" && /\/pulls\/122$/.test(url)) {
      return {
        payload: {
          number: 122,
          title: "Real PR Title",
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { ref: "claude/x", sha: headSha },
          base: { ref: "main" },
          html_url: "https://github.com/goose4500/covent-agent-os/pull/122",
        },
      };
    }
    if (method === "PUT" && /\/pulls\/122\/merge$/.test(url)) {
      return { payload: { merged: true, sha: "deadbeef0000" } };
    }
    throw new Error(`unexpected ${method} ${url}`);
  }, calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const merge = findTool(fakePi, "github_merge_pr");
  const r = await merge.execute(
    "tc7",
    { pull_number: 122 },
    undefined,
    undefined,
    ctxWithUI({
      confirmWithPreview: async (title, summary, previewMd) => {
        captured = { title, summary, previewMd };
        return true;
      },
    }),
  );
  assert.equal(r.isError, undefined);
  assert.equal(r.details.sha, "deadbeef0000");
  assert.equal(r.details.merge_method, "squash", "default merge method is squash");
  assert.equal(calls.length, 2, "PR get then PR merge");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].body.merge_method, "squash");
  assert.equal(calls[1].body.commit_title, "Real PR Title", "commit_title falls back to PR title from server");
  assert.equal(calls[1].body.sha, headSha, "merge body pins approved head SHA");
  // Approval card preview must reflect server-truth, not model-claimed values.
  assert.match(captured.title, /Merge .+#122/);
  assert.match(captured.previewMd, /Real PR Title/);
  assert.match(captured.previewMd, /squash/);
  assert.match(captured.previewMd, /claude\/x/);
  // Preview shows short SHA so the human can verify what they're approving.
  assert.match(captured.previewMd, new RegExp(headSha.slice(0, 7)));
}

// Case 7a: github_merge_pr — head SHA moved between approval and merge (GitHub 409). Surfaces a clear "head moved" error.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(({ method, url }) => {
    if (method === "GET" && /\/pulls\/77$/.test(url)) {
      return {
        payload: {
          number: 77,
          title: "Race",
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { ref: "f", sha: "aaaaaaa00000000000000000000000000000aaaa" },
          base: { ref: "main" },
          html_url: "u",
        },
      };
    }
    if (method === "PUT") {
      return {
        ok: false,
        status: 409,
        payload: { message: "Head branch was modified. Review and try the merge again." },
      };
    }
    throw new Error("unexpected");
  }, calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const merge = findTool(fakePi, "github_merge_pr");
  const r = await merge.execute("tc7a", { pull_number: 77 }, undefined, undefined, ctxWithUI());
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /head .* moved|moved after approval/i);
  assert.match(r.content[0].text, /aaaaaaa/, "error names the approved short SHA so the operator can audit");
  assert.equal(calls.length, 2, "GET + PUT both attempted; only the PUT fails");
}

// Case 8: github_merge_pr refuses to merge an already-merged PR (no PUT call).
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(({ method, url }) => {
    if (method === "GET" && /\/pulls\/9$/.test(url)) {
      return {
        payload: { number: 9, title: "Old", state: "closed", merged: true, head: { ref: "x" }, base: { ref: "main" }, html_url: "u" },
      };
    }
    throw new Error("MUST NOT call merge endpoint for already-merged PR");
  }, calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const merge = findTool(fakePi, "github_merge_pr");
  const r = await merge.execute("tc8", { pull_number: 9 }, undefined, undefined, ctxWithUI());
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /already merged/);
  assert.equal(calls.length, 1, "only the GET happens; no PUT");
}

// Case 9: github_merge_pr blocks merge when approval rejected — GET happens (for the preview), PUT does not.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(({ method, url }) => {
    if (method === "GET" && /\/pulls\/200$/.test(url)) {
      return {
        payload: { number: 200, title: "X", state: "open", merged: false, mergeable: true, mergeable_state: "clean", head: { ref: "f" }, base: { ref: "main" }, html_url: "u" },
      };
    }
    throw new Error("MUST NOT call PUT /merge when approval is rejected");
  }, calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const merge = findTool(fakePi, "github_merge_pr");
  const r = await merge.execute(
    "tc9",
    { pull_number: 200, merge_method: "rebase" },
    undefined,
    undefined,
    ctxWithUI({ confirmWithPreview: async () => false }),
  );
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1, "PR get happened, merge did not");
  assert.match(r.content[0].text, /not approved/i);
}

// Case 10: all four tools surface missing GITHUB_MCP_PAT as isError.
{
  const envNoToken = { ...baseEnv, GITHUB_MCP_PAT: undefined };
  for (const name of ["github_get_pr", "github_pr_comment", "github_create_pr", "github_merge_pr"]) {
    const fakePi = makeFakePi();
    createGitHubPrToolsFactory({ env: envNoToken })(fakePi);
    const tool = findTool(fakePi, name);
    const args = name === "github_pr_comment"
      ? { issue_number: 1, body: "x" }
      : name === "github_create_pr"
        ? { title: "t", body: "b", head: "h" }
        : { pull_number: 1 };
    const r = await tool.execute("x", args, undefined, undefined, ctxWithUI());
    assert.equal(r.isError, true, `${name} returns isError when GITHUB_MCP_PAT missing`);
    assert.match(r.content[0].text, /GITHUB_MCP_PAT/);
  }
}

// Case 11: AbortSignal aborts read + write paths with a clear message.
{
  const fakeFetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    throw new Error("should not reach");
  };
  for (const name of ["github_get_pr", "github_pr_comment"]) {
    const fakePi = makeFakePi();
    createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
    const tool = findTool(fakePi, name);
    const ac = new AbortController(); ac.abort();
    const args = name === "github_pr_comment" ? { issue_number: 1, body: "x" } : { pull_number: 1 };
    const r = await tool.execute("x", args, ac.signal, undefined, ctxWithUI());
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /aborted/i);
  }
}

// Case 12: HTTP 4xx response from GitHub is surfaced as isError, with PAT-shaped strings redacted.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    ok: false,
    status: 422,
    payload: { message: "Validation Failed: token ghp_LEAKAGEOFAREALPATWITHENOUGHCHARS used" },
  }));
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const get = findTool(fakePi, "github_get_pr");
  const r = await get.execute("tc12", { pull_number: 999 }, undefined, undefined, ctxWithUI());
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /422/);
  assert.ok(!r.content[0].text.includes("LEAKAGE"), "secret-shaped substring redacted");
  assert.match(r.content[0].text, /\[REDACTED\]/);
}

// Case 13: github_create_pr / github_merge_pr respect explicit owner/repo overrides.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(({ method, url }) => {
    if (method === "GET" && /\/pulls\/5$/.test(url)) {
      return {
        payload: { number: 5, title: "T", state: "open", merged: false, mergeable: true, mergeable_state: "clean", head: { ref: "h" }, base: { ref: "main" }, html_url: "u" },
      };
    }
    if (method === "PUT") return { payload: { merged: true, sha: "sha-other" } };
    return { payload: {} };
  }, calls);
  createGitHubPrToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const merge = findTool(fakePi, "github_merge_pr");
  await merge.execute(
    "tc13",
    { pull_number: 5, owner: "other-org", repo: "other-repo", merge_method: "merge" },
    undefined,
    undefined,
    ctxWithUI(),
  );
  assert.match(calls[0].url, /\/repos\/other-org\/other-repo\/pulls\/5$/);
  assert.match(calls[1].url, /\/repos\/other-org\/other-repo\/pulls\/5\/merge$/);
  assert.equal(calls[1].body.merge_method, "merge");
}

console.log("github-pr-tools tests passed");
