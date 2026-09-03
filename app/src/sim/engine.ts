/// Turn each `Connection` into a running wire: a `GenericDispatch` server bound
/// to the server instance's behaviours, a `GenericClient` on the other end, over
/// a tapped `duplex()`. Each end handshakes with its own instance's `irHash`, so
/// a version-skewed pair is refused for real. `Wires` keeps one live wire per
/// connection and diffs against the session so adding or removing a connection
/// leaves the others untouched.

import { BEHAVIORS } from "./behavior.ts";
import {
  GenericClient,
  GenericDispatch,
  SimRemoteError,
  type Behavior,
  type BehaviorMap,
  type ForwardFn,
  type SimOutcome,
} from "./generic.ts";
import { instance, type Connection, type Session } from "./model.ts";
import {
  Client,
  DatagramFraming,
  Handshake,
  JsonCodec,
  JsonRpcFraming,
  RuntimeError,
  Server,
  type Framing,
} from "./runtime/index.ts";
import { findProtocol } from "./shape.ts";
import { wire, type Tap } from "./transport.ts";

export interface LiveConnection {
  connId: string;
  tap: Tap;
  /** `null` when connected; otherwise why the connection was refused
   *  (`"handshake"` for a version / framing / wire-format mismatch). */
  error: string | null;
  clientId: string;
  serverId: string;
  clientName: string;
  serverName: string;
  framing: "datagram" | "jsonrpc";
  /** True once a call has timed out — the client is desynced and the
   *  connection must be reopened (`Wires.rebuild`). */
  dead(): boolean;
  /** Invoke a function from the client side. Rejects if `error` is set. */
  call(fnName: string, params: unknown): Promise<unknown>;
  /** Swap a server behaviour; takes effect on the next call. */
  setBehavior(
    fnName: string,
    setting: { kind: keyof typeof BEHAVIORS; config: Record<string, unknown> },
  ): void;
  /** Drop both ends and end the serve loop. */
  close(): void;
}

const framingFor = (name: "datagram" | "jsonrpc"): (() => Framing) =>
  name === "jsonrpc" ? () => new JsonRpcFraming() : () => new DatagramFraming();

/** Bind one `Connection` to real transports and run its handshake. Never throws
 *  — a refused handshake comes back as `LiveConnection.error`. `opts.forward`
 *  gives the server's `Forward` behaviours a way to relay to another wire. */
export async function connect(
  session: Session,
  conn: Connection,
  opts: { forward?: ForwardFn } = {},
): Promise<LiveConnection> {
  const client = instance(session, conn.clientId);
  const server = instance(session, conn.serverId);
  if (!client || !server) throw new Error("connect: unknown instance");

  const found = findProtocol(session.shape, server.schemaNs, server.protocol);
  if (!found) throw new Error(`connect: ${server.schemaNs}::${server.protocol} is not compiled`);
  const { schema, protocol } = found;

  const codec = new JsonCodec();
  const makeFraming = framingFor(protocol.framing);
  const handshake = (irHash: string) =>
    new Handshake({ irHash: BigInt(irHash), wireFormat: codec.name, framing: makeFraming().name });

  // A mutable map so `setBehavior` can swap an entry live.
  const behaviors: BehaviorMap = {};
  const buildBehavior = (fnName: string): Behavior => {
    const fn = protocol.functions.find((f) => f.name === fnName)!;
    const setting = server.behaviors[fnName] ?? { kind: "reply" as const, config: {} };
    return BEHAVIORS[setting.kind].make(setting.config, fn, schema);
  };
  for (const fn of protocol.functions) behaviors[fn.name] = buildBehavior(fn.name);

  const w = wire(client.name, server.name, conn.faults, session.latencyMs);
  const base = {
    connId: conn.id,
    tap: w.tap,
    clientId: client.id,
    serverId: server.id,
    clientName: client.name,
    serverName: server.name,
    framing: protocol.framing,
    close: () => w.close(),
  };

  const rpcServer = new Server(
    new GenericDispatch(protocol, behaviors, opts.forward),
    codec,
    makeFraming(),
  );
  // The serve loop rejects on a handshake mismatch too — swallow it; the client
  // side reports the refusal.
  void rpcServer.serveHandshaked(w.b, handshake(server.irHash)).catch(() => {});

  let rpcClient: GenericClient;
  try {
    rpcClient = new GenericClient(
      await Client.connect(w.a, codec, handshake(client.irHash), makeFraming()),
      protocol,
      session.callTimeoutMs,
    );
  } catch (e) {
    w.close();
    const kind = e instanceof RuntimeError ? e.kind : "handshake";
    return {
      ...base,
      error: kind,
      dead: () => false,
      call: () => Promise.reject(new Error(`connection refused · ${kind}`)),
      setBehavior: () => {},
    };
  }

  return {
    ...base,
    error: null,
    dead: () => rpcClient.dead,
    call: (fnName, params) => rpcClient.call(fnName, params),
    setBehavior: (fnName, setting) => {
      const fn = protocol.functions.find((f) => f.name === fnName);
      if (!fn) throw new Error(`setBehavior: no function ${fnName}`);
      behaviors[fnName] = BEHAVIORS[setting.kind].make(setting.config, fn, schema);
    },
  };
}

