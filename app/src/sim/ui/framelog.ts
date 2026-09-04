/// The frame inspector under the canvas. It merges the frame logs of every live
/// connection into one time-ordered list under a labelled column header — a row
/// per frame: connection (when there is more than one), direction, kind,
/// function, round-trip time (on the reply, from its own request by id), byte
/// length — expanding to the decoded envelope, the framing name, and the raw
/// bytes as hex or text. A gap in *virtual* time over `IDLE_MS` inserts an
/// `idle` separator. Every row kind and every connection is filterable from the
/// header. A refused connection gets its own row. The pane's height is
/// drag-resizable by its top grip.
///
/// The engine is the `comline-simulator` wasm now: frames are polled from the
/// `Sim`, not pushed from a `Tap`. The view calls `poll()` after it advances the
/// clock.

/** One decoded frame, as the `Sim` returns it. */
export interface Frame {
  seq: number;
  from: string;
  to: string;
  bytes: number[];
  at: number;
  kind: "handshake" | "request" | "response";
  fault?: string | null;
}

/** `Sim.describe_frame` output. */
export interface FrameDetail {
  kind: "handshake" | "request" | "response" | "unknown";
  framing: string;
  fn?: string;
  requestId?: string;
  params?: unknown;
  ok?: unknown;
  err?: { ordinal: number; body: unknown };
  handshake?: { irHash: string; wireFormat: string; framing: string; caps: number };
}

export interface LogSource {
  connId: string;
  /** Short label for the connection column / filter, e.g. `chat-2→chat-1`. */
  label: string;
  error?: string | null;
}

/** How the log reads frames — a thin view over the `Sim`. */
export interface FrameSource {
  frames(connId: string): Frame[];
  detail(connId: string, seq: number): FrameDetail | null;
}

export interface ClockBar {
  mode: "real" | "stepped";
  seed: number;
  /** Stepped mode only — the step / play controls show when true. */
  stepped: boolean;
  now: number;
  pending: number;
  playing: boolean;
  recording: boolean;
  hasRecording: boolean;
  onMode(mode: "real" | "stepped"): void;
  onSeed(seed: number): void;
  /** Put the session on the URL fragment + clipboard; returns the shareable URL. */
  onShare(): string;
  onRecord(on: boolean): void;
  onReplay(): void;
  onExport(): void;
  onImport(json: string): void;
  onStep(): void;
  onPlay(): void;
  onPause(): void;
  onSpeed(x: number): void;
}

export interface FrameLog {
  el: HTMLElement;
  /** Replace the set of connections being logged. Clears and re-renders. */
  setSources(sources: LogSource[], source: FrameSource): void;
  /** Re-read every source and append rows for frames not shown yet. */
  poll(): void;
  /** Render the clock / seed controls in the header. */
  setClockBar(bar: ClockBar): void;
}

const IDLE_MS = 2000;

