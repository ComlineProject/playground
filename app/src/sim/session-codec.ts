/// A `Session` ⇄ URL-safe string. `shape` is dropped (it's recomputed from the
/// open schemas); everything else — nodes, instances, behaviours, connections,
/// faults, seed, clock mode — is JSON, which round-trips as-is. The string goes
/// in the URL fragment (`#s=…`) so a topology is shareable by link.

import { reseedCounters, type Session } from "./model.ts";
import type { ProjectShape } from "./shape.ts";

const VERSION = 1;

interface Wire {
  v: number;
  session: Omit<Session, "shape">;
}

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function encodeSession(session: Session): string {
  const { shape: _shape, ...rest } = session;
  const wire: Wire = { v: VERSION, session: rest };
  return toB64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

/** Decode a fragment against the current `shape`. `null` if it isn't a session
 *  string this build understands. Instances keep their stored `irHash`, so a
 *  schema that has moved on since the link was made loads them **stale** — the
 *  existing resync flow (1e) then applies. */
export function decodeSession(str: string, shape: ProjectShape): Session | null {
  let wire: Wire;
  try {
    wire = JSON.parse(new TextDecoder().decode(fromB64Url(str)));
  } catch {
    return null;
  }
  if (!wire || wire.v !== VERSION || typeof wire.session !== "object") return null;
  const s = wire.session;
  if (!Array.isArray(s.nodes) || !Array.isArray(s.instances) || !Array.isArray(s.connections)) {
    return null;
  }
  const session: Session = {
    shape,
    nodes: s.nodes,
    instances: s.instances,
    connections: s.connections,
    latencyMs: Number(s.latencyMs) || 0,
    callTimeoutMs: Number(s.callTimeoutMs) || 3000,
    seed: Number(s.seed) || 1,
    clockMode: s.clockMode === "stepped" ? "stepped" : "real",
  };
  reseedCounters(session);
  return session;
}

/** Read `#s=…` from a URL, if present. */
export function sessionFromHash(hash: string): string | null {
  const m = /[#&]s=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}
