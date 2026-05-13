// PRD-intake orchestrator: download a Slack-hosted zip, extract its text,
// run the Pi `intake` route to capture proposals via intake_propose_issues,
// then post one parent summary + one Approve/Cancel/Edit card per proposal.
//
// Invariants worth knowing:
//   - All I/O is dependency-injected so tests run without real Slack/Pi.
//   - Trace payloads are structural only — never log file/proposal content.
//   - intake runs are serialized via withIntakeRunLock; the intake tool reads
//     process.env._PI_INTAKE_REQUEST_ID at execute() time, so concurrent
//     runs would otherwise clobber each other's requestId.
//   - The orchestrator never writes to Linear; that's the Approve handler.

import {
  downloadSlackFile as defaultDownloadSlackFile,
  extractZipBuffer as defaultExtractZipBuffer,
} from "./intake-zip.mjs";
import {
  buildIntakeSummaryBlocks,
  buildProposalCardBlocks,
} from "./intake-card.mjs";
import {
  nextIntakeApprovalId,
  registerProposal,
} from "./intake-proposal-store.mjs";
import { resolveAction as defaultResolveAction } from "./action-resolver.mjs";
import { runTurn as defaultRunTurn } from "./pi-session.mjs";
import { intakeProposalCapture } from "../../../extensions/intake-tools.ts";

export const PROMPT_AGGREGATE_LIMIT = 120_000;

// Per-process serializer for intake runs. The intake_propose_issues tool
// reads process.env._PI_INTAKE_REQUEST_ID at execute() time, so two
// concurrent runs would clobber each other's requestId. Bolt event
// handlers run concurrently in JS, so a simple Promise-chain mutex is the
// minimum needed to keep the env-var contract sound.
let _intakeRunQueue = Promise.resolve();
function withIntakeRunLock(fn) {
  const prev = _intakeRunQueue;
  let release;
  _intakeRunQueue = new Promise((r) => { release = r; });
  return prev.then(fn).finally(() => release());
}

function safeTrace(trace, event, payload) {
  try {
    trace(event, payload);
  } catch {
    // Tracing must never throw out of the orchestrator.
  }
}

function isZipName(name) {
  if (!name || typeof name !== "string") return false;
  return name.toLowerCase().endsWith(".zip");
}

function shortMessage(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

// Build the Pi prompt body. Exported for tests.
//
//   files     — text-bearing files from extractZipBuffer (binaries are
//               classified into skipped before they reach here).
//   skipped   — { name, reason } from extractZipBuffer (we forward the
//               manifest verbatim so the model can see what was dropped).
//   defaults  — channel default Linear team/project ids; the prompt nudges
//               the model to use them as suggested_team_id/suggested_project_id
//               unless the spec text strongly implies otherwise.
export function buildIntakePrompt({
  zipFilename,
  files = [],
  skipped = [],
  defaultTeamId,
  defaultProjectId,
  channel,
  threadTs,
  user,
  requestId,
} = {}) {
  const header =
    `You are receiving extracted PRD spec text from a zip dropped into #polaris-prd-intake.

Channel defaults:
- default_team_id: ${defaultTeamId || "(unset)"}
- default_project_id: ${defaultProjectId || "(unset)"}

Zip: ${zipFilename || "(unnamed.zip)"}
File count: ${files.length}; skipped: ${skipped.length}

For each proposal, use default_team_id / default_project_id as suggested_team_id / suggested_project_id unless the spec text strongly implies a different team. Call intake_propose_issues EXACTLY ONCE with the full list.

Slack context:
- channel: ${channel || "(unknown)"}
- thread_ts: ${threadTs || "(unknown)"}
- user: ${user ? `<@${user}>` : "(unknown)"}
- request_id: ${requestId || "(unset)"}

---FILES---
`;

  const sections = [];
  let aggregate = 0;
  let truncatedRemaining = 0;
  let firstTruncatedIdx = -1;

  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    // Binary files (text === null) are intentionally skipped from the prompt
    // body; they were already classified in skipped[] before getting here in
    // typical usage, but we belt-and-suspenders.
    if (typeof f.text !== "string" || f.text.length === 0) continue;

    const body = f.text;
    const truncatedFlag = f.truncated === true ? ", truncated" : "";
    const sectionHeader = `### ${f.relPath || f.name || "(unnamed)"} (${
      f.mediaType || "text"
    }, ${Number.isFinite(Number(f.sizeBytes)) ? Number(f.sizeBytes) : body.length} bytes${truncatedFlag})`;

    const block = `${sectionHeader}\n\n${body}\n\n---END-FILE---\n`;

    if (aggregate + block.length > PROMPT_AGGREGATE_LIMIT) {
      // Stop emitting more file bodies; count remaining text-bearing files so
      // we can add a single truncation notice.
      if (firstTruncatedIdx === -1) firstTruncatedIdx = i;
      truncatedRemaining += 1;
      continue;
    }

    sections.push(block);
    aggregate += block.length;
  }

  let body = sections.join("\n");

  if (truncatedRemaining > 0) {
    body += `\n[remaining ${truncatedRemaining} file${
      truncatedRemaining === 1 ? "" : "s"
    } truncated to keep prompt under cap]\n`;
  }

  let skippedSection = "";
  if (skipped.length > 0) {
    const lines = skipped.map((s) => {
      const name = s?.relPath || s?.name || "(unnamed)";
      const reason = s?.reason || "skipped";
      return `- ${name}: ${reason}`;
    });
    skippedSection = `\n---SKIPPED---\n${lines.join("\n")}\n---END-SKIPPED---\n`;
  }

  return `${header}\n${body}${skippedSection}`;
}

