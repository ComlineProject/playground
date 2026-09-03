/// The engine lives in `ComlineProject/simulator` (Rust → WASM), pulled in as
/// the `comline-simulator` git dependency. This proves the wasm loads and its
/// `Sim` surface round-trips a call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initEditor, { describe_project } from "../wasm/comline_playground_wasm.js";
import initSim, { Sim } from "comline-simulator";

const simWasm = fileURLToPath(
  new URL("../../node_modules/comline-simulator/pkg/comline_simulator_bg.wasm", import.meta.url),
);

await initEditor(
  readFileSync(fileURLToPath(new URL("../wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);
await initSim(readFileSync(simWasm));

const CHAT = `struct Message {
    body: string
    seq: u64
}

protocol Chat {
    function send(text: string) -> Message;
}
`;

const spec = (role: "server" | "client") =>
  JSON.stringify({ schemaNs: "chat", protocol: "Chat", role });

test("the sim wasm instantiates and round-trips a call", () => {
  const shape = JSON.stringify(describe_project([{ path: "chat.ids", source: CHAT }]));
  const sim = new Sim(shape);

  const srv = sim.add_instance(spec("server"));
  const cli = sim.add_instance(spec("client"));
  const conn = sim.add_connection(cli, srv);

  const id = sim.call(conn, "send", JSON.stringify(["hi"]));
  sim.run();

  const result = JSON.parse(sim.result(id)!);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.value, { body: "", seq: 0 }); // default seeded reply = zero value

  const frames = JSON.parse(sim.frames(conn));
  assert.equal(frames.length, 4, "two handshake frames, then request + response");
  assert.equal(frames[2].kind, "request");
  assert.equal(frames[3].kind, "response");
});

test("a behaviour swap and a shareable link work through the facade", () => {
  const shape = JSON.stringify(describe_project([{ path: "chat.ids", source: CHAT }]));
  const sim = new Sim(shape);
  const srv = sim.add_instance(spec("server"));
  const cli = sim.add_instance(spec("client"));
  const conn = sim.add_connection(cli, srv);

  sim.set_behavior(srv, "send", "echo", "{}");
  const id = sim.call(conn, "send", JSON.stringify(["echo me"]));
  sim.run();
  assert.deepEqual(JSON.parse(sim.result(id)!).value, ["echo me"]);

  const link = sim.link();
  const restored = new Sim(shape, link);
  assert.equal(JSON.parse(restored.session_json()).instances.length, 2);
});
