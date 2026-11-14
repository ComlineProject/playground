/// The editor: CodeMirror fed by the language server, compiled to WASM and run
/// in a worker. `createCompiler` starts that worker, and `mountEditor` /
/// `makeState` put an editor on the page that uses it.

export {
  makeState,
  mountEditor,
  readOnlyExtensions,
  type EditorBridge,
  type EditorContext,
} from "./editor.ts";
export { createCompiler, type Compiler, type CompilerOpts } from "./compiler.ts";
export type {
  CompileProjectResult,
  CompletionItem,
  FileInput,
  FileReport,
  GeneratedFile,
  GenerateResult,
  Hover,
  LspDiagnostic,
  LspPosition,
  LspRange,
  SemanticTokens,
} from "./worker.ts";
