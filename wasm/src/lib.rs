//! The Comline playground's compile core — the same `comline-core` +
//! `comline-codegen` the CLI uses and the same analysis the language server
//! uses, behind a small `wasm-bindgen` surface.
//!
//! Single schema, namespace `main`, `code` / `lib` mode.
//!
//! - [`compile`]  — parse → IR → diagnostics (the LSP's `all_diagnostics`)
//! - [`generate`] — frozen IR → generated files for a target language
//! - [`semantic_tokens`] / [`hover`] / [`completions`] — the LSP handlers
//!   verbatim, so the editor's highlighting / hover / autocomplete match
//!   `comline-lsp`.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use comline_core::schema::idl::grammar;
use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
use comline_core::schema::ir::compiler::Compile;
use comline_core::schema::ir::frozen::unit::FrozenUnit;

use comline_codegen::{GenRequest, Mode, PackageMeta};

use comline_language_server::analysis::diagnostics::all_diagnostics;
use comline_language_server::handlers::{completion, hover as hover_h, semantic_tokens};
use comline_language_server::parser;

use lsp_types::{Position, Url};

const NAMESPACE: &str = "main";

fn uri() -> Url {
    Url::parse("file:///playground.ids").expect("static uri")
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize)]
struct CompileResult {
    ok: bool,
    /// `lsp-types` diagnostics (line/character ranges), from the LSP's own
    /// parse-error + validation pipeline.
    diagnostics: Vec<lsp_types::Diagnostic>,
    /// Debug rendering of the frozen units — `None` while the source does not
    /// parse.
    ir: Option<String>,
    units: usize,
}

/// Parse `source`, freeze it, and run the language server's diagnostic pass
/// (parse errors + `comline-core` validation).
#[wasm_bindgen]
pub fn compile(source: &str) -> JsValue {
    let parsed = parser::parse(source).expect("parser never errors internally");
    let diagnostics = all_diagnostics(source, &parsed.errors, parsed.document.as_ref());

    let (ir, units) = match &parsed.document {
        Some(doc) => {
            let frozen = IncrementalInterpreter::from_declarations(doc.0.clone());
            (Some(format!("{frozen:#?}")), frozen.len())
        }
        None => (None, 0),
    };

    to_js(&CompileResult {
        ok: diagnostics.is_empty(),
        diagnostics,
        ir,
        units,
    })
}

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

/// Freeze `source` and run a target generator over it. `target` is `"rust"` or
/// `"typescript"` (`"ts"`); `mode` is `"code"` or `"lib"`.
#[wasm_bindgen]
pub fn generate(source: &str, target: &str, mode: &str) -> JsValue {
    let units = match freeze(source) {
        Some(units) => units,
        None => {
            return to_js(&GenerateResult {
                files: Vec::new(),
                error: Some("schema does not parse".to_string()),
            })
        }
    };

    let mode = match mode {
        "lib" => Mode::Lib,
        _ => Mode::Code,
    };
    let schemas = vec![(NAMESPACE.to_string(), units)];
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
                files: Vec::new(),
                error: Some(format!("unknown target `{other}`")),
            })
        }
    };

    let result = match generated {
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
            files: Vec::new(),
            error: Some(e.to_string()),
        },
    };
    to_js(&result)
}

/// Parse + freeze; `None` if the source does not parse.
fn freeze(source: &str) -> Option<Vec<FrozenUnit>> {
    let document = grammar::parse(source).ok()?;
    Some(IncrementalInterpreter::from_declarations(document.0))
}

fn to_js<T: Serialize>(value: &T) -> JsValue {
    serde_wasm_bindgen::to_value(value).unwrap_or(JsValue::NULL)
}
