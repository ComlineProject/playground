// `comline_sim_script.js` (in `app/src/sim-wasm-script/`) is a wasm-pack
// artifact built on demand — by `npm run sim-wasm:script` and the deploy
// workflow, not by `npm run dev`. It exports the same surface as the lean
// `comline_sim.js`, just with the Rhai `script` behaviour compiled in. This
// opaque ambient lets `tsc` resolve the lazy `import()` when the artifact (and
// its generated `.d.ts`) is absent; callers cast the module to the lean
// module's type.
declare module "*/comline_sim_script.js";
