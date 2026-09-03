/// Milestone 2c: an unreliable wire. Scripted end to end — a fault on a
/// connection's `FaultSpec` (mutated in place) changes what the next frame
/// does, with no reconnect.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initWasm, { describe_project } from "../wasm/comline_playground_wasm.js";
import type { ProjectShape } from "./shape.ts";
import { addConnection, addInstance, emptySession, setBehavior } from "./model.ts";
import { Wires } from "./engine.ts";
import { RuntimeError } from "./runtime/index.ts";

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

function wired(callTimeoutMs = 150) {
  const session = emptySession(shape());
  session.callTimeoutMs = callTimeoutMs;
  const spec = { schemaNs: "chat", protocol: "Chat" } as const;
  const server = addInstance(session, { ...spec, role: "server" });
  const client = addInstance(session, { ...spec, role: "client" });
  setBehavior(session, server.id, "send", "reply", { value: { body: "HI", seq: 1 } });
  const conn = addConnection(session, client.id, server.id);
  return { session, server, client, conn };
}

const isTimeout = (e: unknown) => e instanceof RuntimeError && e.kind === "timeout";

test("2c — dropping every response makes the call time out, and clearing it restores service", async () => {
  const { session, conn } = wired(120);
  conn.faults.dropProb = 1;
  conn.faults.applyTo = "responses";

  const wires = new Wires();
  await wires.sync(session);

  await assert.rejects(() => wires.get(conn.id)!.call("send", { text: "x" }), isTimeout);
  assert.equal(wires.get(conn.id)!.dead(), true, "the client is dead after a timeout");

  // a timed-out client is desynced — clearing the fault isn't enough, reconnect
  conn.faults.dropProb = 0;
  await wires.rebuild(session);
  assert.deepEqual(await wires.get(conn.id)!.call("send", { text: "x" }), { body: "HI", seq: 1 });

  wires.closeAll();
});

test("2c — a partition cuts the wire both ways; lifting it restores service", async () => {
  const { session, conn } = wired(120);
  const wires = new Wires();
  await wires.sync(session);

  assert.deepEqual(await wires.get(conn.id)!.call("send", { text: "x" }), { body: "HI", seq: 1 });

  conn.faults.partition = true;
  await assert.rejects(() => wires.get(conn.id)!.call("send", { text: "x" }), isTimeout);

  conn.faults.partition = false;
  await wires.rebuild(session);
  assert.deepEqual(await wires.get(conn.id)!.call("send", { text: "x" }), { body: "HI", seq: 1 });

  wires.closeAll();
});

test("2c — a corrupted response frame is marked on the tap and fails the call", async () => {
  const { session, conn } = wired(300);
  conn.faults.corruptProb = 1;
  conn.faults.applyTo = "responses";

  const wires = new Wires();
  await wires.sync(session);
  const lc = wires.get(conn.id)!;

  let result: unknown = "<rejected>";
  try {
    result = await lc.call("send", { text: "x" });
  } catch {
    /* a mangled frame that won't decode — also fine */
  }
  assert.notDeepEqual(result, { body: "HI", seq: 1 }, "a corrupted reply is never delivered intact");
  assert.ok(
    lc.tap.frames.some((f) => (f.fault ?? "").includes("corrupt")),
    "a response frame is annotated corrupted",
  );

  conn.faults.corruptProb = 0;
  await wires.rebuild(session);
  assert.deepEqual(await wires.get(conn.id)!.call("send", { text: "x" }), { body: "HI", seq: 1 });
  wires.closeAll();
});

test("2c — dropping requests times the call out before the server sees it", async () => {
  const { session, conn } = wired(120);
  conn.faults.dropProb = 1;
  conn.faults.applyTo = "requests";

  const wires = new Wires();
  await wires.sync(session);
  const lc = wires.get(conn.id)!;

  await assert.rejects(() => lc.call("send", { text: "x" }), isTimeout);
  // the request frame is on the tap (recorded) but marked dropped
  assert.ok(lc.tap.frames.some((f) => (f.fault ?? "").includes("dropped")));
  wires.closeAll();
});
