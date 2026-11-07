//! The post-mortem path: what survives when the process itself dies.
//!
//! The activity ring answers "what happened before the failure?" but it lives
//! in memory, and the `<vault>.activity.jsonl` file only lands on a clean
//! stop. A panic in a server thread used to print to stderr — which a
//! window-launched desktop binary does not even have — and everything else
//! was lost with the process. This module closes that: a process-wide panic
//! hook writes a crash report to the temp directory, and the session
//! registers its ring so the report carries the last activity entries with
//! it, plus the path of the activity file the periodic flush has been
//! maintaining.
//!
//! Everything here must assume the worst: the hook runs on a panicking
//! thread, possibly while locks are held, so it never unwraps, never
//! allocates beyond necessity, and re-panicking inside the hook would loop.

use crate::logs::LogRing;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// What the hook needs from the live session. Registered by `Server::bind`
/// and updated as the session's vault changes (start, REC presses).
#[derive(Default)]
struct CrashContext {
    ring: Option<Arc<LogRing>>,
    /// The `<vault>.activity.jsonl` sidecar the flush thread maintains, so a
    /// crash report can point at the fuller trail.
    activity_path: Option<PathBuf>,
}

static CONTEXT: OnceLock<Mutex<CrashContext>> = OnceLock::new();

fn context() -> &'static Mutex<CrashContext> {
    CONTEXT.get_or_init(|| Mutex::new(CrashContext::default()))
}

/// Point the crash report at a session's activity ring. The most recent
/// registration wins: one process serves one session at a time.
pub fn register_ring(ring: &Arc<LogRing>) {
    if let Ok(mut context) = context().lock() {
        context.ring = Some(Arc::clone(ring));
    }
}

/// Record which activity file describes the current session (or `None`
/// between sessions, so a stale path is never cited).
pub fn set_activity_path(path: Option<PathBuf>) {
    if let Ok(mut context) = context().lock() {
        context.activity_path = path;
    }
}

static HOOK_INSTALLED: OnceLock<()> = OnceLock::new();
/// Set while a report is being written: a panic in the middle of writing one
/// must not recurse into writing another.
static WRITING: AtomicBool = AtomicBool::new(false);

/// Install the process-wide panic hook. Idempotent: the first call wins, so
/// every binary can call it unconditionally at startup.
///
/// The previous hook (normally the default stderr printer) still runs, so a
/// launched-from-terminal `bforge serve` keeps its console output.
pub fn install_panic_hook() {
    if HOOK_INSTALLED.set(()).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        write_panic_report(info);
    }));
}

fn write_panic_report(info: &std::panic::PanicHookInfo<'_>) {
    // If the report writer itself panicked, the second hook invocation must
    // not recurse; the process is beyond saving anyway.
    if WRITING.swap(true, Ordering::SeqCst) {
        return;
    }
    let report = CrashReport {
        message: payload_message(info),
        location: info
            .location()
            .map(|location| location.to_string())
            .unwrap_or_else(|| "<unknown>".to_string()),
        thread: std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string(),
        backtrace: std::backtrace::Backtrace::force_capture().to_string(),
    };
    // Locks are taken with `ok()`: a poisoned lock (the panic that brought us
    // here may have happened while it was held) must not turn into another.
    let (ring, activity) = match context().lock() {
        Ok(context) => (context.ring.clone(), context.activity_path.clone()),
        Err(_) => (None, None),
    };
    let path = crash_file_path();
    let written = write_crash_report(&path, &report, ring.as_deref(), activity.as_deref());
    WRITING.store(false, Ordering::SeqCst);
    if let Ok(count) = written {
        eprintln!("bforge: crash report: {count} bytes -> {}", path.display());
    }
}

/// Where the next crash report lands: the temp directory, uniquely named per
/// process and per panic so concurrent reports never overwrite each other.
fn crash_file_path() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("bforge-crash-{}-{stamp}.log", std::process::id()))
}

/// The facts of one panic, extracted from the hook so they can be formatted
/// without the hook machinery in the way (and so tests can exercise it).
pub struct CrashReport {
    pub message: String,
    pub location: String,
    pub thread: String,
    pub backtrace: String,
}

