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
//! - [`semantic_tokens`] / [`hover`] / [`completions`] — the LSP handlers, run
//!   against the active file, so highlighting / hover / autocomplete match
//!   `comline-lsp`.

use std::cell::RefCell;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use comline_core::package::config::ir::interpreter::ProjectInterpreter;
use comline_core::schema::idl::grammar::Declaration;
use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
use comline_core::schema::ir::context::SchemaContext;
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

/// File-name suffixes stripped when turning a virtual file name into a namespace.
const SCHEMA_EXTS: &[&str] = &[".comline", ".ids", ".idl"];

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
    /// Virtual file name, e.g. `chat.comline`. Its stem, split on `/`, is the
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

/// `chat.comline` → `["chat"]`, `foo/bar.ids` → `["foo", "bar"]`. Falls back to
/// `["main"]` for an empty or extension-only name.
fn namespace_segments(path: &str) -> Vec<String> {
    let stem = SCHEMA_EXTS
        .iter()
        .find_map(|ext| path.strip_suffix(ext))
        .unwrap_or(path);
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
