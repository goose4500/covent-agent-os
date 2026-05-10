// Identifiers — normalize the two ways agents reference Linear issues:
// UUIDs and human identifiers like `FE-123`, plus Linear URLs.
// See PRD principle 5.

export interface ParsedLinearUrl {
	identifier: string;
	teamKey: string;
	number: number;
	slug?: string;
}

/** Returns true for strings shaped like a Linear human identifier (e.g. `FE-123`). */
export function isIdentifier(_value: string): boolean {
	throw new Error("not implemented");
}

/** Parses a Linear issue URL (e.g. `https://linear.app/acme/issue/FE-123/slug`). */
export function parseLinearUrl(_url: string): ParsedLinearUrl | null {
	throw new Error("not implemented");
}
