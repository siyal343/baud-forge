//! XMODEM and YMODEM file transfer state machines (ADR-001, SRS 2.1, Milestone 4).
//!
//! Embedded firmware bootloaders use XMODEM and YMODEM for flashing.
//! The state machines use a Sans-IO design: byte buffers in, byte buffers out.
//! Callers run them synchronously over [`std::io::Read`] and [`std::io::Write`]
//! or step them inside asynchronous event loops.

use std::io::{Read, Write};

/// Start of header for 128-byte data blocks.
pub const SOH: u8 = 0x01;
/// Start of header for 1024-byte data blocks.
pub const STX: u8 = 0x02;
/// End of transmission.
pub const EOT: u8 = 0x04;
/// Positive acknowledgment.
pub const ACK: u8 = 0x06;
/// Negative acknowledgment.
pub const NAK: u8 = 0x15;
/// Cancel transfer.
pub const CAN: u8 = 0x18;
/// Handshake request for 16-bit CRC mode (`'C'`).
pub const CRC_POLL: u8 = 0x43;
/// Padding byte for partial blocks (CP/M EOF, Ctrl+Z).
pub const CPMEOF: u8 = 0x1A;

/// Compute the CRC-16/XMODEM checksum of a slice (poly `0x1021`, init `0x0000`).
pub fn crc16_xmodem(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0x0000;
    for &b in bytes {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// Compute the 8-bit arithmetic sum checksum of a slice (sum % 256).
pub fn checksum(bytes: &[u8]) -> u8 {
    let mut sum: u8 = 0;
    for &b in bytes {
        sum = sum.wrapping_add(b);
    }
    sum
}

/// File transfer protocol variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModemMode {
    /// Classic XMODEM: 128-byte blocks, NAK start, 8-bit checksum.
    XmodemChecksum,
    /// XMODEM-CRC: 128-byte blocks, `'C'` start, CRC-16/XMODEM.
    XmodemCrc,
    /// XMODEM-1K: 1024-byte blocks, `'C'` start, CRC-16/XMODEM.
    Xmodem1K,
    /// YMODEM batch mode: Block 0 header, 1024/128-byte blocks, CRC-16.
    Ymodem,
}

/// State of the [`XmodemSender`] state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SenderState {
    /// Waiting for receiver poll byte (`'C'` or `NAK`).
    WaitingForStart,
    /// Sent YMODEM Block 0 metadata, waiting for `ACK`.
    SendingBlockZero,
    /// Received `ACK` for Block 0, waiting for `'C'` to send data blocks.
    WaitingForCAfterBlockZero,
    /// Sending data blocks 1..N, waiting for `ACK`.
    SendingData,
    /// Sent `EOT`, waiting for response (`NAK` then `ACK` in YMODEM).
    SendingEot,
    /// Received `ACK` for `EOT` in YMODEM, waiting for `'C'` before null Block 0.
    WaitingForCAfterEot,
    /// Sent terminating null Block 0 in YMODEM, waiting for `ACK`.
    SendingNullBlock,
    /// Transfer finished successfully.
    Complete,
    /// Transfer cancelled or aborted due to error.
    Cancelled,
}

/// State of the [`XmodemReceiver`] state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiverState {
    /// Waiting for sender response after poll byte.
    WaitingForStart,
    /// Waiting for YMODEM Block 0 metadata.
    WaitingForBlockZero,
    /// Receiving file payload data blocks.
    WaitingForBlock,
    /// Waiting for terminating null Block 0 after EOT handshake.
    WaitingForNullBlock,
    /// Transfer finished successfully.
    Complete,
    /// Transfer cancelled or aborted due to error.
    Cancelled,
}

/// Progress and telemetry counters for a transfer.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TransferStats {
    /// Payload bytes transferred.
    pub bytes_transferred: usize,
    /// Number of blocks transferred.
    pub blocks_transferred: usize,
    /// Number of block retransmissions due to NAK or corruption.
    pub retransmissions: usize,
    /// Number of CRC or checksum mismatch errors detected.
    pub crc_errors: usize,
    /// Filename parsed from Block 0 in YMODEM mode.
    pub file_name: Option<String>,
    /// File size in bytes parsed from Block 0 in YMODEM mode.
    pub file_size: Option<usize>,
}

/// Errors occurring during file transfers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModemError {
    /// Transfer cancelled by remote through two consecutive CAN bytes.
    Cancelled,
    /// Maximum retries exceeded for a block.
    MaxRetriesExceeded { block: usize },
    /// Unexpected block sequence number.
    InvalidSequence { expected: u8, received: u8 },
    /// Sequence complement did not match `seq ^ 0xFF`.
    InvalidComplement { seq: u8, complement: u8 },
    /// CRC-16 check failed.
    CrcMismatch { expected: u16, actual: u16 },
    /// Checksum check failed.
    ChecksumMismatch { expected: u8, actual: u8 },
    /// Unexpected control byte received.
    UnexpectedByte { expected: &'static str, actual: u8 },
    /// Invalid block header byte.
    InvalidHeader(u8),
    /// Underlying I/O error.
    Io(String),
}

