/// The simulate view, driven through the DOM (linkedom): drop instances on the
/// canvas, connect them (inspector dropdown or a port-to-node drag), send a
/// call, watch the frames — plus the 1e refusal path, the canvas polish (free
/// placement, drag-to-connect, frame filters), and 2a fan-out (many
/// connections, one merged log), and 2b node grouping (a gateway box).

import { existsSync, readFileSync } from "node:fs";
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
const initSim = (await import("comline-simulator")).default;
await initSim(
  readFileSync(
    fileURLToPath(
      new URL("../../node_modules/comline-simulator/pkg/comline_simulator_bg.wasm", import.meta.url),
    ),
  ),
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

// ── canvas polish ─────────────────────────────────────────────────────

function place(sim: { el: HTMLElement }) {
  const canvas = sim.el.querySelector(".sim-canvas")!;
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "server" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });
  const nodes = [...sim.el.querySelectorAll(".sim-node")] as HTMLElement[];
  return {
    canvas,
    server: nodes.find((n) => n.classList.contains("role-server"))!,
    client: nodes.find((n) => n.classList.contains("role-client"))!,
  };
}

test("polish — dropped nodes are absolutely placed and don't stack", () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const { server, client } = place(sim);

  const groups = [server, client].map((n) => n.closest(".sim-node-group") as HTMLElement);
  assert.equal(new Set(groups).size, 2, "each instance is in its own group");
  for (const g of groups) {
    assert.match(g.style.left, /^\d+px$/, "group is positioned by an inline offset");
    assert.match(g.style.top, /^\d+px$/);
  }
  assert.notEqual(groups[0].style.top, groups[1].style.top, "the two groups are offset, not stacked");
  assert.ok(server.querySelector(".node-port"), "each instance row has a connect port");
  sim.destroy();
});

test("polish — drag from a node's port to another node connects them", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const { server, client } = place(sim);
  assert.equal(sim.el.querySelector(".sim-wire .wire-live"), null, "not connected yet");

  fire(server.querySelector(".node-port")!, "pointerdown");
  fire(client, "pointerenter"); // the pointer is now over the client node
  window.dispatchEvent(new window.Event("pointerup"));
  await tick();

  assert.ok(sim.el.querySelector(".sim-wire .wire-live"), "the wire is live");
  assert.ok(sim.el.querySelector(".call-fn"), "the client's call form is shown");
  sim.destroy();
});

test("polish — the frame filter hides a kind and restores it", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const { server, client } = place(sim);

  fire(server, "click");
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "HI", seq: 1 } });
  fire(cfg, "change");
  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
    "click",
  );
  await tick();

  const rows = () => [...sim.el.querySelectorAll(".sim-frames-list .frame-row")] as HTMLElement[];
  const shownKinds = () => rows().filter((r) => !r.hidden).map((r) => r.dataset.kind);
  assert.ok(shownKinds().includes("handshake"));

  const hsFilter = [...sim.el.querySelectorAll(".frame-filter")].find(
    (b) => b.textContent === "handshake",
  ) as HTMLButtonElement;
  fire(hsFilter, "click");
  assert.ok(!shownKinds().includes("handshake"), "handshake rows hidden");
  assert.ok(shownKinds().includes("request"), "request rows still shown");
  assert.ok(!hsFilter.classList.contains("on"));

  fire(hsFilter, "click");
  assert.ok(shownKinds().includes("handshake"), "handshake rows back");
  sim.destroy();
});

test("polish — round-trip time shows on the reply, blank on the request", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const { server, client } = place(sim);

  fire(server, "click");
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "HI", seq: 1 } });
  fire(cfg, "change");
  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
    "click",
  );
  await tick();

  const rows = [...sim.el.querySelectorAll(".sim-frames-list .frame-row")] as HTMLElement[];
  const dt = (r: HTMLElement) => r.querySelector(".frame-delta")!.textContent ?? "";
  assert.equal(dt(rows.find((r) => r.dataset.kind === "request")!), "", "no wall-clock gap on a request");
  assert.match(
    dt(rows.find((r) => r.dataset.kind === "response")!),
    /^\d+ ms$/,
    "the reply carries a round-trip time",
  );
  sim.destroy();
});

