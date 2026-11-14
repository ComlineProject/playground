/// The simulation: place protocol instances, wire them together, send a call,
/// watch the frames. `loadSim` loads the engine, `createSim` builds the view,
/// and its styles are `comline-web-kit/sim.css`. Public entry — everything
/// else under `sim/` is internal.

export { loadSim } from "./load.ts";
export { createSim, type Recording, type SimOpts, type SimView } from "./ui/view.ts";
export {
  findProtocol,
  type ArgShape,
  type ConnectionShape,
  type ErrorShape,
  type FieldShape,
  type FnShape,
  type ProjectShape,
  type ProtocolShape,
  type SchemaShape,
  type ThrowShape,
  type TypeDef,
  type TypeRef,
} from "./shape.ts";
