// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The tag-byte {@link Envelope} form the Comline datagram framing wraps a
 * response body in — `[0] payload` for ok, `[1] id:u16 LE body` for err.
 * Matches `comline_runtime::contract::Envelope`.
 */

import type { Envelope } from "./contract.js";

const TAG_OK = 0;
const TAG_ERR = 1;

export function encodeEnvelopeOk(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length);
  out[0] = TAG_OK;
  out.set(payload, 1);
  return out;
}

export function encodeEnvelopeErr(id: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + body.length);
  out[0] = TAG_ERR;
  out[1] = id & 0xff;
  out[2] = (id >> 8) & 0xff;
  out.set(body, 3);
  return out;
}

export function decodeEnvelope(frame: Uint8Array): Envelope | undefined {
  const tag = frame[0];
  if (tag === TAG_OK) {
    return { ok: frame.subarray(1) };
  }
  if (tag === TAG_ERR) {
    if (frame.length < 3) return undefined;
    const id = frame[1]! | (frame[2]! << 8);
    return { err: { id, body: frame.subarray(3) } };
  }
  return undefined;
}