test("polish — a long gap in virtual time inserts a filterable idle separator", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const { server, client } = place(sim);

  // a 5 s server-side delay puts the reply frame far ahead of the request
  fire(server, "click");
  pick(sim.el.querySelector(".behavior-kind") as HTMLSelectElement, "delay");
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ ms: 5000, value: { body: "HI", seq: 1 } });
  fire(cfg, "change");

  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
    "click",
  );
  await tick();

  const idle = sim.el.querySelector(".sim-frames-list .frame-idle") as HTMLElement;
  assert.ok(idle, "an idle separator was inserted");
  assert.match(idle.textContent!, /5s idle/);
  assert.equal(idle.dataset.kind, "idle");

  const idleFilter = [...sim.el.querySelectorAll(".frame-filter")].find(
    (b) => b.textContent === "idle",
  ) as HTMLButtonElement;
  assert.ok(idleFilter, "the header has an `idle` filter");
  fire(idleFilter, "click");
  assert.ok(idle.hidden, "the idle filter hides the separator");
  fire(idleFilter, "click");
  assert.ok(!idle.hidden, "and toggling it back shows it");

  sim.destroy();
});

test("2a — fan-out: one server, two clients, two connections; drop one, the other stays live", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const canvas = sim.el.querySelector(".sim-canvas")!;
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "server" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });

  const all = [...sim.el.querySelectorAll(".sim-node")] as HTMLElement[];
  const serverId = all.find((n) => n.classList.contains("role-server"))!.dataset.id!;
  const clientIds = all.filter((n) => n.classList.contains("role-client")).map((n) => n.dataset.id!);
  const node = (id: string) => sim.el.querySelector(`.sim-node[data-id="${id}"]`) as HTMLElement;
  const sendBtn = () =>
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find(
      (b) => b.textContent === "send",
    ) as HTMLButtonElement;

  // server replies with a constant
  fire(node(serverId), "click");
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "HI", seq: 1 } });
  fire(cfg, "change");

  // wire both clients to the one server
  for (const cid of clientIds) {
    fire(node(cid), "click");
    pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, serverId);
    await tick();
  }
  assert.equal(sim.el.querySelectorAll(".sim-wire .wire-live").length, 2, "two live wires");
  assert.equal(sim.el.querySelectorAll(".conn-filters .frame-filter").length, 2, "a filter per connection");

  // each client calls send and gets the reply
  for (const cid of clientIds) {
    fire(node(cid), "click");
    pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
    fire(sendBtn(), "click");
    await tick();
    assert.match(sim.el.querySelector(".call-out")!.textContent!, /"body": "HI"/);
  }
  const conns = new Set(
    [...sim.el.querySelectorAll(".sim-frames-list .frame-row")].map((r) => (r as HTMLElement).dataset.conn),
  );
  assert.equal(conns.size, 2, "the log carries frames from both connections");

  // drop the first client's connection — the second stays live and callable
  fire(node(clientIds[0]), "click");
  fire(sim.el.querySelector(".conn-x") as HTMLElement, "click");
  await tick();
  assert.equal(sim.el.querySelectorAll(".sim-wire .wire-live").length, 1, "one wire left");

  fire(node(clientIds[1]), "click");
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(sendBtn(), "click");
  await tick();
  assert.match(sim.el.querySelector(".call-out")!.textContent!, /"body": "HI"/, "client 2 still works");

  sim.destroy();
});

