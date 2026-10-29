//! S12 demo: a crash line becomes `file:line`, and how fast.
//!
//! ```sh
//! cargo run -p bforge-elf --release --example s12_elf
//! cargo run -p bforge-elf --release --example s12_elf -- path/to/firmware.elf
//! ```

use bforge_elf::{Editor, ElfImage, scan_pointers};
use std::time::Instant;

const ROUNDS: usize = 10_000;

fn main() {
    let path = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_exe().expect("a binary path"));

    let started = Instant::now();
    let image = match ElfImage::load(&path) {
        Ok(image) => image,
        Err(error) => {
            eprintln!("cannot load {}: {error}", path.display());
            std::process::exit(1);
        }
    };
    let load_time = started.elapsed();
    println!(
        "image {}: {} function symbols, loaded in {:.0} ms",
        path.display(),
        image.functions().len(),
        load_time.as_secs_f64() * 1000.0
    );
    // `s12_elf <image> <needle>` lists symbols whose name contains the needle, so a
    // demo can hand a real address to something that emits frames.
    if let Some(needle) = std::env::args().nth(2) {
        for function in image.functions() {
            if function.name.contains(&needle) {
                println!("0x{:x} {}", function.address, function.name);
            }
        }
        return;
    }
    if let (Some(first), Some(last)) = (image.functions().first(), image.functions().last()) {
        println!(
            "code span 0x{:08x}..0x{:08x}, line info: {}",
            first.address,
            last.address,
            if image.has_line_info() {
                "present"
            } else {
                "absent"
            }
        );
    }

    // A crash line as a firmware would print it, built from addresses this image
    // can actually resolve, so the demo shows a real badge and not a blank.
    let mut resolvable = Vec::new();
    for function in image.functions() {
        if resolvable.len() == 2 {
            break;
        }
        let address = function.address + 4;
        if image.resolve(address).is_some() {
            resolvable.push(address);
        }
    }
    let fault_pc = resolvable.first().copied().unwrap_or(0);
    let fault_lr = resolvable.get(1).copied().unwrap_or(fault_pc);
    let line = format!(
        "HardFault: PC: 0x{fault_pc:08x} LR: 0x{fault_lr:08x} SP: 0x20004ff0 CFSR: 0x00000082"
    );
    println!("\ninput  {line}");

    let started = Instant::now();
    let hits = scan_pointers(&line);
    let scan_time = started.elapsed();
    println!(
        "scan   {} pointer(s) in {:.1} us",
        hits.len(),
        scan_time.as_secs_f64() * 1e6
    );

    let mut resolved = 0;
    for hit in &hits {
        print!("  {} -> ", hit.text);
        match image.resolve(hit.address) {
            Some(location) => {
                resolved += 1;
                println!(
                    "{}:{} ({})",
                    location.file,
                    location.line,
                    shorten(&location.function)
                );
                println!("        {}", Editor::VsCode.command(&location));
            }
            None => println!("no line information, show the raw address"),
        }
    }
    println!(
        "\n{resolved} of {} pointers resolved; SP and CFSR would stay as raw values",
        hits.len()
    );

    let started = Instant::now();
    let mut found = 0usize;
    for round in 0..ROUNDS {
        let address = fault_pc + (round as u64 % 8);
        if image.resolve(address).is_some() {
            found += 1;
        }
    }
    let elapsed = started.elapsed();
    println!(
        "\n{ROUNDS} lookups in {:.1} ms = {:.1} us each ({found} resolved)",
        elapsed.as_secs_f64() * 1000.0,
        elapsed.as_secs_f64() * 1e6 / ROUNDS as f64
    );
}

/// Rust symbol names are long; a badge wants the last two path segments.
fn shorten(name: &str) -> String {
    let mut parts: Vec<&str> = name.split("::").collect();
    if parts.len() > 2 {
        parts = parts.split_off(parts.len() - 2);
    }
    parts.join("::")
}
