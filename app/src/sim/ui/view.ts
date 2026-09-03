/// The full-width simulate view: a palette of protocol × role, a canvas of node
/// boxes (each hosting one or more instances), the connections between
/// instances, an inspector (instance facts, per-function behaviours,
/// per-connection controls, and — for a connected client — the call form), and
/// the merged frame list.
///
/// The engine is `comline-simulator` (Rust → WASM) now. This module holds a
/// `Sim`, mirrors its `session_json()` for rendering, and drives it — a call is
/// `sim.call()` + advancing the clock + polling `sim.result()`; the frame log
/// polls `sim.frames()`.

import { findProtocol, type ProjectShape, type ThrowShape } from "../shape.ts";
import { Sim } from "comline-simulator";
import { argsForm, type ArgsForm } from "./argsform.ts";
import { frameLog, type ClockBar, type Frame, type FrameSource, type LogSource } from "./framelog.ts";

const SVGNS = "http://www.w3.org/2000/svg";

/** Mirrors `comline-simulator`'s `DEFAULT_SCRIPT` — a fresh `script` behaviour
 *  starts as an echo, with the scope contract spelled out in a comment. */
const DEFAULT_SCRIPT = `// \`params\` is the decoded request. \`state\` is a map that persists between
// calls. The last expression is the reply; \`throw\` raises an error.
params`;

type Role = "server" | "client";

interface Faults {
  dropProb: number;
  delayMin: number;
  delayMax: number;
  reorderWindow: number;
  corruptProb: number;
  partition: boolean;
  applyTo: "requests" | "responses" | "both";
}

interface ModelNode {
  id: string;
  label: string;
  x: number;
  y: number;
  instanceIds: string[];
}
interface ModelInstance {
  id: string;
  name: string;
  role: Role;
  schemaNs: string;
  protocol: string;
  behaviors: Record<string, { kind: string; config: unknown }>;
  irHash: string;
  nodeId: string;
}
interface ModelConn {
  id: string;
  clientId: string;
  serverId: string;
  faults: Faults;
  framing: "auto" | "datagram" | "jsonrpc";
  wireFormat: "json" | "msgpack";
}
interface Model {
  nodes: ModelNode[];
  instances: ModelInstance[];
  connections: ModelConn[];
  latencyMs: number;
  callTimeoutMs: number;
  seed: number;
  clockMode: "real" | "stepped";
}

/** A `Sim.record_stop()` payload. */
export interface Recording {
  v: number;
  session: string;
  events: unknown[];
}

export interface SimView {
  el: HTMLElement;
  /** Point at a freshly compiled shape (schemas were edited). Pass a `#s=`
   *  fragment payload to restore a shared session against that shape. */
  setShape(shape: ProjectShape, serialized?: string | null): void;
  /** The current session as a URL-fragment payload. */
  serialize(): string;
  /** Start / stop capturing inputs; `stop` returns the recording. */
  record(on: boolean): Recording | null;
  /** Re-run a recording, into this view. */
  replay(rec: Recording): Promise<void>;
  destroy(): void;
}

function faultsActive(f: Faults): boolean {
  return (
    f.partition ||
    f.dropProb > 0 ||
    f.corruptProb > 0 ||
    f.reorderWindow > 0 ||
    f.delayMax > 0
  );
}

export interface SimOpts {
  /** Test seam: hand back the scripted sim module instead of `import()`ing it
   *  (which, in a build, is a code-split fetch of the heavier Rhai wasm). */
  loadScripted?: () => Promise<{ Sim: typeof Sim }>;
}

