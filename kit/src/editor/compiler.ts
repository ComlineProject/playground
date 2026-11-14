/// The page's side of the compile worker (`worker.ts`): starts it, and turns
/// each request into a promise. It satisfies `EditorBridge`, so it can feed
/// the editor directly, and adds what a page needs beyond the editor:
/// generating code and describing the project for the simulate view.

import type { EditorBridge } from "./editor.ts";
import type {
  CompileProjectResult,
  CompletionItem,
  FileInput,
  GenerateResult,
  Hover,
  ProjectShape,
  SemanticTokens,
} from "./worker.ts";

export interface Compiler extends EditorBridge {
  generateProject(files: FileInput[], target: string, mode: string): Promise<GenerateResult>;
  describeProject(files: FileInput[]): Promise<ProjectShape>;
  /** Stop the worker. The compiler can't be used afterwards. */
  terminate(): void;
}

export interface CompilerOpts {
  /** Called when the WASM throws. The request resolves to its fallback
   *  (no diagnostics, no files, an empty shape) either way. */
  onError?: (message: string) => void;
}

export function createCompiler(opts: CompilerOpts = {}): Compiler {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map<number, (v: unknown) => void>();

  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const resolve = pending.get(e.data.id);
    if (!resolve) return;
    pending.delete(e.data.id);
    resolve(e.data.error ? { __error: e.data.error } : e.data.result);
  };

  function call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = ++seq;
    return new Promise((resolve) => {
      pending.set(id, resolve as (v: unknown) => void);
      worker.postMessage({ id, ...msg });
    });
  }

  async function unwrap<T>(msg: Record<string, unknown>, fallback: T): Promise<T> {
    const r = await call<T | { __error: string }>(msg);
    if (r && typeof r === "object" && "__error" in r) {
      opts.onError?.(r.__error);
      return fallback;
    }
    return r as T;
  }

  return {
    compileProject: (files) =>
      unwrap<CompileProjectResult>({ cmd: "compileProject", files }, { files: [] }),
    semanticTokens: (source) =>
      unwrap<SemanticTokens>({ cmd: "semanticTokens", source }, { data: [] }),
    hover: (files, activePath, line, character) =>
      unwrap<Hover | null>({ cmd: "hover", files, activePath, line, character }, null),
    completions: (source, line, character) =>
      unwrap<CompletionItem[]>({ cmd: "completions", source, line, character }, []),
    generateProject: (files, target, mode) =>
      unwrap<GenerateResult>({ cmd: "generateProject", files, target, mode }, { files: [], error: "wasm error" }),
    describeProject: (files) =>
      unwrap<ProjectShape>({ cmd: "describeProject", files }, { schemas: [] }),
    terminate: () => worker.terminate(),
  };
}
