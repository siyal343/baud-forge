//! XMODEM-CRC / XMODEM-1K transfer state machine (spec 2.7 / FR-XFER-*).
//!
//! One [`XferSession`] runs per port, driven by the pump: raw bytes from the
//! device go into [`XferSession::on_chunk`], timeouts tick through
//! [`XferSession::tick`], and every response the engine must transmit comes
//! back through the `reply` callback. Blocks are validated (number,
//! complement, CRC-16/XMODEM) before being acknowledged; a duplicate block is
//! re-ACKed instead of re-written, which is what makes device retries safe.

use std::time::{Duration, Instant};

pub const SOH: u8 = 0x01; // 128-byte block
pub const STX: u8 = 0x02; // 1024-byte block
pub const EOT: u8 = 0x04;
pub const ACK: u8 = 0x06;
pub const NAK: u8 = 0x15;
pub const CAN: u8 = 0x18;
pub const CRC_CH: u8 = b'C';

const SMALL: usize = 128;
const LARGE: usize = 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_LIMIT: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XferDirection {
    /// The engine transmits a file to the device.
    Send,
    /// The engine receives a file from the device.
    Recv,
}

#[derive(Debug, Clone, PartialEq)]
pub enum XferPhase {
    /// Receiver: poll for a start character. Sender: wait for one.
    Handshake,
    /// Blocks in flight.
    Transferring,
    /// EOT sent or received; awaiting the final ACK.
    Finishing,
    Done,
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XferMode {
    Crc128,
    Crc1K,
}

/// CRC-16/XMODEM (poly 0x1021, init 0x0000, no reflect, no xorout).
pub fn crc_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0x0000;
    for &b in data {
        crc ^= u16::from(b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

#[derive(Debug)]
pub struct XferSession {
    pub port_id: String,
    pub direction: XferDirection,
    pub mode: XferMode,
    pub name: String,
    /// Send: the file to transmit. Recv: the accumulated file.
    pub data: Vec<u8>,
    /// Send: block in flight. Recv: last accepted block number.
    pub block: u32,
    pub phase: XferPhase,
    pub bytes_done: u64,
    pub retries: u32,
    /// The UI knows the true file size (XMODEM has none on the wire) — the
    /// receiver trims the final block's padding to this when Done.
    pub expected_len: Option<usize>,
    /// Receiver: the block being accumulated (header + body + crc).
    pending: Vec<u8>,
    awaiting_ack: bool,
    last_event: Instant,
}

impl XferSession {
    pub fn new(
        port_id: &str,
        direction: XferDirection,
        mode: XferMode,
        name: String,
        data: Vec<u8>,
        now: Instant,
    ) -> Self {
        Self {
            port_id: port_id.to_string(),
            direction,
            mode,
            name,
            data,
            block: 0,
            phase: XferPhase::Handshake,
            bytes_done: 0,
            retries: 0,
            expected_len: None,
            pending: Vec::new(),
            awaiting_ack: false,
            last_event: now,
        }
    }

    fn block_size(&self) -> usize {
        match self.mode {
            XferMode::Crc1K => LARGE,
            XferMode::Crc128 => SMALL,
        }
    }

    /// Total blocks in the file for this mode.
    pub fn total_blocks(&self) -> u32 {
        let size = self.block_size();
        ((self.data.len() + size - 1) / size).max(1) as u32
    }

    fn build_block(&self, number: u32) -> Vec<u8> {
        let size = self.block_size();
        let start = (number as usize - 1) * size;
        let end = (start + size).min(self.data.len());
        let mut body = vec![0u8; size];
        body[..end - start].copy_from_slice(&self.data[start..end]);
        let crc = crc_xmodem(&body);
        let mut block = vec![if size == LARGE { STX } else { SOH }, number as u8, !(number as u8)];
        block.extend_from_slice(&body);
        block.push((crc >> 8) as u8);
        block.push((crc & 0xff) as u8);
        block
    }

    fn send_next_block(&mut self, reply: &mut impl FnMut(Vec<u8>)) {
        self.block += 1;
        if self.block > self.total_blocks() {
            reply(vec![EOT]);
            self.phase = XferPhase::Finishing;
            return;
        }
        self.awaiting_ack = true;
        reply(self.build_block(self.block));
        self.bytes_done =
            (self.block as usize * self.block_size()).min(self.data.len()) as u64;
        self.phase = XferPhase::Transferring;
    }

    fn resend_block(&mut self, reply: &mut impl FnMut(Vec<u8>)) {
        reply(self.build_block(self.block.max(1)));
    }

    /// Raw bytes from the device. The pump feeds whole slabs.
    pub fn on_chunk(&mut self, chunk: &[u8], now: Instant, reply: &mut impl FnMut(Vec<u8>)) {
        for &byte in chunk {
            if matches!(self.phase, XferPhase::Done | XferPhase::Failed(_)) {
                break;
            }
            self.last_event = now;
            if self.direction == XferDirection::Send {
                self.byte_send(byte, reply);
            } else {
                self.byte_recv(byte, reply);
            }
        }
    }

    fn byte_send(&mut self, byte: u8, reply: &mut impl FnMut(Vec<u8>)) {
        match self.phase {
            XferPhase::Handshake => {
                if byte == CRC_CH || byte == NAK {
                    self.send_next_block(reply);
                }
            }
            XferPhase::Transferring => match byte {
                ACK => {
                    self.retries = 0;
                    self.awaiting_ack = false;
                    if self.block >= self.total_blocks() {
                        reply(vec![EOT]);
                        self.phase = XferPhase::Finishing;
                    } else {
                        self.send_next_block(reply);
                    }
                }
                NAK => {
                    self.retries += 1;
                    if self.retries > RETRY_LIMIT {
                        self.phase = XferPhase::Failed("retry limit reached".into());
                        return;
                    }
                    self.resend_block(reply);
                }
                CAN => {
                    self.phase = XferPhase::Failed("cancelled by device (CAN)".into());
                }
                _ => {}
            },
            XferPhase::Finishing => {
                eprintln!("xfer[{}]: finishing byte 0x{:02X}", self.port_id, byte);
                if byte == ACK {
                    self.phase = XferPhase::Done;
                    eprintln!("xfer[{}]: DONE", self.port_id);
                }
            }
            XferPhase::Done | XferPhase::Failed(_) => {}
        }
    }

    fn byte_recv(&mut self, byte: u8, reply: &mut impl FnMut(Vec<u8>)) {
        match self.phase {
            XferPhase::Handshake => {
                // The block that answers our 'C' poll starts the transfer.
                if byte == SOH || byte == STX {
                    self.pending.clear();
                    self.pending.push(byte);
                    self.phase = XferPhase::Transferring;
                }
            }
            XferPhase::Transferring | XferPhase::Finishing => match byte {
                // While a block is being accumulated EVERY byte is data —
                // binary payloads legitimately contain SOH/STX/EOT values.
                EOT if self.pending.is_empty() => {
                    reply(vec![ACK]);
                    if let Some(expected) = self.expected_len {
                        self.data.truncate(expected);
                    }
                    self.bytes_done = self.data.len() as u64;
                    self.phase = XferPhase::Done;
                }
                CAN if self.pending.is_empty() => {
                    self.phase = XferPhase::Failed("cancelled by device (CAN)".into());
                }
                _ if !self.pending.is_empty() => {
                    self.pending.push(byte);
                    let want = self.block_size() + 5; // hdr 3 + data + crc 2
                    if self.pending.len() == want {
                        self.validate_block(reply);
                    }
                }
                SOH | STX => {
                    self.pending.clear();
                    self.pending.push(byte);
                }
                _ => { /* stray byte between blocks: resync on the next SOH/STX */ }
            },
            XferPhase::Done | XferPhase::Failed(_) => {}
        }
    }

    fn validate_block(&mut self, reply: &mut impl FnMut(Vec<u8>)) {
        let buf = std::mem::take(&mut self.pending);
        let size = self.block_size();
        if buf.len() < size + 5 {
            reply(vec![NAK]);
            return;
        }
        let number = buf[1];
        let complement = buf[2];
        let body = &buf[3..3 + size];
        let crc = u16::from_be_bytes([buf[3 + size], buf[4 + size]]);

        if complement != !number {
            reply(vec![NAK]);
            return;
        }
        let next = (self.block as u8).wrapping_add(1);
        if number == next {
            if crc_xmodem(body) != crc {
                reply(vec![NAK]);
                return;
            }
            self.block = u32::from(number);
            self.data.extend_from_slice(body);
            self.bytes_done = self.data.len() as u64;
            self.retries = 0;
            reply(vec![ACK]);
        } else if number == self.block as u8 && self.block > 0 {
            // Duplicate: our ACK was lost on the wire. Re-acknowledge without
            // re-appending — this is what makes device retries safe.
            reply(vec![ACK]);
        } else {
            reply(vec![NAK]);
        }
    }

    /// Pump tick: handshake polling and timeout handling.
    pub fn tick(&mut self, now: Instant, reply: &mut impl FnMut(Vec<u8>)) {
        match self.phase {
            XferPhase::Handshake => {
                // The receiver must keep offering the start character; the
                // sender waits silently for it.
                if self.direction == XferDirection::Recv
                    && now.duration_since(self.last_event) >= Duration::from_secs(1)
                {
                    reply(vec![CRC_CH]);
                    self.last_event = now;
                }
            }
            XferPhase::Transferring => {
                let waiting = self.direction == XferDirection::Send && self.awaiting_ack;
                if now.duration_since(self.last_event) >= IDLE_TIMEOUT {
                    self.retries += 1;
                    if self.retries > RETRY_LIMIT {
                        self.phase = XferPhase::Failed("idle timeout".into());
                        return;
                    }
                    self.last_event = now;
                    if waiting {
                        self.resend_block(reply);
                    } else if self.direction == XferDirection::Recv {
                        reply(vec![CRC_CH]);
                    }
                }
            }
            XferPhase::Finishing => {
                eprintln!("xfer[{}]: finishing tick, elapsed {:?}", self.port_id, now.duration_since(self.last_event));
                if now.duration_since(self.last_event) >= IDLE_TIMEOUT {
                    self.phase = XferPhase::Failed("EOT not acknowledged".into());
                }
            }
            XferPhase::Done | XferPhase::Failed(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Sink = std::rc::Rc<std::cell::RefCell<Vec<u8>>>;

    fn sink() -> Sink {
        std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))
    }

    fn reply_for(sink: &Sink) -> impl FnMut(Vec<u8>) + '_ {
        let s = sink.clone();
        move |bytes: Vec<u8>| s.borrow_mut().extend_from_slice(&bytes)
    }

    fn wire(sink: &Sink) -> Vec<u8> {
        sink.borrow().clone()
    }

    fn t0() -> Instant {
        Instant::now()
    }

    fn block_for(file: &[u8], number: u32) -> Vec<u8> {
        let start = (number as usize - 1) * SMALL;
        let end = (start + SMALL).min(file.len());
        let mut body = vec![0u8; SMALL];
        body[..end - start].copy_from_slice(&file[start..end]);
        let crc = crc_xmodem(&body);
        let mut block = vec![SOH, number as u8, !(number as u8)];
        block.extend_from_slice(&body);
        block.push((crc >> 8) as u8);
        block.push((crc & 0xff) as u8);
        block
    }

    #[test]
    fn crc_xmodem_matches_check_value() {
        // Catalogue check value for CRC-16/XMODEM.
        assert_eq!(crc_xmodem(b"123456789"), 0x31C3);
    }

    #[test]
    fn receiver_accepts_a_full_crc_transfer() {
        let file: Vec<u8> = (0..300u32).map(|i| (i % 251) as u8).collect(); // 3 blocks
        let mut rx = XferSession::new(
            "devA",
            XferDirection::Recv,
            XferMode::Crc128,
            "fw.bin".into(),
            Vec::new(),
            t0(),
        );
        rx.expected_len = Some(file.len());
        let out = sink();
        let mut reply = reply_for(&out);
        let now = t0();

        rx.tick(now + Duration::from_secs(1), &mut reply);
        assert_eq!(wire(&out).last(), Some(&CRC_CH));

        for number in 1u32..=3 {
            let before = wire(&out).len();
            rx.on_chunk(&block_for(&file, number), now, &mut reply);
            assert_eq!(&wire(&out)[before..], &[ACK], "block {number} must be ACKed");
        }

        rx.on_chunk(&[EOT], now, &mut reply);
        assert_eq!(wire(&out).last(), Some(&ACK));
        assert_eq!(rx.phase, XferPhase::Done);
        assert_eq!(rx.data, file);
    }

    #[test]
    fn receiver_naks_corrupt_crc_and_accepts_the_retry() {
        let mut rx = XferSession::new(
            "devA",
            XferDirection::Recv,
            XferMode::Crc128,
            "fw.bin".into(),
            Vec::new(),
            t0(),
        );
        let out = sink();
        let mut reply = reply_for(&out);
        let now = t0();
        rx.tick(now, &mut reply);

        let mut block = vec![SOH, 1, !1u8];
        block.extend_from_slice(&[0xAB; SMALL]);
        block.extend_from_slice(&[0xDE, 0xAD]); // wrong CRC
        rx.on_chunk(&block, now, &mut reply);
        assert_eq!(wire(&out).last(), Some(&NAK));
        assert_eq!(rx.block, 0);

        rx.on_chunk(&block_for(&[0xAB; SMALL], 1), now, &mut reply);
        assert_eq!(wire(&out).last(), Some(&ACK));
        assert_eq!(rx.data, vec![0xAB; SMALL]);
    }

    #[test]
    fn receiver_reacks_a_duplicate_block_without_reappending() {
        let mut rx = XferSession::new(
            "devA",
            XferDirection::Recv,
            XferMode::Crc128,
            "fw.bin".into(),
            Vec::new(),
            t0(),
        );
        let out = sink();
        let mut reply = reply_for(&out);
        let now = t0();
        rx.tick(now, &mut reply);

        let block = block_for(&[0x42; SMALL], 1);
        rx.on_chunk(&block, now, &mut reply);
        assert_eq!(rx.data.len(), SMALL);

        let before = rx.data.clone();
        rx.on_chunk(&block, now, &mut reply); // duplicate (our ACK was lost)
        assert_eq!(wire(&out).last(), Some(&ACK));
        assert_eq!(rx.data, before, "duplicate must not be appended twice");
    }

    #[test]
    fn sender_completes_against_a_responder() {
        let file: Vec<u8> = (0..1200u32).map(|i| (i % 255) as u8).collect();
        let mut tx = XferSession::new(
            "devA",
            XferDirection::Send,
            XferMode::Crc128,
            "fw.bin".into(),
            file.clone(),
            t0(),
        );
        assert_eq!(tx.total_blocks(), (1200 + 127) / 128);

        let out = sink();
        let mut reply = reply_for(&out);
        let now = t0();

        tx.on_chunk(&[CRC_CH], now, &mut reply);
        assert_eq!(wire(&out)[0], SOH);
        assert_eq!(wire(&out)[1], 1);
        assert_eq!(wire(&out)[2], !1u8);

        let mut acks = 0;
        loop {
            acks += 1;
            tx.on_chunk(&[ACK], now, &mut reply);
            if tx.phase == XferPhase::Finishing {
                tx.on_chunk(&[ACK], now, &mut reply); // final EOT ACK
                break;
            }
            if tx.phase == XferPhase::Done {
                break;
            }
            if acks > 40 {
                panic!("transfer did not finish");
            }
        }
        assert_eq!(tx.phase, XferPhase::Done);
        assert_eq!(tx.bytes_done as usize, file.len());
        // Every block on the wire carries a valid CRC.
        let wire_bytes = wire(&out);
        let mut i = 0;
        while i < wire_bytes.len() && wire_bytes[i] != EOT {
            let size = if wire_bytes[i] == STX { LARGE } else { SMALL };
            let crc = u16::from_be_bytes([wire_bytes[i + 3 + size], wire_bytes[i + 4 + size]]);
            assert_eq!(crc_xmodem(&wire_bytes[i + 3..i + 3 + size]), crc);
            i += size + 5;
        }
    }

    #[test]
    fn sender_retransmits_on_nak() {
        let file = vec![0x11u8; SMALL];
        let mut tx = XferSession::new(
            "devA",
            XferDirection::Send,
            XferMode::Crc128,
            "fw.bin".into(),
            file,
            t0(),
        );
        let out = sink();
        let mut reply = reply_for(&out);
        let now = t0();

        tx.on_chunk(&[CRC_CH], now, &mut reply);
        let first_block = wire(&out);
        tx.on_chunk(&[NAK], now, &mut reply); // device NAKs block 1
        let resend = &wire(&out)[first_block.len()..];
        assert_eq!(resend, first_block, "retransmission must be identical");
        assert_eq!(tx.retries, 1);
    }
}
