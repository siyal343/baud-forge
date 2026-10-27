//! Baud Forge: open-source serial monitor.
//!
//! The telemetry core inherited from porti-rs lives in [`legacy`]. New code
//! belongs at the crate root and must not depend on `legacy` internals.

pub mod legacy;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