impl std::fmt::Display for ModemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "transfer cancelled by remote"),
            Self::MaxRetriesExceeded { block } => {
                write!(f, "maximum retries exceeded at block {block}")
            }
            Self::InvalidSequence { expected, received } => {
                write!(
                    f,
                    "invalid sequence number: expected {expected}, got {received}"
                )
            }
            Self::InvalidComplement { seq, complement } => {
                write!(f, "invalid sequence complement for {seq}: got {complement}")
            }
            Self::CrcMismatch { expected, actual } => {
                write!(
                    f,
                    "CRC-16 mismatch: expected 0x{expected:04X}, got 0x{actual:04X}"
                )
            }
            Self::ChecksumMismatch { expected, actual } => {
                write!(
                    f,
                    "checksum mismatch: expected 0x{expected:02X}, got 0x{actual:02X}"
                )
            }
            Self::UnexpectedByte { expected, actual } => {
                write!(
                    f,
                    "unexpected byte: expected {expected}, got 0x{actual:02X}"
                )
            }
            Self::InvalidHeader(b) => write!(f, "invalid block header byte: 0x{b:02X}"),
            Self::Io(msg) => write!(f, "I/O error: {msg}"),
        }
    }
}

impl std::error::Error for ModemError {}

impl From<std::io::Error> for ModemError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

/// Build an XMODEM or YMODEM block frame.
fn build_packet(header: u8, seq: u8, data: &[u8], mode: ModemMode) -> Vec<u8> {
    let mut packet = Vec::with_capacity(data.len() + 5);
    packet.push(header);
    packet.push(seq);
    packet.push(!seq);
    packet.extend_from_slice(data);
    match mode {
        ModemMode::XmodemChecksum => {
            packet.push(checksum(data));
        }
        ModemMode::XmodemCrc | ModemMode::Xmodem1K | ModemMode::Ymodem => {
            let crc = crc16_xmodem(data);
            packet.push((crc >> 8) as u8);
            packet.push((crc & 0xFF) as u8);
        }
    }
    packet
}

/// Encode YMODEM Block 0 containing filename and file size in decimal ASCII.
fn build_block_zero(filename: &str, file_size: usize) -> Vec<u8> {
    let mut data = vec![0u8; 128];
    if !filename.is_empty() {
        let fn_bytes = filename.as_bytes();
        let size_bytes = file_size.to_string().into_bytes();
        let max_fn = 128usize.saturating_sub(size_bytes.len() + 2);
        let fn_len = fn_bytes.len().min(max_fn);
        data[..fn_len].copy_from_slice(&fn_bytes[..fn_len]);
        data[fn_len] = 0;
        let start = fn_len + 1;
        let sz_len = size_bytes.len().min(128usize.saturating_sub(start + 1));
        data[start..start + sz_len].copy_from_slice(&size_bytes[..sz_len]);
        data[start + sz_len] = 0;
    }
    build_packet(SOH, 0, &data, ModemMode::Ymodem)
}

/// Encode empty Block 0 with all zero payload to conclude YMODEM batch session.
fn build_null_block() -> Vec<u8> {
    let data = vec![0u8; 128];
    build_packet(SOH, 0, &data, ModemMode::Ymodem)
}

/// Decode filename and file size from YMODEM Block 0 payload.
fn parse_block_zero(data: &[u8]) -> (Option<String>, Option<usize>) {
    if data.is_empty() || data[0] == 0 {
        return (None, None);
    }
    let null1 = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    let filename = String::from_utf8_lossy(&data[..null1]).to_string();
    if null1 + 1 >= data.len() {
        return (Some(filename), None);
    }
    let rem = &data[null1 + 1..];
    let null2 = rem
        .iter()
        .position(|&b| b == 0 || b == b' ')
        .unwrap_or(rem.len());
    let size_str = String::from_utf8_lossy(&rem[..null2]);
    let size = size_str.trim().parse::<usize>().ok();
    (Some(filename), size)
}

/// Sans-IO transmitter state machine for XMODEM and YMODEM.
pub struct XmodemSender {
    mode: ModemMode,
    payload: Vec<u8>,
    filename: Option<String>,
    max_retries: usize,
    state: SenderState,
    stats: TransferStats,
    out_buf: Vec<u8>,
    payload_offset: usize,
    current_block_num: usize,
    current_seq: u8,
    block_retries: usize,
    last_block_data: Vec<u8>,
    can_count: usize,
}

impl XmodemSender {
    /// Create a new sender for the given mode and payload.
    pub fn new(mode: ModemMode, payload: Vec<u8>) -> Self {
        Self {
            mode,
            payload,
            filename: None,
            max_retries: 10,
            state: SenderState::WaitingForStart,
            stats: TransferStats::default(),
            out_buf: Vec::new(),
            payload_offset: 0,
            current_block_num: 0,
            current_seq: if mode == ModemMode::Ymodem { 0 } else { 1 },
            block_retries: 0,
            last_block_data: Vec::new(),
            can_count: 0,
        }
    }

