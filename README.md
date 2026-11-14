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
            encode_request / decode_response  — the same request, for an
                                    external WASI generator, and its answer
                                    checked as the CLI checks it
            encode_describe / check_description — the Describe call first,
                                    checked as the CLI checks it (protocol,
                                    IR format, language and version)
            describe_project(files)        -> the schema shape the sim runs on,
                                    with wire numbers and the comline@2 Hello
          The package takes core's defaults (datagram@3, comline@2) and
          has the fixed id 706c617967726f756e64000000000000; its facts are
          a first version's (comline_core::compat::facts_of_context), so
          wire numbers and lines are provisional.
            semantic_tokens / hover / completions   — the LSP handlers verbatim
          deps: comline-core, comline-codegen, comline-codegen-rust,
                comline-codegen-typescript, comline-language-server (git rev)
kit/      comline-web-kit — what the playground shares with the tutorial and
          other Comline pages, as TypeScript that Vite compiles:
            comline-web-kit/editor   a CodeMirror 6 editor (highlighting /
                                     diagnostics / hover / autocomplete all
                                     from the editor WASM's LSP) and the Web
                                     Worker that runs that WASM
            comline-web-kit/sim      the **simulate** view: a canvas /
                                     inspector / frame log over the sim WASM
            comline-web-kit/sim/scripted  the Rhai engine's loader, passed to
                                     `createSim` to offer the `script`
                                     behaviour
            comline-web-kit/sim.css  its styles, scoped under `.cl-sim` and
                                     themed with `--cl-*` properties
          The sim engine is the `comline-simulator` git dependency
          (ComlineProject/simulator), which builds itself to WASM on install
          — `pkg/` (lean) plus `pkg-script/` (Rhai, code-split and fetched
          only when a `script` behaviour is picked). `kit/pkg-editor/` is the
          editor WASM, built by `yarn wasm` (or the kit's `prepack`).
app/      the playground site (Vite): files, tabs, problems, generated
          output and examples around the kit's editor and simulate view
fixtures/generators/   a hostile WASI generator (one misbehaviour per
                       name) for app/src/wasi-generator.test.ts
.github/workflows/deploy.yml   build editor WASM → yarn install (builds the sim
                               WASM) → test → build site → deploy to Pages
```

## Develop

```sh
yarn install  # app/ and kit/; also clones + builds comline-simulator to WASM (needs cargo)
yarn dev      # editor WASM, then Vite
yarn test     # the kit's tests, then the app's
```

Needs a Rust toolchain with the `wasm32-unknown-unknown` target (for the editor
WASM via [`wasm-pack`](https://rustwasm.github.io/wasm-pack/), and for
`comline-simulator`'s install-time build — `yarn install` compiles
`wasm-bindgen-cli` once, then caches it in `~/.cargo`). `wasm-opt` trims the
output when present. `COMLINE_SIMULATOR_SCRIPT=0 yarn install` skips the ~2 MB
scripted build.

## Using the kit elsewhere

Another site depends on the kit by git, at a commit of this repo:

```json
"comline-web-kit": "git+https://github.com/ComlineProject/playground.git#workspace=comline-web-kit&commit=<sha>"
```

Yarn clones the repo, and the kit's `prepack` builds the editor WASM. A site
that only uses `comline-web-kit/sim` sets `COMLINE_KIT_EDITOR=0` to skip that
build. Its Vite config needs `optimizeDeps.exclude: ["comline-web-kit"]`, so
the kit's `?url` WASM imports and its worker aren't pre-bundled.

## Deploy

Push to `master`. The workflow builds the editor WASM (`wasm-pack`), runs
`yarn install` (which builds `comline-simulator` to WASM), the tests, builds the site with
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
