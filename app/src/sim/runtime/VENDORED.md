# Vendored `@comline/runtime`

`*.ts` here (and `framing/`) are a verbatim copy of
`ComlineProject/comline-typescript` `runtime/src/` — the package is not
published (`version 0.0.0`), so it is pinned by copy the way `wasm/Cargo.toml`
pins `comline-core` by rev.

- Source: <https://github.com/ComlineProject/comline-typescript>
- Commit: `5c20074113a748cd96b639c38c5c030c2de9fbea` (`runtime/src/`)

`_fixture_chat.ts` is `runtime/test/generated/chat.ts` from the same commit,
its `@comline/runtime` import repointed at `./index.ts`. It is the drift guard:
`sim/wire.test.ts` runs a call through it and through `GenericDispatch` and
asserts identical wire frames.

## Re-vendoring

Re-copy `runtime/src/*` and `runtime/test/generated/chat.ts`, repoint the
fixture import, bump the commit above. Do it when the runtime contract moves
(new framing, transport, envelope shape).
