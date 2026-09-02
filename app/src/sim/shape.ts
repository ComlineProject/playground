/// The shape of a compiled project as the simulator sees it — a 1:1 mirror of
/// the WASM `describe_project` output. Everything here is derived from the
/// frozen IR; nothing is re-implemented.

export interface ProjectShape {
  schemas: SchemaShape[];
}

export interface SchemaShape {
  /** `::`-joined, e.g. `chat` or `wire::frame`. */
  namespace: string;
  /** `0x`-prefixed 16 hex digits — the value the generators emit as `IR_HASH`. */
  ir_hash: string;
  protocols: ProtocolShape[];
  errors: ErrorShape[];
  /** Every struct / enum in the schema, for the call form's nested inputs. */
  types: TypeDef[];
}

export interface ProtocolShape {
  name: string;
  framing: "datagram" | "jsonrpc";
  functions: FnShape[];
}

export interface FnShape {
  name: string;
  /** 0-based position in the protocol — the `Call` id `resolveKind` matches. */
  index: number;
  /** No return at all — a fire-and-forget `notify`. */
  oneway: boolean;
  args: ArgShape[];
  returns: TypeRef | null;
  throws: ThrowShape[];
}

export interface ArgShape {
  name: string;
  ty: TypeRef;
}

export interface ThrowShape {
  ordinal: number;
  /** The error's name, or `"<unresolved>"` for a bare `throws` slot. */
  name: string;
}

export interface ErrorShape {
  ordinal: number;
  name: string;
  message: string;
  fields: FieldShape[];
}

export interface FieldShape {
  name: string;
  ty: TypeRef;
  optional: boolean;
}

export type TypeDef =
  | { kind: "struct"; name: string; fields: FieldShape[] }
  | { kind: "enum"; name: string; variants: string[] };

export type TypeRef =
  | { kind: "prim"; name: string }
  | { kind: "ref"; name: string }
  | { kind: "array"; of: TypeRef }
  | { kind: "unit" }
  | { kind: "union"; of: TypeRef[] };

// ── helpers ─────────────────────────────────────────────────────────────

/** The protocol named `name` in schema `ns`, or `undefined`. */
export function findProtocol(
  shape: ProjectShape,
  ns: string,
  name: string,
): { schema: SchemaShape; protocol: ProtocolShape } | undefined {
  const schema = shape.schemas.find((s) => s.namespace === ns);
  const protocol = schema?.protocols.find((p) => p.name === name);
  return schema && protocol ? { schema, protocol } : undefined;
}

/** A short label for a `TypeRef` (`u64`, `Message[]`, `A | B`, `()`). */
export function typeLabel(ty: TypeRef): string {
  switch (ty.kind) {
    case "unit":
      return "()";
    case "prim":
    case "ref":
      return ty.name;
    case "array":
      return `${typeLabel(ty.of)}[]`;
    case "union":
      return ty.of.map(typeLabel).join(" | ");
  }
}

/** A zero value for `ty`, for seeding "reply with value" and the call form.
 *  `ref` types recurse through `types`; unknown / recursive → `null`. */
export function zeroValue(ty: TypeRef, types: TypeDef[], seen: string[] = []): unknown {
  switch (ty.kind) {
    case "unit":
      return null;
    case "array":
      return [];
    case "union":
      return ty.of.length ? zeroValue(ty.of[0], types, seen) : null;
    case "prim":
      return zeroPrim(ty.name);
    case "ref": {
      if (seen.includes(ty.name)) return null;
      const def = types.find((t) => t.name === ty.name);
      if (!def) return null;
      if (def.kind === "enum") return def.variants[0] ?? null;
      const obj: Record<string, unknown> = {};
      for (const f of def.fields) obj[f.name] = zeroValue(f.ty, types, [...seen, ty.name]);
      return obj;
    }
  }
}

function zeroPrim(name: string): unknown {
  if (name === "bool") return false;
  if (name === "string" || name === "str") return "";
  if (/^[us](8|16|32|64|128)$/.test(name) || name === "f32" || name === "f64" || name === "float") {
    return 0;
  }
  return null;
}
