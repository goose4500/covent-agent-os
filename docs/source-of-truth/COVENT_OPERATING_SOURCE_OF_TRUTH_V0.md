# Covent OS Source of Truth v0

Status: **Archived historical v0 — non-authoritative where it conflicts with trusted internal speed mode.**
Owner/DRI: **Jake Floyd until reassigned**  
Last updated: **2026-05-10**  
Evidence base: `/home/jfloyd/pi-session-audit/2026-05-05/final-context-pack.md`  
Backup of longer draft: `COVENT_OPERATING_SOURCE_OF_TRUTH_V0.md.bak-20260506-141048`

Archive note: This draft is preserved as evidence of the earlier passive/draft-first operating model. Keep its source-linking, ownership, and human accountability principles, but do not treat its blanket draft-only or approval-before-mutation language as authoritative for trusted internal speed mode. `SECURITY.md` remains authoritative for secrets, private data, and data-as-data handling.

---

## 1. The point

Covent needs a simple operating spine.

The problem is not lack of tools. The problem is that important truth can live in too many places: Slack threads, founder memory, Linear issues, docs, code, analytics, Stripe, Sentry, and agent transcripts.

The operating rule is:

> **Every important signal must become owned, source-linked, actionable Linear truth — or it does not count as company truth.**

Slack creates motion. Pi converts messy context into drafts or route/profile-authorized actions. Linear stores the durable record. GitHub, Stripe, Sentry, analytics, Figma, and Whimsical provide evidence.

---

## 2. First-principles system map

```mermaid
flowchart LR
    Signal["Raw signal<br/>Slack, customer, founder note, bug, metric"] --> Pi["Pi<br/>clarify + draft"]
    Pi --> Route["Declared route/profile<br/>authorized Slack invocation"]
    Route --> Human["Human owner<br/>reviews exceptions"]
    Route --> Linear["Linear<br/>durable truth"]
    Human --> Linear
    Linear --> Work["Execution<br/>code, design, ops, sales"]
    Work --> Evidence["Evidence<br/>GitHub, Stripe, Sentry, analytics, Figma, Whimsical"]
    Evidence --> Linear
    Linear --> Slack["Slack<br/>updates + discussion"]
    Slack --> Signal
```

The loop is good only if it reduces ambiguity and speeds execution. If it creates more process than clarity, it is wrong.

---

## 3. Roles of each system

| System | Job | Not its job |
|---|---|---|
| **Linear** | Source of truth for current work, ownership, specs, decisions, status, acceptance criteria | Casual discussion |
| **Slack** | Fast discussion, intake, notifications, authorized route/profile invocations, agent triggers | Permanent memory |
| **Pi** | Summarize, research, draft, audit, and execute selected route/profile work with declared tools/context | Silent decision-maker outside an invocation |
| **GitHub** | Code, branches, PRs, implementation history | Roadmap |
| **Stripe** | Money truth: customers, subscriptions, revenue, billing events | Product assumptions |
| **Sentry** | Reliability truth: errors, incidents, regressions | Business priority by itself |
| **Analytics** | Behavior truth: usage, funnel, activation, retention | Final interpretation without context |
| **Figma / Whimsical** | Visual explanation and exploration | Operating source of truth |
| **Local/Obsidian docs** | Research, drafts, historical synthesis | Current execution truth unless promoted into Linear |

---

## 4. Current known state

These are facts from the 2026-05-05 Pi audit.

| Area | Current state |
|---|---|
| Linear project | `Distribution` exists under `Frontend Engineering / FE` |
| Distribution URL | `https://linear.app/dispo-genius/project/distribution-9785977025fc` |
| Distribution project ID | `ba9682e2-c14e-4208-98a2-a89f3fb285b8` |
| Current parent issue | `FE-457 — 5-5` |
| Structural issue | `FE-457 / Distribution / Frontend Engineering` does not cleanly describe this work. This is company operating infrastructure, not just frontend distribution. |
| Slack/Pi bridge | Local bridge exists at `/home/jfloyd/.pi/agent/pi-mom/` |
| Slack runner | `/home/jfloyd/sources/run-covent-pi-mom.sh` |
| Slack CLI skill | `/home/jfloyd/.pi/agent/skills/slack-cli/SKILL.md` |
| Linear audit skill | `/home/jfloyd/.pi/agent/skills/linear-subissue-audit/SKILL.md` |
| Known Slack/Pi issue | Slack MCP OAuth worked in a fresh process, but long-running Pi session showed stale `401`; reload/restart and retest. |
| Known Slack CLI trap | Do not run `slack run` from `/home/jfloyd`; run from the real app directory or approved runner. |

