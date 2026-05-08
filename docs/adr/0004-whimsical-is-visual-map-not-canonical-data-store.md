# ADR 0004: Whimsical is the visual map, not the canonical data store

Date: 2026-05-08  
Status: accepted  
Related: FE-531

## Context

Whimsical is useful for helping humans and agents see the system quickly: operating loops, runtime boundaries, data flows, and code maps. But visual boards can drift and are harder to diff/review than repo docs.

## Decision

Use one Whimsical board as the visual navigation layer for the Covent Agent OS Slack/Pi/Linear system. The board should link back to `docs/SYSTEM_INDEX.md`; repo docs remain canonical.

## Consequences

- Whimsical diagrams should visualize repo docs, not replace them.
- If a decision changes, update the repo doc/ADR first, then update the board.
- Future agents can use the board for orientation but must verify behavior against code and canonical docs.
