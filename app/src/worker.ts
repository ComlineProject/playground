/// The compile worker: loads the Comline WASM module once, then answers
/// `compileProject` / `generateProject` / `semanticTokens` / `hover` /
/// `completions` requests off the main thread. The editor services call the
/// language server's handlers verbatim, so the editor matches `comline-lsp`;
/// `compileProject` / `generateProject` run the schema set as one package, so
/// cross-file `use` resolves the way `comline build` resolves it.

import init, {
  compile_project,
  generate_project,
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

/// One virtual schema file: its name (its stem is the namespace) and its text.
export interface FileInput {
  path: string;
  source: string;
}

/// Per-file result of compiling the whole set.
export interface FileReport {
  path: string;
  namespace: string;
  ok: boolean;
  diagnostics: LspDiagnostic[];
  ir: string | null;
  units: number;
}
export interface CompileProjectResult {
  files: FileReport[];
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
  | { id: number; cmd: "compileProject"; files: FileInput[] }
  | { id: number; cmd: "generateProject"; files: FileInput[]; target: string; mode: string }
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
      case "compileProject":
        result = compile_project(req.files);
        break;
      case "generateProject":
        result = generate_project(req.files, req.target, req.mode);
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
