---
name: single-file-html-app
description: Build self-contained single-file HTML apps that run locally without a build step or dev server.
---


# Single-File HTML App

## Why this skill exists

The ULTRATHINK explorer (2026-04-18) was a real delivered artifact Jake wanted. V1 shipped with "a ton of things messed up" because Claude reached for exotic CSS/font primitives that fail silently under `file://` serving. V2 worked after stripping everything load-bearing down to conservative web tech. This skill codifies that lesson so it never happens again.

**Core constraint:** These files are opened from local disk, usually via `wslview <path>` → Windows Chrome. No CDN proxy, no build step, no webpack, no Tailwind CLI. Whatever CSS or JS feature the user's browser doesn't render perfectly at paint time becomes a visible defect.

**Design philosophy:** Pick a committed aesthetic direction and execute it with conservative primitives. Elegance comes from restraint + precision, not exotic CSS.

---

## The 10 Hardening Principles

These are not suggestions. Each principle exists because violating it broke a real shipped artifact.

### 1. Font chains are 3-deep minimum

Every `font-family` declaration must have a fallback that works with zero network:

```css
/* GOOD */
--ff-display: 'Fraunces', Georgia, 'Times New Roman', serif;
--ff-body: 'Inter', -apple-system, 'Segoe UI', sans-serif;
--ff-mono: 'JetBrains Mono', 'SF Mono', Menlo, monospace;

/* BAD — single family, single fallback */
font-family: 'Fraunces', serif;
font-family: 'Instrument Sans', sans-serif;
```

**Why:** If the Google Fonts CDN is slow, blocked, or the URL is subtly malformed, the user sees raw `serif` (Times) or `sans-serif` (default) until the network resolves. A 3-deep chain lands on a designed fallback (Georgia for display, system sans for body, Menlo for mono) that feels intentional.

### 2. Google Fonts URLs: simple axes only

```
✅ family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900
✅ family=Inter:wght@300;400;500;600;700
✅ family=JetBrains+Mono:wght@400;500;600

❌ family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,100..900,0..100,0..1;1,9..144,100..900,0..100,0..1
```

**Why:** Variable axes beyond `ital`, `opsz`, `wght` (and sometimes `slnt`) are niche and fragile. When the URL is malformed or the browser doesn't support the axis, the font loads without that axis, and any `font-variation-settings` referencing it silently fails. The text renders in undefined state. **Stick to italic + optical-size + weight.** Drop WONK, SOFT, GRAD, YOPQ, etc.

### 3. Never use `font-variation-settings` for load-bearing style

```css
/* BAD — renders wrong if axis not loaded */
font-variation-settings: "opsz" 144, "SOFT" 100, "WONK" 1;

/* GOOD — explicit, universally supported */
font-weight: 500;
font-style: italic;
font-size: 3rem;
```

**Why:** `font-variation-settings` overrides `font-weight` and `font-style`. If the font didn't load the requested axes, the settings apply to a file that can't honor them, and you get unpredictable rendering. Stick to `font-weight` + `font-style` which have universal fallback behavior.

### 4. Use inline SVG for shapes, never CSS pseudo-elements

```html
<!-- GOOD — arrow with arrowhead always renders -->
<svg width="56" height="12" viewBox="0 0 56 12" xmlns="http://www.w3.org/2000/svg">
  <line x1="0" y1="6" x2="48" y2="6" stroke="#FFB547" stroke-width="1.25" stroke-dasharray="3 3"/>
  <path d="M48 2 L54 6 L48 10 Z" fill="#FFB547"/>
</svg>
```

```css
/* BAD — pixel math + border-triangle hack */
.arrow::before { background: linear-gradient(...); }
.arrow::after { border: 4px solid transparent; border-left-color: #fff; }
```

**Why:** CSS pseudo-arrow "arrowheads" require exact border-triangle math at the endpoint of a gradient line. One rounding error or flex misalignment and it doesn't look like an arrow. Inline SVG renders identically everywhere.

### 5. Sticky over fixed; grid/flex over absolute positioning

```css
/* GOOD */
.topbar { position: sticky; top: 0; }
.hero-stats { display: grid; grid-template-columns: repeat(4, 1fr); }

/* BAD */
.rail { position: fixed; left: 24px; top: 50%; }  /* overlaps content */
.hero-stats { position: absolute; bottom: 48px; left: 0; right: 0; }  /* breaks on short viewports */
```

**Why:** Fixed elements float on top of everything and cause overlap when the viewport is unexpected. Absolute positioning breaks when containers resize. Grid and flex flow with content.

### 6. Never `mix-blend-mode` on load-bearing text

```css
/* BAD — text can become invisible depending on what's behind */
.topmeta { mix-blend-mode: difference; }

/* GOOD — explicit contrast */
.topmeta {
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  color: var(--ink-3);
}
```

**Why:** `mix-blend-mode: difference` inverts colors based on the pixel behind. On a dark background with a noise overlay + radial gradient, this produces unpredictable contrast — often invisible text. Blend modes are for decorative overlays, not UI text.

### 7. Responsive breakpoints at 4 explicit tiers

```css
/* Desktop: default (≥900px) */
/* Tablet: 700-899px — grids collapse */
@media (max-width: 899px) { .channels { grid-template-columns: 1fr; } }
/* Mobile: 480-699px — side-by-side stacks */
@media (max-width: 699px) { .wrap { padding: 0 28px; } }
/* Small: <480px — padding shrinks */
@media (max-width: 479px) { .wrap { padding: 0 20px; } .hero-title { font-size: 4rem; } }
```

