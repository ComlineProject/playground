/// External generators in the browser: a generator built for `wasm32-wasip1`
/// (the generator protocol's WASI packaging, core#8), run through a WASI shim
/// the way `comline generate` runs one under wasmtime (cli `src/external.rs`).
///
/// A generator is untrusted code, so each call runs as the CLI runs it:
///
/// - **In a worker of its own, with a wall-time limit.** The main thread
///   `terminate()`s the worker at the deadline (`DEFAULT_TIMEOUT_MS`, or
///   `timeoutMs`), which stops the generator wherever it is, a loop without
///   calls included. The limit is per call, as the CLI's is.
/// - **With its linear memory capped** (`WASM_MEMORY`, or `memoryCap`).
///   Before compiling, `limitMemory` rewrites the module's memory section so
///   every memory it defines declares a maximum no larger than the cap: the
///   engine then refuses `memory.grow` past it (it returns -1, as under the
///   CLI's wasmtime `StoreLimits`). A module that starts with more than the
///   cap, imports its memory, or uses 64-bit or custom-page-size memory is
///   refused before it runs. After instantiation the memory's size is checked
///   again. Not counted, as under the CLI: the engine's own allocations for
///   the instance (its tables, stack and compiled code), and what's held on
///   the generator's behalf (its stdout, up to `STDOUT_CAP`, and stderr, up
///   to `STDERR_CAP`).
/// - **Describe first.** A `Describe` request goes before `Generate`, and a
///   generator whose protocol versions or IR formats don't include the
///   playground's, or that doesn't offer the target's language at its
///   version, is refused (`check_description`: the CLI's checks and
///   messages).
/// - **With its output capped and checked.** stdout is capped at
///   `STDOUT_CAP` (past it, writes fail and the call is refused), stderr is
///   kept up to `STDERR_CAP` per call (the rest is dropped). The response is
///   checked whole by `decode_response`: an error response, a bad path or
///   too much output is refused.
///
/// Any failure refuses the whole call: `files` is empty.
///
/// The generator gets nothing but its request on stdin: no files (no
/// preopened directories), no environment, no arguments beyond `argv[0]`
/// (its name).

import {
  check_description,
  decode_response,
  encode_describe,
  encode_request,
} from "./wasm/comline_playground_wasm.js";
import { STDERR_CAP, type GuestCall, type GuestResult } from "./wasi-generator-guest.ts";

export { STDERR_CAP, STDOUT_CAP } from "./wasi-generator-guest.ts";

/// How long one call to a generator may take, unless `timeoutMs` says
/// otherwise. The CLI's default (`external::DEFAULT_TIMEOUT`).
export const DEFAULT_TIMEOUT_MS = 60_000;
/// The most linear memory a generator may grow to, unless `memoryCap` says
/// otherwise. The CLI's limit (`external::WASM_MEMORY`).
export const WASM_MEMORY = 1024 * 1024 * 1024;
const PAGE = 64 * 1024;

/// A worker running one call. The browser's is `browserWorker`; the tests
/// run the same guest code in a Node worker.
export interface GuestWorker {
  run(call: GuestCall): Promise<GuestResult>;
  terminate(): void;
}

export interface RunOptions {
  /// The generator's name: `argv[0]`, and what messages call it. Default
  /// `generator.wasm`.
  name?: string;
  /// The wall-time limit for one call, in milliseconds.
  timeoutMs?: number;
  /// A fresh worker per call. Default `browserWorker`.
  worker?: () => GuestWorker;
}

export interface PrepareOptions {
  /// The memory cap in bytes, a whole number of 64 KiB pages.
  memoryCap?: number;
}

/// A generator ready to run: compiled from its bytes with its memory
/// capped. Made by `prepareGenerator`, once, for every call after.
export class PreparedGenerator {
  constructor(
    readonly module: WebAssembly.Module,
    readonly memoryCap: number,
  ) {}
}

export interface GeneratedFile {
  path: string;
  contents: string;
}

/// What `generate_project` returns, and so what this returns too.
export interface GenerateResult {
  files: GeneratedFile[];
  /// Absent (`undefined`) when generation succeeded.
  error?: string;
  /// What the generator wrote to stderr, over both calls; absent when it
  /// wrote nothing.
  stderr?: string;
}

