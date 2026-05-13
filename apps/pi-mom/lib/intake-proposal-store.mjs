// PRD-intake proposal lifecycle on top of the shared `pendingApprovals` Map.
// The Map's `set`/`delete` wrappers in index.mjs re-publish the App Home
// view, so every helper here also keeps the cockpit in sync.

const DEFAULT_CLAIM_TTL_MS = 60_000;

export const INTAKE_STATUS = Object.freeze({
  PENDING: "pending",
  CLAIMED: "claimed",
  APPROVED: "approved",
  CANCELED: "canceled",
  EDITED: "edited",
});

const FINALIZED_STATUSES = new Set([
  INTAKE_STATUS.APPROVED,
  INTAKE_STATUS.CANCELED,
  INTAKE_STATUS.EDITED,
]);

export function isFinalized(entry) {
  return Boolean(entry && FINALIZED_STATUSES.has(entry.status));
}

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
    status: INTAKE_STATUS.PENDING,
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
export function claim(
  pendingApprovals,
  approvalId,
  userId,
  { now = Date.now(), claimTtlMs = DEFAULT_CLAIM_TTL_MS } = {},
) {
  const entry = getProposal(pendingApprovals, approvalId);
  if (!entry) return { ok: false, reason: "missing" };
  if (isFinalized(entry)) {
    return { ok: false, reason: "finalized", status: entry.status };
  }
  if (entry.claimedBy && entry.claimedBy !== userId && (now - (entry.claimedAt || 0)) < claimTtlMs) {
    return { ok: false, reason: "claimed", claimedBy: entry.claimedBy, ageMs: now - entry.claimedAt };
  }
  entry.claimedBy = userId;
  entry.claimedAt = now;
  entry.status = INTAKE_STATUS.CLAIMED;
  return { ok: true, entry };
}

export function release(pendingApprovals, approvalId) {
  const entry = getProposal(pendingApprovals, approvalId);
  if (!entry) return false;
  entry.claimedBy = undefined;
  entry.claimedAt = undefined;
  if (entry.status === INTAKE_STATUS.CLAIMED) entry.status = INTAKE_STATUS.PENDING;
  return true;
}

export function markStatus(pendingApprovals, approvalId, status, extras = {}) {
  const entry = getProposal(pendingApprovals, approvalId);
  if (!entry) return undefined;
  entry.status = status;
  for (const [k, v] of Object.entries(extras)) entry[k] = v;
  return entry;
}

export function finalize(pendingApprovals, approvalId) {
  return pendingApprovals.delete(approvalId);
}
