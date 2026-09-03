/// Record & replay. A recording is the session at record-start plus the ordered
/// list of user inputs — a call, a behaviour edit, a fault edit — each stamped
/// with the clock time it happened at (relative to record-start). Replaying it
/// on a fresh stepped clock with the recorded seed reproduces the run frame for
/// frame; that equality is the regression guard for the engine.

import { SteppedClock } from "./clock.ts";
import { Wires } from "./engine.ts";
import type { FaultSpec } from "./faults.ts";
import { instance, setBehavior, type BehaviorSetting, type Session } from "./model.ts";
import { decodeSession, encodeSession } from "./session-codec.ts";
import type { ProjectShape } from "./shape.ts";

export type Input =
  | { kind: "call"; connId: string; fn: string; params: unknown }
  | { kind: "behavior"; instanceId: string; fn: string; setting: BehaviorSetting }
  | { kind: "fault"; connId: string; faults: FaultSpec };

export type InputEvent = Input & { at: number };

export interface Recording {
  v: 1;
  /** `encodeSession` of the session when recording started. */
  session: string;
  events: InputEvent[];
}

export class Recorder {
  private events: InputEvent[] = [];
  private snapshot = "";
  private t0 = 0;
  recording = false;

  start(session: Session, now: number): void {
    this.snapshot = encodeSession(session);
    this.events = [];
    this.t0 = now;
    this.recording = true;
  }

  /** Record an input at clock time `now` (ignored unless recording). */
  capture(e: Input, now: number): void {
    if (!this.recording) return;
    this.events.push({ ...e, at: Math.max(0, now - this.t0) } as InputEvent);
  }

  stop(): Recording {
    this.recording = false;
    return { v: 1, session: this.snapshot, events: this.events.slice() };
  }

  get count(): number {
    return this.events.length;
  }
}

export interface Replay {
  session: Session;
  wires: Wires;
  clock: SteppedClock;
}

/** Drive a recording on a fresh stepped clock. The caller reads the frame log
 *  off `wires.get(connId).tap`. Pass `deps` to drive an existing view's engine. */
export async function replayRecording(
  rec: Recording,
  shape: ProjectShape,
  deps: { wires?: Wires; clock?: SteppedClock } = {},
): Promise<Replay> {
  const session = decodeSession(rec.session, shape);
  if (!session) throw new Error("replay: the recording's session did not decode");
  session.clockMode = "stepped";

  const clock = deps.clock ?? new SteppedClock();
  const wires = deps.wires ?? new Wires();
  wires.clock = clock;
  await wires.rebuild(session);

  const pending: Promise<unknown>[] = [];
  for (const ev of rec.events) {
    clock.advance(Math.max(0, ev.at - clock.now()));
    await tick();
    apply(ev, session, wires, pending);
    await tick();
  }
  // let anything still in flight land
  clock.advance(5000);
  await Promise.allSettled(pending);
  await tick();

  return { session, wires, clock };
}

function apply(ev: InputEvent, session: Session, wires: Wires, pending: Promise<unknown>[]): void {
  switch (ev.kind) {
    case "call": {
      const lc = wires.get(ev.connId);
      if (lc && !lc.error) pending.push(lc.call(ev.fn, ev.params).catch(() => undefined));
      return;
    }
    case "behavior": {
      const inst = instance(session, ev.instanceId);
      if (!inst) return;
      setBehavior(session, ev.instanceId, ev.fn, ev.setting.kind, ev.setting.config);
      for (const lc of wires.forInstance(ev.instanceId)) {
        if (!lc.error) lc.setBehavior(ev.fn, ev.setting);
      }
      return;
    }
    case "fault": {
      const conn = session.connections.find((c) => c.id === ev.connId);
      if (conn) Object.assign(conn.faults, ev.faults);
      return;
    }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
