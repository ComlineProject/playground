/// One call to a WASI generator, as the worker running it makes it: the
/// generator gets its request on stdin and nothing else (no preopened
/// directories, no environment, no arguments beyond `argv[0]`), and what it
/// writes to stdout and stderr is collected up to the CLI's caps.
///
/// No worker globals here, so the browser worker (`wasi-generator.worker.ts`)
/// and the tests' Node worker run the same code.

import { ConsoleStdout, File, OpenFile, WASI, wasi } from "@bjorn3/browser_wasi_shim";

/// The most a generator may write to stdout: one encoded response. The CLI's
/// limit (`external::STDOUT_CAP`).
export const STDOUT_CAP = 256 * 1024 * 1024;
/// The most of a generator's stderr that's kept; the rest is dropped. The
/// CLI's limit (`external::STDERR_CAP`).
export const STDERR_CAP = 64 * 1024;

/// What the main thread sends the worker: one call.
export interface GuestCall {
  /// Compiled from bytes whose memory maximum `limitMemory` capped.
  module: WebAssembly.Module;
  input: Uint8Array;
  /// `argv[0]`: the generator's name.
  name: string;
  /// The most linear memory the instance may have, in bytes.
  memoryCap: number;
}

/// What the worker sends back.
export type GuestResult =
  | {
      ok: true;
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      /// Whether stderr went past `STDERR_CAP` and was cut.
      stderrTruncated: boolean;
    }
  | {
      ok: false;
      /// Why, without the generator's name: the caller prefixes it.
      error: string;
      stderr: Uint8Array;
      stderrTruncated: boolean;
    };

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

export function tooMuchOutput(): string {
  return `its output passed the ${STDOUT_CAP}-byte limit; nothing was written`;
}

/// Runs one call. Never throws: every failure is a `GuestResult` with `ok:
/// false`.
export async function runGuest(call: GuestCall): Promise<GuestResult> {
  const stdout = new Capped(STDOUT_CAP, false);
  const stderr = new Capped(STDERR_CAP, true);
  const failed = (error: string): GuestResult => ({
    ok: false,
    error,
    stderr: stderr.bytes(),
    stderrTruncated: stderr.over,
  });

  const shim = new WASI(
    [call.name],
    [],
    [new OpenFile(new File(call.input, { readonly: true })), stdout, stderr],
    // The shim logs every call it doesn't support unless told not to.
    { debug: false },
  );
  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(call.module, {
      wasi_snapshot_preview1: shim.wasiImport,
    });
  } catch (e) {
    return failed(`couldn't be instantiated: ${message(e)}; nothing was written`);
  }
  // `limitMemory` has already capped the declared maximum, which is what
  // stops growth; this checks the instance got the memory it expected.
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    return failed("doesn't export its memory as `memory`; nothing was written");
  }
  if (memory.buffer.byteLength > call.memoryCap) {
    return failed(memoryOver(memory.buffer.byteLength, call.memoryCap));
  }

  let exitCode: number;
  try {
    exitCode = shim.start(instance as unknown as Parameters<WASI["start"]>[0]);
  } catch (e) {
    if (stdout.over) return failed(tooMuchOutput());
    return failed(`failed: ${message(e)}; nothing was written`);
  }
  if (stdout.over) return failed(tooMuchOutput());
  return {
    ok: true,
    exitCode,
    stdout: stdout.bytes(),
    stderr: stderr.bytes(),
    stderrTruncated: stderr.over,
  };
}

export function memoryOver(bytes: number, cap: number): string {
  return `its memory (${bytes} bytes) is over the ${cap}-byte limit; nothing was written`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
