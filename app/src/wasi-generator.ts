/// External generators in the browser: a generator built for `wasm32-wasip1`
/// (the generator protocol's WASI packaging, core#8), run through a WASI shim
/// the way `comline generate` runs one under wasmtime.
///
/// The request is the one the linked generators get (`encode_request` in the
/// editor wasm), on stdin. The generator gets nothing else: no files (no
/// preopened directories), no environment, no arguments beyond `argv[0]`.
/// Its stdout is one encoded response, checked by `decode_response` as the
/// CLI checks it: an error response, a bad path or too much output is
/// refused whole.
///
/// What the CLI has that this doesn't (yet): a wall-time limit, which needs
/// the generator in a worker of its own that can be terminated, and a cap on
/// the module's linear memory.

import { ConsoleStdout, File, OpenFile, WASI, wasi } from "@bjorn3/browser_wasi_shim";

import { decode_response, encode_request } from "./wasm/comline_playground_wasm.js";

/// The most a generator may write to stdout: one encoded response. The CLI's
/// limit (`external::STDOUT_CAP`).
export const STDOUT_CAP = 256 * 1024 * 1024;
/// The most of a generator's stderr that's kept; the rest is dropped.
export const STDERR_CAP = 64 * 1024;

export interface GeneratedFile {
  path: string;
  contents: string;
}

/// What `generate_project` returns, and so what this returns too.
export interface GenerateResult {
  files: GeneratedFile[];
  /// Absent (`undefined`) when generation succeeded.
  error?: string;
}

/// What a generator wrote, and how it exited.
export interface GeneratorRun {
  exitCode: number;
  stdout: Uint8Array;
  /// Its stderr as text, cut at `STDERR_CAP` bytes.
  stderr: string;
}

/// One output stream, collected up to `cap` bytes. Past the cap a write
/// fails (`over` is set), unless `truncate`, which keeps what fits and drops
/// the rest.
class Capped extends ConsoleStdout {
  private chunks: Uint8Array[] = [];
  private length = 0;
  over = false;

  constructor(
    private readonly cap: number,
    private readonly truncate: boolean,
  ) {
    super(() => {});
  }

  override fd_write(data: Uint8Array): { ret: number; nwritten: number } {
    const room = this.cap - this.length;
    if (data.byteLength > room) {
      this.over = true;
      if (!this.truncate) return { ret: wasi.ERRNO_FBIG, nwritten: 0 };
      if (room > 0) this.push(data.subarray(0, room));
      return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
    }
    this.push(data);
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }

  private push(data: Uint8Array) {
    this.chunks.push(data.slice());
    this.length += data.byteLength;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

/// Run the WASI generator `wasm` with `request` on stdin, and return what it
/// wrote. Throws when it can't be instantiated, traps, or writes more than
/// `STDOUT_CAP` to stdout.
export async function runWasiGenerator(
  wasm: BufferSource | WebAssembly.Module,
  request: Uint8Array,
): Promise<GeneratorRun> {
  const stdout = new Capped(STDOUT_CAP, false);
  const stderr = new Capped(STDERR_CAP, true);
  const shim = new WASI(
    ["generator"],
    [],
    [new OpenFile(new File(request, { readonly: true })), stdout, stderr],
  );
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: shim.wasiImport,
  });

  let exitCode: number;
  try {
    exitCode = shim.start(instance as unknown as Parameters<WASI["start"]>[0]);
  } catch (e) {
    if (stdout.over) throw new Error(tooMuchOutput());
    throw new Error(`the generator trapped: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (stdout.over) throw new Error(tooMuchOutput());
  return {
    exitCode,
    stdout: stdout.bytes(),
    stderr: new TextDecoder().decode(stderr.bytes()),
  };
}

function tooMuchOutput(): string {
  return `its output passed the ${STDOUT_CAP}-byte limit; nothing was written`;
}

/// `generate_project`, through the WASI generator `wasm` instead of the
/// linked one: the same request, and the same `{ files, error }` back, with
/// any failure in `error`. `files` is `[{ path, source }]`; `target` and
/// `mode` are `generate_project`'s.
export async function generateWithWasiGenerator(
  wasm: BufferSource | WebAssembly.Module,
  files: { path: string; source: string }[],
  target: string,
  mode: string,
): Promise<GenerateResult> {
  const encoded = encode_request(files, target, mode) as {
    request?: Uint8Array;
    error?: string;
  };
  if (!encoded.request) return { files: [], error: encoded.error ?? "the request didn't encode" };

  let run: GeneratorRun;
  try {
    run = await runWasiGenerator(wasm, encoded.request);
  } catch (e) {
    return { files: [], error: `the generator: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (run.exitCode !== 0) {
    const why = run.stderr.trim();
    return {
      files: [],
      error: `the generator exited with code ${run.exitCode}${why ? `: ${why}` : ""}`,
    };
  }
  return decode_response(run.stdout) as GenerateResult;
}
