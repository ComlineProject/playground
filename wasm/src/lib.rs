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

use comline_core::package::config::ir::frozen::FrozenUnit as ConfigUnit;
use comline_core::package::config::ir::interpreter::ProjectInterpreter;
use comline_core::schema::idl::annotations::{FramingValue, DEFAULT_FORMAT, DEFAULT_FRAMING};
use comline_core::schema::idl::grammar::Declaration;
use comline_core::schema::ir::frozen::types::TypeRef as FrozenType;
use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
use comline_core::schema::ir::context::SchemaContext;
use comline_core::schema::ir::frozen::schema_ir_hash;
use comline_core::schema::ir::frozen::unit::FrozenUnit;
use comline_core::schema::ir::validation;
use comline_core::utils::codemap::CodeMap;

use comline_codegen::protocol::{self, FileOut, Request, Response, TargetLanguage};
use comline_codegen::{GenerateRequest, Mode, PackageMeta};

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

/// A virtual file's own URI, for multi-file hover — the exact form doesn't
/// matter (hover never surfaces it back to the caller), it only needs to be
/// distinct per file.
fn file_uri(path: &str) -> Url {
    Url::parse(&format!("file:///{path}")).unwrap_or_else(|_| uri())
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
    let req = match generate_request(files, target, mode) {
        Ok(req) => req,
        Err(error) => return to_js(&GenerateResult { files: vec![], error: Some(error) }),
    };

    let generated = match req.target.language.as_str() {
        "rust" => comline_codegen_rust::generate_rust(&req),
        _ => comline_codegen_typescript::generate_typescript(&req),
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

#[derive(Serialize)]
struct EncodedRequest {
    /// The CBOR-encoded `Request`, for a generator's stdin. Absent on error.
    #[serde(with = "serde_bytes_opt")]
    request: Option<Vec<u8>>,
    error: Option<String>,
}

/// `Option<Vec<u8>>` as a `Uint8Array` (or `null`), not an array of numbers.
mod serde_bytes_opt {
    pub fn serialize<S: serde::Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => s.serialize_bytes(bytes),
            None => s.serialize_none(),
        }
    }
}

/// The request [`generate_project`] hands the linked generator, encoded for
/// an external one: a generator protocol `Request` as one CBOR document,
/// what a generator reads from stdin. `{ request: Uint8Array, error: null }`,
/// or `{ request: null, error }`.
#[wasm_bindgen]
pub fn encode_request(files: JsValue, target: &str, mode: &str) -> JsValue {
    let encoded = generate_request(files, target, mode)
        .and_then(|req| protocol::encode(&Request::generate(req)).map_err(|e| format!("the request doesn't encode: {e}")));
    to_js(&match encoded {
        Ok(request) => EncodedRequest { request: Some(request), error: None },
        Err(error) => EncodedRequest { request: None, error: Some(error) },
    })
}

/// The most generated file contents one response may carry, all files
/// together: the CLI's limit (`external::GENERATED_CAP`).
pub const GENERATED_CAP: usize = 256 * 1024 * 1024;

/// An external generator's stdout, decoded into what [`generate_project`]
/// returns: `{ files, error }`. Checked as the CLI checks it: an error
/// response, a description, a bad path or too much output is refused
/// whole, with nothing in `files`.
#[wasm_bindgen]
pub fn decode_response(bytes: &[u8]) -> JsValue {
    let result = match checked_files(bytes, GENERATED_CAP) {
        Ok(files) => GenerateResult {
            files: files
                .into_iter()
                .map(|f| GeneratedFile { contents: String::from_utf8_lossy(&f.contents).into_owned(), path: f.path })
                .collect(),
            error: None,
        },
        Err(error) => GenerateResult { files: vec![], error: Some(error) },
    };
    to_js(&result)
}

