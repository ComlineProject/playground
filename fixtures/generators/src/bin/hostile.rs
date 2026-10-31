//! A generator that misbehaves, one way per name: the mode is `argv[0]`,
//! which the runner sets to the generator's name, since a generator gets no
//! other arguments and no environment. The CLI's
//! `tests/fixtures/generators/src/bin/hostile.rs`, with the modes the
//! playground's runner tests need.

use std::io::{Read, Write};

use comline_codegen::protocol::{
    decode, encode, Description, FileOut, Generated, LanguageInfo, Request, RequestBody, Response,
    VersionsInfo, IR_FORMAT, PROTOCOL_VERSION,
};

fn main() {
    let mode = std::env::args().next().unwrap_or_default();
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).unwrap();
    let request: Request = decode(&input).unwrap();
    let response = match request.body {
        RequestBody::Describe => describe(&mode),
        RequestBody::Generate(_) => generate(&mode),
    };
    let mut out = std::io::stdout().lock();
    out.write_all(&encode(&response).unwrap()).unwrap();
    out.flush().unwrap();
}

fn describe(mode: &str) -> Response {
    if mode == "describe-timeout" {
        #[allow(clippy::empty_loop)]
        loop {}
    }
    let protocol = if mode == "mismatch" { 7 } else { PROTOCOL_VERSION };
    Response::Describe(Description {
        languages: vec![LanguageInfo {
            id: if mode == "elsewhere" { "go" } else { "rust" }.into(),
            ext: "rs".into(),
            versions: VersionsInfo {
                floor: if mode == "future" { "9.0.0" } else { "1.0.0" }.into(),
                changes: vec![],
                verified_up_to: "1.0.0".into(),
                forward_compatible: true,
            },
            support: vec![],
        }],
        protocols: (protocol, protocol),
        ir_formats: vec![IR_FORMAT],
    })
}

fn generate(mode: &str) -> Response {
    match mode {
        "timeout" =>
        {
            #[allow(clippy::empty_loop)]
            loop {}
        }
        // 128 MiB at once: past a 64 MiB memory cap, within the default.
        "memory" => {
            let mut big: Vec<u8> = Vec::new();
            match big.try_reserve_exact(128 * 1024 * 1024) {
                Ok(()) => {
                    big.resize(128 * 1024 * 1024, 1);
                    Response::Generate(Generated {
                        files: vec![FileOut {
                            path: "big.rs".into(),
                            contents: format!("// {}", big.len()).into_bytes(),
                        }],
                        diagnostics: vec![],
                    })
                }
                Err(e) => Response::Error {
                    message: format!("couldn't reserve 128 MiB: {e}"),
                },
            }
        }
        "stderr" => {
            eprintln!("hello from the generator");
            let line = "x".repeat(1023);
            for _ in 0..100 {
                eprintln!("{line}");
            }
            Response::Error {
                message: "refusing after the noise".into(),
            }
        }
        "dotdot" => Response::Generate(Generated {
            files: ["api.rs", "../escape.rs"]
                .iter()
                .map(|p| FileOut {
                    path: p.to_string(),
                    contents: b"x".to_vec(),
                })
                .collect(),
            diagnostics: vec![],
        }),
        "fine" => Response::Generate(Generated {
            files: vec![FileOut {
                path: "api.rs".into(),
                contents: b"// fine".to_vec(),
            }],
            diagnostics: vec![],
        }),
        other => Response::Error {
            message: format!("unknown mode `{other}`"),
        },
    }
}