/// What a generator wrote, and how it exited.
export interface GeneratorRun {
  exitCode: number;
  stdout: Uint8Array;
  /// Its stderr as text, cut at `STDERR_CAP` bytes (with a note saying so).
  stderr: string;
}

/// Why a call failed, with what it wrote to stderr first.
export class GeneratorError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/// `bytes` with every memory it defines capped at `cap` bytes. Throws,
/// naming why, when the module can't run within the cap. The engine
/// enforces the maximum this sets on every `memory.grow`.
export function limitMemory(bytes: Uint8Array, cap: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(cap) || cap < PAGE || cap % PAGE !== 0 || cap > 65536 * PAGE) {
    throw new Error(`a memory cap of ${cap} bytes isn't a whole number of 64 KiB pages up to 4 GiB`);
  }
  const capPages = cap / PAGE;
  const r = new Reader(bytes);
  if (bytes.length < 8 || r.u32le() !== 0x6d736100) throw new Error("isn't a WebAssembly module");
  if (r.u32le() !== 1) throw new Error("isn't a WebAssembly module of version 1");

  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  while (!r.done()) {
    const start = r.at;
    const id = r.byte();
    const size = r.uleb();
    const end = r.at + size;
    if (end > bytes.length) throw new Error("isn't a WebAssembly module (a section runs past its end)");
    if (id !== 5) {
      out.push(bytes.subarray(start, end));
      r.at = end;
      continue;
    }
    // The memory section: a vector of limits.
    const body: number[] = [];
    const count = r.uleb();
    pushUleb(body, count);
    for (let i = 0; i < count; i++) {
      const flags = r.uleb();
      if (flags & 0x04) throw new Error("uses 64-bit memory, which the playground doesn't run");
      if (flags & ~0x03) throw new Error(`declares a kind of memory the playground doesn't run (flags ${flags})`);
      const min = r.uleb();
      const max = flags & 0x01 ? r.uleb() : undefined;
      if (min > capPages) {
        throw new Error(`starts with ${min * PAGE} bytes of memory, over the ${cap}-byte limit; nothing was written`);
      }
      pushUleb(body, flags | 0x01);
      pushUleb(body, min);
      pushUleb(body, max === undefined ? capPages : Math.min(max, capPages));
    }
    if (r.at !== end) throw new Error("isn't a WebAssembly module (its memory section doesn't parse)");
    const header: number[] = [5];
    pushUleb(header, body.length);
    out.push(new Uint8Array(header), new Uint8Array(body));
  }

  const result = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of out) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

class Reader {
  at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  done(): boolean {
    return this.at >= this.bytes.length;
  }
  byte(): number {
    if (this.at >= this.bytes.length) throw new Error("isn't a WebAssembly module (it ends early)");
    return this.bytes[this.at++];
  }
  u32le(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) v += this.byte() * 2 ** (8 * i);
    return v;
  }
  /// An unsigned LEB128 of up to 32 bits.
  uleb(): number {
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.byte();
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
    }
    throw new Error("isn't a WebAssembly module (a number is too long)");
  }
}

function pushUleb(out: number[], value: number) {
  do {
    let b = value % 128;
    value = Math.floor(value / 128);
    if (value) b |= 0x80;
    out.push(b);
  } while (value);
}

/// Compiles the generator `wasm` with its memory capped (`limitMemory`).
/// Throws, naming why, when it can't be run.
export async function prepareGenerator(
  wasm: Uint8Array | ArrayBuffer,
  options: PrepareOptions = {},
): Promise<PreparedGenerator> {
  const memoryCap = options.memoryCap ?? WASM_MEMORY;
  const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
  const limited = limitMemory(bytes, memoryCap);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(limited);
  } catch (e) {
    throw new Error(`isn't a WebAssembly module the browser can run: ${message(e)}`);
  }
  if (WebAssembly.Module.imports(module).some((i) => i.kind === "memory")) {
    throw new Error("imports its memory, which the playground doesn't provide");
  }
  return new PreparedGenerator(module, memoryCap);
}

