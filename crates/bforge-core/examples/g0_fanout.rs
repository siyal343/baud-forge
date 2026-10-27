//! Gate G0: measure the fan-out primitive before the pipeline depends on it.
//!
//! One producer hands the same 64 KB payload handle to two consumers. One
//! consumer simulates a disk logger with a short flush every eight chunks; the
//! second consumes without delay. The report gives the time the producer could
//! not hand off, which is the number the 0-dropped-bytes rule depends on.
//!
//! ```sh
//! cargo run -p bforge-core --release --example g0_fanout
//! ```

use std::sync::Arc;
use std::sync::mpsc::{TryRecvError, sync_channel};
use std::thread;
use std::time::{Duration, Instant};

const PAYLOAD: usize = 64 * 1024;
const CHUNKS: usize = 2048;
const QUEUE: usize = 16;
const FLUSH_EVERY: usize = 8;
const FLUSH_TIME: Duration = Duration::from_micros(200);

struct Report {
    name: &'static str,
    elapsed: Duration,
    max_stall: Duration,
    total_stall: Duration,
}

impl Report {
    fn mib_per_s(&self) -> f64 {
        let mib = (CHUNKS * PAYLOAD) as f64 / (1024.0 * 1024.0);
        mib / self.elapsed.as_secs_f64()
    }

    fn chunks_per_s(&self) -> f64 {
        CHUNKS as f64 / self.elapsed.as_secs_f64()
    }
}

fn touch(payload: &[u8]) -> u64 {
    payload.iter().step_by(64).map(|b| *b as u64).sum()
}

fn payload(id: usize) -> Arc<Vec<u8>> {
    Arc::new(vec![id as u8; PAYLOAD])
}

fn report(
    name: &'static str,
    started: Instant,
    max_stall: Duration,
    total_stall: Duration,
) -> Report {
    Report {
        name,
        elapsed: started.elapsed(),
        max_stall,
        total_stall,
    }
}

/// rtrb: one wait-free ring per consumer, exactly the topology in ADR-002.
fn bench_rtrb() -> Report {
    let (mut to_logger, mut logger) = rtrb::RingBuffer::<Arc<Vec<u8>>>::new(QUEUE);
    let (mut to_dissector, mut dissector) = rtrb::RingBuffer::<Arc<Vec<u8>>>::new(QUEUE);

    let logger_thread = thread::spawn(move || {
        let mut seen = 0u64;
        let mut sum = 0u64;
        while seen < CHUNKS as u64 {
            match logger.pop() {
                Ok(item) => {
                    sum += touch(&item);
                    seen += 1;
                    if (seen as usize).is_multiple_of(FLUSH_EVERY) {
                        thread::sleep(FLUSH_TIME);
                    }
                }
                Err(_) => thread::yield_now(),
            }
        }
        sum
    });
    let dissector_thread = thread::spawn(move || {
        let mut seen = 0u64;
        let mut sum = 0u64;
        while seen < CHUNKS as u64 {
            match dissector.pop() {
                Ok(item) => {
                    sum += touch(&item);
                    seen += 1;
                }
                Err(_) => thread::yield_now(),
            }
        }
        sum
    });

    let started = Instant::now();
    let mut max_stall = Duration::ZERO;
    let mut total_stall = Duration::ZERO;
    for id in 0..CHUNKS {
        let item = payload(id);
        for ring in [0, 1] {
            let mut back = item.clone();
            loop {
                let push = if ring == 0 {
                    to_logger.push(back)
                } else {
                    to_dissector.push(back)
                };
                match push {
                    Ok(()) => break,
                    Err(rtrb::PushError::Full(returned)) => {
                        let t0 = Instant::now();
                        back = returned;
                        thread::yield_now();
                        let waited = t0.elapsed();
                        total_stall += waited;
                        max_stall = max_stall.max(waited);
                    }
                }
            }
        }
    }
    logger_thread.join().unwrap();
    dissector_thread.join().unwrap();
    report("rtrb, two rings", started, max_stall, total_stall)
}

