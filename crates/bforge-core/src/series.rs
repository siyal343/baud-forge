//! Bounded numeric series for the plot band (F1.7.4, spec 0020).
//!
//! A plot needs numbers at a steady rate, not a stream of whole frames. Every
//! numeric leaf that a frame decodes is sampled here: one ring per port and field,
//! capped in count and depth, so a workspace with a hundred fields cannot grow the
//! process. A field that a later frame does not carry simply stops growing.

use crate::tail::TailRow;
use std::collections::{HashMap, VecDeque};

/// Series kept at once. Beyond this, new fields are counted and ignored.
pub const MAX_SERIES: usize = 32;

/// Samples kept per series. At 500 Hz this is 1.2 s of history.
pub const MAX_SAMPLES: usize = 600;

/// New samples for one series.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SeriesUpdate {
    pub port: String,
    pub field: String,
    /// Samples since the last call, oldest first.
    pub values: Vec<f64>,
}

/// The rings, keyed by port and flattened field name.
#[derive(Debug, Default)]
pub struct SeriesSet {
    order: Vec<(String, String)>,
    rings: HashMap<(String, String), VecDeque<f64>>,
    pending: HashMap<(String, String), Vec<f64>>,
    ignored: u64,
}

impl SeriesSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sample every numeric leaf of one decoded frame.
    pub fn sample(&mut self, row: &TailRow) {
        for field in &row.fields {
            let Some(value) = field.value_num else {
                continue;
            };
            if !value.is_finite() {
                continue;
            }
            let key = (row.port.clone(), field.name.clone());
            if !self.rings.contains_key(&key) {
                if self.order.len() >= MAX_SERIES {
                    self.ignored += 1;
                    continue;
                }
                self.order.push(key.clone());
                self.rings
                    .insert(key.clone(), VecDeque::with_capacity(MAX_SAMPLES));
            }
            let ring = self.rings.get_mut(&key).expect("inserted above");
            if ring.len() == MAX_SAMPLES {
                ring.pop_front();
            }
            ring.push_back(value);
            self.pending.entry(key).or_default().push(value);
        }
    }

    /// The series that have data, in the order they were first seen.
    pub fn keys(&self) -> Vec<(String, String)> {
        self.order.clone()
    }

    /// Latest sample of a series, for a readout.
    pub fn latest(&self, port: &str, field: &str) -> Option<f64> {
        let key = (port.to_string(), field.to_string());
        self.rings.get(&key).and_then(|ring| ring.back().copied())
    }

    /// Take the samples added since the last call. Series with no new sample are
    /// left out, so an idle port costs nothing.
    pub fn take(&mut self) -> Vec<SeriesUpdate> {
        let mut updates = Vec::new();
        for (port, field) in &self.order {
            let key = (port.clone(), field.clone());
            let Some(values) = self.pending.remove(&key) else {
                continue;
            };
            if values.is_empty() {
                continue;
            }
            updates.push(SeriesUpdate {
                port: port.clone(),
                field: field.clone(),
                values,
            });
        }
        updates
    }

    /// Fields dropped because the series limit was reached.
    pub fn ignored(&self) -> u64 {
        self.ignored
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tail::{FieldRow, TailRow};

    fn row(port: &str, value: Option<f64>, name: &str) -> TailRow {
        TailRow {
            port: port.to_string(),
            direction: bforge_hal::Direction::Rx,
            timestamp_us: 0,
            delta_us: 0,
            len: 4,
            hex: "00 00 00 00".to_string(),
            text: String::new(),
            protocol: Some("TEST".to_string()),
            fields: vec![FieldRow {
                name: name.to_string(),
                offset: 0,
                len: 4,
                value: value.map(|v| v.to_string()).unwrap_or_default(),
                value_num: value,
            }],
            decode_error: None,
            symbols: Vec::new(),
        }
    }

    #[test]
    fn numeric_fields_become_series_and_text_fields_do_not() {
        let mut set = SeriesSet::new();
        set.sample(&row("sim", Some(1.5), "v_batt"));
        set.sample(&row("sim", None, "mode_name"));
        assert_eq!(set.keys(), vec![("sim".to_string(), "v_batt".to_string())]);
        let updates = set.take();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].values, vec![1.5]);
        assert_eq!(set.latest("sim", "v_batt"), Some(1.5));
    }

    #[test]
    fn only_new_samples_travel() {
        let mut set = SeriesSet::new();
        set.sample(&row("sim", Some(1.0), "gyro"));
        assert_eq!(set.take()[0].values, vec![1.0]);
        assert!(set.take().is_empty(), "nothing new, nothing sent");
        set.sample(&row("sim", Some(2.0), "gyro"));
        assert_eq!(set.take()[0].values, vec![2.0]);
    }

    #[test]
    fn a_ring_keeps_the_newest_samples() {
        let mut set = SeriesSet::new();
        for index in 0..(MAX_SAMPLES + 5) {
            set.sample(&row("sim", Some(index as f64), "counter"));
        }
        let ring = set
            .rings
            .get(&("sim".to_string(), "counter".to_string()))
            .unwrap();
        assert_eq!(ring.len(), MAX_SAMPLES);
        assert_eq!(ring.front().copied(), Some(5.0));
        let sent: usize = set.take().iter().map(|update| update.values.len()).sum();
        assert_eq!(sent, MAX_SAMPLES + 5, "every sample travels once");
    }

    #[test]
    fn the_series_count_is_capped() {
        let mut set = SeriesSet::new();
        for index in 0..(MAX_SERIES + 3) {
            set.sample(&row("sim", Some(index as f64), &format!("f{index}")));
        }
        assert_eq!(set.keys().len(), MAX_SERIES);
        assert_eq!(set.ignored(), 3);
    }

    #[test]
    fn ports_keep_their_own_ring() {
        let mut set = SeriesSet::new();
        set.sample(&row("a", Some(1.0), "v"));
        set.sample(&row("b", Some(2.0), "v"));
        let updates = set.take();
        assert_eq!(updates.len(), 2);
        assert_eq!(set.latest("a", "v"), Some(1.0));
        assert_eq!(set.latest("b", "v"), Some(2.0));
    }
}
