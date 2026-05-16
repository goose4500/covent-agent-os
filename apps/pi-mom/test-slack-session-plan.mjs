import assert from "node:assert/strict";
import {
  DEFAULT_SLACK_SESSION_PLAN_TITLE,
  buildSlackSessionPlanTitle,
} from "./lib/slack-session-plan.mjs";

{
  assert.equal(
    buildSlackSessionPlanTitle({ env: {} }),
    DEFAULT_SLACK_SESSION_PLAN_TITLE,
    "Pi sessions default into a stable Slack plan/card title",
  );
}

{
  assert.equal(
    buildSlackSessionPlanTitle({ env: { PI_MOM_PLAN_TITLE: "  Covent Pi · Live run  " } }),
    "Covent Pi · Live run",
    "operators can override the card title via env without code changes",
  );
}

{
  assert.equal(
    buildSlackSessionPlanTitle({ env: { PI_MOM_PLAN_TITLE: "   " } }),
    DEFAULT_SLACK_SESSION_PLAN_TITLE,
    "blank overrides fall back to the default plan/card title",
  );
}

console.log("ok slack-session-plan");
