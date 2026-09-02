/// Milestone 1d acceptance, driven through the DOM (linkedom): drop a server
/// and a client onto the canvas, connect them via the inspector, send a call
/// from the call form, and see the reply + frames — then flip the server's
/// behaviour to Raise error and see the mapped error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseHTML } from "linkedom";

const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
// Node 24 already provides a minimal global `navigator` (no `clipboard`), which
// is exactly what the view's guarded `navigator.clipboard?.writeText` expects.
Object.assign(globalThis, { document, window });

const initWasm = (await import("../wasm/comline_playground_wasm.js")).default;
const { describe_project } = await import("../wasm/comline_playground_wasm.js");
await initWasm(
  readFileSync(fileURLToPath(new URL("../wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);
const { createSim } = await import("./ui/view.ts");
import type { ProjectShape } from "./shape.ts";

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

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function drop(canvas: Element, spec: unknown) {
  const ev = new window.Event("drop", { bubbles: true }) as Event & {
    dataTransfer: unknown;
    preventDefault(): void;
  };
  Object.assign(ev, {
    preventDefault() {},
    dataTransfer: { getData: () => JSON.stringify(spec) },
  });
  canvas.dispatchEvent(ev);
}
function fire(el: Element, type: string) {
  el.dispatchEvent(new window.Event(type, { bubbles: true }));
}
function pick(sel: HTMLSelectElement, value: string) {
  // linkedom single-select quirk: clear all, then set exactly one.
  for (const o of [...sel.options]) o.selected = false;
  const target = [...sel.options].find((o) => o.value === value);
  if (target) target.selected = true;
  fire(sel, "change");
}

test("1d — place, connect, call, and see the reply and frames", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());

  const canvas = sim.el.querySelector(".sim-canvas")!;
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "server" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });

  const nodes = [...sim.el.querySelectorAll(".sim-node")] as HTMLElement[];
  assert.equal(nodes.length, 2);
  const server = nodes.find((n) => n.classList.contains("role-server"))!;
  const client = nodes.find((n) => n.classList.contains("role-client"))!;

  // select the server, set `send` to Reply with a value
  fire(server, "click");
  const behaviorSel = sim.el.querySelector(".behavior-row .behavior-kind") as HTMLSelectElement;
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  assert.equal(behaviorSel.value, "reply");
  cfg.value = JSON.stringify({ value: { body: "HI", seq: 3 } });
  fire(cfg, "change");

  // select the client, connect it to the server
  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();

  // the call form appears; send `send`
  const fnSel = sim.el.querySelector(".call-fn") as HTMLSelectElement;
  assert.ok(fnSel, "call form is shown for a connected client");
  pick(fnSel, "send");
  const textInput = sim.el.querySelector(".call-args .arg-input") as HTMLInputElement;
  textInput.value = "hello";
  const sendBtn = [...sim.el.querySelectorAll(".call-form .sim-btn")].find(
    (b) => b.textContent === "send",
  ) as HTMLButtonElement;
  fire(sendBtn, "click");
  await tick();

  const out = sim.el.querySelector(".call-out")!;
  assert.match(out.textContent!, /"body": "HI"/);
  assert.ok(out.classList.contains("ok"));

  const frames = [...sim.el.querySelectorAll(".sim-frames-list .frame-row")] as HTMLElement[];
  assert.ok(frames.length >= 4, `expected handshake + call + reply frames, got ${frames.length}`);
  assert.ok(
    frames.some((r) => r.classList.contains("frame-handshake")),
    "handshake frames are labelled",
  );

  // expand the request frame — its decoded params are shown
  const reqRow = frames.find((r) => r.querySelector(".frame-fn")?.textContent === "send")!;
  (reqRow as HTMLDetailsElement).open = true;
  fire(reqRow, "toggle");
  assert.match(reqRow.querySelector(".frame-body")!.textContent!, /"text": "hello"/);
  assert.match(reqRow.querySelector(".frame-body")!.textContent!, /comline\.datagram/);

  sim.destroy();
});

test("1e — resyncing only the server after a schema edit refuses the handshake", async () => {
  const V1 = CHAT;
  const V2 = CHAT.replace("seq: u64", "seq: u64\n    tag: string"); // IR changes

  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(describe_project([{ path: "chat.ids", source: V1 }]) as ProjectShape);

  const canvas = sim.el.querySelector(".sim-canvas")!;
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "server" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });
  const nodes = [...sim.el.querySelectorAll(".sim-node")] as HTMLElement[];
  const server = nodes.find((n) => n.classList.contains("role-server"))!;
  const client = nodes.find((n) => n.classList.contains("role-client"))!;

  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();
  assert.ok(sim.el.querySelector(".sim-wire .wire-live"), "connected on V1");

  // edit the schema and return to simulate — both instances keep their V1 hash
  sim.setShape(describe_project([{ path: "chat.ids", source: V2 }]) as ProjectShape);
  await tick();
  assert.ok(sim.el.querySelector(".sim-wire .wire-live"), "still fine — neither end resynced");

  // resync ONLY the server, then it and the (still-V1) client disagree
  fire(sim.el.querySelector(`.sim-node[data-id="${server.dataset.id}"]`)!, "click");
  const resyncBtn = [...sim.el.querySelectorAll(".sim-inspector .sim-btn")].find((b) =>
    b.textContent!.startsWith("resync"),
  ) as HTMLButtonElement;
  assert.ok(resyncBtn, "a resync button is offered for the stale instance");
  fire(resyncBtn, "click");
  await tick();

  assert.ok(sim.el.querySelector(".sim-wire .wire-refused"), "the wire shows refused");
  assert.ok(sim.el.querySelector(".sim-frames-list .frame-refused"), "a refusal row is logged");
  assert.match(sim.el.querySelector(".sim-inspector")!.textContent!, /connection refused · handshake/);

  sim.destroy();
});

test("1d — flipping the server to Raise error surfaces the mapped error", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const canvas = sim.el.querySelector(".sim-canvas")!;
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "server" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });
  const nodes = [...sim.el.querySelectorAll(".sim-node")] as HTMLElement[];
  const server = nodes.find((n) => n.classList.contains("role-server"))!;
  const client = nodes.find((n) => n.classList.contains("role-client"))!;

  fire(server, "click");
  pick(sim.el.querySelector(".behavior-row .behavior-kind") as HTMLSelectElement, "raise");
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ ordinal: 0, data: { reason: "denied" } });
  fire(cfg, "change");

  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();

  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  const sendBtn = [...sim.el.querySelectorAll(".call-form .sim-btn")].find(
    (b) => b.textContent === "send",
  ) as HTMLButtonElement;
  fire(sendBtn, "click");
  await tick();

  const out = sim.el.querySelector(".call-out")!;
  assert.match(out.textContent!, /Rejected/);
  assert.match(out.textContent!, /denied/);
  assert.ok(out.classList.contains("err"));
  sim.destroy();
});
