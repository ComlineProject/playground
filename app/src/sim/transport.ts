/// The wire between two instances: a `duplex()` pair from the vendored runtime,
/// each end wrapped so every frame it carries is recorded and put through the
/// connection's `FaultSpec` (drop / delay / reorder / corrupt / partition). The
/// recording is what the frame inspector reads.

import {
  corruptBytes,
  faultAppliesTo,
  noFaults,
  type FaultSpec,
} from "./faults.ts";
import { duplex, type Transport } from "./runtime/transport.ts";

export type FrameKind = "handshake" | "request" | "response";

export interface Frame {
  /** Monotonic, assigned when the frame is sent. */
  seq: number;
  from: string;
  to: string;
  /** A copy — the caller may reuse its buffer. */
  bytes: Uint8Array;
  /** `performance.now()` at send. */
  at: number;
  /** Best-effort classification from the byte shape (see `classify`). */
  kind: FrameKind;
  /** What the wire's `FaultSpec` did to this frame, if anything. */
  fault?: string;
}

const HANDSHAKE_LEN = 31; // [MAGIC:2][VERSION:1][ir_hash:8][wire:8][framing:8][caps:4]

/// Best-effort label for the log. The handshake frame is unambiguous (fixed
/// length + `CO` magic); a JSON-RPC frame's `method` key marks it a request.
/// A binary datagram request and response can't be told apart from the bytes
/// alone, so those default to `request` — the engine overrides `kind` when it
/// knows the direction (1e).
function classify(bytes: Uint8Array): FrameKind {
  if (bytes.length === HANDSHAKE_LEN && bytes[0] === 0x43 && bytes[1] === 0x4f) {
    return "handshake";
  }
  if (bytes[0] === 0x7b) {
    return new TextDecoder().decode(bytes).includes('"method"') ? "request" : "response";
  }
  return "request";
}

/** A shared sink for the frames on one connection. */
export class Tap {
  private counter = 0;
  readonly frames: Frame[] = [];
  private readonly listeners = new Set<(f: Frame) => void>();

  /** Subscribe; returns an unsubscribe. */
  on(fn: (f: Frame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  record(from: string, to: string, bytes: Uint8Array, fault?: string): Frame {
    const frame: Frame = {
      seq: ++this.counter,
      from,
      to,
      bytes: bytes.slice(),
      at: performance.now(),
      kind: classify(bytes),
      fault,
    };
    this.frames.push(frame);
    for (const fn of this.listeners) fn(frame);
    return frame;
  }

  clear(): void {
    this.frames.length = 0;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One `duplex()` end plus the tap and the shared fault spec. `send` records
 *  the frame, then does whatever the faults say; `recv` passes straight through. */
export class TappedTransport implements Transport {
  private reorderBuf: Uint8Array[] = [];
  private reorderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly inner: Transport & { close?(): void },
    private readonly tap: Tap,
    private readonly self: string,
    private readonly peer: string,
    /** Which direction this end emits — used to match `FaultSpec.applyTo`. */
    private readonly dir: "request" | "response",
    /** Live reference — the inspector mutates it in place. */
    private readonly faults: FaultSpec = noFaults(),
    /** Session-wide fixed delivery delay, applied to every frame. */
    private readonly latencyMs = 0,
  ) {}

  async send(frame: Uint8Array): Promise<void> {
    const f = this.faults;
    const isHandshake = classify(frame) === "handshake";

    // Partition cuts everything, handshakes included.
    if (f.partition) {
      this.tap.record(this.self, this.peer, frame, "dropped · partition");
      return;
    }
    // Handshake frames and out-of-scope directions only see the latency knob.
    if (isHandshake || !faultAppliesTo(f, this.dir)) {
      this.tap.record(this.self, this.peer, frame);
      if (this.latencyMs > 0) await sleep(this.latencyMs);
      return this.inner.send(frame);
    }

    if (Math.random() < f.dropProb) {
      this.tap.record(this.self, this.peer, frame, "dropped");
      return;
    }

    let out = frame;
    const notes: string[] = [];
    if (f.corruptProb > 0 && Math.random() < f.corruptProb) {
      out = corruptBytes(frame);
      notes.push("corrupted");
    }
    const jitter =
      f.delayMax > 0 ? f.delayMin + Math.random() * Math.max(0, f.delayMax - f.delayMin) : 0;
    const delay = this.latencyMs + jitter;
    if (jitter > 0) notes.push(`+${Math.round(jitter)} ms`);

    this.tap.record(this.self, this.peer, out, notes.join(" · ") || undefined);

    if (f.reorderWindow > 0) {
      this.enqueueReorder(out);
      return;
    }
    if (delay > 0) await sleep(delay);
    return this.inner.send(out);
  }

  /** Buffer up to `reorderWindow` frames, then flush them shuffled. */
  private enqueueReorder(bytes: Uint8Array): void {
    this.reorderBuf.push(bytes);
    if (this.reorderBuf.length >= this.faults.reorderWindow) {
      this.flushReorder();
      return;
    }
    this.reorderTimer ??= setTimeout(() => this.flushReorder(), 40);
  }

  private flushReorder(): void {
    if (this.reorderTimer) {
      clearTimeout(this.reorderTimer);
      this.reorderTimer = null;
    }
    const batch = this.reorderBuf.splice(0);
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    for (const b of batch) void this.inner.send(b);
  }

  recv(): Promise<Uint8Array> {
    return this.inner.recv();
  }

  /** Drop this end — the peer's pending / next `recv` rejects, ending a serve loop. */
  close(): void {
    if (this.reorderTimer) clearTimeout(this.reorderTimer);
    this.inner.close?.();
  }
}

export interface Wire {
  tap: Tap;
  /** The transport for the endpoint named `a` — the client end (sends requests). */
  a: TappedTransport;
  /** The transport for the endpoint named `b` — the server end (sends responses). */
  b: TappedTransport;
  /** Drop both ends. */
  close(): void;
}

/** A tapped connection between two named endpoints. `a` is the client end. */
export function wire(a: string, b: string, faults?: FaultSpec, latencyMs = 0): Wire {
  const tap = new Tap();
  const spec = faults ?? noFaults();
  const [ta, tb] = duplex();
  const at = new TappedTransport(ta, tap, a, b, "request", spec, latencyMs);
  const bt = new TappedTransport(tb, tap, b, a, "response", spec, latencyMs);
  return {
    tap,
    a: at,
    b: bt,
    close() {
      at.close();
      bt.close();
    },
  };
}
