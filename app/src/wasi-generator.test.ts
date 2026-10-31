/// An external generator run through the WASI shim answers exactly as the
/// linked one does: comline-rust's `comline-gen-rust`, built for
/// `wasm32-wasip1` from the rev the editor wasm links, over every example, in
/// both modes, byte for byte. And one that misbehaves is stopped or refused
/// as the CLI stops or refuses it: the hostile generator
/// (`fixtures/generators`), whose misbehaviour is its name.
///
/// Both are built in CI (see `.github/workflows/deploy.yml`) and found
/// through `COMLINE_GEN_RUST_WASM` and `HOSTILE_GENERATOR_WASM`. Locally,
/// build `comline-gen-rust` with `cargo build -p comline-codegen-rust --bin
/// comline-gen-rust --target wasm32-wasip1 --release` in a comline-rust
/// checkout at that rev, and the hostile one with `cargo build --release
/// --target wasm32-wasip1` in `fixtures/generators`, and point the variables
/// at the `.wasm`s; without them those tests are skipped.
///
/// Every call runs in a Node worker thread running the same guest code as
/// the browser's worker, terminated the same way.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import examples from "comline-examples";

import initEditor, { decode_response, encode_describe, generate_project } from "./wasm/comline_playground_wasm.js";
import {
  generateWithWasiGenerator,
  limitMemory,
  prepareGenerator,
  runWasiGenerator,
  STDERR_CAP,
  type GuestWorker,
  type RunOptions,
} from "./wasi-generator.ts";
import type { GuestResult } from "./wasi-generator-guest.ts";

await initEditor(
  readFileSync(fileURLToPath(new URL("./wasm/comline_playground_wasm_bg.wasm", import.meta.url))),
);

const tsxApi = import.meta.resolve("tsx/esm/api");
const workerEntry = new URL("./wasi-generator.node-worker.ts", import.meta.url).href;

/// A Node worker thread running `runGuest`, as the browser's worker does.
function nodeWorker(): GuestWorker {
  // Through tsx's API: Node doesn't load a `.ts` worker entry by itself.
  const worker = new Worker(
    `import(${JSON.stringify(tsxApi)}).then((tsx) => tsx.tsImport(${JSON.stringify(workerEntry)}, ${JSON.stringify(workerEntry)}));`,
    { eval: true, execArgv: [] },
  );
  return {
    run: (call) =>
      new Promise<GuestResult>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.postMessage(call);
      }),
    terminate: () => void worker.terminate(),
  };
}

const run: RunOptions = { worker: nodeWorker };

interface Example {
  id: string;
  files: { name: string; source: string }[];
}

function wasmFrom(variable: string): { skip: string | false; bytes: Uint8Array | null } {
  const path = process.env[variable];
  // CI builds the generators, so there it's never skipped.
  if (process.env.CI && !path) throw new Error(`${variable} isn't set in CI`);
  return path ? { skip: false, bytes: readFileSync(path) } : { skip: `${variable} isn't set`, bytes: null };
}

const real = wasmFrom("COMLINE_GEN_RUST_WASM");
const hostile = wasmFrom("HOSTILE_GENERATOR_WASM");
const generator = real.bytes ? await prepareGenerator(real.bytes) : null;

const schema = [{ path: "chat.ids", source: "struct S {\n    a: u8\n}\n" }];

for (const ex of examples as Example[]) {
  for (const mode of ["code", "lib"]) {
    test(`example "${ex.id}" (${mode}): the WASI generator matches the linked one`, { skip: real.skip }, async () => {
      const files = ex.files.map((f) => ({ path: f.name, source: f.source }));
      const linked = generate_project(files, "rust", mode);
      assert.ok(!linked.error, linked.error);
      assert.ok(linked.files.length > 0);
      const external = await generateWithWasiGenerator(generator!, files, "rust", mode, run);
      assert.deepEqual(external, linked);
    });
  }
}

/// A module that defines `pages` pages of memory, exports it, and (with
/// `start`) has an empty `_start`: it writes nothing.
function module(pages: number, start = true): Uint8Array<ArrayBuffer> {
  const exports = start
    ? [0x07, 0x13, 0x02, 0x06, ...ascii("memory"), 0x02, 0x00, 0x06, ...ascii("_start"), 0x00, 0x00]
    : [0x07, 0x0a, 0x01, 0x06, ...ascii("memory"), 0x02, 0x00];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
    ...(start ? [0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01, 0x00] : []), // type () -> (), func 0
    0x05, 0x03, 0x01, 0x00, pages, // memory: `pages`, no maximum
    ...exports,
    ...(start ? [0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b] : []), // code: empty body
  ]);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

test("a response that isn't one is refused, with nothing generated", async () => {
  const result = await generateWithWasiGenerator(module(1), schema, "rust", "code", run);
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /^generator `generator.wasm` answered with something that isn't a protocol response/);
});

