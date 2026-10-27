//! S2 demo, part 1: mock source to `.bflog`, then read a window back.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s2_record
//! ```

use bforge_core::pipeline::{Pipeline, PipelineConfig};
use bforge_hal::Direction;
use bforge_hal::mock::MockTransport;
use bforge_storage::{LogHeader, LogReader, LogWriter, RawChunk};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RATE: u64 = 1_200_000;
const SECONDS: u64 = 2;
const WINDOW: usize = 10;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "target/s2-mock.bflog".to_string());

    let mut pipeline = Pipeline::start(
        PipelineConfig {
            port_id: 1,
            ..Default::default()
        },
        Box::new(MockTransport::new(RATE)),
    );
    let mut consumers = pipeline.take_consumers();
    let mut logger = consumers.remove(0);

    let header = LogHeader {
        session_id: 0x5eed_0000_0000_0001_0000_0000_0000_0001,
        start_epoch_ns: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64,
        config_hash: 0,
        port_table_offset: 256,
    };
    let mut writer = LogWriter::create(&path, header).unwrap();

    let started = Instant::now();
    let mut written = 0u64;
    let mut bytes = 0u64;
    while started.elapsed() < Duration::from_secs(SECONDS) {
        match logger.pop() {
            Ok(slab) => {
                let meta = slab.meta;
                let chunk = RawChunk {
                    seq_id: meta.seq_id,
                    timestamp_ns: meta.timestamp_ns,
                    port_id: meta.port_id,
                    direction: Direction::Rx,
                    line_state: meta.line_state,
                    payload_offset: 0,
                    payload_len: meta.len,
                };
                bytes += u64::from(meta.len);
                writer.append(&chunk, slab.bytes()).unwrap();
                written += 1;
            }
            Err(_) => std::thread::yield_now(),
        }
    }
    let elapsed = started.elapsed();
    let summary = writer.seal().unwrap();
    let stats = pipeline.stats();
    pipeline.stop();

    println!(
        "recorded {} chunks, {} bytes in {:.2} s ({:.2} MB/s), overruns on the fast path {}",
        summary.chunks,
        summary.payload_bytes,
        elapsed.as_secs_f64(),
        summary.payload_bytes as f64 / elapsed.as_secs_f64() / 1_000_000.0,
        stats.overruns
    );
    println!(
        "file {}: {} bytes, {} segment(s), header magic {:?}",
        summary.path.display(),
        summary.file_bytes,
        summary.segments,
        bforge_storage::MAGIC
    );
    assert_eq!(written, summary.chunks);
    assert_eq!(bytes, summary.payload_bytes);

    let mut reader = LogReader::open(&path).unwrap();
    println!(
        "reader: {} chunks, {} payload bytes, {} index entries, damaged tail {}",
        reader.chunks(),
        reader.payload_bytes(),
        reader.index_entries(),
        reader.damaged_tail()
    );

    let last = reader.chunks().saturating_sub(WINDOW as u64);
    let window = reader.window(last, WINDOW).unwrap();
    println!(
        "\n{:>6} {:>12} {:>10} {:>6}",
        "seq", "timestamp us", "payload", "gap"
    );
    let mut expected = window.first().map(|record| record.chunk.seq_id);
    let mut gaps = 0u64;
    for record in &window {
        let payload_seq = u64::from_le_bytes(record.payload[..8].try_into().unwrap());
        let gap = expected.is_some_and(|next| record.chunk.seq_id != next);
        if gap {
            gaps += 1;
        }
        expected = Some(record.chunk.seq_id + 1);
        println!(
            "{:>6} {:>12} {:>10} {:>6}",
            record.chunk.seq_id,
            record.chunk.timestamp_ns / 1_000,
            payload_seq,
            if gap { "GAP" } else { "-" }
        );
    }
    assert_eq!(gaps, 0, "the window must be contiguous");
    println!("\nwindow of {WINDOW} read back cleanly");
}
