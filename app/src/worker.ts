/// The compile worker: loads the Comline WASM module once, then answers
/// `compile` / `generate` / `semanticTokens` / `hover` / `completions` requests
/// off the main thread. The latter three call the language server's handlers
/// verbatim, so the editor matches `comline-lsp`.

import init, {
  compile,
  generate,
  semantic_tokens,
  hover,
  completions,
} from "./wasm/comline_playground_wasm.js";

// ── result shapes (a thin slice of lsp-types) ─────────────────────────────
export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number; // 1 error, 2 warning, 3 info, 4 hint
  message: string;
  source?: string;
}
export interface CompileResult {
  ok: boolean;
  diagnostics: LspDiagnostic[];
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
export interface SemanticTokens {
  result_id?: string;
  data: number[]; // delta-encoded 5-tuples
}
export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  insertTextFormat?: number;
}
export interface Hover {
  contents: unknown;
}

type Req =
  | { id: number; cmd: "compile"; source: string }
  | { id: number; cmd: "generate"; source: string; target: string; mode: string }
  | { id: number; cmd: "semanticTokens"; source: string }
  | { id: number; cmd: "hover"; source: string; line: number; character: number }
  | { id: number; cmd: "completions"; source: string; line: number; character: number };

const ready = init();

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  await ready;
  try {
    let result: unknown;
    switch (req.cmd) {
      case "compile":
        result = compile(req.source);
        break;
      case "generate":
        result = generate(req.source, req.target, req.mode);
        break;
      case "semanticTokens":
        result = semantic_tokens(req.source);
        break;
      case "hover":
        result = hover(req.source, req.line, req.character);
        break;
      case "completions":
        result = completions(req.source, req.line, req.character);
        break;
    }
    (self as unknown as Worker).postMessage({ id: req.id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: req.id, error: String(err) });
  }
};
