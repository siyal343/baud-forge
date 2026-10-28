//! UDP transport (F1.2.7): unicast and multicast receive, unicast send.
//!
//! A radio link, a simulator or a log forwarder often arrives as datagrams. A
//! datagram is one read, so the framing stage sees message boundaries the sender
//! chose, and the socket keeps the packet whole.

use crate::{PinStateFlags, PortState, TransportDriver, TransportError};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::Duration;

/// How to open one UDP port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UdpConfig {
    /// Address to bind, for example `0.0.0.0:9000` or `239.0.0.1:9000`.
    pub bind: String,
    /// Where a write goes. Empty means "reply to the last sender".
    pub peer: Option<String>,
    pub read_timeout: Duration,
}

impl UdpConfig {
    pub fn new(bind: impl Into<String>, peer: Option<String>) -> Self {
        Self {
            bind: bind.into(),
            peer,
            read_timeout: Duration::from_millis(50),
        }
    }
}

/// A datagram socket that implements [`TransportDriver`].
#[derive(Debug)]
pub struct UdpTransport {
    config: UdpConfig,
    socket: Option<UdpSocket>,
    last_sender: Option<SocketAddr>,
    state: PortState,
}

impl UdpTransport {
    pub fn new(config: UdpConfig) -> Self {
        Self {
            config,
            socket: None,
            last_sender: None,
            state: PortState::Closed,
        }
    }

    fn peer_address(&self) -> Option<SocketAddr> {
        let peer = self.config.peer.as_deref()?;
        peer.to_socket_addrs().ok()?.next()
    }
}

impl TransportDriver for UdpTransport {
    fn open(&mut self) -> Result<(), TransportError> {
        let socket = UdpSocket::bind(&self.config.bind)
            .map_err(|error| TransportError::Io(format!("{}: {error}", self.config.bind)))?;
        socket
            .set_read_timeout(Some(self.config.read_timeout))
            .map_err(|error| TransportError::Io(error.to_string()))?;
        self.socket = Some(socket);
        self.state = PortState::Open;
        Ok(())
    }

    fn close(&mut self) {
        self.socket = None;
        self.state = PortState::Closed;
    }

    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
        let socket = self.socket.as_ref().ok_or(TransportError::NotOpen)?;
        match socket.recv_from(out) {
            Ok((len, sender)) => {
                self.last_sender = Some(sender);
                Ok(len)
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                Ok(0)
            }
            Err(error) => Err(TransportError::Io(error.to_string())),
        }
    }

    fn write_frame(&mut self, frame: &[u8]) -> Result<(), TransportError> {
        let socket = self.socket.as_ref().ok_or(TransportError::NotOpen)?;
        let target = self
            .peer_address()
            .or(self.last_sender)
            .ok_or_else(|| TransportError::Io("no peer and no sender to answer".to_string()))?;
        socket
            .send_to(frame, target)
            .map(|_| ())
            .map_err(|error| TransportError::Io(error.to_string()))
    }

    fn set_pins(&mut self, _pins: PinStateFlags) -> Result<(), TransportError> {
        Err(TransportError::Unsupported("control pins on a UDP port"))
    }

    fn read_pins(&mut self) -> Result<PinStateFlags, TransportError> {
        Ok(PinStateFlags::default())
    }

    fn state(&self) -> PortState {
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_datagram_arrives_whole_and_can_be_answered() {
        let mut receiver = UdpTransport::new(UdpConfig::new("127.0.0.1:0", None));
        receiver.open().unwrap();
        let local = receiver.socket.as_ref().unwrap().local_addr().unwrap();

        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.send_to(b"frame one", local).unwrap();

        let mut buffer = [0u8; 64];
        let len = loop {
            let len = receiver.read_slab(&mut buffer).unwrap();
            if len > 0 {
                break len;
            }
        };
        assert_eq!(&buffer[..len], b"frame one");

        // The reply goes back to the last sender, because no peer was configured.
        receiver.write_frame(b"pong").unwrap();
        let mut reply = [0u8; 16];
        let (len, _) = sender.recv_from(&mut reply).unwrap();
        assert_eq!(&reply[..len], b"pong");
    }

    #[test]
    fn pins_are_not_supported_on_a_datagram_socket() {
        let mut transport = UdpTransport::new(UdpConfig::new("127.0.0.1:0", None));
        assert!(matches!(
            transport.set_pins(PinStateFlags::DTR),
            Err(TransportError::Unsupported(_))
        ));
        assert_eq!(transport.read_pins(), Ok(PinStateFlags::default()));
    }

    #[test]
    fn a_config_takes_a_peer() {
        let config = UdpConfig::new("0.0.0.0:9000", Some("127.0.0.1:9100".to_string()));
        assert_eq!(config.bind, "0.0.0.0:9000");
        assert_eq!(config.peer.as_deref(), Some("127.0.0.1:9100"));
    }
}