fn payload_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(text) = payload.downcast_ref::<&str>() {
        text.to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Write one crash report: the panic facts, a pointer to the activity file,
/// and the entries still in the ring as JSON lines. Returns the byte count.
pub fn write_crash_report(
    path: &std::path::Path,
    report: &CrashReport,
    ring: Option<&LogRing>,
    activity_path: Option<&std::path::Path>,
) -> std::io::Result<usize> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let mut text = String::with_capacity(1_024);
    text.push_str("BaudForge crash report\n");
    text.push_str(&format!("when (epoch ms): {stamp}\n"));
    text.push_str(&format!("pid: {}\n", std::process::id()));
    if let Ok(exe) = std::env::current_exe() {
        text.push_str(&format!("exe: {}\n", exe.display()));
    }
    text.push_str(&format!("thread: {}\n", report.thread));
    text.push_str(&format!("location: {}\n", report.location));
    text.push_str(&format!("panic: {}\n", report.message));
    if let Some(activity) = activity_path {
        text.push_str(&format!("activity file: {}\n", activity.display()));
    }
    text.push_str("\nbacktrace:\n");
    text.push_str(&report.backtrace);
    text.push('\n');
    if let Some(ring) = ring {
        let entries = ring.all();
        text.push_str(&format!("\nlast activity ({} entries):\n", entries.len()));
        for entry in &entries {
            match serde_json::to_string(entry) {
                Ok(line) => {
                    text.push_str(&line);
                    text.push('\n');
                }
                Err(_) => text.push_str("{\"event\":\"unserializable\"}\n"),
            }
        }
    }
    std::fs::write(path, &text)?;
    Ok(text.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::{LogLevel, LogSource};

    /// A crash report must carry the panic facts and every ring entry, so a
    /// user can attach one file to a bug report and be done.
    #[test]
    fn the_report_carries_the_panic_and_the_ring() {
        let ring = LogRing::default();
        ring.log(LogLevel::Info, LogSource::Engine, "engine_start", "2 ports");
        ring.log(LogLevel::Error, LogSource::Engine, "tx_failed", "port gone");

        let report = CrashReport {
            message: "index out of bounds: the len is 3 but the index is 3".to_string(),
            location: "src/pipeline.rs:41:5".to_string(),
            thread: "bforge-pump".to_string(),
            backtrace: "  0: bforge_core::pipeline::pump".to_string(),
        };

        let dir = std::env::temp_dir().join(format!("bforge-crash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("report.log");
        let activity = dir.join("capture.bflog.activity.jsonl");
        let count = write_crash_report(&path, &report, Some(&ring), Some(&activity)).unwrap();
        assert!(count > 0);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("BaudForge crash report"));
        assert!(text.contains("index out of bounds"));
        assert!(text.contains("src/pipeline.rs:41:5"));
        assert!(text.contains("bforge-pump"));
        assert!(text.contains("backtrace"));
        assert!(text.contains(&activity.display().to_string()));
        assert!(text.contains("\"event\":\"engine_start\""));
        assert!(text.contains("\"event\":\"tx_failed\""));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// No session ever registered (or the ring is gone): the report must
    /// still be written, just without the activity sections.
    #[test]
    fn a_report_without_a_session_still_lands() {
        let report = CrashReport {
            message: "boom".to_string(),
            location: "x.rs:1:1".to_string(),
            thread: "main".to_string(),
            backtrace: String::new(),
        };
        let dir = std::env::temp_dir().join(format!("bforge-crash-bare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("report.log");
        write_crash_report(&path, &report, None, None).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("panic: boom"));
        assert!(!text.contains("last activity"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The registry hands the hook the latest session's ring.
    #[test]
    fn registration_replaces_the_ring() {
        let first = Arc::new(LogRing::default());
        let second = Arc::new(LogRing::default());
        register_ring(&first);
        register_ring(&second);
        let context = context().lock().unwrap();
        assert!(Arc::ptr_eq(
            context.ring.as_ref().unwrap(),
            &second
        ));
    }
}
