/// The simulation's state: the compiled `ProjectShape`, the instances placed on
/// the canvas, and (Phase 1) the single connection between them. Plain data +
/// pure-ish operations; the engine turns a `Connection` into a live wire and
/// the UI renders all of it.

import { BEHAVIORS, defaultKindFor, type BehaviorKind } from "./behavior.ts";
import { findProtocol, type ProjectShape } from "./shape.ts";

export type Role = "server" | "client";

export interface BehaviorSetting {
  kind: BehaviorKind;
  config: Record<string, unknown>;
}

export interface Instance {
  id: string;
  name: string;
  role: Role;
  /** The schema namespace + protocol this instance speaks. */
  schemaNs: string;
  protocol: string;
  /** Server only: one behaviour per function name. Empty for a client. */
  behaviors: Record<string, BehaviorSetting>;
  /** Canvas position (the UI owns it; the engine ignores it). */
  x: number;
  y: number;
}

export interface Connection {
  clientId: string;
  serverId: string;
}

export interface Session {
  shape: ProjectShape;
  instances: Instance[];
  connection: Connection | null;
}

let counter = 0;
const nextId = () => `i${++counter}`;

export function emptySession(shape: ProjectShape): Session {
  return { shape, instances: [], connection: null };
}

/** Seed a server's per-function behaviour map from the protocol shape. */
function seedBehaviors(
  session: Session,
  schemaNs: string,
  protocol: string,
): Record<string, BehaviorSetting> {
  const found = findProtocol(session.shape, schemaNs, protocol);
  const out: Record<string, BehaviorSetting> = {};
  for (const fn of found?.protocol.functions ?? []) {
    const kind = defaultKindFor(fn);
    out[fn.name] = { kind, config: BEHAVIORS[kind].defaultConfig(fn, found!.schema) };
  }
  return out;
}

export function addInstance(
  session: Session,
  spec: { schemaNs: string; protocol: string; role: Role; x?: number; y?: number },
): Instance {
  const n = session.instances.filter((i) => i.protocol === spec.protocol).length + 1;
  const inst: Instance = {
    id: nextId(),
    name: `${spec.protocol.toLowerCase()}-${n}`,
    role: spec.role,
    schemaNs: spec.schemaNs,
    protocol: spec.protocol,
    behaviors: spec.role === "server" ? seedBehaviors(session, spec.schemaNs, spec.protocol) : {},
    x: spec.x ?? 0,
    y: spec.y ?? 0,
  };
  session.instances.push(inst);
  return inst;
}

export function removeInstance(session: Session, id: string): void {
  session.instances = session.instances.filter((i) => i.id !== id);
  if (session.connection && (session.connection.clientId === id || session.connection.serverId === id)) {
    session.connection = null;
  }
}

export function instance(session: Session, id: string): Instance | undefined {
  return session.instances.find((i) => i.id === id);
}

/** Connect a client instance to a server instance of the same protocol.
 *  Replaces any existing connection. Throws on a role / protocol mismatch. */
export function setConnection(session: Session, clientId: string, serverId: string): Connection {
  const c = instance(session, clientId);
  const s = instance(session, serverId);
  if (!c || !s) throw new Error("connect: unknown instance");
  if (c.role !== "client" || s.role !== "server") throw new Error("connect: need a client and a server");
  if (c.schemaNs !== s.schemaNs || c.protocol !== s.protocol) {
    throw new Error(`connect: ${c.protocol} ≠ ${s.protocol}`);
  }
  session.connection = { clientId, serverId };
  return session.connection;
}

export function setBehavior(
  session: Session,
  instanceId: string,
  fnName: string,
  kind: BehaviorKind,
  config?: Record<string, unknown>,
): void {
  const inst = instance(session, instanceId);
  if (!inst || inst.role !== "server") throw new Error("setBehavior: not a server instance");
  const found = findProtocol(session.shape, inst.schemaNs, inst.protocol);
  const fn = found?.protocol.functions.find((f) => f.name === fnName);
  if (!fn) throw new Error(`setBehavior: no function ${fnName}`);
  inst.behaviors[fnName] = {
    kind,
    config: config ?? BEHAVIORS[kind].defaultConfig(fn, found!.schema),
  };
}

/** Re-point the session at a freshly compiled shape. An instance survives if
 *  its `schemaNs::protocol` still exists; its behaviour map keeps the configs
 *  of functions that remain and gains defaults for new ones. */
export function rebuild(session: Session, shape: ProjectShape): void {
  session.shape = shape;
  const kept: Instance[] = [];
  for (const inst of session.instances) {
    const found = findProtocol(shape, inst.schemaNs, inst.protocol);
    if (!found) continue;
    if (inst.role === "server") {
      const next: Record<string, BehaviorSetting> = {};
      for (const fn of found.protocol.functions) {
        const prev = inst.behaviors[fn.name];
        next[fn.name] =
          prev && BEHAVIORS[prev.kind].appliesTo(fn)
            ? prev
            : { kind: defaultKindFor(fn), config: BEHAVIORS[defaultKindFor(fn)].defaultConfig(fn, found.schema) };
      }
      inst.behaviors = next;
    }
    kept.push(inst);
  }
  session.instances = kept;
  if (
    session.connection &&
    !(instance(session, session.connection.clientId) && instance(session, session.connection.serverId))
  ) {
    session.connection = null;
  }
}
