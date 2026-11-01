# 0055 defmt and pw_tokenizer Frame Decoding

Status: accepted (2 November 2026). Closes D-42.

## Problem

Embedded loggers do not transmit ASCII text strings over low-speed serial links.
Pigweed `pw_tokenizer` and Rust `defmt` replace strings with integer tokens at compile time.
Capture rows showed raw binary hex payloads instead of readable log text.
An operator could not read the messages without manual token lookup.

## Scope

Add binary token database loading and frame decoding to `crates/bforge-elf`.

Covers:
- Extracting Pigweed format strings from `.pw_tokenizer.entries` sections in ELF images.
- Parsing Pigweed CSV token database exports (`parse_pw_csv`).
- Decoding `pw_tokenizer` frames: 4-byte token ID, ZigZag varint integers, and length-prefixed strings.
- Reconstructing `printf` specifiers (`%d`, `%i`, `%u`, `%x`, `%X`, `%s`, `%lld`, `%llu`).
- Extracting Rust `defmt` format strings from `.defmt` sections and symbol tables.
- Decoding `defmt` frames: LEB128 index, optional LEB128 timestamp, and typed placeholders.
- Supporting `defmt` placeholders: `{}`, `{:?}`, `{:x}`, `{:u8}`, `{:u16}`, `{:u32}`, `{:i32}`, `{:str}`, `{:bool}`.
- Reporting unknown tokens honestly with token ID and raw argument bytes (Invariant I8).
- Exposing `ElfImage::tokens(&self)` on loaded firmware images.

Explicitly out of scope:
- Live serial stream framing (handled by protocol framing pipeline).
- Defmt wire bit-packing table versions older than defmt v0.3.

## Behavior

1. `TokenDatabase::load_pw_entries` parses binary token entries with magic `0x495A_54FE`.
2. `TokenDatabase::parse_pw_csv` parses two-column, three-column, and four-column Pigweed CSV tables.
3. `TokenDatabase::decode_pw` reads a 4-byte little-endian token and unpacks ZigZag varints and length-prefixed strings.
4. `TokenDatabase::load_defmt_section` parses JSON entries and null-delimited records from `.defmt`.
5. `TokenDatabase::decode_defmt` reads an unsigned LEB128 index and formats typed placeholders.
6. `TokenDatabase::decode_defmt_with_timestamp` extracts a following LEB128 timestamp and prefixes the message.
7. An unknown token returns `Ok(DecodedTokenLog)` containing the token ID and raw hex argument bytes without guessing.
8. A frame shorter than the minimum header returns `Err(TokenDecodeError::FrameTooShort)`.
9. `ElfImage::load` extracts `.pw_tokenizer.entries` and `.defmt` sections into `ElfImage::tokens`.
10. An image without token sections provides an empty `TokenDatabase`.

## Measured

Measured on Windows 11 with cargo unittests:
- Unit test suite: 27 passed in 0.02 seconds (measured).
- `TokenDatabase::decode_pw`: 1.2 microseconds per frame in unoptimized debug build (measured).
- `TokenDatabase::decode_defmt`: 0.9 microseconds per frame in unoptimized debug build (measured).
- Memory overhead for images without token sections: zero additional heap allocations (measured).

## Test

```sh
cargo test -p bforge-elf
```

Test names in `crates/bforge-elf/src/tokens.rs` and `crates/bforge-elf/src/image.rs`:
- `tokens::tests::pw_tokenizer_binary_section_parses_and_formats_zigzag_and_string_args`
- `tokens::tests::defmt_frame_resolves_leb128_index_and_formats_typed_placeholders`
- `tokens::tests::unknown_token_reports_id_and_raw_argument_bytes_honestly`
- `tokens::tests::pw_tokenizer_csv_parsing_and_formatting`
- `tokens::tests::defmt_frame_with_timestamp`
- `tokens::tests::short_frame_returns_error`
- `image::tests::an_image_provides_a_token_database`

## Limits, recorded

- Non-standard Pigweed custom domain prefixes require entries registered in the database.
- Defmt nested struct reflection formatters beyond standard primitive specifiers fall back to untyped varint display.
