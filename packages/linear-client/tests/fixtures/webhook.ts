// Test fixtures for Linear webhook signature verification.
//
// Secrets here are throwaway test values — the `whsec_test_` and
// `whsec_prev_` prefixes are explicit "this is fixture data" markers and
// match no real workspace. Signatures were computed offline with both
// Node's `crypto.createHmac` and OpenSSL (`openssl dgst -sha256 -hmac`)
// to confirm parity.

/** Primary signing secret for fixture payloads. Test value only. */
export const FIXTURE_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";

/** Rotated/previous signing secret. Test value only. */
export const FIXTURE_PREV_SECRET = "whsec_prev_fedcba9876543210fedcba9876543210";

/**
 * webhookTimestamp baked into FIXTURE_BODY. Tests inject a clock pinned to
 * this value so the 60s replay window is satisfied without relying on wall
 * time.
 */
export const FIXTURE_TIMESTAMP_MS = 1715731200000;

/**
 * Canonical webhook body. JSON.stringify of an object with deterministic
 * key order; the signature below was computed against EXACTLY this string.
 */
export const FIXTURE_BODY =
	'{"action":"create","type":"Issue","webhookTimestamp":1715731200000,' +
	'"data":{"id":"issue-1","identifier":"FE-1","title":"Test"},' +
	'"url":"https://linear.app/test/issue/FE-1"}';

/** HMAC-SHA256(FIXTURE_BODY, FIXTURE_SECRET) — lowercase hex. */
export const FIXTURE_SIGNATURE =
	"326cfe051e4e4b206287516d8e2e7764da69dfb156713e059f20b497f55afd46";

/** HMAC-SHA256(FIXTURE_BODY, FIXTURE_PREV_SECRET) — lowercase hex. */
export const FIXTURE_SIGNATURE_PREV =
	"1d0ac8b2dd5194aeaa28ae4e1abdb6210eb1d46969d8e7cbcfc84df056a602c2";
