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
use bforge_hal::{Direction, PortState, TransportDriver, TransportError};
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

/// How often the reader tries to reopen a port that left the bus. Fast at first,
/// because a cable is usually plugged straight back in, then gentle so a port that
/// stays away for a minute does not spin a core. Five milliseconds is the ceiling
/// that keeps a re-enumerated port usable within the 10 ms requirement, once the
/// 1 ms open call is added.
const RECONNECT_POLL_FAST: Duration = Duration::from_millis(2);
const RECONNECT_POLL_SLOW: Duration = Duration::from_millis(5);
/// After this many fast attempts the reader slows down.
const RECONNECT_FAST_ATTEMPTS: u32 = 500;
/// How many reopen attempts before the reader gives up. 1 200 attempts at 5 ms is
/// six seconds, which covers a re-enumeration and a slow hub.
const RECONNECT_ATTEMPTS: u32 = 1_200;

/// Pipeline state codes, kept as numbers so the reader thread can publish them.
const STATE_CLOSED: u64 = 0;
const STATE_OPEN: u64 = 1;
const STATE_RECONNECTING: u64 = 2;
const STATE_YIELDED: u64 = 3;

/// How often a yielded port tries to take the handle back.
const YIELD_RECLAIM_POLL: Duration = Duration::from_millis(50);

/// How one pipeline is built.
///
/// A transport that leaves the bus and comes back is reopened by the reader, not
/// by the caller: the reader owns the handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PipelineConfig {
    pub port_id: u16,
    pub slab_bytes: usize,
    pub queue_chunks: usize,
    /// Consumer 0 is the blocking logger, the rest drop on a full ring.
    pub consumers: usize,
    /// Reopen attempts after a disconnect before the reader stops.
    pub reconnect_attempts: u32,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            port_id: 0,
            slab_bytes: DEFAULT_SLAB_BYTES,
            queue_chunks: DEFAULT_QUEUE_CHUNKS,
            consumers: 2,
            reconnect_attempts: RECONNECT_ATTEMPTS,
        }
    }
}

/// Counters for one pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PipelineStats {
    /// Where the transport is: open, reconnecting, or closed.
    pub state: PortState,
    /// How many times the reader reopened the port after a disconnect.
    pub reconnects: u64,
    /// How many times the reader released the port on request.
    pub yields: u64,
    /// How long the port was away, from the first reopen attempt to the
    /// successful open. It includes the time a person took to plug the cable back
    /// in, so it measures the outage, not our reaction to it.
    pub last_reconnect_ms: u64,
    /// How long the successful `open` call itself took. With the poll interval,
    /// this is what stands between a re-enumerated device and a live port.
    pub last_open_ms: u64,
    /// Pins and error bits from the most recent chunk.
    pub line_state: u16,
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

/// A request to let another program use the port, published by the control plane
/// and taken by the reader thread.
#[derive(Debug, Default)]
pub struct YieldRequest {
    /// Milliseconds of requested window, counted from the request.
    window_ms: AtomicU64,
    pending: AtomicBool,
}

impl YieldRequest {
    /// Ask the reader to release the handle for `duration`.
    pub fn request(&self, duration: Duration) {
        self.window_ms
            .store(duration.as_millis() as u64, Ordering::Relaxed);
        self.pending.store(true, Ordering::Release);
    }

    /// The reader's side: take a pending request and its window.
    fn take(&self) -> Option<Duration> {
        if !self.pending.swap(false, Ordering::Acquire) {
            return None;
        }
        Some(Duration::from_millis(
            self.window_ms.load(Ordering::Relaxed),
        ))
    }
}

/// Everything the reader thread needs to publish.
#[derive(Debug, Default)]
struct ReaderContext {
    counters: Arc<Counters>,
    stop: Arc<AtomicBool>,
    yield_request: Arc<YieldRequest>,
    port_id: u16,
    reconnect_attempts: u32,
}

#[derive(Debug, Default)]
struct Counters {
    state: AtomicU64,
    reconnects: AtomicU64,
    yields: AtomicU64,
    last_reconnect_ms: AtomicU64,
    last_open_ms: AtomicU64,
    line_state: AtomicU64,
    chunks: AtomicU64,
    bytes: AtomicU64,
    overruns: AtomicU64,
    stalls_ns: AtomicU64,
    read_errors: AtomicU64,
}

