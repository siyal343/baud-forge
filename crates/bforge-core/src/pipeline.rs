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
    /// DTR and RTS as this session drove them.
    pub pins_out: u16,
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
struct ReaderContext {
    counters: Arc<Counters>,
    stop: Arc<AtomicBool>,
    yield_request: Arc<YieldRequest>,
    port_id: u16,
    reconnect_attempts: u32,
    /// Bytes another thread asked the reader to send. The reader owns the
    /// transport, so a write must happen on its thread, between reads.
    writes: std::sync::mpsc::Receiver<WriteRequest>,
    pins: std::sync::mpsc::Receiver<PinControl>,
}

/// One step in a timed pin sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PinStep {
    pub dtr: Option<bool>,
    pub rts: Option<bool>,
    #[serde(default)]
    pub wait_ms: u64,
}

/// Pin control message sent to the reader thread.
pub enum PinControl {
    Single(PinRequest),
    Sequence {
        steps: Vec<PinStep>,
        reply: std::sync::mpsc::Sender<Result<u16, String>>,
    },
}

impl From<PinRequest> for PinControl {
    fn from(request: PinRequest) -> Self {
        Self::Single(request)
    }
}

/// One queued write and where to report the result.
/// A request to drive DTR and RTS, optionally as a pulse.
///
/// Pin changes go through the reader thread for the same reason writes do: it owns the
/// transport. A pulse holds the reader for its duration, which is what a board that resets
/// on DTR expects, but it is why a pulse is capped at half a second.
pub struct PinRequest {
    pub pins: bforge_hal::PinStateFlags,
    /// Some when the pins must return to their previous state after this long.
    pub pulse: Option<Duration>,
    pub reply: Option<std::sync::mpsc::Sender<Result<(), String>>>,
}

pub struct WriteRequest {
    pub bytes: Vec<u8>,
    /// Hold the bytes until this moment, so a fault can add latency (D-66).
    pub due: Option<Instant>,
    /// Some when the caller waits for the result, as a person's send does.
    pub reply: Option<std::sync::mpsc::Sender<Result<usize, String>>>,
    /// Some when the caller only wants to know how much has landed, as a bridge
    /// does: no thread waits, and the counters stay honest.
    pub settled: Option<Arc<AtomicU64>>,
    /// Bytes a transport refused, so a wedged port is visible without a caller.
    pub failed: Option<Arc<AtomicU64>>,
    /// Split bytes into chunks of this size. Zero means send all at once.
    pub chunk_size: usize,
    /// Pause between chunks while servicing incoming reads.
    pub pace: Duration,
}

#[derive(Debug, Default)]
struct Counters {
    state: AtomicU64,
    reconnects: AtomicU64,
    yields: AtomicU64,
    last_reconnect_ms: AtomicU64,
    last_open_ms: AtomicU64,
    line_state: AtomicU64,
    /// Pins this session drove, so a view can show the output state it set.
    pins_out: AtomicU64,
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
            pins_out: self.pins_out.load(Ordering::Relaxed) as u16,
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
    writes: std::sync::mpsc::Sender<WriteRequest>,
    pins: std::sync::mpsc::Sender<PinControl>,
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

        let (write_sender, write_receiver) = std::sync::mpsc::channel();
        let (pin_sender, pin_receiver) = std::sync::mpsc::channel();

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
                        writes: write_receiver,
                        pins: pin_receiver,
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
            writes: write_sender,
            pins: pin_sender,
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

    /// Drive DTR and RTS, and wait for the reader to report the result.
    ///
    /// `pulse` holds the pins high for that long and then clears them, which is how a
    /// board that resets on DTR is reset from the workbench.
    pub fn set_pins(
        &self,
        pins: bforge_hal::PinStateFlags,
        pulse: Option<Duration>,
        wait: Duration,
    ) -> Result<(), String> {
        let (reply, answer) = std::sync::mpsc::channel();
        self.pins
            .send(PinControl::Single(PinRequest {
                pins,
                pulse,
                reply: Some(reply),
            }))
            .map_err(|_| "the reader has stopped".to_string())?;
        answer
            .recv_timeout(wait)
            .map_err(|_| "the reader did not answer in time".to_string())?
    }

