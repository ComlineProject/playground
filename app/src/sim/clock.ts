/// Time for the simulation. Every delayed thing — a fault's delivery delay, a
/// `Delay then reply` behaviour, a client's call timeout — schedules on the one
/// `Clock` the engine holds, so `stepped` mode can pause the whole sim and
/// advance it frame by frame. `real` mode is `setTimeout` / `performance.now`
/// and behaves exactly as before.

export type ClockMode = "real" | "stepped";

export interface Clock {
  readonly mode: ClockMode;
  now(): number;
  /** Resolve after `ms` of clock time. */
  sleep(ms: number): Promise<void>;
  /** Run `fn` after `ms` of clock time; returns a cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Stepped only: queued timers not yet due. */
  pending(): number;
}

export class RealClock implements Clock {
  readonly mode = "real" as const;
  now(): number {
    return performance.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
  after(ms: number, fn: () => void): () => void {
    const t = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(t);
  }
  pending(): number {
    return 0;
  }
}

interface Timer {
  id: number;
  dueAt: number;
  fn: () => void;
}

/// A virtual clock: timers land in a queue ordered by due time, and nothing
/// fires until `step` / `advance` / `play` moves time forward. Deterministic —
/// given the same inputs (and a seeded RNG), the queue drains in the same order
/// every run.
export class SteppedClock implements Clock {
  readonly mode = "stepped" as const;
  private t = 0;
  private seq = 0;
  private queue: Timer[] = [];
  private playHandle: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  after(ms: number, fn: () => void): () => void {
    const timer: Timer = { id: ++this.seq, dueAt: this.t + Math.max(0, ms), fn };
    // insert keeping the queue sorted by (dueAt, id)
    let i = this.queue.length;
    while (i > 0 && this.later(this.queue[i - 1], timer)) i--;
    this.queue.splice(i, 0, timer);
    this.emit();
    return () => {
      const at = this.queue.findIndex((x) => x.id === timer.id);
      if (at !== -1) {
        this.queue.splice(at, 1);
        this.emit();
      }
    };
  }

  pending(): number {
    return this.queue.length;
  }

  /** Fire the single earliest timer, moving time to its due instant. */
  step(): void {
    const next = this.queue.shift();
    if (!next) return;
    this.t = Math.max(this.t, next.dueAt);
    this.emit();
    next.fn();
  }

  /** Move time forward by `ms`, firing every timer that comes due. */
  advance(ms: number): void {
    const until = this.t + Math.max(0, ms);
    while (this.queue.length && this.queue[0].dueAt <= until) {
      const next = this.queue.shift()!;
      this.t = next.dueAt;
      next.fn();
    }
    this.t = until;
    this.emit();
  }

  /** Drain in real time at `speed`× until paused or the queue empties. */
  play(speed = 1): void {
    this.pause();
    const tickMs = 32;
    this.playHandle = setInterval(() => {
      this.advance(tickMs * speed);
      if (this.queue.length === 0) this.pause();
    }, tickMs);
  }

  pause(): void {
    if (this.playHandle !== null) {
      clearInterval(this.playHandle);
      this.playHandle = null;
    }
  }

  get playing(): boolean {
    return this.playHandle !== null;
  }

  /** Subscribe to queue / time changes (for the header controls). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private later(a: Timer, b: Timer): boolean {
    return a.dueAt > b.dueAt || (a.dueAt === b.dueAt && a.id > b.id);
  }
}
