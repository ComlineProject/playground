/// The canned server behaviours a simulated instance can run for one function.
/// Each is a spec — a label, when it applies, a default config, and a factory
/// that closes over the config to produce a runnable `Behavior`.

import type { Behavior, SimOutcome } from "./generic.ts";
import type { FnShape, SchemaShape } from "./shape.ts";
import { zeroValue } from "./shape.ts";

export type BehaviorKind = "reply" | "echo" | "increment" | "delay" | "raise" | "drop";

export interface BehaviorSpec {
  kind: BehaviorKind;
  label: string;
  /** Whether this behaviour makes sense for `fn` (e.g. `raise` needs throws). */
  appliesTo(fn: FnShape): boolean;
  /** A starting config for `fn`, seeded from its return / error types. */
  defaultConfig(fn: FnShape, schema: SchemaShape): Record<string, unknown>;
  /** Build the runnable behaviour. */
  make(config: Record<string, unknown>, fn: FnShape, schema: SchemaShape): Behavior;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `ok` for a normal function, `none` for a one-way one. */
function okOrNone(fn: FnShape, value: unknown): SimOutcome {
  return fn.oneway ? { kind: "none" } : { kind: "ok", value };
}

function getAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}
function setAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let cur = obj;
  for (const k of keys) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[last] = value;
}
/** The first `prim` numeric field path in a struct return, for `increment`. */
function firstNumericPath(fn: FnShape, schema: SchemaShape): string | undefined {
  const ret = fn.returns;
  if (ret?.kind !== "ref") return undefined;
  const def = schema.types.find((t) => t.name === ret.name);
  if (def?.kind !== "struct") return undefined;
  const num = def.fields.find(
    (f) => f.ty.kind === "prim" && /^[us](8|16|32|64|128)$|^f(32|64)$|^float$/.test(f.ty.name),
  );
  return num?.name;
}

export const BEHAVIORS: Record<BehaviorKind, BehaviorSpec> = {
  reply: {
    kind: "reply",
    label: "Reply with value",
    appliesTo: () => true,
    defaultConfig: (fn, schema) => ({
      value: fn.returns ? zeroValue(fn.returns, schema.types) : null,
    }),
    make: (config, fn) => ({
      run: () => okOrNone(fn, config.value ?? null),
    }),
  },

  echo: {
    kind: "echo",
    label: "Echo params",
    appliesTo: () => true,
    defaultConfig: () => ({}),
    make: (_config, fn) => ({
      run: (ctx) => okOrNone(fn, ctx.params),
    }),
  },

  increment: {
    kind: "increment",
    label: "Increment field",
    appliesTo: (fn) => !fn.oneway && fn.returns?.kind === "ref",
    defaultConfig: (fn, schema) => ({
      base: fn.returns ? zeroValue(fn.returns, schema.types) : {},
      path: firstNumericPath(fn, schema) ?? "",
    }),
    make: (config, fn) => {
      const path = String(config.path ?? "");
      let current: Record<string, unknown> | null = null;
      return {
        run: () => {
          current ??= structuredClone(config.base ?? {}) as Record<string, unknown>;
          if (path) {
            const n = getAt(current, path);
            setAt(current, path, (typeof n === "number" ? n : 0) + 1);
          }
          return okOrNone(fn, structuredClone(current));
        },
      };
    },
  },

  delay: {
    kind: "delay",
    label: "Delay then reply",
    appliesTo: () => true,
    defaultConfig: (fn, schema) => ({
      ms: 400,
      value: fn.returns ? zeroValue(fn.returns, schema.types) : null,
    }),
    make: (config, fn) => ({
      run: async () => {
        await sleep(Number(config.ms) || 0);
        return okOrNone(fn, config.value ?? null);
      },
    }),
  },

  raise: {
    kind: "raise",
    label: "Raise error",
    appliesTo: (fn) => fn.throws.length > 0,
    defaultConfig: (fn, schema) => {
      const first = fn.throws[0];
      const err = schema.errors.find((e) => e.ordinal === first?.ordinal);
      const data: Record<string, unknown> = {};
      for (const f of err?.fields ?? []) data[f.name] = zeroValue(f.ty, schema.types);
      return { ordinal: first?.ordinal ?? 0, data };
    },
    make: (config) => ({
      run: () => ({
        kind: "err",
        ordinal: Number(config.ordinal) || 0,
        data: config.data ?? null,
      }),
    }),
  },

  drop: {
    kind: "drop",
    label: "Drop (never reply)",
    appliesTo: () => true,
    defaultConfig: () => ({}),
    // Never settles — the client's `call` stays pending, like a hung peer.
    // The promise is released when the connection is closed and discarded.
    make: () => ({ run: () => new Promise<SimOutcome>(() => {}) }),
  },
};

/** The behaviour a freshly-added server function starts on. */
export function defaultKindFor(fn: FnShape): BehaviorKind {
  return fn.oneway ? "drop" : "reply";
}

export const BEHAVIOR_KINDS = Object.keys(BEHAVIORS) as BehaviorKind[];
