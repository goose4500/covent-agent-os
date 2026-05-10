// Trace — observability hook matching pi-mom's `trace()` pattern.
// Callers can inject a trace function; the client emits a structured event
// per request (operation, request id, duration, rate-limit headers, error
// class). Secrets must be redacted at the boundary. See PRD principle 11.

export type TraceFn = (eventName: string, data: Record<string, unknown>) => void;

export function setTraceFn(_fn: TraceFn | null): void {
	throw new Error("not implemented");
}

export function trace(_eventName: string, _data: Record<string, unknown>): void {
	throw new Error("not implemented");
}