test("2b — a node hosts a client and a server; the grouped gateway relays a call", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const canvas = sim.el.querySelector(".sim-canvas")!;
  const spec = { schemaNs: "chat", protocol: "Chat" };
  const groups = () => [...sim.el.querySelectorAll(".sim-node-group")] as HTMLElement[];
  const rows = (root: ParentNode = sim.el) => [...root.querySelectorAll(".sim-node")] as HTMLElement[];
  const sendBtn = () =>
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send") as HTMLButtonElement;

  // one box hosting the edge server AND the edge client — the gateway
  drop(canvas, { ...spec, role: "server" });
  const gatewayId = groups()[0].dataset.nodeId!;
  const gatewayEl = () => sim.el.querySelector(`.sim-node-group[data-node-id="${gatewayId}"]`)!;
  drop(gatewayEl(), { ...spec, role: "client" }); // drop onto the box → adds to it
  assert.equal(rows(gatewayEl()).length, 2, "the gateway box holds two instances");
  assert.equal(groups().length, 1);

  // a backend server and a caller client, each its own box
  drop(canvas, { ...spec, role: "server" });
  drop(canvas, { ...spec, role: "client" });
  assert.equal(groups().length, 3);

  const gateway = gatewayEl();
  const edgeSrv = rows(gateway).find((n) => n.classList.contains("role-server"))!;
  const edgeCli = rows(gateway).find((n) => n.classList.contains("role-client"))!;
  const backend = rows().find(
    (n) => n.classList.contains("role-server") && !gateway.contains(n),
  )!;
  const caller = rows().find(
    (n) => n.classList.contains("role-client") && !gateway.contains(n),
  )!;
  const backendName = backend.querySelector(".node-name")!.textContent!;

  const connect = (fromPort: Element, toNode: Element) => {
    fire(fromPort.querySelector(".node-port")!, "pointerdown");
    fire(toNode, "pointerenter");
    window.dispatchEvent(new window.Event("pointerup"));
  };
  connect(edgeCli, backend); // edge-client → backend
  await tick();
  connect(caller, sim.el.querySelector(`.sim-node[data-id="${edgeSrv.dataset.id}"]`)!); // caller → edge-server
  await tick();
  assert.equal(sim.el.querySelectorAll(".sim-wire .wire-live").length, 2);

  // backend replies with a constant
  fire(sim.el.querySelector(`.sim-node[data-id="${backend.dataset.id}"]`)!, "click");
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "FROM-BACKEND", seq: 7 } });
  fire(cfg, "change");

  // edge-server forwards `send` over the edge-client → backend connection
  fire(sim.el.querySelector(`.sim-node[data-id="${edgeSrv.dataset.id}"]`)!, "click");
  pick(sim.el.querySelector(".behavior-row .behavior-kind") as HTMLSelectElement, "forward");
  const via = sim.el.querySelector(".forward-via") as HTMLSelectElement;
  const toBackend = [...via.options].find((o) => o.textContent!.endsWith(backendName))!;
  pick(via, toBackend.value);

  // caller calls send → the reply comes from the backend, through the gateway
  fire(sim.el.querySelector(`.sim-node[data-id="${caller.dataset.id}"]`)!, "click");
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(sendBtn(), "click");
  await tick();
  assert.match(sim.el.querySelector(".call-out")!.textContent!, /"body": "FROM-BACKEND"/);

  sim.destroy();
});

test("2b — the inspector adds a second instance to a box (a gateway without dragging)", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  const canvas = sim.el.querySelector(".sim-canvas")!;
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "server" });

  fire(sim.el.querySelector(".sim-node") as HTMLElement, "click");
  const addSel = sim.el.querySelector(".add-inst-sel") as HTMLSelectElement;
  assert.ok(addSel, "the box section offers an add-instance select");
  const clientOpt = [...addSel.options].find((o) => o.textContent === "Chat · client")!;
  pick(addSel, clientOpt.value);
  await tick();

  const groups = sim.el.querySelectorAll(".sim-node-group");
  assert.equal(groups.length, 1, "still a single box");
  assert.equal(groups[0].querySelectorAll(".sim-node").length, 2, "now hosting two instances");
  sim.destroy();
});

