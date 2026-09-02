/// The compile worker: loads the Comline WASM module once, then answers
/// `compile` / `generate` requests off the main thread.

import init, { compile, generate } from "./wasm/comline_playground_wasm.js";

export interface Diagnostic {
  severity: "error";
  message: string;
  start: number;
  end: number;
}
export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  ir: string | null;
  units: number;
}
export interface GeneratedFile {
  path: string;
  contents: string;
}
export interface GenerateResult {
  files: GeneratedFile[];
  error: string | null;
}

type Req =
  | { id: number; cmd: "compile"; source: string }
  | { id: number; cmd: "generate"; source: string; target: string; mode: string };

const ready = init();

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  await ready;
  try {
    const result =
      req.cmd === "compile"
        ? (compile(req.source) as CompileResult)
        : (generate(req.source, req.target, req.mode) as GenerateResult);
    (self as unknown as Worker).postMessage({ id: req.id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      error: String(err),
    });
  }
};
