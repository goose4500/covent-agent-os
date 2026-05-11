export function createTrace(config) {
  return function trace(eventName, data = {}) {
    if (!config.traceEnabled) return;
    const entry = { ts: new Date().toISOString(), event: eventName, ...data };
    console.log(`[pi-mom-trace] ${JSON.stringify(entry)}`);
  };
}