/** Height (px) of the frames pane — grabbed by its grip, kept per-viewer. */
const HEIGHT_KEY = "sim.frames.height";
function storedHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function frameLog(): FrameLog {
  const el = document.createElement("div");
  el.className = "sim-frames";

  // ── resize grip ──────────────────────────────────────────────────────
  // drags the `.sim` grid's bottom row; the canvas above takes the rest.
  const grip = document.createElement("div");
  grip.className = "sim-frames-grip";
  grip.title = "drag to resize";
  const applyHeight = (h: number) => {
    const sim = el.closest<HTMLElement>(".sim");
    if (!sim) return;
    const max = Math.max(140, sim.clientHeight - 160);
    const clamped = Math.round(Math.min(max, Math.max(120, h)));
    sim.style.gridTemplateRows = `1fr ${clamped}px`;
    try {
      localStorage.setItem(HEIGHT_KEY, String(clamped));
    } catch {
      /* private mode — just don't persist */
    }
  };
  const saved = storedHeight();
  if (saved !== null && typeof requestAnimationFrame === "function") {
    const apply = () => (el.closest(".sim") ? applyHeight(saved) : requestAnimationFrame(apply));
    requestAnimationFrame(apply);
  }
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = el.clientHeight;
    const move = (ev: PointerEvent) => applyHeight(startH + (startY - ev.clientY));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  const head = document.createElement("div");
  head.className = "sim-frames-head";
  const title = document.createElement("span");
  title.textContent = "frames";

  const hidden = new Set<string>();
  const hiddenConns = new Set<string>();

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

  const clockBar = document.createElement("div");
  clockBar.className = "clock-bar";

  const clear = document.createElement("button");
  clear.className = "icon-btn";
  clear.textContent = "clear";
  head.append(title, kindFilters, connFilters, clockBar, clear);

  // column header — same grid as each row's `<summary>` (see the CSS)
  const cols = document.createElement("div");
  cols.className = "sim-frames-cols";
  for (const [cls, label, hint] of [
    ["frame-conn", "conn", "which connection this frame is on"],
    ["frame-seq", "#", "frame number, in the order they crossed the wire"],
    ["frame-dir", "direction", "sender → receiver (instance names)"],
    ["frame-kind", "kind", "handshake, request, or response"],
    ["frame-fn", "function", "the protocol function this frame belongs to"],
    ["frame-delta", "rtt", "round-trip time — on the response, measured from its own request"],
    ["frame-len", "bytes", "encoded size of the frame on the wire"],
  ] as const) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = label;
    s.title = hint;
    cols.append(s);
  }

  const list = document.createElement("div");
  list.className = "sim-frames-list";
  el.append(grip, head, cols, list);

  let sources: LogSource[] = [];
  let api: FrameSource = { frames: () => [], detail: () => null };
  const labelByConn = new Map<string, string>();
  const shownByConn = new Map<string, number>(); // connId → count of frames rendered
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
    const detail = api.detail(connId, f.seq) ?? { kind: f.kind, framing: "?" };

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

    const dropped = /dropped/.test(f.fault ?? "");
    const row = document.createElement("details");
    row.className = `frame-row frame-${detail.kind}${multi ? " has-conn" : ""}${
      f.fault ? " frame-faulted" : ""
    }${dropped ? " frame-dropped" : ""}`;
    row.dataset.kind = detail.kind;
    row.dataset.conn = connId;
    row.hidden = hidden.has(detail.kind) || hiddenConns.has(connId);

    const summary = document.createElement("summary");
    const rtt = cell("frame-delta", rttText);
    if (rttText) rtt.title = "round-trip time";
    const kindText = f.fault ? `${detail.kind} · ${f.fault}` : detail.kind;
    const cells = [
      cell("frame-seq", String(f.seq).padStart(3, "0")),
      cell("frame-dir", `${f.from} → ${f.to}`),
      cell("frame-kind", kindText),
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

    // raw bytes — as hex, or decoded as text (non-printables → ·)
    const rawBtns = document.createElement("div");
    rawBtns.className = "frame-raw-btns";
    const rawPanes: HTMLElement[] = [];
    for (const [label, text] of [
      ["hex", toHex(f.bytes)],
      ["text", bytesAsText(f.bytes)],
    ] as const) {
      const btn = document.createElement("button");
      btn.className = "bytes-toggle";
      btn.textContent = label;
      const pre = document.createElement("pre");
      pre.className = "frame-bytes";
      pre.hidden = true;
      pre.textContent = text;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        pre.hidden = !pre.hidden;
        btn.classList.toggle("on", !pre.hidden);
      });
      rawBtns.append(btn);
      rawPanes.push(pre);
    }
    body.append(rawBtns, ...rawPanes);

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

  // `keepCursor`: wipe the rows on screen but leave `shownByConn` where it is,
  // so the *next* poll only shows frames that arrive after this point. The
  // `clear` button wants that; `setSources` (a fresh shape) wants a full reset.
  function resetList(keepCursor = false) {
    sentAt.clear();
    lastAt = null;
    list.replaceChildren();
    if (keepCursor) {
      for (const s of sources) shownByConn.set(s.connId, api.frames(s.connId).length);
    } else {
      shownByConn.clear();
    }
  }

  clear.addEventListener("click", () => resetList(true));

  return {
    el,
    setSources(next, next_api) {
      resetList();
      sources = next;
      api = next_api;
      multi = next.length > 1;
      cols.classList.toggle("has-conn", multi);
      labelByConn.clear();
      for (const s of next) labelByConn.set(s.connId, s.label);
      renderConnFilters();

      if (next.length === 0) {
        const p = document.createElement("p");
        p.className = "muted pad";
        p.textContent = "no connection";
        list.append(p);
        return;
      }
      this.poll();
      for (const s of next) if (s.error) refusedRow(s.connId, s.error);
    },
    poll() {
      // gather every source's un-shown frames, merge-sort by arrival time
      const fresh: { connId: string; f: Frame }[] = [];
      for (const s of sources) {
        const all = api.frames(s.connId);
        const from = shownByConn.get(s.connId) ?? 0;
        for (let i = from; i < all.length; i++) fresh.push({ connId: s.connId, f: all[i] });
        shownByConn.set(s.connId, all.length);
      }
      fresh.sort((a, b) => a.f.at - b.f.at);
      for (const { connId, f } of fresh) addRow(connId, f);
    },
    setClockBar(bar) {
      clockBar.replaceChildren();

      const mkBtn = (text: string, on: () => void) => {
        const b = document.createElement("button");
        b.className = "clock-btn";
        b.textContent = text;
        b.addEventListener("click", on);
        return b;
      };

      const mode = document.createElement("select");
      mode.className = "clock-mode";
      for (const m of ["real", "stepped"] as const) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = `⏱ ${m}`;
        o.selected = m === bar.mode;
        mode.append(o);
      }
      mode.addEventListener("change", () => bar.onMode((mode.value || "real") as "real" | "stepped"));
      clockBar.append(mode);

      const seed = document.createElement("input");
      seed.type = "number";
      seed.className = "clock-seed";
      seed.value = String(bar.seed);
      seed.title = "fault RNG seed — same seed, same run";
      seed.addEventListener("change", () => bar.onSeed(Math.trunc(Number(seed.value) || 0)));
      clockBar.append(seed);

      const share = mkBtn("⧉ link", () => {
        bar.onShare();
        share.textContent = "copied ✓";
        setTimeout(() => (share.textContent = "⧉ link"), 1500);
      });
      share.title = "copy a link that restores this topology";
      clockBar.append(share);

      const rec = mkBtn(bar.recording ? "■ stop" : "● rec", () => bar.onRecord(!bar.recording));
      rec.classList.toggle("recording", bar.recording);
      rec.title = "capture calls / behaviour & fault edits, then replay them";
      clockBar.append(rec);

      if (bar.hasRecording && !bar.recording) {
        clockBar.append(
          mkBtn("▷ replay", () => bar.onReplay()),
          mkBtn("⭳", () => bar.onExport()),
        );
      }
      const imp = document.createElement("label");
      imp.className = "clock-btn";
      imp.textContent = "⭱";
      imp.title = "import a recording";
      const file = document.createElement("input");
      file.type = "file";
      file.accept = "application/json,.json";
      file.hidden = true;
      file.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (f) bar.onImport(await f.text());
        file.value = "";
      });
      imp.append(file);
      clockBar.append(imp);

      if (!bar.stepped) return;

      const step = mkBtn("⏭", () => bar.onStep());
      step.disabled = bar.pending === 0;
      const play = mkBtn(bar.playing ? "⏸" : "▶", () => (bar.playing ? bar.onPause() : bar.onPlay()));
      const speed = document.createElement("select");
      speed.className = "clock-speed";
      for (const s of ["1", "4", "16"]) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = `${s}×`;
        speed.append(o);
      }
      speed.addEventListener("change", () => bar.onSpeed(Number(speed.value) || 1));
      const queued = document.createElement("span");
      queued.className = "clock-queued mono";
      queued.textContent = bar.pending
        ? `${bar.pending} queued · t=${Math.round(bar.now)}`
        : "";
      clockBar.append(step, play, speed, queued);
    },
  };
}

function humanGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** The bytes decoded as UTF-8, control / non-printable chars shown as `·`. */
function bytesAsText(bytes: number[]): string {
  const s = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, "\u00b7");
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