    /// Create a new YMODEM batch sender with filename and payload.
    pub fn new_ymodem(filename: impl Into<String>, payload: Vec<u8>) -> Self {
        let name = filename.into();
        let stats = TransferStats {
            file_name: Some(name.clone()),
            file_size: Some(payload.len()),
            ..Default::default()
        };
        Self {
            mode: ModemMode::Ymodem,
            payload,
            filename: Some(name),
            max_retries: 10,
            state: SenderState::WaitingForStart,
            stats,
            out_buf: Vec::new(),
            payload_offset: 0,
            current_block_num: 0,
            current_seq: 0,
            block_retries: 0,
            last_block_data: Vec::new(),
            can_count: 0,
        }
    }

    /// Configure maximum retries per block before aborting.
    pub fn with_max_retries(mut self, max_retries: usize) -> Self {
        self.max_retries = max_retries;
        self
    }

    /// Configure filename for YMODEM transfers.
    pub fn with_filename(mut self, filename: impl Into<String>) -> Self {
        let name = filename.into();
        self.stats.file_name = Some(name.clone());
        self.filename = Some(name);
        self
    }

    /// Current sender state.
    pub fn state(&self) -> SenderState {
        self.state
    }

    /// Current transfer statistics.
    pub fn stats(&self) -> &TransferStats {
        &self.stats
    }

    /// Return true when transfer has completed successfully.
    pub fn is_complete(&self) -> bool {
        self.state == SenderState::Complete
    }

    /// Return true when transfer was cancelled or aborted.
    pub fn is_cancelled(&self) -> bool {
        self.state == SenderState::Cancelled
    }

    /// Return true if outgoing bytes are waiting to be read.
    pub fn has_output(&self) -> bool {
        !self.out_buf.is_empty()
    }

    /// Borrow outgoing bytes without consuming them.
    pub fn output_bytes(&self) -> &[u8] {
        &self.out_buf
    }

    /// Remove the first `count` bytes from the outgoing buffer.
    pub fn consume_output(&mut self, count: usize) {
        let n = count.min(self.out_buf.len());
        self.out_buf.drain(..n);
    }

    /// Take all pending outgoing bytes.
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out_buf)
    }

    /// Cancel the transfer by emitting two CAN bytes.
    pub fn cancel(&mut self) {
        self.out_buf.push(CAN);
        self.out_buf.push(CAN);
        self.state = SenderState::Cancelled;
    }

    /// Process a slice of incoming bytes from the receiver.
    pub fn process_bytes(&mut self, bytes: &[u8]) -> Result<(), ModemError> {
        for &b in bytes {
            self.process_byte(b)?;
        }
        Ok(())
    }

    /// Process a single incoming byte from the receiver.
    pub fn process_byte(&mut self, byte: u8) -> Result<(), ModemError> {
        if byte == CAN {
            self.can_count += 1;
            if self.can_count >= 2 {
                self.state = SenderState::Cancelled;
                return Err(ModemError::Cancelled);
            }
            return Ok(());
        }
        self.can_count = 0;

        match self.state {
            SenderState::WaitingForStart => {
                let start_byte = match self.mode {
                    ModemMode::XmodemChecksum => NAK,
                    _ => CRC_POLL,
                };
                if byte == start_byte {
                    if self.mode == ModemMode::Ymodem {
                        let fname = self.filename.as_deref().unwrap_or("file.bin");
                        let fsize = self.payload.len();
                        let pkt = build_block_zero(fname, fsize);
                        self.last_block_data = pkt.clone();
                        self.out_buf.extend_from_slice(&pkt);
                        self.state = SenderState::SendingBlockZero;
                        self.block_retries = 0;
                    } else {
                        self.current_seq = 1;
                        self.current_block_num = 1;
                        self.send_next_data_block();
                    }
                }
            }
            SenderState::SendingBlockZero => {
                if byte == ACK {
                    self.block_retries = 0;
                    self.state = SenderState::WaitingForCAfterBlockZero;
                } else if byte == NAK {
                    self.handle_nak(0)?;
                }
            }
            SenderState::WaitingForCAfterBlockZero => {
                if byte == CRC_POLL {
                    self.current_seq = 1;
                    self.current_block_num = 1;
                    self.send_next_data_block();
                }
            }
            SenderState::SendingData => {
                if byte == ACK {
                    self.stats.blocks_transferred += 1;
                    self.block_retries = 0;
                    self.current_seq = self.current_seq.wrapping_add(1);
                    self.current_block_num += 1;
                    self.send_next_data_block();
                } else if byte == NAK {
                    self.handle_nak(self.current_block_num)?;
                }
            }
            SenderState::SendingEot => {
                if byte == NAK {
                    self.block_retries += 1;
                    self.stats.retransmissions += 1;
                    if self.block_retries >= self.max_retries {
                        self.cancel();
                        return Err(ModemError::MaxRetriesExceeded {
                            block: self.current_block_num,
                        });
                    }
                    self.out_buf.push(EOT);
                } else if byte == ACK {
                    self.block_retries = 0;
                    if self.mode == ModemMode::Ymodem {
                        self.state = SenderState::WaitingForCAfterEot;
                    } else {
                        self.state = SenderState::Complete;
                    }
                }
            }
            SenderState::WaitingForCAfterEot => {
                if byte == CRC_POLL {
                    let pkt = build_null_block();
                    self.last_block_data = pkt.clone();
                    self.out_buf.extend_from_slice(&pkt);
                    self.state = SenderState::SendingNullBlock;
                    self.block_retries = 0;
                }
            }
            SenderState::SendingNullBlock => {
                if byte == ACK {
                    self.state = SenderState::Complete;
                } else if byte == NAK {
                    self.handle_nak(0)?;
                }
            }
            SenderState::Complete | SenderState::Cancelled => {}
        }
        Ok(())
    }

    fn handle_nak(&mut self, block: usize) -> Result<(), ModemError> {
        self.block_retries += 1;
        self.stats.retransmissions += 1;
        if self.block_retries >= self.max_retries {
            self.cancel();
            return Err(ModemError::MaxRetriesExceeded { block });
        }
        self.out_buf.extend_from_slice(&self.last_block_data);
        Ok(())
    }

    fn send_next_data_block(&mut self) {
        if self.payload_offset >= self.payload.len() {
            self.out_buf.push(EOT);
            self.state = SenderState::SendingEot;
            self.block_retries = 0;
        } else {
            let remaining = self.payload.len() - self.payload_offset;
            let block_size = match self.mode {
                ModemMode::Xmodem1K => 1024,
                ModemMode::Ymodem if remaining > 128 => 1024,
                _ => 128,
            };
            let chunk_len = remaining.min(block_size);
            let header = if block_size == 1024 { STX } else { SOH };
            let mut block_data = vec![CPMEOF; block_size];
            block_data[..chunk_len].copy_from_slice(
                &self.payload[self.payload_offset..self.payload_offset + chunk_len],
            );
            self.payload_offset += chunk_len;
            self.stats.bytes_transferred += chunk_len;

            let pkt = build_packet(header, self.current_seq, &block_data, self.mode);
            self.last_block_data = pkt.clone();
            self.out_buf.extend_from_slice(&pkt);
            self.state = SenderState::SendingData;
        }
    }

    /// Run the sender synchronously over reader and writer streams.
    pub fn send_stream<R: Read, W: Write>(
        &mut self,
        reader: &mut R,
        writer: &mut W,
    ) -> Result<TransferStats, ModemError> {
        send_stream(self, reader, writer)
    }
}

