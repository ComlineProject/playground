// `comline-simulator/pkg-script/` is the Rhai-enabled build. The engine's
// `prepare` produces it by default on `npm install`, but a consumer can opt out
// (`COMLINE_SIMULATOR_SCRIPT=0`), so these opaque ambients keep `tsc` resolving
// the lazy `import()`s even when that build (and its generated `.d.ts`) is
// absent. Callers cast the module to `typeof import("comline-simulator")`.
declare module "comline-simulator/pkg-script/comline_simulator.js";

declare module "comline-simulator/pkg-script/comline_simulator_bg.wasm?url" {
  const url: string;
  export default url;
}
