// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The connection handshake — byte-compatible with `comline-runtime`'s
 * `contract::handshake`. Each end sends one fixed 31-byte frame first and
 * refuses on a schema / wire-format / framing mismatch.
 */

import { RuntimeError } from "./contract.js";

const MAGIC = Uint8Array.of(0x43, 0x4f); // "CO"
const VERSION = 1;
/** `[MAGIC:2][VERSION:1][ir_hash:u64][wire_format:u64][framing:u64][caps:u32]`, LE. */
const LEN = 2 + 1 + 8 + 8 + 8 + 4;

const U64_MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x00000100000001b3n;

/** Name of Comline's default datagram framing. Pass it to {@link Handshake}. */
export const FRAMING_DATAGRAM = "comline.datagram";

/**
 * 64-bit FNV-1a over a name's UTF-8 bytes. Folds a wire-format / framing name
 * into the fixed-size handshake without a registry; matches
 * `comline_runtime::contract::name_hash`.
 */
export function nameHash(name: string): bigint {
  let h = FNV_OFFSET;
  for (const b of new TextEncoder().encode(name)) {
    h = (h ^ BigInt(b)) & U64_MASK;
    h = (h * FNV_PRIME) & U64_MASK;
  }
  return h;
}

export interface HandshakeInit {
  /** Fingerprint of the frozen IR both ends generated from (the `IR_HASH` const). */
  irHash: bigint;
  /** The wire format's name, e.g. `"json"` — hashed in. */
  wireFormat: string;
  /** The framing's name, e.g. {@link FRAMING_DATAGRAM} — hashed in. */
  framing: string;
  /** Transport capability bits. Advisory: a difference here is not a mismatch. */
  capabilities?: number;
}

/** What each end declares when a connection opens. */
export class Handshake {
  readonly irHash: bigint;
  readonly wireFormat: bigint;
  readonly framing: bigint;
  readonly capabilities: number;

  constructor(init: HandshakeInit) {
    this.irHash = init.irHash & U64_MASK;
    this.wireFormat = nameHash(init.wireFormat);
    this.framing = nameHash(init.framing);
    this.capabilities = (init.capabilities ?? 0) >>> 0;
  }

  /** The fixed 31-byte frame. */
  encode(): Uint8Array {
    const frame = new Uint8Array(LEN);
    const view = new DataView(frame.buffer);
    frame.set(MAGIC, 0);
    frame[2] = VERSION;
    view.setBigUint64(3, this.irHash, true);
    view.setBigUint64(11, this.wireFormat, true);
    view.setBigUint64(19, this.framing, true);
    view.setUint32(27, this.capabilities, true);
    return frame;
  }

  /** Parse a frame; `undefined` if truncated or the magic / version is wrong. */
  static decode(frame: Uint8Array): Handshake | undefined {
    if (frame.length < LEN) return undefined;
    if (frame[0] !== MAGIC[0] || frame[1] !== MAGIC[1] || frame[2] !== VERSION) {
      return undefined;
    }
    const view = new DataView(frame.buffer, frame.byteOffset, LEN);
    const h = Object.create(Handshake.prototype) as Handshake;
    return Object.assign(h, {
      irHash: view.getBigUint64(3, true),
      wireFormat: view.getBigUint64(11, true),
      framing: view.getBigUint64(19, true),
      capabilities: view.getUint32(27, true),
    });
  }

  /**
   * Check a peer's declaration against this one. Throws
   * `RuntimeError("handshake")` if `irHash`, `wireFormat`, or `framing`
   * disagree; capability bits are allowed to differ.
   */
  check(peer: Handshake): void {
    const agree =
      this.irHash === peer.irHash &&
      this.wireFormat === peer.wireFormat &&
      this.framing === peer.framing;
    if (!agree) throw RuntimeError.handshake();
  }
}
