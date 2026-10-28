//! S11 demo: a firmware header alone decodes a frame, and how fast.
//!
//! ```sh
//! cargo run -p bforge-dissect --release --example s11_dissect
//! ```

use bforge_dissect::{DecodedField, cheader, exec};
use std::time::Instant;

const HEADER: &str = include_str!("../tests/fixtures/imu_packet.h");
const ROUNDS: usize = 200_000;

fn main() {
    let started = Instant::now();
    let header = cheader::parse(HEADER).expect("header parses");
    let parse_time = started.elapsed();

    println!(
        "header: {} struct(s), {} enum(s), parsed in {:.2} ms",
        header.structs.len(),
        header.enums.len(),
        parse_time.as_secs_f64() * 1000.0
    );
    for definition in &header.structs {
        println!(
            "  {:<12} {} bytes, {} field(s), {}",
            definition.name,
            definition.size,
            definition.fields.len(),
            if definition.packed {
                "packed"
            } else {
                "aligned"
            }
        );
    }

    let pack = &header.structs[0];
    println!("\n{:>16} {:>6} {:>6}  type", "field", "offset", "bytes");
    for field in &pack.fields {
        println!(
            "{:>16} {:>6} {:>6}  {}",
            field.name, field.offset, field.len, field.type_name
        );
    }

    let ir = cheader::compile(&header, "ImuPacket", "imu_packet.h").expect("compiles");
    let frame = golden_frame();

    let compiled = Instant::now();
    let fields = exec::execute(&ir, &frame).expect("decodes");
    println!(
        "\ndecoded {} fields from {} bytes in {:.1} us",
        fields.len(),
        frame.len(),
        compiled.elapsed().as_secs_f64() * 1e6
    );
    print_tree(&fields, 0);

    let started = Instant::now();
    let mut checksum = 0f64;
    for _ in 0..ROUNDS {
        let decoded = exec::execute(&ir, &frame).expect("decodes");
        checksum += decoded[0].value_num.unwrap_or(0.0);
    }
    let elapsed = started.elapsed();
    println!(
        "\n{ROUNDS} frames in {:.2} s = {:.0} frames/s ({:.1} MB/s of frame bytes), checksum {checksum}",
        elapsed.as_secs_f64(),
        ROUNDS as f64 / elapsed.as_secs_f64(),
        (ROUNDS * frame.len()) as f64 / elapsed.as_secs_f64() / 1e6
    );
    println!("note: every field allocates a String, which the UI copy will replace");
}

fn print_tree(fields: &[DecodedField], depth: usize) {
    for field in fields {
        println!(
            "{:indent$}{:<14} +0x{:02x} {:>2}B  {}",
            "",
            field.name,
            field.byte_offset,
            field.byte_len,
            field.value,
            indent = depth * 2
        );
        print_tree(&field.children, depth + 1);
    }
}

fn golden_frame() -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&0xAA55u16.to_le_bytes());
    frame.push(3);
    frame.push(5 | (18 << 3));
    frame.extend_from_slice(&123_456u32.to_le_bytes());
    frame.extend_from_slice(&8_190u16.to_be_bytes());
    frame.extend_from_slice(&(-0.042f32).to_le_bytes());
    frame.extend_from_slice(&[1, 2, 3, 4]);
    frame.push(1);
    frame
}
