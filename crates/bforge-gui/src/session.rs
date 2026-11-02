//! Live Session Pump and Real-Time Hardware Streaming for BaudForge.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Line ending mode for ASCII commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    None,
    Lf,
    Cr,
    CrLf,
}

impl LineEnding {
    pub fn as_bytes(&self) -> &'static [u8] {
        match self {
            Self::None => b"",
            Self::Lf => b"\n",
            Self::Cr => b"\r",
            Self::CrLf => b"\r\n",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "",
            Self::Lf => "\n",
            Self::Cr => "\r",
            Self::CrLf => "\r\n",
        }
    }
}

/// Transmit command payload variants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxCommand {
    Ascii(String, LineEnding),
    Hex(Vec<u8>),
}

impl TxCommand {
    pub fn to_bytes(&self) -> Vec<u8> {
        match self {
            Self::Ascii(text, ending) => {
                let mut b = text.as_bytes().to_vec();
                b.extend_from_slice(ending.as_bytes());
                b
            }
            Self::Hex(bytes) => bytes.clone(),
        }
    }
}

/// Received event types emitted by background streaming pump.
#[derive(Debug, Clone)]
pub enum RxEvent {
    Line(String),
    Bytes(Vec<u8>),
    Stats {
        rx_bytes: u64,
        tx_bytes: u64,
        packets_per_sec: u32,
    },
    Connected {
        port: String,
        baud: u32,
    },
    Disconnected(String),
    Error(String),
}

/// Active session controller managing background I/O pumps.
pub struct SessionController {
    tx_sender: crossbeam_channel::Sender<TxCommand>,
    rx_receiver: crossbeam_channel::Receiver<RxEvent>,
    stop_flag: Arc<AtomicBool>,
    thread_handle: Option<JoinHandle<()>>,
}

impl SessionController {
    /// Start a hardware serial port pump session with UART framing and modem line controls.
    pub fn start_hardware(
        port: &str,
        baud: u32,
        framing: &str,
        data_bits: u8,
        parity: &str,
        stop_bits: u8,
        dtr: bool,
        rts: bool,
    ) -> Result<Self, String> {
        let data_bits_cfg = match data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        };
        let parity_cfg = match parity {
            "Even" => serialport::Parity::Even,
            "Odd" => serialport::Parity::Odd,
            _ => serialport::Parity::None,
        };
        let stop_bits_cfg = match stop_bits {
            2 => serialport::StopBits::Two,
            _ => serialport::StopBits::One,
        };

