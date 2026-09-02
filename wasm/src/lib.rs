//! The Comline playground's compile core — the same `comline-core` +
//! `comline-codegen` the CLI uses and the same analysis the language server
//! uses, behind a small `wasm-bindgen` surface.
//!
//! Multi-file: the editor holds a set of virtual schema files. A file's name
//! (minus a schema extension, split on `/`) is its namespace, so `use
//! other::Thing` resolves *across* files the same way `comline build` resolves
//! it inside a package.
//!
//! - [`compile_project`]  — parse + freeze every file with cross-file `use`
//!   resolution, then per-file diagnostics (parse errors + `comline-core`
//!   validation) and per-file IR.
//! - [`generate_project`] — the whole set's frozen IR → generated files.
//! - [`describe_project`] — the frozen IR as a machine-readable protocol
//!   description (namespace, `ir_hash`, functions, errors, types) for the
//!   simulation to drive.
//! - [`semantic_tokens`] / [`hover`] / [`completions`] — the LSP handlers, run
//!   against the active file, so highlighting / hover / autocomplete match
//!   `comline-lsp`.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use comline_core::package::config::ir::interpreter::ProjectInterpreter;
use comline_core::schema::idl::grammar::Declaration;
use comline_core::schema::ir::compiler::interpreted::kind_search::{KindValue, Primitive};
use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
use comline_core::schema::ir::context::SchemaContext;
use comline_core::schema::ir::frozen::schema_ir_hash;
use comline_core::schema::ir::frozen::unit::FrozenUnit;
use comline_core::schema::ir::validation::{self, ValidationError};
use comline_core::utils::codemap::CodeMap;

use comline_codegen::{GenRequest, Mode, PackageMeta};

use comline_language_server::analysis::diagnostics::generate_diagnostics;
use comline_language_server::handlers::{completion, hover as hover_h, semantic_tokens};
use comline_language_server::parser;
use comline_language_server::util::byte_range_to_lsp_range;

use lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range, Url};

/// Minimal package config — enough for `ProjectInterpreter` to hand back a
/// `ProjectContext` we can push schema contexts onto. Generation targets are
/// chosen in the UI, not here.
const CONGREGATION: &str = "congregation playground\nspecification_version = 1\n";

/// Schema file extension (`comline-core`'s `SCHEMA_EXTENSION`), stripped when
/// turning a virtual file name into a namespace.
const SCHEMA_EXT: &str = ".ids";

fn uri() -> Url {
    Url::parse("file:///playground.ids").expect("static uri")
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

// ── multi-file compile ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct FileInput {
    /// Virtual file name, e.g. `chat.ids`. Its stem, split on `/`, is the
    /// namespace `use` statements in other files resolve against.
    path: String,
    source: String,
}

#[derive(Serialize)]
struct FileReport {
    path: String,
    /// `::`-joined namespace derived from `path`.
    namespace: String,
    ok: bool,
    /// `lsp-types` diagnostics (line/character ranges) for this file.
    diagnostics: Vec<Diagnostic>,
    /// Debug rendering of this file's frozen units — `None` while it does not
    /// parse.
    ir: Option<String>,
    units: usize,
}

#[derive(Serialize)]
struct CompileProjectResult {
    files: Vec<FileReport>,
}

/// Parse and freeze every file as one package: cross-file `use` resolves, and
/// each file gets its own diagnostics and IR. `files` is `[{ path, source }]`.
#[wasm_bindgen]
pub fn compile_project(files: JsValue) -> JsValue {
    let files: Vec<FileInput> = match serde_wasm_bindgen::from_value(files) {
        Ok(f) => f,
        Err(e) => {
            return to_js(&CompileProjectResult {
                files: vec![FileReport {
                    path: "<input>".into(),
                    namespace: String::new(),
                    ok: false,
                    diagnostics: vec![plain_error(format!("bad file list: {e}"))],
                    ir: None,
                    units: 0,
                }],
            })
        }
    };
    to_js(&interpret_project(&files).0)
}

