// Pagination — async-iterable walker over Linear's Relay-style connections.
//
// Yields one node at a time, fetching subsequent pages via the supplied
// `connectionFn(after?)` until `hasNextPage` is false or `max` nodes have
// been yielded.

export interface PageInfoLike {
	hasNextPage: boolean;
	endCursor: string | null;
}

export interface ConnectionLike<T> {
	nodes: T[];
	pageInfo: PageInfoLike;
}

export type ConnectionFn<T> = (after?: string) => Promise<ConnectionLike<T>>;

export interface PaginateOptions {
	/** Stop yielding after this many nodes. Default `Number.POSITIVE_INFINITY`. */
	max?: number;
}

/**
 * Walk a paginated Linear connection lazily. Example:
 *
 * ```ts
 * for await (const issue of paginate((after) => team.issues({ after }))) {
 *   …
 * }
 * ```
 */
export async function* paginate<T>(
	connectionFn: ConnectionFn<T>,
	opts: PaginateOptions = {},
): AsyncIterable<T> {
	const max = opts.max ?? Number.POSITIVE_INFINITY;
	if (max <= 0) return;

	let yielded = 0;
	let cursor: string | undefined;

	while (true) {
		const page = await connectionFn(cursor);
		for (const node of page.nodes) {
			yield node;
			yielded++;
			if (yielded >= max) return;
		}

		if (!page.pageInfo.hasNextPage) return;
		const next = page.pageInfo.endCursor;
		if (!next) return;
		cursor = next;
	}
}
