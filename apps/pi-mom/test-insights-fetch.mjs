#!/usr/bin/env node
import { extractSupportedUrls } from "./lib/insights/url-classifier.mjs";
import { fetchTranscriptForKind } from "./lib/insights/apify-client.mjs";
import { INSIGHTS_CONFIG } from "./lib/insights/config.mjs";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node test-insights-fetch.mjs <url>");
  console.error("Requires APIFY_API_TOKEN in env.");
  process.exit(2);
}
if (!INSIGHTS_CONFIG.apifyToken) {
  console.error("APIFY_API_TOKEN is required.");
  process.exit(2);
}

const [link] = extractSupportedUrls(url);
if (!link) {
  console.error(`Not a supported URL: ${url}`);
  process.exit(2);
}

console.log(`Resolved kind=${link.kind} url=${link.normalizedUrl}`);
console.log(`Calling Apify actor for ${link.kind} (timeout ${INSIGHTS_CONFIG.perLinkTimeoutMs}ms)…`);

const start = Date.now();
try {
  const { transcript, metadata } = await fetchTranscriptForKind({
    kind: link.kind,
    url: link.normalizedUrl,
    config: INSIGHTS_CONFIG,
  });
  console.log(`OK in ${Date.now() - start}ms`);
  console.log("Metadata:", JSON.stringify(metadata, null, 2));
  console.log(`Transcript length: ${transcript.length} chars`);
  console.log("Transcript head (first 500 chars):");
  console.log(transcript.slice(0, 500));
} catch (error) {
  console.error(`FAILED in ${Date.now() - start}ms:`, error.message);
  process.exit(1);
}
