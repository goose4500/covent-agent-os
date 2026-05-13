// Slack thread fetch + file-hydration + file-bytes-download layer.
//
// This module is the I/O boundary between pi-mom and Slack for the
// long-thread / multimodal context pipeline. It deliberately does NOT
// know anything about prompts, summarization, image description, or
// token budgets — those are composed on top by the thread-context
// builder. Three primitives are exported:
//
//   1. fetchFullThread — paginate `conversations.replies` to the end,
//      with a safety cap so a runaway thread can't unbound us. Mid-loop
//      errors are tolerated: we return whatever we accumulated and tag
//      the result `partial: true`.
//
//   2. hydrateFiles — fan out `files.info` calls in parallel with a
//      per-call deadline. Order-preserving. Per-file failures become
//      stub records carrying just the original id/name plus an `error`
//      field, so downstream callers can render a degraded placeholder
//      instead of crashing.
//
//   3. downloadFileBytes — raw `fetch` against `url_private` with the
//      bot token. A `text/html` response is the Slack "you got the
//      login page" tell — we surface that as `auth_failure` so callers
//      can act on it specifically.
//
// All three accept dependency-injection seams (`fetchImpl`, the
// `client` object) so the test file can swap in stubs without
// touching the network.

const DEFAULT_SAFETY_CAP = 2000;
const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_DEADLINE_MS = 3000;

/**
 * Fetch every reply in a Slack thread via cursor-paginated
 * `conversations.replies`. Stops at `safetyCap` total messages and
 * tolerates mid-loop errors.
 *
 * @param {{
 *   client: { paginate: (method: string, options: Record<string, unknown>) => AsyncIterable<{ messages?: unknown[] }> },
 *   channel: string,
 *   rootTs: string,
 *   safetyCap?: number,
 * }} params
 * @returns {Promise<{ messages: unknown[], partial: boolean, count: number, error?: string }>}
 */
export async function fetchFullThread({
  client,
  channel,
  rootTs,
  safetyCap = DEFAULT_SAFETY_CAP,
}) {
  const messages = [];
  let partial = false;
  let error;

  try {
    const iter = client.paginate("conversations.replies", {
      channel,
      ts: rootTs,
      limit: DEFAULT_PAGE_LIMIT,
      include_all_metadata: true,
    });

    for await (const page of iter) {
      const pageMessages = Array.isArray(page?.messages) ? page.messages : [];
      for (const m of pageMessages) {
        if (messages.length >= safetyCap) {
          partial = true;
          break;
        }
        messages.push(m);
      }
      if (messages.length >= safetyCap) {
        partial = true;
        break;
      }
    }
  } catch (err) {
    partial = true;
    error = err instanceof Error ? err.message : String(err);
  }

  const result = { messages, partial, count: messages.length };
  if (error !== undefined) result.error = error;
  return result;
}

/**
 * Fan out `files.info` calls for a list of file references. Each call
 * is wrapped with a per-call deadline. Failures become stub records;
 * the output array preserves input order and length.
 *
 * @param {{
 *   client: { files: { info: (args: { file: string }) => Promise<{ file?: unknown }> } },
 *   files: Array<{ id?: string, file_id?: string, name?: string, mimetype?: string }>,
 *   deadlineMs?: number,
 * }} params
 * @returns {Promise<unknown[]>}
 */
export async function hydrateFiles({
  client,
  files,
  deadlineMs = DEFAULT_DEADLINE_MS,
}) {
  if (!Array.isArray(files) || files.length === 0) return [];

  const settled = await Promise.allSettled(
    files.map((input) => {
      const id = input?.id ?? input?.file_id;
      if (!id) {
        return Promise.reject(new Error("missing file id"));
      }
      return withDeadline(
        client.files.info({ file: id }),
        deadlineMs,
        "files.info timed out",
      );
    }),
  );

  return settled.map((res, i) => {
    const input = files[i] || {};
    if (res.status === "fulfilled") {
      const file = res.value?.file;
      if (file && typeof file === "object") return file;
      return stubFor(input, "files.info returned no file");
    }
    const reason = res.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    return stubFor(input, msg);
  });
}

function stubFor(input, errorMessage) {
  return {
    id: input?.id ?? input?.file_id ?? null,
    name: input?.name ?? "<unknown>",
    mimetype: input?.mimetype ?? null,
    error: errorMessage,
  };
}

/**
 * Race a promise against a deadline. We don't have AbortSignal hooks
 * into @slack/web-api's request layer, so this just bounds the wait —
 * the underlying request may continue in the background until Slack
 * answers, but we move on.
 */
function withDeadline(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Download raw bytes for a Slack-hosted file. Uses the bot token via
 * `Authorization: Bearer …`. A `text/html` response means Slack
 * served the login page (auth failure); we surface that as a tagged
 * error so callers can react specifically.
 *
 * @param {{
 *   url: string,
 *   botToken: string,
 *   deadlineMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} params
 * @returns {Promise<{ buffer: Buffer, mimeType: string } | { error: string }>}
 */
export async function downloadFileBytes({
  url,
  botToken,
  deadlineMs = DEFAULT_DEADLINE_MS,
  fetchImpl,
}) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) return { error: "fetch unavailable" };

  let signal;
  try {
    if (
      Number.isFinite(deadlineMs) &&
      deadlineMs > 0 &&
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      signal = AbortSignal.timeout(deadlineMs);
    }
  } catch {
    signal = undefined;
  }

  let response;
  try {
    response = await doFetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  if (!response || !response.ok) {
    const status = response?.status ?? "unknown";
    return { error: `http_${status}` };
  }

  const contentType =
    (typeof response.headers?.get === "function"
      ? response.headers.get("content-type")
      : null) || "";
  if (contentType.toLowerCase().includes("text/html")) {
    return { error: "auth_failure" };
  }

  let buffer;
  try {
    const arrayBuf = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuf);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  return { buffer, mimeType: contentType };
}
