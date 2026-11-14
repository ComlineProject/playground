/// The Rhai-scripted engine, for the `script` behaviour. Pass it to
/// `createSim({ loadScripted })` to offer scripting. The view calls it only
/// once a `script` behaviour is picked, and Vite code-splits these imports, so
/// the ~2 MB scripted WASM downloads only then.
///
/// It's its own entry point (`comline-web-kit/sim/scripted`) because a build
/// resolves dynamic imports too: a page that never imports this module builds
/// without the scripted engine, as when installed with
/// `COMLINE_SIMULATOR_SCRIPT=0`.

/// <reference path="./sim-wasm-script.d.ts" />

import type { Sim } from "comline-simulator";

export async function loadScripted(): Promise<{ Sim: typeof Sim }> {
  // Same surface as the lean module, just Rhai-enabled — hence the cast (the
  // `pkg-script/` ambient is deliberately opaque).
  const m = (await import(
    "comline-simulator/pkg-script/comline_simulator.js"
  )) as typeof import("comline-simulator");
  const { default: wasmUrl } = await import(
    "comline-simulator/pkg-script/comline_simulator_bg.wasm?url"
  );
  await m.default({ module_or_path: wasmUrl });
  return { Sim: m.Sim };
}
