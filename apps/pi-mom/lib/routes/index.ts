import { ROUTES as BASE_ROUTES, type RouteData } from "../domain/routes.ts";
import { createImageRoute } from "./image.ts";
import { createLinearPostProcess } from "./linear.ts";
import type { Config } from "../config.ts";
import type { Trace } from "../trace.ts";
import type { createSlackAdapter } from "../adapters/slack.ts";
import type { createLinearAdapter } from "../adapters/linear.ts";

export type SlackAdapter = ReturnType<typeof createSlackAdapter>;
export type LinearAdapter = ReturnType<typeof createLinearAdapter>;

export type RouteCtx = {
  client: any;
  event: any;
  channel: string;
  threadTs: string;
  user: string;
  text: string;
  requestId: string;
  start: number;
  mode: string;
  routeKey?: string;
  route?: RouteData;
};

export type EnrichedRoute = RouteData & {
  handle?: (ctx: RouteCtx) => Promise<void>;
  postProcess?: (ctx: RouteCtx & { result: string }) => Promise<void>;
};

export type RouteDeps = {
  config: Config;
  trace: Trace;
  slack: SlackAdapter;
  linear: LinearAdapter;
};

/**
 * Build the enriched route registry. The base ROUTES table holds only data
 * (label + instruction) and is what command parsing reads. This adds the
 * dispatch hooks:
 *
 *   - handle(ctx):      full override of the default pi flow (used by `image:`)
 *   - postProcess(ctx, result): runs after the default pi reply (used by `linear:`)
 *
 * Adding a new route with custom behavior is a single new file in this dir
 * plus one entry here. The orchestrator in index.ts stays untouched.
 */
export function createRoutes(deps: RouteDeps): Record<string, EnrichedRoute> {
  return {
    ...BASE_ROUTES,
    image: {
      ...BASE_ROUTES.image,
      handle: createImageRoute(deps),
    },
    linear: {
      ...BASE_ROUTES.linear,
      postProcess: createLinearPostProcess(deps),
    },
  };
}
