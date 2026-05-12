# PR #5 audit — private DM agent loop route

## Recommendation

**Rework before landing.** The UX is directionally useful and the diff is small enough for an MVP, but the current implementation widens the Slack surface area more than the feature flag implies and overstates the “continuous private agent loop” behavior.

## What PR #5 adds

- `private:` route plus natural-language triggers on `app_mention`.
- Opens a 1:1 DM with `conversations.open`, posts an ephemeral channel/thread redirect notice, then sends/streams the Pi answer to the DM.
- Allows `D…` channels through `isAllowedChannel`, enabling the existing `message.im` handler when `SLACK_ALLOWED_CHANNEL_ID` is set.
- Smoke script for `conversations.open` + DM post + threaded DM follow-up.
- Docs/env knob: `PI_MOM_PRIVATE_ROUTE_ENABLED=true` by default.

GitHub metadata: PR is open, mergeable to `main`, checks passing, 1 commit (`20fe816`).

## Blocking issues

1. **Disable knob does not disable direct-DM Pi access.**
   - `isAllowedChannel()` allows every `D…` channel unconditionally.
   - If `PI_MOM_PRIVATE_ROUTE_ENABLED=false`, explicit `private:` requests are blocked, but plain DMs still bypass `SLACK_ALLOWED_CHANNEL_ID` and invoke Pi.
   - This violates the stated feature flag and turns the public-channel allowlist into “allowed channel plus every workspace DM.”

2. **Default-on DM bypass is a privacy/safety policy change, not just a route.**
   - In `PI_MOM_MODE=pi`, any workspace user who can DM the bot can use the local Pi bridge unless another Slack/app policy blocks them.
   - For a POC, this should be explicit opt-in or scoped by user allowlist / allowed-channel membership.

3. **“Continuous private agent loop” is misleading.**
   - Direct DM top-level messages are handled independently; `getThreadContext()` only reads the current message’s thread/root. Normal Slack DM chat history is not included unless the user replies in the same Slack thread.
   - Either implement recent DM history/context windows or document this as stateless DM Q&A plus threaded continuity.

4. **Natural-language trigger is too broad.**
   - The regex matches bare `privately` and negated phrases like “don’t reply privately,” causing surprising private redirects.
   - MVP should only accept explicit low-ambiguity triggers: `private:`, `dm me`, `reply in dm`, `take this private`.

## MVP path

- Keep `private:` route and one or two explicit triggers only.
- Make `PI_MOM_PRIVATE_ROUTE_ENABLED=false` fully disable both redirected private route and `message.im` processing / DM allowlist bypass.
- Prefer default-off for production/Railway examples until there is a user/channel policy decision.
- Add optional `PI_MOM_ALLOWED_DM_USER_IDS=U1,U2` or require source mention to originate in the allowed channel before opening a DM.
- Document that public thread context may be copied into the requester’s DM; only output is private.
- Treat direct DM as stateless unless/until recent DM history is deliberately engineered.

## Safety/privacy risks

- Hidden output: channel participants see only an ephemeral redirect notice to the requester; others do not know a private answer was produced.
- Context movement: public/private-channel thread content is copied into a 1:1 DM. This is usually acceptable for the requester, but should be made explicit.
- Surface expansion: DM bypass weakens `SLACK_ALLOWED_CHANNEL_ID` as the primary guardrail.
- Auditability: private answers are less visible for team review; request IDs help, but logs should not contain sensitive text.

## Validation needed

- Unit-test parser cases, especially negation and false positives.
- Assert `PI_MOM_PRIVATE_ROUTE_ENABLED=false` blocks direct DMs and redirected route.
- Smoke test in Slack: allowed-channel mention → ephemeral ack → DM anchor/thread → streamed reply.
- Smoke test unauthorized/disabled cases.
- Confirm `chatStream` works against `D…` channels with current Slack SDK/scopes.
- Confirm direct DM context behavior and update docs accordingly.

## Conflicts / integration risk

- **Agent Run Card:** PR #5 is based on `main` without current Agent Run Card work. It touches the same `ROUTES`, env docs, README help/status, and `handleRequest` control flow. If Agent Run Card lands first, this PR needs rebase/integration rather than blind merge.
- **Modularity refactor:** The PR adds another large feature directly into monolithic `index.mjs`, conflicting with the route-registry/adapters direction on `origin/claude/refactor-app-modularity-FcmE5`. Private DM should become a route handler with clear policy gates, not more branching in `handleRequest`.

## Land/close/rework

**Rework.** Do not close: the product direction is good. Do not land as-is: the allowlist/feature-flag semantics and DM context claims are unsafe/confusing for Slack agent UX.
