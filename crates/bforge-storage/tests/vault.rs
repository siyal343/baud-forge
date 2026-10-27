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
