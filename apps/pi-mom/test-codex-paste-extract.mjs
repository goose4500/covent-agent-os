import assert from "node:assert/strict";
import {
  looksLikeCodexCallback,
  extractCallbackValue,
} from "./lib/codex-paste-extract.mjs";

// The exact paste Arbaz Khan tried in #idea-specs on 2026-05-13 (after
// Slack auto-linked the URL into <url|display> form). Reproduced here as
// the regression fixture this whole change exists to prevent.
const ARBAZ_PASTE =
  "<http://localhost:1455/auth/callback?code=ac_F9Ap4NEGAGqzqB6PbsB7_XdkoTioyK80-kiq_f_KDg0" +
  ".XnulNCfxXFtCjSbmthaNCzlnHd9AI0uBTKN-KEzA8rY&scope=openid+profile+email+offline_access" +
  "&state=e81f85ace78288c3727b430a1eabe9bb" +
  "|http://localhost:1455/auth/callback?code=ac_F9Ap4NEGAGqzqB6PbsB7_XdkoTioyK80-kiq_f_[…]e+email+offline_access" +
  "&state=e81f85ace78288c3727b430a1eabe9bb>";

// --- looksLikeCodexCallback ---

assert.equal(
  looksLikeCodexCallback("http://localhost:1455/auth/callback?code=abc"),
  true,
  "looks: bare callback URL",
);
assert.equal(looksLikeCodexCallback(ARBAZ_PASTE), true, "looks: Slack-wrapped URL");
assert.equal(
  looksLikeCodexCallback("here you go: http://localhost:1455/auth/callback?code=x then thanks"),
  true,
  "looks: URL embedded in chatter",
);
assert.equal(
  looksLikeCodexCallback("ac_F9Ap4NEGAGqzqB6PbsB7_XdkoTioyK80kiq.XnulNCfxXFtCjSbmthaNCzlnHd"),
  true,
  "looks: bare ac_… code",
);
assert.equal(
  looksLikeCodexCallback("hi @bot please draft a spec"),
  false,
  "looks: unrelated chat is false",
);
assert.equal(
  looksLikeCodexCallback("can you help me with localhost stuff"),
  false,
  "looks: similar phrase is false",
);
assert.equal(looksLikeCodexCallback(""), false, "looks: empty is false");
assert.equal(looksLikeCodexCallback(null), false, "looks: null is false");
assert.equal(looksLikeCodexCallback(undefined), false, "looks: undefined is false");
assert.equal(
  looksLikeCodexCallback("http://localhost:3000/auth/callback?code=x"),
  false,
  "looks: wrong port is false",
);
assert.equal(
  looksLikeCodexCallback("https://example.com/auth/callback?code=x"),
  false,
  "looks: wrong host is false",
);

// --- extractCallbackValue ---

assert.equal(
  extractCallbackValue("http://localhost:1455/auth/callback?code=abc&state=xyz"),
  "http://localhost:1455/auth/callback?code=abc&state=xyz",
  "extract: bare URL passthrough",
);

const extractedArbaz = extractCallbackValue(ARBAZ_PASTE);
assert.ok(
  extractedArbaz?.startsWith("http://localhost:1455/auth/callback?code=ac_F9Ap4NEGAGqzqB6PbsB7"),
  "extract: Arbaz paste unwraps to real URL",
);
assert.ok(
  extractedArbaz?.includes("state=e81f85ace78288c3727b430a1eabe9bb"),
  "extract: state survives unwrap",
);
assert.ok(!extractedArbaz?.includes("[…]"), "extract: truncation display does not leak");
assert.ok(!extractedArbaz?.includes("|"), "extract: pipe separator does not leak");

assert.equal(
  extractCallbackValue(
    "thanks! here: http://localhost:1455/auth/callback?code=abc&state=xyz.",
  ),
  "http://localhost:1455/auth/callback?code=abc&state=xyz",
  "extract: strips trailing punctuation",
);

assert.equal(
  extractCallbackValue("ac_F9Ap4NEGAGqzqB6PbsB7_XdkoTioyK80kiq.XnulNCfxXFtCjSbmthaNCzlnHdAA"),
  "ac_F9Ap4NEGAGqzqB6PbsB7_XdkoTioyK80kiq.XnulNCfxXFtCjSbmthaNCzlnHdAA",
  "extract: bare code passthrough",
);

assert.equal(extractCallbackValue("hi please help"), null, "extract: unrelated text returns null");
assert.equal(extractCallbackValue(""), null, "extract: empty returns null");
assert.equal(extractCallbackValue(null), null, "extract: null input returns null");

console.log("✓ codex-paste-extract: all cases pass");
