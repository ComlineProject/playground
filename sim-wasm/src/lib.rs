//! Thin wrapper: re-export `comline-simulator`'s `#[wasm_bindgen]` surface so
//! `wasm-pack build sim-wasm` produces the playground's sim module. The engine
//! lives in `ComlineProject/simulator`; this crate only pins its rev and picks
//! the `script` feature on or off.

pub use comline_simulator::*;
