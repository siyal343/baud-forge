# 0032 Encode a frame from named values

Status: accepted (31 October 2026). Closes the engine half of D-64.

## Problem

The engine could decode a frame from a C header but not write one. A forge therefore
asked for hex, and a person had to place bytes by hand — knowing, from memory, that a
battery voltage is big endian at offset 8 and that two bitfields share byte 3. The same
schema that knows all of this was already compiled for reading.

## Scope

An encoder over the dissector IR, and a `values` variant of the send route. Not in this
stage: a typed form in the workbench (D-85), enum labels as strings (D-86), and nested
structs written by name (D-87).

## Behavior

1. `POST /api/send` accepts `values` instead of `hex`:
   `{"port":"sim","values":{"sync":43605,"version":3,"v_batt_mv":7400}}`.
2. The engine encodes with the port's own C header schema, so the decoder and the
   encoder cannot drift: one table, read and written.
3. A field that is not named stays **zero**, which is what a firmware default is.
4. A name the schema does not have is a `409` naming the field. A typo must not send a
   frame of zeros that looks valid.
5. A value outside the field's width, a fraction in an integer field, or a float in an
   enum is refused the same way.
6. Big endian, little endian, bitfields and single-precision floats are written the way
   the decoder reads them; a round trip through the same IR returns the same numbers.
7. An enum field takes a number or a **label** from the header, matched without regard to
   case: `"mode":"MODE_RUN"`, `"mode":"mode_run"` and `"mode":1` are the same frame. A
   label the enum does not carry is refused with both names.
8. Both spellings a header uses work: `enum mode_e mode;` and, through the typedef,
   `state_t state;`. The typedef spelling names the enum after the alias, which is what a
   real header writes.
9. A struct inside a struct is addressed by a dotted name: `gains.proportional`. The
   parser flattens it into an `inner.field` label with an absolute offset, so decoding
   stays a flat list while encoding can still name the member.

## Data

`bforge_dissect::encoder::{encode, EncodeError}`. The session builds one IR per port in
`enable_decode` and exposes `send_values`, so the schema is loaded once.

## Measured

Seven encoder tests, and one end-to-end through the HTTP surface:

```text
encode(ImuPacket, values) + decode(same IR) -> the same numbers   (round trip)
omitted fields                              -> zero in the frame
unknown name                                -> EncodeError::UnknownField("v_bat_mv")
version 300                                 -> OutOfRange
v_batt_mv 7400.5                            -> NotAWholeNumber
v_batt_mv 0x1CE8                            -> bytes 1C E8 (big endian on the wire)
flags 5, channel 9                          -> byte 3 == 0x4D (5 | 9<<3)

POST /api/send {"values":{"sync":43605,"version":3,…}} -> {"sent":19}
device received 55 AA 03 4D … 1C E8 …, which is what the decoder reads back

POST {"mode":"MODE_FAULT","sync":43605,"flags":1} -> {"sent":7}
POST {"mode":"MODE_WOBBLE"}                        -> {"error":"`MODE_WOBBLE` is not a value of `mode`"}
POST {"mode":2}                                     -> {"sent":7}
POST {"state":"STATE_ON"} on a typedef'd enum        -> {"sent":7}
POST {"state":"STATE_BROKEN"}                        -> {"error":"`STATE_BROKEN` is not a value of `state`"}
POST {"gains.proportional":1234,"gains.integral":7}   -> {"sent":7}
POST {"gains.derivative":1}                           -> {"error":"`gains.derivative` is not a field of this schema"}
```

## Test

```sh
cargo test -p bforge-dissect --lib encoder
cargo test -p bforge-core --test serve
```

## The form

The command forge has two modes, switched by the small button on the left of the row:

- `hex`, as before;
- `typed`, which lists one row per numeric leaf of the last decoded frame, seeded with
  the values that frame carried, and posts `values` instead of `hex`.

The field list comes from the frame the port just decoded, so the form and the schema
are the same thing seen twice. A port with no schema says so instead of showing an empty
form. `?typed=1` opens the page on the typed form, which is also how a headless browser
can reach it.

Not captured: a screenshot of the typed form. Headless Edge in this session returns an
empty document for the engine's page as well as the dev server, as recorded in spec 0029.
The build type-checks, and the route it calls answers `{"sent":19}` for the same values,
measured above.

## Limits, recorded

- An enum is four bytes, which is what a C compiler gives it without `-fshort-enums`; a
  firmware built with short enums needs the width said out loud (not implemented).
- A struct member must be declared before it is used, and a member that is an array of
  structs is not expanded.
- Arrays take `name.0`, `name.1`, … and only when the element is named in the header.
