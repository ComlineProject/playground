/// Milestone 2e (replay half): a recorded run replays to a byte-identical frame
/// log — the engine's regression guard.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initWasm, { describe_project } from "../wasm/comline_playground_wasm.js";
import type { ProjectShape } from "./shape.ts";
import { addConnection, addInstance, emptySession, setBehavior } from "./model.ts";
import { Wires } from "./engine.ts";
import { SteppedClock } from "./clock.ts";
import { Recorder, replayRecording } from "./record.ts";

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
const tick = () => new Promise((r) => setTimeout(r, 0));
const sig = (wires: Wires, connId: string) =>
  wires.get(connId)!.tap.frames.map((f) => [f.from, f.to, f.kind, f.fault ?? ""]);

test("2e — a 3-call recording (with a mid-run behaviour flip and faults) replays identically", async () => {
  const session = emptySession(shape());
  session.clockMode = "stepped";
  session.seed = 7;
  const spec = { schemaNs: "chat", protocol: "Chat" } as const;
  const server = addInstance(session, { ...spec, role: "server" });
  const client = addInstance(session, { ...spec, role: "client" });
  setBehavior(session, server.id, "send", "reply", { value: { body: "A", seq: 1 } });
  const conn = addConnection(session, client.id, server.id);
  conn.faults.corruptProb = 0.4;
  conn.faults.delayMin = 20;
  conn.faults.delayMax = 90;
  conn.faults.applyTo = "responses";

  const clock = new SteppedClock();
  const wires = new Wires();
  wires.clock = clock;
  await wires.rebuild(session);

  const rec = new Recorder();
  rec.start(session, clock.now());

  const doCall = async (text: string) => {
    rec.capture({ kind: "call", connId: conn.id, fn: "send", params: { text } }, clock.now());
    const p = wires
      .get(conn.id)!
      .call("send", { text })
      .catch(() => undefined);
    for (let s = 0; s < 5; s++) {
      await tick();
      clock.advance(40);
    }
    await p;
  };

  await doCall("one");

  // flip the reply mid-run
  const flip = { kind: "reply" as const, config: { value: { body: "B", seq: 2 } } };
  rec.capture({ kind: "behavior", instanceId: server.id, fn: "send", setting: flip }, clock.now());
  setBehavior(session, server.id, "send", flip.kind, flip.config);
  wires.get(conn.id)!.setBehavior("send", flip);

  await doCall("two");

  // widen the delay mid-run
  conn.faults.delayMax = 200;
  rec.capture({ kind: "fault", connId: conn.id, faults: { ...conn.faults } }, clock.now());

  await doCall("three");

  const recording = rec.stop();
  const original = sig(wires, conn.id);
  wires.closeAll();

  assert.ok(recording.events.length === 5, "3 calls + 1 behaviour + 1 fault captured");

  const r = await replayRecording(recording, shape());
  const replayed = sig(r.wires, conn.id);
  r.wires.closeAll();

  assert.deepEqual(replayed, original, "replay reproduces the frame log frame for frame");
  assert.ok(
    original.some((row) => row[3] !== ""),
    "faults actually occurred in the run",
  );
});
