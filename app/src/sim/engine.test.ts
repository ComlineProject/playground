/// Milestone 1c acceptance, scripted end to end: build a session, add a server
/// and a client, connect, and exercise the behaviours — Reply, Echo, Increment,
/// Raise error, Drop — plus the model ops (naming, removal, rebuild).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initWasm, { describe_project } from "../wasm/comline_playground_wasm.js";
import type { ProjectShape } from "./shape.ts";
import {
  addConnection,
  addInstance,
  emptySession,
  rebuild,
  removeInstance,
  setBehavior,
} from "./model.ts";
import { connect } from "./engine.ts";
import { SimRemoteError } from "./generic.ts";

await initWasm(
  readFileSync(fileURLToPath(new URL("../wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);

const CHAT = `struct Message {
    body: string
    seq: u64
}

error Rejected {
    message = "rejected"
    reason: string
}

protocol Chat {
    function send(text: string) -> Message ! Rejected;
    function note(text: string);
}
`;

const shape = () => describe_project([{ path: "chat.ids", source: CHAT }]) as ProjectShape;

function wired() {
  const session = emptySession(shape());
  const server = addInstance(session, { schemaNs: "chat", protocol: "Chat", role: "server" });
  const client = addInstance(session, { schemaNs: "chat", protocol: "Chat", role: "client" });
  const conn = addConnection(session, client.id, server.id);
  return { session, server, client, conn };
}

test("model — instance naming, seeded behaviours, removal drops the connection", () => {
  const session = emptySession(shape());
  const a = addInstance(session, { schemaNs: "chat", protocol: "Chat", role: "server" });
  const b = addInstance(session, { schemaNs: "chat", protocol: "Chat", role: "server" });
  assert.deepEqual([a.name, b.name], ["chat-1", "chat-2"]);
  assert.deepEqual(Object.keys(a.behaviors).sort(), ["note", "send"]);
  assert.equal(a.behaviors.send.kind, "reply");
  assert.equal(a.behaviors.note.kind, "drop"); // one-way default

  const client = addInstance(session, { schemaNs: "chat", protocol: "Chat", role: "client" });
  assert.deepEqual(client.behaviors, {});
  addConnection(session, client.id, a.id);
  removeInstance(session, a.id);
  assert.deepEqual(session.connections, []);
});

test("Reply with value returns the configured value", async () => {
  const { session, server, conn } = wired();
  setBehavior(session, server.id, "send", "reply", { value: { body: "HI", seq: 1 } });
  const live = await connect(session, conn);

  assert.deepEqual(await live.call("send", { text: "x" }), { body: "HI", seq: 1 });
  assert.equal(live.tap.frames.filter((f) => f.kind !== "handshake").length, 2);
  live.close();
});

test("Echo returns the params; a live behaviour swap takes effect on the next call", async () => {
  const { session, conn } = wired();
  const live = await connect(session, conn);

  live.setBehavior("send", { kind: "echo", config: {} });
  assert.deepEqual(await live.call("send", { text: "pong" }), { text: "pong" });

  live.setBehavior("send", { kind: "reply", config: { value: { body: "z", seq: 9 } } });
  assert.deepEqual(await live.call("send", { text: "x" }), { body: "z", seq: 9 });
  live.close();
});

test("Increment field bumps once per call", async () => {
  const { session, server, conn } = wired();
  setBehavior(session, server.id, "send", "increment", {
    base: { body: "b", seq: 0 },
    path: "seq",
  });
  const live = await connect(session, conn);

  assert.equal((await live.call("send", { text: "x" }) as { seq: number }).seq, 1);
  assert.equal((await live.call("send", { text: "x" }) as { seq: number }).seq, 2);
  assert.equal((await live.call("send", { text: "x" }) as { seq: number }).seq, 3);
  live.close();
});

test("Raise error comes back as SimRemoteError mapped to the ordinal's name", async () => {
  const { session, server, conn } = wired();
  setBehavior(session, server.id, "send", "raise", { ordinal: 0, data: { reason: "denied" } });
  const live = await connect(session, conn);

  await assert.rejects(
    () => live.call("send", { text: "x" }),
    (e: unknown) => {
      assert.ok(e instanceof SimRemoteError);
      assert.equal(e.ordinal, 0);
      assert.equal(e.errorName, "Rejected");
      assert.deepEqual(e.data, { reason: "denied" });
      return true;
    },
  );
  live.close();
});

test("Drop leaves the call pending", async () => {
  const { session, conn } = wired();
  const live = await connect(session, conn);
  live.setBehavior("send", { kind: "drop", config: {} });

  const race = await Promise.race([
    live.call("send", { text: "x" }).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 60)),
  ]);
  assert.equal(race, "pending");
  assert.equal(live.tap.frames.filter((f) => f.kind !== "handshake" && f.from === "server").length, 0);
  live.close();
});

test("rebuild keeps a surviving instance's behaviour config", () => {
  const { session, server } = wired();
  setBehavior(session, server.id, "send", "raise", { ordinal: 0, data: { reason: "keep me" } });
  rebuild(session, shape()); // same schema, recompiled

  const kept = session.instances.find((i) => i.id === server.id)!;
  assert.equal(kept.behaviors.send.kind, "raise");
  assert.deepEqual(kept.behaviors.send.config, { ordinal: 0, data: { reason: "keep me" } });
  assert.equal(session.connections.length, 1, "connection survives a same-shape rebuild");
});
