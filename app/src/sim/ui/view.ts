/// The full-width simulate view: a palette of protocol × role, a canvas of
/// node boxes (each hosting one or more instances), the connections between
/// instances, an inspector (instance facts, per-function behaviours,
/// per-connection controls, and — for a connected client — the call form), and
/// the merged frame list. Phase 2: many connections (2a), a node hosting
/// several instances — a gateway (2b), an unreliable wire per connection (2c), a virtual clock (2d), a shareable session URL + record a shareable session URL (2e). replay (2e).

import { BEHAVIORS, BEHAVIOR_KINDS, type BehaviorKind } from "../behavior.ts";
import { RealClock, SteppedClock, type Clock } from "../clock.ts";
import { Wires } from "../engine.ts";
import { faultsActive } from "../faults.ts";
import { SimRemoteError } from "../generic.ts";
import {
  addConnection,
  addInstance,
  connectionsFor,
  emptySession,
  instance,
  moveNode,
  rebuild,
  removeConnection,
  removeInstance,
  renameNode,
  resyncInstance,
  setBehavior,
  type Connection,
  type Instance,
  type Node,
  type Role,
  type Session,
} from "../model.ts";
import { Recorder, replayRecording, type Recording } from "../record.ts";
import { decodeSession, encodeSession } from "../session-codec.ts";
import { findProtocol, type ProjectShape } from "../shape.ts";
import type { LogSource } from "./framelog.ts";
import { argsForm, type ArgsForm } from "./argsform.ts";
import { frameLog } from "./framelog.ts";

const SVGNS = "http://www.w3.org/2000/svg";

export interface SimView {
  el: HTMLElement;
  /** Point at a freshly compiled shape (schemas were edited). Pass a `#s=`
   *  fragment payload to restore a shared session against that shape. */
  setShape(shape: ProjectShape, serialized?: string | null): void;
  /** The current session as a URL-fragment payload. */
  serialize(): string;
  /** Start / stop capturing inputs; `stop` returns the recording. */
  record(on: boolean): Recording | null;
  /** Re-run a recording on a fresh stepped clock, into this view. */
  replay(rec: Recording): Promise<void>;
  destroy(): void;
}

