/// Milestone 2b: a `Forward` behaviour relays a call onto another connection —
/// a gateway. Scripted end to end: caller → edge → (forward) → backend → back.
/// A forward that re-enters a connection already in flight is a cycle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initWasm, { describe_project } from "../wasm/comline_playground_wasm.js";
import type { ProjectShape } from "./shape.ts";
import { addConnection, addInstance, emptySession, setBehavior } from "./model.ts";
import { Wires } from "./engine.ts";
import { SimRemoteError } from "./generic.ts";

await initWasm(
  readFileSync(fileURLToPath(new URL("../wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);

const CHAT = `struct Message {
    body: string
    seq: u64
}

protocol Chat {
    function send(text: string) -> Message;
}
`;
const shape = () => describe_project([{ path: "chat.ids", source: CHAT }]) as ProjectShape;

/** caller ─cFront─▶ edge ══forward══▶ ─cBack─▶ backend */
function gateway() {
  const session = emptySession(shape());
  const spec = { schemaNs: "chat", protocol: "Chat" } as const;
  const edge = addInstance(session, { ...spec, role: "server" });
  const edgeCli = addInstance(session, { ...spec, role: "client" });
  const backend = addInstance(session, { ...spec, role: "server" });
  const caller = addInstance(session, { ...spec, role: "client" });
  const cBack = addConnection(session, edgeCli.id, backend.id);
  const cFront = addConnection(session, caller.id, edge.id);
  return { session, edge, edgeCli, backend, caller, cBack, cFront };
}

test("2b — a Forward behaviour relays the call to another server and returns its reply", async () => {
  const g = gateway();
  setBehavior(g.session, g.backend.id, "send", "reply", { value: { body: "FROM-BACKEND", seq: 9 } });
  setBehavior(g.session, g.edge.id, "send", "forward", {
    viaConnectionId: g.cBack.id,
    targetFn: "send",
  });

  const wires = new Wires();
  await wires.sync(g.session);

  const reply = await wires.get(g.cFront.id)!.call("send", { text: "hi" });
  assert.deepEqual(reply, { body: "FROM-BACKEND", seq: 9 });

  const backendCalls = wires
    .get(g.cBack.id)!
    .tap.frames.filter((f) => f.kind !== "handshake");
  assert.ok(backendCalls.length >= 2, "the nested call and its reply crossed the second connection");

  wires.closeAll();
});

test("2b — a forward that re-enters its own connection is refused as a cycle", async () => {
  const g = gateway();
  const loop = { viaConnectionId: g.cBack.id, targetFn: "send" };
  setBehavior(g.session, g.edge.id, "send", "forward", loop);
  setBehavior(g.session, g.backend.id, "send", "forward", loop); // backend forwards back over cBack

  const wires = new Wires();
  await wires.sync(g.session);

  await assert.rejects(
    () => wires.get(g.cFront.id)!.call("send", { text: "hi" }),
    (e: unknown) => {
      assert.ok(e instanceof SimRemoteError);
      assert.equal((e.data as { error?: string }).error, "forwarding cycle");
      return true;
    },
  );

  // the wire is not wedged — fixing the backend lets the next call through
  setBehavior(g.session, g.backend.id, "send", "reply", { value: { body: "OK", seq: 1 } });
  await wires.rebuild(g.session);
  assert.deepEqual(await wires.get(g.cFront.id)!.call("send", { text: "hi" }), { body: "OK", seq: 1 });

  wires.closeAll();
});