        let mut serial_port = serialport::new(port, baud)
            .data_bits(data_bits_cfg)
            .parity(parity_cfg)
            .stop_bits(stop_bits_cfg)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| format!("Failed to open port '{}' at {} baud: {}", port, baud, e))?;

        let _ = serial_port.write_data_terminal_ready(dtr);
        let _ = serial_port.write_request_to_send(rts);

        let (tx_sender, tx_receiver) = crossbeam_channel::unbounded::<TxCommand>();
        let (rx_sender, rx_receiver) = crossbeam_channel::unbounded::<RxEvent>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop_flag);

        let port_name = port.to_string();
        let framing_string = framing.to_string();

        let thread_handle = thread::Builder::new()
            .name(format!("bforge-hw-{}", port))
            .spawn(move || {
                let _ = rx_sender.send(RxEvent::Connected {
                    port: port_name.clone(),
                    baud,
                });

                let mut rx_bytes = 0u64;
                let mut tx_bytes = 0u64;
                let mut packets_in_window = 0u32;
                let mut last_stats_instant = Instant::now();
                let mut accum_buf = Vec::with_capacity(4096);
                let mut read_buf = [0u8; 1024];

                while !stop_clone.load(Ordering::Relaxed) {
                    // 1. Check for outgoing TX commands
                    while let Ok(cmd) = tx_receiver.try_recv() {
                        let bytes = cmd.to_bytes();
                        if let Err(e) = serial_port.write_all(&bytes) {
                            let _ = rx_sender.send(RxEvent::Error(format!("TX write error: {}", e)));
                        } else {
                            let _ = serial_port.flush();
                            tx_bytes += bytes.len() as u64;
                        }
                    }

                    // 2. Read incoming hardware bytes
                    match serial_port.read(&mut read_buf) {
                        Ok(n) if n > 0 => {
                            rx_bytes += n as u64;
                            accum_buf.extend_from_slice(&read_buf[..n]);
                            process_rx_buffer(&mut accum_buf, &framing_string, &rx_sender, &mut packets_in_window);
                        }
                        Ok(_) => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                            // Normal read timeout, continue loop
                        }
                        Err(e) => {
                            let _ = rx_sender.send(RxEvent::Error(format!("Serial read error: {}", e)));
                            break;
                        }
                    }

                    // 3. Emit periodic statistics
                    let stats_elapsed = last_stats_instant.elapsed();
                    if stats_elapsed >= Duration::from_millis(500) {
                        let pps = (packets_in_window as f32 / stats_elapsed.as_secs_f32()).round() as u32;
                        let _ = rx_sender.send(RxEvent::Stats {
                            rx_bytes,
                            tx_bytes,
                            packets_per_sec: pps,
                        });
                        packets_in_window = 0;
                        last_stats_instant = Instant::now();
                    }
                }

                let _ = rx_sender.send(RxEvent::Disconnected("Hardware session ended".to_string()));
            })
            .map_err(|e| format!("Failed to spawn serial pump thread: {}", e))?;

        Ok(Self {
            tx_sender,
            rx_receiver,
            stop_flag,
            thread_handle: Some(thread_handle),
        })
    }

    /// Start a simulated 9-DoF IMU loopback generator session.
    pub fn start_imu_demo() -> Result<Self, String> {
        let (tx_sender, tx_receiver) = crossbeam_channel::unbounded::<TxCommand>();
        let (rx_sender, rx_receiver) = crossbeam_channel::unbounded::<RxEvent>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop_flag);

        let thread_handle = thread::Builder::new()
            .name("bforge-imu-demo".to_string())
            .spawn(move || {
                let start_time = Instant::now();
                let mut last_stats_instant = Instant::now();
                let mut rx_bytes = 0u64;
                let mut tx_bytes = 0u64;
                let mut packets_in_window = 0u32;
                let mut seq_num: u16 = 0;

                let _ = rx_sender.send(RxEvent::Connected {
                    port: "DEMO-IMU (Simulated)".to_string(),
                    baud: 921600,
                });

                while !stop_clone.load(Ordering::Relaxed) {
                    let iter_start = Instant::now();

                    // 1. Process simulated incoming TX commands
                    while let Ok(cmd) = tx_receiver.try_recv() {
                        let cmd_bytes = cmd.to_bytes();
                        tx_bytes += cmd_bytes.len() as u64;

                        let text_rep = String::from_utf8_lossy(&cmd_bytes);
                        let trimmed = text_rep.trim();

                        let (resp_line, resp_bytes) = if trimmed.starts_with("AT+PING") {
                            ("OK:PONG".to_string(), b"OK:PONG\r\n".to_vec())
                        } else if trimmed.starts_with("AT+STATUS") {
                            (
                                "IMU_ONLINE: BNO085 9-DoF 50Hz CALIBRATED".to_string(),
                                b"IMU_ONLINE\r\n".to_vec(),
                            )
                        } else if trimmed.starts_with("AT+RESET") {
                            (
                                "[SYS] Soft-reset acknowledged. Sensor calibration intact.".to_string(),
                                b"OK:RESET\r\n".to_vec(),
                            )
                        } else if trimmed == "BAUD_PING" {
                            ("BAUD_PONG 0xCAFE".to_string(), b"BAUD_PONG\r\n".to_vec())
                        } else {
                            (
                                format!("ERR: UNKNOWN_COMMAND '{}'", trimmed),
                                format!("ERR: UNKNOWN\r\n").into_bytes(),
                            )
                        };

                        rx_bytes += resp_bytes.len() as u64;
                        let _ = rx_sender.send(RxEvent::Bytes(resp_bytes));
                        let _ = rx_sender.send(RxEvent::Line(resp_line));
                    }

                    // 2. Generate synthetic 9-DoF telemetry packet
                    let elapsed = start_time.elapsed();
                    let t = elapsed.as_secs_f32();
                    let now_millis = elapsed.as_millis();
                    let hours = (now_millis / 3_600_000) % 24;
                    let mins = (now_millis / 60_000) % 60;
                    let secs = (now_millis / 1_000) % 60;
                    let ms = now_millis % 1_000;

                    let ax = 0.05 * (t * 2.0).sin();
                    let ay = 0.03 * (t * 2.5).cos();
                    let az = 9.81 + 0.12 * (t * 1.2).sin();

                    let gx = 1.25 * (t * 0.8).sin();
                    let gy = 0.95 * (t * 1.1).cos();
                    let gz = 0.42 * (t * 1.7).sin();

                    let roll = 0.10 * (t * 0.5).sin();
                    let pitch = 0.15 * (t * 0.7).cos();
                    let yaw = 0.20 * t;

                    let cy = (yaw * 0.5).cos();
                    let sy = (yaw * 0.5).sin();
                    let cp = (pitch * 0.5).cos();
                    let sp = (pitch * 0.5).sin();
                    let cr = (roll * 0.5).cos();
                    let sr = (roll * 0.5).sin();

                    let qw = cr * cp * cy + sr * sp * sy;
                    let qx = sr * cp * cy - cr * sp * sy;
                    let qy = cr * sp * cy + sr * cp * sy;
                    let qz = cr * cp * sy - sr * sp * cy;

                    let temp = 36.5 + 0.6 * (t * 0.1).sin();
                    let status_flags: u16 = 0x0003;
                    seq_num = seq_num.wrapping_add(1);

                    let line = format!(
                        "[{:02}:{:02}:{:02}.{:03}] [IMU] ax={:+.2} ay={:+.2} az={:+.2} gx={:+.2} gy={:+.2} gz={:+.2} temp={:.1}C",
                        hours, mins, secs, ms, ax, ay, az, gx, gy, gz, temp
                    );

                    // Binary packet assembly
                    let mut packet = Vec::with_capacity(64);
                    packet.extend_from_slice(&[0xBA, 0xDE]);
                    packet.extend_from_slice(&(now_millis as u32).to_le_bytes());
                    packet.extend_from_slice(&seq_num.to_le_bytes());
                    packet.extend_from_slice(&status_flags.to_le_bytes());
                    packet.extend_from_slice(&ax.to_le_bytes());
                    packet.extend_from_slice(&ay.to_le_bytes());
                    packet.extend_from_slice(&az.to_le_bytes());
                    packet.extend_from_slice(&gx.to_le_bytes());
                    packet.extend_from_slice(&gy.to_le_bytes());
                    packet.extend_from_slice(&gz.to_le_bytes());
                    packet.extend_from_slice(&qw.to_le_bytes());
                    packet.extend_from_slice(&qx.to_le_bytes());
                    packet.extend_from_slice(&qy.to_le_bytes());
                    packet.extend_from_slice(&qz.to_le_bytes());
                    packet.extend_from_slice(&temp.to_le_bytes());

                    let crc = bforge_framer::checksum::crc32c(&packet);
                    packet.extend_from_slice(&crc.to_le_bytes());

                    rx_bytes += packet.len() as u64;
                    let _ = rx_sender.send(RxEvent::Bytes(packet));
                    let _ = rx_sender.send(RxEvent::Line(line));
                    packets_in_window += 1;

                    // 3. Emit periodic statistics
                    let stats_elapsed = last_stats_instant.elapsed();
                    if stats_elapsed >= Duration::from_millis(500) {
                        let pps = (packets_in_window as f32 / stats_elapsed.as_secs_f32()).round() as u32;
                        let _ = rx_sender.send(RxEvent::Stats {
                            rx_bytes,
                            tx_bytes,
                            packets_per_sec: pps,
                        });
                        packets_in_window = 0;
                        last_stats_instant = Instant::now();
                    }

                    // 4. Target 50Hz (20ms interval)
                    let loop_dur = iter_start.elapsed();
                    if loop_dur < Duration::from_millis(20) {
                        thread::sleep(Duration::from_millis(20) - loop_dur);
                    }
                }

                let _ = rx_sender.send(RxEvent::Disconnected("IMU demo stopped".to_string()));
            })
            .map_err(|e| format!("Failed to spawn IMU demo thread: {}", e))?;

        Ok(Self {
            tx_sender,
            rx_receiver,
            stop_flag,
            thread_handle: Some(thread_handle),
        })
    }

    /// Transmit a command to the session background thread.
    pub fn send_tx(&self, cmd: TxCommand) -> bool {
        self.tx_sender.send(cmd).is_ok()
    }

    /// Poll incoming events without blocking.
    pub fn poll_events(&self) -> Vec<RxEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.rx_receiver.try_recv() {
            events.push(event);
        }
        events
    }

    /// Stop the background session thread and wait for completion.
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for SessionController {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Helper to format a short hex preview string for binary packets.
fn format_hex_preview(data: &[u8]) -> String {
    let max_preview = 16.min(data.len());
    let mut parts = Vec::with_capacity(max_preview);
    for &b in &data[..max_preview] {
        parts.push(format!("{:02X}", b));
    }
    let mut s = parts.join(" ");
    if data.len() > max_preview {
        s.push_str(" ...");
    }
    s
}

/// Helper to process received bytes according to framing configuration.
fn process_rx_buffer(
    accum_buf: &mut Vec<u8>,
    framing: &str,
    rx_sender: &crossbeam_channel::Sender<RxEvent>,
    packet_count: &mut u32,
) {
    let framing_lower = framing.to_lowercase();

    if framing_lower.contains("cobs") {
        while let Some(pos) = accum_buf.iter().position(|&b| b == 0x00) {
            let frame: Vec<u8> = accum_buf.drain(..=pos).collect();
            let preview = format_hex_preview(&frame);
            let _ = rx_sender.send(RxEvent::Bytes(frame.clone()));
            let _ = rx_sender.send(RxEvent::Line(format!("[COBS] len={} [{}]", frame.len(), preview)));
            *packet_count += 1;
        }
    } else if framing_lower.contains("len") {
        while accum_buf.len() >= 2 {
            let payload_len = u16::from_be_bytes([accum_buf[0], accum_buf[1]]) as usize;
            let total_len = 2 + payload_len;
            if accum_buf.len() >= total_len {
                let frame: Vec<u8> = accum_buf.drain(..total_len).collect();
                let payload = &frame[2..];
                let preview = format_hex_preview(payload);
                let _ = rx_sender.send(RxEvent::Bytes(frame));
                let _ = rx_sender.send(RxEvent::Line(format!("[LEN-HDR] len={} [{}]", payload_len, preview)));
                *packet_count += 1;
            } else {
                break;
            }
        }
    } else if framing_lower.contains("chunk") || framing_lower.contains("raw") {
        while accum_buf.len() >= 64 {
            let frame: Vec<u8> = accum_buf.drain(..64).collect();
            let preview = format_hex_preview(&frame);
            let _ = rx_sender.send(RxEvent::Bytes(frame));
            let _ = rx_sender.send(RxEvent::Line(format!("[RAW-64] [{}]", preview)));
            *packet_count += 1;
        }
    } else {
        // Line-based ('\n')
        while let Some(pos) = accum_buf.iter().position(|&b| b == b'\n') {
            let mut line_bytes: Vec<u8> = accum_buf.drain(..=pos).collect();
            while line_bytes.last() == Some(&b'\n') || line_bytes.last() == Some(&b'\r') {
                line_bytes.pop();
            }
            let line_str = String::from_utf8_lossy(&line_bytes).into_owned();
            let _ = rx_sender.send(RxEvent::Bytes(line_bytes));
            let _ = rx_sender.send(RxEvent::Line(line_str));
            *packet_count += 1;
        }
    }

    if accum_buf.len() > 65536 {
        accum_buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_line_ending_bytes() {
        assert_eq!(LineEnding::None.as_bytes(), b"");
        assert_eq!(LineEnding::Lf.as_bytes(), b"\n");
        assert_eq!(LineEnding::Cr.as_bytes(), b"\r");
        assert_eq!(LineEnding::CrLf.as_bytes(), b"\r\n");
    }

    #[test]
    fn test_tx_command_serialization() {
        let ascii_cmd = TxCommand::Ascii("AT+PING".to_string(), LineEnding::CrLf);
        assert_eq!(ascii_cmd.to_bytes(), b"AT+PING\r\n");

        let hex_cmd = TxCommand::Hex(vec![0xBA, 0xDE, 0x01]);
        assert_eq!(hex_cmd.to_bytes(), vec![0xBA, 0xDE, 0x01]);
    }

    #[test]
    fn test_imu_demo_session_lifecycle() {
        let mut session = SessionController::start_imu_demo().expect("Failed to start IMU demo");
        thread::sleep(Duration::from_millis(60));

        let events = session.poll_events();
        assert!(!events.is_empty(), "Should receive initial events from IMU demo");

        let mut got_connected = false;
        let mut got_line = false;
        let mut got_bytes = false;

        for event in events {
            match event {
                RxEvent::Connected { port, baud } => {
                    assert_eq!(port, "DEMO-IMU (Simulated)");
                    assert_eq!(baud, 921600);
                    got_connected = true;
                }
                RxEvent::Line(line) => {
                    if line.contains("[IMU]") {
                        got_line = true;
                    }
                }
                RxEvent::Bytes(bytes) => {
                    if bytes.len() >= 50 && bytes[0] == 0xBA && bytes[1] == 0xDE {
                        got_bytes = true;
                    }
                }
                _ => {}
            }
        }

        assert!(got_connected, "Expected RxEvent::Connected");
        assert!(got_line, "Expected RxEvent::Line containing [IMU]");
        assert!(got_bytes, "Expected RxEvent::Bytes with sync word 0xBADE");

        // Test TX ping
        assert!(session.send_tx(TxCommand::Ascii("AT+PING".to_string(), LineEnding::CrLf)));
        thread::sleep(Duration::from_millis(30));

        let events_after_ping = session.poll_events();
        let ping_answered = events_after_ping.iter().any(|e| {
            if let RxEvent::Line(line) = e {
                line.contains("OK:PONG")
            } else {
                false
            }
        });
        assert!(ping_answered, "Expected OK:PONG response to AT+PING");

        // Stop session cleanly
        session.stop();
    }

    #[test]
    fn test_process_rx_buffer_line() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut accum = b"hello\r\nworld\npartial".to_vec();
        let mut pkt_count = 0;

        process_rx_buffer(&mut accum, "Line-Delimited (\\n)", &tx, &mut pkt_count);
        assert_eq!(pkt_count, 2);
        assert_eq!(accum, b"partial");

        let events: Vec<_> = rx.try_iter().collect();
        // Each line emits 1 Bytes event and 1 Line event
        assert_eq!(events.len(), 4);
    }

    #[test]
    fn test_process_rx_buffer_cobs() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut accum = vec![0x01, 0x02, 0x00, 0x03, 0x00, 0x04];
        let mut pkt_count = 0;

        process_rx_buffer(&mut accum, "COBS", &tx, &mut pkt_count);
        assert_eq!(pkt_count, 2);
        assert_eq!(accum, vec![0x04]);

        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(events.len(), 4);
    }

    #[test]
    fn test_process_rx_buffer_len_prefix() {
        let (tx, rx) = crossbeam_channel::unbounded();
        // 2-byte BE length = 3, followed by 3 bytes [0xAA, 0xBB, 0xCC]
        let mut accum = vec![0x00, 0x03, 0xAA, 0xBB, 0xCC, 0x00];
        let mut pkt_count = 0;

        process_rx_buffer(&mut accum, "Length-Prefixed", &tx, &mut pkt_count);
        assert_eq!(pkt_count, 1);
        assert_eq!(accum, vec![0x00]);

        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn test_start_hardware_invalid_port() {
        let res = SessionController::start_hardware(
            "INVALID_PORT_XYZ",
            115200,
            "Line",
            8,
            "None",
            1,
            true,
            false,
        );
        assert!(res.is_err(), "Opening non-existent port must return an Err");
    }
}
