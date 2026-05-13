// Light wrapper around the global `pendingApprovals` Map (declared in
// apps/pi-mom/index.mjs) for the PRD-intake proposal flow. Each entry has
// shape:
//
//   {
//     type: "intake_proposal",
//     approvalId,
//     channel,
//     threadTs,           // root ts of the Slack thread (the zip's message ts)
//     parentMessageTs,    // ts of the orchestrator's summary post
//     cardMessageTs,      // ts of the per-issue card we'll later edit on Approve/Cancel
//     proposal,           // IntakeProposal from extensions/intake-tools.ts
//     proposalIndex,      // 1-based
//     proposalTotal,
//     requestId,
//     status,             // "pending" | "approved" | "canceled" | "edited" | "claimed"
//     claimedBy,          // userId of the person mid-action (Edit modal open)
//     claimedAt,          // ms epoch
//     title,              // for App Home cockpit (home-view.mjs reads `title` and `type`)
//   }
//
// Because the `pendingApprovals.set` / `.delete` wrappers in index.mjs already
// re-publish the App Home view, every helper here triggers a cockpit refresh
// for free.

const CLAIM_TTL_MS = 60_000;

let _approvalCounter = 0;
export function nextIntakeApprovalId(requestId) {
  _approvalCounter += 1;
  return `intake_${requestId}_${_approvalCounter}_${Date.now().toString(36)}`;
}

export function _resetIntakeApprovalCounterForTests() {
  _approvalCounter = 0;
}

export function registerProposal(pendingApprovals, entry) {
  if (!entry?.approvalId) throw new Error("registerProposal: approvalId required");
  const stored = {
    type: "intake_proposal",
    status: "pending",
    title: entry.proposal?.title ? `Intake proposal — ${entry.proposal.title}` : "Intake proposal",
    ...entry,
  };
  pendingApprovals.set(entry.approvalId, stored);
  return stored;
}

export function getProposal(pendingApprovals, approvalId) {
  const entry = pendingApprovals.get(approvalId);
  if (!entry || entry.type !== "intake_proposal") return undefined;
  return entry;
}

// Soft lock for the edit modal flow. Returns:
//   { ok: true, entry }                                  → caller may proceed
//   { ok: false, reason: "missing" }                     → no such approval
//   { ok: false, reason: "finalized" }                   → already approved/canceled
//   { ok: false, reason: "claimed", claimedBy, ageMs }   → someone else is editing
export function claim(pendingApprovals, approvalId, userId, { now = Date.now() } = {}) {
  const entry = getProposal(pendingApprovals, approvalId);
  if (!entry) return { ok: false, reason: "missing" };
  if (entry.status === "approved" || entry.status === "canceled" || entry.status === "edited") {
    return { ok: false, reason: "finalized", status: entry.status };
  }
  if (entry.claimedBy && entry.claimedBy !== userId && (now - (entry.claimedAt || 0)) < CLAIM_TTL_MS) {
    return { ok: false, reason: "claimed", claimedBy: entry.claimedBy, ageMs: now - entry.claimedAt };
  }
  entry.claimedBy = userId;
  entry.claimedAt = now;
  entry.status = "claimed";
  return { ok: true, entry };
}

export function release(pendingApprovals, approvalId) {
  const entry = getProposal(pendingApprovals, approvalId);
  if (!entry) return false;
  entry.claimedBy = undefined;
  entry.claimedAt = undefined;
  if (entry.status === "claimed") entry.status = "pending";
  return true;
}

export function markStatus(pendingApprovals, approvalId, status, extras = {}) {
  const entry = getProposal(pendingApprovals, approvalId);
  if (!entry) return undefined;
  entry.status = status;
  for (const [k, v] of Object.entries(extras)) entry[k] = v;
  return entry;
}

// Finalize → delete the pending entry (which triggers App Home re-publish via
// the wrapped pendingApprovals.delete in index.mjs).
export function finalize(pendingApprovals, approvalId) {
  return pendingApprovals.delete(approvalId);
}

export const _CLAIM_TTL_MS_FOR_TESTS = CLAIM_TTL_MS;