**Why:** A single `@media (max-width: 768px)` leaves gaps. The 700-899px range commonly has a wide tablet that looks cramped under desktop rules. Test 4 explicit widths: 1280, 800, 600, 400.

### 8. One accent pair, not a palette

```css
/* GOOD — clear visual semantics */
--you: #FFB547;       /* amber — human actions */
--agents: #5EA9FF;    /* blue — machine actions */
--live: #22C989;      /* green — status only */
--danger: #E56B58;    /* red — failure mode only */

/* BAD — rainbow dashboard */
--accent-1: #8B5CF6; --accent-2: #EC4899; --accent-3: #F59E0B; ...
```

**Why:** A single accent pair carries meaning. The reader learns "amber = me, blue = agents" in two seconds and the design reinforces the story. A palette of 6+ accents looks like a generic SaaS dashboard.

### 9. Dark-mode contrast must be tested with zero-font fallback

```css
/* Background + text combination must read even if fonts haven't loaded */
--bg: #0B0908;
--ink: #F5EFE6;  /* warm cream — not pure #FFFFFF which is harsh on dark */
--ink-2: #A89E91;  /* muted for secondary text */
--ink-3: #6E6458;  /* dim for tertiary labels */
```

**Why:** Pure white (#FFF) on near-black (#000) is retina-burning. Use warm cream (#F5EFE6) and graduated muted tones. All combinations should read at WCAG AA minimum with system fonts before Google Fonts load.

### 10. Single file, no framework, no build step

- HTML + inline `<style>` + inline `<script>` (vanilla JS only)
- One external dependency allowed: Google Fonts `<link>` tag (and only that)
- Zero npm, no React, no Vue, no Tailwind CDN (Tailwind's runtime CDN is fine for rapid prototyping but introduces a dependency)
- The file must work when double-clicked from Finder/Explorer

**Why:** The deliverable has to open from disk, no server. Every external dependency is a failure point. Frameworks add loader complexity that breaks under `file://`. Inline everything.

---

## The canonical starter template

Every app Jake asks for should start from this skeleton. Adapt the aesthetic direction to the content; keep the primitives unchanged.

See `assets/starter.html` for the full template. Copy-paste, rename, adapt. Use it as the baseline for every single-file app.

---

## Aesthetic direction menu

After committing to the 10 principles, *commit to a direction*. Pick one of these (or a variation) per file — don't hedge with "modern and clean":

| Direction | Feel | Works for |
|---|---|---|
| **Editorial-brutalist** | Fraunces display serif + Inter body + dark cream-on-black + one accent pair | Explainers, explorers, manifestos |
| **Terminal-retro** | JetBrains Mono everywhere + green-on-black CRT look | Developer tools, status dashboards |
| **Swiss-minimal** | Sans only + lots of white space + one hot accent | Data visualization, process diagrams |
| **Archival-print** | Warm cream paper + black ink + editorial serif + hairline dividers | Reference docs, manuals |
| **Operations-center** | Dark UI + data-dense cards + live indicators + muted accents | Live dashboards, monitoring |
| **Playground-toy** | Oversized interactive elements + bright colors + generous motion | Interactive playgrounds |

Pick the direction in your first thinking pass, state it explicitly in your opening message ("Going editorial-brutalist: Fraunces display + Inter body + amber/blue accents"), and every CSS choice falls out from there.

---

## Delivery checklist

Before reporting done, verify each of these:

- [ ] Single `.html` file at a specified path (usually `99_Inbox/<topic>.html` or `/tmp/<topic>.html`)
- [ ] Opens correctly via `wslview <path>` (test it, or have user test)
- [ ] Fonts load (check Network tab — Google Fonts CSS 200)
- [ ] No console errors on page load
- [ ] Responsive: test 1280px, 800px, 600px, 400px
- [ ] Dark mode: all text readable with fallback fonts (temporarily disable Google Fonts `<link>` and check)
- [ ] Every interactive element has a visible hover state
- [ ] JavaScript is vanilla — no imports, no frameworks
- [ ] One aesthetic direction committed, not hedged

## Anti-pattern spotlist

If you catch yourself writing any of these, stop and rewrite:

| Anti-pattern | Replacement |
|---|---|
| `font-variation-settings: "SOFT" ...` | `font-weight: ...` + `font-style: ...` |
| `::before { border: 4px solid transparent; ... }` (as arrow) | `<svg>` inline |
| `position: fixed; left/right: ...` (for nav) | `position: sticky; top: 0` |
| `mix-blend-mode: difference` (on text) | Explicit `background` + `color` pair |
| Single `@media (max-width: 768px)` | 4 tiers: 900, 700, 600, 480 |
| `color: #FFFFFF` on `background: #000000` | `#F5EFE6` on `#0B0908` or similar warm pair |
| Loading exotic Google Fonts axes (WONK, SOFT, GRAD) | opsz + weight + ital only |
| Tailwind via CDN | Raw CSS with custom properties |
| "modern and clean" as aesthetic direction | Commit to one: editorial / brutalist / terminal / etc. |
| `<script src="https://cdn...">` (for libraries) | Inline vanilla JS |

## When delivering

Announce the aesthetic direction first. Then write the file. Then offer to open it:

```
Going editorial-brutalist: Fraunces display + Inter body + dark cream-on-near-black + amber (you) / blue (agents) accents.

Built at /home/jfloyd/obsidian-vault/99_Inbox/name.html.

Open with: wslview /home/jfloyd/obsidian-vault/99_Inbox/name.html
```

If the file will be opened in the same session, run `wslview <path>` yourself after writing.

---

## References

- `assets/starter.html` — the canonical skeleton. Copy and adapt.
- `references/failure-modes.md` — detailed war stories of each anti-pattern (when needed)
