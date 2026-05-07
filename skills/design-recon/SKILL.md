---
name: design-recon
description: 
---


# Design Recon — Website Design System Reverse Engineering

Extract the low-level CSS design system from any website and produce a structured reference
note in the Obsidian vault. Works on single sites or batches.

## When This Skill Fires

The user provides one or more website URLs and wants to understand their design systems at
the CSS level — colors, typography, spacing, components, shadows, motion, and layout patterns.

## Input Formats

The skill accepts URLs in any of these forms:

1. **Inline:** `/design-recon clay.com bland.ai lindy.ai`
2. **From a file:** `/design-recon --file ~/sites-to-analyze.txt` (one URL per line)
3. **Conversational:** "Can you reverse-engineer the design system of attio.com and cohere.com?"

Normalize all URLs to include `https://` if not provided. Strip trailing slashes.

## The Extraction Pipeline

### Step 1: Batch Planning

Count the sites. Decide how many subagents to launch:

| Sites | Agents | Sites per Agent | Why |
|-------|--------|----------------|-----|
| 1-3   | 1      | 1-3            | Not worth parallelizing |
| 4-6   | 2      | 2-3            | Light parallelism |
| 7-10  | 3      | 2-4            | Sweet spot — agents won't timeout |
| 11-15 | 4      | 3-4            | Max recommended parallelism |
| 16-20 | 5      | 3-4            | Beyond this, run in two rounds |
| 21+   | 5      | 4 per round    | Split into rounds of 20, run sequentially |

**Why 3-4 sites per agent max:** Each site requires 2-4 tool calls (WebFetch + chrome-devtools
JS injection + optional follow-ups). At 5+ sites per agent, context windows bloat and agents
start timing out or losing fidelity on later sites. The 3-4 sweet spot was validated empirically.

**Why 5 agents max:** Beyond 5 parallel agents, the system becomes I/O bound on MCP tool calls
and chrome-devtools page switching causes tab conflicts between agents sharing the browser.

### Step 2: Launch Subagents

Each subagent gets this prompt template. Fill in the `{SITES}` list:

```
You are extracting the CSS design system from these websites: {SITES}

For EACH site, perform TWO extraction passes:

PASS 1 — WebFetch (fast, gets static CSS/HTML):
Use WebFetch to fetch the URL. Extract from the HTML:
- CSS custom properties (--var-name: value)
- Tailwind classes on key elements (body, h1-h6, nav, buttons, sections)
- Inline styles
- Google Fonts or @font-face declarations
- Meta viewport and theme-color tags
- Any <style> blocks with design tokens

PASS 2 — Chrome DevTools (computed styles from rendered page):
Open the page with mcp__chrome-devtools__new_page, then run this JS extraction script
via mcp__chrome-devtools__evaluate_script:

```javascript
() => {
  const r = { title: document.title, url: window.location.href };
  const ext = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      tag: el.tagName, cls: el.className?.toString?.()?.substring?.(0, 150) || '',
      ff: s.fontFamily, fs: s.fontSize, fw: s.fontWeight, lh: s.lineHeight,
      ls: s.letterSpacing, c: s.color, bg: s.backgroundColor, p: s.padding,
      br: s.borderRadius, bs: s.boxShadow, mw: s.maxWidth, gap: s.gap,
      d: s.display, pos: s.position, h: s.height, bdr: s.border, tr: s.transition
    };
  };
  r.el = {};
  ['body','h1','h2','h3','h4','h5','p'].forEach(t => r.el[t] = ext(document.querySelector(t)));
  r.el.nav = ext(document.querySelector('nav') || document.querySelector('header'));
  r.el.footer = ext(document.querySelector('footer'));
  // Buttons
  const btns = document.querySelectorAll('a[class*="btn"], a[class*="button"], button[class*="btn"], button[class*="button"], a[class*="cta"], a[class*="CTA"]');
  r.btns = Array.from(btns).slice(0, 5).map(b => {
    const s = getComputedStyle(b);
    return { text: b.textContent?.trim().substring(0, 60), bg: s.backgroundColor,
      c: s.color, p: s.padding, br: s.borderRadius, fs: s.fontSize, fw: s.fontWeight,
      bdr: s.border, bs: s.boxShadow };
  });
  // If no buttons found by class, try CTA-text heuristic
  if (r.btns.length === 0) {
    const allLinks = document.querySelectorAll('a');
    const ctaLinks = Array.from(allLinks).filter(a => {
      const text = a.textContent?.trim().toLowerCase() || '';
      return text.includes('book') || text.includes('start') || text.includes('get') ||
             text.includes('contact') || text.includes('demo') || text.includes('try') ||
             text.includes('free') || text.includes('schedule');
    });
    r.btns = ctaLinks.slice(0, 5).map(b => {
      const s = getComputedStyle(b);
      return { text: b.textContent?.trim().substring(0, 60), bg: s.backgroundColor,
        c: s.color, p: s.padding, br: s.borderRadius, fs: s.fontSize, fw: s.fontWeight,
        bdr: s.border, bs: s.boxShadow };
    });
  }
  // Heading scale
  r.hs = {};
  for (let i = 1; i <= 6; i++) {
    const el = document.querySelector('h' + i);
    if (el) {
      const s = getComputedStyle(el);
      r.hs['h'+i] = { fs: s.fontSize, fw: s.fontWeight,
        ff: s.fontFamily.substring(0, 80), lh: s.lineHeight, ls: s.letterSpacing,
        c: s.color, t: el.textContent?.trim().substring(0, 80) };
    }
  }
  // Background colors across page
  const bgs = new Set(), txts = new Set();
  document.querySelectorAll('*').forEach((el, i) => {
    if (i > 500) return;
    const s = getComputedStyle(el);
    txts.add(s.color);
    if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') bgs.add(s.backgroundColor);
  });
  r.bgs = [...bgs].slice(0, 15);
  r.txts = [...txts].slice(0, 15);
  // Sections
  const secs = document.querySelectorAll('section, [class*="section"]');
  r.secs = Array.from(secs).slice(0, 8).map(s => {
    const cs = getComputedStyle(s);
    return { cls: s.className?.substring(0, 100), p: cs.padding, bg: cs.backgroundColor, mw: cs.maxWidth };
  });
  return r;
}
```

If chrome-devtools fails (page won't load, timeout, etc.), fall back to WebFetch-only data.
Note the failure in the output but don't retry more than once.

For each site, compile the data into this EXACT format:

## [Site Name] ([domain]) — Design System Teardown

### Color Palette
- Primary: #xxx (what it's used for)
- Secondary: #xxx
- Accent: #xxx
- Background: #xxx
- Surface: #xxx
- Text: #xxx / #xxx (heading/body)
- Border: #xxx

### Typography
- Display: [font-family], [sizes], [weights]
- Body: [font-family], [sizes], [weights]
- Heading Scale: h1=Xpx/Xwt/Xpx tracking, h2=..., h3=...
- Letter-spacing pattern: [values]
- Line-height pattern: [values]

### Spacing
- Base unit: Xpx
- Section padding: Xpx vertical
- Container max-width: Xpx
- Component gaps: Xpx

### Layout
- Platform: [Webflow/Framer/Next.js/etc]
- Grid system: [columns, approach]
- Section flow: [Hero → Features → Social Proof → CTA → Footer]

### Components
- Button: padding Xpx, radius Xpx, bg #xxx, font Xpx/Xwt
- Card: padding Xpx, radius Xpx, shadow [value]
- Nav: height Xpx, bg [value], position [sticky/fixed]

### Motion
- Transitions: [durations and easings]
- Animations: [keyframes, scroll effects]

### Key Design Decision
[One sentence: what makes THIS site's design distinctive at the CSS level]
```

