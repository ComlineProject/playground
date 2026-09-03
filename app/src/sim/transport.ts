/// The wire between two instances: a `duplex()` pair from the vendored runtime,
/// each end wrapped so every frame it carries is recorded and put through the
/// connection's `FaultSpec` (drop / delay / reorder / corrupt / partition). Every
/// delay is scheduled on the engine's `Clock`, so a stepped clock can pause the
/// wire; the fault rolls use the session's seeded `Rng`, so a stepped run is
/// reproducible. The recording is what the frame inspector reads.

import { RealClock, type Clock } from "./clock.ts";
import { corruptBytes, faultAppliesTo, noFaults, type FaultSpec } from "./faults.ts";
import { mulberry32, type Rng } from "./rng.ts";
import { duplex, type Transport } from "./runtime/transport.ts";

export type FrameKind = "handshake" | "request" | "response";

export interface Frame {
  /** Monotonic, assigned when the frame is sent. */
  seq: number;
  from: string;
  to: string;
  /** A copy — the caller may reuse its buffer. */
  bytes: Uint8Array;
  /** `Clock.now()` at send. */
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

  constructor(private readonly now: () => number = () => performance.now()) {}

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
      at: this.now(),
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

/** One `duplex()` end plus the tap, the shared fault spec, the clock and the
 *  RNG. `send` records the frame, then does whatever the faults say; `recv`
 *  passes straight through. */
export class TappedTransport implements Transport {
  private reorderBuf: Uint8Array[] = [];
  private cancelReorder: (() => void) | null = null;

  constructor(
    private readonly inner: Transport & { close?(): void },
    private readonly tap: Tap,
    private readonly self: string,
    private readonly peer: string,
    /** Which direction this end emits — used to match `FaultSpec.applyTo`. */
    private readonly dir: "request" | "response",
    private readonly faults: FaultSpec,
    private readonly latencyMs: number,
    private readonly clock: Clock,
    private readonly rng: Rng,
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
      if (this.latencyMs > 0) await this.clock.sleep(this.latencyMs);
      return this.inner.send(frame);
    }

    if (this.rng() < f.dropProb) {
      this.tap.record(this.self, this.peer, frame, "dropped");
      return;
    }

    let out = frame;
    const notes: string[] = [];
    if (f.corruptProb > 0 && this.rng() < f.corruptProb) {
      out = corruptBytes(frame, this.rng);
      notes.push("corrupted");
    }
    const range = Math.max(0, f.delayMax - f.delayMin);
    const jitter = f.delayMax > 0 ? f.delayMin + this.rng() * range : 0;
    const delay = this.latencyMs + jitter;
    if (jitter > 0) notes.push(`+${Math.round(jitter)} ms`);

    this.tap.record(this.self, this.peer, out, notes.join(" · ") || undefined);

    if (f.reorderWindow > 0) {
      this.enqueueReorder(out);
      return;
    }
    if (delay > 0) await this.clock.sleep(delay);
    return this.inner.send(out);
  }

  /** Buffer up to `reorderWindow` frames, then flush them shuffled. */
  private enqueueReorder(bytes: Uint8Array): void {
    this.reorderBuf.push(bytes);
    if (this.reorderBuf.length >= this.faults.reorderWindow) {
      this.flushReorder();
      return;
    }
    this.cancelReorder ??= this.clock.after(40, () => this.flushReorder());
  }

  private flushReorder(): void {
    this.cancelReorder?.();
    this.cancelReorder = null;
    const batch = this.reorderBuf.splice(0);
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    for (const b of batch) void this.inner.send(b);
  }

  recv(): Promise<Uint8Array> {
    return this.inner.recv();
  }

  /** Drop this end — the peer's pending / next `recv` rejects, ending a serve loop. */
  close(): void {
    this.cancelReorder?.();
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

export interface WireOpts {
  faults?: FaultSpec;
  latencyMs?: number;
  clock?: Clock;
  rng?: Rng;
}

/** A tapped connection between two named endpoints. `a` is the client end. */
export function wire(a: string, b: string, opts: WireOpts = {}): Wire {
  const clock = opts.clock ?? new RealClock();
  const rng = opts.rng ?? Math.random;
  const spec = opts.faults ?? noFaults();
  const latencyMs = opts.latencyMs ?? 0;
  const tap = new Tap(() => clock.now());
  const [ta, tb] = duplex();
  const at = new TappedTransport(ta, tap, a, b, "request", spec, latencyMs, clock, rng);
  const bt = new TappedTransport(tb, tap, b, a, "response", spec, latencyMs, clock, rng);
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

export { mulberry32 };
