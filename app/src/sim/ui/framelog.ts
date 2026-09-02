/// The frame list under the canvas. Subscribes to a `Tap` and appends a row
/// per frame. 1d keeps it plain — seq, direction, kind, byte length; 1e turns
/// rows into expandable envelope inspectors.

import type { Frame, Tap } from "../transport.ts";

export interface FrameLog {
  el: HTMLElement;
  /** Point at a new tap (a fresh connection); clears the list. */
  attach(tap: Tap | null): void;
}

export function frameLog(): FrameLog {
  const el = document.createElement("div");
  el.className = "sim-frames";

  const head = document.createElement("div");
  head.className = "sim-frames-head";
  head.textContent = "frames";

  const list = document.createElement("div");
  list.className = "sim-frames-list mono";

  const empty = document.createElement("p");
  empty.className = "muted pad";
  empty.textContent = "no connection";
  list.append(empty);

  el.append(head, list);

  let unsub: (() => void) | null = null;

  const row = (f: Frame) => {
    const r = document.createElement("div");
    r.className = `frame-row frame-${f.kind}`;
    r.append(
      span("frame-seq", String(f.seq).padStart(3, "0")),
      span("frame-dir", `${f.from} → ${f.to}`),
      span("frame-kind", f.kind),
      span("frame-len", `${f.bytes.length} B`),
    );
    return r;
  };

  return {
    el,
    attach(tap) {
      unsub?.();
      unsub = null;
      list.replaceChildren();
      if (!tap) {
        list.append(empty);
        return;
      }
      for (const f of tap.frames) list.append(row(f));
      scroll(list);
      unsub = tap.on((f) => {
        list.append(row(f));
        scroll(list);
      });
    },
  };
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function scroll(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}
