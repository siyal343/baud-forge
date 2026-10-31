//! `.bflog` writer and reader round trips.

use bforge_hal::{Direction, PinStateFlags};
use bforge_storage::{
    HEADER_LEN, INDEX_STRIDE, LogHeader, LogReader, LogWriter, RECORD_HEADER_LEN, RawChunk,
    StorageError,
};

fn header() -> LogHeader {
    LogHeader {
        session_id: 0x0123_4567_89ab_cdef_0123_4567_89ab_cdef,
        start_epoch_ns: 1_700_000_000_000_000_000,
        config_hash: 0xfeed_face,
        port_table_offset: 256,
    }
}

fn chunk(seq: u64, len: usize) -> RawChunk {
    RawChunk {
        seq_id: seq,
        timestamp_ns: 1_000_000 + seq * 53_000,
        port_id: (seq % 4) as u16,
        direction: Direction::Rx,
        line_state: PinStateFlags::CTS,
        payload_offset: 0,
        payload_len: len as u32,
    }
}

fn payload(seq: u64, len: usize) -> Vec<u8> {
    (0..len).map(|index| (seq as u8) ^ (index as u8)).collect()
}

fn temp_path(name: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("bforge-test-{}-{}", std::process::id(), name));
    let _ = std::fs::remove_file(&path);
    path
}

fn write_session(path: &std::path::Path, count: u64, len: usize) -> u64 {
    let mut writer = LogWriter::create(path, header()).unwrap();
    let mut payload_bytes = 0;
    for seq in 0..count {
        let bytes = payload(seq, len);
        payload_bytes += bytes.len() as u64;
        writer.append(&chunk(seq, len), &bytes).unwrap();
    }
    let summary = writer.seal().unwrap();
    assert_eq!(summary.chunks, count);
    assert_eq!(summary.payload_bytes, payload_bytes);
    assert_eq!(
        summary.file_bytes,
        HEADER_LEN as u64 + count * (RECORD_HEADER_LEN as u64 + len as u64)
    );
    payload_bytes
}

#[test]
fn header_roundtrip_and_foreign_file() {
    let block = header().encode();
    assert_eq!(block.len(), HEADER_LEN);
    assert_eq!(&block[0..6], &bforge_storage::MAGIC);
    assert_eq!(LogHeader::decode(&block).unwrap(), header());

    let mut foreign = block;
    foreign[0..6].copy_from_slice(b"BFLG\x02\x00");
    assert_eq!(LogHeader::decode(&foreign), Err(StorageError::BadMagic));
    assert_eq!(
        LogHeader::decode(&block[..10]),
        Err(StorageError::ShortHeader(10))
    );
}

