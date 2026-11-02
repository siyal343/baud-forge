//! Hardware detection, enumeration, and baud/framing sniffer for BaudForge.

use std::io::Read;
use std::time::Duration;

/// Metadata describing an enumerated serial port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerialPortInfo {
    /// Port name identifier, e.g. "COM3" or "/dev/ttyUSB0".
    pub port_name: String,
    /// Formatted display name for UI dropdowns.
    pub display_name: String,
    /// Manufacturer string if USB device, e.g. "STMicroelectronics".
    pub manufacturer: Option<String>,
    /// Product description string, e.g. "STM32 Virtual COM Port".
    pub product: Option<String>,
    /// USB Vendor and Product ID string formatted as "VID:PID" (e.g. "0483:5740").
    pub vid_pid: Option<String>,
}

/// Detect framing format from raw byte buffer.
pub fn classify_payload_framing(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "Raw Stream".to_string();
    }

    let has_newline = bytes.contains(&b'\n');
    let ascii_count = bytes
        .iter()
        .filter(|&&b| b.is_ascii_graphic() || b == b' ' || b == b'\t' || b == b'\r' || b == b'\n')
        .count();
    let is_predominantly_ascii = ascii_count * 10 >= bytes.len() * 8; // >= 80%

    if has_newline && is_predominantly_ascii {
        "Line-Delimited (\\n)".to_string()
    } else if bytes.contains(&0x00) {
        "COBS".to_string()
    } else {
        "Raw Stream".to_string()
    }
}

/// Identifies known USB VID/PIDs and maps them to clean product descriptions.
pub fn identify_usb_device(vid: u16, pid: u16) -> Option<&'static str> {
    match vid {
        0x303A => match pid {
            0x1001 => Some("Espressif ESP32-C3 USB JTAG/Serial"),
            0x1002 => Some("Espressif ESP32-S3 USB JTAG/Serial"),
            _ => Some("Espressif Device"),
        },
        0x0483 => Some("STMicroelectronics STM32"),
        0x10C4 => Some("Silicon Labs CP210x"),
        0x0403 => Some("FTDI USB Serial"),
        0x1A86 => Some("WCH CH340/CH341"),
        0x2E8A => Some("Raspberry Pi RP2040/RP2350"),
        0x2341 => Some("Arduino"),
        _ => None,
    }
}

/// Scans the system for serial ports and returns metadata.
///
/// If no physical hardware ports are detected, provides friendly placeholder
/// entries indicating the built-in virtual loopback simulator.
pub fn scan_available_ports() -> Vec<SerialPortInfo> {
    let mut results = Vec::new();

    if let Ok(ports) = serialport::available_ports() {
        for port in ports {
            let (manufacturer, product, vid_pid) = match &port.port_type {
                serialport::SerialPortType::UsbPort(usb) => {
                    let vp = format!("{:04X}:{:04X}", usb.vid, usb.pid);
                    let recognized = identify_usb_device(usb.vid, usb.pid);
                    let prod = recognized
                        .map(|s| s.to_string())
                        .or_else(|| usb.product.clone());
                    (usb.manufacturer.clone(), prod, Some(vp))
                }
                _ => (None, None, None),
            };

            let mut details = Vec::new();
            if let Some(ref prod) = product {
                details.push(prod.clone());
            } else if let Some(ref mfg) = manufacturer {
                details.push(mfg.clone());
            }

            if let Some(ref vp) = vid_pid {
                details.push(format!("({vp})"));
            }

            let display_name = if details.is_empty() {
                port.port_name.clone()
            } else {
                format!("{} - {}", port.port_name, details.join(" "))
            };

            results.push(SerialPortInfo {
                port_name: port.port_name,
                display_name,
                manufacturer,
                product,
                vid_pid,
            });
        }
    }

    if results.is_empty() {
        results.push(SerialPortInfo {
            port_name: "COM-LOOPBACK".to_string(),
            display_name: "COM-LOOPBACK - Virtual HIL Simulator (Built-in)".to_string(),
            manufacturer: Some("BaudForge".to_string()),
            product: Some("HIL Loopback Simulator".to_string()),
            vid_pid: Some("BAUD:F086".to_string()),
        });
    }

    results
}

/// Sniff baud rate and framing format by probing candidate configurations.
///
/// Probes candidate baud rates `[115200, 9600, 921600, 460800, 230400, 57600]`
/// with a 100ms read timeout. Analyzes up to 256 bytes:
/// - Printable ASCII with `\n` or `\r\n` -> "Line-Delimited (\n)"
/// - Contains `0x00` delimiters -> "COBS"
/// - Valid bytes but raw binary -> "Raw Stream"
pub fn sniff_port_baud_and_framing(port_name: &str) -> Option<(u32, String)> {
    if port_name.contains("LOOPBACK") || port_name.contains("Virtual") {
        return Some((921600, "COBS".to_string()));
    }

    let candidate_bauds = [115200, 9600, 921600, 460800, 230400, 57600];

    for &baud in &candidate_bauds {
        let builder = serialport::new(port_name, baud).timeout(Duration::from_millis(100));
        if let Ok(mut port) = builder.open() {
            let mut buf = [0u8; 256];
            if let Ok(n) = port.read(&mut buf) {
                if n > 0 {
                    let framing = classify_payload_framing(&buf[..n]);
                    return Some((baud, framing));
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_payload_framing() {
        assert_eq!(classify_payload_framing(b"AT+STATUS\r\n"), "Line-Delimited (\\n)");
        assert_eq!(classify_payload_framing(b"sensor_val: 42\n"), "Line-Delimited (\\n)");
        assert_eq!(classify_payload_framing(&[0x05, 0x10, 0x20, 0x00]), "COBS");
        assert_eq!(classify_payload_framing(&[0xFF, 0xFE, 0xFD, 0xFC]), "Raw Stream");
    }

    #[test]
    fn test_scan_available_ports_not_empty() {
        let ports = scan_available_ports();
        assert!(!ports.is_empty(), "Should always return at least the fallback simulator port");
    }

    #[test]
    fn test_sniff_virtual_loopback() {
        let sniff = sniff_port_baud_and_framing("COM-LOOPBACK");
        assert_eq!(sniff, Some((921600, "COBS".to_string())));
    }

    #[test]
    fn test_identify_known_usb_devices() {
        assert_eq!(identify_usb_device(0x303A, 0x1001), Some("Espressif ESP32-C3 USB JTAG/Serial"));
        assert_eq!(identify_usb_device(0x303A, 0x1002), Some("Espressif ESP32-S3 USB JTAG/Serial"));
        assert_eq!(identify_usb_device(0x303A, 0x9999), Some("Espressif Device"));
        assert_eq!(identify_usb_device(0x0483, 0x5740), Some("STMicroelectronics STM32"));
        assert_eq!(identify_usb_device(0x10C4, 0xEA60), Some("Silicon Labs CP210x"));
        assert_eq!(identify_usb_device(0x0403, 0x6001), Some("FTDI USB Serial"));
        assert_eq!(identify_usb_device(0x1A86, 0x7523), Some("WCH CH340/CH341"));
        assert_eq!(identify_usb_device(0x2E8A, 0x000A), Some("Raspberry Pi RP2040/RP2350"));
        assert_eq!(identify_usb_device(0x2341, 0x0043), Some("Arduino"));
        assert_eq!(identify_usb_device(0xFFFF, 0x0000), None);
    }
}
