//! Slab pool and chunk metadata for the SPMC pipeline (F1.1.2).

use bforge_hal::{Direction, PinStateFlags};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

/// Default slab size. One slab is one read from the transport.
pub const DEFAULT_SLAB_BYTES: usize = 64 * 1024;

/// What the pipeline knows about one slab, independent of where it is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkMeta {
    /// Monotonic chunk counter for this port.
    pub seq_id: u64,
    /// Nanoseconds since the session started.
    pub timestamp_ns: u64,
    pub port_id: u16,
    pub direction: Direction,
    /// Pins and error bits sampled with this slab.
    pub line_state: PinStateFlags,
    pub len: u32,
}

/// A filled slab. The buffer returns to the pool when the last consumer drops it.
#[derive(Debug)]
pub struct Slab {
    pub meta: ChunkMeta,
    data: Vec<u8>,
    recycle: Option<SyncSender<Vec<u8>>>,
}

impl Slab {
    pub fn new(meta: ChunkMeta, data: Vec<u8>, recycle: Option<SyncSender<Vec<u8>>>) -> Self {
        debug_assert_eq!(data.len(), meta.len as usize);
        Self {
            meta,
            data,
            recycle,
        }
    }

    /// The bytes of this chunk.
    pub fn bytes(&self) -> &[u8] {
        &self.data
    }
}

impl Drop for Slab {
    fn drop(&mut self) {
        if let Some(recycle) = self.recycle.take() {
            // The pool may already be gone during shutdown. That is not an error.
            let _ = recycle.send(std::mem::take(&mut self.data));
        }
    }
}

/// Fixed-size buffer pool. `take` hands out a full-length buffer and never
/// allocates after the first lap, because every `Slab` returns its buffer here.
#[derive(Debug)]
pub struct SlabPool {
    free: Receiver<Vec<u8>>,
    recycle: SyncSender<Vec<u8>>,
    slab_bytes: usize,
    allocated: u64,
}

impl SlabPool {
    pub fn new(capacity: usize, slab_bytes: usize) -> Self {
        assert!(slab_bytes > 0, "slab size must be greater than zero");
        let (recycle, free) = sync_channel(capacity.max(1));
        Self {
            free,
            recycle,
            slab_bytes,
            allocated: 0,
        }
    }

    /// Hand this to every `Slab`, so its buffer comes back on drop.
    pub fn recycle_handle(&self) -> SyncSender<Vec<u8>> {
        self.recycle.clone()
    }

    /// Return a buffer of exactly `slab_bytes`, ready to be written.
    pub fn take(&mut self) -> Vec<u8> {
        match self.free.try_recv() {
            Ok(mut buffer) => {
                buffer.clear();
                buffer.resize(self.slab_bytes, 0);
                buffer
            }
            Err(_) => {
                self.allocated += 1;
                vec![0u8; self.slab_bytes]
            }
        }
    }

    /// Number of real allocations. The read loop must keep this flat.
    pub fn allocated(&self) -> u64 {
        self.allocated
    }
}