export function createSim(opts: SimOpts = {}): SimView {
  let sim: Sim | null = null;
  let shape: ProjectShape | null = null;
  let shapeJson = "";
  let model: Model | null = null;
  let clockMode: "real" | "stepped" = "real";
  let selectedId: string | null = null;
  let selectedConnId: string | null = null;
  let callForm: ArgsForm | null = null;
  let lastRecording: Recording | null = null;
  let playHandle: ReturnType<typeof setInterval> | null = null;
  let speed = 1;
  const pendingCalls = new Map<number, { out: HTMLElement; throws: ThrowShape[] }>();

  // Scripting (the Rhai `script` behaviour) rides a ~4× heavier wasm, so it is
  // loaded only once a `script` behaviour is actually picked. `SimClass` starts
  // lean; `ensureScripted` swaps in the scripted class and re-seats the live
  // session on it (via the `#s=` link), after which every rebuild uses it too.
  let SimClass: typeof Sim = Sim;
  let scripted = false;
  const loadScripted =
    opts.loadScripted ??
    (async () => {
      // Same surface as the lean module, just Rhai-enabled — hence the cast
      // (the `pkg-script/` ambient is deliberately opaque). Vite code-splits
      // this dynamic import, so the ~2 MB scripted wasm only downloads here.
      const m = (await import(
        "comline-simulator/pkg-script/comline_simulator.js"
      )) as typeof import("comline-simulator");
      const { default: wasmUrl } = await import(
        "comline-simulator/pkg-script/comline_simulator_bg.wasm?url"
      );
      await m.default({ module_or_path: wasmUrl });
      return { Sim: m.Sim };
    });
  async function ensureScripted(): Promise<boolean> {
    if (scripted) return true;
    try {
      SimClass = (await loadScripted()).Sim;
      if (sim) {
        const link = sim.link();
        const next = new SimClass(shapeJson, link);
        sim.free();
        sim = next;
      }
      scripted = true;
      return true;
    } catch (err) {
      flashInspectorError(`scripting unavailable · ${String((err as Error).message ?? err)}`);
      return false;
    }
  }
  const sessionHasScript = () =>
    !!model?.instances.some((i) => Object.values(i.behaviors).some((b) => b.kind === "script"));

  const el = div("sim");
  const paletteEl = div("sim-col sim-palette");
  const canvasEl = div("sim-col sim-canvas");
  const inspectorEl = div("sim-col sim-inspector");
  const wireSvg = document.createElementNS(SVGNS, "svg");
  wireSvg.setAttribute("class", "sim-wire");
  canvasEl.append(wireSvg);
  const flog = frameLog();

  el.append(
    labelled("palette", paletteEl),
    labelled("canvas", canvasEl),
    inspectorEl,
    flog.el,
  );

  const onResize = () => drawWires();
  window.addEventListener("resize", onResize);

  const frameApi: FrameSource = {
    frames: (connId) => (sim ? (JSON.parse(sim.frames(connId)) as Frame[]) : []),
    detail: (connId, seq) => {
      const d = sim?.describe_frame(connId, seq);
      return d ? JSON.parse(d) : null;
    },
  };

  // ── model mirror ─────────────────────────────────────────────────────
  function refresh() {
    model = sim ? (JSON.parse(sim.session_json()) as Model) : null;
    if (model) clockMode = model.clockMode;
  }
  const inst = (id: string) => model?.instances.find((i) => i.id === id) ?? null;
  const node = (id: string) => model?.nodes.find((n) => n.id === id) ?? null;
  const connsFor = (id: string) =>
    model?.connections.filter((c) => c.clientId === id || c.serverId === id) ?? [];
  const live = (connId: string) =>
    sim ? !sim.connection_error(connId) && !sim.connection_dead(connId) : false;

  // ── palette ──────────────────────────────────────────────────────────
  function renderPalette() {
    paletteEl.replaceChildren();
    if (!shape) return;
    for (const schema of shape.schemas) {
      for (const protocol of schema.protocols) {
        const group = div("palette-group");
        const title = document.createElement("div");
        title.className = "palette-proto";
        title.textContent = protocol.name;
        group.append(title);
        for (const role of ["server", "client"] as Role[]) {
          const chip = document.createElement("div");
          chip.className = `palette-chip role-${role}`;
          chip.textContent = role;
          chip.draggable = true;
          chip.addEventListener("dragstart", (e) => {
            e.dataTransfer?.setData(
              "application/json",
              JSON.stringify({ schemaNs: schema.namespace, protocol: protocol.name, role }),
            );
          });
          group.append(chip);
        }
        paletteEl.append(group);
      }
    }
    const hint = document.createElement("p");
    hint.className = "muted pad";
    hint.textContent = "drag onto the canvas — or onto an existing box to group them (a gateway)";
    paletteEl.append(hint);
  }

  // ── canvas ───────────────────────────────────────────────────────────
  let hoverId: string | null = null;

  const dropHint = document.createElement("p");
  dropHint.className = "muted pad canvas-hint";
  dropHint.textContent =
    "drag roles here — drop onto a box to add to it (a gateway), then drag between ports";
  canvasEl.append(dropHint);

  function canvasPoint(e: { clientX?: number; clientY?: number }): { x: number; y: number } | null {
    if (typeof e.clientX !== "number" || typeof e.clientY !== "number") return null;
    const r = canvasEl.getBoundingClientRect();
    return { x: e.clientX - r.left + canvasEl.scrollLeft, y: e.clientY - r.top + canvasEl.scrollTop };
  }

  const clearDropTarget = () => {
    for (const g of canvasEl.querySelectorAll(".sim-node-group.drop-target")) {
      g.classList.remove("drop-target");
    }
  };
  canvasEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    const g = (e.target as HTMLElement | null)?.closest<HTMLElement>(".sim-node-group");
    if (g?.classList.contains("drop-target")) return;
    clearDropTarget();
    g?.classList.add("drop-target");
  });
  canvasEl.addEventListener("dragleave", (e) => {
    if (e.target === canvasEl) clearDropTarget();
  });
  canvasEl.addEventListener("drop", (e) => {
    e.preventDefault();
    clearDropTarget();
    const raw = e.dataTransfer?.getData("application/json");
    if (!raw || !sim || !model) return;
    const spec = JSON.parse(raw) as { schemaNs: string; protocol: string; role: Role };
    const ontoNode = (e.target as HTMLElement | null)?.closest<HTMLElement>(".sim-node-group");
    const p = canvasPoint(e);
    const n = model.nodes.length;
    const place = ontoNode?.dataset.nodeId
      ? { ...spec, nodeId: ontoNode.dataset.nodeId }
      : {
          ...spec,
          x: Math.max(8, (p?.x ?? 48 + n * 34) - 75),
          y: Math.max(8, (p?.y ?? 48 + n * 30) - 26),
        };
    const id = sim.add_instance(JSON.stringify(place));
    selectedId = id;
    selectedConnId = null;
    redraw();
  });

  function nodeEl(instanceId: string): HTMLElement | null {
    return canvasEl.querySelector<HTMLElement>(`.sim-node[data-id="${instanceId}"]`);
  }
  const connected = (id: string) => connsFor(id).length > 0;

  function select(id: string) {
    selectedId = id;
    selectedConnId = null;
    renderCanvas();
    renderInspector();
  }
  function selectConn(connId: string) {
    selectedConnId = connId;
    selectedId = null;
    renderCanvas();
    renderInspector();
  }

  function renderCanvas() {
    for (const g of [...canvasEl.querySelectorAll(".sim-node-group")]) g.remove();
    if (!model) return;
    for (const nd of model.nodes) canvasEl.append(groupCard(nd));
    dropHint.hidden = model.nodes.length > 0;
    drawWires();
  }

  function groupCard(nd: ModelNode): HTMLElement {
    const g = div("sim-node-group");
    g.dataset.nodeId = nd.id;
    g.style.left = `${nd.x}px`;
    g.style.top = `${nd.y}px`;

    const cap = div("group-cap mono");
    const count = nd.instanceIds.length > 1 ? ` · ${nd.instanceIds.length}` : "";
    cap.textContent = nd.label + count;
    cap.title = "double-click to rename";
    cap.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.className = "group-rename mono";
      input.value = nd.label;
      input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      const commit = (save: boolean) => {
        if (save && sim) sim.rename_node(nd.id, input.value);
        redraw();
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") commit(true);
        else if (ev.key === "Escape") commit(false);
      });
      input.addEventListener("blur", () => commit(true));
      cap.replaceChildren(input);
      input.focus?.();
      input.select?.();
    });
    g.append(cap);

    for (const id of nd.instanceIds) {
      const i = inst(id);
      if (i) g.append(instRow(i));
    }
    g.addEventListener("pointerdown", (e) => startGroupDrag(e, nd, g));
    return g;
  }

  function instRow(i: ModelInstance): HTMLElement {
    const n = div(`sim-node role-${i.role}`);
    n.dataset.id = i.id;
    if (i.id === selectedId) n.classList.add("selected");
    if (connected(i.id)) n.classList.add("wired");

    const name = document.createElement("div");
    name.className = "node-name";
    name.textContent = i.name;
    const sub = document.createElement("div");
    sub.className = "node-sub mono";
    sub.textContent = `${i.protocol} · ${i.role}`;
    const port = div("node-port");
    port.title = "drag to a partner to connect";
    n.append(name, sub, port);

    n.addEventListener("click", () => select(i.id));
    port.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startConnectDrag(e, i);
    });
    n.addEventListener("pointerenter", () => (hoverId = i.id));
    n.addEventListener("pointerleave", () => {
      if (hoverId === i.id) hoverId = null;
    });
    return n;
  }

  function startGroupDrag(e: PointerEvent, nd: ModelNode, groupEl: HTMLElement) {
    const target = e.target as HTMLElement | null;
    if (target?.closest(".node-port")) return;
    const rowId = target?.closest<HTMLElement>(".sim-node")?.dataset.id ?? null;
    const start = canvasPoint(e);
    if (!start) return;
    const ox = start.x - nd.x;
    const oy = start.y - nd.y;
    let moved = false;
    let nx = nd.x;
    let ny = nd.y;

    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev);
      if (!p) return;
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      moved = true;
      nx = Math.max(0, Math.round(p.x - ox));
      ny = Math.max(0, Math.round(p.y - oy));
      groupEl.style.left = `${nx}px`;
      groupEl.style.top = `${ny}px`;
      drawWires();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved && sim) {
        sim.move_node(nd.id, nx, ny);
        refresh();
      } else if (rowId) {
        select(rowId);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startConnectDrag(e: PointerEvent, from: ModelInstance) {
    hoverId = null;
    const fromRow = nodeEl(from.id);
    const a = fromRow ? center(fromRow) : { x: 0, y: 0 };
    const temp = document.createElementNS(SVGNS, "line");
    temp.setAttribute("class", "wire-drag");
    for (const [k, v] of [
      ["x1", a.x],
      ["y1", a.y],
      ["x2", a.x],
      ["y2", a.y],
    ] as const)
      temp.setAttribute(k, String(v));
    wireSvg.append(temp);

    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev);
      if (!p) return;
      temp.setAttribute("x2", String(p.x));
      temp.setAttribute("y2", String(p.y));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      temp.remove();
      const target = hoverId ? inst(hoverId) : null;
      if (target && target.id !== from.id) tryConnect(from, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function tryConnect(a: ModelInstance, b: ModelInstance) {
    if (!sim) return;
    if (a.role === b.role || a.protocol !== b.protocol || a.schemaNs !== b.schemaNs) {
      flashInspectorError(`connect: ${a.protocol} needs a client and a server`);
      return;
    }
    const [clientId, serverId] = a.role === "client" ? [a.id, b.id] : [b.id, a.id];
    try {
      sim.add_connection(clientId, serverId);
    } catch (err) {
      flashInspectorError(String((err as Error).message ?? err));
      return;
    }
    selectedId = clientId;
    selectedConnId = null;
    redraw();
  }

  function drawWires() {
    for (const l of [...wireSvg.querySelectorAll("line")]) {
      if (!l.classList.contains("wire-drag")) l.remove();
    }
    if (!model || !sim) return;
    for (const conn of model.connections) {
      const c = nodeEl(conn.clientId);
      const s = nodeEl(conn.serverId);
      if (!c || !s) continue;
      const a = center(c);
      const b = center(s);
      const refused = !!sim.connection_error(conn.id) || sim.connection_dead(conn.id);
      let cls = refused ? "wire-refused" : "wire-live";
      if (!refused && faultsActive(conn.faults)) cls = "wire-faulty";

      const hit = document.createElementNS(SVGNS, "line");
      hit.setAttribute("class", "wire-hit");
      const vis = document.createElementNS(SVGNS, "line");
      vis.setAttribute("class", cls + (conn.id === selectedConnId ? " wire-selected" : ""));
      for (const ln of [hit, vis]) {
        ln.setAttribute("x1", String(a.x));
        ln.setAttribute("y1", String(a.y));
        ln.setAttribute("x2", String(b.x));
        ln.setAttribute("y2", String(b.y));
        ln.addEventListener("click", () => selectConn(conn.id));
      }
      wireSvg.append(hit, vis);
    }
  }

  function center(elm: HTMLElement) {
    let x = elm.offsetWidth / 2;
    let y = elm.offsetHeight / 2;
    let e: HTMLElement | null = elm;
    while (e && e !== canvasEl) {
      x += e.offsetLeft;
      y += e.offsetTop;
      e = e.offsetParent as HTMLElement | null;
    }
    return { x, y };
  }

  // ── frame-log sources ────────────────────────────────────────────────
  function logSources(): LogSource[] {
    if (!model || !sim) return [];
    return model.connections.map((conn) => ({
      connId: conn.id,
      label: `${inst(conn.clientId)?.name ?? conn.clientId}→${inst(conn.serverId)?.name ?? conn.serverId}`,
      error: sim!.connection_error(conn.id) ?? null,
    }));
  }

  // ── clock bar ────────────────────────────────────────────────────────
  function clockBar(): ClockBar {
    return {
      mode: model?.clockMode ?? "real",
      seed: model?.seed ?? 1,
      stepped: (model?.clockMode ?? "real") === "stepped",
      now: sim?.now() ?? 0,
      pending: sim?.pending() ?? 0,
      playing: playHandle !== null,
      recording: sim?.recording() ?? false,
      hasRecording: lastRecording !== null,
      onMode: (mode) => {
        if (!sim) return;
        pause();
        sim.set_clock_mode(mode);
        redraw();
      },
      onSeed: (seed) => {
        sim?.set_seed(seed);
        redraw();
      },
      onShare: () => {
        if (!sim) return "";
        const frag = `#s=${sim.link()}`;
        try {
          const url = location.origin + location.pathname + location.search + frag;
          location.hash = frag;
          void navigator.clipboard?.writeText(url);
          return url;
        } catch {
          return frag;
        }
      },
      onRecord: (on) => {
        if (!sim) return;
        if (on) sim.record_start();
        else lastRecording = JSON.parse(sim.record_stop()) as Recording;
        flog.setClockBar(clockBar());
      },
      onReplay: () => {
        if (lastRecording) void replayInView(lastRecording);
      },
      onExport: () => {
        if (!lastRecording) return;
        try {
          const blob = new Blob([JSON.stringify(lastRecording, null, 2)], {
            type: "application/json",
          });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `sim-recording-${Date.now()}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } catch {
          /* no blob URL (tests) */
        }
      },
      onImport: (json) => {
        try {
          const rec = JSON.parse(json) as Recording;
          if (rec && rec.v === 1 && Array.isArray(rec.events)) {
            lastRecording = rec;
            void replayInView(rec);
          }
        } catch {
          flashInspectorError("import: not a recording");
        }
      },
      onStep: () => {
        if (!sim) return;
        sim.step();
        afterAdvance();
      },
      onPlay: () => play(),
      onPause: () => pause(),
      onSpeed: (x) => (speed = x),
    };
  }

  function play() {
    if (playHandle !== null || !sim) return;
    playHandle = setInterval(() => {
      if (!sim) return pause();
      sim.advance(32 * speed);
      afterAdvance();
      if (sim.pending() === 0) pause();
    }, 32);
    flog.setClockBar(clockBar());
  }
  function pause() {
    if (playHandle !== null) {
      clearInterval(playHandle);
      playHandle = null;
    }
    flog.setClockBar(clockBar());
  }

  /** Poll for settled calls + new frames after the clock moved. */
  function afterAdvance() {
    settlePending();
    flog.poll();
    flog.setClockBar(clockBar());
  }

  function errorName(throws: ThrowShape[], ordinal: number): string | undefined {
    return throws.find((t) => t.ordinal === ordinal)?.name;
  }

  function settlePending() {
    let wireChanged = false;
    for (const [id, p] of [...pendingCalls]) {
      const raw = sim?.result(id);
      if (!raw) continue;
      pendingCalls.delete(id);
      const r = JSON.parse(raw) as {
        status: string;
        value?: unknown;
        ordinal?: number;
        body?: unknown;
        message?: string;
      };
      p.out.className = "call-out mono";
      if (r.status === "ok") {
        p.out.textContent =
          r.value === null || r.value === undefined ? "(no reply)" : JSON.stringify(r.value, null, 2);
        p.out.classList.add("ok");
      } else if (r.status === "err") {
        const name = errorName(p.throws, r.ordinal ?? 0);
        p.out.textContent = `${name ?? "error " + r.ordinal} ${JSON.stringify(r.body)}`;
        p.out.classList.add("err");
      } else if (r.status === "timeout") {
        p.out.textContent = "timeout";
        p.out.classList.add("err");
        wireChanged = true;
      } else {
        p.out.textContent = r.message ?? "undecodable";
        p.out.classList.add("err");
      }
    }
    if (wireChanged) drawWires();
  }

  async function replayInView(rec: Recording) {
    if (!sim) return;
    pause();
    sim.load_replay(JSON.stringify(rec), shapeJson);
    selectedId = null;
    selectedConnId = null;
    refresh();
    renderPalette();
    flog.setSources(logSources(), frameApi);
    flog.setClockBar(clockBar());
    renderCanvas();
    renderInspector();
  }

  function disconnect(connId: string) {
    if (!sim) return;
    sim.remove_connection(connId);
    if (selectedConnId === connId) selectedConnId = null;
    redraw();
  }

  function openPartnersFor(i: ModelInstance): ModelInstance[] {
    if (!model) return [];
    const want: Role = i.role === "client" ? "server" : "client";
    const already = new Set(
      connsFor(i.id).map((c) => (c.clientId === i.id ? c.serverId : c.clientId)),
    );
    return model.instances.filter(
      (x) =>
        x.role === want &&
        x.protocol === i.protocol &&
        x.schemaNs === i.schemaNs &&
        !already.has(x.id),
    );
  }

  // ── inspector ────────────────────────────────────────────────────────
  function renderInspector() {
    inspectorEl.replaceChildren();
    callForm = null;
    if (!model || !sim || !shape) return;

    if (selectedConnId) {
      renderConnInspector(selectedConnId);
      return;
    }

    const sel = selectedId ? inst(selectedId) : null;
    if (!sel) {
      inspectorEl.append(muted("select an instance, or a connection"));
      return;
    }
    const found = findProtocol(shape, sel.schemaNs, sel.protocol);
    if (!found) {
      inspectorEl.append(muted(`${sel.protocol} is no longer compiled`));
      return;
    }

    inspectorEl.append(
      facts([
        ["instance", sel.name],
        ["protocol", sel.protocol],
        ["role", sel.role],
        ["framing", found.protocol.framing],
      ]),
    );
    const hash = document.createElement("button");
    hash.className = "hash-copy mono";
    hash.textContent = sel.irHash;
    hash.title = "copy ir_hash";
    hash.addEventListener("click", () => void navigator.clipboard?.writeText(sel.irHash));
    inspectorEl.append(row("ir_hash", hash));
    if (sel.irHash !== found.schema.ir_hash) {
      inspectorEl.append(
        button("resync — schema changed", "danger", () => {
          sim!.resync_instance(sel.id);
          redraw();
        }),
      );
    }

    inspectorEl.append(
      button("remove instance", "danger", () => {
        sim!.remove_instance(sel.id);
        if (selectedId === sel.id) selectedId = null;
        redraw();
      }),
    );

    // ── this box (add a second instance → a gateway) ──
    const nd = node(sel.nodeId);
    if (nd) {
      inspectorEl.append(section(`box · ${nd.label}`));
      if (nd.instanceIds.length > 1) {
        inspectorEl.append(
          muted(
            `${nd.instanceIds.length} instances: ` +
              nd.instanceIds.map((id) => inst(id)?.name ?? id).join(", "),
          ),
        );
      }
      const addSel = document.createElement("select");
      addSel.className = "add-inst-sel";
      addSel.append(opt("", "+ add instance to this box…", true));
      for (const schema of shape.schemas) {
        for (const p of schema.protocols) {
          for (const role of ["server", "client"] as Role[]) {
            addSel.append(opt(`${schema.namespace}|${p.name}|${role}`, `${p.name} · ${role}`));
          }
        }
      }
      addSel.addEventListener("change", () => {
        const v = selValue(addSel);
        if (!v) return;
        const [schemaNs, protocol, role] = v.split("|");
        const id = sim!.add_instance(
          JSON.stringify({ schemaNs, protocol, role, nodeId: nd.id }),
        );
        selectedId = id;
        redraw();
      });
      inspectorEl.append(row("add", addSel));
    }

    // ── connections ──
    inspectorEl.append(section("connections"));
    const conns = connsFor(sel.id);
    if (conns.length === 0) inspectorEl.append(muted("none"));
    for (const conn of conns) {
      const otherId = conn.clientId === sel.id ? conn.serverId : conn.clientId;
      const other = inst(otherId);
      const err = sim.connection_error(conn.id);
      const dead = sim.connection_dead(conn.id);
      const r = div("conn-row");
      const bad = !!err || dead;
      const dot = document.createElement("span");
      dot.className = `conn-dot ${bad ? "err" : "ok"}`;
      dot.textContent = "●";
      const name = document.createElement("button");
      name.className = "conn-name";
      name.textContent = `${conn.clientId === sel.id ? "→" : "←"} ${other?.name ?? otherId}`;
      name.title = err
        ? `refused · ${err}`
        : dead
          ? "timed out"
          : faultsActive(conn.faults)
            ? "faults active"
            : "inspect connection";
      name.addEventListener("click", () => selectConn(conn.id));
      const x = document.createElement("button");
      x.className = "conn-x";
      x.textContent = "✕";
      x.title = "disconnect";
      x.addEventListener("click", () => disconnect(conn.id));
      r.append(dot, name, x);
      inspectorEl.append(r);
      if (err) inspectorEl.append(muted(`connection refused · ${err}`, "err"));
    }
    const open = openPartnersFor(sel);
    if (open.length) {
      const addSel = document.createElement("select");
      addSel.className = "connect-sel";
      addSel.append(opt("", "+ connect to…", true));
      for (const p of open) addSel.append(opt(p.id, p.name));
      addSel.addEventListener("change", () => {
        const otherId = selValue(addSel);
        const other = otherId ? inst(otherId) : null;
        if (other) tryConnect(sel, other);
      });
      inspectorEl.append(row("add", addSel));
    }

    const latency = document.createElement("input");
    latency.type = "number";
    latency.min = "0";
    latency.step = "10";
    latency.value = String(model.latencyMs);
    latency.title = "applies to every connection";
    latency.addEventListener("change", () => {
      sim!.set_latency(Math.max(0, Number(latency.value) || 0));
      redraw();
    });
    inspectorEl.append(row("latency ms", latency));

    const timeout = document.createElement("input");
    timeout.type = "number";
    timeout.min = "0";
    timeout.step = "100";
    timeout.value = String(model.callTimeoutMs);
    timeout.title = "how long a client waits before a timeout; 0 = forever";
    timeout.addEventListener("change", () => {
      sim!.set_call_timeout(Math.max(0, Number(timeout.value) || 0));
      redraw();
    });
    inspectorEl.append(row("call timeout ms", timeout));

    if (sel.role === "server") {
      inspectorEl.append(section("behaviours"));
      for (const fn of found.protocol.functions) {
        inspectorEl.append(behaviorRow(sel, fn.name));
      }
    }

    if (sel.role === "client" && connsFor(sel.id).some((c) => live(c.id))) {
      inspectorEl.append(renderCallForm(sel));
    }
  }

  function renderConnInspector(connId: string) {
    const conn = model!.connections.find((c) => c.id === connId);
    if (!conn || !sim) {
      selectedConnId = null;
      inspectorEl.append(muted("connection is gone"));
      return;
    }
    const client = inst(conn.clientId);
    const server = inst(conn.serverId);
    const err = sim.connection_error(conn.id);
    const dead = sim.connection_dead(conn.id);
    const framing = conn.framing === "auto"
      ? findProtocol(shape!, server?.schemaNs ?? "", server?.protocol ?? "")?.protocol.framing ?? "?"
      : conn.framing;
    inspectorEl.append(
      facts([
        ["client", client?.name ?? conn.clientId],
        ["server", server?.name ?? conn.serverId],
        ["framing", framing],
        ["status", err ? `refused · ${err}` : dead ? "timed out" : "live"],
      ]),
    );
    if (err) inspectorEl.append(muted(`connection refused · ${err}`, "err"));
    else if (dead) {
      inspectorEl.append(muted("timed out — the client is desynced", "err"));
      inspectorEl.append(
        button("reconnect", "primary", () => {
          sim!.set_seed(model!.seed); // no-op knob that forces an engine rebuild
          redraw();
        }),
      );
    } else inspectorEl.append(muted("● live", "ok"));

    inspectorEl.append(section("faults"));
    inspectorEl.append(faultControls(conn));

    inspectorEl.append(
      button("disconnect", "danger", () => disconnect(conn.id)),
      button("select client", "", () => select(conn.clientId)),
    );
  }

  /** Live sliders / toggles for one connection's faults. Each edit pushes the
   *  whole spec to `sim.set_faults`; it takes effect on the next frame. */
  function faultControls(conn: ModelConn): HTMLElement {
    const wrap = div("fault-ctls");
    const f = { ...conn.faults };
    const touched = () => {
      sim?.set_faults(conn.id, JSON.stringify(f));
      refresh();
      drawWires();
    };

    const pct = (label: string, get: () => number, set: (v: number) => void) => {
      const inp = document.createElement("input");
      inp.type = "range";
      inp.min = "0";
      inp.max = "100";
      inp.step = "5";
      inp.value = String(Math.round(get() * 100));
      const out = document.createElement("span");
      out.className = "fault-val mono";
      out.textContent = `${inp.value}%`;
      inp.addEventListener("input", () => {
        set(Number(inp.value) / 100);
        out.textContent = `${inp.value}%`;
        touched();
      });
      const r = div("insp-row");
      const l = document.createElement("span");
      l.className = "insp-label";
      l.textContent = label;
      r.append(l, inp, out);
      return r;
    };
    const num = (label: string, get: () => number, set: (v: number) => void, step = "10") => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "0";
      inp.step = step;
      inp.value = String(get());
      inp.addEventListener("change", () => {
        set(Math.max(0, Number(inp.value) || 0));
        touched();
      });
      const r = div("insp-row");
      const l = document.createElement("span");
      l.className = "insp-label";
      l.textContent = label;
      r.append(l, inp);
      return r;
    };

    const applyTo = document.createElement("select");
    for (const v of ["both", "requests", "responses"] as const) {
      applyTo.append(opt(v, v, v === f.applyTo));
    }
    applyTo.addEventListener("change", () => {
      f.applyTo = selValue(applyTo) as Faults["applyTo"];
      touched();
    });

    const partition = document.createElement("input");
    partition.type = "checkbox";
    partition.checked = f.partition;
    partition.addEventListener("change", () => {
      f.partition = partition.checked;
      touched();
    });
    const pRow = div("insp-row");
    const pl = document.createElement("span");
    pl.className = "insp-label";
    pl.textContent = "partition";
    pRow.append(pl, partition);

    wrap.append(
      row("apply to", applyTo),
      pct("drop", () => f.dropProb, (v) => (f.dropProb = v)),
      pct("corrupt", () => f.corruptProb, (v) => (f.corruptProb = v)),
      num("delay min ms", () => f.delayMin, (v) => (f.delayMin = v)),
      num("delay max ms", () => f.delayMax, (v) => (f.delayMax = v)),
      num("reorder window", () => f.reorderWindow, (v) => (f.reorderWindow = v), "1"),
      pRow,
    );
    return wrap;
  }

  function behaviorRow(i: ModelInstance, fnName: string): HTMLElement {
    const setting = () => inst(i.id)?.behaviors[fnName] ?? { kind: "reply", config: {} };
    const catalog = (
      JSON.parse(sim!.behavior_catalog(i.schemaNs, i.protocol, fnName)) as {
        kind: string;
        label: string;
        applies: boolean;
      }[]
    ).filter((e) => e.applies); // `script` lazy-loads its wasm on first pick

    const wrap = div("behavior-row");
    const head = div("behavior-head");
    const name = document.createElement("span");
    name.className = "behavior-fn mono";
    name.textContent = fnName;
    const sel = document.createElement("select");
    sel.className = "behavior-kind";
    for (const e of catalog) sel.append(opt(e.kind, e.label, e.kind === setting().kind));
    head.append(name, sel);
    wrap.append(head);

    const cfgHost = div("behavior-cfg-host");
    wrap.append(cfgHost);

    const renderConfig = () => {
      cfgHost.replaceChildren();
      if (setting().kind === "forward") {
        cfgHost.append(forwardConfig(i, fnName));
        return;
      }
      if (setting().kind === "script") {
        cfgHost.append(scriptConfig(i, fnName));
        return;
      }
      const cfg = document.createElement("textarea");
      cfg.className = "behavior-config mono";
      cfg.rows = 3;
      cfg.spellcheck = false;
      cfg.value = JSON.stringify(setting().config, null, 1);
      cfg.addEventListener("change", () => {
        try {
          JSON.parse(cfg.value || "{}");
          cfg.classList.remove("bad");
          sim!.set_behavior(i.id, fnName, setting().kind, cfg.value || "{}");
          refresh();
        } catch {
          cfg.classList.add("bad");
        }
      });
      cfgHost.append(cfg);
    };

    sel.addEventListener("change", async () => {
      const kind = selValue(sel);
      if (kind === "script" && !scripted) {
        // First `script` pick: pull the scripted wasm and re-seat the session
        // on it. If it fails to load, roll the picker back and bail.
        if (!(await ensureScripted())) {
          sel.value = setting().kind;
          return;
        }
        pendingCalls.clear();
        sim!.set_behavior(i.id, fnName, "script", JSON.stringify({ source: DEFAULT_SCRIPT }));
        refresh();
        redraw();
        return;
      }
      const config = kind === "script" ? JSON.stringify({ source: DEFAULT_SCRIPT }) : "{}";
      sim!.set_behavior(i.id, fnName, kind, config); // other configs default engine-side
      refresh();
      renderConfig();
      redrawSoft();
    });
    renderConfig();
    return wrap;
  }

  /** The Rhai source box for a `Script` behaviour. `params` (the decoded
   *  request) and a persistent `state` map are in scope; the last expression is
   *  the reply, `throw` raises an error. */
  function scriptConfig(i: ModelInstance, fnName: string): HTMLElement {
    const wrap = div("script-cfg");
    const src = () =>
      ((inst(i.id)?.behaviors[fnName]?.config ?? {}) as { source?: string }).source ?? DEFAULT_SCRIPT;
    const ta = document.createElement("textarea");
    ta.className = "behavior-config script mono";
    ta.rows = 6;
    ta.spellcheck = false;
    ta.value = src();
    ta.addEventListener("change", () => {
      sim!.set_behavior(i.id, fnName, "script", JSON.stringify({ source: ta.value }));
      refresh();
    });
    wrap.append(ta);
    return wrap;
  }

  /** The two-select editor for a `Forward` behaviour. */
  function forwardConfig(i: ModelInstance, fnName: string): HTMLElement {
    const wrap = div("forward-cfg");
    const cfg = () =>
      (inst(i.id)?.behaviors[fnName]?.config ?? {}) as { viaConnectionId?: string; targetFn?: string };
    const push = (next: { viaConnectionId?: string; targetFn?: string }) => {
      sim!.set_behavior(i.id, fnName, "forward", JSON.stringify({ ...cfg(), ...next }));
      refresh();
    };

    const viaSel = document.createElement("select");
    viaSel.className = "forward-via";
    viaSel.append(opt("", "via connection…", !cfg().viaConnectionId));
    for (const conn of model!.connections) {
      const c = inst(conn.clientId);
      const s = inst(conn.serverId);
      viaSel.append(
        opt(
          conn.id,
          `${c?.name ?? conn.clientId} → ${s?.name ?? conn.serverId}`,
          conn.id === cfg().viaConnectionId,
        ),
      );
    }

    const fnHost = div("forward-fn-host");
    const renderFnSel = () => {
      fnHost.replaceChildren();
      const conn = model!.connections.find((x) => x.id === selValue(viaSel));
      const s = conn && inst(conn.serverId);
      const found = s && findProtocol(shape!, s.schemaNs, s.protocol);
      if (!found) return;
      const fnSel = document.createElement("select");
      fnSel.className = "forward-fn";
      found.protocol.functions.forEach((f, idx) =>
        fnSel.append(opt(f.name, f.name, f.name === cfg().targetFn || (idx === 0 && !cfg().targetFn))),
      );
      fnSel.addEventListener("change", () => push({ targetFn: selValue(fnSel) }));
      if (!cfg().targetFn) push({ targetFn: found.protocol.functions[0]?.name });
      fnHost.append(row("fn", fnSel));
    };

    viaSel.addEventListener("change", () => {
      push({ viaConnectionId: selValue(viaSel) });
      renderFnSel();
    });
    renderFnSel();
    wrap.append(row("via", viaSel), fnHost);
    return wrap;
  }

  function renderCallForm(i: ModelInstance): HTMLElement {
    const found = findProtocol(shape!, i.schemaNs, i.protocol)!;
    const wrap = div("call-form");
    wrap.append(section("call"));

    const liveConns = connsFor(i.id).filter((c) => live(c.id));
    let connSel: HTMLSelectElement | null = null;
    if (liveConns.length > 1) {
      connSel = document.createElement("select");
      connSel.className = "call-conn";
      liveConns.forEach((c, idx) =>
        connSel!.append(opt(c.id, `→ ${inst(c.serverId)?.name ?? c.serverId}`, idx === 0)),
      );
      wrap.append(row("via", connSel));
    }
    const pickConn = () => (connSel ? selValue(connSel) || liveConns[0]?.id : liveConns[0]?.id);

    const fnSel = document.createElement("select");
    fnSel.className = "call-fn";
    found.protocol.functions.forEach((fn, idx) => fnSel.append(opt(fn.name, fn.name, idx === 0)));
    wrap.append(row("fn", fnSel));

    const formHost = div("call-args");
    wrap.append(formHost);

    const out = div("call-out mono");
    wrap.append(out);

    const send = button("send", "primary", () => {
      const connId = pickConn();
      if (!callForm || !connId || !sim) return;
      out.className = "call-out mono";
      let params: unknown;
      try {
        params = callForm.read();
      } catch (e) {
        out.textContent = (e as Error).message;
        out.classList.add("err");
        return;
      }
      const fnName = selValue(fnSel);
      const fn = found.protocol.functions.find((f) => f.name === fnName)!;
      out.textContent = "…";
      let id: number;
      try {
        id = sim.call(connId, fnName, JSON.stringify(params));
      } catch (e) {
        out.textContent = String((e as Error).message ?? e);
        out.classList.add("err");
        return;
      }
      pendingCalls.set(id, { out, throws: fn.throws });
      if (clockMode === "real") sim.run();
      afterAdvance();
    });
    wrap.append(send);

    const rebuildForm = () => {
      const fn =
        found.protocol.functions.find((f) => f.name === selValue(fnSel)) ??
        found.protocol.functions[0];
      callForm = argsForm(fn.args, found.schema);
      formHost.replaceChildren(callForm.el);
    };
    fnSel.addEventListener("change", rebuildForm);
    rebuildForm();
    return wrap;
  }

  function flashInspectorError(msg: string) {
    const p = muted(msg, "err");
    inspectorEl.prepend(p);
    setTimeout(() => p.remove(), 4000);
  }

  // ── lifecycle ────────────────────────────────────────────────────────
  /** Full re-render: model, frame-log sources (clears the list), canvas,
   *  inspector, clock bar. */
  function redraw() {
    refresh();
    if (selectedId && !inst(selectedId)) selectedId = null;
    if (selectedConnId && !model?.connections.some((c) => c.id === selectedConnId)) {
      selectedConnId = null;
    }
    flog.setSources(logSources(), frameApi);
    flog.setClockBar(clockBar());
    renderCanvas();
    renderInspector();
  }
  /** Like `redraw` but keeps the frame-log list (a behaviour edit doesn't
   *  reset the wire). */
  function redrawSoft() {
    refresh();
    renderCanvas();
    renderInspector();
    flog.setClockBar(clockBar());
  }

  return {
    el,
    setShape(shapeObj, serialized) {
      shape = shapeObj;
      shapeJson = JSON.stringify(shapeObj);
      try {
        if (serialized) sim = new SimClass(shapeJson, serialized);
        else if (!sim) sim = new SimClass(shapeJson);
        else sim.set_shape(shapeJson);
      } catch {
        sim = new SimClass(shapeJson);
      }
      selectedId = null;
      selectedConnId = null;
      renderPalette();
      redraw();
      // A restored link may carry `script` behaviours the lean wasm only stubs —
      // upgrade in the background, then re-render on the real engine.
      if (!scripted && sessionHasScript()) void ensureScripted().then(redraw);
    },
    serialize() {
      return sim ? sim.link() : "";
    },
    record(on) {
      if (!sim) return null;
      if (on) {
        sim.record_start();
        flog.setClockBar(clockBar());
        return null;
      }
      lastRecording = JSON.parse(sim.record_stop()) as Recording;
      flog.setClockBar(clockBar());
      return lastRecording;
    },
    async replay(rec) {
      lastRecording = rec;
      await replayInView(rec);
    },
    destroy() {
      pause();
      window.removeEventListener("resize", onResize);
      sim?.free();
      sim = null;
    },
  };
}

// ── tiny DOM helpers ───────────────────────────────────────────────────
function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}
function labelled(area: string, content: HTMLElement): HTMLElement {
  content.dataset.area = area;
  return content;
}
function section(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "insp-section";
  h.textContent = text;
  return h;
}
function row(label: string, control: HTMLElement): HTMLElement {
  const r = div("insp-row");
  const l = document.createElement("span");
  l.className = "insp-label";
  l.textContent = label;
  r.append(l, control);
  return r;
}
function facts(pairs: [string, string][]): HTMLElement {
  const f = div("insp-facts");
  for (const [k, v] of pairs) {
    const kv = div("fact");
    const kk = document.createElement("span");
    kk.className = "insp-label";
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "fact-v";
    vv.textContent = v;
    kv.append(kk, vv);
    f.append(kv);
  }
  return f;
}
function muted(text: string, extra = ""): HTMLElement {
  const p = document.createElement("p");
  p.className = `muted pad ${extra}`.trim();
  p.textContent = text;
  return p;
}
function button(text: string, variant: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `sim-btn ${variant}`;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
function selValue(sel: HTMLSelectElement): string {
  return (
    sel.value ||
    [...sel.options].find((o) => o.selected)?.value ||
    sel.options[0]?.value ||
    ""
  );
}
function opt(value: string, text: string, selected = false): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  if (selected) o.selected = true;
  return o;
}
