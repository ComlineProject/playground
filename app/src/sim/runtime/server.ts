// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Codec, Dispatch, Framing } from "./contract.js";
import { Reply, RuntimeError, resolveKind } from "./contract.js";
import { Handshake } from "./handshake.js";
import type { Transport } from "./transport.js";
import { DatagramFraming } from "./framing/datagram.js";

/**
 * The provider side. Reads a request frame, dispatches it, writes the response
 * frame — until the transport closes. Generic over the {@link Framing};
 * defaults to {@link DatagramFraming}.
 */
export class Server {
  constructor(
    private readonly dispatch: Dispatch,
    private readonly codec: Codec,
    private readonly framing: Framing = new DatagramFraming(),
  ) {}

  /** Handle one call. `true` — served; `false` — the transport closed. */
  async serveOne(transport: Transport): Promise<boolean> {
    let frame: Uint8Array;
    try {
      frame = await transport.recv();
    } catch {
      return false;
    }

    const req = this.framing.decodeRequest(frame);
    if (!req) throw RuntimeError.framing();

    const idx = resolveKind(req.call, this.dispatch.calls());
    if (idx === undefined) throw RuntimeError.unknownCall();

    const reply = new Reply();
    await this.dispatch.dispatch({ id: idx }, req.params, this.codec, reply);

    switch (reply.outcome.kind) {
      case "none":
        return true; // one-way call: nothing to reply
      case "ok":
        await transport.send(this.framing.encodeResponseOk(req.requestId, reply.body));
        return true;
      case "err":
        await transport.send(
          this.framing.encodeResponseErr(req.requestId, reply.outcome.id, reply.body),
        );
        return true;
    }
  }

  /** Serve calls until the transport closes. No handshake. */
  async serve(transport: Transport): Promise<void> {
    while (await this.serveOne(transport)) {
      /* keep serving */
    }
  }

  /**
   * Run the connection {@link Handshake} against the connecting peer — send
   * `local`, read theirs, refuse on a mismatch — then {@link Server.serve}.
   */
  async serveHandshaked(transport: Transport, local: Handshake): Promise<void> {
    await transport.send(local.encode());
    const peer = Handshake.decode(await transport.recv());
    if (!peer) throw RuntimeError.handshake();
    local.check(peer);
    await this.serve(transport);
  }
}
