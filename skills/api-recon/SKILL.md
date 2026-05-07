---
name: api-recon
description: 
---


# API Reconnaissance Skill

**Follow the product surface first, the browser second, the HTTP contract third, and only use fuzzing when confirmed flows stop yielding signal.**

Maps undocumented internal APIs by following the product's actual UI flows — not by guessing endpoint names. Every data field you want already has a UI screen that loads it. Find that screen, intercept the network call, and you have your endpoint — along with its exact request shape and full response schema.

## References

**Core — read these before starting:**
- **`references/product-model-analysis.md`** — How to read a SaaS product's pricing/docs to map UI flows and auth tiers before touching the API
- **`references/browser-recon-protocol.md`** — Chrome DevTools MCP command sequences and JS snippets for XHR interception, JS bundle analysis, auth state inspection
- **`references/deliverables.md`** — Required output artifacts for every recon project: `api_map.md`, `request_contracts/`, `field_inventory.csv`, `status_matrix.csv`, `next_probe_plan.md`, `open_questions.md`
- **`references/request-contract-template.md`** — Standard artifact shape for documenting every confirmed endpoint

**Decision spine — consult when deciding what to do next:**
- **`references/escalation-rules.md`** — When to stay in the browser, when to promote to HTTP, when to require auth, when to stop probing, when to fuzz, when the target isn't worth deeper effort.

**Secondary — consult when building the scraper:**
- **`references/waf-and-rate-limits.md`** — WAF bypass patterns, safe concurrency rates, TLS fingerprint techniques, backoff strategies. Relevant once you're writing the actual scraper, not during recon.

## Core Approach

1. **Understand the product model first** — what does each subscription tier unlock? What UI screens exist? What data does each screen display?
2. **Navigate those exact screens with a real browser** — intercept the actual XHR/fetch calls. No guessing required.
3. **Document each confirmed endpoint as a request contract** — full URL, params, response schema, auth requirement.
4. **Escalate auth tiers** — map what's public, what needs a free account, what needs a paid tier.

Fuzzing is useful only as a **last pass** when confirmed flows stop yielding signal.

---

## Phase 1: Product Model Analysis (do this first, before any API calls)

Read the target's marketing site, pricing page, and any public documentation. Extract:

1. **Feature inventory** — what does each screen/section display? (e.g., "Buyers list shows buyer name, score, verification status, contact info")
2. **Auth tier map** — free vs paid vs premium. What does each tier unlock?
3. **High-value UI flows** — rank screens by data value. The screen with contact info or the most granular data is your #1 target.
4. **Shared account patterns** — some platforms sell shared subscriptions (one account, multiple users). This affects deduplication strategy.

**Output of this phase:** A ranked list of UI flows to intercept, ordered by data value.

See `references/product-model-analysis.md` for the full analysis framework.

---

## Phase 2: Browser-First Recon (Chrome DevTools MCP)

Read `references/browser-recon-protocol.md` for exact commands. The high-level flow:

1. Open a browser page via `mcp__chrome-devtools__new_page`
2. Navigate each high-value UI flow in order
3. After every navigation, `mcp__chrome-devtools__list_network_requests` — capture every XHR/fetch call
4. Use `mcp__chrome-devtools__evaluate_script` to probe the JS bundle for route/API patterns
5. Test unauthenticated vs authenticated behavior on the same flows

**Key JS snippets to run** (see reference for full list):
- XHR interception from browser context (`fetch()` calls inside the page)
- JS bundle API pattern extraction
- localStorage/sessionStorage/cookie inspection for auth tokens
- Framework state inspection (`window.__NUXT__`, `window.__INITIAL_STATE__`, `data-page`)

**Auth escalation during browser recon:**
- Test each page unauthenticated first — note what 401s or redirects
- Log in with any available credentials, repeat the same flows
- Note exactly which endpoints change behavior with auth

---

## Phase 3: Parallel Subagent Recon Team

Once you have confirmed working endpoints from Phase 2, split into parallel agents:

