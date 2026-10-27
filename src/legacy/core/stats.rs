use serde::{Deserialize, Serialize};

/// Online statistical tracker for a numerical stream using Welford's algorithm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunningStats {
    count: u64,
    min: f64,
    max: f64,
    mean: f64,
    m2: f64,
    last_update_ms: u64,
    rate_hz: f64,
}

impl Default for RunningStats {
    fn default() -> Self {
        Self::new()
    }
}

impl RunningStats {
    pub fn new() -> Self {
        Self {
            count: 0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            mean: 0.0,
            m2: 0.0,
            last_update_ms: 0,
            rate_hz: 0.0,
        }
    }

    /// Update statistics with a new sample value and timestamp in milliseconds.
    pub fn update(&mut self, val: f64, now_ms: u64) {
        self.count += 1;

        if val < self.min {
            self.min = val;
        }
        if val > self.max {
            self.max = val;
        }

        let delta = val - self.mean;
        self.mean += delta / self.count as f64;
        let delta2 = val - self.mean;
        self.m2 += delta * delta2;

        if self.last_update_ms > 0 && now_ms > self.last_update_ms {
            let dt = (now_ms - self.last_update_ms) as f64 / 1000.0;
            if dt > 0.0 {
                let instant_rate = 1.0 / dt;
                // Exponential moving average for rate
                self.rate_hz = 0.9 * self.rate_hz + 0.1 * instant_rate;
            }
        }
        self.last_update_ms = now_ms;
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn min(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            self.min
        }
    }

    pub fn max(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            self.max
        }
    }

    pub fn mean(&self) -> f64 {
        self.mean
    }

    pub fn variance(&self) -> f64 {
        if self.count < 2 {
            0.0
        } else {
            self.m2 / (self.count - 1) as f64
        }
    }

    pub fn std_dev(&self) -> f64 {
        self.variance().sqrt()
    }

    pub fn rate_hz(&self) -> f64 {
        self.rate_hz
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }
}
