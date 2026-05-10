#!/usr/bin/env node
import { extractSupportedUrls } from "./lib/insights/url-classifier.mjs";

const cases = [
  {
    name: "bare youtube long",
    text: "Check this out https://www.youtube.com/watch?v=abc123XYZ_-",
    expectKinds: ["youtube"],
  },
  {
    name: "youtu.be short",
    text: "https://youtu.be/dQw4w9WgXcQ",
    expectKinds: ["youtube"],
  },
  {
    name: "slack-wrapped with label",
    text: "look at <https://www.youtube.com/watch?v=ABCDEFG1234|the talk>",
    expectKinds: ["youtube"],
  },
  {
    name: "twitter status",
    text: "tweet <https://twitter.com/jack/status/20|jack>",
    expectKinds: ["twitter"],
  },
  {
    name: "x.com status",
    text: "https://x.com/elonmusk/status/123456789",
    expectKinds: ["twitter"],
  },
  {
    name: "spotify episode",
    text: "<https://open.spotify.com/episode/3w5mWmfeyGb6oVc1zaLVWg>",
    expectKinds: ["spotify"],
  },
  {
    name: "spotify show (allowed)",
    text: "https://open.spotify.com/show/7gozmLqbcbr6PScMjc0Zl4",
    expectKinds: ["spotify"],
  },
  {
    name: "unsupported domain",
    text: "https://example.com/post and https://news.ycombinator.com/item?id=1",
    expectKinds: [],
  },
  {
    name: "spotify track (NOT supported)",
    text: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    expectKinds: [],
  },
  {
    name: "mixed message",
    text: "<https://youtu.be/AAA1111zzzz|talk> + <https://x.com/foo/status/999> + https://example.com",
    expectKinds: ["youtube", "twitter"],
  },
  {
    name: "duplicate within message",
    text: "<https://youtu.be/SAME1234567|a> and https://www.youtube.com/watch?v=SAME1234567",
    expectKinds: ["youtube"],
  },
  {
    name: "trailing punctuation",
    text: "see https://x.com/user/status/1, also https://youtu.be/aaaBBBccc99.",
    expectKinds: ["twitter", "youtube"],
  },
  {
    name: "empty",
    text: "",
    expectKinds: [],
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const out = extractSupportedUrls(c.text);
  const kinds = out.map((r) => r.kind);
  const ok = kinds.length === c.expectKinds.length && kinds.every((k, i) => k === c.expectKinds[i]);
  if (ok) {
    pass += 1;
    console.log(`PASS  ${c.name}  -> [${kinds.join(", ")}]`);
  } else {
    fail += 1;
    console.log(`FAIL  ${c.name}`);
    console.log(`  expected: [${c.expectKinds.join(", ")}]`);
    console.log(`  got:      [${kinds.join(", ")}]`);
    console.log(`  results:  ${JSON.stringify(out, null, 2)}`);
  }
}

console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail === 0 ? 0 : 1);
