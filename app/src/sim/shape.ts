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
