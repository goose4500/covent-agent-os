// @covent/linear-client — public entrypoint.
//
// Re-exports the (currently stubbed) module surface described in the PRD
// (docs/source-of-truth/LINEAR_INTEGRATION_PRD.md → "What we build").
// W-A fills in the implementations. Stubs throw "not implemented".

export * from "./client.js";
export * from "./issues.js";
export * from "./comments.js";
export * from "./attachments.js";
export * from "./workflow-states.js";
export * from "./webhooks.js";
export * from "./pagination.js";
export * from "./rate-limit.js";
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./trace.js";