```
Agent A — Bulk/List Endpoint Mapper
  Goal: Map all columns/fields in list/bulk endpoints
  Tests: every query param combination, pagination, filtering
  Outputs: full column map, unique value counts, filtering capabilities

Agent B — Per-Item Schema Deep Dive
  Goal: Map the complete response schema for individual item endpoints
  Tests: all `with=` / `include=` / `expand=` / `embed=` param combinations
  Tests: 5-10 different item IDs to understand field variance
  Outputs: full field map with types, hit rates, example values, nested object schemas

Agent C — Endpoint Variation Discovery
  Goal: Find endpoints not surfaced by Phase 2 browser recon
  Method: walk path levels upward from known working endpoints
  Method: try sub-resources under confirmed endpoints ({id}/contact, {id}/analytics, etc.)
  Method: test HTTP methods (POST/PUT/DELETE/OPTIONS) on confirmed endpoints
  Outputs: status code table, any new 200 responses with field maps
```

Run all three in a single message for maximum parallelism. Give each agent the WAF bypass pattern from `references/waf-and-rate-limits.md`.

---

## Phase 4: Authentication Escalation

Map what each auth tier unlocks:

| Step | Method | What to test |
|---|---|---|
| Unauthenticated | Plain HTTP | What's fully public? |
| Free account (buyer/viewer role) | Login with free credentials | What does basic auth unlock? |
| Free account (seller/creator role) | Register as content creator | Different permission scope? |
| Paid account | Use client credentials if available | What's behind the paywall? |
| Premium/God Mode | Highest tier | Full data access? |

For each auth tier: run the same endpoint set and compare responses. Note which fields appear/disappear, which status codes change from 401/403 to 200.

**Subscription manifest pattern:** Many platforms return the user's full feature entitlement on the `/auth/user` or `/me` endpoint as a `subscriptions` array. This is the fastest way to understand the full permission model — read the slugs and their `is_active` states.

---

## Phase 5: Contact & Data Extraction Strategy

After mapping the API, determine the optimal extraction path for your target data:

**Direct fields** — data returned in structured API fields (name, company, ID). Always prefer these.

**Embedded free-text** — contact info (email, phone) buried in description/notes fields as HTML. Requires HTML stripping then regex. See hit rate notes below.

**Enrichment waterfall** — when direct extraction doesn't yield contact info, enrich using:
1. Apollo `search_people` (name + company) — best for corporate contacts
2. Hunter domain search — low yield for SMB/solo operators
3. TracerFi reverse phone append — **highest yield for phone-rich, email-poor datasets** (wholesalers, contractors, local service businesses)
4. Crawl4AI website scrape — for businesses with a web presence

**Deduplication strategy:**
- If platform has shared accounts (one subscription, many users), deduplicate by **individual user ID**, not account ID
- Check whether the individual user ID is exposed in the bulk endpoint or only in per-item calls — this determines whether you need full per-item scraping or can optimize to account-level

---

## Phase 6: Fuzzer Pass (only if phases 2-4 are exhausted)

The fuzzer is a last resort, not a starting point. Run it only after the product-model approach is complete. See `scripts/endpoint_fuzzer.py` — it walks every path level upward from a known endpoint and tests common resource names.

Configure it with:
- `BASE_URL` — target domain
- `KNOWN_PATH` — your deepest confirmed working path
- `CONCURRENCY` — start at 3, increase only if no WAF triggers
- `HEADERS` — matching the browser's request headers

The fuzzer's most valuable output is not 200s — it's 405s (Method Not Allowed) and 422s (Unprocessable Entity), which confirm a route exists even if the specific call is wrong.

---

## Output: Reconnaissance Report

Structure your final output as:

```markdown
## [Target] API Reconnaissance Report

### Confirmed Endpoints (by auth tier)
Table: endpoint | method | auth required | returns | notable fields

### Field Schema (per key endpoint)
Full field map with types, hit rates, example values

### Auth Tier Map
What each tier unlocks, subscription slugs if found

### Contact/Data Extraction Strategy
Ranked extraction paths with expected hit rates

### WAF / Rate Limit Notes
Safe concurrency, headers required, bypass method

### Dead Ends
Endpoints that return 404 — saves future effort

### Recommended Next Steps
What auth credentials would unlock next, what enrichment is needed
```

Save to Obsidian at `07_Solutions/pipelines/[target]-api-reconnaissance.md`.