test("2b — each instance in a shared box is individually selectable", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  drop(sim.el.querySelector(".sim-canvas")!, { schemaNs: "chat", protocol: "Chat", role: "server" });

  fire(sim.el.querySelector(".sim-node") as HTMLElement, "click");
  const addSel = sim.el.querySelector(".add-inst-sel") as HTMLSelectElement;
  pick(addSel, [...addSel.options].find((o) => o.textContent === "Chat · client")!.value);
  await tick();

  const rowNames = () =>
    [...sim.el.querySelectorAll(".sim-node-group .sim-node")].map(
      (r) => r.querySelector(".node-name")!.textContent!,
    );
  assert.equal(rowNames().length, 2, "one box, two rows");

  for (const target of rowNames()) {
    const row = [...sim.el.querySelectorAll(".sim-node-group .sim-node")].find(
      (r) => r.querySelector(".node-name")!.textContent === target,
    )!;
    fire(row, "click");
    assert.match(sim.el.querySelector(".sim-inspector")!.textContent!, new RegExp(`instance\\s*${target}`));
    const selected = [...sim.el.querySelectorAll(".sim-node-group .sim-node.selected")];
    assert.equal(selected.length, 1, "exactly one row is marked selected");
    assert.equal(selected[0].querySelector(".node-name")!.textContent, target);
  }
  sim.destroy();
});

test("2b — a box is named `Machine N` and its header renames on double-click", async () => {
  const sim = createSim();
  document.body.append(sim.el);
  sim.setShape(shape());
  drop(sim.el.querySelector(".sim-canvas")!, { schemaNs: "chat", protocol: "Chat", role: "server" });

  const cap = () => sim.el.querySelector(".sim-node-group .group-cap") as HTMLElement;
  assert.match(cap().textContent!, /^Machine \d+$/, "the default box name is Machine N");

  fire(cap(), "dblclick");
  const input = sim.el.querySelector(".group-rename") as HTMLInputElement;
  assert.ok(input, "double-click opens a rename field");
  assert.match(input.value, /^Machine \d+$/);
  input.value = "gateway";
  fire(input, "blur");
  assert.equal(cap().textContent, "gateway", "the header shows the new name");

  fire(sim.el.querySelector(".sim-node") as HTMLElement, "click");
  assert.match(sim.el.querySelector(".sim-inspector")!.textContent!, /box · gateway/i);
  sim.destroy();
});

test("2c — the fault inspector drops responses: the edge goes faulty and the call times out", async () => {
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
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "HI", seq: 1 } });
  fire(cfg, "change");

  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();
  // shorten the client's wait so the timeout fires fast
  const timeout = [...sim.el.querySelectorAll(".sim-inspector input[type=number]")].find((i) =>
    (i as HTMLInputElement).title.includes("timeout"),
  ) as HTMLInputElement;
  timeout.value = "120";
  fire(timeout, "change");
  await tick();

  // select the connection edge, drop every response
  fire(sim.el.querySelector(".sim-wire line")!, "click");
  const applyTo = sim.el.querySelector(".fault-ctls select") as HTMLSelectElement;
  pick(applyTo, "responses");
  const dropSlider = sim.el.querySelector('.fault-ctls input[type="range"]') as HTMLInputElement;
  dropSlider.value = "100";
  fire(dropSlider, "input");
  assert.ok(sim.el.querySelector(".sim-wire .wire-faulty"), "the edge shows faulty");

  // now call from the client and watch it time out
  fire(client, "click");
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
    "click",
  );
  await tick(220);
  assert.match(sim.el.querySelector(".call-out")!.textContent!, /timeout/i);

  // a dropped response frame is greyed / labelled in the log
  const dropped = [...sim.el.querySelectorAll(".sim-frames-list .frame-row")].find((r) =>
    /dropped/.test(r.querySelector(".frame-kind")?.textContent ?? ""),
  );
  assert.ok(dropped, "the dropped response is shown in the frame log");
  sim.destroy();
});

