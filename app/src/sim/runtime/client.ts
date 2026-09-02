// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Call, Codec, Envelope, Framing } from "./contract.js";
import { RuntimeError } from "./contract.js";
import { Handshake } from "./handshake.js";
import type { Transport } from "./transport.js";
import { DatagramFraming } from "./framing/datagram.js";

/**
 * The consumer side. Frames a call, sends it, waits for the matching response,
 * and hands the generated stub the raw {@link Envelope} to decode. Generic over
 * the {@link Framing}; defaults to {@link DatagramFraming}.
 */
export class Client {
  private nextId = 0n;

  constructor(
    private readonly transport: Transport,
    readonly codec: Codec,
    readonly framing: Framing = new DatagramFraming(),
  ) {}

  /**
   * Bind and run the connection {@link Handshake}: send `local`, read the
   * peer's, refuse (`RuntimeError("handshake")`) on a mismatch.
   */
  static async connect(
    transport: Transport,
    codec: Codec,
    local: Handshake,
    framing: Framing = new DatagramFraming(),
  ): Promise<Client> {
    await transport.send(local.encode());
    const peer = Handshake.decode(await transport.recv());
    if (!peer) throw RuntimeError.handshake();
    local.check(peer);
    return new Client(transport, codec, framing);
  }

  /** Make `call` with `params`, block for the response, return its {@link Envelope}. */
  async call(call: Call, params: unknown): Promise<Envelope> {
    const requestId = this.nextId++;
    await this.transport.send(
      this.framing.encodeRequest(call, requestId, this.codec.encode(params)),
    );
    const res = this.framing.decodeResponse(await this.transport.recv());
    if (!res) throw RuntimeError.framing();
    if (res.requestId !== requestId) throw RuntimeError.framing();
    return res.envelope;
  }

  /** Fire-and-forget: send the call, expect no response (a one-way function). */
  async notify(call: Call, params: unknown): Promise<void> {
    const requestId = this.nextId++;
    await this.transport.send(
      this.framing.encodeRequest(call, requestId, this.codec.encode(params)),
    );
  }
}
