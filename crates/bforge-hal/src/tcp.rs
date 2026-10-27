//! TCP transport (F1.2.7): client and one-connection server.
//!
//! A TCP port has no control lines, so `set_pins` reports that it is not
//! supported and `read_pins` returns an empty bitmask.

use crate::{PinStateFlags, PortState, TransportDriver, TransportError};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

/// Which end of the connection this transport is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TcpEndpoint {
    /// Connect to a remote address on open.
    Client(String),
    /// Listen, then accept one connection on open.
    Server(String),
}

/// How to open one TCP port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcpConfig {
    pub endpoint: TcpEndpoint,
    pub read_timeout: Duration,
}

impl TcpConfig {
    pub fn client(address: impl Into<String>) -> Self {
        Self {
            endpoint: TcpEndpoint::Client(address.into()),
            read_timeout: Duration::from_millis(50),
        }
    }

    pub fn server(bind: impl Into<String>) -> Self {
        Self {
            endpoint: TcpEndpoint::Server(bind.into()),
            read_timeout: Duration::from_millis(50),
        }
    }
}

/// A socket that implements [`TransportDriver`].
#[derive(Debug)]
pub struct TcpTransport {
    config: TcpConfig,
    stream: Option<TcpStream>,
    local_addr: Option<SocketAddr>,
    state: PortState,
}

impl TcpTransport {
    pub fn new(config: TcpConfig) -> Self {
        Self {
            config,
            stream: None,
            local_addr: None,
            state: PortState::Closed,
        }
    }

    /// The local address, once open. A server finds its port here after binding
    /// to port 0.
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.local_addr
    }

    pub fn remote_addr(&self) -> Option<SocketAddr> {
        self.stream.as_ref().and_then(|s| s.peer_addr().ok())
    }
}

impl TransportDriver for TcpTransport {
    fn open(&mut self) -> Result<(), TransportError> {
        let io = |error: std::io::Error| TransportError::Io(error.to_string());
        let stream = match &self.config.endpoint {
            TcpEndpoint::Client(address) => {
                let stream = TcpStream::connect(address).map_err(io)?;
                stream.set_nodelay(true).map_err(io)?;
                stream
            }
            TcpEndpoint::Server(bind) => {
                let listener = TcpListener::bind(bind).map_err(io)?;
                let local = listener.local_addr().map_err(io)?;
                let (stream, _peer) = listener.accept().map_err(io)?;
                self.local_addr = Some(local);
                stream.set_nodelay(true).map_err(io)?;
                stream
            }
        };
        if self.local_addr.is_none() {
            self.local_addr = stream.local_addr().ok();
        }
        stream
            .set_read_timeout(Some(self.config.read_timeout))
            .map_err(io)?;
        self.stream = Some(stream);
        self.state = PortState::Open;
        Ok(())
    }

    fn close(&mut self) {
        self.stream = None;
        self.state = PortState::Closed;
    }

    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
        let stream = self.stream.as_mut().ok_or(TransportError::NotOpen)?;
        match stream.read(out) {
            Ok(0) => Err(TransportError::Disconnected),
            Ok(len) => Ok(len),
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
        let stream = self.stream.as_mut().ok_or(TransportError::NotOpen)?;
        stream
            .write_all(frame)
            .and_then(|()| stream.flush())
            .map_err(|error| TransportError::Io(error.to_string()))
    }

    fn set_pins(&mut self, _pins: PinStateFlags) -> Result<(), TransportError> {
        Err(TransportError::Unsupported("control pins on a TCP port"))
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
    fn client_round_trips_against_a_plain_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let peer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 16];
            let len = stream.read(&mut buffer).unwrap();
            stream.write_all(&buffer[..len]).unwrap();
        });

        let mut client = TcpTransport::new(TcpConfig::client(address));
        client.open().unwrap();
        assert_eq!(client.state(), PortState::Open);
        assert!(client.remote_addr().is_some());
        assert!(client.local_addr().is_some());

        client.write_frame(b"ping").unwrap();
        let mut buffer = [0u8; 16];
        let len = loop {
            let len = client.read_slab(&mut buffer).unwrap();
            if len > 0 {
                break len;
            }
        };
        assert_eq!(&buffer[..len], b"ping");
        client.close();
        assert_eq!(client.state(), PortState::Closed);
        peer.join().unwrap();
    }

    #[test]
    fn a_closed_peer_is_reported_as_disconnected() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let peer = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            drop(stream);
        });

        let mut client = TcpTransport::new(TcpConfig::client(address));
        client.open().unwrap();
        peer.join().unwrap();
        std::thread::sleep(Duration::from_millis(20));

        let mut buffer = [0u8; 8];
        assert_eq!(
            client.read_slab(&mut buffer),
            Err(TransportError::Disconnected)
        );
    }

    #[test]
    fn pins_are_not_supported_on_a_socket() {
        let mut transport = TcpTransport::new(TcpConfig::client("127.0.0.1:1"));
        assert_eq!(
            transport.set_pins(PinStateFlags::DTR),
            Err(TransportError::Unsupported("control pins on a TCP port"))
        );
        assert_eq!(transport.read_pins(), Ok(PinStateFlags::default()));
        assert_eq!(transport.state(), PortState::Closed);
    }
}
