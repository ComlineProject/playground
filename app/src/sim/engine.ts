/// Turn a `Connection` into a running wire: a `GenericDispatch` server bound to
/// the client instance's behaviours, a `GenericClient` on the other end, both
/// over a tapped `duplex()`. Behaviours can be swapped without reconnecting.

import { BEHAVIORS } from "./behavior.ts";
import { GenericClient, GenericDispatch, type Behavior, type BehaviorMap } from "./generic.ts";
import { instance, type Connection, type Session } from "./model.ts";
import {
  DatagramFraming,
  Handshake,
  JsonCodec,
  JsonRpcFraming,
  Server,
  Client,
  type Framing,
} from "./runtime/index.ts";
import { findProtocol } from "./shape.ts";
import { wire, type Tap } from "./transport.ts";

export interface LiveConnection {
  tap: Tap;
  /** Invoke a function from the client side. */
  call(fnName: string, params: unknown): Promise<unknown>;
  /** Swap a server behaviour; takes effect on the next call. */
  setBehavior(fnName: string, setting: { kind: keyof typeof BEHAVIORS; config: Record<string, unknown> }): void;
  /** Drop both ends and end the serve loop. */
  close(): void;
}

const framingFor = (name: "datagram" | "jsonrpc"): (() => Framing) =>
  name === "jsonrpc" ? () => new JsonRpcFraming() : () => new DatagramFraming();

/** Bind a `Connection` to real transports and run its handshake. */
export async function connect(session: Session, conn: Connection): Promise<LiveConnection> {
  const client = instance(session, conn.clientId);
  const server = instance(session, conn.serverId);
  if (!client || !server) throw new Error("connect: unknown instance");

  const found = findProtocol(session.shape, server.schemaNs, server.protocol);
  if (!found) throw new Error(`connect: ${server.schemaNs}::${server.protocol} is not compiled`);
  const { schema, protocol } = found;

  const codec = new JsonCodec();
  const makeFraming = framingFor(protocol.framing);
  const handshake = () =>
    new Handshake({ irHash: BigInt(schema.ir_hash), wireFormat: codec.name, framing: makeFraming().name });

  // A mutable map so `setBehavior` can swap an entry live.
  const behaviors: BehaviorMap = {};
  const build = (fnName: string): Behavior => {
    const fn = protocol.functions.find((f) => f.name === fnName)!;
    const setting = server.behaviors[fnName] ?? { kind: "reply" as const, config: {} };
    return BEHAVIORS[setting.kind].make(setting.config, fn, schema);
  };
  for (const fn of protocol.functions) behaviors[fn.name] = build(fn.name);

  const w = wire(client.name, server.name);
  const rpcServer = new Server(new GenericDispatch(protocol, behaviors), codec, makeFraming());
  void rpcServer.serveHandshaked(w.b, handshake());
  const rpcClient = new GenericClient(
    await Client.connect(w.a, codec, handshake(), makeFraming()),
    protocol,
  );

  return {
    tap: w.tap,
    call: (fnName, params) => rpcClient.call(fnName, params),
    setBehavior: (fnName, setting) => {
      const fn = protocol.functions.find((f) => f.name === fnName);
      if (!fn) throw new Error(`setBehavior: no function ${fnName}`);
      behaviors[fnName] = BEHAVIORS[setting.kind].make(setting.config, fn, schema);
    },
    close: () => w.close(),
  };
}
