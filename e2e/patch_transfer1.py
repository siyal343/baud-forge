#!/usr/bin/env python3
"""One-off patch: transfer endpoints in serve.rs (jobs, channels, routes)."""
import io

p = "crates/bforge-core/src/serve.rs"
s = io.open(p, encoding="utf-8").read()

# 1. Job struct after SchemaJob
anchor = """/// One `POST /api/schema` with `action: "apply"`: swap a port's dissector.
#[derive(Debug)]
struct SchemaJob {"""
job = """/// One `POST /api/transfer`: arm, cancel or drain an X/YMODEM transfer.
#[derive(Debug)]
enum TransferAction {
    Arm {
        port: String,
        direction: crate::xmodem::XferDirection,
        mode: crate::xmodem::XferMode,
        name: String,
        data: Vec<u8>,
        expected_len: Option<usize>,
    },
    Cancel {
        port: String,
    },
    /// Take the bytes a finished receive collected.
    Drain {
        port: String,
    },
}

#[derive(Debug)]
struct TransferJob {
    action: TransferAction,
    reply: std::sync::mpsc::SyncSender<Result<Vec<u8>, String>>,
}

/// One `POST /api/schema` with `action: "apply"`: swap a port's dissector.
#[derive(Debug)]
struct SchemaJob {"""
assert anchor in s
s = s.replace(anchor, job, 1)

# 2. Shared channel (staging slot lives in Shared directly)
anchor = """    /// Same for applying an uploaded schema to a port.
    schema_request: Mutex<Option<std::sync::mpsc::Sender<SchemaJob>>>,"""
add = anchor + """
    /// Same for arming, cancelling or draining an X/YMODEM transfer.
    transfer_request: Mutex<Option<std::sync::mpsc::Sender<TransferJob>>>,
    /// Staged upload bytes for the next Send transfer (single slot: the UI
    /// uploads, then arms immediately).
    upload_staging: Mutex<Vec<u8>>,"""
assert anchor in s
s = s.replace(anchor, add, 1)

# 3. Channel init
anchor = """        let (schema_tx, schema_rx) = std::sync::mpsc::channel::<SchemaJob>();
        *shared.schema_request.lock().unwrap() = Some(schema_tx);"""
add = anchor + """
        let (transfer_tx, transfer_rx) = std::sync::mpsc::channel::<TransferJob>();
        *shared.transfer_request.lock().unwrap() = Some(transfer_tx);"""
assert anchor in s
s = s.replace(anchor, add, 1)

# 4. Drain loop after schema drain
anchor = """            while let Ok(job) = schema_rx.try_recv() {
                let result = session
                    .apply_schema_text(&job.port, &job.kind, &job.text, job.root.as_deref())
                    .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }"""
add = anchor + """
            while let Ok(job) = transfer_rx.try_recv() {
                let result = match job.action {
                    TransferAction::Arm {
                        port,
                        direction,
                        mode,
                        name,
                        data,
                        expected_len,
                    } => session
                        .start_transfer(&port, direction, mode, name, data, expected_len)
                        .map(|()| Vec::new()),
                    TransferAction::Cancel { port } => session
                        .cancel_transfer(&port)
                        .map(|()| Vec::new()),
                    TransferAction::Drain { port } => session.take_transfer_data(&port),
                }
                .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }"""
assert anchor in s
s = s.replace(anchor, add, 1)

# 5. Routes after /api/schema
anchor = """    if method == "POST" && path == "/api/schema" {
        let body = read_body(&mut reader, content_length);
        schema(&mut stream, &shared, &body);
        return;
    }"""
routes = anchor + """
    if method == "POST" && path == "/api/transfer" {
        let body = read_body(&mut reader, content_length);
        transfer_control(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/transfer/upload" {
        let body = read_body(&mut reader, content_length);
        transfer_upload(&mut stream, &shared, &body);
        return;
    }
    if method == "GET" && path == "/api/transfer" {
        transfer_status(&mut stream, &shared, target);
        return;
    }
    if method == "GET" && path == "/api/transfer/data" {
        transfer_data(&mut stream, &shared, target);
        return;
    }"""
assert anchor in s
s = s.replace(anchor, routes, 1)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("patched routes+jobs")