/// Sans-IO receiver state machine for XMODEM and YMODEM.
pub struct XmodemReceiver {
    mode: ModemMode,
    max_retries: usize,
    state: ReceiverState,
    stats: TransferStats,
    out_buf: Vec<u8>,
    rx_buf: Vec<u8>,
    received_data: Vec<u8>,
    file_name: Option<String>,
    file_size: Option<usize>,
    expected_seq: u8,
    retries: usize,
    eot_seen: bool,
}

impl XmodemReceiver {
    /// Create a new receiver for the specified mode.
    pub fn new(mode: ModemMode) -> Self {
        let mut out_buf = Vec::new();
        let state = match mode {
            ModemMode::Ymodem => {
                out_buf.push(CRC_POLL);
                ReceiverState::WaitingForBlockZero
            }
            ModemMode::XmodemChecksum => {
                out_buf.push(NAK);
                ReceiverState::WaitingForStart
            }
            ModemMode::XmodemCrc | ModemMode::Xmodem1K => {
                out_buf.push(CRC_POLL);
                ReceiverState::WaitingForStart
            }
        };

        Self {
            mode,
            max_retries: 10,
            state,
            stats: TransferStats::default(),
            out_buf,
            rx_buf: Vec::new(),
            received_data: Vec::new(),
            file_name: None,
            file_size: None,
            expected_seq: if mode == ModemMode::Ymodem { 0 } else { 1 },
            retries: 0,
            eot_seen: false,
        }
    }

    /// Configure maximum retries before aborting.
    pub fn with_max_retries(mut self, max_retries: usize) -> Self {
        self.max_retries = max_retries;
        self
    }

    /// Current receiver state.
    pub fn state(&self) -> ReceiverState {
        self.state
    }

    /// Current transfer statistics.
    pub fn stats(&self) -> &TransferStats {
        &self.stats
    }

    /// Return true when transfer has completed successfully.
    pub fn is_complete(&self) -> bool {
        self.state == ReceiverState::Complete
    }

    /// Return true when transfer was cancelled or aborted.
    pub fn is_cancelled(&self) -> bool {
        self.state == ReceiverState::Cancelled
    }

    /// Return true if outgoing control bytes are waiting to be read.
    pub fn has_output(&self) -> bool {
        !self.out_buf.is_empty()
    }

    /// Borrow outgoing control bytes.
    pub fn output_bytes(&self) -> &[u8] {
        &self.out_buf
    }