/// crossbeam-channel: bounded MPMC queue, one queue per consumer.
fn bench_crossbeam() -> Report {
    let (to_logger, logger) = crossbeam_channel::bounded::<Arc<Vec<u8>>>(QUEUE);
    let (to_dissector, dissector) = crossbeam_channel::bounded::<Arc<Vec<u8>>>(QUEUE);

    let logger_thread = thread::spawn(move || {
        let mut seen = 0u64;
        let mut sum = 0u64;
        while seen < CHUNKS as u64 {
            if let Ok(item) = logger.recv() {
                sum += touch(&item);
                seen += 1;
                if (seen as usize).is_multiple_of(FLUSH_EVERY) {
                    thread::sleep(FLUSH_TIME);
                }
            }
        }
        sum
    });
    let dissector_thread = thread::spawn(move || {
        let mut seen = 0u64;
        let mut sum = 0u64;
        while seen < CHUNKS as u64 {
            if let Ok(item) = dissector.recv() {
                sum += touch(&item);
                seen += 1;
            }
        }
        sum
    });

    let started = Instant::now();
    let mut max_stall = Duration::ZERO;
    let mut total_stall = Duration::ZERO;
    for id in 0..CHUNKS {
        let item = payload(id);
        for ring in [0, 1] {
            let mut back = item.clone();
            loop {
                let push = if ring == 0 {
                    to_logger.try_send(back)
                } else {
                    to_dissector.try_send(back)
                };
                match push {
                    Ok(()) => break,
                    Err(crossbeam_channel::TrySendError::Full(returned)) => {
                        let t0 = Instant::now();
                        back = returned;
                        thread::yield_now();
                        let waited = t0.elapsed();
                        total_stall += waited;
                        max_stall = max_stall.max(waited);
                    }
                    Err(crossbeam_channel::TrySendError::Disconnected(_)) => break,
                }
            }
        }
    }
    logger_thread.join().unwrap();
    dissector_thread.join().unwrap();
    report(
        "crossbeam-channel, bounded",
        started,
        max_stall,
        total_stall,
    )
}

/// std::sync::mpsc: the standard library, no dependency at all.
fn bench_std() -> Report {
    let (to_logger, logger) = sync_channel::<Arc<Vec<u8>>>(QUEUE);
    let (to_dissector, dissector) = sync_channel::<Arc<Vec<u8>>>(QUEUE);

    let logger_thread = thread::spawn(move || {
        let mut seen = 0u64;
        let mut sum = 0u64;
        while seen < CHUNKS as u64 {
            match logger.try_recv() {
                Ok(item) => {
                    sum += touch(&item);
                    seen += 1;
                    if (seen as usize).is_multiple_of(FLUSH_EVERY) {
                        thread::sleep(FLUSH_TIME);
                    }
                }
                Err(TryRecvError::Empty) => thread::yield_now(),
                Err(TryRecvError::Disconnected) => break,
            }
        }
        sum
    });
    let dissector_thread = thread::spawn(move || {
        let mut seen = 0u64;
        let mut sum = 0u64;
        while seen < CHUNKS as u64 {
            match dissector.try_recv() {
                Ok(item) => {
                    sum += touch(&item);
                    seen += 1;
                }
                Err(TryRecvError::Empty) => thread::yield_now(),
                Err(TryRecvError::Disconnected) => break,
            }
        }
        sum
    });

    let started = Instant::now();
    let mut max_stall = Duration::ZERO;
    let mut total_stall = Duration::ZERO;
    for id in 0..CHUNKS {
        let item = payload(id);
        for ring in [0, 1] {
            let mut back = item.clone();
            loop {
                let push = if ring == 0 {
                    to_logger.try_send(back)
                } else {
                    to_dissector.try_send(back)
                };
                match push {
                    Ok(()) => break,
                    Err(std::sync::mpsc::TrySendError::Full(returned)) => {
                        let t0 = Instant::now();
                        back = returned;
                        thread::yield_now();
                        let waited = t0.elapsed();
                        total_stall += waited;
                        max_stall = max_stall.max(waited);
                    }
                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => break,
                }
            }
        }
    }
    logger_thread.join().unwrap();
    dissector_thread.join().unwrap();
    report("std sync_channel", started, max_stall, total_stall)
}

fn main() {
    println!(
        "G0 fan-out, 1 producer to 2 consumers, {} chunks of {} KiB, queue {}",
        CHUNKS,
        PAYLOAD / 1024,
        QUEUE
    );
    println!(
        "logger flush: {} us every {} chunks\n",
        FLUSH_TIME.as_micros(),
        FLUSH_EVERY
    );
    println!(
        "{:<28} {:>10} {:>12} {:>12} {:>12}",
        "primitive", "MiB/s", "chunks/s", "max stall", "total stall"
    );

    for run in [bench_rtrb(), bench_crossbeam(), bench_std()] {
        println!(
            "{:<28} {:>10.0} {:>12.0} {:>9.3} ms {:>9.3} ms",
            run.name,
            run.mib_per_s(),
            run.chunks_per_s(),
            run.max_stall.as_secs_f64() * 1000.0,
            run.total_stall.as_secs_f64() * 1000.0
        );
    }
}
