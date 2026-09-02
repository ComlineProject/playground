// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wire formats. {@link JsonCodec} pairs with the Rust runtime's `format::Json`
 * (`name === "json"`); a MessagePack codec matching `format::MsgPack` is a
 * later addition.
 */

import type { Codec } from "./contract.js";

/**
 * UTF-8 JSON. `bigint` fields (only 128-bit IDL integers map to `bigint`) are
 * written as JSON numbers and read back as `number` — lossless below 2^53. A
 * precise `bigint` round-trip waits on the tagged binary codec.
 */
export class JsonCodec implements Codec {
  readonly name = "json";

  encode(value: unknown): Uint8Array {
    const json = JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? Number(v) : v,
    );
    if (json === undefined) {
      throw new TypeError("JsonCodec: value is not JSON-serializable");
    }
    return new TextEncoder().encode(json);
  }

  decode<T>(bytes: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
}
