use serde::{Deserialize, Serialize};

/// Type of visual presentation widget attached to a dataset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum WidgetType {
    #[default]
    Plot,
    Bar,
    Gauge,
    Compass,
    Meter,
    Led,
}

/// Severity level for alarm bands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub enum AlarmSeverity {
    #[default]
    Info = 0,
    Ok = 1,
    Warning = 2,
    Critical = 3,
}

/// An alarm band defining a threshold range and associated alert severity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlarmBand {
    pub min: f64,
    pub max: f64,
    pub severity: AlarmSeverity,
    pub label: String,
}

impl AlarmBand {
    pub fn new(min: f64, max: f64, severity: AlarmSeverity, label: impl Into<String>) -> Self {
        Self {
            min,
            max,
            severity,
            label: label.into(),
        }
    }

    pub fn contains(&self, val: f64) -> bool {
        val >= self.min && val < self.max
    }
}

fn deserialize_f64_lenient<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.unwrap_or(0.0))
}

/// A single telemetry channel or metric.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Dataset {
    pub index: usize,
    pub name: String,
    pub value: f64,
    pub raw_value: String,
    pub units: String,
    pub widget: WidgetType,
    #[serde(default, deserialize_with = "deserialize_f64_lenient")]
    pub min: f64,
    #[serde(default, deserialize_with = "deserialize_f64_lenient")]
    pub max: f64,
    pub alarm_bands: Vec<AlarmBand>,
}

impl Dataset {
    pub fn new(index: usize, name: impl Into<String>, value: f64) -> Self {
        Self {
            index,
            name: name.into(),
            value,
            raw_value: format!("{:.4}", value),
            units: String::new(),
            widget: WidgetType::Plot,
            min: 0.0,
            max: 0.0,
            alarm_bands: Vec::new(),
        }
    }

    pub fn with_units(mut self, units: impl Into<String>) -> Self {
        self.units = units.into();
        self
    }

    pub fn with_widget(mut self, widget: WidgetType) -> Self {
        self.widget = widget;
        self
    }

    pub fn with_bounds(mut self, min: f64, max: f64) -> Self {
        self.min = min;
        self.max = max;
        self
    }

    pub fn active_alarm(&self) -> Option<&AlarmBand> {
        self.alarm_bands
            .iter()
            .find(|band| band.contains(self.value))
    }
}

/// A logical collection of related datasets (e.g. Accelerometer, Battery, GPS).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub group_id: u32,
    pub title: String,
    pub datasets: Vec<Dataset>,
}

impl Group {
    pub fn new(group_id: u32, title: impl Into<String>) -> Self {
        Self {
            group_id,
            title: title.into(),
            datasets: Vec::new(),
        }
    }

    pub fn add_dataset(&mut self, dataset: Dataset) {
        self.datasets.push(dataset);
    }
}

/// Complete telemetry snapshot from a device at a specific point in time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub frame_number: u64,
    pub timestamp_ms: u64,
    pub source_id: u32,
    pub groups: Vec<Group>,
    pub raw_payload: Vec<u8>,
}

impl Frame {
    pub fn new(frame_number: u64, timestamp_ms: u64, source_id: u32) -> Self {
        Self {
            frame_number,
            timestamp_ms,
            source_id,
            groups: Vec::new(),
            raw_payload: Vec::new(),
        }
    }

    pub fn add_group(&mut self, group: Group) {
        self.groups.push(group);
    }

    /// Flatten all datasets across groups in index order.
    pub fn all_datasets(&self) -> Vec<&Dataset> {
        self.groups.iter().flat_map(|g| g.datasets.iter()).collect()
    }

    /// Retrieve a dataset by its overall positional index.
    pub fn get_dataset(&self, index: usize) -> Option<&Dataset> {
        self.all_datasets().into_iter().find(|d| d.index == index)
    }

    /// Count total datasets across all groups.
    pub fn dataset_count(&self) -> usize {
        self.groups.iter().map(|g| g.datasets.len()).sum()
    }
}
