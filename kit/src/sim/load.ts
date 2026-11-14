/// Loads the simulation engine's (lean) WASM. Call it once before
/// `createSim`; later calls return the same promise. The Rhai-scripted engine
/// is separate, and `createSim` fetches it only when a `script` behaviour is
/// picked.

import initSimWasm from "comline-simulator";
import simWasmUrl from "comline-simulator/pkg/comline_simulator_bg.wasm?url";

let loading: Promise<void> | null = null;

export function loadSim(): Promise<void> {
  loading ??= initSimWasm({ module_or_path: simWasmUrl }).then(() => undefined);
  return loading;
}
