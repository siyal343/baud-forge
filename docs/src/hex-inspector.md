# Canonical Hex & ASCII

The Hex Inspector is the byte-level view of the selected frame: classic hex-and-ASCII columns with byte offsets, and — when a dissector field is selected — the field's bytes highlighted in place.

![Hex Inspector with the sync field highlighted](img/hex-inspector.png)

## Reading the panel

- **Offset ruler** across the top (`00 01 02 … 0E 0F`), one row per 16 bytes.
- **Hex columns** — every byte of the selected frame, uppercase hex.
- **ASCII column** on the right — printable bytes as characters, everything else as `.`.
- **HL: banner** (highlight) — when a dissector field is active, the banner reads `HL: sync · 0x00..0x01 · 0xAA55`: the field name, its byte range in the frame, and its raw value.

## Using it

1. Select a frame in the Packet Stream.
2. Select or hover a field in the [Protocol Dissector](protocol-dissector.html) — the corresponding bytes light up in the hex pane so you can see exactly which bytes the decoder consumed.
3. Compare frames: pause the stream ([Space](dvr-replay.html)), step back and forth — the hex pane follows the selection, making byte-level diffs between consecutive frames trivial.

## Why "canonical"

The pane shows the frame exactly as the wire carried it — no reformatting, no endianness games. When the dissector says `v_batt_mv = 7739` at offset 8..10 (`1E 3B` big-endian), the hex pane is where you confirm those two bytes are the ones you meant.

## Tips

- Undecoded frames are just as inspectable: their full payload is laid out raw, which is where you start when writing a new dissector.
- Bridge-forwarded `TX` rows show the wire bytes too — including framing overhead — so you can verify byte-for-byte what left the engine.