// Internal helper: post a single chat.postMessage with text fallback, used
// only for failure paths (download error / empty zip / Pi run failure). The
// summary + cards use Block Kit via the dedicated builders.
async function postPlainText(client, { channel, thread_ts, text }, trace, label) {
  try {
    const res = await client.chat.postMessage({ channel, thread_ts, text });
    safeTrace(trace, "intake.posted_status", { label, ts: res?.ts });
    return res;
  } catch (error) {
    safeTrace(trace, "intake.post_status_failed", {
      label,
      error: shortMessage(error),
    });
    return undefined;
  }
}

export async function handleIntakeZip({ client, event, fileInfo } = {}, options = {}) {
  const {
    pendingApprovals,
    runTurn = defaultRunTurn,
    resolveAction = defaultResolveAction,
    proposalCapture,
    botToken = process.env.SLACK_BOT_TOKEN,
    fetchImpl = fetch,
    now = Date.now,
    trace = () => {},
    zip,
    defaultTeamId = process.env.INTAKE_DEFAULT_TEAM_ID || process.env.LINEAR_TEAM_ID,
    defaultProjectId = process.env.INTAKE_DEFAULT_PROJECT_ID || process.env.LINEAR_PROJECT_ID,
  } = options;

  const downloadSlackFile = zip?.downloadSlackFile || defaultDownloadSlackFile;
  const extractZipBuffer = zip?.extractZipBuffer || defaultExtractZipBuffer;

  const requestId = `intake_${Number(now()).toString(36)}`;

  if (!pendingApprovals || typeof pendingApprovals.set !== "function") {
    return {
      requestId,
      error: "pendingApprovals map required",
    };
  }

  const channel = event?.channel_id || event?.channel || fileInfo?.file?.channels?.[0];
  const user = event?.user_id || event?.user || fileInfo?.file?.user;
  const fileName = fileInfo?.file?.name || "";
  const zipMessageTs =
    event?.message_ts ||
    fileInfo?.file?.shares?.public?.[channel]?.[0]?.ts ||
    fileInfo?.file?.shares?.private?.[channel]?.[0]?.ts;

  safeTrace(trace, "intake.start", {
    requestId,
    channel,
    user,
    fileName,
    fileId: event?.file_id,
    zipMessageTs,
  });

  if (!isZipName(fileName)) {
    safeTrace(trace, "intake.skip_not_zip", { requestId, fileName });
    return { requestId, error: "not a zip" };
  }

  if (!channel) {
    return { requestId, error: "missing channel" };
  }

  // 1) Download.
  let buffer;
  try {
    buffer = await downloadSlackFile(client, event?.file_id || fileInfo?.file?.id, {
      fetchImpl,
      botToken,
    });
    safeTrace(trace, "intake.downloaded", {
      requestId,
      bytes: buffer?.length ?? 0,
    });
  } catch (error) {
    safeTrace(trace, "intake.download_failed", {
      requestId,
      error: shortMessage(error),
    });
    await postPlainText(
      client,
      {
        channel,
        thread_ts: zipMessageTs,
        text: `Intake failed to download the zip (\`req: ${requestId}\`).`,
      },
      trace,
      "download_failed",
    );
    return { requestId, error: `download failed: ${shortMessage(error)}` };
  }

  // 2) Extract.
  let extracted;
  try {
    extracted = extractZipBuffer(buffer);
  } catch (error) {
    safeTrace(trace, "intake.extract_failed", {
      requestId,
      error: shortMessage(error),
    });
    await postPlainText(
      client,
      {
        channel,
        thread_ts: zipMessageTs,
        text: `Intake failed to extract the zip (\`req: ${requestId}\`): ${shortMessage(error)}`,
      },
      trace,
      "extract_failed",
    );
    return { requestId, error: `extract failed: ${shortMessage(error)}` };
  }

  const files = Array.isArray(extracted?.files) ? extracted.files : [];
  const skipped = Array.isArray(extracted?.skipped) ? extracted.skipped : [];

  safeTrace(trace, "intake.extracted", {
    requestId,
    files: files.length,
    skipped: skipped.length,
    totalBytes: extracted?.totalBytes,
  });

  if (files.length === 0 && skipped.length === 0) {
    await postPlainText(
      client,
      {
        channel,
        thread_ts: zipMessageTs,
        text: `Intake found no files in the zip (\`req: ${requestId}\`).`,
      },
      trace,
      "empty_zip",
    );
    return { requestId, files: [], skipped: [], proposalCount: 0 };
  }

  // 3) Resolve action + 4) build prompt. The builder drops binary entries
  // (text=null) on its own — no need to pre-filter here.
  const action = resolveAction({ kind: "route", routeKey: "intake" });
  const prompt = buildIntakePrompt({
    zipFilename: fileName,
    files,
    skipped,
    defaultTeamId,
    defaultProjectId,
    channel,
    threadTs: zipMessageTs,
    user,
    requestId,
  });

  safeTrace(trace, "intake.prompt_built", {
    requestId,
    promptBytes: prompt.length,
  });

  // 5) Stash request id, run, harvest. Serialized across concurrent intakes
  // so the process.env handoff into intake_propose_issues stays sound.
  let proposals = [];
  let runError;
  const captureMap = proposalCapture || intakeProposalCapture;

  await withIntakeRunLock(async () => {
    const prevEnv = process.env._PI_INTAKE_REQUEST_ID;
    process.env._PI_INTAKE_REQUEST_ID = requestId;
    try {
      await runTurn({
        surface: "intake_file",
        threadTs: zipMessageTs || channel,
        prompt,
        action,
      });
      proposals = captureMap.get(requestId) || [];
      safeTrace(trace, "intake.run_complete", {
        requestId,
        proposalCount: proposals.length,
      });
    } catch (error) {
      runError = error;
      safeTrace(trace, "intake.run_failed", {
        requestId,
        error: shortMessage(error),
      });
    } finally {
      captureMap.delete(requestId);
      if (prevEnv === undefined) {
        delete process.env._PI_INTAKE_REQUEST_ID;
      } else {
        process.env._PI_INTAKE_REQUEST_ID = prevEnv;
      }
    }
  });

  if (runError) {
    await postPlainText(
      client,
      {
        channel,
        thread_ts: zipMessageTs,
        text: `Pi run failed during intake (\`req: ${requestId}\`): ${shortMessage(runError)}`,
      },
      trace,
      "pi_run_failed",
    );
    return {
      requestId,
      error: `pi run failed: ${shortMessage(runError)}`,
      files,
      skipped,
    };
  }

  // 6) Post parent summary.
  let parentMessageTs;
  try {
    const parentRes = await client.chat.postMessage({
      channel,
      thread_ts: zipMessageTs,
      blocks: buildIntakeSummaryBlocks({
        files,
        skipped,
        proposalCount: proposals.length,
        requestId,
        zipFilename: fileName,
      }),
      text: `Intake: ${files.length} file(s), ${proposals.length} proposal(s) (req: ${requestId})`,
    });
    parentMessageTs = parentRes?.ts;
    safeTrace(trace, "intake.parent_posted", {
      requestId,
      ts: parentMessageTs,
    });
  } catch (error) {
    safeTrace(trace, "intake.parent_post_failed", {
      requestId,
      error: shortMessage(error),
    });
    return {
      requestId,
      error: `parent post failed: ${shortMessage(error)}`,
      files,
      skipped,
      proposalCount: proposals.length,
    };
  }

  // 7) Post per-issue cards + register.
  const cardTs = [];
  const proposalTotal = proposals.length;
  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    const approvalId = nextIntakeApprovalId(requestId);
    let cardMessageTs;
    try {
      const cardRes = await client.chat.postMessage({
        channel,
        thread_ts: zipMessageTs,
        blocks: buildProposalCardBlocks(proposal, {
          approvalId,
          status: "pending",
          proposalIndex: i + 1,
          proposalTotal,
          requestId,
        }),
        text: `Intake proposal ${i + 1} of ${proposalTotal} (req: ${requestId})`,
      });
      cardMessageTs = cardRes?.ts;
      cardTs.push(cardMessageTs);
    } catch (error) {
      safeTrace(trace, "intake.card_post_failed", {
        requestId,
        approvalId,
        index: i + 1,
        error: shortMessage(error),
      });
      // Skip registering this card if we couldn't post it.
      continue;
    }

    try {
      registerProposal(pendingApprovals, {
        approvalId,
        channel,
        threadTs: zipMessageTs,
        parentMessageTs,
        cardMessageTs,
        proposal,
        proposalIndex: i + 1,
        proposalTotal,
        requestId,
      });
      safeTrace(trace, "intake.card_registered", {
        requestId,
        approvalId,
        index: i + 1,
      });
    } catch (error) {
      safeTrace(trace, "intake.card_register_failed", {
        requestId,
        approvalId,
        error: shortMessage(error),
      });
    }
  }

  safeTrace(trace, "intake.done", {
    requestId,
    proposalCount: proposals.length,
    cardCount: cardTs.length,
  });

  return {
    requestId,
    proposalCount: proposals.length,
    posted: { parentTs: parentMessageTs, cardTs },
    files,
    skipped,
  };
}