export function createSim(): SimView {
  let session: Session | null = null;
  const wires = new Wires();
  let clock: Clock = new RealClock();
  const recorder = new Recorder();
  let selectedId: string | null = null; // selected instance
  let selectedConnId: string | null = null; // selected connection (edge)
  let callForm: ArgsForm | null = null;

  const capture = (e: Parameters<Recorder["capture"]>[0]) => recorder.capture(e, clock.now());

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

  // ── palette ──────────────────────────────────────────────────────────
  function renderPalette() {
    paletteEl.replaceChildren();
    if (!session) return;
    for (const schema of session.shape.schemas) {
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
  let hoverId: string | null = null; // instance row the pointer is over, for drop-to-connect

  const dropHint = document.createElement("p");
  dropHint.className = "muted pad canvas-hint";
  dropHint.textContent =
    "drag roles here — drop onto a box to add to it (a gateway), then drag between ports";
  canvasEl.append(dropHint);

  /** Event point in canvas coordinates, or `null` when the environment has no
   *  layout (jsdom / linkedom in tests). */
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
    if (!raw || !session) return;
    const spec = JSON.parse(raw) as { schemaNs: string; protocol: string; role: Role };
    const ontoNode = (e.target as HTMLElement | null)?.closest<HTMLElement>(".sim-node-group");
    const p = canvasPoint(e);
    const n = session.nodes.length;
    const inst = ontoNode?.dataset.nodeId
      ? addInstance(session, spec, { nodeId: ontoNode.dataset.nodeId })
      : addInstance(session, spec, {
          x: Math.max(8, (p?.x ?? 48 + n * 34) - 75),
          y: Math.max(8, (p?.y ?? 48 + n * 30) - 26),
        });
    selectedId = inst.id;
    selectedConnId = null;
    renderAll();
  });

  function nodeEl(instanceId: string): HTMLElement | null {
    return canvasEl.querySelector<HTMLElement>(`.sim-node[data-id="${instanceId}"]`);
  }

  function connected(id: string): boolean {
    return !!session && connectionsFor(session, id).length > 0;
  }

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
    if (!session) return;
    for (const nd of session.nodes) canvasEl.append(groupCard(nd));
    dropHint.hidden = session.nodes.length > 0;
    drawWires();
  }

  function groupCard(nd: Node): HTMLElement {
    const g = div("sim-node-group");
    g.dataset.nodeId = nd.id;
    g.style.left = `${nd.x}px`;
    g.style.top = `${nd.y}px`;

    // header — the machine's name; double-click to rename.
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
        if (save) renameNode(session!, nd.id, input.value);
        renderCanvas();
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
      const inst = session!.instances.find((i) => i.id === id);
      if (inst) g.append(instRow(inst));
    }
    // one drag handler for the whole box — grab anywhere (header, padding, a
    // row) to move it; a press that doesn't move selects the row it landed on.
    g.addEventListener("pointerdown", (e) => startGroupDrag(e, nd, g));
    return g;
  }

  function instRow(inst: Instance): HTMLElement {
    const n = div(`sim-node role-${inst.role}`);
    n.dataset.id = inst.id;
    if (inst.id === selectedId) n.classList.add("selected");
    if (connected(inst.id)) n.classList.add("wired");

    const name = document.createElement("div");
    name.className = "node-name";
    name.textContent = inst.name;
    const sub = document.createElement("div");
    sub.className = "node-sub mono";
    sub.textContent = `${inst.protocol} · ${inst.role}`;
    const port = div("node-port");
    port.title = "drag to a partner to connect";
    n.append(name, sub, port);

    n.addEventListener("click", () => select(inst.id));
    port.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startConnectDrag(e, inst);
    });
    n.addEventListener("pointerenter", () => (hoverId = inst.id));
    n.addEventListener("pointerleave", () => {
      if (hoverId === inst.id) hoverId = null;
    });
    return n;
  }

  function startGroupDrag(e: PointerEvent, nd: Node, groupEl: HTMLElement) {
    const target = e.target as HTMLElement | null;
    if (target?.closest(".node-port")) return; // the port starts a connect drag
    const rowId = target?.closest<HTMLElement>(".sim-node")?.dataset.id ?? null;
    const start = canvasPoint(e);
    // No layout (tests): the row's own click handler does the selecting.
    if (!start) return;
    const ox = start.x - nd.x;
    const oy = start.y - nd.y;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev);
      if (!p) return;
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      moved = true;
      moveNode(session!, nd.id, p.x - ox, p.y - oy);
      groupEl.style.left = `${nd.x}px`;
      groupEl.style.top = `${nd.y}px`;
      drawWires();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved && rowId) select(rowId); // a press without a drag = select that row
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startConnectDrag(e: PointerEvent, from: Instance) {
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
      const target = hoverId && session ? instance(session, hoverId) : null;
      if (target && target.id !== from.id) tryConnect(from, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function tryConnect(a: Instance, b: Instance) {
    if (!session) return;
    if (a.role === b.role || a.protocol !== b.protocol || a.schemaNs !== b.schemaNs) {
      flashInspectorError(`connect: ${a.protocol} needs a client and a server`);
      return;
    }
    const [clientId, serverId] = a.role === "client" ? [a.id, b.id] : [b.id, a.id];
    let conn: Connection;
    try {
      conn = addConnection(session, clientId, serverId);
    } catch (err) {
      flashInspectorError((err as Error).message);
      return;
    }
    selectedId = clientId; // land on the client — its call form is the next step
    selectedConnId = null;
    void syncWires().then(() => void conn);
  }

  function drawWires() {
    for (const l of [...wireSvg.querySelectorAll("line")]) {
      if (!l.classList.contains("wire-drag")) l.remove();
    }
    if (!session) return;
    for (const conn of session.connections) {
      const c = nodeEl(conn.clientId);
      const s = nodeEl(conn.serverId);
      if (!c || !s) continue;
      const a = center(c);
      const b = center(s);
      const live = wires.get(conn.id);
      let cls = live?.error || live?.dead() ? "wire-refused" : live ? "wire-live" : "wire-pending";
      if (live && !live.error && !live.dead() && faultsActive(conn.faults)) cls = "wire-faulty";

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

  /** Centre of an element in canvas coordinates — walks the offset chain, so an
   *  instance row nested in a positioned node group still resolves. */
  function center(el: HTMLElement) {
    let x = el.offsetWidth / 2;
    let y = el.offsetHeight / 2;
    let e: HTMLElement | null = el;
    while (e && e !== canvasEl) {
      x += e.offsetLeft;
      y += e.offsetTop;
      e = e.offsetParent as HTMLElement | null;
    }
    return { x, y };
  }

  // ── wires ────────────────────────────────────────────────────────────
  function logSources(): LogSource[] {
    if (!session) return [];
    return wires.all().map((lc) => {
      const server = instance(session!, lc.serverId);
      const found = server && findProtocol(session!.shape, server.schemaNs, server.protocol);
      return {
        connId: lc.connId,
        label: `${lc.clientName}→${lc.serverName}`,
        tap: lc.tap,
        error: lc.error,
        ctx: found
          ? {
              clientName: lc.clientName,
              serverName: lc.serverName,
              framing: lc.framing,
              fnNames: found.protocol.functions.map((f) => f.name),
            }
          : undefined,
      };
    });
  }

  /** Add / drop wires to match the session, leaving the rest running. */
  async function syncWires() {
    if (session) await wires.sync(session);
    flog.setSources(logSources());
    renderCanvas();
    renderInspector();
  }

  /** Close every wire and re-open — for a schema edit / resync / latency change. */
  async function rebuildWires() {
    if (session) await wires.rebuild(session);
    flog.setSources(logSources());
    renderCanvas();
    renderInspector();
  }

  /** The clock / seed strip in the frame-log header. */
  function clockBar() {
    return {
      mode: session?.clockMode ?? ("real" as const),
      seed: session?.seed ?? 1,
      clock: clock instanceof SteppedClock ? clock : null,
      onMode: (mode: "real" | "stepped") => {
        if (!session) return;
        if (clock instanceof SteppedClock) clock.pause();
        session.clockMode = mode;
        clock = mode === "stepped" ? new SteppedClock() : new RealClock();
        wires.clock = clock;
        flog.setClockBar(clockBar());
        void rebuildWires();
      },
      onSeed: (seed: number) => {
        if (!session) return;
        session.seed = seed;
        void rebuildWires();
      },
      onShare: () => {
        if (!session) return "";
        const frag = `#s=${encodeSession(session)}`;
        try {
          const url = location.origin + location.pathname + location.search + frag;
          location.hash = frag;
          void navigator.clipboard?.writeText(url);
          return url;
        } catch {
          return frag;
        }
      },
      recording: recorder.recording,
      hasRecording: lastRecording !== null,
      onRecord: (on: boolean) => {
        if (on) {
          if (session) recorder.start(session, clock.now());
        } else {
          lastRecording = recorder.stop();
        }
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
          /* no blob URL support (tests) — silently no-op */
        }
      },
      onImport: (json: string) => {
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
    };
  }

  let lastRecording: Recording | null = null;

  async function replayInView(rec: Recording) {
    if (!session) return;
    const stepClock = new SteppedClock();
    clock = stepClock;
    wires.clock = stepClock;
    const r = await replayRecording(rec, session.shape, { wires, clock: stepClock });
    session = r.session;
    selectedId = null;
    selectedConnId = null;
    flog.setClockBar(clockBar());
    flog.setSources(logSources());
    renderPalette();
    renderCanvas();
    renderInspector();
  }

  function disconnect(connId: string) {
    if (!session) return;
    removeConnection(session, connId);
    if (selectedConnId === connId) selectedConnId = null;
    void syncWires();
  }

  /** Server / client instances of `inst`'s protocol not already wired to it. */
  function openPartnersFor(inst: Instance): Instance[] {
    if (!session) return [];
    const want: Role = inst.role === "client" ? "server" : "client";
    const already = new Set(
      connectionsFor(session, inst.id).map((c) => (c.clientId === inst.id ? c.serverId : c.clientId)),
    );
    return session.instances.filter(
      (i) =>
        i.role === want &&
        i.protocol === inst.protocol &&
        i.schemaNs === inst.schemaNs &&
        !already.has(i.id),
    );
  }

  // ── inspector ────────────────────────────────────────────────────────
  function renderInspector() {
    inspectorEl.replaceChildren();
    callForm = null;
    if (!session) return;

    if (selectedConnId) {
      renderConnInspector(selectedConnId);
      return;
    }

    const sel = selectedId ? instance(session, selectedId) : undefined;
    if (!sel) {
      inspectorEl.append(muted("select an instance, or a connection"));
      return;
    }
    const found = findProtocol(session.shape, sel.schemaNs, sel.protocol);
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
          resyncInstance(session!, sel.id);
          void rebuildWires();
        }),
      );
    }

    inspectorEl.append(
      button("remove instance", "danger", () => {
        removeInstance(session!, sel.id);
        if (selectedId === sel.id) selectedId = null;
        void syncWires();
      }),
    );

    // ── this box (add a second instance → a gateway) ──
    const nd = session.nodes.find((x) => x.id === sel.nodeId);
    if (nd) {
      inspectorEl.append(section(`box · ${nd.label}`));
      if (nd.instanceIds.length > 1) {
        inspectorEl.append(
          muted(`${nd.instanceIds.length} instances: ` + nd.instanceIds
            .map((id) => instance(session!, id)?.name ?? id)
            .join(", ")),
        );
      }
      const addSel = document.createElement("select");
      addSel.className = "add-inst-sel";
      addSel.append(opt("", "+ add instance to this box…", true));
      for (const schema of session.shape.schemas) {
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
        const inst = addInstance(session!, { schemaNs, protocol, role: role as Role }, { nodeId: nd.id });
        selectedId = inst.id;
        void syncWires();
        renderAll();
      });
      inspectorEl.append(row("add", addSel));
    }

    // ── connections ──
    inspectorEl.append(section("connections"));
    const conns = connectionsFor(session, sel.id);
    if (conns.length === 0) inspectorEl.append(muted("none"));
    for (const conn of conns) {
      const otherId = conn.clientId === sel.id ? conn.serverId : conn.clientId;
      const other = instance(session, otherId);
      const lc = wires.get(conn.id);
      const r = div("conn-row");
      const bad = lc?.error || lc?.dead();
      const dot = document.createElement("span");
      dot.className = `conn-dot ${bad ? "err" : lc ? "ok" : ""}`;
      dot.textContent = "●";
      const name = document.createElement("button");
      name.className = "conn-name";
      name.textContent = `${conn.clientId === sel.id ? "→" : "←"} ${other?.name ?? otherId}`;
      name.title = lc?.error
        ? `refused · ${lc.error}`
        : lc?.dead()
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
      if (lc?.error) inspectorEl.append(muted(`connection refused · ${lc.error}`, "err"));
    }
    const open = openPartnersFor(sel);
    if (open.length) {
      const addSel = document.createElement("select");
      addSel.className = "connect-sel";
      addSel.append(opt("", "+ connect to…", true));
      for (const p of open) addSel.append(opt(p.id, p.name));
      addSel.addEventListener("change", () => {
        const otherId = selValue(addSel);
        if (!otherId) return;
        const other = instance(session!, otherId)!;
        tryConnect(sel, other);
      });
      inspectorEl.append(row("add", addSel));
    }

    const latency = document.createElement("input");
    latency.type = "number";
    latency.min = "0";
    latency.step = "10";
    latency.value = String(session.latencyMs);
    latency.title = "applies to every connection";
    latency.addEventListener("change", () => {
      session!.latencyMs = Math.max(0, Number(latency.value) || 0);
      void rebuildWires();
    });
    inspectorEl.append(row("latency ms", latency));

    const timeout = document.createElement("input");
    timeout.type = "number";
    timeout.min = "0";
    timeout.step = "100";
    timeout.value = String(session.callTimeoutMs);
    timeout.title = "how long a client waits before RuntimeError(timeout); 0 = forever";
    timeout.addEventListener("change", () => {
      session!.callTimeoutMs = Math.max(0, Number(timeout.value) || 0);
      void rebuildWires();
    });
    inspectorEl.append(row("call timeout ms", timeout));

    // server: per-function behaviours
    if (sel.role === "server") {
      inspectorEl.append(section("behaviours"));
      for (const fn of found.protocol.functions) {
        inspectorEl.append(behaviorRow(sel, fn.name));
      }
    }

    // client with at least one live connection: the call form
    if (sel.role === "client" && wires.forInstance(sel.id).some((lc) => !lc.error)) {
      inspectorEl.append(renderCallForm(sel));
    }
  }

  function renderConnInspector(connId: string) {
    const conn = session!.connections.find((c) => c.id === connId);
    if (!conn) {
      selectedConnId = null;
      inspectorEl.append(muted("connection is gone"));
      return;
    }
    const client = instance(session!, conn.clientId);
    const server = instance(session!, conn.serverId);
    const lc = wires.get(conn.id);
    inspectorEl.append(
      facts([
        ["client", client?.name ?? conn.clientId],
        ["server", server?.name ?? conn.serverId],
        ["framing", lc?.framing ?? "?"],
        ["status", lc?.error ? `refused · ${lc.error}` : lc ? "live" : "…"],
      ]),
    );
    if (lc?.error) inspectorEl.append(muted(`connection refused · ${lc.error}`, "err"));
    else if (lc?.dead()) {
      inspectorEl.append(muted("timed out — the client is desynced", "err"));
      inspectorEl.append(button("reconnect", "primary", () => void rebuildWires()));
    } else if (lc) inspectorEl.append(muted("● live", "ok"));

    inspectorEl.append(section("faults"));
    inspectorEl.append(faultControls(conn));

    inspectorEl.append(
      button("disconnect", "danger", () => disconnect(conn.id)),
      button("select client", "", () => select(conn.clientId)),
    );
  }

  /** Live sliders / toggles for one connection's `FaultSpec`. Edits mutate the
   *  spec in place — both transports hold the same object — so they take effect
   *  on the next frame; the edge colour follows immediately. */
  function faultControls(conn: Connection): HTMLElement {
    const wrap = div("fault-ctls");
    const f = conn.faults;
    const touched = () => {
      drawWires();
      capture({ kind: "fault", connId: conn.id, faults: { ...f } });
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
      f.applyTo = selValue(applyTo) as typeof f.applyTo;
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

  function behaviorRow(inst: Instance, fnName: string): HTMLElement {
    const found = findProtocol(session!.shape, inst.schemaNs, inst.protocol)!;
    const fn = found.protocol.functions.find((f) => f.name === fnName)!;
    const setting = inst.behaviors[fnName];

    const wrap = div("behavior-row");
    const head = div("behavior-head");
    const name = document.createElement("span");
    name.className = "behavior-fn mono";
    name.textContent = fnName;
    const sel = document.createElement("select");
    sel.className = "behavior-kind";
    for (const kind of BEHAVIOR_KINDS) {
      if (!BEHAVIORS[kind].appliesTo(fn)) continue;
      sel.append(opt(kind, BEHAVIORS[kind].label, kind === setting.kind));
    }
    head.append(name, sel);
    wrap.append(head);

    const applyLive = () => {
      capture({ kind: "behavior", instanceId: inst.id, fn: fnName, setting: inst.behaviors[fnName] });
      for (const lc of wires.forInstance(inst.id)) {
        if (!lc.error) lc.setBehavior(fnName, inst.behaviors[fnName]);
      }
    };

    const cfgHost = div("behavior-cfg-host");
    wrap.append(cfgHost);

    const renderConfig = () => {
      cfgHost.replaceChildren();
      if (inst.behaviors[fnName].kind === "forward") {
        cfgHost.append(forwardConfig(inst, fnName, applyLive));
        return;
      }
      const cfg = document.createElement("textarea");
      cfg.className = "behavior-config mono";
      cfg.rows = 3;
      cfg.spellcheck = false;
      cfg.value = JSON.stringify(inst.behaviors[fnName].config, null, 1);
      cfg.addEventListener("change", () => {
        try {
          inst.behaviors[fnName].config = JSON.parse(cfg.value || "{}") as Record<string, unknown>;
          cfg.classList.remove("bad");
          applyLive();
        } catch {
          cfg.classList.add("bad");
        }
      });
      cfgHost.append(cfg);
    };

    sel.addEventListener("change", () => {
      setBehavior(session!, inst.id, fnName, selValue(sel) as BehaviorKind);
      renderConfig();
      applyLive();
    });
    renderConfig();
    return wrap;
  }

  /** The two-select editor for a `Forward` behaviour: which connection to relay
   *  over, and which function to call on it. */
  function forwardConfig(inst: Instance, fnName: string, applyLive: () => void): HTMLElement {
    const wrap = div("forward-cfg");
    const cfg = inst.behaviors[fnName].config as { viaConnectionId?: string; targetFn?: string };

    const viaSel = document.createElement("select");
    viaSel.className = "forward-via";
    viaSel.append(opt("", "via connection…", !cfg.viaConnectionId));
    for (const conn of session!.connections) {
      const c = instance(session!, conn.clientId);
      const s = instance(session!, conn.serverId);
      viaSel.append(
        opt(conn.id, `${c?.name ?? conn.clientId} → ${s?.name ?? conn.serverId}`, conn.id === cfg.viaConnectionId),
      );
    }

    const fnHost = div("forward-fn-host");
    const renderFnSel = () => {
      fnHost.replaceChildren();
      const conn = session!.connections.find((x) => x.id === selValue(viaSel));
      const s = conn && instance(session!, conn.serverId);
      const found = s && findProtocol(session!.shape, s.schemaNs, s.protocol);
      if (!found) return;
      const fnSel = document.createElement("select");
      fnSel.className = "forward-fn";
      found.protocol.functions.forEach((f, i) =>
        fnSel.append(opt(f.name, f.name, f.name === cfg.targetFn || (i === 0 && !cfg.targetFn))),
      );
      fnSel.addEventListener("change", () => {
        cfg.targetFn = selValue(fnSel);
        applyLive();
      });
      cfg.targetFn ??= found.protocol.functions[0]?.name;
      fnHost.append(row("fn", fnSel));
    };

    viaSel.addEventListener("change", () => {
      cfg.viaConnectionId = selValue(viaSel);
      renderFnSel();
      applyLive();
    });
    renderFnSel();
    wrap.append(row("via", viaSel), fnHost);
    return wrap;
  }

  function renderCallForm(inst: Instance): HTMLElement {
    const found = findProtocol(session!.shape, inst.schemaNs, inst.protocol)!;
    const wrap = div("call-form");
    wrap.append(section("call"));

    // pick which connection to call over, when the client has more than one
    const liveConns = wires.forInstance(inst.id).filter((lc) => !lc.error);
    let connSel: HTMLSelectElement | null = null;
    if (liveConns.length > 1) {
      connSel = document.createElement("select");
      connSel.className = "call-conn";
      liveConns.forEach((lc, i) => connSel!.append(opt(lc.connId, `→ ${lc.serverName}`, i === 0)));
      wrap.append(row("via", connSel));
    }
    const pickLive = () =>
      connSel ? wires.get(selValue(connSel)) ?? liveConns[0] : liveConns[0];

    const fnSel = document.createElement("select");
    fnSel.className = "call-fn";
    found.protocol.functions.forEach((fn, i) => fnSel.append(opt(fn.name, fn.name, i === 0)));
    wrap.append(row("fn", fnSel));

    const formHost = div("call-args");
    wrap.append(formHost);

    const out = div("call-out mono");
    wrap.append(out);

    const send = button("send", "primary", async () => {
      const lc = pickLive();
      if (!callForm || !lc) return;
      out.className = "call-out mono";
      let params: unknown;
      try {
        params = callForm.read();
      } catch (e) {
        out.textContent = (e as Error).message;
        out.classList.add("err");
        return;
      }
      out.textContent = "…";
      const fnName = selValue(fnSel);
      capture({ kind: "call", connId: lc.connId, fn: fnName, params });
      try {
        const res = await lc.call(fnName, params);
        out.textContent = res === undefined ? "(no reply)" : JSON.stringify(res, null, 2);
        out.classList.add("ok");
      } catch (e) {
        if (e instanceof SimRemoteError) {
          out.textContent = `${e.errorName ?? "error " + e.ordinal} ${JSON.stringify(e.data)}`;
        } else {
          out.textContent = (e as Error).message;
        }
        out.classList.add("err");
      }
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
  function renderAll() {
    renderPalette();
    renderCanvas();
    renderInspector();
  }

  return {
    el,
    setShape(shape, serialized) {
      const restored = serialized ? decodeSession(serialized, shape) : null;
      if (restored) {
        session = restored;
        selectedId = null;
        selectedConnId = null;
      } else if (!session) {
        session = emptySession(shape);
      } else {
        rebuild(session, shape);
      }
      if (selectedId && !instance(session, selectedId)) selectedId = null;
      if (selectedConnId && !session.connections.some((c) => c.id === selectedConnId)) {
        selectedConnId = null;
      }
      if (session.clockMode === "stepped" && !(clock instanceof SteppedClock)) {
        clock = new SteppedClock();
      }
      wires.clock = clock;
      flog.setClockBar(clockBar());
      renderPalette();
      void rebuildWires(); // re-handshake every wire against the new shape
    },
    serialize() {
      return session ? encodeSession(session) : "";
    },
    record(on) {
      if (on) {
        if (session) recorder.start(session, clock.now());
        flog.setClockBar(clockBar());
        return null;
      }
      lastRecording = recorder.stop();
      flog.setClockBar(clockBar());
      return lastRecording;
    },
    async replay(rec) {
      lastRecording = rec;
      await replayInView(rec);
    },
    destroy() {
      window.removeEventListener("resize", onResize);
      if (clock instanceof SteppedClock) clock.pause();
      wires.closeAll();
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
/** The chosen value — resilient to a DOM where `<select>.value` isn't populated. */
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
