/// The wire between two instances: a `duplex()` pair from the vendored runtime,
/// each end wrapped so every frame it carries is recorded and (optionally)
/// delayed. The recording is what the frame inspector reads.

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

  record(from: string, to: string, bytes: Uint8Array): Frame {
    const frame: Frame = {
      seq: ++this.counter,
      from,
      to,
      bytes: bytes.slice(),
      at: performance.now(),
      kind: classify(bytes),
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

/** One `duplex()` end plus the tap. `send` records then (optionally) waits
 *  `latencyMs` before delivering; `recv` passes straight through. */
export class TappedTransport implements Transport {
  constructor(
    private readonly inner: Transport & { close?(): void },
    private readonly tap: Tap,
    private readonly self: string,
    private readonly peer: string,
    private readonly latencyMs = 0,
  ) {}

  async send(frame: Uint8Array): Promise<void> {
    this.tap.record(this.self, this.peer, frame);
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return this.inner.send(frame);
  }

  recv(): Promise<Uint8Array> {
    return this.inner.recv();
  }

  /** Drop this end — the peer's pending / next `recv` rejects, ending a serve loop. */
  close(): void {
    this.inner.close?.();
  }
}

export interface Wire {
  tap: Tap;
  /** The transport for the endpoint named `a` (talks to `b`). */
  a: TappedTransport;
  /** The transport for the endpoint named `b` (talks to `a`). */
  b: TappedTransport;
  /** Drop both ends. */
  close(): void;
}

/** A tapped connection between two named endpoints. */
export function wire(a: string, b: string, latencyMs = 0): Wire {
  const tap = new Tap();
  const [ta, tb] = duplex();
  const at = new TappedTransport(ta, tap, a, b, latencyMs);
  const bt = new TappedTransport(tb, tap, b, a, latencyMs);
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