#[derive(Serialize)]
struct GeneratedFile {
    path: String,
    contents: String,
}

#[derive(Serialize)]
struct GenerateResult {
    files: Vec<GeneratedFile>,
    error: Option<String>,
}

/// Freeze the whole file set and run a target generator over it. `target` is
/// `"rust"` / `"typescript"`; `mode` is `"code"` or `"lib"`.
#[wasm_bindgen]
pub fn generate_project(files: JsValue, target: &str, mode: &str) -> JsValue {
    let files: Vec<FileInput> = match serde_wasm_bindgen::from_value(files) {
        Ok(f) => f,
        Err(e) => {
            return to_js(&GenerateResult {
                files: vec![],
                error: Some(format!("bad file list: {e}")),
            })
        }
    };

    let schemas = interpret_project(&files).1;
    if schemas.is_empty() {
        return to_js(&GenerateResult {
            files: vec![],
            error: Some("no schema parses".to_string()),
        });
    }

    let mode = match mode {
        "lib" => Mode::Lib,
        _ => Mode::Code,
    };
    let req = GenRequest {
        mode,
        schemas: &schemas,
        package: PackageMeta {
            name: "playground".to_string(),
            version: "0.1.0".to_string(),
        },
        default_framing: None,
    };

    let generated = match target {
        "rust" | "rs" => comline_codegen_rust::generate_rust(&req),
        "typescript" | "ts" => comline_codegen_typescript::generate_typescript(&req),
        other => {
            return to_js(&GenerateResult {
                files: vec![],
                error: Some(format!("unknown target `{other}`")),
            })
        }
    };

    to_js(&match generated {
        Ok(files) => GenerateResult {
            files: files
                .into_iter()
                .map(|f| GeneratedFile {
                    path: f.path.to_string_lossy().into_owned(),
                    contents: f.contents,
                })
                .collect(),
            error: None,
        },
        Err(e) => GenerateResult {
            files: vec![],
            error: Some(e.to_string()),
        },
    })
}

/// The shared pipeline behind [`compile_project`] and [`generate_project`]:
/// build a `ProjectContext` from the cleanly-parsing files, then interpret each
/// one with full project context (so `use` across files resolves) and validate
/// it.
///
/// Returns the per-file reports and, separately, `(namespace-path, units)` for
/// every file that froze — the shape `comline-codegen` wants.
fn interpret_project(
    files: &[FileInput],
) -> (CompileProjectResult, Vec<(String, Vec<FrozenUnit>)>) {
    let mut context =
        ProjectInterpreter::from_config_source(CONGREGATION).expect("static congregation parses");

    struct Parsed {
        segments: Vec<String>,
        decls: Option<Vec<rust_sitter::Spanned<Declaration>>>,
        parse_diags: Vec<Diagnostic>,
    }

    // First pass: parse everything, register the good ones on the context so
    // later files' `use` statements can see them.
    let mut parsed: Vec<Parsed> = Vec::with_capacity(files.len());
    for f in files {
        let segments = namespace_segments(&f.path);
        let pr = parser::parse(&f.source).expect("parser never errors internally");
        let parse_diags = generate_diagnostics(&f.source, &pr.errors);
        let decls = pr.document.map(|d| d.0);

        if let Some(decls) = &decls {
            context.schema_contexts.push(Rc::new(RefCell::new(
                SchemaContext::with_declarations(decls.clone(), segments.clone(), CodeMap::new()),
            )));
        }
        parsed.push(Parsed { segments, decls, parse_diags });
    }

    // Second pass: interpret + validate each file against the whole context.
    let mut reports = Vec::with_capacity(files.len());
    let mut schemas = Vec::new();
    for (f, p) in files.iter().zip(parsed) {
        let namespace = p.segments.join("::");

        let Some(decls) = p.decls else {
            reports.push(FileReport {
                path: f.path.clone(),
                namespace,
                ok: false,
                diagnostics: p.parse_diags,
                ir: None,
                units: 0,
            });
            continue;
        };

        let mut units =
            IncrementalInterpreter::from_declarations_with_context(decls, &p.segments, &context);
        // Match `comline build`: a leading `Namespace` unit before validation.
        units.insert(0, FrozenUnit::Namespace(namespace.clone()));

        let diagnostics = match validation::validate(&units) {
            Ok(()) => Vec::new(),
            Err(errors) => errors
                .into_iter()
                .map(|e| validation_diagnostic(&f.source, e))
                .collect(),
        };

        reports.push(FileReport {
            path: f.path.clone(),
            namespace,
            ok: diagnostics.is_empty(),
            diagnostics,
            ir: Some(format!("{units:#?}")),
            units: units.len(),
        });
        schemas.push((p.segments.join("/"), units));
    }

    (CompileProjectResult { files: reports }, schemas)
}

