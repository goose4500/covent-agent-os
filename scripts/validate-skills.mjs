import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("skills");
const strict = process.env.STRICT_SKILL_VALIDATION === "true";
const warnings = [];
const errors = [];
let count = 0;

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    const skill = path.join(folder, "SKILL.md");
    if (await exists(skill)) {
      count++;
      const text = await readFile(skill, "utf8");
      if (!text.startsWith("---")) {
        warnings.push(`${skill}: legacy skill missing frontmatter`);
        continue;
      }
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      if (!m) {
        warnings.push(`${skill}: malformed frontmatter`);
        continue;
      }
      const name = m[1].match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
      const desc = m[1].match(/^description:\s*([^\n]+)$/m)?.[1]?.trim();
      if (!name) warnings.push(`${skill}: missing name`);
      if (!desc) warnings.push(`${skill}: missing description`);
    } else {
      await walk(folder);
    }
  }
}

if (await exists(root)) await walk(root);

if (warnings.length) {
  const label = strict ? "Skill validation errors" : "Skill validation warnings";
  console.warn(`${label}:\n${warnings.join("\n")}`);
  if (strict) errors.push(...warnings);
}

if (errors.length) {
  process.exit(1);
}

console.log(`validate:skills ok (${count} skills${warnings.length ? `, ${warnings.length} warnings` : ""})`);
