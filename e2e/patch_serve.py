#!/usr/bin/env python3
"""One-off patch: add elf_upload + schema handlers to serve.rs."""
import io

p = "crates/bforge-core/src/serve.rs"
s = io.open(p, encoding="utf-8").read()

anchor = """#[derive(serde::Serialize)]
struct DeviceDto<'a> {"""
handlers = r'''/// One `POST /api/elf`: raw firmware-image bytes (application/octet-stream).
fn elf_upload(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    if body.is_empty() {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"empty body: attach the raw ELF bytes\"}",
        );
    }
    // Store under the workspace images/ directory; enable_symbols reads paths.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let path = std::path::PathBuf::from(format!("images/uploaded-{stamp}.elf"));
    if let Some(parent) = path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
        return respond(stream, "500 Internal Server Error", "application/json", body.as_bytes());
    }
    if let Err(error) = std::fs::write(&path, body) {
        let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
        return respond(stream, "500 Internal Server Error", "application/json", body.as_bytes());
    }
    let sender = shared.elf_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(ElfJob {
            path: path.clone(),
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(stored)) => {
            let body = format!(
                "{{\"ok\":true,\"path\":{},\"bytes\":{}}}",
                serde_json::json!(stored),
                body.len()
            );
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let body = format!("{{\"error\":{}}}", serde_json::json!(error));
            respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(stream, "504 Gateway Timeout", "application/json", body.as_bytes());
        }
    }
}

/// One `POST /api/schema`: parse (dry run), decode sample bytes, or apply a
/// dialect parsed from uploaded text to a live port (spec 2.2).
#[derive(serde::Deserialize)]
struct SchemaBody {
    action: String,
    /// `c_header`, `protobuf` or `mavlink`.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    root: Option<String>,
    /// Target port for `apply`.
    #[serde(default)]
    port: Option<String>,
    /// Spaced hex sample for `decode`.
    #[serde(default)]
    hex: Option<String>,
}

fn schema(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: SchemaBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    };
    let kind = request.kind.as_deref().unwrap_or("c_header").to_string();
    let text = request.text.clone().unwrap_or_default();

    // parse + decode are pure: build the decoder right here.
    let built = crate::tail::decoder_from_text(&kind, &text, request.root.as_deref());
    match request.action.as_str() {
        "parse" => match built {
            Ok(decoder) => {
                // A zero-filled sample exposes the compiled field layout.
                let ir = match decoder {
                    crate::tail::Decoder::Ir { ir, .. } => ir,
                    crate::tail::Decoder::Pack(_) => {
                        let body =
                            "{\"fields\":[],\"note\":\"native pack: no field layout\"}".to_string();
                        return respond(stream, "200 OK", "application/json", body.as_bytes());
                    }
                };
                let zeros = vec![0u8; 256];
                let fields = bforge_dissect::exec::execute(&ir, &zeros).unwrap_or_default();
                let rows = crate::tail::flatten(&fields, "");
                let body = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string());
                respond(stream, "200 OK", "application/json", body.as_bytes());
            }
            Err(error) => {
                let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            }
        },
        "decode" => match built {
            Ok(decoder) => {
                let hex = request.hex.unwrap_or_default();
                let bytes = crate::validate::parse_hex(&hex).unwrap_or_default();
                let reply = match &decoder {
                    crate::tail::Decoder::Ir { ir, .. } => bforge_dissect::exec::execute(ir, &bytes)
                        .map(|fields| crate::tail::flatten(&fields, "")),
                    crate::tail::Decoder::Pack(pack) => pack.decode(&bytes).map(|rows| rows.to_vec()),
                };
                match reply {
                    Ok(rows) => {
                        let body = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string());
                        respond(stream, "200 OK", "application/json", body.as_bytes());
                    }
                    Err(error) => {
                        let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                        respond(stream, "400 Bad Request", "application/json", body.as_bytes());
                    }
                }
            }
            Err(error) => {
                let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            }
        },
        "apply" => {
            let Some(port) = request.port.clone() else {
                let body = "{\"error\":\"apply needs a port\"}";
                return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            };
            if let Err(error) = built {
                let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            }
            let sender = shared.schema_request.lock().unwrap().clone();
            let Some(sender) = sender else {
                let body = "{\"error\":\"the pump is not running\"}";
                return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
            };
            let (reply, answer) = std::sync::mpsc::sync_channel(1);
            let job = SchemaJob {
                port,
                kind,
                text,
                root: request.root,
                reply,
            };
            if sender.send(job).is_err() {
                let body = "{\"error\":\"the pump has stopped\"}";
                return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
            }
            match answer.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(())) => respond(stream, "200 OK", "application/json", b"{\"ok\":true}"),
                Ok(Err(error)) => {
                    let body = format!("{{\"error\":{}}}", serde_json::json!(error));
                    respond(stream, "409 Conflict", "application/json", body.as_bytes());
                }
                Err(_) => {
                    let body = "{\"error\":\"no answer from the pump\"}";
                    respond(stream, "504 Gateway Timeout", "application/json", body.as_bytes());
                }
            }
        }
        other => {
            let body = format!(
                "{{\"error\":\"unknown action `{other}`; use parse, decode or apply\"}}"
            );
            respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    }
}

#[derive(serde::Serialize)]
struct DeviceDto<'a> {'''
assert anchor in s, "anchor missing"
s = s.replace(anchor, handlers, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("patched serve.rs")