test("2d — stepped clock: a delayed reply lands only after the step button is pressed", async () => {
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
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "HI", seq: 1 } });
  fire(cfg, "change");
  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();

  // switch the clock to stepped
  pick(sim.el.querySelector(".clock-mode") as HTMLSelectElement, "stepped");
  await tick();

  // 300 ms delay on the response
  fire(sim.el.querySelector(".sim-wire line")!, "click");
  pick(sim.el.querySelector(".fault-ctls select") as HTMLSelectElement, "responses");
  const nums = [...sim.el.querySelectorAll('.fault-ctls input[type="number"]')] as HTMLInputElement[];
  nums[0].value = "300";
  fire(nums[0], "change");
  nums[1].value = "300";
  fire(nums[1], "change");

  // call — it should hang while the clock is paused
  fire(client, "click");
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
    "click",
  );
  await tick(40);
  const out = () => sim.el.querySelector(".call-out")!.textContent ?? "";
  assert.doesNotMatch(out(), /"body": "HI"/, "nothing lands while paused");

  const stepBtn = () =>
    [...sim.el.querySelectorAll(".clock-btn")].find((b) => b.textContent === "⏭") as HTMLButtonElement;
  assert.ok(stepBtn() && !stepBtn().disabled, "the step button is offered with a timer queued");

  // step the clock forward — each event is one step (request delivery, then the
  // 300 ms-delayed response); the reply lands once time passes the delay
  for (let i = 0; i < 6 && !out().includes('"body": "HI"'); i++) {
    fire(stepBtn(), "click");
    await tick(20);
  }
  assert.match(out(), /"body": "HI"/, "the reply lands once time is stepped past the delay");

  sim.destroy();
});

test("2e — a serialized session restores its nodes, connections and live wires", async () => {
  const build = createSim();
  document.body.append(build.el);
  build.setShape(shape());
  const canvas = build.el.querySelector(".sim-canvas")!;
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "server" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });
  drop(canvas, { schemaNs: "chat", protocol: "Chat", role: "client" });

  const all = [...build.el.querySelectorAll(".sim-node")] as HTMLElement[];
  const serverId = all.find((n) => n.classList.contains("role-server"))!.dataset.id!;
  const clientIds = all.filter((n) => n.classList.contains("role-client")).map((n) => n.dataset.id!);
  const node = (root: ParentNode, id: string) =>
    root.querySelector(`.sim-node[data-id="${id}"]`) as HTMLElement;

  // reply constant + two connections (a fan-out)
  fire(node(build.el, serverId), "click");
  const cfg = build.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "SHARED", seq: 5 } });
  fire(cfg, "change");
  for (const cid of clientIds) {
    fire(node(build.el, cid), "click");
    pick(build.el.querySelector(".connect-sel") as HTMLSelectElement, serverId);
    await tick();
  }
  assert.equal(build.el.querySelectorAll(".sim-wire .wire-live").length, 2);

  const payload = build.serialize();
  assert.ok(payload.length > 20);
  build.destroy();

  // a fresh view, same schema, restored from the payload
  const restored = createSim();
  document.body.append(restored.el);
  restored.setShape(shape(), payload);
  await tick();

  assert.equal(restored.el.querySelectorAll(".sim-node-group").length, 3, "3 boxes back");
  assert.equal(restored.el.querySelectorAll(".sim-wire .wire-live").length, 2, "2 wires reconnected");

  // and a call over a restored wire still works
  const rClient = [...restored.el.querySelectorAll(".sim-node.role-client")][0] as HTMLElement;
  fire(rClient, "click");
  pick(restored.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(
    [...restored.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
    "click",
  );
  await tick();
  assert.match(restored.el.querySelector(".call-out")!.textContent!, /"body": "SHARED"/);
  restored.destroy();
});

