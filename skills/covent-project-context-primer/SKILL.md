---
name: covent-project-context-primer
description: Concise Covent project context primer for starting sessions around getcovent.com, DispoGenius/Covent, covent-frontend, UX/UI review, positioning, pricing, onboarding, SEO/resources, buyer-data workflows, and V2 launch planning. Use this skill at the start of any Covent-related session so the assistant anchors on the product, customer, strategy, and current UX/business constraints before giving recommendations or editing code/content.
---

# Covent Project Context Primer

Use this as the starting mental model for Covent work. Keep outputs concise, practical, and grounded in first principles.

## Company / product context

- Covent is the V2 evolution of DispoGenius.
- V1 was built on GoHighLevel; V2 moves onto custom infrastructure, custom UI, custom data pipelines, and proprietary buyer-data systems.
- The product serves real estate wholesalers, especially the disposition side: finding buyers, understanding buyer behavior, marketing deals, and managing buyer relationships.
- Core customer job: “I have/need a deal moved; show me real active buyers fast.”
- Avoid framing Covent as generic CRM or generic AI software; the strongest wedge is buyer intelligence + deal distribution.

## Strategic moat

- The proprietary data layer is the likely moat.
- Covent can scrape, aggregate, clean, dedupe, and serve its own real-estate buyer data instead of depending fully on third-party data aggregators.
- This enables fresher data, lower marginal data cost, free lead magnets, usage-based pricing, API access, and stronger enterprise positioning.
- Freshness matters: competitors may update every 3/6/12 months; Covent should emphasize direct-source, frequently refreshed buyer intelligence.
- Data should be positioned as practical truth: who bought, where, when, for how much, what type of buyer they are, and how to contact them.

## Customer / market assumptions

- Wholesalers are often cash-flow constrained and price-sensitive.
- Wholesaling has slow cash conversion; deals can take months to pay out.
- Churn risk is structurally high unless users reach value quickly.
- Small operators may adopt Covent as CRM + buyer list + deal marketing workflow.
- Larger operators likely keep Salesforce/HubSpot/internal systems; for them Covent should be data/API/integration layer.

## Current funnel context

- Existing funnel appears to convert despite weak UX/marketing: roughly two organic free trials/day, ~$646/mo price, zero paid CAC, meaningful trial-to-paid conversion.
- The 14-day free trial is doing major conversion work.
- Current marketing/video assets are under-polished and likely under-articulate the pain in the customer’s language.
- Organic SEO/resources already drive signups, but visible resource UX can hurt trust if it looks mass-produced or flat.

## UX first principles

- Optimize for fastest possible time-to-value.
- The ideal first value moment: enter a market/deal → see active buyer intelligence → sign up to unlock details.
- Reduce cognitive load aggressively: fewer buttons, fewer detours, fewer repeated blocks, clearer hierarchy.
- Public pricing can exist, but should not interrupt the primary free-trial/value-preview flow.
- Prefer contextual sign-up modal after value preview over sending users through pricing and multiple URLs.
- Main CTA should feel like action, not navigation.

## Messaging principles

- Speak in wholesaler language: find active buyers, move deals, stop texting dead lists, know who is actually buying, get to the right buyer faster.
- Lead with outcomes, not feature categories.
- Strong framing examples:
  - “Find active cash buyers for your deal in seconds.”
  - “See who bought nearby, what they paid, and how to reach them.”
  - “Fresh buyer data for dispo teams — not stale exported lists.”
- Treat AI as support, not the headline, unless tied directly to deal marketing or buyer matching.

## Pricing / packaging context

- Be careful lowering price from $646/mo to cheap tiers; it can damage perceived value and upset existing customers.
- A $100/$300/$600 tier structure may undercut the product if the data moat is real.
- Usage-based pricing may fit buyer-data access better than arbitrary search limits.
- Likely split: subscription/CRM for small teams; usage/API/data access for larger teams.
- Existing customers may need grandfathering, migration logic, or explicit value framing before V2 pricing changes.

## Website / content review heuristics

- Reviews/social proof should be easy to scan and visually prioritized.
- Feature/resource pages should not all look identical; repeated layouts blur meaning.
- SEO pages can be indexable without all being prominent in main navigation.
- Organize resources by user intent, not by whatever content exists.
- Watch for excessive whitespace, weak section hierarchy, cluttered footers, and navigation that makes pages feel indistinguishable.

## When working in repo/code

- Before edits, inspect nearby files and existing conventions.
- Keep changes small, launchable, and tied to conversion/onboarding/value-preview goals.
- If working on analytics, also consider the `covent-analytics` skill.
- Do not invent infrastructure or hosting assumptions unless confirmed by repo/docs/user.

## Default output style

- Use concise bullets.
- Separate strategic diagnosis from concrete next actions.
- Prioritize highest-leverage fixes over exhaustive redesign.
- When uncertain, name the assumption and recommend the smallest validation step.
