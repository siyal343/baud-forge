//! TCP transport (F1.2.7): client and a re-accepting server.
//!
//! A server port binds once and then accepts clients in the read path, so a
//! device may drop and reconnect like it would on a serial link — and a
//! shutdown never waits on a thread parked inside `accept()`. One client is
//! served at a time; the next one in the backlog is accepted when the current
//! one leaves.
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
    /// Bind and listen; clients are accepted in the read path, one at a time,
    /// and may come and go for as long as the session lives.
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
    /// Server only: the bound listener, kept across disconnects so a device
    /// can reconnect without a rebind, and so shutdown never waits on a
    /// thread parked inside a blocking `accept()`.
    listener: Option<TcpListener>,
    local_addr: Option<SocketAddr>,
    state: PortState,
}

impl TcpTransport {
    pub fn new(config: TcpConfig) -> Self {
        Self {
            config,
            stream: None,
            listener: None,
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

    fn is_server(&self) -> bool {
        matches!(self.config.endpoint, TcpEndpoint::Server(_))
    }

    /// The configured peer or bind address, as text.
    fn address(&self) -> String {
        match &self.config.endpoint {
            TcpEndpoint::Client(address) | TcpEndpoint::Server(address) => address.clone(),
        }
    }
}

impl TransportDriver for TcpTransport {
    fn open(&mut self) -> Result<(), TransportError> {
        let io = |error: std::io::Error| TransportError::Io(error.to_string());
        match &self.config.endpoint {
            TcpEndpoint::Client(address) => {
                let stream = TcpStream::connect(address).map_err(io)?;
                stream.set_nodelay(true).map_err(io)?;
                stream
                    .set_read_timeout(Some(self.config.read_timeout))
                    .map_err(io)?;
                if self.local_addr.is_none() {
                    self.local_addr = stream.local_addr().ok();
                }
                self.stream = Some(stream);
            }
            TcpEndpoint::Server(_) => {
                // Bind once. A reconnect keeps the listener, so the address is
                // never re-bound and the read path picks clients up.
                if self.listener.is_none() {
                    let listener = TcpListener::bind(&self.address()).map_err(io)?;
                    listener.set_nonblocking(true).map_err(io)?;
                    self.local_addr = Some(listener.local_addr().map_err(io)?);
                    self.listener = Some(listener);
                }
                self.stream = None;
            }
        }
        self.state = PortState::Open;
        Ok(())
    }

    fn close(&mut self) {
        self.stream = None;
        // A server's listener survives a lost client — that is the point. A
        // deliberate close of the whole transport drops it too.
        if !self.is_server() {
            self.listener = None;
        }
        self.state = PortState::Closed;
    }

    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
        if self.stream.is_none() {
            if let Some(listener) = self.listener.as_ref() {
                // No client yet (or the last one left): poll the backlog once
                // per call. WouldBlock is an idle tick, not an error.
                match listener.accept() {
                    Ok((stream, _peer)) => {
                        let _ = stream.set_nodelay(true);
                        let _ = stream.set_read_timeout(Some(self.config.read_timeout));
                        self.stream = Some(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        return Ok(0);
                    }
                    Err(error) => return Err(TransportError::Io(error.to_string())),
                }
            } else {
                return Err(TransportError::NotOpen);
            }
        }
        let stream = self.stream.as_mut().expect("stream was just accepted");
        match stream.read(out) {
            // A client that closed cleanly leaves; the listener takes the next one.
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

    /// A server port opens without any client and reports idle reads until one
    /// shows up — open() must never park the caller in `accept()`.
    #[test]
    fn a_server_opens_without_a_client_and_accepts_one_late() {
        let mut server = TcpTransport::new(TcpConfig::server("127.0.0.1:0"));
        server.open().unwrap();
        assert_eq!(server.state(), PortState::Open);
        assert!(server.remote_addr().is_none(), "no client yet");

        let mut buffer = [0u8; 16];
        assert_eq!(server.read_slab(&mut buffer), Ok(0), "idle tick");

        let address = server.local_addr().unwrap().to_string();
        let mut client = TcpTransport::new(TcpConfig::client(address));
        client.open().unwrap();
        client.write_frame(b"late").unwrap();

        // The accepted client is picked up by the next read; allow a few idle
        // ticks for the connection to land in the backlog.
        let mut seen = None;
        for _ in 0..50 {
            match server.read_slab(&mut buffer) {
                Ok(0) => continue,
                Ok(len) => {
                    seen = Some(buffer[..len].to_vec());
                    break;
                }
                Err(error) => panic!("read failed: {error}"),
            }
        }
        assert_eq!(seen, Some(b"late".to_vec()));
    }

    /// A server accepts the NEXT client after the current one drops — the
    /// one-connection-per-session limitation is gone, and re-accept does not
    /// re-bind the address.
    #[test]
    fn a_server_reaccepts_after_the_client_drops() {
        let mut server = TcpTransport::new(TcpConfig::server("127.0.0.1:0"));
        server.open().unwrap();
        let address = server.local_addr().unwrap().to_string();
        let bind_address = address.clone();

        // First device: talk, then vanish.
        let first = std::thread::spawn(move || {
            let mut client = TcpTransport::new(TcpConfig::client(bind_address));
            client.open().unwrap();
            client.write_frame(b"one").unwrap();
        });
        let mut buffer = [0u8; 16];
        for _ in 0..200 {
            match server.read_slab(&mut buffer) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Ok(_) => break,
                Err(error) => panic!("read failed: {error}"),
            }
        }
        assert_eq!(&buffer[..3], b"one");
        first.join().unwrap();

        // The drop is noticed, the reader would close() + open() again.
        loop {
            match server.read_slab(&mut buffer) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Err(TransportError::Disconnected) => break,
                other => panic!("expected Disconnected, got {other:?}"),
            }
        }
        server.close();
        server.open().unwrap();

        // Second device: accepted without a rebind.
        let second = std::thread::spawn(move || {
            let mut client = TcpTransport::new(TcpConfig::client(address));
            client.open().unwrap();
            client.write_frame(b"two").unwrap();
        });
        let mut seen = None;
        for _ in 0..100 {
            match server.read_slab(&mut buffer) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Ok(len) => {
                    seen = Some(buffer[..len].to_vec());
                    break;
                }
                Err(TransportError::Disconnected) => break, // raced the drop
                Err(error) => panic!("read failed: {error}"),
            }
        }
        assert_eq!(seen, Some(b"two".to_vec()));
        second.join().unwrap();
    }
}
