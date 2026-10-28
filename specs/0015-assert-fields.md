# 0015 Assert on decoded fields

Status: accepted (28 October 2026). Closes D-15 in its useful form.

## Problem

`bforge assert` could only look at raw bytes. A team that has a schema wants to
say "the battery stayed between 7.4 and 8.2 volts", not "these bytes appeared".
Storage cannot answer that either: it holds raw frames by design, so a dissector
written next week still applies to last month's session.

## Scope

Decoding a vault with a workspace schema, two new check kinds, and the CLI flag
that turns them on. Not in this stage: assert on timing (D-23), assert on live
traffic, and any change to the `.bflog` format.

## Behavior

1. The vault keeps raw bytes only. Framing and decoding happen when a question is
   asked, from the schema in the workspace.
2. `decode_vault` reads the vault in windows, feeds each port's framing machine with
   the record timestamps, and decodes every completed frame with the port's
   dissector. The rows carry byte offsets, so a field points at its bytes.
3. `assert -c <workspace>` decodes before it checks. Without `-c`, the byte and
   count kinds still work, and a `field` or `protocol` check fails with the reason:
   "no decoded frames; pass the workspace to `assert` with -c".
4. `kind = "field"` takes the field name in `value`, and either `equals` or a
   `min`/`max` range. A range is checked against every value of that field in the
   session, and the report prints the range it saw.
5. `kind = "protocol"` requires every decoded frame to carry the expected tag, so a
   session that drifted to another schema fails.
6. A field name may be dotted (`samples.0`) or bare: a bare name matches any field
   whose path ends with it.

## Data

```toml
[[checks]]
name = "battery in range"
kind = "field"
value = "v_batt_mv"
min = 7400
max = 8200

[[checks]]
name = "sync word"
kind = "field"
value = "sync"
equals = "43605"

[[checks]]
name = "every frame matched the header"
kind = "protocol"
value = "C_STRUCT:ImuPacket"
```

## Measured

28 October 2026, the test firmware in `mode imu 20` on COM8, six seconds recorded,
then checked from the vault:

```text
$ bforge record -c esp32c3-imu.toml -o target/imu-assert.bflog --duration 6s
sealed target/imu-assert.bflog: 241 chunks, 3049 bytes in 6.00 s (508 B/s)

$ bforge assert target/imu-assert.bflog -c esp32c3-imu.toml -r imu.rules.toml
target/imu-assert.bflog: 241 chunks, 3049 bytes, 122 decoded frame(s)
  PASS field      sync word  122 of 122 `sync` value(s) equal `43605`
  PASS field      battery in range  `v_batt_mv` ranges over 7405 to 7526 across 122 value(s)
  PASS field      mode is RUN  122 of 122 `mode` value(s) equal `1`
  PASS protocol   every frame matched the header  all 122 frame(s) are C_STRUCT:ImuPacket
  PASS chunks     session has frames  241 >= 10
5 of 5 checks passed
```

The range is the firmware's own `7400 + seq % 800` over 122 frames, which is a
partial cycle, so 7405 to 7526 is the correct answer and not a coincidence.

241 chunks carried 122 frames: the reader still receives short chunks, so two
records per frame is normal at this rate (D-53).

## Test

```sh
cargo test -p bforge-core --test assert_fields
cargo test -p bforge-core --test tail
cargo test -p bforge-cli
```

Five tests: a vault decodes through the workspace schema and the field values match
the frame that was written; field and protocol checks pass across decoded frames; a
field outside its range fails and prints the range it saw; a field check without
decoded frames says what is missing; and a field rule with nothing to compare is
refused before a run.
