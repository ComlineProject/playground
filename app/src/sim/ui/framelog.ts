/// The frame inspector under the canvas. A row per frame — direction, kind,
/// function, Δ since the previous frame, byte length — expanding to the decoded
/// envelope, the raw hex, and the framing name. Handshake frames read
/// distinctly; a refused connection gets its own row.

import { describeFrame, toHex, type DecodeCtx } from "../framedecode.ts";
import type { Frame, Tap } from "../transport.ts";

export interface FrameLog {
  el: HTMLElement;
  /** Point at a new connection's tap. `ctx` decodes the frames; `error` (e.g.
   *  `"handshake"`) appends a refusal row. Clears the list. */
  attach(tap: Tap | null, ctx?: DecodeCtx, error?: string | null): void;
}

export function frameLog(): FrameLog {
  const el = document.createElement("div");
  el.className = "sim-frames";

  const head = document.createElement("div");
  head.className = "sim-frames-head";
  const title = document.createElement("span");
  title.textContent = "frames";

  // kind filter — a toggle per row kind; hidden kinds persist across attaches.
  const hidden = new Set<string>();
  const filters = document.createElement("div");
  filters.className = "frame-filters";
  for (const k of ["handshake", "request", "response"]) {
    const b = document.createElement("button");
    b.className = "frame-filter on";
    b.dataset.kind = k;
    b.textContent = k;
    b.addEventListener("click", () => {
      if (hidden.delete(k)) b.classList.add("on");
      else (hidden.add(k), b.classList.remove("on"));
      applyFilter();
    });
    filters.append(b);
  }
  const clear = document.createElement("button");
  clear.className = "icon-btn";
  clear.textContent = "clear";
  head.append(title, filters, clear);

  const list = document.createElement("div");
  list.className = "sim-frames-list";

  el.append(head, list);

  let unsub: (() => void) | null = null;
  let ctx: DecodeCtx | null = null;
  let prevAt = 0;
  let first = true;

  function applyFilter() {
    for (const r of list.querySelectorAll<HTMLElement>(".frame-row")) {
      r.hidden = hidden.has(r.dataset.kind ?? "");
    }
  }

  const empty = () => {
    const p = document.createElement("p");
    p.className = "muted pad";
    p.textContent = "no connection";
    return p;
  };

  function addRow(f: Frame) {
    const detail = ctx ? describeFrame(f, ctx) : { kind: f.kind, framing: "?" };
    const delta = first ? 0 : Math.round(f.at - prevAt);
    prevAt = f.at;
    first = false;

    const row = document.createElement("details");
    row.className = `frame-row frame-${detail.kind}`;
    row.dataset.kind = detail.kind;
    row.hidden = hidden.has(detail.kind);

    const summary = document.createElement("summary");
    summary.append(
      cell("frame-seq", String(f.seq).padStart(3, "0")),
      cell("frame-dir", `${f.from} → ${f.to}`),
      cell("frame-kind", detail.kind),
      cell("frame-fn", detail.fn ?? (detail.err ? `err ${detail.err.ordinal}` : "")),
      cell("frame-delta", delta ? `+${delta} ms` : ""),
      cell("frame-len", `${f.bytes.length} B`),
    );
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

  function refusedRow(reason: string) {
    const r = document.createElement("div");
    r.className = "frame-row frame-refused";
    r.textContent = `connection refused · ${reason}`;
    list.append(r);
  }

  clear.addEventListener("click", () => {
    list.replaceChildren();
    prevAt = 0;
    first = true;
  });

  return {
    el,
    attach(tap, decodeCtx, error) {
      unsub?.();
      unsub = null;
      ctx = decodeCtx ?? null;
      prevAt = 0;
      first = true;
      list.replaceChildren();
      if (!tap) {
        list.append(empty());
        return;
      }
      for (const f of tap.frames) addRow(f);
      if (error) refusedRow(error);
      unsub = tap.on(addRow);
    },
  };
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
