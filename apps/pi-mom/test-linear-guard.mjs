import assert from "node:assert/strict";
import test from "node:test";
import { findExistingLinearIssueConfirmation, formatExistingLinearIssueMessage } from "./lib/linear-guard.mjs";

test("duplicate guard detects standard Slack-created Linear confirmation", () => {
  const existing = findExistingLinearIssueConfirmation([
    { ts: "1", text: "random draft" },
    { ts: "2", text: "✅ Created Linear issue <https://linear.app/dispo-genius/issue/FE-528/verify-slack-to-linear|FE-528: Verify Slack-to-Linear issue creation>" },
  ]);
  assert.equal(existing.identifier, "FE-528");
  assert.equal(existing.url, "https://linear.app/dispo-genius/issue/FE-528/verify-slack-to-linear");
  assert.equal(existing.messageTs, "2");
});

test("duplicate guard detects success text with identifier even without URL", () => {
  const existing = findExistingLinearIssueConfirmation([{ text: "Created Linear issue FE-999: Harden pi-mom" }]);
  assert.equal(existing.identifier, "FE-999");
  assert.equal(existing.title, "Harden pi-mom");
});

test("duplicate guard ignores drafts and failure notices", () => {
  assert.equal(findExistingLinearIssueConfirmation([{ text: "Title: Create Linear issue draft" }]), undefined);
  assert.equal(findExistingLinearIssueConfirmation([{ text: "I drafted the issue spec, but did not create the Linear issue: LINEAR_API_KEY missing" }]), undefined);
  assert.equal(findExistingLinearIssueConfirmation([{ text: "Linear issue creation: LINEAR_API_KEY missing" }]), undefined);
});

test("duplicate guard message links existing issue when possible", () => {
  const message = formatExistingLinearIssueMessage({ identifier: "FE-528", title: "Verify route", url: "https://linear.app/x/issue/FE-528/test" });
  assert(message.includes("skipped creating a duplicate"));
  assert(message.includes("<https://linear.app/x/issue/FE-528/test|FE-528: Verify route>"));
});
