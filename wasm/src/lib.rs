//! The Comline playground's compile core — the same `comline-core` +
//! `comline-codegen` the CLI uses, behind a small `wasm-bindgen` surface.
//!
//! Single schema, namespace `main`, `code` / `lib` mode. Two entry points:
//! [`compile`] (parse → IR → validation diagnostics) and [`generate`]
//! (frozen IR → generated files for a target language).

use serde::Serialize;
use wasm_bindgen::prelude::*;

use comline_core::schema::idl::grammar;
use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
use comline_core::schema::ir::compiler::Compile;
use comline_core::schema::ir::frozen::unit::FrozenUnit;
use comline_core::schema::ir::validation;

use comline_codegen::{GenRequest, Mode, PackageMeta};

const NAMESPACE: &str = "main";

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// One editor-placeable diagnostic. `start` / `end` are byte offsets into the
/// source (the editor maps them to line/column).
#[derive(Serialize)]
struct Diagnostic {
    severity: &'static str, // "error"
    message: String,
    start: usize,
    end: usize,
}

#[derive(Serialize)]
struct CompileResult {
    ok: bool,
    diagnostics: Vec<Diagnostic>,
    /// Debug rendering of the frozen units — `None` while the source does not
    /// parse.
    ir: Option<String>,
    /// How many top-level declarations froze.
    units: usize,
}

/// Parse `source`, freeze it, and run `comline-core`'s validation pass.
/// Returns a `CompileResult` (see the TS `CompileResult` type).
#[wasm_bindgen]
pub fn compile(source: &str) -> JsValue {
    let result = match freeze(source) {
        Ok(units) => {
            let mut diagnostics = Vec::new();
            if let Err(errors) = validation::validate(&units) {
                for e in errors {
                    let (start, end) = e.span.unwrap_or((0, 0));
                    let message = if e.context.is_empty() {
                        e.message
                    } else {
                        format!("{} — {}", e.message, e.context)
                    };
                    diagnostics.push(Diagnostic {
                        severity: "error",
                        message,
                        start,
                        end,
                    });
                }
            }
            CompileResult {
                ok: diagnostics.is_empty(),
                diagnostics,
                ir: Some(format!("{units:#?}")),
                units: units.len(),
            }
        }
        Err(diagnostics) => CompileResult {
            ok: false,
            diagnostics,
            ir: None,
            units: 0,
        },
    };
    to_js(&result)
}

#[derive(Serialize)]
struct GeneratedFile {
    path: String,
    contents: String,
}

#[derive(Serialize)]
struct GenerateResult {
    files: Vec<GeneratedFile>,
    /// Set instead of `files` when the source didn't compile or the generator
    /// errored.
    error: Option<String>,
}

/// Freeze `source` and run a target generator over it. `target` is `"rust"` or
/// `"typescript"` (`"ts"`); `mode` is `"code"` or `"lib"`.
#[wasm_bindgen]
pub fn generate(source: &str, target: &str, mode: &str) -> JsValue {
    let units = match freeze(source) {
        Ok(units) => units,
        Err(diags) => {
            let msg = diags
                .first()
                .map(|d| d.message.clone())
                .unwrap_or_else(|| "does not parse".to_string());
            return to_js(&GenerateResult {
                files: Vec::new(),
                error: Some(format!("schema does not compile: {msg}")),
            });
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

/// Parse + freeze. `Err` carries parse-error diagnostics; a well-formed tree
/// always freezes (validation is a separate step).
fn freeze(source: &str) -> Result<Vec<FrozenUnit>, Vec<Diagnostic>> {
    match grammar::parse(source) {
        Ok(document) => Ok(IncrementalInterpreter::from_declarations(document.0)),
        Err(errors) => Err(errors
            .iter()
            .map(|e| Diagnostic {
                severity: "error",
                message: parse_error_message(e),
                start: e.start,
                end: e.end,
            })
            .collect()),
    }
}

fn parse_error_message(error: &rust_sitter::errors::ParseError) -> String {
    use rust_sitter::errors::ParseErrorReason;
    match &error.reason {
        ParseErrorReason::UnexpectedToken(t) => format!("unexpected token `{t}`"),
        ParseErrorReason::MissingToken(t) => format!("missing `{t}`"),
        ParseErrorReason::FailedNode(nested) => nested
            .first()
            .map(parse_error_message)
            .unwrap_or_else(|| "syntax error".to_string()),
    }
}

fn to_js<T: Serialize>(value: &T) -> JsValue {
    serde_wasm_bindgen::to_value(value).unwrap_or(JsValue::NULL)
}
