import { fetchTranscriptForKind } from "./apify-client.mjs";
import { buildAnalysisPrompt, buildDryRunAnalysis } from "./prompt.mjs";
import { formatThreadReply, formatErrorReply } from "./format.mjs";

function truncateTranscript(transcript, maxChars) {
  if (!transcript) return "";
  if (transcript.length <= maxChars) return transcript;
  return `${transcript.slice(0, maxChars)}\n\n[transcript truncated for analysis]`;
}

async function notifyArchive(_payload) {
  // Phase 2 seam — intentionally a no-op in v1. See plan: "Slack search only for v1".
}

export async function analyzeUrl({ link, config, requestId, runPi, dedupe, trace = () => {} }) {
  const { url, normalizedUrl, kind, hash } = link;
  if (dedupe && dedupe.checkAndRecord(hash)) {
    trace("insights.deduped", { requestId, kind, url: normalizedUrl });
    return { ok: false, skipped: true, reason: "deduped" };
  }

  let fetched;
  try {
    fetched = await fetchTranscriptForKind({ kind, url: normalizedUrl, config });
    trace("insights.fetch_ok", {
      requestId,
      kind,
      url: normalizedUrl,
      transcriptLength: fetched.transcript.length,
    });
  } catch (error) {
    trace("insights.fetch_failed", {
      requestId,
      kind,
      url: normalizedUrl,
      error: error.message,
      apifyKind: error.kind,
    });
    return { ok: false, error, text: formatErrorReply({ url, error, requestId }) };
  }

  const transcript = truncateTranscript(fetched.transcript, config.maxTranscriptChars);

  let analysis;
  try {
    if (config.dryRun) {
      analysis = buildDryRunAnalysis({ kind, metadata: fetched.metadata, transcript });
    } else {
      const prompt = buildAnalysisPrompt({ kind, url, metadata: fetched.metadata, transcript });
      analysis = await runPi(prompt, { extraArgs: config.piExtraArgs });
    }
    trace("insights.analyzed", { requestId, kind, url: normalizedUrl, dryRun: config.dryRun });
  } catch (error) {
    trace("insights.analyze_failed", { requestId, kind, url: normalizedUrl, error: error.message });
    return { ok: false, error, text: formatErrorReply({ url, error, requestId }) };
  }

  const reply = formatThreadReply({ kind, url, metadata: fetched.metadata, analysis });

  try {
    await notifyArchive({ url, normalizedUrl, kind, metadata: fetched.metadata, analysisRaw: analysis });
  } catch (error) {
    trace("insights.archive_failed", { requestId, error: error.message });
  }

  return { ok: true, text: reply, metadata: fetched.metadata };
}