test("2e — record a call through the UI, then replay it", async () => {
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
  const cfg = sim.el.querySelector(".behavior-config") as HTMLTextAreaElement;
  cfg.value = JSON.stringify({ value: { body: "REC", seq: 4 } });
  fire(cfg, "change");
  fire(client, "click");
  pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
  await tick();

  const clockBtn = (text: string) =>
    [...sim.el.querySelectorAll(".clock-btn")].find((b) => b.textContent === text) as HTMLButtonElement;

  // start recording via the header button
  fire(clockBtn("● rec"), "click");
  assert.ok(clockBtn("■ stop"), "the rec button flips to stop");

  // send a call — captured
  fire(client, "click");
  pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
  fire(
    [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
    "click",
  );
  await tick(30);
  assert.match(sim.el.querySelector(".call-out")!.textContent!, /"body": "REC"/);

  // stop → a replay button appears
  fire(clockBtn("■ stop"), "click");
  const replayBtn = clockBtn("▷ replay");
  assert.ok(replayBtn, "a replay button is offered once a recording exists");

  // replay — the call re-runs; frames reappear on a fresh (stepped) engine
  fire(replayBtn, "click");
  await tick(60);
  const nonHs = [...sim.el.querySelectorAll(".sim-frames-list .frame-row")].filter(
    (r) => (r as HTMLElement).dataset.kind !== "handshake",
  );
  assert.ok(nonHs.length >= 2, "the replayed call's request + response are in the log");
  assert.ok(sim.el.querySelector(".sim-wire .wire-live"), "the wire is live after replay");
  assert.equal((sim.el.querySelector(".clock-mode") as HTMLSelectElement).value, "stepped");
  sim.destroy();
});

// ── 2f — scripted behaviour (Rhai), lazy-loaded ──────────────────────
const scriptedWasm = fileURLToPath(
  new URL(
    "../../node_modules/comline-simulator/pkg-script/comline_simulator_bg.wasm",
    import.meta.url,
  ),
);
const loadScripted = async () => {
  const m = await import("comline-simulator/pkg-script/comline_simulator.js");
  await m.default(readFileSync(scriptedWasm));
  return { Sim: m.Sim };
};

test(
  "2f — picking `script` pulls the scripted wasm and runs a Rhai reply",
  { skip: existsSync(scriptedWasm) ? false : "set COMLINE_SIMULATOR_SCRIPT=1 and reinstall" },
  async () => {
    const sim = createSim({ loadScripted });
    document.body.append(sim.el);
    sim.setShape(shape());
    const { server, client } = place(sim);

    fire(server, "click");
    // `script` is offered even though the lean wasm is loaded; picking it swaps
    // in the scripted engine before the behaviour takes effect.
    pick(sim.el.querySelector(".behavior-row .behavior-kind") as HTMLSelectElement, "script");
    for (let i = 0; i < 20 && !sim.el.querySelector(".behavior-config.script"); i++) await tick(20);
    const src = sim.el.querySelector(".behavior-row .behavior-config.script") as HTMLTextAreaElement;
    assert.ok(src, "the script source box replaced the JSON config box");

    src.value = `#{ body: params.text + "!", seq: 7 }`;
    fire(src, "change");

    fire(client, "click");
    pick(sim.el.querySelector(".connect-sel") as HTMLSelectElement, server.dataset.id!);
    await tick();
    pick(sim.el.querySelector(".call-fn") as HTMLSelectElement, "send");
    (sim.el.querySelector(".call-args .arg-input") as HTMLInputElement).value = "hello";
    fire(
      [...sim.el.querySelectorAll(".call-form .sim-btn")].find((b) => b.textContent === "send")!,
      "click",
    );
    await tick(40);

    const out = sim.el.querySelector(".call-out")!;
    assert.match(out.textContent!, /"body": "hello!"/);
    assert.match(out.textContent!, /"seq": 7/);
    assert.ok(out.classList.contains("ok"));
    sim.destroy();
  },
);