test("an empty stdin is answered with an error response, not a crash", { skip: real.skip }, async () => {
  const run_ = await runWasiGenerator(generator!, new Uint8Array(), run);
  assert.equal(run_.exitCode, 0);
  const result = decode_response(run_.stdout) as { files: unknown[]; error?: string };
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /^the generator: /);
});

test("the memory cap is the module's maximum, which the engine enforces on growth", () => {
  const page = 64 * 1024;
  const unlimited = new WebAssembly.Instance(new WebAssembly.Module(module(1, false))).exports
    .memory as WebAssembly.Memory;
  unlimited.grow(8);

  const limited = new WebAssembly.Instance(new WebAssembly.Module(limitMemory(module(1, false), 4 * page)))
    .exports.memory as WebAssembly.Memory;
  limited.grow(3);
  assert.equal(limited.buffer.byteLength, 4 * page);
  assert.throws(() => limited.grow(1), RangeError);
});

test("a module that starts with more memory than the cap is refused before it runs", async () => {
  const result = await generateWithWasiGenerator(module(5), schema, "rust", "code", {
    ...run,
    memoryCap: 4 * 64 * 1024,
  });
  assert.deepEqual(result.files, []);
  assert.equal(
    result.error,
    "generator `generator.wasm`: starts with 327680 bytes of memory, over the 262144-byte limit; nothing was written",
  );
});

/// The hostile generator, misbehaving as `mode`.
function asHostile(mode: string, options: RunOptions & { memoryCap?: number } = {}) {
  return generateWithWasiGenerator(hostile.bytes!, schema, "rust", "code", { ...run, name: mode, ...options });
}

test("a generator that never finishes is stopped at the time limit", { skip: hostile.skip }, async () => {
  const started = Date.now();
  const result = await asHostile("timeout", { timeoutMs: 500 });
  assert.ok(Date.now() - started < 10_000, "it was stopped");
  assert.deepEqual(result.files, []);
  assert.equal(result.error, "generator `timeout`: didn't finish within 0.5s and was stopped; nothing was written");
});

test("the time limit covers Describe too", { skip: hostile.skip }, async () => {
  const result = await asHostile("describe-timeout", { timeoutMs: 500 });
  assert.equal(
    result.error,
    "generator `describe-timeout`: didn't finish within 0.5s and was stopped; nothing was written",
  );
});

test("a generator that speaks another protocol is refused", { skip: hostile.skip }, async () => {
  const result = await asHostile("mismatch");
  assert.deepEqual(result.files, []);
  assert.equal(
    result.error,
    "generator `mismatch` speaks generator protocol 7, and this playground speaks protocol 0",
  );
});

test("a generator that doesn't offer the language is refused", { skip: hostile.skip }, async () => {
  const result = await asHostile("elsewhere");
  assert.deepEqual(result.files, []);
  assert.equal(result.error, "generator `elsewhere` doesn't generate `rust`; it offers `go`");
});

test("a generator whose floor is past the target's version is refused", { skip: hostile.skip }, async () => {
  const result = await asHostile("future");
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /^generator `future` handles `rust` from `9.0.0` on, not `\d+\.\d+\.\d+`$/);
});

test("a generator can't grow its memory past the cap", { skip: hostile.skip }, async () => {
  // 128 MiB fits under the default cap...
  const fits = await asHostile("memory");
  assert.ok(!fits.error, fits.error);
  // ...and not under a 64 MiB one: `memory.grow` fails inside the generator.
  const capped = await asHostile("memory", { memoryCap: 64 * 1024 * 1024 });
  assert.deepEqual(capped.files, []);
  assert.match(capped.error ?? "", /^the generator: couldn't reserve 128 MiB: /);
});

test("stderr is kept up to its cap, and the rest dropped", { skip: hostile.skip }, async () => {
  const result = await asHostile("stderr");
  assert.deepEqual(result.files, []);
  assert.equal(result.error, "the generator: refusing after the noise");
  const stderr = result.stderr ?? "";
  assert.ok(stderr.startsWith("hello from the generator\n"));
  assert.ok(stderr.endsWith(`\n... (stderr past ${STDERR_CAP} bytes not shown)\n`), stderr.slice(-80));
  assert.equal(stderr.length, STDERR_CAP + `\n... (stderr past ${STDERR_CAP} bytes not shown)\n`.length);
});

test("a response with a bad path is refused whole", { skip: hostile.skip }, async () => {
  const result = await asHostile("dotdot");
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /`\.\.\/escape\.rs`.*nothing was written/);
});

test("a well-behaved generator's files come through", { skip: hostile.skip }, async () => {
  const result = await asHostile("fine");
  assert.ok(!result.error, result.error);
  assert.ok(!("stderr" in result));
  assert.deepEqual(result.files, [{ path: "api.rs", contents: "// fine" }]);
});

test("the Describe request is what the generator reads first", () => {
  assert.ok(encode_describe().length > 0);
});