/// The files in an encoded response, after the CLI's checks
/// (`external::files`), with at most `cap` bytes of contents in all.
fn checked_files(bytes: &[u8], cap: usize) -> Result<Vec<FileOut>, String> {
    let who = "the generator";
    let generated = match protocol::decode::<Response>(bytes) {
        Ok(Response::Generate(generated)) => generated,
        Ok(Response::Error { message }) => return Err(format!("{who}: {message}")),
        Ok(Response::Describe(_)) => return Err(format!("{who} answered `Generate` with a description")),
        Err(e) => return Err(format!("{who}'s response doesn't decode: {e}")),
    };
    let mut total = 0usize;
    for file in &generated.files {
        check_path(&file.path).map_err(|why| {
            format!("{who} returned the path `{}`, which {why}; nothing was written", file.path.escape_debug())
        })?;
        total = total.saturating_add(file.contents.len());
    }
    if total > cap {
        return Err(format!("{who} generated {total} bytes, over the {cap}-byte limit; nothing was written"));
    }
    Ok(generated.files)
}

/// Why `path` can't be a generated file's path, if it can't: the CLI's rule
/// (`external::check_path`). It must be relative, `/`-separated and
/// normalized.
fn check_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() {
        return Err("is empty");
    }
    if path.contains('\0') {
        return Err("contains a NUL");
    }
    if path.contains('\\') {
        return Err("contains a `\\` (a generated path is `/`-separated)");
    }
    if path.starts_with('/') {
        return Err("is absolute");
    }
    for component in path.split('/') {
        match component {
            "" => return Err("has an empty component"),
            "." | ".." => return Err("isn't normalized (it has a `.` or `..` component)"),
            c if c.contains(':') => return Err("has a `:` (a drive or stream prefix on Windows)"),
            _ => {}
        }
    }
    Ok(())
}

/// The request for `target` and `mode` over the whole file set, with its
/// encodings filled the way `comline generate` fills them: the official
/// mappings, then what the playground's package declares (nothing: its
/// packages are in memory, and core refuses `encodings` there), with no
/// `comline.toml` overrides.
fn generate_request(files: JsValue, target: &str, mode: &str) -> Result<GenerateRequest, String> {
    let files: Vec<FileInput> = serde_wasm_bindgen::from_value(files).map_err(|e| format!("bad file list: {e}"))?;
    let (_, schemas, declared) = interpret_project(&files);
    if schemas.is_empty() {
        return Err("no schema parses".to_string());
    }

    let (language, version) = match target {
        "rust" | "rs" => ("rust", comline_codegen_rust::LANG_VERSION),
        "typescript" | "ts" => ("typescript", comline_codegen_typescript::LANG_VERSION),
        other => return Err(format!("unknown target `{other}`")),
    };
    let mode = match mode {
        "lib" => Mode::Lib,
        _ => Mode::Code,
    };
    let mut req = GenerateRequest {
        mode,
        schemas,
        package: PackageMeta {
            name: "playground".to_string(),
            version: "0.1.0".to_string(),
        },
        // The generator's own version, named by the generator rather than
        // restated here.
        target: TargetLanguage { language: language.to_string(), version: version.to_string() },
        // The playground's congregation declares no `wire`: the default.
        wire_format: DEFAULT_FORMAT.to_string(),
        // No dependency bindings to reference in the browser - std is
        // generated inline, as it was before the flag existed.
        external_std: false,
        // The preview shows the checks; whether decoding runs them is a
        // consumer's `comline.toml` choice the playground has no file for.
        validate_on_decode: Default::default(),
        // `async` is a consumer's `comline.toml` choice too: the preview
        // shows the blocking form.
        async_api: false,
        // Filled just below.
        encodings: Default::default(),
    };
    comline_codegen::encodings::fill(
        &mut req,
        comline_core::encodings::official::units(),
        &declared,
        &Default::default(),
    )
    .map_err(|e| format!("{e:#}"))?;
    Ok(req)
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
) -> (CompileProjectResult, Vec<(String, Vec<FrozenUnit>)>, Vec<ConfigUnit>) {
    let mut context =
        ProjectInterpreter::from_config_source(CONGREGATION).expect("static congregation parses");
    // The encodings the package declares, for `encodings::fill`. The
    // congregation is in memory, so it declares none: core reads an
    // encoding's profile from the package directory.
    let declared: Vec<ConfigUnit> = context
        .config_frozen
        .iter()
        .flatten()
        .filter(|u| matches!(u, ConfigUnit::Encoding { .. }))
        .cloned()
        .collect();

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

        // `validate` reports warnings through its `Ok` arm now - a
        // deprecation, say. Showing those too matches what `comline build`
        // prints; only the `Err` arm means the schema would fail to build.
        let (diagnostics, ok) = match validation::validate(&units) {
            Ok(warnings) => (
                warnings.into_iter().map(|w| validation_diagnostic(&f.source, w)).collect(),
                true,
            ),
            Err(errors) => (
                errors.into_iter().map(|e| validation_diagnostic(&f.source, e)).collect(),
                false,
            ),
        };

        reports.push(FileReport {
            path: f.path.clone(),
            namespace,
            ok,
            diagnostics,
            ir: Some(format!("{units:#?}")),
            units: units.len(),
        });
        schemas.push((p.segments.join("/"), units));
    }

    (CompileProjectResult { files: reports }, schemas, declared)
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

