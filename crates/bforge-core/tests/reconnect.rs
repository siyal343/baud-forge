//! A port that leaves the bus is reopened by the reader (F1.2.5).

use bforge_core::pipeline::{Pipeline, PipelineConfig};
use bforge_hal::{PinStateFlags, PortState, TransportDriver, TransportError};
// The fake counts every `open`, including the first one the reader makes.
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// A transport that works, then disappears for a while, then works again.
struct Flaky {
    remaining_before: Arc<AtomicUsize>,
    reopen_after: usize,
    opens: Arc<AtomicUsize>,
    data: usize,
}

impl TransportDriver for Flaky {
    fn open(&mut self) -> Result<(), TransportError> {
        self.opens.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn close(&mut self) {}

    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
        if self.remaining_before.load(Ordering::Relaxed) == 0 {
            if self.opens.load(Ordering::Relaxed) < self.reopen_after {
                return Err(TransportError::Disconnected);
            }
            // The device came back: hand out the rest of the data.
            self.remaining_before.store(4, Ordering::Relaxed);
        }
        let left = self.remaining_before.load(Ordering::Relaxed);
        if left == 0 {
            return Ok(0);
        }
        let len = out.len().min(64);
        out[..len].fill(self.data as u8);
        self.data += 1;
        self.remaining_before.store(left - 1, Ordering::Relaxed);
        Ok(len)
    }

    fn write_frame(&mut self, _frame: &[u8]) -> Result<(), TransportError> {
        Ok(())
    }

    fn set_pins(&mut self, _pins: PinStateFlags) -> Result<(), TransportError> {
        Ok(())
    }

    fn read_pins(&mut self) -> Result<PinStateFlags, TransportError> {
        Ok(PinStateFlags::default())
    }

    fn state(&self) -> PortState {
        PortState::Open
    }
}

fn run(reads_before: usize, reopen_after: usize, attempts: u32) -> (Pipeline, Arc<AtomicUsize>) {
    let opens = Arc::new(AtomicUsize::new(0));
    let transport = Flaky {
        remaining_before: Arc::new(AtomicUsize::new(reads_before)),
        reopen_after,
        opens: Arc::clone(&opens),
        data: 1,
    };
    let pipeline = Pipeline::start(
        PipelineConfig {
            port_id: 1,
            consumers: 1,
            reconnect_attempts: attempts,
            ..Default::default()
        },
        Box::new(transport),
    );
    (pipeline, opens)
}

#[test]
fn the_reader_reopens_a_port_that_came_back() {
    // Two reads, then the device is away until its second open attempt.
    let (mut pipeline, opens) = run(2, 2, 100);
    let mut logger = pipeline.take_consumers().remove(0);

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut chunks = 0usize;
    while chunks < 6 && Instant::now() < deadline {
        if logger.pop().is_ok() {
            chunks += 1;
        } else {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    let stats = pipeline.stats();
    pipeline.stop();
    assert!(chunks >= 6, "chunks after the reconnect: {chunks}");
    assert_eq!(stats.reconnects, 1, "{stats:?}");
    assert_eq!(stats.state, PortState::Open, "the port is usable again");
    assert!(
        stats.last_reconnect_ms < 1_000,
        "the port was away for {} ms",
        stats.last_reconnect_ms
    );
    let attempts = opens.load(Ordering::Relaxed);
    assert!(attempts >= 2, "open attempts: {attempts}");
}

#[test]
fn the_state_says_reconnecting_while_the_port_is_away() {
    // One read, then the device stays away for longer than the budget.
    // 200 attempts at 5 ms gives the polling test a second to observe the state.
    let (mut pipeline, _opens) = run(1, usize::MAX / 2, 200);
    let _logger = pipeline.take_consumers().remove(0);

    // The state starts Closed before the first open, so a Closed reading only
    // counts as "gave up" after the port has been open at least once.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen_open = false;
    let mut seen_reconnecting = false;
    let mut gave_up = false;
    while Instant::now() < deadline {
        let state = pipeline.stats().state;
        match state {
            PortState::Open => seen_open = true,
            PortState::Reconnecting => {
                seen_open = true;
                seen_reconnecting = true;
            }
            PortState::Closed if seen_open => {
                gave_up = true;
                break;
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    pipeline.stop();
    assert!(seen_reconnecting, "the state never reported a reconnect");
    assert!(gave_up, "the reader never gave up");
}

#[test]
fn a_healthy_port_never_reports_a_reconnect() {
    let (mut pipeline, _opens) = run(100, 0, 10);
    let mut logger = pipeline.take_consumers().remove(0);
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if logger.pop().is_err() {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    let stats = pipeline.stats();
    pipeline.stop();
    assert_eq!(stats.reconnects, 0, "{stats:?}");
    assert_eq!(stats.read_errors, 0, "{stats:?}");
}

/// A port that another program holds: `open` fails until the holder lets go.
struct Busy {
    holder: Arc<std::sync::atomic::AtomicBool>,
    opens: Arc<AtomicUsize>,
}

impl TransportDriver for Busy {
    fn open(&mut self) -> Result<(), TransportError> {
        if self.holder.load(Ordering::Relaxed) {
            return Err(TransportError::Io("port is busy".to_string()));
        }
        self.opens.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn close(&mut self) {}

    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
        let len = out.len().min(32);
        out[..len].fill(0x5A);
        Ok(len)
    }

    fn write_frame(&mut self, _frame: &[u8]) -> Result<(), TransportError> {
        Ok(())
    }

    fn set_pins(&mut self, _pins: PinStateFlags) -> Result<(), TransportError> {
        Ok(())
    }

    fn read_pins(&mut self) -> Result<PinStateFlags, TransportError> {
        Ok(PinStateFlags::default())
    }

    fn state(&self) -> PortState {
        PortState::Open
    }
}

#[test]
fn a_yield_releases_the_port_and_takes_it_back_when_the_holder_leaves() {
    let holder = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let transport = Busy {
        holder: Arc::clone(&holder),
        opens: Arc::new(AtomicUsize::new(0)),
    };
    let mut pipeline = Pipeline::start(
        PipelineConfig {
            port_id: 1,
            consumers: 1,
            ..Default::default()
        },
        Box::new(transport),
    );
    let mut logger = pipeline.take_consumers().remove(0);

    // Let the reader take one chunk, then hand the port to a "flash tool".
    let deadline = Instant::now() + Duration::from_secs(2);
    while logger.pop().is_err() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    holder.store(true, Ordering::Relaxed);
    pipeline.yield_for(Duration::from_millis(1_500));

    // The state must show the port is gone while the flasher holds it.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut saw_yielded = false;
    while Instant::now() < deadline {
        if pipeline.stats().state == PortState::Yielded {
            saw_yielded = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(saw_yielded, "the yield was never reported");
    assert_eq!(pipeline.stats().yields, 1);

    // The flasher is done: the reader must take the port back by itself.
    holder.store(false, Ordering::Relaxed);
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut back = false;
    while Instant::now() < deadline {
        if pipeline.stats().state == PortState::Open && logger.pop().is_ok() {
            back = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    pipeline.stop();
    assert!(back, "the reader never reclaimed the port");
}