impl Counters {
    fn snapshot(&self) -> PipelineStats {
        PipelineStats {
            state: match self.state.load(Ordering::Relaxed) {
                STATE_OPEN => PortState::Open,
                STATE_RECONNECTING => PortState::Reconnecting,
                STATE_YIELDED => PortState::Yielded,
                _ => PortState::Closed,
            },
            reconnects: self.reconnects.load(Ordering::Relaxed),
            yields: self.yields.load(Ordering::Relaxed),
            last_reconnect_ms: self.last_reconnect_ms.load(Ordering::Relaxed),
            last_open_ms: self.last_open_ms.load(Ordering::Relaxed),
            line_state: self.line_state.load(Ordering::Relaxed) as u16,
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
    yield_request: Arc<YieldRequest>,
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
        let yield_request = Arc::new(YieldRequest::default());
        let reader_yield = Arc::clone(&yield_request);
        let reader_counters = Arc::clone(&counters);
        let reader_stop = Arc::clone(&stop);
        let port_id = config.port_id;
        let reconnect_attempts = config.reconnect_attempts;

        let thread = thread::Builder::new()
            .name(format!("bforge-reader-{port_id}"))
            .spawn(move || {
                read_loop(
                    transport,
                    pool,
                    producers,
                    ReaderContext {
                        counters: reader_counters,
                        stop: reader_stop,
                        yield_request: reader_yield,
                        port_id,
                        reconnect_attempts,
                    },
                )
            })
            .expect("reader thread");

        Self {
            consumers,
            counters,
            stop,
            started: Instant::now(),
            thread: Some(thread),
            yield_request,
        }
    }

    /// Take the consumer ends. Call this once, before consuming.
    pub fn take_consumers(&mut self) -> Vec<Consumer<Arc<Slab>>> {
        std::mem::take(&mut self.consumers)
    }

    /// Ask the reader to release the port so another program can use it.
    pub fn yield_for(&self, duration: Duration) {
        self.yield_request.request(duration);
    }

    /// The handle a control plane keeps, so it can yield without touching the
    /// reader.
    pub fn yield_handle(&self) -> Arc<YieldRequest> {
        Arc::clone(&self.yield_request)
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
    context: ReaderContext,
) {
    let ReaderContext {
        counters,
        stop,
        yield_request,
        port_id,
        reconnect_attempts,
    } = context;
    if transport.open().is_err() {
        counters.read_errors.fetch_add(1, Ordering::Relaxed);
        return;
    }
    counters.state.store(STATE_OPEN, Ordering::Relaxed);

    let clock = Instant::now();
    let mut seq_id = 0u64;
    // Failed reopen attempts since the port last delivered a byte. A port that
    // opens and fails again immediately must not reset its own budget.
    let mut failed_reopens = 0u32;

    // On stop, a slab that is still waiting for the logger ring is abandoned.
    // Nobody is left to read it, and the wait must not outlive the session.
    'read: while !stop.load(Ordering::Relaxed) {
        if let Some(window) = yield_request.take() {
            counters.state.store(STATE_YIELDED, Ordering::Relaxed);
            counters.yields.fetch_add(1, Ordering::Relaxed);
            transport.close();
            yield_port(&mut transport, &counters, &stop, window);
            continue;
        }

        let mut buffer = pool.take();
        let read = transport.read_slab(&mut buffer);
        let len = match read {
            Ok(0) => {
                thread::sleep(IDLE_SLEEP);
                continue;
            }
            Ok(len) => len,
            Err(TransportError::Disconnected) => {
                counters.read_errors.fetch_add(1, Ordering::Relaxed);
                counters.state.store(STATE_RECONNECTING, Ordering::Relaxed);
                counters.reconnects.fetch_add(1, Ordering::Relaxed);
                transport.close();
                if !reopen(
                    &mut transport,
                    &counters,
                    &stop,
                    reconnect_attempts,
                    &mut failed_reopens,
                ) {
                    break 'read;
                }
                continue;
            }
            Err(_) => {
                counters.read_errors.fetch_add(1, Ordering::Relaxed);
                thread::sleep(IDLE_SLEEP);
                continue;
            }
        };
        buffer.truncate(len);
        failed_reopens = 0;

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
        counters
            .line_state
            .store(u64::from(meta.line_state.0), Ordering::Relaxed);

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
    counters.state.store(STATE_CLOSED, Ordering::Relaxed);
}

/// Release the port for the whole window, then take it back.
///
/// The reader does not poll the port while it is yielded: a poll would race the
/// flash tool for the same handle, and an open that wins that race is exactly the
/// failure the yield exists to prevent. The window is therefore the contract — the
/// flasher owns the port until it ends — and the reader takes the port back
/// afterwards with the normal reconnect patience.
fn yield_port(
    transport: &mut Box<dyn TransportDriver + Send>,
    counters: &Counters,
    stop: &AtomicBool,
    window: Duration,
) {
    let deadline = Instant::now() + window;
    while Instant::now() < deadline {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        thread::sleep(YIELD_RECLAIM_POLL.min(deadline.saturating_duration_since(Instant::now())));
    }

    for _ in 0..RECONNECT_ATTEMPTS {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if transport.open().is_ok() {
            counters.state.store(STATE_OPEN, Ordering::Relaxed);
            return;
        }
        thread::sleep(RECONNECT_POLL_FAST);
    }
    counters.state.store(STATE_RECONNECTING, Ordering::Relaxed);
}

/// Try to reopen a port that left the bus. Returns false when the port stays away
/// for longer than the attempt budget, or when the session is stopping.
fn reopen(
    transport: &mut Box<dyn TransportDriver + Send>,
    counters: &Counters,
    stop: &AtomicBool,
    attempt_budget: u32,
    failed_reopens: &mut u32,
) -> bool {
    let started = Instant::now();
    while *failed_reopens < attempt_budget {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let poll = if *failed_reopens < RECONNECT_FAST_ATTEMPTS {
            RECONNECT_POLL_FAST
        } else {
            RECONNECT_POLL_SLOW
        };
        thread::sleep(poll);
        *failed_reopens += 1;

        let open_started = Instant::now();
        if transport.open().is_ok() {
            counters
                .last_open_ms
                .store(open_started.elapsed().as_millis() as u64, Ordering::Relaxed);
            counters
                .last_reconnect_ms
                .store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
            counters.state.store(STATE_OPEN, Ordering::Relaxed);
            return true;
        }
    }
    false
}