/// `chat.ids` → `["chat"]`, `wire/frame.ids` → `["wire", "frame"]`. Falls back
/// to `["main"]` for an empty or extension-only name.
fn namespace_segments(path: &str) -> Vec<String> {
    let stem = path.strip_suffix(SCHEMA_EXT).unwrap_or(path);
    let segments: Vec<String> = stem
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if segments.is_empty() {
        vec!["main".to_string()]
    } else {
        segments
    }
}

fn validation_diagnostic(source: &str, error: ValidationError) -> Diagnostic {
    let range = error
        .span
        .map(|(start, end)| byte_range_to_lsp_range(source, start, end))
        .unwrap_or_default();
    let message = if error.context.is_empty() {
        error.message
    } else {
        format!("{} — {}", error.message, error.context)
    };
    Diagnostic {
        range,
        severity: Some(DiagnosticSeverity::ERROR),
        source: Some("comline".to_string()),
        message,
        ..Default::default()
    }
}

fn plain_error(message: String) -> Diagnostic {
    Diagnostic {
        range: Range::default(),
        severity: Some(DiagnosticSeverity::ERROR),
        source: Some("comline".to_string()),
        message,
        ..Default::default()
    }
}

// ── protocol description (drives the simulation) ─────────────────────────

#[derive(Serialize)]
struct ProjectShape {
    schemas: Vec<SchemaShape>,
}

#[derive(Serialize)]
struct SchemaShape {
    /// `::`-joined, e.g. `chat` or `wire::frame`.
    namespace: String,
    /// `comline-core`'s `schema_ir_hash` as `0x`-prefixed 16 hex digits — the
    /// value the generators emit as `IR_HASH`, so a sim connection's handshake
    /// mirrors a real one.
    ir_hash: String,
    protocols: Vec<ProtocolShape>,
    errors: Vec<ErrorShape>,
    /// Every struct / enum in the schema, so the call form can render nested
    /// inputs.
    types: Vec<TypeDef>,
}

#[derive(Serialize)]
struct ProtocolShape {
    name: String,
    /// `"datagram"` | `"jsonrpc"` — from the protocol's `@framing`, else the
    /// datagram default.
    framing: String,
    functions: Vec<FnShape>,
}

#[derive(Serialize)]
struct FnShape {
    name: String,
    /// 0-based position in the protocol — the `Call` id `resolveKind` matches.
    index: u32,
    /// No `_return` at all — a fire-and-forget `notify`, not `Some(Unit)`.
    oneway: bool,
    args: Vec<ArgShape>,
    returns: Option<TypeRef>,
    throws: Vec<ThrowShape>,
}

#[derive(Serialize)]
struct ArgShape {
    name: String,
    ty: TypeRef,
}

#[derive(Serialize)]
struct ThrowShape {
    ordinal: u16,
    /// The error's name, or `"<unresolved>"` for a bare `throws` slot.
    name: String,
}