    /// Run a timed sequence of pin changes on the reader thread.
    ///
    /// Steps execute in order. Between steps with `wait_ms > 0`, the reader
    /// thread continues servicing reads so bootloader banners and incoming bytes
    /// are captured into the logger ring. Returns the final `pins_out` bitmask.
    pub fn run_pin_sequence(&self, steps: Vec<PinStep>) -> Result<u16, String> {
        let total_wait_ms: u64 = steps.iter().map(|step| step.wait_ms).sum();
        let wait = Duration::from_millis(total_wait_ms) + Duration::from_secs(5);
        let (reply, answer) = std::sync::mpsc::channel();
        self.pins
            .send(PinControl::Sequence { steps, reply })
            .map_err(|_| "the reader has stopped".to_string())?;
        answer
            .recv_timeout(wait)
            .map_err(|_| "the reader did not answer in time".to_string())?
    }

    /// Queue bytes for the port and wait for the reader to report the result.
    ///
    /// The reader owns the transport, so this cannot write directly: a second
    /// writer on a serial port is exactly the race the reader exists to prevent.
    pub fn write(&self, bytes: Vec<u8>, wait: Duration) -> Result<usize, String> {
        let (reply, answer) = std::sync::mpsc::channel();
        self.writes
            .send(WriteRequest {
                bytes,
                due: None,
                reply: Some(reply),
                settled: None,
                failed: None,
                chunk_size: 0,
                pace: Duration::ZERO,
            })
            .map_err(|_| "the reader has stopped".to_string())?;
        answer
            .recv_timeout(wait)
            .map_err(|_| "the reader did not answer in time".to_string())?
    }

    /// Queue bytes with pacing between chunks on the reader thread.
    ///
    /// When `chunk_size > 0` and `bytes.len() > chunk_size`, the write is split
    /// into chunks with `pace` delay between them. The reader services reads
    /// during pauses so full-duplex echoes are not dropped.
    pub fn write_paced(
        &self,
        bytes: Vec<u8>,
        chunk_size: usize,
        pace: Duration,
        wait: Duration,
    ) -> Result<usize, String> {
        let (reply, answer) = std::sync::mpsc::channel();
        self.writes
            .send(WriteRequest {
                bytes,
                due: None,
                reply: Some(reply),
                settled: None,
                failed: None,
                chunk_size,
                pace,
            })
            .map_err(|_| "the reader has stopped".to_string())?;
        answer
            .recv_timeout(wait)
            .map_err(|_| "the reader did not answer in time".to_string())?
    }

    /// Queue bytes without waiting. The reader writes them when it can, so a
    /// forwarding bridge never holds the pump hostage to one port.
    pub fn post(
        &self,
        bytes: Vec<u8>,
        settled: Arc<AtomicU64>,
        failed: Arc<AtomicU64>,
    ) -> Result<(), String> {
        self.post_after(bytes, settled, failed, None)
    }

    /// Post bytes that must leave at `due`, so a fault can add latency without
    /// blocking the reader: it holds them until the deadline and keeps reading.
    pub fn post_after(
        &self,
        bytes: Vec<u8>,
        settled: Arc<AtomicU64>,
        failed: Arc<AtomicU64>,
        due: Option<Duration>,
    ) -> Result<(), String> {
        self.writes
            .send(WriteRequest {
                bytes,
                due: due.map(|delay| Instant::now() + delay),
                reply: None,
                settled: Some(settled),
                failed: Some(failed),
                chunk_size: 0,
                pace: Duration::ZERO,
            })
            .map_err(|_| "the reader has stopped".to_string())
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
        writes,
        pins,
    } = context;
    // A port that is not there yet is not a failure: a window opened before the
    // board is plugged in must recover, so the first open gets the same patience as
    // a reconnect.
    if transport.open().is_err() {
        counters.read_errors.fetch_add(1, Ordering::Relaxed);
        counters.state.store(STATE_RECONNECTING, Ordering::Relaxed);
        let mut failed = 0;
        if !reopen(
            &mut transport,
            &counters,
            &stop,
            reconnect_attempts,
            &mut failed,
        ) {
            counters.state.store(STATE_CLOSED, Ordering::Relaxed);
            return;
        }
    }
    counters.state.store(STATE_OPEN, Ordering::Relaxed);

