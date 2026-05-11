// Maps action.handler strings (declared in agent.yaml) to the in-process
// dispatch shape that handleRequest() in index.mjs consumes today.
//
// This registry is intentionally thin during the migration: each entry tells
// the legacy dispatcher which routeKey to use and whether the route requires
// a Slack thread. As we extract Linear orchestration into its own module in
// follow-up commits, entries will grow into real callables.

export const handlerRegistry = Object.freeze({
  linearFromThread: Object.freeze({
    routeKey: "linear",
    requiresThread: true,
  }),
});

export function describeHandler(name) {
  if (!name) return undefined;
  return handlerRegistry[name];
}
