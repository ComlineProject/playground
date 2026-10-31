/// The worker one WASI generator call runs in, so a generator that doesn't
/// finish can be stopped: the main thread `terminate()`s it at the deadline
/// (`wasi-generator.ts`). One call per worker.

import { runGuest, type GuestCall } from "./wasi-generator-guest.ts";

self.onmessage = async (event: MessageEvent<GuestCall>) => {
  const result = await runGuest(event.data);
  const transfer = [result.stderr.buffer, ...(result.ok ? [result.stdout.buffer] : [])];
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(result, transfer as ArrayBuffer[]);
};
