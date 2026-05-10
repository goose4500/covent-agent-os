import { clampLinearTitle, extractLinearIssuePayload } from "../domain/linear-payload.ts";
import type { Config } from "../config.ts";
import type { Trace } from "../trace.ts";
import type { createSlackAdapter } from "./slack.ts";

export type LinearAdapterDeps = {
  config: Config;
  trace: Trace;
  slack: ReturnType<typeof createSlackAdapter>;
};

export function createLinearAdapter({ config, trace, slack }: LinearAdapterDeps) {
  async function createLinearIssue({ title, description, slackUrl, requestId }) {
    if (!config.linear.apiKey) {
      throw new Error("LINEAR_API_KEY is not set in the pi-mom environment.");
    }

    const fullDescription = `${description.trim()}\n\n---\n\nSource Slack thread: ${slackUrl || "unavailable"}\nCreated by Covent Pi request: ${requestId}`;
    const query = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title url }
        }
      }
    `;

    const response = await fetch(config.linear.apiUrl, {
      method: "POST",
      headers: {
        Authorization: config.linear.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          input: {
            teamId: config.linear.teamId,
            projectId: config.linear.projectId,
            stateId: config.linear.stateId,
            title: clampLinearTitle(title),
            description: fullDescription,
          },
        },
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.errors?.length) {
      const message = payload.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`;
      throw new Error(`Linear issueCreate failed: ${message}`);
    }
    if (!payload.data?.issueCreate?.success || !payload.data?.issueCreate?.issue) {
      throw new Error("Linear issueCreate did not return a created issue.");
    }

    return payload.data.issueCreate.issue;
  }

  async function createLinearIssueFromPiOutput({ client, channel, threadTs, requestId, result }) {
    const sourceUrl = await slack.getSlackPermalink(client, channel, threadTs);
    const { title, description } = extractLinearIssuePayload(result);

    trace("linear.issue_create_requested", {
      requestId,
      titleLength: title.length,
      descriptionLength: description.length,
      teamId: config.linear.teamId,
      projectId: config.linear.projectId,
      stateId: config.linear.stateId,
    });

    const issue = await createLinearIssue({ title, description, slackUrl: sourceUrl, requestId });
    trace("linear.issue_created", { requestId, identifier: issue.identifier, issueId: issue.id });
    return issue;
  }

  return { createLinearIssue, createLinearIssueFromPiOutput };
}
