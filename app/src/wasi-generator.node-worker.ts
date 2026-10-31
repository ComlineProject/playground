/// The tests' stand-in for `wasi-generator.worker.ts`: the same guest code
/// in a Node worker thread, which `terminate()` stops the same way.

import { parentPort } from "node:worker_threads";

import { runGuest, type GuestCall } from "./wasi-generator-guest.ts";

parentPort!.on("message", async (call: GuestCall) => {
  parentPort!.postMessage(await runGuest(call));
});