---

## 5. The only Linear structure needed right now

Do not over-design the company taxonomy yet.

Use four levels:

```mermaid
flowchart TD
    I["Initiative<br/>strategic outcome"] --> P["Project<br/>time-bound deliverable"]
    P --> Issue["Issue<br/>one accountable unit of work"]
    Issue --> Sub["Subissue<br/>child task only if needed"]
    P --> Doc["Doc<br/>spec, principle, decision record"]
```

Definitions:

| Object | Meaning | Required fields |
|---|---|---|
| **Initiative** | A strategic outcome spanning multiple projects | owner, outcome, why now, success metric |
| **Project** | A bounded deliverable | owner, target state, scope, non-goals |
| **Issue** | The smallest accountable work unit | owner, current state, done state, next action |
| **Subissue** | A necessary child task | parent link, dependency, done state |
| **Doc** | A durable principle/spec/decision | owner, status, source links, decision log |

Proposed parent:

> **Covent OS v0 — Linear × Slack × Pi operating spine**

Current temporary parent:

> **FE-457 — `5-5`**

Decision needed:

> Keep this under FE temporarily, or move/rename into a company-level operating project through an authorized route/profile.

---

## 6. What must be tracked in Linear

### P0 — foundation issues

| Priority | Issue title | Existing mapping | Definition of done |
|---|---|---|---|
| P0 | **Adopt Covent OS Source of Truth v0** | `FE-459` or new | This doc or current derivative is linked in Linear; system roles, issue standard, and first workflow are accepted. |
| P0 | **Clean up FE-457 issue tree** | `FE-457` | Parent has outcome-based title; children have clear titles; `FE-458` is archived or justified; each child has owner/current state/DoD/next action. |
| P0 | **Verify Slack/Pi local foundation** | `FE-460` | Pi reload/restart complete; Slack MCP retested; `pi-mom` start/doctor path documented; correct app directory/runner documented. |
| P0 | **Build trusted Slack thread → Linear workflow** | `FE-463` | Authorized Slack invocation creates or updates Linear through a declared route/profile with source link, audit evidence, and redaction. Archived draft-only variants are non-authoritative safe-mode history. |

### P1 — useful after P0

| Priority | Issue title | Existing mapping | Definition of done |
|---|---|---|---|
| P1 | **Create issue/spec/decision templates** | child of `FE-459` | Templates exist for issue, spec, decision, weekly update, Slack thread promotion. |
| P1 | **Document Covent Pi skills/agents registry** | child of `FE-463` | One doc lists relevant skills, paths, use cases, boundaries, and limitations. |
| P1 | **Harden `pi-mom`** | child of `FE-460` | Queue/lock, timeout, progress, failure, logging, idempotency behavior are defined or implemented. |
| P1 | **Reconcile Slack manifest with code** | child of `FE-460` | Scopes and slash commands match actual MVP behavior; archived safe-mode scope-reduction advice is non-authoritative where trusted internal speed mode intentionally grants approved internal scopes. |
| P1 | **Define Linear ↔ Slack cadence** | new | Rules exist for when Slack discussion becomes Linear truth and how status flows back to Slack. |

### P2 — defer until the loop works

| Priority | Issue title | Existing mapping | Reason to defer |
|---|---|---|---|
| P2 | **Revenue + reliability brief** | new | Valuable, but only after Linear/Slack/Pi loop is trusted. |
| P2 | **Identity spine across app/Stripe/Sentry/analytics** | new | Strategic, but not needed to prove first operating loop. |
| P2 | **Whimsical/visual artifact decision** | `FE-461` | Visuals support truth; they do not define it. |
| P2 | **Browser/Panda automation layer** | `FE-462` | Only useful if a concrete browser workflow exists. |
| P2 | **GitHub PR concierge pilot** | new | Useful after issue packets are consistently high quality. |

---

## 7. First workflow to prove

This is the MVP. Everything else is secondary.