/// One live wire per `Connection` in the session. `sync` opens the ones that
/// appeared and closes the ones that vanished, leaving the rest running;
/// `rebuild` drops everything and re-opens (for a schema edit / latency change /
/// resync, where every handshake has to run again).
export class Wires {
  private live = new Map<string, LiveConnection>();
  /** Connections currently mid-forward — re-entering one is a cycle. */
  private forwarding = new Set<string>();

  /** Relay a call onto another live wire, for a `Forward` behaviour. */
  private forwardVia: ForwardFn = async (viaConnId, targetFn, params): Promise<SimOutcome> => {
    const lc = this.live.get(viaConnId);
    if (!lc) return { kind: "err", ordinal: 0, data: { error: `forward: no connection ${viaConnId}` } };
    if (lc.error) return { kind: "err", ordinal: 0, data: { error: `forward: ${viaConnId} refused (${lc.error})` } };
    if (this.forwarding.has(viaConnId)) {
      return { kind: "err", ordinal: 0, data: { error: "forwarding cycle" } };
    }
    this.forwarding.add(viaConnId);
    try {
      return { kind: "ok", value: await lc.call(targetFn, params) };
    } catch (e) {
      if (e instanceof SimRemoteError) return { kind: "err", ordinal: e.ordinal, data: e.data };
      return { kind: "err", ordinal: 0, data: { error: (e as Error).message } };
    } finally {
      this.forwarding.delete(viaConnId);
    }
  };

  /** Incremental: match the live set to `session.connections`. */
  async sync(session: Session): Promise<void> {
    const want = new Map(session.connections.map((c) => [c.id, c]));
    for (const [id, lc] of this.live) {
      if (!want.has(id)) {
        lc.close();
        this.live.delete(id);
      }
    }
    for (const conn of session.connections) {
      if (this.live.has(conn.id)) continue;
      this.live.set(conn.id, await connect(session, conn, { forward: this.forwardVia }));
    }
  }

  /** Close all and re-open from scratch. */
  async rebuild(session: Session): Promise<void> {
    this.closeAll();
    await this.sync(session);
  }

  get(connId: string): LiveConnection | undefined {
    return this.live.get(connId);
  }

  /** Live wires this instance is an end of. */
  forInstance(instanceId: string): LiveConnection[] {
    return [...this.live.values()].filter(
      (lc) => lc.clientId === instanceId || lc.serverId === instanceId,
    );
  }

  all(): LiveConnection[] {
    return [...this.live.values()];
  }

  closeAll(): void {
    for (const lc of this.live.values()) lc.close();
    this.live.clear();
  }
}
