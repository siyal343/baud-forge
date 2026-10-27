use serde::{Deserialize, Serialize};

/// Fixed-capacity circular ring buffer for real-time telemetry plotting.
/// Avoids repeated memory allocations on the high-rate processing hotpath.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RingBuffer<T> {
    buffer: Vec<T>,
    capacity: usize,
    head: usize,
    len: usize,
}

impl<T: Clone> RingBuffer<T> {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "Capacity must be greater than zero");
        Self {
            buffer: Vec::with_capacity(capacity),
            capacity,
            head: 0,
            len: 0,
        }
    }

    /// Push an item into the buffer. Overwrites oldest item when full.
    pub fn push(&mut self, item: T) {
        if self.buffer.len() < self.capacity {
            self.buffer.push(item);
            self.len = self.buffer.len();
        } else {
            self.buffer[self.head] = item;
            self.head = (self.head + 1) % self.capacity;
        }
    }

    /// Returns the number of items stored in the buffer.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Checks if the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Returns maximum capacity.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Clears all elements from the buffer.
    pub fn clear(&mut self) {
        self.buffer.clear();
        self.head = 0;
        self.len = 0;
    }

    /// Returns items in chronological order (oldest to newest).
    pub fn to_vec(&self) -> Vec<T> {
        if self.len < self.capacity {
            self.buffer.clone()
        } else {
            let mut result = Vec::with_capacity(self.capacity);
            result.extend_from_slice(&self.buffer[self.head..]);
            result.extend_from_slice(&self.buffer[..self.head]);
            result
        }
    }

    /// Returns the most recently pushed item.
    pub fn latest(&self) -> Option<&T> {
        if self.len == 0 {
            None
        } else if self.len < self.capacity {
            self.buffer.last()
        } else {
            let idx = if self.head == 0 {
                self.capacity - 1
            } else {
                self.head - 1
            };
            Some(&self.buffer[idx])
        }
    }
}
