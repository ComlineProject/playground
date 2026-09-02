/// The simulation's state: the compiled `ProjectShape`, the nodes on the canvas
/// (each hosting one or more instances), and the connections between instances.
/// Plain data + pure-ish operations; the engine turns each `Connection` into a
/// live wire and the UI renders all of it. Phase 2: many connections (2a), a
/// node hosting several instances (2b) — e.g. a gateway that is a client of one
/// protocol and a server of another.

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
  /** The schema's `ir_hash` when this instance was placed or last resynced.
   *  A `rebuild` does NOT touch it — so editing a schema and returning leaves
   *  a surviving instance built against the old IR, which the handshake then
   *  rejects (the version-skew demo). `resyncInstance` snaps it forward. */
  irHash: string;
  /** The canvas node hosting this instance. */
  nodeId: string;
}

export interface Node {
  id: string;
  label: string;
  /** Canvas position (the UI owns it; the engine ignores it). */
  x: number;
  y: number;
  /** The instances in this box, in display order. Always ≥ 1. */
  instanceIds: string[];
}

export interface Connection {
  id: string;
  clientId: string;
  serverId: string;
}

export interface Session {
  shape: ProjectShape;
  nodes: Node[];
  instances: Instance[];
  connections: Connection[];
  /** Fixed per-frame delivery delay for every wire, ms. */
  latencyMs: number;
}

let counter = 0;
const nextId = () => `i${++counter}`;
let connCounter = 0;
const nextConnId = () => `c${++connCounter}`;
let nodeCounter = 0;
const nextNodeId = () => `n${++nodeCounter}`;

export function emptySession(shape: ProjectShape): Session {
  return { shape, nodes: [], instances: [], connections: [], latencyMs: 0 };
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
  spec: { schemaNs: string; protocol: string; role: Role },
  /** Drop onto an existing node to add the instance there; otherwise a new
   *  node is created at `x` / `y`. */
  place: { nodeId?: string; x?: number; y?: number } = {},
): Instance {
  const n = session.instances.filter((i) => i.protocol === spec.protocol).length + 1;
  const inst: Instance = {
    id: nextId(),
    name: `${spec.protocol.toLowerCase()}-${n}`,
    role: spec.role,
    schemaNs: spec.schemaNs,
    protocol: spec.protocol,
    behaviors: spec.role === "server" ? seedBehaviors(session, spec.schemaNs, spec.protocol) : {},
    irHash: findProtocol(session.shape, spec.schemaNs, spec.protocol)?.schema.ir_hash ?? "0x0",
    nodeId: "",
  };
  session.instances.push(inst);

  const host = place.nodeId ? session.nodes.find((nd) => nd.id === place.nodeId) : undefined;
  if (host) {
    host.instanceIds.push(inst.id);
    inst.nodeId = host.id;
  } else {
    const id = nextNodeId();
    const node: Node = {
      id,
      label: `Machine ${nodeCounter}`, // a box is a machine; rename it in the canvas
      x: place.x ?? 0,
      y: place.y ?? 0,
      instanceIds: [inst.id],
    };
    session.nodes.push(node);
    inst.nodeId = node.id;
  }
  return inst;
}

/** Rename a machine box. An empty / blank label is ignored. */
export function renameNode(session: Session, nodeId: string, label: string): void {
  const nd = session.nodes.find((n) => n.id === nodeId);
  if (nd && label.trim()) nd.label = label.trim();
}

export function removeInstance(session: Session, id: string): void {
  const inst = instance(session, id);
  session.instances = session.instances.filter((i) => i.id !== id);
  session.connections = session.connections.filter(
    (c) => c.clientId !== id && c.serverId !== id,
  );
  if (inst) {
    const node = session.nodes.find((nd) => nd.id === inst.nodeId);
    if (node) {
      node.instanceIds = node.instanceIds.filter((x) => x !== id);
      if (node.instanceIds.length === 0) {
        session.nodes = session.nodes.filter((nd) => nd.id !== node.id);
      }
    }
  }
}

export function instance(session: Session, id: string): Instance | undefined {
  return session.instances.find((i) => i.id === id);
}

export function node(session: Session, id: string): Node | undefined {
  return session.nodes.find((nd) => nd.id === id);
}

/** Move a node (and every instance it hosts) on the canvas. */
export function moveNode(session: Session, nodeId: string, x: number, y: number): void {
  const nd = session.nodes.find((n) => n.id === nodeId);
  if (nd) {
    nd.x = Math.max(0, Math.round(x));
    nd.y = Math.max(0, Math.round(y));
  }
}

/** Every connection an instance is an end of. */
export function connectionsFor(session: Session, instanceId: string): Connection[] {
  return session.connections.filter(
    (c) => c.clientId === instanceId || c.serverId === instanceId,
  );
}

/** Add a connection from a client instance to a server instance of the same
 *  protocol. Throws on a role / protocol mismatch or a duplicate pair. */
export function addConnection(session: Session, clientId: string, serverId: string): Connection {
  const c = instance(session, clientId);
  const s = instance(session, serverId);
  if (!c || !s) throw new Error("connect: unknown instance");
  if (c.role !== "client" || s.role !== "server") throw new Error("connect: need a client and a server");
  if (c.schemaNs !== s.schemaNs || c.protocol !== s.protocol) {
    throw new Error(`connect: ${c.protocol} ≠ ${s.protocol}`);
  }
  if (session.connections.some((x) => x.clientId === clientId && x.serverId === serverId)) {
    throw new Error(`connect: ${c.name} ↔ ${s.name} already connected`);
  }
  const conn = { id: nextConnId(), clientId, serverId };
  session.connections.push(conn);
  return conn;
}

export function removeConnection(session: Session, connId: string): void {
  session.connections = session.connections.filter((c) => c.id !== connId);
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
 *  of functions that remain and gains defaults for new ones. Its `irHash`
 *  snapshot is deliberately left as-is — see `Instance.irHash`. */
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
  const liveIds = new Set(kept.map((i) => i.id));
  for (const nd of session.nodes) nd.instanceIds = nd.instanceIds.filter((id) => liveIds.has(id));
  session.nodes = session.nodes.filter((nd) => nd.instanceIds.length > 0);
  session.connections = session.connections.filter(
    (c) => instance(session, c.clientId) && instance(session, c.serverId),
  );
}

/** Snap an instance's `irHash` forward to the currently-compiled schema, so a
 *  connection built after a schema edit handshakes cleanly again. */
export function resyncInstance(session: Session, id: string): void {
  const inst = instance(session, id);
  const found = inst && findProtocol(session.shape, inst.schemaNs, inst.protocol);
  if (inst && found) inst.irHash = found.schema.ir_hash;
}
