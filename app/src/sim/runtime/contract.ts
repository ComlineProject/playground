// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The framing-agnostic RPC contract — the TypeScript mirror of
 * `comline-runtime`'s `contract` module. Generated bindings and (later) a
 * `Client` / `Server` are written against these types.
 */

/** Every way a call can fail below the application layer. */
export type RuntimeErrorKind =
  | "transport" // the transport failed to send or receive
  | "serialization" // a payload would not encode / decode against its type
  | "framing" // the call frame was malformed
  | "timeout" // no response within the call's window
  | "unknownCall" // the peer addressed a call this side does not have
  | "remote" // the peer raised a schema error this side's code does not know
  | "handshake"; // the connection handshake disagreed

export class RuntimeError extends Error {
  override readonly name = "RuntimeError";
  readonly kind: RuntimeErrorKind;
  /** Schema-global error ordinal, set only when `kind === "remote"`. */
  readonly remoteId?: number;

  constructor(kind: RuntimeErrorKind, remoteId?: number) {
    super(remoteId === undefined ? kind : `${kind} (#${remoteId})`);
    this.kind = kind;
    this.remoteId = remoteId;
  }

  static transport(): RuntimeError {
    return new RuntimeError("transport");
  }
  static serialization(): RuntimeError {
    return new RuntimeError("serialization");
  }
  static framing(): RuntimeError {
    return new RuntimeError("framing");
  }
  static timeout(): RuntimeError {
    return new RuntimeError("timeout");
  }
  static unknownCall(): RuntimeError {
    return new RuntimeError("unknownCall");
  }
  static remote(id: number): RuntimeError {
    return new RuntimeError("remote", id);
  }
  static handshake(): RuntimeError {
    return new RuntimeError("handshake");
  }

  is(kind: RuntimeErrorKind): boolean {
    return this.kind === kind;
  }
}

/**
 * How a call is addressed on the wire. A datagram framing carries the ordinal
 * (`id`); a name-oriented framing (JSON-RPC) carries the method `name`. A
 * generated stub supplies both and lets the framing pick.
 */
export type Kind = { id: number } | { name: string };

/** Resolve a {@link Kind} to a call ordinal against the protocol's call list. */
export function resolveKind(kind: Kind, calls: readonly string[]): number | undefined {
  if ("id" in kind) {
    return kind.id < calls.length ? kind.id : undefined;
  }
  const i = calls.indexOf(kind.name);
  return i === -1 ? undefined : i;
}

/** A `Call` a generated stub passes — both addresses, the framing picks one. */
export interface Call {
  readonly id: number;
  readonly name: string;
}

export function call(id: number, name: string): Call {
  return { id, name };
}

/**
 * A decoded response body: an `ok` payload for the stub to decode as its return
 * type, or an `err` payload keyed by the schema-global error ordinal for the
 * generated error table to map.
 */
export type Envelope =
  | { readonly ok: Uint8Array }
  | { readonly err: { readonly id: number; readonly body: Uint8Array } };

/** What a dispatched handler recorded — nothing (one-way), an ok, or an error. */
export type Outcome =
  | { readonly kind: "none" }
  | { readonly kind: "ok" }
  | { readonly kind: "err"; readonly id: number };

/**
 * The framing-agnostic sink a generated dispatcher writes its result into. The
 * `Server` (a later PR) turns the {@link Outcome} + body into whatever envelope
 * the active framing wants.
 */
export class Reply {
  outcome: Outcome = { kind: "none" };
  body: Uint8Array = new Uint8Array(0);

  ok(body: Uint8Array): void {
    this.body = body;
    this.outcome = { kind: "ok" };
  }

  err(id: number, body: Uint8Array): void {
    this.body = body;
    this.outcome = { kind: "err", id };
  }
}

/** A call outcome for a generated client method: an app error, or a runtime one. */
export type CallError<E> = { readonly app: E } | { readonly runtime: RuntimeError };

/**
 * A serialization format — the TypeScript `WireFormat`. `name` is folded into
 * the {@link Handshake} so the two ends can catch "one side JSON, one side
 * MessagePack" before exchanging real frames.
 */
export interface Codec {
  readonly name: string;
  encode(value: unknown): Uint8Array;
  decode<T>(bytes: Uint8Array): T;
}

/**
 * A generated dispatcher implements this: the ordered call list, and a
 * `dispatch` that decodes params, runs the handler, and records the result on
 * the {@link Reply}.
 */
export interface Dispatch {
  calls(): readonly string[];
  dispatch(call: Kind, params: Uint8Array, codec: Codec, reply: Reply): Promise<void>;
}

/** Whichever call address a framing put on the wire. */
export type RequestCall = { readonly id: number } | { readonly name: string };

/** A decoded request frame. */
export interface DecodedRequest {
  readonly call: RequestCall;
  readonly requestId: bigint;
  /** The params sub-frame, independently decodable with the peer's {@link Codec}. */
  readonly params: Uint8Array;
}

/** A decoded response frame: the correlation id and its {@link Envelope}. */
export interface DecodedResponse {
  readonly requestId: bigint;
  readonly envelope: Envelope;
}

/**
 * How a call becomes bytes and back — the axis orthogonal to {@link Codec}
 * (which serializes the *parts*). {@link DatagramFraming} is the default;
 * {@link JsonRpcFraming} is the name-oriented alternative. `params` / `payload`
 * / `body` arrive already {@link Codec}-encoded; the framing only positions
 * them. Both ends of a connection must agree — the {@link Handshake} carries
 * `name`, hashed.
 */
export interface Framing {
  readonly name: string;
  encodeRequest(call: Call, requestId: bigint, params: Uint8Array): Uint8Array;
  decodeRequest(frame: Uint8Array): DecodedRequest | undefined;
  encodeResponseOk(requestId: bigint, payload: Uint8Array): Uint8Array;
  encodeResponseErr(requestId: bigint, id: number, body: Uint8Array): Uint8Array;
  decodeResponse(frame: Uint8Array): DecodedResponse | undefined;
}
