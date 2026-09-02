// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { RuntimeError } from "./contract.js";

/**
 * A message-oriented byte pipe: each {@link Transport.send} delivers exactly
 * one frame to the peer's next {@link Transport.recv}. The counterpart of the
 * Rust `Transport` trait; a stream transport (length-prefixed) is a later add.
 */
export interface Transport {
  send(frame: Uint8Array): Promise<void>;
  /** Resolves with the next frame; rejects `RuntimeError("transport")` once the peer is gone and the queue is drained. */
  recv(): Promise<Uint8Array>;
}

interface Waiter {
  resolve(v: Uint8Array): void;
  reject(e: unknown): void;
}

/** One direction of an in-memory pipe: a queue plus parked receivers. */
class Channel {
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  push(frame: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(frame);
    else this.queue.push(frame);
  }

  pull(): Promise<Uint8Array> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed) return Promise.reject(RuntimeError.transport());
    return new Promise<Uint8Array>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(RuntimeError.transport());
  }
}

class InMemoryTransport implements Transport {
  constructor(
    private readonly inbox: Channel,
    private readonly outbox: Channel,
  ) {}

  send(frame: Uint8Array): Promise<void> {
    this.outbox.push(frame.slice()); // copy: the caller may reuse its buffer
    return Promise.resolve();
  }

  recv(): Promise<Uint8Array> {
    return this.inbox.pull();
  }

  /** Drop this end — the peer's pending / next `recv` rejects, ending a serve loop. */
  close(): void {
    this.outbox.close();
  }
}

/**
 * A connected in-memory transport pair — the TypeScript `duplex()`. What one
 * end sends, the other receives. `close()` on either end makes the peer's
 * pending / next `recv` reject.
 */
export function duplex(): [InMemoryTransport, InMemoryTransport] {
  const a = new Channel();
  const b = new Channel();
  return [new InMemoryTransport(a, b), new InMemoryTransport(b, a)];
}

export type { InMemoryTransport };