#[test]
fn a_session_reads_back_byte_for_byte() {
    let path = temp_path("roundtrip");
    write_session(&path, 5, 300);

    let mut reader = LogReader::open(&path).unwrap();
    assert_eq!(reader.header(), header());
    assert_eq!(reader.chunks(), 5);
    assert!(!reader.damaged_tail());
    assert_eq!(reader.index_entries(), 1);

    for seq in 0..5u64 {
        let record = reader.read_at(seq).unwrap().unwrap();
        assert_eq!(record.chunk.seq_id, seq);
        assert_eq!(record.chunk.timestamp_ns, 1_000_000 + seq * 53_000);
        assert_eq!(record.chunk.port_id, (seq % 4) as u16);
        assert_eq!(record.chunk.direction, Direction::Rx);
        assert_eq!(record.chunk.line_state, PinStateFlags::CTS);
        assert_eq!(record.payload, payload(seq, 300));
        assert_eq!(
            record.chunk.payload_offset,
            HEADER_LEN as u64 + seq * (RECORD_HEADER_LEN as u64 + 300) + RECORD_HEADER_LEN as u64
        );
    }
    assert_eq!(reader.read_at(5).unwrap(), None);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_window_seeks_into_a_long_session() {
    let path = temp_path("window");
    write_session(&path, 5_000, 64);

    let mut reader = LogReader::open(&path).unwrap();
    assert_eq!(reader.chunks(), 5_000);
    // One entry at chunk 0, then one per stride: 0, 1024, 2048, 3072, 4096.
    assert_eq!(
        reader.index_entries(),
        5_000_usize.div_ceil(INDEX_STRIDE as usize)
    );

    let window = reader.window(4_990, 20).unwrap();
    assert_eq!(window.len(), 10);
    assert_eq!(window[0].chunk.seq_id, 4_990);
    assert_eq!(window[9].chunk.seq_id, 4_999);
    assert_eq!(window[0].payload, payload(4_990, 64));

    // Across an index entry, so the reader has to walk from 4096.
    let window = reader.window(4_090, 12).unwrap();
    assert_eq!(window.len(), 12);
    assert_eq!(window[0].chunk.seq_id, 4_090);
    assert_eq!(window[10].chunk.seq_id, 4_100);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_truncated_tail_is_reported_not_fatal() {
    let path = temp_path("truncated");
    write_session(&path, 3, 100);

    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    let len = file.metadata().unwrap().len();
    file.set_len(len - 5).unwrap();
    drop(file);

    let mut reader = LogReader::open(&path).unwrap();
    assert!(reader.damaged_tail());
    assert_eq!(reader.chunks(), 2);
    assert_eq!(reader.read_at(1).unwrap().unwrap().payload, payload(1, 100));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn records_from_two_ports_keep_their_own_sequences() {
    // Every port starts its sequence at zero, so the file holds two records with
    // seq_id 0. The seek key is the record ordinal, not the sequence.
    let path = temp_path("two-ports");
    let mut writer = LogWriter::create(&path, header()).unwrap();
    for seq in 0..2u64 {
        for port in 0..2u16 {
            let mut record = chunk(seq, 16);
            record.port_id = port;
            writer
                .append(&record, &payload(seq + u64::from(port) * 10, 16))
                .unwrap();
        }
    }
    writer.seal().unwrap();

    let mut reader = LogReader::open(&path).unwrap();
    assert_eq!(reader.chunks(), 4);
    let window = reader.window(0, 4).unwrap();
    let seen: Vec<(u16, u64)> = window
        .iter()
        .map(|record| (record.chunk.port_id, record.chunk.seq_id))
        .collect();
    assert_eq!(seen, vec![(0, 0), (1, 0), (0, 1), (1, 1)]);
    assert_eq!(window[1].payload, payload(10, 16));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn chunks_carry_every_direction() {
    let path = temp_path("directions");
    let mut writer = LogWriter::create(&path, header()).unwrap();
    let directions = [
        Direction::Rx,
        Direction::Tx,
        Direction::MitmAToB,
        Direction::MitmBToA,
        Direction::InjectedFault,
    ];
    for (seq, direction) in directions.iter().enumerate() {
        let mut record = chunk(seq as u64, 8);
        record.direction = *direction;
        writer.append(&record, &payload(seq as u64, 8)).unwrap();
    }
    writer.seal().unwrap();

    let mut reader = LogReader::open(&path).unwrap();
    for (seq, direction) in directions.iter().enumerate() {
        let record = reader.read_at(seq as u64).unwrap().unwrap();
        assert_eq!(record.chunk.direction, *direction);
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn the_saved_index_opens_without_scanning() {
    let path = temp_path("persisted-index");
    write_session(&path, 3_000, 64);

    let index_file = bforge_storage::index_path(&path);
    assert!(index_file.exists(), "the writer must save an index");

    let mut reader = LogReader::open(&path).unwrap();
    assert_eq!(
        reader.index_source(),
        bforge_storage::IndexSource::Persisted
    );
    assert_eq!(reader.chunks(), 3_000);
    assert_eq!(reader.payload_bytes(), 3_000 * 64);
    let window = reader.window(2_990, 10).unwrap();
    assert_eq!(window.len(), 10);
    assert_eq!(window[0].payload, payload(2_990, 64));

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(index_file);
}

#[test]
fn a_stale_index_falls_back_to_a_scan() {
    let path = temp_path("stale-index");
    write_session(&path, 1_500, 32);
    let index_file = bforge_storage::index_path(&path);

    // Append bytes after the seal: the index no longer describes this file.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    use std::io::Write as _;
    file.write_all(&[0u8; 16]).unwrap();
    drop(file);

    let reader = LogReader::open(&path).unwrap();
    assert_eq!(reader.index_source(), bforge_storage::IndexSource::Scanned);
    assert!(reader.damaged_tail());
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(index_file);
}

#[test]
fn repair_truncates_a_partial_tail_and_keeps_the_records() {
    let path = temp_path("repair");
    write_session(&path, 4, 100);
    let index_file = bforge_storage::index_path(&path);

    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    let full = file.metadata().unwrap().len();
    file.set_len(full - 37).unwrap();
    drop(file);

    let report = bforge_storage::repair(&path).unwrap();
    assert_eq!(report.kept_chunks, 3);
    // The fourth record keeps 95 of its 132 bytes, so 95 bytes are removed.
    assert_eq!(report.removed_bytes, 95);
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        256 + 3 * (32 + 100)
    );
    assert!(!index_file.exists(), "a repair invalidates the saved index");

    let reader = LogReader::open(&path).unwrap();
    assert!(!reader.damaged_tail());
    assert_eq!(reader.chunks(), 3);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn every_truncation_point_recovers_to_whole_records() {
    let path = temp_path("truncation-sweep");
    write_session(&path, 5, 40);
    let good = std::fs::read(&path).unwrap();
    let record_len = 32 + 40;

    for cut in 0..=good.len() {
        let _ = std::fs::write(&path, &good[..cut]);
        let _ = std::fs::remove_file(bforge_storage::index_path(&path));

        if cut < 256 {
            // No header, so the file is not a vault and there is nothing to keep.
            assert!(LogReader::open(&path).is_err(), "cut at {cut}");
            assert!(bforge_storage::repair(&path).is_err(), "cut at {cut}");
            continue;
        }

        let complete = (cut - 256) / record_len;
        let reader = LogReader::open(&path).unwrap();
        assert_eq!(reader.chunks(), complete as u64, "cut at {cut}");

        let report = bforge_storage::repair(&path).unwrap();
        assert_eq!(report.kept_chunks, complete as u64, "cut at {cut}");
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            (256 + complete * record_len) as u64,
            "cut at {cut}"
        );
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn repairing_a_healthy_vault_changes_nothing() {
    let path = temp_path("repair-healthy");
    write_session(&path, 2, 16);
    let before = std::fs::metadata(&path).unwrap().len();
    let report = bforge_storage::repair(&path).unwrap();
    assert_eq!(report.removed_bytes, 0);
    assert_eq!(report.kept_chunks, 2);
    assert_eq!(std::fs::metadata(&path).unwrap().len(), before);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(bforge_storage::index_path(&path));
}

/// A vault that is still being written must be readable: the scrubber reads the
/// file while the recorder appends to it.
#[test]
fn a_reader_opens_a_vault_that_is_not_sealed() {
    let path = temp_path("live");
    let mut writer = LogWriter::create(&path, header()).unwrap();
    writer.append(&chunk(0, 16), &payload(0, 16)).unwrap();
    writer.append(&chunk(1, 16), &payload(1, 16)).unwrap();
    // No seal: the file is still open, which is the live case. A flush is what the
    // session does on every pump so a scrubber sees the records.
    writer.flush().unwrap();

    let mut reader = LogReader::open(&path).expect("a live vault opens");
    assert_eq!(reader.chunks(), 2, "the writer's records are visible");
    let window = reader.window(0, 10).unwrap();
    assert_eq!(window.len(), 2);

    // Appending more is visible to a fresh reader.
    writer.append(&chunk(2, 16), &payload(2, 16)).unwrap();
    writer.flush().unwrap();
    let reader = LogReader::open(&path).expect("it still opens");
    assert_eq!(reader.chunks(), 3);

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(bforge_storage::index_path(&path));
}

/// A timeline in seconds seeks by time, not by record number.
#[test]
fn a_time_seek_lands_on_the_first_record_at_or_after_it() {
    let path = temp_path("seek-time");
    // One record every 10 ms, timestamps from the writer's clock.
    let mut writer = LogWriter::create(&path, header()).unwrap();
    for seq in 0..50u64 {
        let mut chunk = chunk(seq, 8);
        chunk.timestamp_ns = seq * 10_000_000;
        writer.append(&chunk, &payload(seq, 8)).unwrap();
    }
    writer.seal().unwrap();

    let mut reader = LogReader::open(&path).expect("opens");
    assert_eq!(reader.last_timestamp_ns(), 49 * 10_000_000);

    // Exactly on a record.
    assert_eq!(reader.seek_time(10 * 10_000_000).unwrap(), Some(10));
    // Between records: the next one.
    assert_eq!(reader.seek_time(105_000_000).unwrap(), Some(11));
    // Before the first: the first.
    assert_eq!(reader.seek_time(0).unwrap(), Some(0));
    // Past the end: the last record, so a slider stays usable.
    assert_eq!(reader.seek_time(99_000_000_000).unwrap(), Some(49));

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(bforge_storage::index_path(&path));
}