/// A browser `Worker` running `wasi-generator.worker.ts`.
export function browserWorker(): GuestWorker {
  const worker = new Worker(new URL("./wasi-generator.worker.ts", import.meta.url), {
    type: "module",
  });
  return {
    run: (call) =>
      new Promise((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<GuestResult>) => resolve(e.data);
        worker.onerror = (e) => reject(new Error(e.message || "its worker failed"));
        worker.postMessage(call);
      }),
    terminate: () => worker.terminate(),
  };
}

/// Run `generator` once with `request` on stdin, in a worker of its own, and
/// return what it wrote. Throws a `GeneratorError` (not naming the
/// generator; `generateWithWasiGenerator` does) when it can't be
/// instantiated, traps, writes more than `STDOUT_CAP` to stdout, or doesn't
/// finish within the time limit. The worker is terminated either way.
export async function runWasiGenerator(
  generator: PreparedGenerator,
  request: Uint8Array,
  options: RunOptions = {},
): Promise<GeneratorRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const worker = (options.worker ?? browserWorker)();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  let result: GuestResult | "timeout";
  try {
    result = await Promise.race([
      worker.run({
        module: generator.module,
        input: request,
        name: options.name ?? "generator.wasm",
        memoryCap: generator.memoryCap,
      }),
      deadline,
    ]);
  } catch (e) {
    throw new GeneratorError(`failed: ${message(e)}; nothing was written`, "");
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
  if (result === "timeout") {
    throw new GeneratorError(
      `didn't finish within ${timeoutMs / 1000}s and was stopped; nothing was written`,
      "",
    );
  }
  const stderr = stderrText(result.stderr, result.stderrTruncated);
  if (!result.ok) throw new GeneratorError(result.error, stderr);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr };
}

function stderrText(bytes: Uint8Array, truncated: boolean): string {
  const text = new TextDecoder().decode(bytes);
  return truncated ? `${text}\n... (stderr past ${STDERR_CAP} bytes not shown)\n` : text;
}

/// `generate_project`, through the WASI generator `wasm` instead of the
/// linked one: the same request, and the same `{ files, error }` back, with
/// any failure in `error` and nothing in `files`. `files` is `[{ path,
/// source }]`; `target` and `mode` are `generate_project`'s. The generator
/// is asked to describe itself first, and refused if it can't take the
/// request (see the top of this file).
export async function generateWithWasiGenerator(
  wasm: Uint8Array | ArrayBuffer | PreparedGenerator,
  files: { path: string; source: string }[],
  target: string,
  mode: string,
  options: RunOptions & PrepareOptions = {},
): Promise<GenerateResult> {
  const who = `generator \`${options.name ?? "generator.wasm"}\``;
  const stderr: string[] = [];
  const refuse = (error: string): GenerateResult => withStderr({ files: [], error }, stderr);

  let generator: PreparedGenerator;
  try {
    generator = wasm instanceof PreparedGenerator ? wasm : await prepareGenerator(wasm, options);
  } catch (e) {
    return refuse(`${who}: ${message(e)}`);
  }

  // One call: its stdout once it exits successfully, or why not.
  const call = async (request: Uint8Array): Promise<Uint8Array | string> => {
    let run: GeneratorRun;
    try {
      run = await runWasiGenerator(generator, request, options);
    } catch (e) {
      if (e instanceof GeneratorError && e.stderr) stderr.push(e.stderr);
      return `${who}: ${message(e)}`;
    }
    if (run.stderr) stderr.push(run.stderr);
    if (run.exitCode !== 0) return `${who}: exited with code ${run.exitCode}; nothing was written`;
    return run.stdout;
  };

  let describe: Uint8Array;
  try {
    describe = encode_describe();
  } catch (e) {
    return refuse(message(e));
  }
  const description = await call(describe);
  if (typeof description === "string") return refuse(description);
  const checked = check_description(description, who, target) as { error?: string | null };
  if (checked.error) return refuse(checked.error);

  const encoded = encode_request(files, target, mode) as {
    request?: Uint8Array;
    error?: string;
  };
  if (!encoded.request) return refuse(encoded.error ?? "the request didn't encode");
  const output = await call(encoded.request);
  if (typeof output === "string") return refuse(output);
  const result = decode_response(output) as GenerateResult;
  if (result.error) return refuse(result.error);
  return withStderr(result, stderr);
}

function withStderr(result: GenerateResult, stderr: string[]): GenerateResult {
  const text = stderr.join("");
  return text ? { ...result, stderr: text } : result;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
