//! S5 memory assertion (F1.6.2): read a large vault with a flat footprint.
//!
//! Builds a session of a chosen size, then reads it back in windows while sampling
//! resident memory. The claim under test is that the reader keeps a bounded
//! index and a bounded window, not the file.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s5_memory -- --size-mb 512
//! ```

use bforge_core::mem::{peak_resident_bytes, resident_bytes};
use bforge_hal::{Direction, PinStateFlags};
use bforge_storage::{LogHeader, LogReader, LogWriter, RawChunk};
use std::time::Instant;

const RSS_CEILING: u64 = 150 * 1024 * 1024;
const SLAB: usize = 64 * 1024;
const WINDOW: usize = 256;

fn parse_size() -> u64 {
    let mut args = std::env::args().skip(1);
    let mut size = 256u64;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--size-mb" => {
                size = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(size)
            }
            other => {
                eprintln!("unknown flag `{other}`");
                std::process::exit(2);
            }
        }
    }
    size
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn main() {
    let size_mb = parse_size();
    let vault = "target/s5-memory.bflog";
    let _ = std::fs::remove_file(vault);

    let records = (size_mb * 1024 * 1024) as usize / SLAB;
    println!(
        "S5 memory: building a {size_mb} MiB vault of {records} records of {} KiB",
        SLAB / 1024
    );

    let build_started = Instant::now();
    let mut writer = LogWriter::create(vault, LogHeader::default()).unwrap();
    let payload = vec![0x5Au8; SLAB];
    for seq in 0..records as u64 {
        writer
            .append(
                &RawChunk {
                    seq_id: seq,
                    timestamp_ns: seq * 53_000,
                    port_id: 0,
                    direction: Direction::Rx,
                    line_state: PinStateFlags::default(),
                    payload_offset: 0,
                    payload_len: SLAB as u32,
                },
                &payload,
            )
            .unwrap();
    }
    let summary = writer.seal().unwrap();
    println!(
        "built {:.1} MiB in {:.2} s ({:.0} MiB/s), file {} bytes",
        mib(summary.file_bytes),
        build_started.elapsed().as_secs_f64(),
        mib(summary.file_bytes) / build_started.elapsed().as_secs_f64(),
        summary.file_bytes
    );

    let file_bytes = std::fs::metadata(vault).unwrap().len();
    let baseline = resident_bytes().unwrap_or(0);
    println!("resident before open: {:.1} MiB", mib(baseline));

    let open_started = Instant::now();
    let mut reader = LogReader::open(vault).unwrap();
    let open_time = open_started.elapsed();

    let index_entries = reader.index_entries();
    let index_bytes = (index_entries * std::mem::size_of::<bforge_storage::IndexEntry>()) as u64;
    println!(
        "opened in {:.2} s: {} records, {index_entries} index entries ({:.1} KiB)",
        open_time.as_secs_f64(),
        reader.chunks(),
        mib(index_bytes) * 1024.0
    );

    // Read the whole file in order, one window at a time.
    let mut peak = baseline;
    let mut read = 0u64;
    let mut frame = 0u64;
    let scan_started = Instant::now();
    while frame < reader.chunks() {
        let window = reader.window(frame, WINDOW).unwrap();
        if window.is_empty() {
            break;
        }
        read += window
            .iter()
            .map(|record| record.payload.len() as u64)
            .sum::<u64>();
        frame += window.len() as u64;
        peak = peak.max(resident_bytes().unwrap_or(0));
    }
    let scan_time = scan_started.elapsed();
    let peak = peak_resident_bytes().unwrap_or(peak).max(peak);

    println!(
        "read {} records, {:.1} MiB of payload in {:.2} s ({:.0} MiB/s)",
        frame,
        mib(read),
        scan_time.as_secs_f64(),
        mib(read) / scan_time.as_secs_f64()
    );
    println!(
        "resident: baseline {:.1} MiB, peak {:.1} MiB, growth {:.1} MiB",
        mib(baseline),
        mib(peak),
        mib(peak.saturating_sub(baseline))
    );
    println!(
        "file is {:.1} MiB, so the peak is {:.2}% of the file",
        mib(file_bytes),
        100.0 * peak as f64 / file_bytes as f64
    );

    // Extrapolation, clearly labelled: an index entry is 24 bytes, one per 1024
    // records, so a 100 GB file of 64 KiB records needs this much.
    let records_100gb = 100u64 * 1024 * 1024 * 1024 / SLAB as u64;
    let entries_100gb = records_100gb / 1024;
    println!(
        "estimate: a 100 GB file holds {records_100gb} records and needs {} index entries, about {:.1} KiB",
        entries_100gb,
        entries_100gb as f64 * 24.0 / 1024.0
    );

    let mut ok = true;
    if peak > RSS_CEILING {
        println!(
            "FAIL: peak resident memory is above {:.1} MiB",
            mib(RSS_CEILING)
        );
        ok = false;
    }
    if read != summary.payload_bytes {
        println!(
            "FAIL: read {} bytes, the writer reported {}",
            read, summary.payload_bytes
        );
        ok = false;
    }
    println!(
        "\nRESULT: {}",
        if ok {
            "PASS - flat memory over the whole file"
        } else {
            "FAIL"
        }
    );
    if !ok {
        std::process::exit(1);
    }
}
