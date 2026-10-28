//! S3 demo: a recorded COBS stream through the pipeline, the framer and the CRC.
//!
//! Builds 2 000 COBS frames, each ending with a CRC-32C, replays them through the
//! pipeline as one byte script, then decodes and checks every frame.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s3_frames
//! ```

use bforge_core::pipeline::{Pipeline, PipelineConfig};
use bforge_framer::checksum::Checksum;
use bforge_framer::machine::{ByteMachine, Cobs, cobs_encode};
use bforge_hal::mock::MockTransport;
use std::time::Instant;

const FRAMES: usize = 2_000;

fn main() {
    let checksum = Checksum::Crc32c;

    // One stream: encoded frame, zero byte, encoded frame, zero byte, ...
    let mut stream = Vec::new();
    let mut payload_bytes = 0usize;
    for index in 0..FRAMES {
        let len = 8 + index % 64;
        let mut frame: Vec<u8> = (0..len)
            .map(|byte| (index as u8).wrapping_add(byte as u8))
            .collect();
        // A zero inside a frame proves COBS handles it.
        frame[len / 2] = 0;
        frame.extend_from_slice(&checksum.compute(&frame).to_le_bytes());
        payload_bytes += frame.len();
        stream.extend_from_slice(&cobs_encode(&frame));
        stream.push(0);
    }
    let stream_bytes = stream.len();

    let mut pipeline = Pipeline::start(
        PipelineConfig {
            port_id: 0,
            slab_bytes: 4096,
            queue_chunks: 64,
            consumers: 2,
            ..Default::default()
        },
        Box::new(MockTransport::stream(stream)),
    );
    let mut consumers = pipeline.take_consumers();
    let mut logger = consumers.remove(0);

    let mut machine = Cobs::new(4096);
    let mut frames: Vec<Vec<u8>> = Vec::new();
    let started = Instant::now();
    let mut fed = 0usize;

    loop {
        match logger.pop() {
            Ok(slab) => {
                fed += slab.bytes().len();
                machine.feed(slab.bytes(), &mut frames);
            }
            Err(_) => {
                if fed >= stream_bytes {
                    break;
                }
                std::thread::yield_now();
            }
        }
    }
    // Flush whatever the last slab left behind without a delimiter.
    machine.feed(&[0], &mut frames);

    let elapsed = started.elapsed();
    let stats = pipeline.stats();
    pipeline.stop();

    let mut crc_ok = 0usize;
    let mut crc_bad = 0usize;
    let mut total = 0usize;
    for frame in &frames {
        total += frame.len();
        let split = frame.len() - 4;
        let expected = u32::from_le_bytes(frame[split..].try_into().unwrap());
        if checksum.compute(&frame[..split]) == expected {
            crc_ok += 1;
        } else {
            crc_bad += 1;
        }
    }

    println!("stream     {stream_bytes} bytes in, {payload_bytes} bytes of frame payload");
    println!(
        "pipeline   {} chunks, {} bytes, {} overruns, {:.2} MB/s",
        stats.chunks,
        stats.bytes,
        stats.overruns,
        stats.bytes as f64 / elapsed.as_secs_f64() / 1_000_000.0
    );
    println!(
        "framing    {} frames decoded, {} bytes out, {} invalid blocks",
        frames.len(),
        total,
        machine.invalid_blocks()
    );
    println!(
        "checksum   {crc_ok} valid, {crc_bad} invalid, {:.0} frames/s",
        frames.len() as f64 / elapsed.as_secs_f64()
    );

    assert_eq!(frames.len(), FRAMES, "every frame must arrive");
    assert_eq!(crc_bad, 0, "no frame may fail its checksum");
    assert_eq!(total, payload_bytes);
    println!("\n{FRAMES} of {FRAMES} frames decoded with a valid CRC-32C");
}