    /// Consume the first `count` outgoing bytes.
    pub fn consume_output(&mut self, count: usize) {
        let n = count.min(self.out_buf.len());
        self.out_buf.drain(..n);
    }

    /// Take all pending outgoing control bytes.
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out_buf)
    }

    /// Borrow the decoded payload bytes.
    pub fn data(&self) -> &[u8] {
        &self.received_data
    }

    /// Consume receiver and return decoded payload bytes.
    pub fn into_data(self) -> Vec<u8> {
        self.received_data
    }

    /// Return filename parsed from Block 0 (YMODEM).
    pub fn file_name(&self) -> Option<&str> {
        self.file_name.as_deref()
    }

    /// Return exact file size in bytes parsed from Block 0 (YMODEM).
    pub fn file_size(&self) -> Option<usize> {
        self.file_size
    }

    /// Cancel transfer by emitting two CAN bytes.
    pub fn cancel(&mut self) {
        self.out_buf.push(CAN);
        self.out_buf.push(CAN);
        self.state = ReceiverState::Cancelled;
    }

    /// Process a single incoming byte.
    pub fn process_byte(&mut self, byte: u8) -> Result<(), ModemError> {
        self.process_bytes(&[byte])
    }

    /// Process a slice of incoming bytes from the sender.
    pub fn process_bytes(&mut self, bytes: &[u8]) -> Result<(), ModemError> {
        self.rx_buf.extend_from_slice(bytes);

        loop {
            if self.state == ReceiverState::Complete || self.state == ReceiverState::Cancelled {
                return Ok(());
            }

            if self.rx_buf.is_empty() {
                return Ok(());
            }

            // Two consecutive CAN bytes cancel transfer immediately.
            if self.rx_buf[0] == CAN {
                if self.rx_buf.len() >= 2 && self.rx_buf[1] == CAN {
                    self.state = ReceiverState::Cancelled;
                    return Err(ModemError::Cancelled);
                }
                if self.rx_buf.len() == 1 {
                    return Ok(());
                }
                self.rx_buf.remove(0);
                continue;
            }

            // EOT handling
            if self.rx_buf[0] == EOT {
                self.rx_buf.remove(0);
                if self.mode == ModemMode::Ymodem {
                    if !self.eot_seen {
                        self.eot_seen = true;
                        self.out_buf.push(NAK);
                    } else {
                        self.out_buf.push(ACK);
                        self.out_buf.push(CRC_POLL);
                        self.state = ReceiverState::WaitingForNullBlock;
                        self.expected_seq = 0;
                    }
                } else {
                    self.out_buf.push(ACK);
                    self.state = ReceiverState::Complete;
                }
                continue;
            }

            // SOH or STX block packet
            if self.rx_buf[0] == SOH || self.rx_buf[0] == STX {
                let header = self.rx_buf[0];
                let block_len = if header == SOH { 128 } else { 1024 };
                let check_len = match self.mode {
                    ModemMode::XmodemChecksum => 1,
                    _ => 2,
                };
                let packet_len = 3 + block_len + check_len;

                if self.rx_buf.len() < packet_len {
                    return Ok(());
                }

                let seq = self.rx_buf[1];
                let comp = self.rx_buf[2];

                // Check sequence complement
                if comp != (seq ^ 0xFF) {
                    self.out_buf.push(CAN);
                    self.out_buf.push(CAN);
                    self.state = ReceiverState::Cancelled;
                    return Err(ModemError::InvalidComplement {
                        seq,
                        complement: comp,
                    });
                }

                let data = &self.rx_buf[3..3 + block_len];

                let is_valid = match self.mode {
                    ModemMode::XmodemChecksum => {
                        let expected_csum = checksum(data);
                        let actual_csum = self.rx_buf[3 + block_len];
                        expected_csum == actual_csum
                    }
                    _ => {
                        let expected_crc = crc16_xmodem(data);
                        let actual_crc = ((self.rx_buf[3 + block_len] as u16) << 8)
                            | (self.rx_buf[4 + block_len] as u16);
                        expected_crc == actual_crc
                    }
                };

                if !is_valid {
                    self.stats.crc_errors += 1;
                    self.retries += 1;
                    self.rx_buf.drain(..packet_len);
                    if self.retries >= self.max_retries {
                        self.out_buf.push(CAN);
                        self.out_buf.push(CAN);
                        self.state = ReceiverState::Cancelled;
                        let block = self.stats.blocks_transferred + 1;
                        return Err(ModemError::MaxRetriesExceeded { block });
                    }
                    self.out_buf.push(NAK);
                    continue;
                }

                self.retries = 0;
                let data_vec = data.to_vec();
                self.rx_buf.drain(..packet_len);

                match self.state {
                    ReceiverState::WaitingForBlockZero => {
                        if seq == 0 {
                            let (fname, fsize) = parse_block_zero(&data_vec);
                            self.file_name = fname.clone();
                            self.file_size = fsize;
                            self.stats.file_name = fname;
                            self.stats.file_size = fsize;
                            self.out_buf.push(ACK);
                            self.out_buf.push(CRC_POLL);
                            self.expected_seq = 1;
                            self.state = ReceiverState::WaitingForBlock;
                        } else {
                            self.out_buf.push(NAK);
                        }
                    }
                    ReceiverState::WaitingForNullBlock => {
                        if seq == 0 {
                            self.out_buf.push(ACK);
                            if let Some(size) = self.file_size {
                                if self.received_data.len() > size {
                                    self.received_data.truncate(size);
                                }
                                self.stats.bytes_transferred = self.received_data.len();
                            }
                            self.state = ReceiverState::Complete;
                        } else {
                            self.out_buf.push(NAK);
                        }
                    }
                    ReceiverState::WaitingForStart | ReceiverState::WaitingForBlock => {
                        if seq == self.expected_seq {
                            self.received_data.extend_from_slice(&data_vec);
                            self.expected_seq = self.expected_seq.wrapping_add(1);
                            self.stats.blocks_transferred += 1;
                            self.stats.bytes_transferred += block_len;
                            self.out_buf.push(ACK);
                            self.state = ReceiverState::WaitingForBlock;
                        } else if seq == self.expected_seq.wrapping_sub(1) {
                            self.out_buf.push(ACK);
                        } else {
                            self.out_buf.push(NAK);
                        }
                    }
                    ReceiverState::Complete | ReceiverState::Cancelled => {}
                }
                continue;
            }

            // Discard line noise byte
            self.rx_buf.remove(0);
        }
    }

    /// Run the receiver synchronously over reader and writer streams.
    pub fn receive_stream<R: Read, W: Write>(
        &mut self,
        reader: &mut R,
        writer: &mut W,
    ) -> Result<TransferStats, ModemError> {
        receive_stream(self, reader, writer)
    }
}

