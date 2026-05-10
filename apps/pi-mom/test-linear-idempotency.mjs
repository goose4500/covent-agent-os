import assert from "node:assert/strict";
import {
  createLinearIssueUnlessDuplicate,
  duplicateLinearIssueReply,
  extractLinearIssueReference,
  findPriorLinearIssueConfirmation,
} from "./lib/linear-idempotency.mjs";

const slackLink = extractLinearIssueReference("✅ Created Linear issue <https://linear.app/covent/issue/FE-528/verify-slack-to-linear|FE-528: Verify Slack-to-Linear issue creation>");
assert.equal(slackLink.url, "https://linear.app/covent/issue/FE-528/verify-slack-to-linear");
assert.equal(slackLink.identifier, "FE-528");
assert.equal(slackLink.reference, "<https://linear.app/covent/issue/FE-528/verify-slack-to-linear|FE-528: Verify Slack-to-Linear issue creation>");

const bareUrl = extractLinearIssueReference("Created Linear issue https://linear.app/covent/issue/ABC-123/test-title");
assert.equal(bareUrl.identifier, "ABC-123");
assert.equal(bareUrl.reference, "<https://linear.app/covent/issue/ABC-123/test-title|ABC-123>");

const bareKey = extractLinearIssueReference("Created Linear issue FE-999");
assert.equal(bareKey.identifier, "FE-999");
assert.equal(bareKey.reference, "FE-999");

assert.equal(extractLinearIssueReference("I drafted the issue spec, but did not create the Linear issue: LINEAR_API_KEY is not set"), undefined);
assert.equal(extractLinearIssueReference("Draft: Created Linear issue FE-111"), undefined);
assert.equal(extractLinearIssueReference("Created Linear issue draft for FE-111"), undefined);
assert.equal(extractLinearIssueReference("Mentioned Linear issue FE-222 while discussing scope"), undefined);
assert.equal(extractLinearIssueReference("Created Linear issue but no URL or key yet"), undefined);

const prior = findPriorLinearIssueConfirmation([
  { ts: "1", text: "Created Linear issue FE-101" },
  { ts: "2", text: "Created Linear issue <https://linear.app/covent/issue/FE-202/newer|FE-202: Newer>" },
]);
assert.equal(prior.messageTs, "2");
assert.equal(prior.identifier, "FE-202");
assert.match(duplicateLinearIssueReply(prior), /FE-202/);

let createCalls = 0;
let duplicateReplies = 0;
const duplicateOutcome = await createLinearIssueUnlessDuplicate({
  messages: [{ ts: "3", text: "✅ Created Linear issue <https://linear.app/covent/issue/FE-303/existing|FE-303: Existing>" }],
  createIssue: async () => {
    createCalls += 1;
    return { identifier: "FE-404" };
  },
  postDuplicateReply: async () => {
    duplicateReplies += 1;
  },
});
assert.equal(duplicateOutcome.status, "duplicate");
assert.equal(createCalls, 0);
assert.equal(duplicateReplies, 1);

const createdOutcome = await createLinearIssueUnlessDuplicate({
  messages: [{ ts: "4", text: "No prior success here" }],
  createIssue: async () => {
    createCalls += 1;
    return { identifier: "FE-505" };
  },
});
assert.equal(createdOutcome.status, "created");
assert.equal(createdOutcome.issue.identifier, "FE-505");
assert.equal(createCalls, 1);

console.log("linear idempotency tests passed");
