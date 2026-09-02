/// A form built from a function's `ArgShape[]` (or any single `TypeRef`): a
/// typed input per primitive, a fieldset per struct, a select per enum, and a
/// raw-JSON textarea for arrays / unions / anything unresolved. A top-level
/// toggle swaps the whole thing for one JSON textarea — the always-available
/// escape hatch.

import type { ArgShape, FieldShape, SchemaShape, TypeRef } from "../shape.ts";
import { typeLabel } from "../shape.ts";

export interface ArgsForm {
  el: HTMLElement;
  /** The current params object. Throws `Error` with a readable message on a
   *  malformed raw-JSON field. */
  read(): unknown;
}

/** A form for a whole parameter list (`{ [argName]: value }`). */
export function argsForm(args: ArgShape[], schema: SchemaShape, initial?: unknown): ArgsForm {
  return objectForm(
    args.map((a) => ({ name: a.name, ty: a.ty, optional: false })),
    schema,
    initial,
  );
}

/** A form for a struct-shaped value (`{ [fieldName]: value }`), with the
 *  raw-JSON toggle. */
export function objectForm(
  fields: FieldShape[],
  schema: SchemaShape,
  initial?: unknown,
): ArgsForm {
  const el = document.createElement("div");
  el.className = "args";

  const bar = document.createElement("label");
  bar.className = "args-raw-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  bar.append(cb, document.createTextNode(" raw JSON"));

  const body = document.createElement("div");
  body.className = "args-body";

  const raw = document.createElement("textarea");
  raw.className = "args-json mono";
  raw.rows = Math.max(3, fields.length + 1);
  raw.spellcheck = false;
  raw.hidden = true;

  el.append(bar, body, raw);

  const rows = fields.map((f) => fieldRow(f, schema, (initial as Record<string, unknown>)?.[f.name]));
  for (const r of rows) body.append(r.el);

  const currentObject = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.name] = r.read();
    return out;
  };

  cb.addEventListener("change", () => {
    if (cb.checked) {
      raw.value = JSON.stringify(currentObject(), null, 2);
      raw.hidden = false;
      body.hidden = true;
    } else {
      body.hidden = false;
      raw.hidden = true;
    }
  });

  return {
    el,
    read() {
      if (cb.checked) return parseJson(raw.value, "params");
      return currentObject();
    },
  };
}

interface Row {
  el: HTMLElement;
  name: string;
  read(): unknown;
}

function fieldRow(field: FieldShape, schema: SchemaShape, initial: unknown): Row {
  const el = document.createElement("div");
  el.className = "arg-row";
  const label = document.createElement("label");
  label.className = "arg-label";
  label.textContent = field.name;
  const type = document.createElement("span");
  type.className = "arg-type mono";
  type.textContent = typeLabel(field.ty);
  label.append(type);
  el.append(label);

  const input = inputFor(field.ty, schema, initial);
  el.append(input.el);
  return { el, name: field.name, read: input.read };
}

function inputFor(ty: TypeRef, schema: SchemaShape, initial: unknown): { el: HTMLElement; read(): unknown } {
  switch (ty.kind) {
    case "prim": {
      if (ty.name === "bool") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = initial === true;
        return { el: cb, read: () => cb.checked };
      }
      const numeric = /^[us](8|16|32|64|128)$/.test(ty.name) || /^f(32|64)$|^float$/.test(ty.name);
      const inp = document.createElement("input");
      inp.className = "arg-input";
      if (numeric) {
        inp.type = "number";
        if (typeof initial === "number") inp.value = String(initial);
        return { el: inp, read: () => (inp.value === "" ? 0 : Number(inp.value)) };
      }
      inp.type = "text";
      if (typeof initial === "string") inp.value = initial;
      return { el: inp, read: () => inp.value };
    }

    case "ref": {
      const def = schema.types.find((t) => t.name === ty.name);
      if (def?.kind === "enum") {
        const sel = document.createElement("select");
        sel.className = "arg-input";
        for (const v of def.variants) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = v;
          sel.append(o);
        }
        if (typeof initial === "string") sel.value = initial;
        return { el: sel, read: () => sel.value };
      }
      if (def?.kind === "struct") {
        const fs = document.createElement("fieldset");
        fs.className = "arg-struct";
        const nested = def.fields.map((f) =>
          fieldRow(f, schema, (initial as Record<string, unknown>)?.[f.name]),
        );
        for (const n of nested) fs.append(n.el);
        return {
          el: fs,
          read: () => {
            const out: Record<string, unknown> = {};
            for (const n of nested) out[n.name] = n.read();
            return out;
          },
        };
      }
      return jsonInput(ty, initial);
    }

    // arrays, unions and unresolved names — one JSON field
    default:
      return jsonInput(ty, initial);
  }
}

function jsonInput(ty: TypeRef, initial: unknown): { el: HTMLElement; read(): unknown } {
  const ta = document.createElement("textarea");
  ta.className = "arg-input mono";
  ta.rows = 2;
  ta.spellcheck = false;
  ta.value = initial === undefined ? (ty.kind === "array" ? "[]" : "null") : JSON.stringify(initial);
  return { el: ta, read: () => parseJson(ta.value, typeLabel(ty)) };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text || "null");
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}
