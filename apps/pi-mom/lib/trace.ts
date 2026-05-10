import type { Config } from "./config.ts";

export type Trace = (eventName: string, data?: Record<string, unknown>) => void;

export function createTrace(config: Config): Trace {
  return function trace(eventName, data = {}) {
    if (!config.pi.traceEnabled) return;
    const entry = { ts: new Date().toISOString(), event: eventName, ...data };
    console.log(`[pi-mom-trace] ${JSON.stringify(entry)}`);
  };
}
