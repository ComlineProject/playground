/// Milestone 2e (share half): a `Session` round-trips through the URL-fragment
/// string, and a bogus string is rejected.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initWasm, { describe_project } from "../wasm/comline_playground_wasm.js";
import type { ProjectShape } from "./shape.ts";
import { addConnection, addInstance, emptySession, setBehavior } from "./model.ts";
import { decodeSession, encodeSession, sessionFromHash } from "./session-codec.ts";

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

test("2e — a fan-out session round-trips through encode / decode", () => {
  const s = emptySession(shape());
  const spec = { schemaNs: "chat", protocol: "Chat" } as const;
  const server = addInstance(s, { ...spec, role: "server" });
  const c1 = addInstance(s, { ...spec, role: "client" });
  const c2 = addInstance(s, { ...spec, role: "client" });
  setBehavior(s, server.id, "send", "reply", { value: { body: "HI", seq: 1 } });
  const conn1 = addConnection(s, c1.id, server.id);
  addConnection(s, c2.id, server.id);
  conn1.faults.dropProb = 0.5;
  conn1.faults.applyTo = "responses";
  s.seed = 99;
  s.clockMode = "stepped";
  s.latencyMs = 40;

  const round = decodeSession(encodeSession(s), shape())!;
  assert.ok(round, "decodes");

  assert.deepEqual(
    round.nodes.map((n) => [n.label, n.instanceIds.length]),
    s.nodes.map((n) => [n.label, n.instanceIds.length]),
  );
  assert.equal(round.instances.length, 3);
  assert.equal(round.connections.length, 2);
  assert.deepEqual(
    round.instances.find((i) => i.id === server.id)!.behaviors.send,
    { kind: "reply", config: { value: { body: "HI", seq: 1 } } },
  );
  assert.equal(round.connections.find((c) => c.id === conn1.id)!.faults.dropProb, 0.5);
  assert.equal(round.connections.find((c) => c.id === conn1.id)!.faults.applyTo, "responses");
  assert.equal(round.seed, 99);
  assert.equal(round.clockMode, "stepped");
  assert.equal(round.latencyMs, 40);
  assert.ok(round.shape.schemas.length === 1, "shape is re-attached, not part of the payload");

  // adding a new instance after a load doesn't collide with a restored id
  const fresh = addInstance(round, { ...spec, role: "client" });
  assert.ok(!round.instances.slice(0, -1).some((i) => i.id === fresh.id));
});

test("2e — a malformed fragment decodes to null", () => {
  assert.equal(decodeSession("not-base64-!!!", shape()), null);
  assert.equal(decodeSession(encodeSession(emptySession(shape())).slice(4), shape()), null);
  assert.equal(decodeSession(btoa("{}").replace(/=+$/, ""), shape()), null);
});

test("2e — sessionFromHash pulls the payload out of a URL hash", () => {
  assert.equal(sessionFromHash("#s=abc123"), "abc123");
  assert.equal(sessionFromHash("#foo&s=xy%2Fz"), "xy/z");
  assert.equal(sessionFromHash("#nothing"), null);
});
