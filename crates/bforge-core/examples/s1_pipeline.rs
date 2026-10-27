//! S1 demo: four mock ports at 12 Mbaud (1.2 MB/s each) for three seconds.
//!
//! One consumer per port plays the disk logger and checks the chunk sequence in
//! the payload. The second consumer plays a slower framing stage. The demo
//! prints the counters and proves 0 dropped bytes on the logger path.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s1_pipeline
//! ```

use bforge_core::pipeline::{Pipeline, PipelineConfig};
use bforge_core::slab::Slab;
use bforge_hal::mock::MockTransport;
use rtrb::Consumer;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const PORTS: u16 = 4;
const BYTES_PER_SEC: u64 = 1_200_000;
const SECONDS: u64 = 3;
const DISSECTOR_FLUSH: Duration = Duration::from_micros(200);
const DISSECTOR_EVERY: u64 = 16;

fn main() {
    let stop = Arc::new(AtomicBool::new(false));
    let logged = Arc::new(AtomicU64::new(0));
    let framed = Arc::new(AtomicU64::new(0));

    let mut gaps: Vec<Arc<AtomicU64>> = Vec::new();
    let mut pipelines = Vec::new();
    let mut workers = Vec::new();

    for port in 0..PORTS {
        let config = PipelineConfig {
            port_id: port,
            ..Default::default()
        };
        let mut pipeline = Pipeline::start(config, Box::new(MockTransport::new(BYTES_PER_SEC)));
        let consumers = pipeline.take_consumers();
        pipelines.push(pipeline);

        let port_gaps = Arc::new(AtomicU64::new(0));
        gaps.push(Arc::clone(&port_gaps));

        let mut ends = consumers.into_iter();
        if let Some(logger) = ends.next() {
            workers.push(spawn_logger(
                logger,
                Arc::clone(&stop),
                port_gaps,
                Arc::clone(&logged),
            ));
        }
        if let Some(dissector) = ends.next() {
            workers.push(spawn_dissector(
                dissector,
                Arc::clone(&stop),
                Arc::clone(&framed),
            ));
        }
    }

    let started = Instant::now();
    thread::sleep(Duration::from_secs(SECONDS));
    stop.store(true, Ordering::Relaxed);
    for worker in workers {
        worker.join().unwrap();
    }

    println!(
        "{:<6} {:>8} {:>9} {:>9} {:>11} {:>8} {:>6}",
        "port", "chunks", "MiB", "MB/s", "stalled", "overruns", "gaps"
    );
    let mut total_bytes = 0u64;
    let mut total_overruns = 0u64;
    for (index, pipeline) in pipelines.iter().enumerate() {
        let stats = pipeline.stats();
        total_bytes += stats.bytes;
        total_overruns += stats.overruns;
        println!(
            "{:<6} {:>8} {:>9.2} {:>9.2} {:>9.2}ms {:>8} {:>6}",
            index,
            stats.chunks,
            stats.bytes as f64 / (1024.0 * 1024.0),
            stats.bytes as f64 / pipeline.elapsed().as_secs_f64() / 1_000_000.0,
            stats.stalls_ns as f64 / 1_000_000.0,
            stats.overruns,
            gaps[index].load(Ordering::Relaxed),
        );
    }

    let elapsed = started.elapsed().as_secs_f64();
    let target = BYTES_PER_SEC as f64 * f64::from(PORTS) * elapsed;
    let lost: u64 = gaps.iter().map(|gap| gap.load(Ordering::Relaxed)).sum();
    println!(
        "\n{:.2} MB in {:.2} s, target {:.2} MB at {} x 1.2 MB/s",
        total_bytes as f64 / 1_000_000.0,
        elapsed,
        target / 1_000_000.0,
        PORTS
    );
    println!(
        "{} chunks logged, {} framed, {} overruns on the slow stage",
        logged.load(Ordering::Relaxed),
        framed.load(Ordering::Relaxed),
        total_overruns
    );
    println!(
        "logger gaps: {lost} -> {}",
        if lost == 0 {
            "0 dropped bytes"
        } else {
            "BYTES LOST"
        }
    );

    for pipeline in pipelines {
        pipeline.stop();
    }
}

fn payload_seq(slab: &Slab) -> u64 {
    u64::from_le_bytes(slab.bytes()[..8].try_into().unwrap())
}

fn spawn_logger(
    mut consumer: Consumer<Arc<Slab>>,
    stop: Arc<AtomicBool>,
    gaps: Arc<AtomicU64>,
    logged: Arc<AtomicU64>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut expected: Option<u64> = None;
        while !stop.load(Ordering::Relaxed) {
            match consumer.pop() {
                Ok(slab) => {
                    let seq = payload_seq(&slab);
                    if expected.is_some_and(|next| seq != next) {
                        gaps.fetch_add(1, Ordering::Relaxed);
                    }
                    expected = Some(seq + 1);
                    logged.fetch_add(1, Ordering::Relaxed);
                    std::hint::black_box(slab.bytes().len());
                }
                Err(_) => thread::yield_now(),
            }
        }
    })
}

fn spawn_dissector(
    mut consumer: Consumer<Arc<Slab>>,
    stop: Arc<AtomicBool>,
    framed: Arc<AtomicU64>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut seen = 0u64;
        while !stop.load(Ordering::Relaxed) {
            match consumer.pop() {
                Ok(slab) => {
                    seen += 1;
                    framed.fetch_add(1, Ordering::Relaxed);
                    std::hint::black_box(slab.bytes().len());
                    if seen.is_multiple_of(DISSECTOR_EVERY) {
                        thread::sleep(DISSECTOR_FLUSH);
                    }
                }
                Err(_) => thread::yield_now(),
            }
        }
    })
}