    let clock = Instant::now();
    let mut seq_id = 0u64;
    // Failed reopen attempts since the port last delivered a byte. A port that
    // opens and fails again immediately must not reset its own budget.
    let mut failed_reopens = 0u32;
    // Writes a fault asked to delay, oldest deadline first.
    let mut held: Vec<(Instant, WriteRequest)> = Vec::new();

    let mut state = ReaderLoopState {
        transport: &mut transport,
        pool: &mut pool,
        producers: &mut producers,
        counters: &counters,
        stop: &stop,
        port_id,
        clock,
        seq_id: &mut seq_id,
        failed_reopens: &mut failed_reopens,
        reconnect_attempts,
    };

    // On stop, a slab that is still waiting for the logger ring is abandoned.
    // Nobody is left to read it, and the wait must not outlive the session.
    'read: while !stop.load(Ordering::Relaxed) {
        while let Ok(control) = pins.try_recv() {
            match control {
                PinControl::Single(request) => {
                    set_pins_one(&mut **state.transport, &counters, request, &stop);
                }
                PinControl::Sequence { steps, reply } => {
                    if !state.run_pin_sequence(steps, reply) {
                        break 'read;
                    }
                }
            }
        }
        // Delayed writes wait here, so a deadline never blocks the read path.
        while let Ok(request) = writes.try_recv() {
            match request.due {
                Some(due) if due > Instant::now() => held.push((due, request)),
                _ => {
                    if !state.write_one(request) {
                        break 'read;
                    }
                }
            }
        }
        if !held.is_empty() {
            let now = Instant::now();
            let mut still = Vec::with_capacity(held.len());
            let mut iter = std::mem::take(&mut held).into_iter();
            while let Some((due, request)) = iter.next() {
                if due <= now {
                    if !state.write_one(request) {
                        still.extend(iter);
                        held = still;
                        break 'read;
                    }
                } else {
                    still.push((due, request));
                }
            }
            if !stop.load(Ordering::Relaxed) {
                held = still;
            }
        }
        if let Some(window) = yield_request.take() {
            counters.state.store(STATE_YIELDED, Ordering::Relaxed);
            counters.yields.fetch_add(1, Ordering::Relaxed);
            state.transport.close();
            yield_port(state.transport, &counters, &stop, window);
            continue;
        }

        if !state.pump_one_slab() {
            break 'read;
        }
    }

    for (_, request) in held.drain(..) {
        if let Some(failed) = &request.failed {
            failed.fetch_add(request.bytes.len() as u64, Ordering::Relaxed);
        }
        if let Some(reply) = request.reply {
            let _ = reply.send(Err("the session stopped before the delay ended".to_string()));
        }
    }
    transport.close();
    counters.state.store(STATE_CLOSED, Ordering::Relaxed);
}

struct ReaderLoopState<'a> {
    transport: &'a mut Box<dyn TransportDriver + Send>,
    pool: &'a mut SlabPool,
    producers: &'a mut [Producer<Arc<Slab>>],
    counters: &'a Counters,
    stop: &'a AtomicBool,
    port_id: u16,
    clock: Instant,
    seq_id: &'a mut u64,
    failed_reopens: &'a mut u32,
    reconnect_attempts: u32,
}

