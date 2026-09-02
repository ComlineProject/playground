// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `@comline/runtime` — the TypeScript runtime that Comline-generated RPC
 * bindings link against. The framing-agnostic contract, two framings, an
 * in-memory transport, and a `Client` / `Server`. The generator emitting a
 * `<Proto>Client` / dispatcher against this package, and a stream transport,
 * follow.
 */

export {
  RuntimeError,
  type RuntimeErrorKind,
  type Kind,
  resolveKind,
  type Call,
  call,
  type Envelope,
  type Outcome,
  Reply,
  type CallError,
  type Codec,
  type Dispatch,
  type RequestCall,
  type DecodedRequest,
  type DecodedResponse,
  type Framing,
} from "./contract.js";

export {
  FRAMING_DATAGRAM,
  nameHash,
  Handshake,
  type HandshakeInit,
} from "./handshake.js";

export { JsonCodec } from "./codec.js";

export { encodeEnvelopeOk, encodeEnvelopeErr, decodeEnvelope } from "./envelope.js";

export { DatagramFraming } from "./framing/datagram.js";
export { JsonRpcFraming } from "./framing/jsonrpc.js";

export { type Transport, type InMemoryTransport, duplex } from "./transport.js";

export { Client } from "./client.js";
export { Server } from "./server.js";
