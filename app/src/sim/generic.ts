/// Route B: one `Client` / `Dispatch` pair that reads a `ProtocolShape` and
/// does what a generated `<Proto>Client` / `<Proto>Dispatcher` does — so any
/// compiled schema can be wired up without code generation. The drift guard in
/// `wire.test.ts` proves the frames match the generator's.

import type { Client, Codec, Dispatch, Kind, Reply } from "./runtime/index.ts";
import { resolveKind, RuntimeError } from "./runtime/index.ts";
import type { FnShape, ProtocolShape } from "./shape.ts";

/// A schema error the peer raised. `errorName` is `undefined` when the ordinal
/// isn't in the calling function's `throws` (a `RuntimeError.remote` on the
/// generated side).
export class SimRemoteError extends Error {
  constructor(
    readonly ordinal: number,
    readonly errorName: string | undefined,
    readonly data: unknown,
  ) {
    super(errorName ? `${errorName} (ordinal ${ordinal})` : `remote error, ordinal ${ordinal}`);
    this.name = "SimRemoteError";
  }
}

export type SimOutcome =
  | { kind: "ok"; value?: unknown }
  | { kind: "err"; ordinal: number; data?: unknown }
  | { kind: "none" };

export interface BehaviorCtx {
  /** The decoded request params. */
  params: unknown;
  fn: FnShape;
  proto: ProtocolShape;
}

/** What a server instance does for one function when dispatched. */
export interface Behavior {
  run(ctx: BehaviorCtx): Promise<SimOutcome> | SimOutcome;
}

/** One behavior per function name. */
export type BehaviorMap = Record<string, Behavior>;

/// The consumer side. `call(fnName, params)` frames the call, waits for the
/// response, and either returns the decoded value or throws `SimRemoteError`.
export class GenericClient {
  constructor(
    private readonly client: Client,
    private readonly proto: ProtocolShape,
  ) {}

  async call(fnName: string, params: unknown): Promise<unknown> {
    const fn = this.proto.functions.find((f) => f.name === fnName);
    if (!fn) throw new Error(`${this.proto.name} has no function \`${fnName}\``);
    const address: Kind & { name: string } = { id: fn.index, name: fn.name };

    if (fn.oneway) {
      await this.client.notify(address, params);
      return undefined;
    }

    const env = await this.client.call(address, params);
    if ("ok" in env) return this.client.codec.decode(env.ok);
    const thrown = fn.throws.find((t) => t.ordinal === env.err.id);
    throw new SimRemoteError(
      env.err.id,
      thrown?.name,
      env.err.body.length ? this.client.codec.decode(env.err.body) : null,
    );
  }
}

/// The provider side. Resolves the call to a `FnShape`, decodes params, runs
/// the instance's `Behavior` for that function, and records the outcome on the
/// `Reply` — exactly the three shapes a generated dispatcher writes.
export class GenericDispatch implements Dispatch {
  constructor(
    private readonly proto: ProtocolShape,
    private readonly behaviors: BehaviorMap,
  ) {}

  calls(): readonly string[] {
    return this.proto.functions.map((f) => f.name);
  }

  async dispatch(call: Kind, params: Uint8Array, codec: Codec, reply: Reply): Promise<void> {
    const idx = resolveKind(call, this.calls());
    if (idx === undefined) throw RuntimeError.unknownCall();
    const fn = this.proto.functions[idx];
    const behavior = this.behaviors[fn.name];
    if (!behavior) throw new Error(`no behavior set for \`${fn.name}\``);

    const outcome = await behavior.run({
      params: params.length ? codec.decode(params) : null,
      fn,
      proto: this.proto,
    });

    switch (outcome.kind) {
      case "ok":
        reply.ok(codec.encode(outcome.value ?? null));
        return;
      case "err":
        reply.err(outcome.ordinal, codec.encode(outcome.data ?? null));
        return;
      case "none":
        return; // one-way — nothing to send
    }
  }
}
