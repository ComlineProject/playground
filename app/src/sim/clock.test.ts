/// Milestone 2d: a virtual clock. In `stepped` mode nothing timed happens until
/// `step` / `advance` moves time forward, and a run from a fixed seed is
/// reproducible frame for frame.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import initWasm, { describe_project } from "../wasm/comline_playground_wasm.js";
import type { ProjectShape } from "./shape.ts";
import { addConnection, addInstance, emptySession, setBehavior } from "./model.ts";
import { Wires } from "./engine.ts";
import { SteppedClock } from "./clock.ts";
import type { FaultSpec } from "./faults.ts";

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

test("SteppedClock — timers hold until time is moved forward", () => {
  const c = new SteppedClock();
  const fired: string[] = [];
  c.after(100, () => fired.push("a@100"));
  c.after(50, () => fired.push("b@50"));
  c.after(100, () => fired.push("c@100"));

  assert.equal(c.pending(), 3);
  assert.equal(c.now(), 0);
  assert.deepEqual(fired, []);

  c.step(); // earliest first
  assert.deepEqual(fired, ["b@50"]);
  assert.equal(c.now(), 50);

  c.advance(60); // to t=110 — both @100 fire in insertion order
  assert.deepEqual(fired, ["b@50", "a@100", "c@100"]);
  assert.equal(c.now(), 110);
  assert.equal(c.pending(), 0);
});

async function stepped(seed: number, faults: Partial<FaultSpec> = {}) {
  const session = emptySession(shape());
  session.clockMode = "stepped";
  session.seed = seed;
  session.callTimeoutMs = 100_000; // far away — we never advance that far
  const spec = { schemaNs: "chat", protocol: "Chat" } as const;
  const server = addInstance(session, { ...spec, role: "server" });
  const client = addInstance(session, { ...spec, role: "client" });
  setBehavior(session, server.id, "send", "reply", { value: { body: "HI", seq: 1 } });
  const conn = addConnection(session, client.id, server.id);
  Object.assign(conn.faults, faults);

  const clock = new SteppedClock();
  const wires = new Wires();
  wires.clock = clock;
  await wires.rebuild(session);
  return { session, wires, clock, conn };
}

test("2d — a paused clock holds a delayed reply until it is stepped past the delay", async () => {
  const { wires, clock, conn } = await stepped(1, {
    delayMin: 200,
    delayMax: 200,
    applyTo: "responses",
  });

  const p = wires.get(conn.id)!.call("send", { text: "x" });
  await tick();
  assert.ok(clock.pending() > 0, "the delayed reply is queued");

  const stillPending = async () =>
    (await Promise.race([
      p.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ])) === "pending";

  assert.ok(await stillPending(), "nothing lands while the clock is paused");
  clock.advance(150);
  assert.ok(await stillPending(), "still nothing 50 ms short of the delay");

  clock.advance(100); // now past 200
  assert.deepEqual(await p, { body: "HI", seq: 1 }, "the reply lands once time passes the delay");
  wires.closeAll();
});

test("2d — the same seed produces the same frame sequence twice", async () => {
  // corrupt + jittered delay on the reply: every call still completes (a bad
  // frame decodes to a parse error, not a hang), so no timeouts / rebuilds.
  const run = async () => {
    const { wires, clock, conn } = await stepped(42, {
      corruptProb: 0.5,
      delayMin: 15,
      delayMax: 120,
      applyTo: "responses",
    });
    for (let i = 0; i < 5; i++) {
      const p = wires
        .get(conn.id)!
        .call("send", { text: `m${i}` })
        .catch(() => "err");
      for (let s = 0; s < 5; s++) {
        await tick();
        clock.advance(40);
      }
      await p;
    }
    const sig = wires
      .get(conn.id)!
      .tap.frames.map((f) => [f.from, f.to, f.kind, f.fault ?? ""]);
    wires.closeAll();
    return sig;
  };

  const a = await run();
  const b = await run();
  assert.deepEqual(a, b, "byte-for-byte reproducible given the seed");
  assert.ok(
    a.some((r) => r[3].includes("corrupt") || r[3].includes("ms")),
    "faults actually happened over the run",
  );
});
