# 0056 XMODEM and YMODEM file transfer state machines

Status: accepted (2 November 2026).

## Problem

Embedded hardware bootloaders and flight computers frequently require XMODEM or YMODEM
to flash binary images across serial links. BaudForge had no protocol engine for file
transfers. Users had to exit BaudForge and run external terminal programs to flash firmware.
Running an external tool broke logging, disrupted active sessions, and interrupted hardware
in-the-loop tests.

## Scope

Deterministic Sans-IO state machines and synchronous byte stream adapters in `bforge-script`:
- XMODEM-Checksum (128-byte data blocks, NAK initial handshake, 8-bit checksum).
- XMODEM-CRC (128-byte data blocks, `'C'` handshake, CRC-16/XMODEM).
- XMODEM-1K (1024-byte data blocks, `'C'` handshake, CRC-16/XMODEM).
- YMODEM batch mode (Block 0 with filename and exact file size, 1024/128-byte data blocks,
  double EOT handshake, terminating empty Block 0).
- Retransmission on NAK or block corruption, cancellation on double CAN, and configurable retries.
- Generic synchronous `send_stream` and `receive_stream` helpers over `Read + Write`.

Explicitly out of scope:
- ZMODEM streaming and sliding window protocols.
- Direct serial port CLI commands.
- Terminal UI progress bars.

## Behavior

1. `ModemMode` selects among `XmodemChecksum`, `XmodemCrc`, `Xmodem1K`, and `Ymodem`.
2. `XmodemSender` and `XmodemReceiver` implement deterministic Sans-IO state machines.
3. In `XmodemChecksum`, the receiver initiates the session with `NAK` (0x15). Blocks carry 128
   bytes and an 8-bit sum checksum.
4. In `XmodemCrc` and `Xmodem1K`, the receiver initiates the session with `CRC_POLL` (`'C'`, 0x43).
   Blocks carry CRC-16/XMODEM (polynomial 0x1021, initial value 0x0000).
5. In `Ymodem`, the sender transmits Block 0 (sequence 0) containing null-terminated filename and
   decimal ASCII file size.
6. The receiver acknowledges Block 0 with `ACK` (0x06) followed by `'C'` (0x43) to request file data.
7. Data blocks carry 128 bytes (`SOH`, 0x01) or 1024 bytes (`STX`, 0x02), sequence number, and
   sequence complement `seq ^ 0xFF`.
8. The receiver rejects mismatched complements immediately with `[CAN, CAN]` and returns
   `ModemError::InvalidComplement`.
9. The receiver replies with `NAK` on CRC or checksum mismatch. The sender retransmits the block.
10. Two consecutive `CAN` bytes (0x18, 0x18) cancel the transfer immediately with `ModemError::Cancelled`.
11. At the end of file data, the sender transmits `EOT` (0x04).
12. In YMODEM, the receiver replies with `NAK` to the first `EOT`, then `ACK` and `'C'` to the
    second `EOT`.
13. The sender terminates a YMODEM session by sending an empty Block 0 with 128 zero bytes.
14. The receiver truncates YMODEM data to the exact file size recorded in Block 0.
15. `send_stream` and `receive_stream` execute transfers synchronously over `Read + Write` streams.

## Measured

All 8 tests run against memory buffers and threaded duplex pipes:

```text
test xymodem::tests::crc16_xmodem_matches_standard_test_vector ... ok
test xymodem::tests::xmodem_checksum_roundtrip ... ok
test xymodem::tests::xmodem_1k_roundtrip ... ok
test xymodem::tests::xmodem_crc_roundtrips_multi_block_payload_and_pads_last_block ... ok
test xymodem::tests::nak_triggers_block_retransmit_and_recovers ... ok
test xymodem::tests::ymodem_carries_filename_and_exact_size_in_block_zero ... ok
test xymodem::tests::bad_sequence_complement_or_double_can_aborts_cleanly ... ok
test xymodem::tests::send_and_receive_stream_roundtrip_over_pipes ... ok
```

Execution time for the complete test suite: 0.01 seconds.

## Test

Run unit and integration tests with:

```bash
cargo test -p bforge-script -- xymodem
```

Key test coverage:
- `xmodem_crc_roundtrips_multi_block_payload_and_pads_last_block`: verifies 300-byte payload across
  three 128-byte blocks and validates CP/M EOF padding (0x1A).
- `nak_triggers_block_retransmit_and_recovers`: injects CRC payload corruption, asserts NAK emission,
  verifies sender retransmission, and confirms payload integrity.
- `ymodem_carries_filename_and_exact_size_in_block_zero`: verifies Block 0 metadata encoding and
  receiver exact payload truncation without padding.
- `bad_sequence_complement_or_double_can_aborts_cleanly`: verifies immediate abort on bad complement
  and double CAN.

## Limits, recorded

- ZMODEM protocol state machine is deferred to a future iteration.
- Multiple-file batches within a single YMODEM session are not supported; each session transfers
  one file.
