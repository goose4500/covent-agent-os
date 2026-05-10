// Identifiers — normalize the two ways agents reference Linear issues:
// UUIDs and human identifiers like `FE-123`, plus Linear URLs.
// See PRD principle 5.

/**
 * Linear human identifier shape. Uppercase team prefix (1+ char), then digits,
 * separated by a dash. Examples: `FE-123`, `ENG-4567`, `A1-9`.
 *
 * The prefix must start with a letter; subsequent prefix characters may be
 * letters, digits, or underscores. Prefix length 2..10 chars (Linear's own
 * limit), number is one or more digits.
 */
const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]{1,9}-\d+$/;

/** Match Linear issue URLs: `https://linear.app/<workspace>/issue/FE-123[/<slug>]`. */
const LINEAR_URL_RE =
	/^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9_]{1,9}-\d+)(?:\/([^/?#]*))?(?:[/?#].*)?$/;

export interface ParsedLinearUrl {
	identifier: string;
	teamPrefix: string;
	teamKey: string;
	number: number;
	slug?: string;
}

/** Returns true for strings shaped like a Linear human identifier (e.g. `FE-123`). */
export function isIdentifier(value: string): boolean {
	if (typeof value !== "string") return false;
	return IDENTIFIER_RE.test(value);
}

/**
 * Parses a Linear issue URL (e.g. `https://linear.app/acme/issue/FE-123/slug`).
 * Returns `null` if the URL is not a Linear issue URL.
 */
export function parseLinearUrl(url: string): ParsedLinearUrl | null {
	if (typeof url !== "string") return null;
	const m = LINEAR_URL_RE.exec(url);
	if (!m) return null;
	const identifier = m[1]!;
	const slug = m[2];
	const dash = identifier.indexOf("-");
	const teamPrefix = identifier.slice(0, dash);
	const number = Number.parseInt(identifier.slice(dash + 1), 10);
	const parsed: ParsedLinearUrl = {
		identifier,
		teamPrefix,
		// teamKey alias kept for parity with the pre-existing stub shape.
		teamKey: teamPrefix,
		number,
	};
	if (slug && slug.length > 0) parsed.slug = slug;
	return parsed;
}