/// One of core's diagnostics as an LSP one. `ValidationError` was folded
/// into the shared `Diagnostic` type, which carries its own severity and a
/// `help` line - so a warning is no longer forced to render as an error,
/// and a "did you mean" suggestion is no longer dropped.
fn validation_diagnostic(source: &str, error: comline_core::diagnostics::Diagnostic) -> Diagnostic {
    use comline_core::diagnostics::Severity;

    let range = error
        .span
        .map(|(start, end)| byte_range_to_lsp_range(source, start, end))
        .unwrap_or_default();
    let severity = error.effective_severity();
    let mut message = if error.context.is_empty() {
        error.message
    } else {
        format!("{} — {}", error.message, error.context)
    };
    if let Some(help) = error.help {
        message = format!("{message} — {help}");
    }
    Diagnostic {
        range,
        severity: Some(match severity {
            Severity::Error => DiagnosticSeverity::ERROR,
            Severity::Warning => DiagnosticSeverity::WARNING,
            Severity::Info => DiagnosticSeverity::INFORMATION,
            Severity::Hint => DiagnosticSeverity::HINT,
        }),
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
    /// `type Name = target`: a name for another type, so a field of this
    /// type renders as, and encodes as, the target.
    Alias { name: String, of: TypeRef },
}

/// A type reference in a signature: core's frozen `TypeRef`, with each named
/// type classified as declared in this project (`ref`) or not (`prim`).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TypeRef {
    Prim { name: String },
    Ref { name: String },
    /// `len` is a fixed array's length (`u8[4]`); absent for `T[]`.
    Array {
        of: Box<TypeRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        len: Option<u64>,
    },
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
            FrozenUnit::Struct { name, .. }
            | FrozenUnit::Enum { name, .. }
            | FrozenUnit::TypeAlias { name, .. } => Some(name.as_str()),
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
            FrozenUnit::TypeAlias { name, target, .. } => Some(TypeDef::Alias {
                name: name.clone(),
                of: type_ref(target, known),
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

/// The framing a protocol is generated with, by name.
///
/// The accepted spellings come from core rather than a copy kept here.
/// This copy had drifted: it was missing `json-rpc` and
/// `comline.datagram`, so a protocol both real generators emit as
/// JSON-RPC was rendered as datagram in the playground - the one place a
/// reader would compare them side by side.
///
/// Read through core's `FramingValue`, so `"jsonrpc"` and
/// `{ name = "jsonrpc", ... }` are the same framing here as everywhere.
///
/// A protocol that names none gets the package's framing, which core has
/// already written into it when the package declares one, else the
/// built-in default, `datagram@2`.
fn framing_of(params: &[FrozenUnit]) -> String {
    FramingValue::of_protocol(params).map_or(DEFAULT_FRAMING, |f| f.name).to_string()
}

fn field_shape(u: &FrozenUnit, known: &HashSet<&str>) -> Option<FieldShape> {
    match u {
        FrozenUnit::Field { name, ty, optional, .. } => Some(FieldShape {
            name: name.clone(),
            ty: type_ref(ty, known),
            optional: *optional,
        }),
        _ => None,
    }
}

fn enum_variant_name(u: &FrozenUnit) -> Option<String> {
    match u {
        FrozenUnit::EnumVariant(name, _) => Some(name.clone()),
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
                .map(|a| ArgShape { name: a.name.clone(), ty: type_ref(&a.ty, known) })
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

/// The only distinction the UI needs beyond core's own shape is "a type
/// declared in this project" (render its fields) vs. "anything else" (one
/// scalar input). The grammar reserves the primitive keywords, so a declared
/// name never collides with `u64` / `string` / …, and `known` (built from the
/// IR) decides.
fn type_ref(ty: &FrozenType, known: &HashSet<&str>) -> TypeRef {
    match ty {
        FrozenType::Unit => TypeRef::Unit,
        FrozenType::Union(members) => TypeRef::Union {
            of: members.iter().map(|m| type_ref(m, known)).collect(),
        },
        FrozenType::Primitive(p) => TypeRef::Prim { name: p.name().to_string() },
        FrozenType::Array { element, length } => TypeRef::Array {
            of: Box::new(type_ref(element, known)),
            len: *length,
        },
        FrozenType::Named(n) if known.contains(n.as_str()) => TypeRef::Ref { name: n.clone() },
        FrozenType::Named(n) => TypeRef::Prim { name: n.clone() },
    }
}

// ── per-file editor services (LSP handlers) ──────────────────────────────

#[wasm_bindgen]
pub fn semantic_tokens(source: &str) -> JsValue {
    to_js(&semantic_tokens::get_semantic_tokens(source, &uri()))
}

/// Hover for the active file, also resolving a struct/enum/protocol/const
/// declared in one of the *other* project files (e.g. via `use other::Thing`)
/// — a flat, first-match name lookup across `files`, not full `use`-scoped
/// resolution (same simplification `describe_project`'s `known` set below
/// already uses for cross-file type references).
#[wasm_bindgen]
pub fn hover(files: JsValue, active_path: &str, line: u32, character: u32) -> JsValue {
    let files: Vec<FileInput> = match serde_wasm_bindgen::from_value(files) {
        Ok(f) => f,
        Err(_) => return to_js(&None::<lsp_types::Hover>),
    };
    let Some(active) = files.iter().find(|f| f.path == active_path) else {
        return to_js(&None::<lsp_types::Hover>);
    };
    let other_files: Vec<(Url, String)> = files
        .iter()
        .filter(|f| f.path != active_path)
        .map(|f| (file_uri(&f.path), f.source.clone()))
        .collect();
    to_js(&hover_h::get_hover_info_with_project(
        &active.source,
        &file_uri(&active.path),
        Position { line, character },
        &other_files,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_paths_follow_the_clis_rule() {
        for good in ["a.rs", "src/lib.rs", "a/b/c.ts", "..a", "a.."] {
            assert_eq!(check_path(good), Ok(()), "{good}");
        }
        for bad in ["", "/etc/passwd", "../x", "a/../b", "./a", "a//b", "a/", "a\\b", "c:/x", "a/b:c", "a\0b"] {
            assert!(check_path(bad).is_err(), "{bad:?}");
        }
    }

    fn response(files: Vec<FileOut>) -> Vec<u8> {
        protocol::encode(&Response::Generate(protocol::Generated { files, diagnostics: vec![] })).unwrap()
    }

    #[test]
    fn a_bad_path_refuses_the_whole_response() {
        let files = vec![
            FileOut { path: "ok.rs".into(), contents: b"fine".to_vec() },
            FileOut { path: "../escape.rs".into(), contents: vec![] },
        ];
        let error = checked_files(&response(files), GENERATED_CAP).unwrap_err();
        assert!(error.contains("`../escape.rs`") && error.contains("nothing was written"), "{error}");
    }

    #[test]
    fn an_error_response_or_garbage_is_refused() {
        let error = protocol::encode(&Response::Error { message: "no".into() }).unwrap();
        assert_eq!(checked_files(&error, GENERATED_CAP).unwrap_err(), "the generator: no");
        assert!(checked_files(b"not cbor", GENERATED_CAP).unwrap_err().contains("doesn't decode"));
    }

    #[test]
    fn output_over_the_cap_is_refused() {
        let files = vec![
            FileOut { path: "a".into(), contents: vec![0; 8] },
            FileOut { path: "b".into(), contents: vec![0; 9] },
        ];
        let bytes = response(files);
        assert_eq!(checked_files(&bytes, 17).map(|f| f.len()), Ok(2));
        assert!(checked_files(&bytes, 16).unwrap_err().contains("over the 16-byte limit"));
    }
    use comline_core::schema::ir::frozen::unit::ConfigValue;

    fn framing_param(written: &str) -> Vec<FrozenUnit> {
        vec![FrozenUnit::Property {
            name: "framing".to_string(),
            value: ConfigValue::Str(written.to_string()),
        }]
    }

    #[test]
    fn every_framing_spelling_core_accepts_resolves_here_too() {
        // The bug this replaced: `json-rpc` and `comline.datagram` were
        // missing from the local table, so a protocol the real generators
        // emit as JSON-RPC rendered as datagram in the playground - the
        // one place the two are compared side by side.
        for spelling in ["jsonrpc", "json-rpc", "jsonrpc-2.0"] {
            assert_eq!(framing_of(&framing_param(spelling)), "jsonrpc", "{spelling}");
        }
        for spelling in ["datagram", "comline.datagram"] {
            assert_eq!(framing_of(&framing_param(spelling)), "datagram", "{spelling}");
        }
    }

    #[test]
    fn a_framing_dictionary_names_its_framing() {
        let dict = vec![FrozenUnit::Property {
            name: "framing".to_string(),
            value: ConfigValue::Dict(vec![
                ("name".to_string(), ConfigValue::Str("json-rpc".to_string())),
                ("method_names".to_string(), ConfigValue::Name("qualified".to_string())),
            ]),
        }];
        assert_eq!(framing_of(&dict), "jsonrpc");
    }

    #[test]
    fn a_type_alias_is_described_and_references_to_it_are_refs() {
        let files = vec![FileInput {
            path: "alias.ids".to_string(),
            source: "type Handle = string\n\nstruct Account {\n    owner: Handle\n}\n"
                .to_string(),
        }];
        let (_, frozen, _) = interpret_project(&files);
        let known: HashSet<&str> = frozen
            .iter()
            .flat_map(|(_, units)| units.iter())
            .filter_map(|u| match u {
                FrozenUnit::Struct { name, .. }
                | FrozenUnit::Enum { name, .. }
                | FrozenUnit::TypeAlias { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        let (ns, units) = &frozen[0];
        let schema = serde_json::to_value(describe_schema(ns, units, &known)).unwrap();
        let types = schema["types"].as_array().unwrap();

        let alias = types.iter().find(|t| t["name"] == "Handle").expect("alias described");
        assert_eq!(
            *alias,
            serde_json::json!({"kind":"alias","name":"Handle","of":{"kind":"prim","name":"string"}})
        );
        let account = types.iter().find(|t| t["name"] == "Account").expect("struct described");
        assert_eq!(
            account["fields"][0]["ty"],
            serde_json::json!({"kind":"ref","name":"Handle"})
        );
    }

    #[test]
    fn no_framing_is_the_default_datagram2() {
        assert_eq!(framing_of(&[]), "datagram@2");
        assert_eq!(framing_of(&framing_param("datagram@2")), "datagram@2");
    }
}
