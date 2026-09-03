/// What an unreliable wire does to a frame. One `FaultSpec` per connection; the
/// engine hands the (mutable) object to both of that connection's transports,
/// so tweaking a control in the inspector takes effect on the next frame with
/// no reconnect.

export type FaultDir = "requests" | "responses" | "both";

export interface FaultSpec {
  /** 0..1 — probability a frame is dropped outright. */
  dropProb: number;
  /** Uniform delivery delay, ms. `0..0` = none. */
  delayMin: number;
  delayMax: number;
  /** Hold up to N frames, then release them shuffled. `0` = keep order. */
  reorderWindow: number;
  /** 0..1 — probability a body byte is flipped before delivery. */
  corruptProb: number;
  /** Hard cut both directions — every frame dropped until cleared. */
  partition: boolean;
  /** Which direction the drop / delay / reorder / corrupt apply to. */
  applyTo: FaultDir;
}

export function noFaults(): FaultSpec {
  return {
    dropProb: 0,
    delayMin: 0,
    delayMax: 0,
    reorderWindow: 0,
    corruptProb: 0,
    partition: false,
    applyTo: "both",
  };
}

/** Any behaviour that isn't a clean, ordered, immediate pass-through. */
export function faultsActive(f: FaultSpec): boolean {
  return (
    f.partition ||
    f.dropProb > 0 ||
    f.corruptProb > 0 ||
    f.reorderWindow > 0 ||
    f.delayMax > 0
  );
}

export function faultAppliesTo(f: FaultSpec, dir: "request" | "response"): boolean {
  return f.applyTo === "both" || f.applyTo === `${dir}s`;
}

/** A copy of `bytes` with one byte in its back half flipped — enough to make the
 *  body fail to decode without mangling the frame header. */
export function corruptBytes(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  if (out.length === 0) return out;
  const i = Math.floor(out.length / 2 + Math.random() * (out.length / 2));
  out[Math.min(i, out.length - 1)] ^= 0xff;
  return out;
}