impl ReaderLoopState<'_> {
    fn pump_one_slab(&mut self) -> bool {
        let mut buffer = self.pool.take();
        let read = self.transport.read_slab(&mut buffer);
        let len = match read {
            Ok(0) => {
                thread::sleep(IDLE_SLEEP);
                return true;
            }
            Ok(len) => len,
            Err(TransportError::Disconnected) => {
                self.counters.read_errors.fetch_add(1, Ordering::Relaxed);
                self.counters
                    .state
                    .store(STATE_RECONNECTING, Ordering::Relaxed);
                self.counters.reconnects.fetch_add(1, Ordering::Relaxed);
                self.transport.close();
                if !reopen(
                    self.transport,
                    self.counters,
                    self.stop,
                    self.reconnect_attempts,
                    self.failed_reopens,
                ) {
                    return false;
                }
                return true;
            }
            Err(_) => {
                self.counters.read_errors.fetch_add(1, Ordering::Relaxed);
                thread::sleep(IDLE_SLEEP);
                return true;
            }
        };
        buffer.truncate(len);
        *self.failed_reopens = 0;

        let meta = ChunkMeta {
            seq_id: *self.seq_id,
            timestamp_ns: self.clock.elapsed().as_nanos() as u64,
            port_id: self.port_id,
            direction: Direction::Rx,
            line_state: self.transport.read_pins().unwrap_or_default(),
            len: len as u32,
        };
        *self.seq_id += 1;
        self.counters.chunks.fetch_add(1, Ordering::Relaxed);
        self.counters.bytes.fetch_add(len as u64, Ordering::Relaxed);
        self.counters
            .line_state
            .store(u64::from(meta.line_state.0), Ordering::Relaxed);

        let slab = Arc::new(Slab::new(meta, buffer, Some(self.pool.recycle_handle())));

        for (index, producer) in self.producers.iter_mut().enumerate() {
            let mut item = Arc::clone(&slab);
            loop {
                match producer.push(item) {
                    Ok(()) => break,
                    Err(PushError::Full(returned)) => {
                        if index == 0 {
                            if self.stop.load(Ordering::Relaxed) {
                                return false;
                            }
                            item = returned;
                            let wait_started = Instant::now();
                            thread::sleep(IDLE_SLEEP);
                            self.counters.stalls_ns.fetch_add(
                                wait_started.elapsed().as_nanos() as u64,
                                Ordering::Relaxed,
                            );
                        } else {
                            self.counters.overruns.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                    }
                }
            }
        }
        true
    }

    fn wait_servicing_reads(&mut self, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            if self.stop.load(Ordering::Relaxed) {
                return false;
            }
            if !self.pump_one_slab() {
                return false;
            }
        }
        true
    }

    fn run_pin_sequence(
        &mut self,
        steps: Vec<PinStep>,
        reply: std::sync::mpsc::Sender<Result<u16, String>>,
    ) -> bool {
        let mut current_pins =
            bforge_hal::PinStateFlags(self.counters.pins_out.load(Ordering::Relaxed) as u16);
        for step in steps {
            if self.stop.load(Ordering::Relaxed) {
                let _ = reply.send(Err("the reader stopped during pin sequence".to_string()));
                return false;
            }
            if let Some(dtr) = step.dtr {
                if dtr {
                    current_pins.insert(bforge_hal::PinStateFlags::DTR);
                } else {
                    current_pins.0 &= !bforge_hal::PinStateFlags::DTR.0;
                }
            }
            if let Some(rts) = step.rts {
                if rts {
                    current_pins.insert(bforge_hal::PinStateFlags::RTS);
                } else {
                    current_pins.0 &= !bforge_hal::PinStateFlags::RTS.0;
                }
            }
            if let Err(error) = self.transport.set_pins(current_pins) {
                self.counters.read_errors.fetch_add(1, Ordering::Relaxed);
                let _ = reply.send(Err(error.to_string()));
                return true;
            }
            self.counters
                .pins_out
                .store(u64::from(current_pins.0), Ordering::Relaxed);

            if step.wait_ms > 0 {
                let wait_dur = Duration::from_millis(step.wait_ms);
                if !self.wait_servicing_reads(wait_dur) {
                    let _ = reply.send(Err(
                        "the reader stopped during pin sequence wait".to_string()
                    ));
                    return false;
                }
            }
        }
        let final_pins = self.counters.pins_out.load(Ordering::Relaxed) as u16;
        let _ = reply.send(Ok(final_pins));
        true
    }

    fn write_one(&mut self, request: WriteRequest) -> bool {
        if request.chunk_size > 0 && request.bytes.len() > request.chunk_size {
            let chunks: Vec<&[u8]> = request.bytes.chunks(request.chunk_size).collect();
            let total_chunks = chunks.len();
            let mut written_total = 0usize;

            for (i, chunk) in chunks.iter().enumerate() {
                if self.stop.load(Ordering::Relaxed) {
                    if let Some(failed) = &request.failed {
                        failed.fetch_add(
                            (request.bytes.len() - written_total) as u64,
                            Ordering::Relaxed,
                        );
                    }
                    if let Some(reply) = request.reply {
                        let _ =
                            reply.send(Err("the reader stopped during paced write".to_string()));
                    }
                    return false;
                }

                match self.transport.write_frame(chunk) {
                    Ok(()) => {
                        written_total += chunk.len();
                        if let Some(settled) = &request.settled {
                            settled.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                        }
                    }
                    Err(error) => {
                        self.counters.read_errors.fetch_add(1, Ordering::Relaxed);
                        if let Some(failed) = &request.failed {
                            failed.fetch_add(
                                (request.bytes.len() - written_total) as u64,
                                Ordering::Relaxed,
                            );
                        }
                        if let Some(reply) = request.reply {
                            let _ = reply.send(Err(error.to_string()));
                        }
                        return true;
                    }
                }

                if i + 1 < total_chunks
                    && !request.pace.is_zero()
                    && !self.wait_servicing_reads(request.pace)
                {
                    if let Some(reply) = request.reply {
                        let _ = reply.send(Err("the reader stopped during pace wait".to_string()));
                    }
                    return false;
                }
            }

            if let Some(reply) = request.reply {
                let _ = reply.send(Ok(written_total));
            }
            true
        } else {
            let written = request.bytes.len();
            match self.transport.write_frame(&request.bytes) {
                Ok(()) => {
                    if let Some(settled) = &request.settled {
                        settled.fetch_add(written as u64, Ordering::Relaxed);
                    }
                    if let Some(reply) = request.reply {
                        let _ = reply.send(Ok(written));
                    }
                }
                Err(error) => {
                    self.counters.read_errors.fetch_add(1, Ordering::Relaxed);
                    if let Some(failed) = &request.failed {
                        failed.fetch_add(written as u64, Ordering::Relaxed);
                    }
                    if let Some(reply) = request.reply {
                        let _ = reply.send(Err(error.to_string()));
                    }
                }
            }
            true
        }
    }
}

