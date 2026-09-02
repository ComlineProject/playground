/// Read a raw frame back into something the inspector can show — the same
/// framing / handshake decoders the runtime uses, plus a JSON decode of the
/// sub-frames (Phase 1's codec is always JSON).

import {
  DatagramFraming,
  FRAMING_DATAGRAM,
  Handshake,
  JsonRpcFraming,
  nameHash,
  type Framing,
} from "./runtime/index.ts";
import type { Frame } from "./transport.ts";

export interface FrameDetail {
  kind: "handshake" | "request" | "response" | "unknown";
  framing: string;
  /** request: the function name (resolved from the call address). */
  fn?: string;
  requestId?: string;
  /** request: the decoded params. */
  params?: unknown;
  /** response: the decoded ok body. */
  ok?: unknown;
  /** response: a raised error. */
  err?: { ordinal: number; body: unknown };
  /** handshake: the three fields it carries (names resolved where known). */
  handshake?: { irHash: string; wireFormat: string; framing: string; caps: number };
}

export interface DecodeCtx {
  clientName: string;
  serverName: string;
  framing: "datagram" | "jsonrpc";
  /** function names in protocol order — resolves a datagram request's call id. */
  fnNames: string[];
}

// FNV-1a name hashes → readable names, for the handshake's wire-format / framing.
const NAME_BY_HASH = new Map<bigint, string>([
  [nameHash("json"), "json"],
  [nameHash(FRAMING_DATAGRAM), FRAMING_DATAGRAM],
  [nameHash("jsonrpc-2.0"), "jsonrpc-2.0"],
]);
const nameOf = (h: bigint) => NAME_BY_HASH.get(h) ?? `0x${h.toString(16)}`;

const framingFor = (name: "datagram" | "jsonrpc"): Framing =>
  name === "jsonrpc" ? new JsonRpcFraming() : new DatagramFraming();

function jsonOf(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return `<${bytes.length} bytes>`;
  }
}

export function describeFrame(frame: Frame, ctx: DecodeCtx): FrameDetail {
  const bytes = frame.bytes;
  const framingName = ctx.framing === "jsonrpc" ? "jsonrpc-2.0" : FRAMING_DATAGRAM;

  const hs = Handshake.decode(bytes);
  if (hs && bytes.length === 31) {
    return {
      kind: "handshake",
      framing: framingName,
      handshake: {
        irHash: `0x${hs.irHash.toString(16).padStart(16, "0")}`,
        wireFormat: nameOf(hs.wireFormat),
        framing: nameOf(hs.framing),
        caps: hs.capabilities,
      },
    };
  }

  const framing = framingFor(ctx.framing);

  if (frame.from === ctx.clientName) {
    const req = framing.decodeRequest(bytes);
    if (!req) return { kind: "unknown", framing: framingName };
    const fn =
      "name" in req.call ? req.call.name : (ctx.fnNames[req.call.id] ?? `#${req.call.id}`);
    return {
      kind: "request",
      framing: framingName,
      fn,
      requestId: req.requestId.toString(),
      params: jsonOf(req.params),
    };
  }

  const res = framing.decodeResponse(bytes);
  if (!res) return { kind: "unknown", framing: framingName };
  const detail: FrameDetail = {
    kind: "response",
    framing: framingName,
    requestId: res.requestId.toString(),
  };
  if ("ok" in res.envelope) detail.ok = jsonOf(res.envelope.ok);
  else detail.err = { ordinal: res.envelope.err.id, body: jsonOf(res.envelope.err.body) };
  return detail;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}
