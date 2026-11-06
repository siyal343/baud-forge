//! The session activity ring: one interleaved timeline of engine and UI events.
//!
//! The wire vault records what the device said; this ring records what the
//! session did — job handlers, lifecycle changes, device trouble, and the UI
//! actions that caused them. It exists to answer "what happened right before
//! the failure?" without attaching a debugger.
//!
//! Bounded by design: a week-long session must not grow it without limit, so
//! the oldest entries fall off and the ring stays at `capacity`. On shutdown it
//! is written next to the vault as `<vault>.activity.jsonl`.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// How many entries a serve session keeps in memory. Two thousand covers a
/// dense debugging window; anything older is in the previous activity file.
pub const RING_CAPACITY: usize = 2_000;

/// Severity of one activity entry. Ordered, so a filter can ask for
/// `warn` and still see `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Where an entry came from. The engine logs what it did; the UI logs what a
/// human pressed, so one timeline shows cause and effect together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    Engine,
    Ui,
}

impl std::str::FromStr for LogLevel {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" | "warning" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            other => Err(format!("unknown level {other:?}")),
        }
    }
}

/// One thing that happened, in the order it happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    /// Monotonic within the process; `GET /api/logs?since=` paginates on it.
    pub seq: u64,
    /// Epoch milliseconds, for correlation with vault timestamps.
    pub at_ms: u64,
    pub level: LogLevel,
    pub source: LogSource,
    /// Short machine tag, for example `tx`, `overrun`, `rec_start`.
    pub event: String,
    /// Human-readable specifics.
    pub detail: String,
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The bounded ring behind `GET /api/logs`. Cheap to clone into `Shared`
/// everywhere; the lock is held for microseconds per entry.
#[derive(Debug)]
pub struct LogRing {
    seq: AtomicU64,
    capacity: usize,
    entries: Mutex<VecDeque<LogEntry>>,
}

impl Default for LogRing {
    fn default() -> Self {
        Self::with_capacity(RING_CAPACITY)
    }
}

impl LogRing {
    /// A ring capped at [`RING_CAPACITY`].
    pub fn new() -> Self {
        Self::with_capacity(RING_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            seq: AtomicU64::new(0),
            capacity,
            entries: Mutex::new(VecDeque::with_capacity(capacity.min(64))),
        }
    }

    /// Append one entry and return its sequence number. Oldest entries fall
    /// off when the ring is full.
    pub fn log(
        &self,
        level: LogLevel,
        source: LogSource,
        event: impl Into<String>,
        detail: impl Into<String>,
    ) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let entry = LogEntry {
            seq,
            at_ms: epoch_ms(),
            level,
            source,
            event: event.into(),
            detail: detail.into(),
        };
        let mut entries = self.entries.lock().unwrap();
        while entries.len() >= self.capacity {
            entries.pop_front();
        }
        entries.push_back(entry);
        seq
    }

    /// Entries with `seq > since` and at least `min_level`, oldest first.
    pub fn since(&self, since: u64, min_level: LogLevel) -> Vec<LogEntry> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.seq > since && entry.level >= min_level)
            .cloned()
            .collect()
    }

    /// Every entry still in the ring, oldest first (activity-file export).
    pub fn all(&self) -> Vec<LogEntry> {
        self.entries.lock().unwrap().iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Write every entry as one JSON object per line. The file sits next to
    /// the vault so a capture carries its own audit trail.
    pub fn write_jsonl(&self, path: &std::path::Path) -> std::io::Result<usize> {
        let entries = self.all();
        let mut text = String::with_capacity(entries.len() * 96);
        for entry in &entries {
            text.push_str(
                &serde_json::to_string(entry).unwrap_or_else(|_| "{\"event\":\"unserializable\"}".to_string()),
            );
            text.push('\n');
        }
        std::fs::write(path, text)?;
        Ok(entries.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring() -> LogRing {
        LogRing::with_capacity(4)
    }

    #[test]
    fn sequence_numbers_are_monotonic() {
        let logs = ring();
        assert_eq!(logs.log(LogLevel::Info, LogSource::Engine, "a", ""), 0);
        assert_eq!(logs.log(LogLevel::Warn, LogSource::Ui, "b", ""), 1);
        assert_eq!(logs.all().len(), 2);
    }

    #[test]
    fn oldest_entries_fall_off_when_full() {
        let logs = ring();
        for i in 0..6 {
            logs.log(LogLevel::Info, LogSource::Engine, "tick", i.to_string());
        }
        let all = logs.all();
        assert_eq!(all.len(), 4);
        // Sequence 4 and 5 survive; 0..3 fell off the front.
        assert_eq!(all.first().unwrap().seq, 2);
        assert_eq!(all.last().unwrap().seq, 5);
    }

    #[test]
    fn since_paginates_and_level_filter_is_ordered() {
        let logs = ring();
        logs.log(LogLevel::Debug, LogSource::Engine, "d", "");
        let warn_seq = logs.log(LogLevel::Warn, LogSource::Engine, "w", "");
        logs.log(LogLevel::Error, LogSource::Engine, "e", "");

        let warn_and_up = logs.since(0, LogLevel::Warn);
        assert_eq!(
            warn_and_up.iter().map(|entry| entry.event.as_str()).collect::<Vec<_>>(),
            vec!["w", "e"]
        );
        // `since` only returns what came after the cursor.
        assert_eq!(logs.since(warn_seq, LogLevel::Debug).len(), 1);
    }

    #[test]
    fn jsonl_round_trips() {
        let logs = ring();
        logs.log(LogLevel::Info, LogSource::Engine, "engine_start", "2 ports");
        logs.log(LogLevel::Error, LogSource::Ui, "send_failed", "port not open");
        let dir = std::env::temp_dir().join(format!("bforge-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("capture.bflog.activity.jsonl");
        let count = logs.write_jsonl(&path).unwrap();
        assert_eq!(count, 2);

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<LogEntry> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines[0].event, "engine_start");
        assert_eq!(lines[1].source, LogSource::Ui);
        assert_eq!(lines[1].level, LogLevel::Error);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn client_post_deserializes_lowercase_levels() {
        let level: LogLevel = serde_json::from_str("\"warn\"").unwrap();
        assert_eq!(level, LogLevel::Warn);
        let source: LogSource = serde_json::from_str("\"ui\"").unwrap();
        assert_eq!(source, LogSource::Ui);
    }
}