/// Generic synchronous stream helper driving an [`XmodemSender`].
pub fn send_stream<R: Read, W: Write>(
    sender: &mut XmodemSender,
    reader: &mut R,
    writer: &mut W,
) -> Result<TransferStats, ModemError> {
    let mut buf = [0u8; 1024];
    loop {
        let out = sender.take_output();
        if !out.is_empty() {
            writer
                .write_all(&out)
                .map_err(|e| ModemError::Io(e.to_string()))?;
            writer.flush().map_err(|e| ModemError::Io(e.to_string()))?;
        }

        if sender.is_complete() {
            return Ok(sender.stats().clone());
        }
        if sender.is_cancelled() {
            return Err(ModemError::Cancelled);
        }

        let n = reader
            .read(&mut buf)
            .map_err(|e| ModemError::Io(e.to_string()))?;
        if n == 0 {
            return Err(ModemError::Io(
                "unexpected EOF waiting for receiver response".to_string(),
            ));
        }

        sender.process_bytes(&buf[..n])?;
    }
}

/// Generic synchronous stream helper driving an [`XmodemReceiver`].
pub fn receive_stream<R: Read, W: Write>(
    receiver: &mut XmodemReceiver,
    reader: &mut R,
    writer: &mut W,
) -> Result<TransferStats, ModemError> {
    let mut buf = [0u8; 2048];
    loop {
        let out = receiver.take_output();
        if !out.is_empty() {
            writer
                .write_all(&out)
                .map_err(|e| ModemError::Io(e.to_string()))?;
            writer.flush().map_err(|e| ModemError::Io(e.to_string()))?;
        }

        if receiver.is_complete() {
            return Ok(receiver.stats().clone());
        }
        if receiver.is_cancelled() {
            return Err(ModemError::Cancelled);
        }

        let n = reader
            .read(&mut buf)
            .map_err(|e| ModemError::Io(e.to_string()))?;
        if n == 0 {
            return Err(ModemError::Io(
                "unexpected EOF receiving modem stream".to_string(),
            ));
        }

        receiver.process_bytes(&buf[..n])?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    #[test]
    fn crc16_xmodem_matches_standard_test_vector() {
        assert_eq!(crc16_xmodem(b"123456789"), 0x31C3);
    }

    #[test]
    fn xmodem_crc_roundtrips_multi_block_payload_and_pads_last_block() {
        let payload: Vec<u8> = (0..300).map(|i| ((i * 7 + 13) % 256) as u8).collect();
        let mut sender = XmodemSender::new(ModemMode::XmodemCrc, payload.clone());
        let mut receiver = XmodemReceiver::new(ModemMode::XmodemCrc);

        let mut iterations = 0;
        while (!sender.is_complete() || !receiver.is_complete()) && iterations < 1000 {
            iterations += 1;
            let rx_bytes = receiver.take_output();
            if !rx_bytes.is_empty() {
                sender.process_bytes(&rx_bytes).expect("sender process");
            }
            let tx_bytes = sender.take_output();
            if !tx_bytes.is_empty() {
                receiver.process_bytes(&tx_bytes).expect("receiver process");
            }
        }

        assert!(sender.is_complete());
        assert!(receiver.is_complete());
        let received = receiver.data();
        assert_eq!(received.len(), 384);
        assert_eq!(&received[..300], &payload[..]);
        for &b in &received[300..384] {
            assert_eq!(b, CPMEOF);
        }
        assert_eq!(sender.stats().blocks_transferred, 3);
        assert_eq!(receiver.stats().blocks_transferred, 3);
    }

    #[test]
    fn nak_triggers_block_retransmit_and_recovers() {
        let payload: Vec<u8> = (0..256).map(|i| (i % 256) as u8).collect();
        let mut sender = XmodemSender::new(ModemMode::XmodemCrc, payload.clone());
        let mut receiver = XmodemReceiver::new(ModemMode::XmodemCrc);

        // Handshake: receiver emits 'C'
        let rx_c = receiver.take_output();
        sender.process_bytes(&rx_c).unwrap();

        // Block 1: sender emits block 1, receiver accepts and emits ACK
        let block1 = sender.take_output();
        receiver.process_bytes(&block1).unwrap();
        let ack1 = receiver.take_output();
        sender.process_bytes(&ack1).unwrap();

        // Block 2: sender emits block 2. Corrupt it before receiver inspects it.
        let block2 = sender.take_output();
        let mut corrupted_block2 = block2.clone();
        corrupted_block2[10] ^= 0xFF; // corrupt payload byte

        receiver.process_bytes(&corrupted_block2).unwrap();
        assert_eq!(receiver.stats().crc_errors, 1);
        let nak = receiver.take_output();
        assert_eq!(nak, vec![NAK]);

        // Feed NAK to sender. Sender must re-emit block 2.
        sender.process_bytes(&nak).unwrap();
        assert_eq!(sender.stats().retransmissions, 1);
        let resent_block2 = sender.take_output();
        assert_eq!(resent_block2, block2);

        // Receiver accepts re-sent block 2
        receiver.process_bytes(&resent_block2).unwrap();
        let ack2 = receiver.take_output();
        sender.process_bytes(&ack2).unwrap();

        // Sender sends EOT
        let eot = sender.take_output();
        assert_eq!(eot, vec![EOT]);
        receiver.process_bytes(&eot).unwrap();
        let ack_eot = receiver.take_output();
        sender.process_bytes(&ack_eot).unwrap();

        assert!(sender.is_complete());
        assert!(receiver.is_complete());
        assert_eq!(receiver.data(), &payload[..]);
        assert_eq!(sender.stats().retransmissions, 1);
    }

    #[test]
    fn ymodem_carries_filename_and_exact_size_in_block_zero() {
        let payload: Vec<u8> = (0..500).map(|i| ((i * 11 + 3) % 256) as u8).collect();
        let mut sender = XmodemSender::new_ymodem("bootloader.bin", payload.clone());
        let mut receiver = XmodemReceiver::new(ModemMode::Ymodem);

        let mut iterations = 0;
        while (!sender.is_complete() || !receiver.is_complete()) && iterations < 1000 {
            iterations += 1;
            let rx_bytes = receiver.take_output();
            if !rx_bytes.is_empty() {
                sender.process_bytes(&rx_bytes).expect("sender step");
            }
            let tx_bytes = sender.take_output();
            if !tx_bytes.is_empty() {
                receiver.process_bytes(&tx_bytes).expect("receiver step");
            }
        }

        assert!(sender.is_complete());
        assert!(receiver.is_complete());
        assert_eq!(receiver.file_name(), Some("bootloader.bin"));
        assert_eq!(receiver.file_size(), Some(500));
        assert_eq!(receiver.data().len(), 500);
        assert_eq!(receiver.data(), &payload[..]);
        assert_eq!(
            receiver.stats().file_name.as_deref(),
            Some("bootloader.bin")
        );
        assert_eq!(receiver.stats().file_size, Some(500));
    }

    #[test]
    fn bad_sequence_complement_or_double_can_aborts_cleanly() {
        // Bad sequence complement in receiver
        let mut receiver = XmodemReceiver::new(ModemMode::XmodemCrc);
        let _ = receiver.take_output(); // consume initial 'C'
        let mut bad_pkt = build_packet(SOH, 1, &[0x42; 128], ModemMode::XmodemCrc);
        bad_pkt[2] = 0xAA; // 1 ^ 0xFF is 0xFE, corrupted to 0xAA

        let err = receiver.process_bytes(&bad_pkt).unwrap_err();
        assert_eq!(
            err,
            ModemError::InvalidComplement {
                seq: 1,
                complement: 0xAA
            }
        );
        assert!(receiver.is_cancelled());
        assert_eq!(receiver.take_output(), vec![CAN, CAN]);

        // Double CAN aborts sender
        let mut sender = XmodemSender::new(ModemMode::XmodemCrc, vec![1, 2, 3]);
        let err = sender.process_bytes(&[CAN, CAN]).unwrap_err();
        assert_eq!(err, ModemError::Cancelled);
        assert!(sender.is_cancelled());

        // Double CAN aborts receiver
        let mut receiver2 = XmodemReceiver::new(ModemMode::XmodemCrc);
        let err = receiver2.process_bytes(&[CAN, CAN]).unwrap_err();
        assert_eq!(err, ModemError::Cancelled);
        assert!(receiver2.is_cancelled());

        // Lone CAN separated by other byte does not abort
        let mut sender2 = XmodemSender::new(ModemMode::XmodemCrc, vec![1, 2, 3]);
        assert!(sender2.process_bytes(&[CAN, 0x00, CAN]).is_ok());
        assert!(!sender2.is_cancelled());
    }

    #[test]
    fn xmodem_checksum_roundtrip() {
        let payload: Vec<u8> = vec![0x42; 128];
        let mut sender = XmodemSender::new(ModemMode::XmodemChecksum, payload.clone());
        let mut receiver = XmodemReceiver::new(ModemMode::XmodemChecksum);

        let mut iterations = 0;
        while (!sender.is_complete() || !receiver.is_complete()) && iterations < 100 {
            iterations += 1;
            let rx = receiver.take_output();
            if !rx.is_empty() {
                sender.process_bytes(&rx).unwrap();
            }
            let tx = sender.take_output();
            if !tx.is_empty() {
                receiver.process_bytes(&tx).unwrap();
            }
        }

        assert!(sender.is_complete());
        assert!(receiver.is_complete());
        assert_eq!(receiver.data(), &payload[..]);
    }

    #[test]
    fn xmodem_1k_roundtrip() {
        let payload: Vec<u8> = (0..1024).map(|i| (i % 256) as u8).collect();
        let mut sender = XmodemSender::new(ModemMode::Xmodem1K, payload.clone());
        let mut receiver = XmodemReceiver::new(ModemMode::Xmodem1K);

        let mut iterations = 0;
        while (!sender.is_complete() || !receiver.is_complete()) && iterations < 100 {
            iterations += 1;
            let rx = receiver.take_output();
            if !rx.is_empty() {
                sender.process_bytes(&rx).unwrap();
            }
            let tx = sender.take_output();
            if !tx.is_empty() {
                receiver.process_bytes(&tx).unwrap();
            }
        }

        assert!(sender.is_complete());
        assert!(receiver.is_complete());
        assert_eq!(receiver.data(), &payload[..]);
        assert_eq!(sender.stats().blocks_transferred, 1);
    }

    // In-memory duplex pipe for testing send_stream and receive_stream across threads
    struct PipeReader {
        buf: Arc<Mutex<VecDeque<u8>>>,
        cond: Arc<Condvar>,
        closed: Arc<AtomicBool>,
    }

    struct PipeWriter {
        buf: Arc<Mutex<VecDeque<u8>>>,
        cond: Arc<Condvar>,
        closed: Arc<AtomicBool>,
    }

    fn create_pipe() -> (PipeReader, PipeWriter) {
        let buf = Arc::new(Mutex::new(VecDeque::new()));
        let cond = Arc::new(Condvar::new());
        let closed = Arc::new(AtomicBool::new(false));
        (
            PipeReader {
                buf: Arc::clone(&buf),
                cond: Arc::clone(&cond),
                closed: Arc::clone(&closed),
            },
            PipeWriter { buf, cond, closed },
        )
    }

    impl Read for PipeReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            loop {
                let mut q = self.buf.lock().unwrap();
                if !q.is_empty() {
                    let mut n = 0;
                    while n < out.len() && !q.is_empty() {
                        out[n] = q.pop_front().unwrap();
                        n += 1;
                    }
                    return Ok(n);
                }
                if self.closed.load(Ordering::SeqCst) {
                    return Ok(0);
                }
                q = self.cond.wait(q).unwrap();
            }
        }
    }

    impl Write for PipeWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let mut q = self.buf.lock().unwrap();
            q.extend(data);
            self.cond.notify_all();
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for PipeWriter {
        fn drop(&mut self) {
            self.closed.store(true, Ordering::SeqCst);
            self.cond.notify_all();
        }
    }

    #[test]
    fn send_and_receive_stream_roundtrip_over_pipes() {
        let payload: Vec<u8> = (0..500).map(|i| ((i * 3 + 7) % 256) as u8).collect();
        let (mut s2r_reader, mut s2r_writer) = create_pipe();
        let (mut r2s_reader, mut r2s_writer) = create_pipe();

        let sender_payload = payload.clone();
        let sender_handle = std::thread::spawn(move || {
            let mut sender = XmodemSender::new_ymodem("stream.bin", sender_payload);
            sender.send_stream(&mut r2s_reader, &mut s2r_writer)
        });

        let mut receiver = XmodemReceiver::new(ModemMode::Ymodem);
        let recv_stats = receiver
            .receive_stream(&mut s2r_reader, &mut r2s_writer)
            .unwrap();
        let send_stats = sender_handle.join().unwrap().unwrap();

        assert_eq!(recv_stats.file_name.as_deref(), Some("stream.bin"));
        assert_eq!(recv_stats.file_size, Some(500));
        assert_eq!(receiver.data(), &payload[..]);
        assert_eq!(send_stats.file_name.as_deref(), Some("stream.bin"));
    }
}
