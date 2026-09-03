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
app/      a Vite site: a CodeMirror 6 editor (highlighting / diagnostics /
          hover / autocomplete all from the editor WASM's LSP, in a Web
          Worker), plus the **simulate** view — a thin canvas / inspector /
          frame-log over the sim WASM. `app/src/sim/` is that view; the engine
          is the `comline-simulator` git dependency (ComlineProject/simulator),
          which builds itself to WASM on `npm install` — `pkg/` (lean) plus
          `pkg-script/` (Rhai, code-split and fetched only when a `script`
          behaviour is picked).
.github/workflows/deploy.yml   build editor WASM → npm install (builds the sim
                               WASM) → build site → deploy to Pages
```

## Develop

```sh
cd app
npm install   # also clones + builds comline-simulator to WASM (needs cargo)
npm run dev   # editor WASM, then Vite
```

Needs a Rust toolchain with the `wasm32-unknown-unknown` target (for the editor
WASM via [`wasm-pack`](https://rustwasm.github.io/wasm-pack/), and for
`comline-simulator`'s install-time build — `npm install` compiles
`wasm-bindgen-cli` once, then caches it in `~/.cargo`). `wasm-opt` trims the
output when present. `COMLINE_SIMULATOR_SCRIPT=0 npm install` skips the ~2 MB
scripted build.

## Deploy

Push to `master`. The workflow builds the editor WASM (`wasm-pack`), runs
`npm install` (which builds `comline-simulator` to WASM), builds the site with
Vite (`base: "./"`, so it works under `/<repo>/`), and publishes `app/dist` to
Pages. Enable Pages → "GitHub Actions" in the repo settings once.

## Scope

The editor: one schema, namespace `main`; `code` and `lib` modes; `rust` and
`typescript` targets. The simulate view: many instances / connections, fault
injection, a virtual clock, forwarding gateways, record & replay, the framing /
codec matrix, and user-scripted behaviours (Rhai). Multi-file packages, config
(`config.idp` / `comline.toml`) input, and docs embedding are follow-ups — see
`ComlineProject/docs` → Design → *Playground simulation*.

## License

GPL-3.0-only — links `comline-core`, part of the Comline toolchain.
