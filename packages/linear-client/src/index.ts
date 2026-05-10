// @covent/linear-client — public entrypoint.
//
// Re-exports the (currently stubbed) module surface described in the PRD
// (docs/source-of-truth/LINEAR_INTEGRATION_PRD.md → "What we build").
// W-A fills in the implementations. Stubs throw "not implemented".

export * from "./client.ts";
export * from "./issues.ts";
export * from "./comments.ts";
export * from "./attachments.ts";
export * from "./workflow-states.ts";
export * from "./webhooks.ts";
export * from "./pagination.ts";
export * from "./rate-limit.ts";
export * from "./identifiers.ts";
export * from "./errors.ts";
export * from "./trace.ts";
