/// The full-width simulate view: a palette of protocol × role, a canvas the
/// instances sit on, one connection between a client and a server, an inspector
/// (instance facts, per-function behaviours, and — for a connected client — the
/// call form), and the frame list. Everything 1c does, through the UI.

import { BEHAVIORS, BEHAVIOR_KINDS, type BehaviorKind } from "../behavior.ts";
import { connect, type LiveConnection } from "../engine.ts";
import { SimRemoteError } from "../generic.ts";
import {
  addInstance,
  emptySession,
  instance,
  rebuild,
  removeInstance,
  resyncInstance,
  setBehavior,
  setConnection,
  type Instance,
  type Role,
  type Session,
} from "../model.ts";
import { findProtocol, type ProjectShape } from "../shape.ts";
import type { DecodeCtx } from "../framedecode.ts";
import { argsForm, type ArgsForm } from "./argsform.ts";
import { frameLog } from "./framelog.ts";

const SVGNS = "http://www.w3.org/2000/svg";

export interface SimView {
  el: HTMLElement;
  /** Point at a freshly compiled shape (schemas were edited). */
  setShape(shape: ProjectShape): void;
  destroy(): void;
}

export function createSim(): SimView {
  let session: Session | null = null;
  let live: LiveConnection | null = null;
  let selectedId: string | null = null;
  let callForm: ArgsForm | null = null;

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

  const onResize = () => drawWire();
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
    hint.textContent = "drag onto the canvas";
    paletteEl.append(hint);
  }

  // ── canvas ───────────────────────────────────────────────────────────
  const NODE_W = 150;
  const NODE_H = 52;
  let hoverId: string | null = null; // node the pointer is over, for drop-to-connect

  const dropHint = document.createElement("p");
  dropHint.className = "muted pad canvas-hint";
  dropHint.textContent = "drag a client and a server here, then drag between their ports";
  canvasEl.append(dropHint);

  /** Event point in canvas coordinates, or `null` when the environment has no
   *  layout (jsdom / linkedom in tests). */
  function canvasPoint(e: { clientX?: number; clientY?: number }): { x: number; y: number } | null {
    if (typeof e.clientX !== "number" || typeof e.clientY !== "number") return null;
    const r = canvasEl.getBoundingClientRect();
    return { x: e.clientX - r.left + canvasEl.scrollLeft, y: e.clientY - r.top + canvasEl.scrollTop };
  }

  canvasEl.addEventListener("dragover", (e) => e.preventDefault());
  canvasEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const raw = e.dataTransfer?.getData("application/json");
    if (!raw || !session) return;
    const spec = JSON.parse(raw) as { schemaNs: string; protocol: string; role: Role };
    const p = canvasPoint(e);
    const n = session.instances.length;
    const inst = addInstance(session, {
      ...spec,
      x: Math.max(8, (p?.x ?? 48 + n * 30) - NODE_W / 2),
      y: Math.max(8, (p?.y ?? 48 + n * 26) - NODE_H / 2),
    });
    selectedId = inst.id;
    renderAll();
  });

  function nodeEl(id: string): HTMLElement | null {
    return canvasEl.querySelector<HTMLElement>(`.sim-node[data-id="${id}"]`);
  }

  function connected(id: string): boolean {
    const c = session?.connection;
    return !!c && (c.clientId === id || c.serverId === id);
  }

  function select(id: string) {
    selectedId = id;
    renderCanvas();
    renderInspector();
  }

  function renderCanvas() {
    for (const n of [...canvasEl.querySelectorAll(".sim-node")]) n.remove();
    if (!session) return;
    for (const inst of session.instances) canvasEl.append(nodeCard(inst));
    dropHint.hidden = session.instances.length > 0;
    drawWire();
  }

  function nodeCard(inst: Instance): HTMLElement {
    const n = div(`sim-node role-${inst.role}`);
    n.dataset.id = inst.id;
    n.style.left = `${inst.x}px`;
    n.style.top = `${inst.y}px`;
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
    n.addEventListener("pointerdown", (e) => startNodeDrag(e, inst, n));
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

  function startNodeDrag(e: PointerEvent, inst: Instance, n: HTMLElement) {
    if ((e.target as HTMLElement | null)?.closest(".node-port")) return;
    const start = canvasPoint(e);
    if (!start) return; // no layout — the click handler does the selecting
    const ox = start.x - inst.x;
    const oy = start.y - inst.y;
    let moved = false;
    n.setPointerCapture?.(e.pointerId);

    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev);
      if (!p) return;
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      moved = true;
      inst.x = Math.max(0, Math.round(p.x - ox));
      inst.y = Math.max(0, Math.round(p.y - oy));
      n.style.left = `${inst.x}px`;
      n.style.top = `${inst.y}px`;
      drawWire();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startConnectDrag(e: PointerEvent, from: Instance) {
    hoverId = null;
    const fromNode = nodeEl(from.id);
    const a = fromNode ? center(fromNode) : { x: 0, y: 0 };
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
    try {
      setConnection(session, clientId, serverId);
    } catch (err) {
      flashInspectorError((err as Error).message);
      return;
    }
    selectedId = clientId; // land on the client — its call form is the next step
    void reconnect();
  }

  function drawWire() {
    for (const l of [...wireSvg.querySelectorAll("line:not(.wire-drag)")]) l.remove();
    if (!session?.connection) return;
    const c = nodeEl(session.connection.clientId);
    const s = nodeEl(session.connection.serverId);
    if (!c || !s) return;
    const a = center(c);
    const b = center(s);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    line.setAttribute("class", live?.error ? "wire-refused" : live ? "wire-live" : "wire-pending");
    wireSvg.append(line);
  }

  function center(node: HTMLElement) {
    return { x: node.offsetLeft + node.offsetWidth / 2, y: node.offsetTop + node.offsetHeight / 2 };
  }

  // ── connect / disconnect ─────────────────────────────────────────────
  async function reconnect() {
    live?.close();
    live = null;
    if (session?.connection) {
      try {
        live = await connect(session, session.connection);
      } catch (e) {
        flashInspectorError((e as Error).message);
      }
    }
    let ctx: DecodeCtx | undefined;
    if (live && session) {
      const found = findProtocol(
        session.shape,
        instance(session, session.connection!.serverId)!.schemaNs,
        instance(session, session.connection!.serverId)!.protocol,
      );
      if (found) {
        ctx = {
          clientName: live.clientName,
          serverName: live.serverName,
          framing: live.framing,
          fnNames: found.protocol.functions.map((f) => f.name),
        };
      }
    }
    flog.attach(live?.tap ?? null, ctx, live?.error ?? null);
    renderCanvas();
    renderInspector();
  }

  function partnersFor(inst: Instance): Instance[] {
    if (!session) return [];
    const want: Role = inst.role === "client" ? "server" : "client";
    return session.instances.filter(
      (i) => i.role === want && i.protocol === inst.protocol && i.schemaNs === inst.schemaNs,
    );
  }

  function connectedPartnerId(inst: Instance): string | null {
    const conn = session?.connection;
    if (!conn) return null;
    if (conn.clientId === inst.id) return conn.serverId;
    if (conn.serverId === inst.id) return conn.clientId;
    return null;
  }

  // ── inspector ────────────────────────────────────────────────────────
  function renderInspector() {
    inspectorEl.replaceChildren();
    callForm = null;
    if (!session) return;
    const sel = selectedId ? instance(session, selectedId) : undefined;
    if (!sel) {
      inspectorEl.append(muted("select an instance"));
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
      const resync = button("resync — schema changed", "danger", () => {
        resyncInstance(session!, sel.id);
        void reconnect();
        renderAll();
      });
      inspectorEl.append(resync);
    }

    // remove
    const rm = button("remove instance", "danger", () => {
      removeInstance(session!, sel.id);
      if (selectedId === sel.id) selectedId = null;
      void reconnect();
      renderAll();
    });
    inspectorEl.append(rm);

    // connect control
    const partnerId = connectedPartnerId(sel);
    const connectSel = document.createElement("select");
    connectSel.className = "connect-sel";
    connectSel.append(opt("", "— not connected —", !partnerId));
    for (const p of partnersFor(sel)) connectSel.append(opt(p.id, p.name, p.id === partnerId));
    connectSel.addEventListener("change", () => {
      const otherId = selValue(connectSel);
      if (!otherId) {
        session!.connection = null;
      } else {
        const [clientId, serverId] =
          sel.role === "client" ? [sel.id, otherId] : [otherId, sel.id];
        try {
          setConnection(session!, clientId, serverId);
        } catch (e) {
          flashInspectorError((e as Error).message);
          return;
        }
      }
      void reconnect();
    });
    inspectorEl.append(section("connection"), row("partner", connectSel));

    const latency = document.createElement("input");
    latency.type = "number";
    latency.min = "0";
    latency.step = "10";
    latency.value = String(session.latencyMs);
    latency.addEventListener("change", () => {
      session!.latencyMs = Math.max(0, Number(latency.value) || 0);
      void reconnect();
    });
    inspectorEl.append(row("latency ms", latency));

    if (session.connection && live?.error) {
      inspectorEl.append(muted(`connection refused · ${live.error}`, "err"));
    } else if (session.connection && live) {
      inspectorEl.append(muted("● live", "ok"));
    }

    // server: per-function behaviours
    if (sel.role === "server") {
      inspectorEl.append(section("behaviours"));
      for (const fn of found.protocol.functions) {
        inspectorEl.append(behaviorRow(sel, fn.name));
      }
    }

    // client + live: the call form
    if (sel.role === "client" && live && !live.error && connectedPartnerId(sel)) {
      inspectorEl.append(renderCallForm(sel));
    }
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

    const cfg = document.createElement("textarea");
    cfg.className = "behavior-config mono";
    cfg.rows = 3;
    cfg.spellcheck = false;
    cfg.value = JSON.stringify(setting.config, null, 1);
    wrap.append(cfg);

    const applyLive = () => {
      if (live && !live.error && connectedPartnerId(inst)) live.setBehavior(fnName, inst.behaviors[fnName]);
    };
    sel.addEventListener("change", () => {
      setBehavior(session!, inst.id, fnName, selValue(sel) as BehaviorKind);
      cfg.value = JSON.stringify(inst.behaviors[fnName].config, null, 1);
      applyLive();
    });
    cfg.addEventListener("change", () => {
      try {
        const parsed = JSON.parse(cfg.value || "{}") as Record<string, unknown>;
        inst.behaviors[fnName].config = parsed;
        cfg.classList.remove("bad");
        applyLive();
      } catch {
        cfg.classList.add("bad");
      }
    });
    return wrap;
  }

  function renderCallForm(inst: Instance): HTMLElement {
    const found = findProtocol(session!.shape, inst.schemaNs, inst.protocol)!;
    const wrap = div("call-form");
    wrap.append(section("call"));

    const fnSel = document.createElement("select");
    fnSel.className = "call-fn";
    found.protocol.functions.forEach((fn, i) => fnSel.append(opt(fn.name, fn.name, i === 0)));
    wrap.append(row("fn", fnSel));

    const formHost = div("call-args");
    wrap.append(formHost);

    const out = div("call-out mono");
    wrap.append(out);

    const send = button("send", "primary", async () => {
      if (!callForm || !live) return;
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
      try {
        const res = await live.call(selValue(fnSel), params);
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
    setShape(shape) {
      if (!session) session = emptySession(shape);
      else rebuild(session, shape);
      if (selectedId && !instance(session, selectedId)) selectedId = null;
      void reconnect(); // pick up any framing / ir_hash change, or drop a dead connection
      renderAll();
    },
    destroy() {
      window.removeEventListener("resize", onResize);
      live?.close();
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
