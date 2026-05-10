import { ROUTES as BASE_ROUTES } from "../domain/routes.mjs";
import { createImageRoute } from "./image.mjs";
import { createLinearPostProcess } from "./linear.mjs";

/**
 * Build the enriched route registry. The base ROUTES table holds only data
 * (label + instruction) and is what command parsing reads. This adds the
 * dispatch hooks:
 *
 *   - handle(ctx):      full override of the default pi flow (used by `image:`)
 *   - postProcess(ctx, result): runs after the default pi reply (used by `linear:`)
 *
 * Adding a new route with custom behavior is a single new file in this dir
 * plus one entry here. The orchestrator in index.mjs stays untouched.
 */
export function createRoutes(deps) {
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
