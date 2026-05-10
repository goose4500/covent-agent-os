// Pagination — generic helper over @linear/sdk's connection types.
//
// `paginate(connFn, { pageSize, max })` walks a relay-style connection until
// exhaustion or `max` is reached. Real impl in W-A.

export interface PaginateOptions {
	pageSize?: number;
	max?: number;
}

export interface ConnectionLike<T> {
	nodes: T[];
	pageInfo: {
		hasNextPage: boolean;
		endCursor?: string | null;
	};
}

export type ConnectionFetcher<T> = (args: {
	first: number;
	after?: string;
}) => Promise<ConnectionLike<T>>;

export async function paginate<T>(
	_connFn: ConnectionFetcher<T>,
	_options?: PaginateOptions,
): Promise<T[]> {
	throw new Error("not implemented");
}
