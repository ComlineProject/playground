/// The project shape's type references: a fixed array keeps its length from
/// core's frozen IR through `describe_project` to the label and zero value.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const initWasm = (await import("../wasm/comline_playground_wasm.js")).default;
const { describe_project } = await import("../wasm/comline_playground_wasm.js");
await initWasm(
  readFileSync(fileURLToPath(new URL("../wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);
import { typeLabel, zeroValue, type ProjectShape, type TypeDef } from "./shape.ts";

const SOURCE = `struct Packet {
    digest: u8[4]
    tags: string[]
    ratio: f32
}
`;

function packet(): TypeDef {
  const shape = describe_project([{ path: "packet.ids", source: SOURCE }]) as ProjectShape;
  const def = shape.schemas[0].types.find((t) => t.name === "Packet");
  assert.ok(def, JSON.stringify(shape));
  return def;
}

test("a fixed array keeps its length; a dynamic one has none", () => {
  const def = packet();
  assert.equal(def.kind, "struct");
  if (def.kind !== "struct") return;
  const [digest, tags, ratio] = def.fields;
  assert.deepEqual(digest.ty, { kind: "array", of: { kind: "prim", name: "u8" }, len: 4 });
  assert.deepEqual(tags.ty, { kind: "array", of: { kind: "prim", name: "string" } });
  assert.deepEqual(ratio.ty, { kind: "prim", name: "f32" });
  assert.equal(typeLabel(digest.ty), "u8[4]");
  assert.equal(typeLabel(tags.ty), "string[]");
});

test("a fixed array's zero value is already its full length", () => {
  const def = packet();
  assert.deepEqual(zeroValue({ kind: "ref", name: "Packet" }, [def]), {
    digest: [0, 0, 0, 0],
    tags: [],
    ratio: 0,
  });
});
