/// Turn each `Connection` into a running wire: a `GenericDispatch` server bound
/// to the server instance's behaviours, a `GenericClient` on the other end, over
/// a tapped `duplex()`. Each end handshakes with its own instance's `irHash`, so
/// a version-skewed pair is refused for real. `Wires` keeps one live wire per
/// connection and diffs against the session so adding or removing a connection
/// leaves the others untouched.

import { BEHAVIORS } from "./behavior.ts";
import { GenericClient, GenericDispatch, type Behavior, type BehaviorMap } from "./generic.ts";
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
 *  — a refused handshake comes back as `LiveConnection.error`. */
export async function connect(session: Session, conn: Connection): Promise<LiveConnection> {
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

  const w = wire(client.name, server.name, session.latencyMs);
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

  const rpcServer = new Server(new GenericDispatch(protocol, behaviors), codec, makeFraming());
  // The serve loop rejects on a handshake mismatch too — swallow it; the client
  // side reports the refusal.
  void rpcServer.serveHandshaked(w.b, handshake(server.irHash)).catch(() => {});

  let rpcClient: GenericClient;
  try {
    rpcClient = new GenericClient(
      await Client.connect(w.a, codec, handshake(client.irHash), makeFraming()),
      protocol,
    );
  } catch (e) {
    w.close();
    const kind = e instanceof RuntimeError ? e.kind : "handshake";
    return {
      ...base,
      error: kind,
      call: () => Promise.reject(new Error(`connection refused · ${kind}`)),
      setBehavior: () => {},
    };
  }

  return {
    ...base,
    error: null,
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
      this.live.set(conn.id, await connect(session, conn));
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
