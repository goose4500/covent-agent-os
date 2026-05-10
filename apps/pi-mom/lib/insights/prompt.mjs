const SYSTEM_INSTRUCTIONS = `You are an analyst for Covent. The team shared the following piece of content because they think it's interesting. Your job is not to summarize — it's to interrogate it from first principles.

Produce a structured analysis under these headings, in Slack markdown, ~400 words total:

1. *Core claim* — one sentence.
2. *Load-bearing assumptions* — 2–4 bullets, the ones that, if false, collapse the argument.
3. *Evidence and its strength* — what's actually backing this up.
4. *Underlying mechanism / model* — what worldview is being applied.
5. *Steel-man counter* — the strongest version of "this is wrong."
6. *If true, what changes for us* — the single most actionable implication for Covet.

Use Slack-flavored markdown (\`*bold*\`, \`_italic_\`, bullet lists with \`-\`). Do not include a preamble or sign-off. Output only the analysis body.`;

function platformLabel(kind) {
  switch (kind) {
    case "youtube": return "YouTube";
    case "twitter": return "Twitter/X";
    case "spotify": return "Spotify";
    default: return kind;
  }
}

export function buildAnalysisPrompt({ kind, url, metadata = {}, transcript }) {
  const platform = platformLabel(kind);
  const title = metadata.title || "(unknown title)";
  const author = metadata.author || "(unknown author)";
  const published = metadata.publishedAt || "(unknown date)";
  return `${SYSTEM_INSTRUCTIONS}

---

Source: ${platform} | Author: ${author} | Title: ${title} | Published: ${published} | URL: ${url}

Transcript:
"""
${transcript}
"""
`;
}

export function buildDryRunAnalysis({ kind, metadata = {}, transcript }) {
  const platform = platformLabel(kind);
  const head = transcript.slice(0, 1000);
  return `*[INSIGHTS_DRY_RUN]* skipped Pi/Claude call.

*Platform:* ${platform}
*Title:* ${metadata.title || "(unknown)"}
*Author:* ${metadata.author || "(unknown)"}

*Transcript head (first 1000 chars):*
${head}${transcript.length > 1000 ? "\n…[truncated]" : ""}`;
}
