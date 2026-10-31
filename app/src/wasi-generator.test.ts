/// An external generator run through the WASI shim answers exactly as the
/// linked one does: comline-rust's `comline-gen-rust`, built for
/// `wasm32-wasip1` from the rev the editor wasm links, over every example, in
/// both modes, byte for byte.
///
/// The generator is built in CI (see `.github/workflows/deploy.yml`) and
/// found through `COMLINE_GEN_RUST_WASM`. Locally, build it with
/// `cargo build -p comline-codegen-rust --bin comline-gen-rust --target
/// wasm32-wasip1 --release` in a comline-rust checkout at that rev, and
/// point the variable at the `.wasm`; without it this test is skipped.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import examples from "comline-examples";

import initEditor, { decode_response, generate_project } from "./wasm/comline_playground_wasm.js";
import { generateWithWasiGenerator, runWasiGenerator } from "./wasi-generator.ts";

await initEditor(
  readFileSync(fileURLToPath(new URL("./wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);

interface Example {
  id: string;
  files: { name: string; source: string }[];
}

const generatorPath = process.env.COMLINE_GEN_RUST_WASM;
// CI builds the generator, so there it's never skipped.
if (process.env.CI && !generatorPath) throw new Error("COMLINE_GEN_RUST_WASM isn't set in CI");
const skip = generatorPath ? false : "COMLINE_GEN_RUST_WASM isn't set";
const generator = generatorPath ? await WebAssembly.compile(readFileSync(generatorPath)) : null;

for (const ex of examples as Example[]) {
  for (const mode of ["code", "lib"]) {
    test(`example "${ex.id}" (${mode}): the WASI generator matches the linked one`, { skip }, async () => {
      const files = ex.files.map((f) => ({ path: f.name, source: f.source }));
      const linked = generate_project(files, "rust", mode);
      assert.ok(!linked.error, linked.error);
      assert.ok(linked.files.length > 0);
      const external = await generateWithWasiGenerator(generator!, files, "rust", mode);
      assert.deepEqual(external, linked);
    });
  }
}

test("a response that isn't one is refused, with nothing generated", { skip }, async () => {
  const result = await generateWithWasiGenerator(
    // A module that writes nothing: an empty response.
    await WebAssembly.compile(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
      0x03, 0x02, 0x01, 0x00, // func 0
      0x05, 0x03, 0x01, 0x00, 0x01, // memory 1 page
      0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, // export "memory"
      0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00, // export "_start"
      0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b, // code: empty body
    ])),
    [{ path: "chat.ids", source: "struct S {\n    a: u8\n}\n" }],
    "rust",
    "code",
  );
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /doesn't decode/);
});

test("an empty stdin is answered with an error response, not a crash", { skip }, async () => {
  const run = await runWasiGenerator(generator!, new Uint8Array());
  assert.equal(run.exitCode, 0);
  const result = decode_response(run.stdout) as { files: unknown[]; error?: string };
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /^the generator: /);
});
