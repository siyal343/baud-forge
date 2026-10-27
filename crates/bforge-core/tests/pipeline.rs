//! Pipeline tests (S1). The mock transport writes a chunk sequence into the
//! first eight bytes of every slab, so a gap is detectable from the payload.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use bforge_core::pipeline::{Pipeline, PipelineConfig};
use bforge_core::slab::{ChunkMeta, Slab, SlabPool};
use bforge_hal::mock::MockTransport;
use bforge_hal::{Direction, PinStateFlags};

fn meta(len: usize) -> ChunkMeta {
    ChunkMeta {
        seq_id: 0,
        timestamp_ns: 0,
        port_id: 1,
        direction: Direction::Rx,
        line_state: PinStateFlags::default(),
        len: len as u32,
    }
}

fn payload_seq(slab: &Slab) -> u64 {
    u64::from_le_bytes(slab.bytes()[..8].try_into().unwrap())
}

#[test]
fn slab_pool_allocates_once_and_then_recycles() {
    let mut pool = SlabPool::new(4, 1024);
    for _ in 0..200 {
        let buffer = pool.take();
        assert_eq!(buffer.len(), 1024);
        let slab = Arc::new(Slab::new(meta(1024), buffer, Some(pool.recycle_handle())));
        drop(slab);
    }
    assert_eq!(
        pool.allocated(),
        1,
        "the read loop must not allocate per slab"
    );
}

#[test]
fn truncated_slab_returns_a_full_buffer_to_the_pool() {
    let mut pool = SlabPool::new(1, 1024);
    let mut buffer = pool.take();
    buffer.truncate(37);
    drop(Slab::new(meta(37), buffer, Some(pool.recycle_handle())));

    let reused = pool.take();
    assert_eq!(reused.len(), 1024);
    assert!(reused.iter().all(|byte| *byte == 0));
    assert_eq!(pool.allocated(), 1);
}

#[test]
fn logger_receives_every_chunk_in_order() {
    let config = PipelineConfig {
        port_id: 7,
        queue_chunks: 32,
        ..Default::default()
    };
    let mut pipeline = Pipeline::start(config, Box::new(MockTransport::new(0)));
    let mut consumers = pipeline.take_consumers();
    let mut logger = consumers.remove(0);

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut expected = 0u64;
    while expected < 50 {
        match logger.pop() {
            Ok(slab) => {
                assert_eq!(slab.meta.seq_id, expected);
                assert_eq!(payload_seq(&slab), expected, "payload lost its place");
                assert_eq!(slab.meta.len as usize, slab.bytes().len());
                assert_eq!(slab.meta.port_id, 7);
                expected += 1;
            }
            Err(_) => {
                assert!(Instant::now() < deadline, "stalled after {expected} chunks");
                thread::sleep(Duration::from_millis(1));
            }
        }
    }

    let stats = pipeline.stats();
    assert!(stats.chunks >= 50);
    assert!(stats.bytes >= 50 * 64 * 1024);
    assert_eq!(stats.read_errors, 0);
    pipeline.stop();
}

#[test]
fn slow_consumer_overruns_do_not_stop_the_logger() {
    let config = PipelineConfig {
        port_id: 2,
        queue_chunks: 4,
        ..Default::default()
    };
    let mut pipeline = Pipeline::start(config, Box::new(MockTransport::new(0)));
    let mut consumers = pipeline.take_consumers();
    let mut logger = consumers.remove(0);
    // The dissector end goes away, which is the worst case for a slow stage.
    drop(consumers);

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut expected = 0u64;
    while expected < 500 {
        match logger.pop() {
            Ok(slab) => {
                assert_eq!(payload_seq(&slab), expected);
                expected += 1;
            }
            Err(_) => {
                assert!(Instant::now() < deadline, "stalled after {expected} chunks");
                thread::sleep(Duration::from_millis(1));
            }
        }
    }

    let stats = pipeline.stats();
    assert!(stats.chunks >= 500);
    assert!(stats.overruns > 0, "a dead consumer must be counted");
    pipeline.stop();
}

#[test]
fn a_slow_logger_stalls_the_reader_instead_of_dropping() {
    let config = PipelineConfig {
        port_id: 3,
        queue_chunks: 2,
        consumers: 2,
        ..Default::default()
    };
    let mut pipeline = Pipeline::start(config, Box::new(MockTransport::new(0)));
    let mut consumers = pipeline.take_consumers();
    let mut logger = consumers.remove(0);
    drop(consumers);

    // Do not drain for a moment: the reader must wait, not drop.
    thread::sleep(Duration::from_millis(50));
    let blocked = pipeline.stats();
    assert!(blocked.stalls_ns > 0, "the reader must report its wait");
    assert!(
        blocked.chunks <= 8,
        "the reader must not run ahead: {}",
        blocked.chunks
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    for expected in 0..20u64 {
        loop {
            match logger.pop() {
                Ok(slab) => {
                    assert_eq!(payload_seq(&slab), expected);
                    break;
                }
                Err(_) => {
                    assert!(Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }
    pipeline.stop();
}

#[test]
fn stats_report_a_rate() {
    let config = PipelineConfig {
        port_id: 0,
        queue_chunks: 64,
        ..Default::default()
    };
    let mut pipeline = Pipeline::start(config, Box::new(MockTransport::new(0)));
    let mut consumers = pipeline.take_consumers();
    let mut logger = consumers.remove(0);

    let seen = Arc::new(AtomicU64::new(0));
    let counter = Arc::clone(&seen);
    let reader = thread::spawn(move || {
        while counter.load(Ordering::Relaxed) < 64 {
            self::thread::yield_now();
            if let Ok(_slab) = logger.pop() {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
    });
    reader.join().unwrap();

    let stats = pipeline.stats();
    let elapsed = pipeline.elapsed();
    assert!(stats.bytes_per_sec(elapsed) > 0);
    assert!(stats.bytes >= 64 * 64 * 1024);
    pipeline.stop();
}
