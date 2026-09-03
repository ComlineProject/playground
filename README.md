# Comline Playground

Type a `.ids` schema, see the diagnostics, the frozen IR, and the generated
code — live, in the browser. Runs the **actual** `comline-core` +
`comline-codegen` + the `comline-language-server` analysis (compiled to WASM),
so what you see matches the CLI and `comline-lsp`.

Static — deploys to GitHub Pages, no server.

## Layout

```
wasm/     comline-playground-wasm — the editor's Rust crate, wasm-bindgen surface
            compile(source)                -> { ok, diagnostics, ir, units }
            generate(source, target, mode) -> { files, error }
            describe_project(files)        -> the schema shape the sim runs on
            semantic_tokens / hover / completions   — the LSP handlers verbatim
          deps: comline-core, comline-codegen, comline-codegen-rust,
                comline-codegen-typescript, comline-language-server (git rev)
sim-wasm/ a thin wrapper that re-exports ComlineProject/simulator's `Sim`
          surface (git rev). `npm run sim-wasm` builds it lean (~520 KB);
          `npm run sim-wasm:script` adds the Rhai `script` behaviour (~2.1 MB),
          a separate chunk the simulate view fetches only when a `script`
          behaviour is picked.
app/      a Vite site: a CodeMirror 6 editor (highlighting / diagnostics /
          hover / autocomplete all from the editor WASM's LSP, in a Web
          Worker), plus the **simulate** view — a thin canvas / inspector /
          frame-log over the sim WASM. `app/src/sim/` is that view; the engine
          it drives lives in ComlineProject/simulator.
.github/workflows/deploy.yml   build the WASMs (editor, sim, scripted sim)
                               → build site → deploy to Pages
```

## Develop

```sh
cd app
npm install
npm run dev              # editor + lean sim WASM, then Vite
npm run sim-wasm:script  # once, if you want to exercise `script` behaviours
```

`npm run dev` skips the scripted sim WASM (it is slow to build and rarely
touched); without it, picking a `script` behaviour just shows an inspector
notice. `npm run build` *does* need it — run `npm run sim-wasm:script` first, as
CI does. Requires a Rust toolchain with the `wasm32-unknown-unknown` target and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

## Deploy

Push to `master`. The workflow builds the WASM with `wasm-pack`, builds the site
with Vite (`base: "./"`, so it works under `/<repo>/`), and publishes `app/dist`
to Pages. Enable Pages → "GitHub Actions" in the repo settings once.

## Scope

The editor: one schema, namespace `main`; `code` and `lib` modes; `rust` and
`typescript` targets. The simulate view: many instances / connections, fault
injection, a virtual clock, forwarding gateways, record & replay, the framing /
codec matrix, and user-scripted behaviours (Rhai). Multi-file packages, config
(`config.idp` / `comline.toml`) input, and docs embedding are follow-ups — see
`ComlineProject/docs` → Design → *Playground simulation*.

## License

GPL-3.0-only — links `comline-core`, part of the Comline toolchain.
