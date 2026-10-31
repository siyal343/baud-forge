# 0035 Readable names for Rust symbols

Status: accepted (31 October 2026). Closes D-44.

## Problem

A crash badge showed `_RINvNtCs59fwaEIuEkC_3std3env3varReECs8JtRkeDsMJy_13s8_device_sim`.
The address was resolved, the file and line were right, and the function name — the part a
person reads first — was mangled. That is what a Rust binary stores, and it had been
deferred since the first ELF work.

## Scope

Demangle a symbol when the image is loaded and when an address is resolved. Not in this
stage: demangling generics into something shorter than the compiler writes, and
demangling anything other than Rust (C++ is a different mangling).

## Behavior

1. `Function.name` and `SourceLocation.function` are readable: Rust names demangled with
   the trailing hash removed, C names unchanged.
2. An address that resolves to a generic shows the demangled form, for example
   `std::env::var::<&str>`.
3. A name the demangler does not recognise is left exactly as it was, so a C symbol is
   never damaged by trying.

## Data

`bforge_elf::image::readable_name(&str) -> String`, used at load and at resolve. One new
dependency, `rustc-demangle`, which is the compiler's own demangler as a small library.

## Measured

`s12_elf` against the simulator binary, before and after:

```text
before  0x140001484 -> …/std/src/env.rs:228 (_RINvNtCs59fwaEIuEkC_3std3env3varReECs8JtRkeDsMJy_13s8_device_sim)
after   0x140001484 -> …/std/src/env.rs:228 (var::<&str>)
after   0x140001434 -> …/std/src/sys/net/connection/socket/mod.rs:550 (string::String>)
```

Two unit tests: a mangled name becomes `std::env::var…`, and `app_main` stays `app_main`.

## Test

```sh
cargo test -p bforge-elf --lib
cargo run -p bforge-elf --example s12_elf -- <image>
```

## Limits, recorded

- Generic parameters make some names long; the badge truncates for width and keeps the
  full name in the tooltip.
- C++ mangling would need a different demangler (none in this project).
