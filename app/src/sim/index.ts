/// The simulation: place two protocol instances, wire them together, send a
/// call, watch the frames. Public entry — everything else under `sim/` is
/// internal.

export { createSim, type SimView } from "./ui/view.ts";
export type { ProjectShape } from "./shape.ts";