#[derive(Serialize)]
struct ErrorShape {
    ordinal: u16,
    name: String,
    message: String,
    fields: Vec<FieldShape>,
}

#[derive(Serialize)]
struct FieldShape {
    name: String,
    ty: TypeRef,
    optional: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TypeDef {
    Struct { name: String, fields: Vec<FieldShape> },
    Enum { name: String, variants: Vec<String> },
}

/// A type reference in a signature. Frozen function args / returns / fields are
/// almost always `KindValue::Namespaced(<string>, None)`; this classifies that
/// string (`u64`, `Message`, `Message[]`, …) into a shape the UI can render.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TypeRef {
    Prim { name: String },
    Ref { name: String },
    Array { of: Box<TypeRef> },
    Unit,
    Union { of: Vec<TypeRef> },
}

/// Parse and freeze every file, then describe each frozen schema's protocols,
/// errors and types. `files` is `[{ path, source }]`.
#[wasm_bindgen]
pub fn describe_project(files: JsValue) -> JsValue {
    let files: Vec<FileInput> = match serde_wasm_bindgen::from_value(files) {
        Ok(f) => f,
        Err(_) => return to_js(&ProjectShape { schemas: vec![] }),
    };
    let frozen = interpret_project(&files).1;

    // Struct / enum names across the whole project, so a cross-file type
    // reference still classifies as `ref` (not an opaque scalar).
    let known: HashSet<&str> = frozen
        .iter()
        .flat_map(|(_, units)| units.iter())
        .filter_map(|u| match u {
            FrozenUnit::Struct { name, .. } | FrozenUnit::Enum { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();

    let schemas = frozen
        .iter()
        .map(|(ns_path, units)| describe_schema(ns_path, units, &known))
        .collect();
    to_js(&ProjectShape { schemas })
}

fn describe_schema(ns_path: &str, units: &[FrozenUnit], known: &HashSet<&str>) -> SchemaShape {
    let errors: Vec<ErrorShape> = units
        .iter()
        .filter_map(|u| match u {
            FrozenUnit::Error { ordinal, name, message, fields, .. } => Some(ErrorShape {
                ordinal: *ordinal,
                name: name.clone(),
                message: message.clone(),
                fields: fields.iter().filter_map(|f| field_shape(f, known)).collect(),
            }),
            _ => None,
        })
        .collect();

    let types = units
        .iter()
        .filter_map(|u| match u {
            FrozenUnit::Struct { name, fields, .. } => Some(TypeDef::Struct {
                name: name.clone(),
                fields: fields.iter().filter_map(|f| field_shape(f, known)).collect(),
            }),
            FrozenUnit::Enum { name, variants, .. } => Some(TypeDef::Enum {
                name: name.clone(),
                variants: variants.iter().filter_map(enum_variant_name).collect(),
            }),
            _ => None,
        })
        .collect();

    let protocols = units
        .iter()
        .filter_map(|u| match u {
            FrozenUnit::Protocol { name, parameters, functions, .. } => Some(ProtocolShape {
                name: name.clone(),
                framing: framing_of(parameters),
                functions: functions
                    .iter()
                    .enumerate()
                    .filter_map(|(i, fu)| fn_shape(i as u32, fu, &errors, known))
                    .collect(),
            }),
            _ => None,
        })
        .collect();

    SchemaShape {
        namespace: ns_path.replace('/', "::"),
        ir_hash: format!("{:#018x}", schema_ir_hash(units)),
        protocols,
        errors,
        types,
    }
}

fn framing_of(params: &[FrozenUnit]) -> String {
    for p in params {
        if let FrozenUnit::Property { name, expression } = p {
            if name == "framing" {
                return match expression.as_deref() {
                    Some("jsonrpc") | Some("jsonrpc-2.0") => "jsonrpc".to_string(),
                    _ => "datagram".to_string(),
                };
            }
        }
    }
    "datagram".to_string()
}

fn field_shape(u: &FrozenUnit, known: &HashSet<&str>) -> Option<FieldShape> {
    match u {
        FrozenUnit::Field { name, kind_value, optional, .. } => Some(FieldShape {
            name: name.clone(),
            ty: type_ref(kind_value, known),
            optional: *optional,
        }),
        _ => None,
    }
}

fn enum_variant_name(u: &FrozenUnit) -> Option<String> {
    match u {
        FrozenUnit::EnumVariant(kv, _) => Some(match kv {
            KindValue::EnumVariant(n, _) | KindValue::Namespaced(n, _) => n.clone(),
            KindValue::Primitive(p) => prim_name(p),
            _ => "?".to_string(),
        }),
        _ => None,
    }
}

fn fn_shape(index: u32, u: &FrozenUnit, errors: &[ErrorShape], known: &HashSet<&str>) -> Option<FnShape> {
    match u {
        FrozenUnit::Function { name, arguments, _return, throws, .. } => Some(FnShape {
            name: name.clone(),
            index,
            oneway: _return.is_none(),
            args: arguments
                .iter()
                .map(|a| ArgShape { name: a.name.clone(), ty: type_ref(&a.kind, known) })
                .collect(),
            returns: _return.as_ref().map(|k| type_ref(k, known)),
            throws: throws
                .iter()
                .map(|ord| ThrowShape {
                    ordinal: *ord,
                    name: errors
                        .iter()
                        .find(|e| e.ordinal == *ord)
                        .map(|e| e.name.clone())
                        .unwrap_or_else(|| "<unresolved>".to_string()),
                })
                .collect(),
        }),
        _ => None,
    }
}

fn type_ref(kind: &KindValue, known: &HashSet<&str>) -> TypeRef {
    match kind {
        KindValue::Unit => TypeRef::Unit,
        KindValue::Union(members) => TypeRef::Union {
            of: members.iter().map(|m| type_ref(m, known)).collect(),
        },
        KindValue::Primitive(p) => TypeRef::Prim { name: prim_name(p) },
        KindValue::EnumVariant(n, _) | KindValue::Namespaced(n, _) => name_ref(n, known),
    }
}

/// A frozen signature type is a plain string: `u64`, `Message`, `Message[]`.
/// The only distinction the UI needs is "a type declared in this project"
/// (render its fields) vs. "anything else" (one scalar input) — and the
/// grammar reserves the primitive keywords, so a declared name can never
/// collide with `u64` / `string` / …. That makes `known` (built from the IR)
/// the single source of truth; there is no primitive-name list to keep in
/// sync with `comline-core`.
fn name_ref(n: &str, known: &HashSet<&str>) -> TypeRef {
    match n.strip_suffix("[]") {
        Some(elem) => TypeRef::Array { of: Box::new(name_ref(elem, known)) },
        None if known.contains(n) => TypeRef::Ref { name: n.to_string() },
        None => TypeRef::Prim { name: n.to_string() },
    }
}

fn prim_name(p: &Primitive) -> String {
    // strum's `Name` prop is empty for `String` / `Namespaced`.
    match p.name() {
        "" => "string".to_string(),
        n => n.to_string(),
    }
}

// ── per-file editor services (LSP handlers) ──────────────────────────────

#[wasm_bindgen]
pub fn semantic_tokens(source: &str) -> JsValue {
    to_js(&semantic_tokens::get_semantic_tokens(source, &uri()))
}

#[wasm_bindgen]
pub fn hover(source: &str, line: u32, character: u32) -> JsValue {
    to_js(&hover_h::get_hover_info(
        source,
        &uri(),
        Position { line, character },
    ))
}

#[wasm_bindgen]
pub fn completions(source: &str, line: u32, character: u32) -> JsValue {
    to_js(&completion::get_completions(
        source,
        &uri(),
        Position { line, character },
    ))
}

fn to_js<T: Serialize>(value: &T) -> JsValue {
    serde_wasm_bindgen::to_value(value).unwrap_or(JsValue::NULL)
}