### Step 3: Collect and Synthesize

After all subagents return, synthesize the results:

1. **Combine all teardowns** into a single document
2. **Generate the cross-site comparison matrix:**

```markdown
| Site | Platform | Display Font | Color DNA | Container | Shadow Approach | Maturity |
|------|----------|-------------|-----------|-----------|-----------------|----------|
```

3. **Generate the meta-analysis** — patterns that recur across 3+ sites:
   - Typography consensus (font families, weight ranges, tracking patterns)
   - Color temperature trends (warm vs cool neutrals)
   - Spacing patterns (base unit, section padding ranges)
   - Border-radius consensus
   - Animation timing consensus
   - Shadow philosophy (minimal vs multi-layer vs none)

4. **Generate copy-paste CSS palette presets** for the most distinctive color systems found:

```css
/* [Palette Name] (inspired by [site]) */
--bg: #xxx;
--surface: #xxx;
--text: #xxx;
--text-muted: #xxx;
--accent: #xxx;
--border: #xxx;
```

### Step 4: Write to Vault

Write the final note using `mcp__obsidian-vault__write_note`:

- **Path:** `07_Solutions/marketing/design-recon-YYYY-MM-DD-[slug]`
- **Slug:** derived from the first 2-3 sites or a theme if provided
- **Frontmatter:** `type: solution, status: active, tags: [design, css, reference, design-recon]`
- **Content:** All teardowns + comparison matrix + meta-analysis + palette presets

Link to existing reference notes:
```markdown
## Related
- [[design-system-reference-library]] — Master reference from prior recon sessions
- [[figma-evaluation-first-principles]] — When to use Figma vs code-first
- [[svg-remotion-skills-first-principles]] — Code-first visual production
```

### Step 5: Report

Tell the user:
- How many sites were analyzed
- Which extraction method worked for each (WebFetch, chrome-devtools, or both)
- The vault note path
- Top 3 most interesting design patterns found
- Any sites that failed extraction and why

## Error Handling

- **Site behind auth/paywall:** Note as "requires authentication" and skip
- **Chrome-devtools timeout:** Fall back to WebFetch-only, note reduced fidelity
- **Site redirects to different domain:** Note both domains, analyze the final destination
- **Empty/minimal CSS (SPA with external styles):** Try extracting CSS custom properties from `document.documentElement` computed styles via chrome-devtools
- **Rate limiting (429s):** Wait 5 seconds and retry once. If still blocked, skip and note.

## What NOT to Do

- Don't screenshot sites (wastes tokens, not actionable data)
- Don't try to extract full external CSS files (too large, low signal-to-noise)
- Don't analyze more than 20 sites in one invocation (split into multiple runs)
- Don't spend more than 2 tool calls per site if both WebFetch and chrome-devtools succeed on the first try
- Don't write custom HTML viewers — the vault note IS the deliverable
