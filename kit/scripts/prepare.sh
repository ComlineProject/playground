#!/usr/bin/env bash
# The build hook run when the kit is consumed as a git dependency
# (`"comline-web-kit": "git+https://github.com/ComlineProject/playground.git#workspace=comline-web-kit&commit=<sha>"`):
# Yarn clones the repo, installs it, and runs this `prepack` before packing the
# workspace, so `../wasm` (the editor's Rust crate) is there to build.
#
# Builds the editor WASM (core, codegen and the language server's analysis,
# compiled together) into `pkg-editor/`. That takes a Rust toolchain, the
# wasm32 target and wasm-pack, and a few minutes. A consumer that only uses
# `comline-web-kit/sim` sets COMLINE_KIT_EDITOR=0 to skip it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${COMLINE_KIT_EDITOR:-1}" = "0" ]; then
	echo "comline-web-kit: COMLINE_KIT_EDITOR=0, skipping the editor WASM" >&2
	exit 0
fi

if [ -f pkg-editor/comline_playground_wasm.js ] && [ pkg-editor/comline_playground_wasm.js -nt ../wasm/Cargo.toml ]; then
	echo "comline-web-kit: pkg-editor/ is already built, skipping" >&2
	exit 0
fi

for tool in cargo wasm-pack; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "comline-web-kit: building the editor WASM needs $tool." >&2
		echo "  Install a Rust toolchain (https://rustup.rs) and wasm-pack, or set COMLINE_KIT_EDITOR=0" >&2
		echo "  if you only use comline-web-kit/sim." >&2
		exit 1
	fi
done

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
wasm-pack build ../wasm --release --target web --out-dir ../kit/pkg-editor --out-name comline_playground_wasm
