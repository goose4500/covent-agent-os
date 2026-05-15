// Build a zip bundle from a file or directory on disk, normalized so the
// preview service always sees `index.html` at the zip root.
//
// Rules:
//   - A single file → zipped under its existing basename if it's `index.html`,
//     otherwise renamed to `index.html` in the bundle (the preview service
//     unconditionally serves index.html from the slug's root).
//   - A directory → zipped recursively from that dir as the bundle root.
//     The directory MUST contain index.html.
//   - Hidden entries (`.git`, `.DS_Store`, files starting with `.`) are
//     skipped.
//   - Total uncompressed bytes are capped at MAX_BUNDLE_BYTES; the preview
//     service enforces the same limit independently.
//
// Returns a Uint8Array of the zip bytes. Throws if the source is missing or
// the bundle violates the policy — callers fail-soft from there.

import { readFile, stat, readdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { zipSync } from "fflate";

export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 64;

async function* walkFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(p);
    else if (entry.isFile()) yield p;
  }
}

export async function buildPreviewZip(sourcePath) {
  const s = await stat(sourcePath);
  const files = {};
  let total = 0;
  let count = 0;

  function add(name, bytes) {
    if (++count > MAX_FILES) throw new Error(`too_many_files:${count}`);
    total += bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) throw new Error(`bundle_too_large:${total}`);
    files[name] = bytes;
  }

  if (s.isFile()) {
    const bytes = await readFile(sourcePath);
    const name = basename(sourcePath).toLowerCase() === "index.html"
      ? "index.html"
      : "index.html";
    add(name, new Uint8Array(bytes));
  } else if (s.isDirectory()) {
    for await (const filePath of walkFiles(sourcePath)) {
      const rel = relative(sourcePath, filePath).replace(/\\/g, "/");
      const bytes = await readFile(filePath);
      add(rel, new Uint8Array(bytes));
    }
    if (!files["index.html"]) {
      throw new Error("missing_index_html_in_source_dir");
    }
  } else {
    throw new Error("source_path_not_file_or_dir");
  }

  return { zip: zipSync(files), count, bytes: total };
}
