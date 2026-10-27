//! Three-stage pipeline: transport to slab to fan-out (ADR-002, S1).
//!
//! One reader thread per port owns the transport. It reads into a recycled 64 KB
//! slab and hands an `Arc<Slab>` to one wait-free ring per consumer.
//!
//! Overrun policy, decided in `specs/0002-spmc-pipeline.md`:
//!
//! - consumer 0 is the disk logger. Its ring never drops. The reader waits for a
//!   free slot, and the wait is counted in `stalls_ns`.
//! - every other consumer may fall behind. A full ring costs one overrun count
//!   and no bytes from the logger.

use crate::slab::{ChunkMeta, DEFAULT_SLAB_BYTES, Slab, SlabPool};
use bforge_hal::{Direction, TransportDriver};
use rtrb::{Consumer, Producer, PushError, RingBuffer};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Default ring depth per consumer. At 1.2 MB/s a slab is about 53 ms of data,
/// so 256 slots is more than ten seconds of slack before the logger stalls.
pub const DEFAULT_QUEUE_CHUNKS: usize = 256;

/// Sleep used when the transport has nothing to give.
const IDLE_SLEEP: Duration = Duration::from_micros(200);

/// How one pipeline is built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PipelineConfig {
    pub port_id: u16,
    pub slab_bytes: usize,
    pub queue_chunks: usize,
    /// Consumer 0 is the blocking logger, the rest drop on a full ring.
    pub consumers: usize,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            port_id: 0,
            slab_bytes: DEFAULT_SLAB_BYTES,
            queue_chunks: DEFAULT_QUEUE_CHUNKS,
            consumers: 2,
        }
    }
}

/// Counters for one pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PipelineStats {
    pub chunks: u64,
    pub bytes: u64,
    /// Slabs dropped because a non-logger consumer was full.
    pub overruns: u64,
    /// Time the reader spent waiting for the logger ring.
    pub stalls_ns: u64,
    pub read_errors: u64,
}

impl PipelineStats {
    pub fn bytes_per_sec(&self, elapsed: Duration) -> u64 {
        if elapsed.is_zero() {
            return 0;
        }
        (self.bytes as f64 / elapsed.as_secs_f64()) as u64
    }
}

#[derive(Debug, Default)]
struct Counters {
    chunks: AtomicU64,
    bytes: AtomicU64,
    overruns: AtomicU64,
    stalls_ns: AtomicU64,
    read_errors: AtomicU64,
}

impl Counters {
    fn snapshot(&self) -> PipelineStats {
        PipelineStats {
            chunks: self.chunks.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            overruns: self.overruns.load(Ordering::Relaxed),
            stalls_ns: self.stalls_ns.load(Ordering::Relaxed),
            read_errors: self.read_errors.load(Ordering::Relaxed),
        }
    }
}

/// A running pipeline. Drop it, or call [`Pipeline::stop`], to stop the reader.
pub struct Pipeline {
    consumers: Vec<Consumer<Arc<Slab>>>,
    counters: Arc<Counters>,
    stop: Arc<AtomicBool>,
    started: Instant,
    thread: Option<JoinHandle<()>>,
}

impl Pipeline {
    /// Start the reader thread. The transport is opened by the thread itself.
    pub fn start(config: PipelineConfig, transport: Box<dyn TransportDriver + Send>) -> Self {
        assert!(config.consumers >= 1, "a pipeline needs a logger ring");
        assert!(config.queue_chunks >= 1, "the ring cannot be empty");

        let mut producers = Vec::with_capacity(config.consumers);
        let mut consumers = Vec::with_capacity(config.consumers);
        for _ in 0..config.consumers {
            let (producer, consumer) = RingBuffer::new(config.queue_chunks);
            producers.push(producer);
            consumers.push(consumer);
        }

        let pool = SlabPool::new(config.queue_chunks * config.consumers, config.slab_bytes);
        let counters = Arc::new(Counters::default());
        let stop = Arc::new(AtomicBool::new(false));
        let reader_counters = Arc::clone(&counters);
        let reader_stop = Arc::clone(&stop);
        let port_id = config.port_id;

        let thread = thread::Builder::new()
            .name(format!("bforge-reader-{port_id}"))
            .spawn(move || {
                read_loop(
                    transport,
                    pool,
                    producers,
                    reader_counters,
                    reader_stop,
                    port_id,
                )
            })
            .expect("reader thread");

        Self {
            consumers,
            counters,
            stop,
            started: Instant::now(),
            thread: Some(thread),
        }
    }

    /// Take the consumer ends. Call this once, before consuming.
    pub fn take_consumers(&mut self) -> Vec<Consumer<Arc<Slab>>> {
        std::mem::take(&mut self.consumers)
    }

    pub fn stats(&self) -> PipelineStats {
        self.counters.snapshot()
    }

    /// Elapsed time since the pipeline started, for rate calculations.
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Stop the reader and wait for it. Safe to call once.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn read_loop(
    mut transport: Box<dyn TransportDriver + Send>,
    mut pool: SlabPool,
    mut producers: Vec<Producer<Arc<Slab>>>,
    counters: Arc<Counters>,
    stop: Arc<AtomicBool>,
    port_id: u16,
) {
    if transport.open().is_err() {
        counters.read_errors.fetch_add(1, Ordering::Relaxed);
        return;
    }

    let clock = Instant::now();
    let mut seq_id = 0u64;

    // On stop, a slab that is still waiting for the logger ring is abandoned.
    // Nobody is left to read it, and the wait must not outlive the session.
    'read: while !stop.load(Ordering::Relaxed) {
        let mut buffer = pool.take();
        let read = transport.read_slab(&mut buffer);
        let len = match read {
            Ok(0) => {
                thread::sleep(IDLE_SLEEP);
                continue;
            }
            Ok(len) => len,
            Err(_) => {
                counters.read_errors.fetch_add(1, Ordering::Relaxed);
                thread::sleep(IDLE_SLEEP);
                continue;
            }
        };
        buffer.truncate(len);

        let meta = ChunkMeta {
            seq_id,
            timestamp_ns: clock.elapsed().as_nanos() as u64,
            port_id,
            direction: Direction::Rx,
            line_state: transport.read_pins().unwrap_or_default(),
            len: len as u32,
        };
        seq_id += 1;
        counters.chunks.fetch_add(1, Ordering::Relaxed);
        counters.bytes.fetch_add(len as u64, Ordering::Relaxed);

        let slab = Arc::new(Slab::new(meta, buffer, Some(pool.recycle_handle())));

        for (index, producer) in producers.iter_mut().enumerate() {
            let mut item = Arc::clone(&slab);
            loop {
                match producer.push(item) {
                    Ok(()) => break,
                    Err(PushError::Full(returned)) => {
                        if index == 0 {
                            if stop.load(Ordering::Relaxed) {
                                break 'read;
                            }
                            // The logger must not lose a byte: wait for a slot.
                            item = returned;
                            let wait_started = Instant::now();
                            thread::yield_now();
                            counters.stalls_ns.fetch_add(
                                wait_started.elapsed().as_nanos() as u64,
                                Ordering::Relaxed,
                            );
                        } else {
                            counters.overruns.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                    }
                }
            }
        }

        drop(slab);
    }

    transport.close();
}
