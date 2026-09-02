# Comline Playground

Type a `.comline` schema, see the diagnostics, the frozen IR, and the generated
code — live, in the browser. Runs the **actual** `comline-core` +
`comline-codegen` (compiled to WASM), so what you see matches the CLI.

Static — deploys to GitHub Pages, no server.

## Layout

```
wasm/   comline-playground-wasm — the Rust crate, wasm-bindgen surface
          compile(source)                -> { ok, diagnostics, ir, units }
          generate(source, target, mode) -> { files, error }
        deps: comline-core, comline-codegen, comline-codegen-rust,
              comline-codegen-typescript (all by git rev)
app/    a Vite + vanilla-TS static site; the WASM runs in a Web Worker
.github/workflows/deploy.yml   build WASM → build site → deploy to Pages
```

## Develop

```sh
cd app
npm install
npm run dev        # runs wasm-pack, then Vite
```

Requires a Rust toolchain with the `wasm32-unknown-unknown` target and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

## Deploy

Push to `master`. The workflow builds the WASM with `wasm-pack`, builds the site
with Vite (`base: "./"`, so it works under `/<repo>/`), and publishes `app/dist`
to Pages. Enable Pages → "GitHub Actions" in the repo settings once.

## Scope (v1)

One schema, namespace `main`; `code` and `lib` modes; `rust` and `typescript`
targets. Multi-file packages, a real editor (CodeMirror), a runtime demo, and
docs embedding are follow-ups — see `ComlineProject/docs` → Design → *Playground
& tutorial*.

## License

GPL-3.0-only — links `comline-core`, part of the Comline toolchain.