/// Drive the pins, optionally as a pulse, and answer the caller.
///
/// A pulse holds the reader for its length. That is what a board that resets on DTR
/// expects, and a pulse is capped by the caller so the read path cannot stall for long.
fn set_pins_one(
    transport: &mut (dyn TransportDriver + Send),
    counters: &Counters,
    request: PinRequest,
    stop: &AtomicBool,
) {
    let reply = request.reply;
    let mut result = transport
        .set_pins(request.pins)
        .map_err(|error| error.to_string());
    if result.is_ok() {
        counters
            .pins_out
            .store(u64::from(request.pins.0), Ordering::Relaxed);
    }
    if let Some(pulse) = request.pulse
        && result.is_ok()
    {
        let until = Instant::now() + pulse;
        while Instant::now() < until && !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(5));
        }
        // Clear only the pins this pulse set: a request that also held RTS keeps it.
        if let Err(error) = transport.set_pins(bforge_hal::PinStateFlags(0)) {
            result = Err(error.to_string());
        }
        counters.pins_out.store(0, Ordering::Relaxed);
    }
    if let Some(reply) = reply {
        let _ = reply.send(result);
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use bforge_hal::PinStateFlags;
    use bforge_hal::mock::MockTransport;
    use std::sync::Mutex;

    type PinTrace = Arc<Mutex<Vec<u16>>>;
    type WriteTrace = Arc<Mutex<Vec<Vec<u8>>>>;

    struct TracingTransport {
        mock: MockTransport,
        pin_history: PinTrace,
        write_history: WriteTrace,
    }

    impl TracingTransport {
        fn new(mock: MockTransport) -> (Self, PinTrace, WriteTrace) {
            let pin_history = Arc::new(Mutex::new(Vec::new()));
            let write_history = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    mock,
                    pin_history: Arc::clone(&pin_history),
                    write_history: Arc::clone(&write_history),
                },
                pin_history,
                write_history,
            )
        }
    }

    impl TransportDriver for TracingTransport {
        fn open(&mut self) -> Result<(), TransportError> {
            self.mock.open()
        }

        fn close(&mut self) {
            self.mock.close()
        }

        fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
            self.mock.read_slab(out)
        }

        fn write_frame(&mut self, frame: &[u8]) -> Result<(), TransportError> {
            self.write_history.lock().unwrap().push(frame.to_vec());
            self.mock.write_frame(frame)
        }

        fn set_pins(&mut self, pins: PinStateFlags) -> Result<(), TransportError> {
            self.pin_history.lock().unwrap().push(pins.0);
            self.mock.set_pins(pins)
        }

        fn read_pins(&mut self) -> Result<PinStateFlags, TransportError> {
            self.mock.read_pins()
        }

        fn state(&self) -> PortState {
            self.mock.state()
        }
    }

    #[test]
    fn a_pin_sequence_applies_steps_in_order_and_keeps_reading() {
        let config = PipelineConfig {
            port_id: 1,
            slab_bytes: 4096,
            queue_chunks: 64,
            ..Default::default()
        };
        let (transport, pin_history, _) = TracingTransport::new(MockTransport::new(500_000));
        let mut pipeline = Pipeline::start(config, Box::new(transport));
        let mut consumers = pipeline.take_consumers();
        let mut logger = consumers.remove(0);

        let steps = vec![
            PinStep {
                dtr: Some(false),
                rts: Some(true),
                wait_ms: 20,
            },
            PinStep {
                dtr: Some(true),
                rts: Some(false),
                wait_ms: 20,
            },
        ];

        let final_pins = pipeline
            .run_pin_sequence(steps)
            .expect("sequence completes");

        assert_eq!(
            final_pins & PinStateFlags::DTR.0,
            PinStateFlags::DTR.0,
            "DTR must be set at the end"
        );
        assert_eq!(
            final_pins & PinStateFlags::RTS.0,
            0,
            "RTS must be cleared at the end"
        );
        assert_eq!(pipeline.stats().pins_out, final_pins);

        let history = pin_history.lock().unwrap().clone();
        assert_eq!(
            history,
            vec![PinStateFlags::RTS.0, PinStateFlags::DTR.0],
            "pin steps must apply in specified order"
        );

        let mut read_chunks = 0;
        while let Ok(slab) = logger.pop() {
            assert!(!slab.bytes().is_empty());
            read_chunks += 1;
        }
        assert!(
            read_chunks > 0,
            "incoming bytes must still be captured into logger ring during sequence"
        );
        assert!(pipeline.stats().bytes > 0);

        pipeline.stop();
    }

    #[test]
    fn paced_write_delivers_all_chunks_without_dropping_reads() {
        let config = PipelineConfig {
            port_id: 2,
            slab_bytes: 4096,
            queue_chunks: 64,
            ..Default::default()
        };
        let (transport, _, write_history) = TracingTransport::new(MockTransport::new(500_000));
        let mut pipeline = Pipeline::start(config, Box::new(transport));
        let mut consumers = pipeline.take_consumers();
        let mut logger = consumers.remove(0);

        let data = vec![0xABu8; 250];
        let chunk_size = 100;
        let pace = Duration::from_millis(20);
        let wait = Duration::from_secs(5);

        let written = pipeline
            .write_paced(data.clone(), chunk_size, pace, wait)
            .expect("paced write succeeds");

        assert_eq!(written, 250);

        let recorded = write_history.lock().unwrap().clone();
        assert_eq!(
            recorded.len(),
            3,
            "250 bytes split by 100 must yield 3 chunks"
        );
        assert_eq!(recorded[0].len(), 100);
        assert_eq!(recorded[1].len(), 100);
        assert_eq!(recorded[2].len(), 50);
        assert_eq!(recorded.concat(), data);

        let mut read_chunks = 0;
        while let Ok(slab) = logger.pop() {
            assert!(!slab.bytes().is_empty());
            read_chunks += 1;
        }
        assert!(
            read_chunks > 0,
            "reads must continue during paced pauses without being dropped"
        );

        pipeline.stop();
    }
}
