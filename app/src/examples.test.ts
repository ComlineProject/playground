/// Every example schema (from the `comline-examples` git dependency) compiles
/// against *this* build of the editor wasm — so a `comline-core` change that
/// breaks one is caught here, not in the playground UI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import examples from "comline-examples";

const initWasm = (await import("./wasm/comline_playground_wasm.js")).default;
const { compile_project } = await import("./wasm/comline_playground_wasm.js");
await initWasm(
  readFileSync(fileURLToPath(new URL("./wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);

interface Example {
  id: string;
  entry: string;
  files: { name: string; source: string }[];
}

for (const ex of examples as Example[]) {
  test(`example "${ex.id}" compiles with no errors`, () => {
    assert.ok(
      ex.files.some((f) => f.name === ex.entry),
      `entry "${ex.entry}" is one of the files`,
    );
    const res = compile_project(
      ex.files.map((f) => ({ path: f.name, source: f.source })),
    ) as { diagnostics?: { severity?: unknown; message?: string }[] };
    const errors = (res.diagnostics ?? []).filter(
      (d) => d.severity === "error" || d.severity === 1 || d.severity === "Error",
    );
    assert.equal(errors.length, 0, `diagnostics: ${JSON.stringify(errors)}`);
  });
}
