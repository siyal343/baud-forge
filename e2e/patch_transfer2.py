#!/usr/bin/env python3
"""One-off patch: transfer handler functions in serve.rs."""
import io

p = "crates/bforge-core/src/serve.rs"
s = io.open(p, encoding="utf-8").read()

anchor = """#[derive(serde::Serialize)]
struct DeviceDto<'a> {"""
handlers = r'''/// One `POST /api/transfer/upload`: stage the raw file for a Send transfer.
fn transfer_upload(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    if body.is_empty() {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"empty body: attach the file bytes\"}",
        );
    }
    *shared.upload_staging.lock().unwrap() = body.to_vec();
    let body = format!("{{\"ok\":true,\"bytes\":{}}}", body.len());
    respond(stream, "200 OK", "application/json", body.as_bytes());
}

/// One `POST /api/transfer`: arm or cancel an X/YMODEM transfer.
#[derive(serde::Deserialize)]
struct TransferBody {
    action: String,
    port: String,
    /// `send` or `recv`.
    #[serde(default)]
    direction: Option<String>,
    /// `crc128` (default) or `crc1k`.
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// True file size for a Recv (the protocol has no length on the wire).
    #[serde(default)]
    size: Option<usize>,
}

fn transfer_control(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: TransferBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    };
    let action = match request.action.as_str() {
        "arm" => {
            let direction = match request.direction.as_deref() {
                Some("send") => crate::xmodem::XferDirection::Send,
                Some("recv") | None => crate::xmodem::XferDirection::Recv,
                Some(other) => {
                    let body = format!(
                        "{{\"error\":\"unknown direction `{other}`; use send or recv\"}}"
                    );
                    return respond(
                        stream,
                        "400 Bad Request",
                        "application/json",
                        body.as_bytes(),
                    );
                }
            };
            let mode = match request.mode.as_deref() {
                Some("crc1k") => crate::xmodem::XferMode::Crc1K,
                _ => crate::xmodem::XferMode::Crc128,
            };
            let name = request
                .name
                .clone()
                .unwrap_or_else(|| "transfer.bin".to_string());
            let (data, expected_len) = match direction {
                crate::xmodem::XferDirection::Send => {
                    let staged = shared.upload_staging.lock().unwrap().clone();
                    if staged.is_empty() {
                        let body =
                            "{\"error\":\"no file staged; POST /api/transfer/upload first\"}";
                        return respond(
                            stream,
                            "409 Conflict",
                            "application/json",
                            body.as_bytes(),
                        );
                    }
                    let len = request.size.unwrap_or(staged.len());
                    (staged, Some(len))
                }
                crate::xmodem::XferDirection::Recv => {
                    (Vec::new(), request.size.map(|size| size.max(1)))
                }
            };
            TransferAction::Arm {
                port: request.port.clone(),
                direction,
                mode,
                name,
                data,
                expected_len,
            }
        }
        "cancel" => TransferAction::Cancel {
            port: request.port.clone(),
        },
        other => {
            let body = format!(
                "{{\"error\":\"unknown action `{other}`; use arm or cancel\"}}"
            );
            return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    };
    let sender = shared.transfer_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(TransferJob {
            action,
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(bytes)) => {
            let body = format!("{{\"ok\":true,\"port\":{}}}", serde_json::json!(request.port));
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
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

/// One `GET /api/transfer?port=X`: the armed transfer's live status, answered
/// from the pump's latest published snapshot (it refreshes each interval).
fn transfer_status(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let query = query(target);
    let Some(port) = query.get("port").cloned() else {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"transfer status needs ?port=\"}",
        );
    };
    let snap = {
        let text = shared.snapshot.lock().unwrap().clone();
        serde_json::from_str::<serde_json::Value>(&text).ok()
    };
    let view = snap
        .and_then(|value| {
            value
                .get("transfers")
                .and_then(|list| list.as_array())
                .map(|list| {
                    list.iter()
                        .find(|view| view.get("port").and_then(|p| p.as_str()) == Some(&port))
                        .cloned()
                })
                .unwrap_or(None)
        })
        .unwrap_or_else(|| serde_json::json!({"phase": "none", "port": port}));
    let body = serde_json::to_string(&view).unwrap_or_else(|_| "{}".to_string());
    respond(stream, "200 OK", "application/json", body.as_bytes());
}

/// One `GET /api/transfer/data?port=X`: drain a finished receive.
fn transfer_data(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let query = query(target);
    let Some(port) = query.get("port").cloned() else {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"transfer data needs ?port=\"}",
        );
    };
    let sender = shared.transfer_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(TransferJob {
            action: TransferAction::Drain { port },
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(bytes)) => {
            respond(stream, "200 OK", "application/octet-stream", &bytes);
        }
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

#[derive(serde::Serialize)]
struct DeviceDto<'a> {'''
assert anchor in s
s = s.replace(anchor, handlers, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("patched handlers")
