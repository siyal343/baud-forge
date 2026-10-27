//! UART transport (F1.2.2), built on the `serialport` crate.
//!
//! Gate G1 decided this base: the crate covers baud rate, 5 to 8 data bits, all
//! five parity modes, both stop-bit values that matter, DTR and RTS output, and
//! the four modem inputs. Two FR-HAL-01 items stay out until F1.2.1 needs them:
//! 1.5 stop bits, and non-standard baud divisors on platforms that round them.

use crate::{
    DeviceId, LineConfig, Parity, PinStateFlags, PortState, StopBits, TransportDriver,
    TransportError,
};
use serialport::{DataBits, FlowControl, SerialPort};
use std::time::Duration;

/// How to open one UART.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UartConfig {
    /// OS device path, for example `COM8` or `/dev/ttyACM0`.
    pub device: String,
    pub line: LineConfig,
    /// How long a read waits before it returns 0 bytes.
    pub read_timeout: Duration,
}

impl UartConfig {
    pub fn new(device: impl Into<String>, line: LineConfig) -> Self {
        Self {
            device: device.into(),
            line,
            read_timeout: Duration::from_millis(50),
        }
    }
}

/// A serial port that implements [`TransportDriver`].
#[derive(Debug)]
pub struct UartTransport {
    config: UartConfig,
    port: Option<Box<dyn SerialPort>>,
    state: PortState,
}

impl UartTransport {
    pub fn new(config: UartConfig) -> Self {
        Self {
            config,
            port: None,
            state: PortState::Closed,
        }
    }

    pub fn device(&self) -> &str {
        &self.config.device
    }

    /// Assert RTS, hold it, then release both outputs. On boards that wire RTS
    /// to EN this restarts the target, and the ROM boot log appears at the
    /// configured baud rate.
    pub fn pulse_rts(&mut self, hold: Duration) -> Result<(), TransportError> {
        self.set_pins(PinStateFlags::RTS)?;
        std::thread::sleep(hold);
        self.set_pins(PinStateFlags(0))?;
        Ok(())
    }
}

impl TransportDriver for UartTransport {
    fn open(&mut self) -> Result<(), TransportError> {
        let line = self.config.line;
        if line.data_bits == 5 && line.stop_bits == StopBits::Two {
            // The crate accepts it; the platform may not. Reported, not guessed.
            return Err(TransportError::Unsupported("5 data bits with 2 stop bits"));
        }
        let stop_bits = match line.stop_bits {
            StopBits::One => serialport::StopBits::One,
            StopBits::Two => serialport::StopBits::Two,
            StopBits::OneAndHalf => {
                return Err(TransportError::Unsupported("1.5 stop bits (F1.2.1)"));
            }
        };
        let data_bits = match line.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            other => {
                return Err(TransportError::Io(format!(
                    "data bits {other} is not 5 to 8"
                )));
            }
        };
        let parity = match line.parity {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
            // The crate offers five parity modes only on some platforms; it
            // exposes none for mark and space, so they stay unimplemented.
            Parity::Mark => return Err(TransportError::Unsupported("mark parity (F1.2.1)")),
            Parity::Space => return Err(TransportError::Unsupported("space parity (F1.2.1)")),
        };

        let port = serialport::new(&self.config.device, line.baud_rate)
            .data_bits(data_bits)
            .parity(parity)
            .stop_bits(stop_bits)
            .flow_control(FlowControl::None)
            .timeout(self.config.read_timeout)
            .open()
            .map_err(|error| TransportError::Io(format!("{}: {error}", self.config.device)))?;

        self.port = Some(port);
        self.state = PortState::Open;
        Ok(())
    }

    fn close(&mut self) {
        self.port = None;
        self.state = PortState::Closed;
    }

    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::NotOpen)?;
        match port.read(out) {
            Ok(len) => Ok(len),
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => Ok(0),
            Err(error) => Err(TransportError::Io(error.to_string())),
        }
    }

    fn write_frame(&mut self, frame: &[u8]) -> Result<(), TransportError> {
        use std::io::Write;
        let port = self.port.as_mut().ok_or(TransportError::NotOpen)?;
        port.write_all(frame)
            .and_then(|()| port.flush())
            .map_err(|error| TransportError::Io(error.to_string()))
    }

    fn set_pins(&mut self, pins: PinStateFlags) -> Result<(), TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::NotOpen)?;
        port.write_data_terminal_ready(pins.contains(PinStateFlags::DTR))
            .and_then(|()| port.write_request_to_send(pins.contains(PinStateFlags::RTS)))
            .map_err(|error| TransportError::Io(error.to_string()))
    }

    fn read_pins(&mut self) -> Result<PinStateFlags, TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::NotOpen)?;
        let io = |error: serialport::Error| TransportError::Io(error.to_string());
        let mut pins = PinStateFlags::default();
        if port.read_clear_to_send().map_err(io)? {
            pins.insert(PinStateFlags::CTS);
        }
        if port.read_data_set_ready().map_err(io)? {
            pins.insert(PinStateFlags::DSR);
        }
        if port.read_carrier_detect().map_err(io)? {
            pins.insert(PinStateFlags::DCD);
        }
        if port.read_ring_indicator().map_err(io)? {
            pins.insert(PinStateFlags::RI);
        }
        Ok(pins)
    }

    fn state(&self) -> PortState {
        self.state
    }
}

/// Every serial port the operating system reports, with its USB identity when
/// the platform exposes one (FR-HAL-02).
pub fn available() -> Result<Vec<DeviceId>, TransportError> {
    let ports = serialport::available_ports()
        .map_err(|error| TransportError::Io(format!("cannot enumerate ports: {error}")))?;
    Ok(ports
        .into_iter()
        .map(|port| {
            let (vid_pid, serial) = match &port.port_type {
                serialport::SerialPortType::UsbPort(usb) => (
                    Some(format!("{:04x}:{:04x}", usb.vid, usb.pid)),
                    usb.serial_number.clone(),
                ),
                _ => (None, None),
            };
            DeviceId {
                vid_pid,
                serial,
                interface_index: None,
                port_path: None,
                device_path: port.port_name,
            }
        })
        .collect())
}