```mermaid
sequenceDiagram
    participant S as Slack
    participant P as Pi
    participant H as Human owner
    participant L as Linear

    S->>P: Thread/message selected
    P->>P: Summarize context + extract decision/action
    S->>P: Authorized route/profile invocation
    P->>L: Write route/profile-approved issue/comment/update
    P->>H: Ask only for exceptions outside profile
    L-->>S: Link back to durable Linear record
```

Rules:

1. Trusted internal speed mode is route/profile-authorized, not passive ambient automation.
2. Authorized Slack invocation is approval for the selected route/profile and its declared Linear/Slack/Git/docs mutations.
3. Every durable action includes source link, owner suggestion where useful, acceptance criteria/open questions where useful, and audit evidence.
4. If Pi is uncertain or the action falls outside the selected route/profile, it asks instead of inventing.
5. Archived draft-only/approval-before-write variants are safe-mode history, not the current default.
6. Success is measured by less ambiguity and faster execution, not more process.

---

## 8. Issue standard

Every active Linear issue should answer seven questions.

```mermaid
flowchart TD
    A["Issue"] --> B["Why does this matter?"]
    A --> C["Who owns it?"]
    A --> D["What is true now?"]
    A --> E["What must be true when done?"]
    A --> F["What is the next physical action?"]
    A --> G["What evidence/source links matter?"]
    A --> H["What is out of scope?"]
```

Template:

```md
## Why this matters

## Owner / DRI

## Current state

## Done state

## Next physical action

## Source links

## Out of scope
```

An issue is not ready if the next physical action is unclear.

---

## 9. Operating rules

1. **Linear is truth. Slack is motion. Pi is leverage.**
2. **One owner per important item.** No owner means no accountability.
3. **No source link, weak truth.** Link back to Slack, GitHub, Stripe, Sentry, analytics, Figma, Whimsical, or prior doc evidence.
4. **Invocation before mutate.** Authorized Slack invocation approves declared route/profile writes; ask again only for outside-profile, destructive, secret-bearing, or ambiguous actions. Draft-before-mutate is archived safe-mode guidance, not the current default.
5. **Do not automate ambiguity.** Clean the manual loop before scaling automations.
6. **Do not restructure Linear until the new structure is agreed.** Rename/clean the current tree first.
7. **Visuals explain. Linear decides.** Diagrams are supporting artifacts, not the durable record.
8. **Metrics inform. Owners decide.** Stripe/Sentry/analytics provide facts; Linear records the decision/action.

---

## 10. What not to do yet

Do not do these until P0 is complete:

- build many Slack automations;
- broadly restructure Linear;
- make Slack the memory layer;
- add AI app surfaces without route/profile policy, audit, redaction, and kill switches;
- create dashboards without knowing which decisions they improve;
- pursue browser automation without a concrete workflow;
- let diagrams become the operating record;
- let Pi silently update external systems without an authorized invocation and route/profile audit trail.

---

## 11. Success metrics

The system is working when:

| Metric | Direction |
|---|---|
| Time from Slack discussion to Linear artifact | Down |
| Decisions living only in Slack/founder memory | Down |
| Active issues with owner + done state + next action | Up |
| Stale/ambiguous Linear issues | Down |
| Repeated context re-explanation | Down |
| Engineering rework from unclear specs | Down |
| Agent actions with source links, route/profile authorization, and audit trail | Up |

---

## 12. Immediate sequence

```mermaid
flowchart LR
    A["1. Adopt speed-mode policy"] --> B["2. Update Linear parent"]
    B --> C["3. Clean P0 child issues"]
    C --> D["4. Verify Slack/Pi foundation"]
    D --> E["5. Trusted route/profile workflow"]
    E --> F["6. Build one workflow"]
    F --> G["7. Review and simplify"]
```

Next actions:

1. Review this document and mark anything false or too heavy.
2. Promote the current speed-mode policy into Linear as the operating source of truth.
3. Rename `FE-457 — 5-5` to the real outcome or create a new parent and link the old tree.
4. Clean child issues: `FE-459`, `FE-460`, `FE-463`, `FE-461`, `FE-462`; archive or justify `FE-458`.
5. Verify Slack/Pi foundation.
6. Write the trusted Slack invocation → Linear workflow spec.
7. Build only that workflow.

---

## 13. North star

Covent should become a company where important context does not decay.

A signal enters Slack, product usage, customer conversation, Stripe, Sentry, GitHub, or founder thinking. An authorized Slack route/profile invocation lets Pi clarify or act. Linear preserves it. The team executes from it.

That is the operating system.
