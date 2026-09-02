/// The frame inspector under the canvas. It merges the taps of every live
/// connection into one time-ordered list — a row per frame: connection (when
/// there is more than one), direction, kind, function, round-trip time (on the
/// reply, measured from its own request by id — not wall-clock gap, which is
/// mostly idle time), byte length — expanding to the decoded envelope, the raw
/// hex, and the framing name. A wall-clock gap over `IDLE_MS` inserts an `idle`
/// separator. Every row kind — handshake / request / response / idle — and
/// every connection is filterable from the header. A refused connection gets
/// its own row.

import { describeFrame, toHex, type DecodeCtx } from "../framedecode.ts";
import type { Frame, Tap } from "../transport.ts";

export interface LogSource {
  connId: string;
  /** Short label for the connection column / filter, e.g. `chat-2→chat-1`. */
  label: string;
  tap: Tap;
  ctx?: DecodeCtx;
  error?: string | null;
}

export interface FrameLog {
  el: HTMLElement;
  /** Replace the set of connections being logged. Clears and re-renders. */
  setSources(sources: LogSource[]): void;
}

const IDLE_MS = 2000;

export function frameLog(): FrameLog {
  const el = document.createElement("div");
  el.className = "sim-frames";

  const head = document.createElement("div");
  head.className = "sim-frames-head";
  const title = document.createElement("span");
  title.textContent = "frames";

  const hidden = new Set<string>(); // hidden row kinds
  const hiddenConns = new Set<string>(); // hidden connection ids

  const kindFilters = document.createElement("div");
  kindFilters.className = "frame-filters";
  for (const k of ["handshake", "request", "response", "idle"]) {
    const b = document.createElement("button");
    b.className = "frame-filter on";
    b.dataset.kind = k;
    b.textContent = k;
    b.addEventListener("click", () => {
      if (hidden.delete(k)) b.classList.add("on");
      else (hidden.add(k), b.classList.remove("on"));
      applyFilter();
    });
    kindFilters.append(b);
  }

  const connFilters = document.createElement("div");
  connFilters.className = "frame-filters conn-filters";

  const clear = document.createElement("button");
  clear.className = "icon-btn";
  clear.textContent = "clear";
  head.append(title, kindFilters, connFilters, clear);

  const list = document.createElement("div");
  list.className = "sim-frames-list";
  el.append(head, list);

  let sources: LogSource[] = [];
  const unsubs: (() => void)[] = [];
  const ctxByConn = new Map<string, DecodeCtx | undefined>();
  const labelByConn = new Map<string, string>();
  const sentAt = new Map<string, number>(); // `${connId}:${requestId}` → sent-at
  let lastAt: number | null = null;
  let multi = false;

  function applyFilter() {
    for (const r of list.querySelectorAll<HTMLElement>(".frame-row, .frame-idle")) {
      const byKind = hidden.has(r.dataset.kind ?? "");
      const byConn = r.dataset.conn ? hiddenConns.has(r.dataset.conn) : false;
      r.hidden = byKind || byConn;
    }
  }

  function renderConnFilters() {
    connFilters.replaceChildren();
    if (!multi) return;
    for (const s of sources) {
      const b = document.createElement("button");
      b.className = "frame-filter on";
      b.textContent = s.label;
      b.addEventListener("click", () => {
        if (hiddenConns.delete(s.connId)) b.classList.add("on");
        else (hiddenConns.add(s.connId), b.classList.remove("on"));
        applyFilter();
      });
      connFilters.append(b);
    }
  }

  function addRow(connId: string, f: Frame) {
    const ctx = ctxByConn.get(connId);
    const detail = ctx ? describeFrame(f, ctx) : { kind: f.kind, framing: "?" };

    if (lastAt !== null && f.at - lastAt > IDLE_MS) {
      const sep = document.createElement("div");
      sep.className = "frame-idle";
      sep.dataset.kind = "idle";
      sep.hidden = hidden.has("idle");
      sep.textContent = `⋯ ${humanGap(f.at - lastAt)} idle`;
      list.append(sep);
    }
    lastAt = f.at;

    let rttText = "";
    if (detail.requestId) {
      const key = `${connId}:${detail.requestId}`;
      if (detail.kind === "request") sentAt.set(key, f.at);
      else if (detail.kind === "response" && sentAt.has(key)) {
        rttText = `${Math.round(f.at - sentAt.get(key)!)} ms`;
        sentAt.delete(key);
      }
    }

    const row = document.createElement("details");
    row.className = `frame-row frame-${detail.kind}${multi ? " has-conn" : ""}`;
    row.dataset.kind = detail.kind;
    row.dataset.conn = connId;
    row.hidden = hidden.has(detail.kind) || hiddenConns.has(connId);

    const summary = document.createElement("summary");
    const rtt = cell("frame-delta", rttText);
    if (rttText) rtt.title = "round-trip time";
    const cells = [
      cell("frame-seq", String(f.seq).padStart(3, "0")),
      cell("frame-dir", `${f.from} → ${f.to}`),
      cell("frame-kind", detail.kind),
      cell("frame-fn", detail.fn ?? (detail.err ? `err ${detail.err.ordinal}` : "")),
      rtt,
      cell("frame-len", `${f.bytes.length} B`),
    ];
    if (multi) cells.unshift(cell("frame-conn", labelByConn.get(connId) ?? connId));
    summary.append(...cells);
    row.append(summary);

    const body = document.createElement("div");
    body.className = "frame-body mono";
    body.append(kv("framing", detail.framing));
    if (detail.handshake) {
      body.append(
        kv("ir_hash", detail.handshake.irHash),
        kv("wire_format", detail.handshake.wireFormat),
        kv("framing_name", detail.handshake.framing),
      );
    }
    if (detail.requestId !== undefined) body.append(kv("request_id", detail.requestId));
    if ("params" in detail) body.append(json("params", detail.params));
    if ("ok" in detail) body.append(json("ok", detail.ok));
    if (detail.err) body.append(json(`err · ordinal ${detail.err.ordinal}`, detail.err.body));

    const hexToggle = document.createElement("button");
    hexToggle.className = "hex-toggle";
    hexToggle.textContent = "hex";
    const hex = document.createElement("pre");
    hex.className = "frame-hex";
    hex.hidden = true;
    hex.textContent = toHex(f.bytes);
    hexToggle.addEventListener("click", (e) => {
      e.preventDefault();
      hex.hidden = !hex.hidden;
    });
    body.append(hexToggle, hex);

    row.append(body);
    list.append(row);
    list.scrollTop = list.scrollHeight;
  }

  function refusedRow(connId: string, reason: string) {
    const r = document.createElement("div");
    r.className = "frame-row frame-refused";
    r.dataset.conn = connId;
    r.textContent = `${multi ? (labelByConn.get(connId) ?? connId) + " · " : ""}connection refused · ${reason}`;
    list.append(r);
  }

  function teardown() {
    for (const u of unsubs.splice(0)) u();
    sentAt.clear();
    lastAt = null;
    list.replaceChildren();
  }

  clear.addEventListener("click", () => {
    sentAt.clear();
    lastAt = null;
    list.replaceChildren();
  });

  return {
    el,
    setSources(next) {
      teardown();
      sources = next;
      multi = next.length > 1;
      ctxByConn.clear();
      labelByConn.clear();
      for (const s of next) {
        ctxByConn.set(s.connId, s.ctx);
        labelByConn.set(s.connId, s.label);
      }
      renderConnFilters();

      if (next.length === 0) {
        const p = document.createElement("p");
        p.className = "muted pad";
        p.textContent = "no connection";
        list.append(p);
        return;
      }

      // backfill: every source's existing frames, merge-sorted by arrival
      const backlog = next
        .flatMap((s) => s.tap.frames.map((f) => ({ connId: s.connId, f })))
        .sort((a, b) => a.f.at - b.f.at);
      for (const { connId, f } of backlog) addRow(connId, f);
      for (const s of next) if (s.error) refusedRow(s.connId, s.error);

      for (const s of next) unsubs.push(s.tap.on((f) => addRow(s.connId, f)));
    },
  };
}

function humanGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

function cell(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
function kv(k: string, v: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "frame-kv";
  d.append(cell("frame-k", k), cell("frame-v", v));
  return d;
}
function json(k: string, v: unknown): HTMLElement {
  const d = document.createElement("div");
  d.className = "frame-kv";
  const kk = cell("frame-k", k);
  const pre = document.createElement("pre");
  pre.className = "frame-json";
  pre.textContent = JSON.stringify(v, null, 2);
  d.append(kk, pre);
  return d;
}
