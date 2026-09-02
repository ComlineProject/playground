// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Call, DecodedRequest, DecodedResponse, Framing } from "../contract.js";
import { FRAMING_DATAGRAM } from "../handshake.js";
import { decodeEnvelope, encodeEnvelopeErr, encodeEnvelopeOk } from "../envelope.js";

const HEAD = 10; // [call_id:u16][request_id:u64], both LE

/**
 * The Comline datagram framing — compact, one frame per message. Matches
 * `comline_runtime::contract::DatagramFraming`:
 * request `[call_id:u16 LE][request_id:u64 LE][params]`,
 * response `[request_id:u64 LE][envelope]`.
 */
export class DatagramFraming implements Framing {
  readonly name = FRAMING_DATAGRAM;

  encodeRequest(call: Call, requestId: bigint, params: Uint8Array): Uint8Array {
    const out = new Uint8Array(HEAD + params.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, call.id, true);
    view.setBigUint64(2, requestId, true);
    out.set(params, HEAD);
    return out;
  }

  decodeRequest(frame: Uint8Array): DecodedRequest | undefined {
    if (frame.length < HEAD) return undefined;
    const view = new DataView(frame.buffer, frame.byteOffset, HEAD);
    return {
      call: { id: view.getUint16(0, true) },
      requestId: view.getBigUint64(2, true),
      params: frame.subarray(HEAD),
    };
  }

  encodeResponseOk(requestId: bigint, payload: Uint8Array): Uint8Array {
    return withRequestId(requestId, encodeEnvelopeOk(payload));
  }

  encodeResponseErr(requestId: bigint, id: number, body: Uint8Array): Uint8Array {
    return withRequestId(requestId, encodeEnvelopeErr(id, body));
  }

  decodeResponse(frame: Uint8Array): DecodedResponse | undefined {
    if (frame.length < 8) return undefined;
    const requestId = new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0, true);
    const envelope = decodeEnvelope(frame.subarray(8));
    return envelope && { requestId, envelope };
  }
}

function withRequestId(requestId: bigint, rest: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + rest.length);
  new DataView(out.buffer).setBigUint64(0, requestId, true);
  out.set(rest, 8);
  return out;
}
