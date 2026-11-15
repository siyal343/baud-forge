//! High-speed waveform triggering and min/max decimation for telemetry plots.

/// Edge polarity used when detecting trigger crossings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TriggerSlope {
    Rising,
    Falling,
    Either,
}

/// Acquisition trigger mode for waveform capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TriggerMode {
    Auto,
    Norm,
    Single,
    Roll,
}

/// Configuration parameters for edge trigger detection on a telemetry window.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TriggerConfig {
    pub mode: TriggerMode,
    pub slope: TriggerSlope,
    pub level: f64,
    pub holdoff_us: u64,
}

/// Four-point envelope summary for one decimated time bucket.
///
/// Preserves the first, minimum, maximum, and last sample in the bucket so
/// transient spikes and edges remain accurate at any zoom factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DecimatedBucket {
    pub t_first: u64,
    pub v_first: f64,
    pub t_min: u64,
    pub v_min: f64,
    pub t_max: u64,
    pub v_max: f64,
    pub t_last: u64,
    pub v_last: f64,
}

impl DecimatedBucket {
    fn point(t: u64, v: f64) -> Self {
        Self {
            t_first: t,
            v_first: v,
            t_min: t,
            v_min: v,
            t_max: t,
            v_max: v,
            t_last: t,
            v_last: v,
        }
    }
}

/// Summary statistics over all finite samples in an inspected window.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct WindowStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub rms: f64,
    pub pk_pk: f64,
    pub count: usize,
}

/// Find the latest sub-sample trigger crossing timestamp in microseconds.
///
/// Scans consecutive sample pairs `(i - 1, i)` forward from oldest to newest
/// across `timestamps_us[..len]` and `values[..len]` where
/// `len = timestamps_us.len().min(values.len())`. Each accepted edge arms a
/// holdoff period of `cfg.holdoff_us` microseconds during which later crossings
/// are ignored without extending holdoff; a subsequent crossing is accepted
/// once `t_cross - prev >= cfg.holdoff_us as f64`. Returns the most recent
/// accepted crossing timestamp, or `None` if no valid crossing occurred.
pub fn find_trigger_crossing(
    timestamps_us: &[u64],
    values: &[f64],
    cfg: &TriggerConfig,
) -> Option<f64> {
    let len = timestamps_us.len().min(values.len());
    if len < 2 || !cfg.level.is_finite() {
        return None;
    }

    let holdoff = cfg.holdoff_us as f64;
    let mut last_armed_trigger: Option<f64> = None;

    for i in 1..len {
        let v0 = values[i - 1];
        let v1 = values[i];
        if !v0.is_finite() || !v1.is_finite() {
            continue;
        }

        let rising = v0 < cfg.level && v1 >= cfg.level;
        let falling = v0 > cfg.level && v1 <= cfg.level;
        let crossed = match cfg.slope {
            TriggerSlope::Rising => rising,
            TriggerSlope::Falling => falling,
            TriggerSlope::Either => rising || falling,
        };
        if !crossed {
            continue;
        }

        let t0 = timestamps_us[i - 1];
        let t1 = timestamps_us[i];
        let frac = if (v1 - v0).abs() > f64::EPSILON {
            ((cfg.level - v0) / (v1 - v0)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let t_cross = t0 as f64 + frac * (t1.saturating_sub(t0) as f64);

        if last_armed_trigger.is_none_or(|prev| cfg.holdoff_us == 0 || t_cross - prev >= holdoff) {
            last_armed_trigger = Some(t_cross);
        }
    }

    last_armed_trigger
}

/// Decimate a window into `first/min/max/last` buckets while computing exact
/// window statistics in a single pass.
///
/// Inspects `len = timestamps_us.len().min(values.len())` samples and skips
/// non-finite values (`NaN`, `±Infinity`). When `buckets > 0` and
/// `len > buckets * 4`, samples are partitioned across up to `buckets`
/// contiguous index buckets (omitting any bucket whose samples are all
/// non-finite). Otherwise, when `buckets > 0`, one bucket per finite sample is
/// emitted; when `buckets == 0`, no buckets are returned while `WindowStats` is
/// still computed. Returns zeroed `WindowStats` with `count == 0` when no
/// finite samples exist.
pub fn decimate_min_max(
    timestamps_us: &[u64],
    values: &[f64],
    buckets: usize,
) -> (Vec<DecimatedBucket>, WindowStats) {
    let len = timestamps_us.len().min(values.len());
    let bucketed = buckets > 0 && len > buckets * 4;
    let emit_raw = buckets > 0 && !bucketed;

    let mut out = if buckets == 0 || len == 0 {
        Vec::new()
    } else if emit_raw {
        Vec::with_capacity(len)
    } else {
        Vec::with_capacity(buckets)
    };

    let mut bucket_idx = 0usize;
    let mut next_boundary = if bucketed {
        (len as u128 / buckets as u128) as usize
    } else {
        0
    };
    let mut current_bucket: Option<DecimatedBucket> = None;

    let mut count = 0usize;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut sum = 0.0_f64;
    let mut sum_sq = 0.0_f64;

    for i in 0..len {
        if bucketed && i == next_boundary {
            if let Some(b) = current_bucket.take() {
                out.push(b);
            }
            bucket_idx += 1;
            next_boundary = ((bucket_idx + 1) as u128 * len as u128 / buckets as u128) as usize;
        }

        let t = timestamps_us[i];
        let v = values[i];
        if !v.is_finite() {
            continue;
        }

        count += 1;
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
        sum += v;
        sum_sq += v * v;

        if emit_raw {
            out.push(DecimatedBucket::point(t, v));
        } else if bucketed {
            match current_bucket.as_mut() {
                None => {
                    current_bucket = Some(DecimatedBucket::point(t, v));
                }
                Some(b) => {
                    if v < b.v_min {
                        b.v_min = v;
                        b.t_min = t;
                    }
                    if v > b.v_max {
                        b.v_max = v;
                        b.t_max = t;
                    }
                    b.t_last = t;
                    b.v_last = v;
                }
            }
        }
    }

    if let Some(b) = current_bucket.take() {
        out.push(b);
    }

    let stats = if count == 0 {
        WindowStats {
            min: 0.0,
            max: 0.0,
            mean: 0.0,
            rms: 0.0,
            pk_pk: 0.0,
            count: 0,
        }
    } else {
        let n = count as f64;
        WindowStats {
            min,
            max,
            mean: sum / n,
            rms: (sum_sq / n).sqrt(),
            pk_pk: max - min,
            count,
        }
    };

    (out, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(slope: TriggerSlope, level: f64, holdoff_us: u64) -> TriggerConfig {
        TriggerConfig {
            mode: TriggerMode::Norm,
            slope,
            level,
            holdoff_us,
        }
    }

    #[test]
    fn trigger_rising_and_falling_interpolation() {
        let ts = [1000_u64, 1010, 1020, 1030];
        let vals = [0.0, 10.0, 10.0, 0.0];

        // Rising from 0.0 to 10.0 across [1000, 1010] at level 2.5 => t = 1002.5
        let t_rise = find_trigger_crossing(&ts, &vals, &cfg(TriggerSlope::Rising, 2.5, 0));
        assert!((t_rise.unwrap() - 1002.5).abs() < 1e-9);

        // Falling from 10.0 to 0.0 across [1020, 1030] at level 2.5 => t = 1027.5
        let t_fall = find_trigger_crossing(&ts, &vals, &cfg(TriggerSlope::Falling, 2.5, 0));
        assert!((t_fall.unwrap() - 1027.5).abs() < 1e-9);

        // Either picks the most recent crossing (falling at 1027.5)
        let t_either = find_trigger_crossing(&ts, &vals, &cfg(TriggerSlope::Either, 2.5, 0));
        assert!((t_either.unwrap() - 1027.5).abs() < 1e-9);
    }

    #[test]
    fn trigger_boundary_equality_and_flat_edge_cases() {
        // Reaching level exactly at sample 1 triggers; starting at level does not.
        let ts = [0_u64, 100, 200];
        assert_eq!(
            find_trigger_crossing(&ts, &[0.0, 5.0, 8.0], &cfg(TriggerSlope::Rising, 5.0, 0)),
            Some(100.0)
        );
        assert_eq!(
            find_trigger_crossing(&ts, &[5.0, 6.0, 7.0], &cfg(TriggerSlope::Rising, 5.0, 0)),
            None
        );
        assert_eq!(
            find_trigger_crossing(&ts, &[5.0, 4.0, 3.0], &cfg(TriggerSlope::Falling, 5.0, 0)),
            None
        );
        assert_eq!(
            find_trigger_crossing(&ts, &[8.0, 5.0, 2.0], &cfg(TriggerSlope::Falling, 5.0, 0)),
            Some(100.0)
        );

        // Non-monotonic timestamps fall back safely via saturating_sub.
        assert_eq!(
            find_trigger_crossing(
                &[500, 400],
                &[0.0, 10.0],
                &cfg(TriggerSlope::Rising, 5.0, 0)
            ),
            Some(500.0)
        );
    }

    #[test]
    fn trigger_holdoff_suppresses_bounce_without_extending_window() {
        // Crossings at t = 100.0, 130.0, 145.0, 160.0 (level = 5.0).
        // With holdoff = 50 us:
        // - 100.0 arms trigger
        // - 130.0 (dt=30) suppressed
        // - 145.0 (dt=45) suppressed
        // - 160.0 (dt=60 >= 50) re-arms and wins!
        let ts = [95, 105, 125, 135, 140, 150, 155, 165];
        let vals = [0.0, 10.0, 0.0, 10.0, 0.0, 10.0, 0.0, 10.0];

        let t = find_trigger_crossing(&ts, &vals, &cfg(TriggerSlope::Rising, 5.0, 50));
        assert!((t.unwrap() - 160.0).abs() < 1e-9);

        // With holdoff = 100 us, all bounces through 160.0 are within [100, 200) -> 100.0 stays.
        let t_long = find_trigger_crossing(&ts, &vals, &cfg(TriggerSlope::Rising, 5.0, 100));
        assert!((t_long.unwrap() - 100.0).abs() < 1e-9);

        // Exact boundary dt == holdoff_us (60 us) must accept the later crossing.
        let t_exact = find_trigger_crossing(&ts, &vals, &cfg(TriggerSlope::Rising, 5.0, 60));
        assert!((t_exact.unwrap() - 160.0).abs() < 1e-9);
    }

    #[test]
    fn trigger_handles_short_mismatched_and_non_finite_inputs() {
        let c = cfg(TriggerSlope::Either, 1.0, 0);
        assert_eq!(find_trigger_crossing(&[], &[], &c), None);
        assert_eq!(find_trigger_crossing(&[10], &[5.0], &c), None);
        assert_eq!(
            find_trigger_crossing(&[10, 20, 30], &[0.0, 2.0], &c),
            Some(15.0)
        );
        assert_eq!(
            find_trigger_crossing(&[10, 20, 30], &[0.0, f64::NAN, 2.0], &c),
            None
        );
        assert_eq!(
            find_trigger_crossing(&[10, 20, 30], &[0.0, f64::INFINITY, 2.0], &c),
            None
        );
        assert_eq!(
            find_trigger_crossing(
                &[10, 20],
                &[0.0, 2.0],
                &cfg(TriggerSlope::Rising, f64::NAN, 0)
            ),
            None
        );
    }

    #[test]
    fn decimate_preserves_bucket_envelope_and_stats() {
        // 17 samples into 4 buckets (17 > 4 * 4 => bucketed):
        // boundaries at [0..4), [4..8), [8..12), [12..17)
        let ts: Vec<u64> = (0..17).map(|i| i * 10).collect();
        let vals = [
            1.0, -5.0, 3.0, 2.0, // b0: first=1, min=-5@10, max=3@20, last=2@30
            4.0, 12.0, -1.0, 6.0, // b1: first=4@40, min=-1@60, max=12@50, last=6@70
            0.0, 0.0, 0.0, 0.0, // b2: all zero
            -3.0, 9.0, -8.0, 7.0, 5.0, // b3: first=-3@120, min=-8@140, max=9@130, last=5@160
        ];

        let (buckets, stats) = decimate_min_max(&ts, &vals, 4);
        assert_eq!(buckets.len(), 4);

        assert_eq!(
            buckets[0],
            DecimatedBucket {
                t_first: 0,
                v_first: 1.0,
                t_min: 10,
                v_min: -5.0,
                t_max: 20,
                v_max: 3.0,
                t_last: 30,
                v_last: 2.0,
            }
        );
        assert_eq!(
            buckets[1],
            DecimatedBucket {
                t_first: 40,
                v_first: 4.0,
                t_min: 60,
                v_min: -1.0,
                t_max: 50,
                v_max: 12.0,
                t_last: 70,
                v_last: 6.0,
            }
        );
        assert_eq!(
            buckets[3],
            DecimatedBucket {
                t_first: 120,
                v_first: -3.0,
                t_min: 140,
                v_min: -8.0,
                t_max: 130,
                v_max: 9.0,
                t_last: 160,
                v_last: 5.0,
            }
        );

        let global_min = buckets
            .iter()
            .map(|b| b.v_min)
            .fold(f64::INFINITY, f64::min);
        let global_max = buckets
            .iter()
            .map(|b| b.v_max)
            .fold(f64::NEG_INFINITY, f64::max);
        assert_eq!(global_min, stats.min);
        assert_eq!(global_max, stats.max);
        assert_eq!(buckets.first().unwrap().v_first, vals[0]);
        assert_eq!(buckets.last().unwrap().v_last, vals[vals.len() - 1]);

        let expected_sum: f64 = vals.iter().sum();
        let expected_sum_sq: f64 = vals.iter().map(|v| v * v).sum();
        assert_eq!(stats.count, 17);
        assert_eq!(stats.min, -8.0);
        assert_eq!(stats.max, 12.0);
        assert_eq!(stats.pk_pk, 20.0);
        assert!((stats.mean - expected_sum / 17.0).abs() < 1e-12);
        assert!((stats.rms - (expected_sum_sq / 17.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn decimate_small_window_emits_one_bucket_per_finite_sample() {
        let ts = [10, 20, 30, 40];
        let vals = [2.0, f64::NAN, -4.0, 6.0];
        let (buckets, stats) = decimate_min_max(&ts, &vals, 2);
        assert_eq!(buckets.len(), 3);
        assert_eq!(
            buckets[0],
            DecimatedBucket {
                t_first: 10,
                v_first: 2.0,
                t_min: 10,
                v_min: 2.0,
                t_max: 10,
                v_max: 2.0,
                t_last: 10,
                v_last: 2.0,
            }
        );
        assert_eq!(buckets[1].t_first, 30);
        assert_eq!(buckets[1].v_first, -4.0);
        assert_eq!(buckets[2].t_last, 40);
        assert_eq!(buckets[2].v_last, 6.0);

        assert_eq!(stats.count, 3);
        assert_eq!(stats.min, -4.0);
        assert_eq!(stats.max, 6.0);
        assert_eq!(stats.pk_pk, 10.0);
        assert!((stats.mean - 4.0 / 3.0).abs() < 1e-12);
        assert!((stats.rms - ((4.0_f64 + 16.0 + 36.0) / 3.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn decimate_edge_cases_empty_zero_buckets_and_all_nan_bucket() {
        // Empty input
        let (b_empty, s_empty) = decimate_min_max(&[], &[], 10);
        assert!(b_empty.is_empty());
        assert_eq!(
            s_empty,
            WindowStats {
                min: 0.0,
                max: 0.0,
                mean: 0.0,
                rms: 0.0,
                pk_pk: 0.0,
                count: 0,
            }
        );

        // Zero buckets requested: no buckets emitted, stats still computed
        let (b_zero, s_zero) = decimate_min_max(&[1, 2], &[-3.0, 3.0], 0);
        assert!(b_zero.is_empty());
        assert_eq!(s_zero.count, 2);
        assert_eq!(s_zero.min, -3.0);
        assert_eq!(s_zero.max, 3.0);
        assert_eq!(s_zero.mean, 0.0);
        assert_eq!(s_zero.rms, 3.0);
        assert_eq!(s_zero.pk_pk, 6.0);

        // All non-finite values
        let (b_nan, s_nan) =
            decimate_min_max(&[1, 2, 3], &[f64::NAN, f64::INFINITY, f64::NEG_INFINITY], 1);
        assert!(b_nan.is_empty());
        assert_eq!(s_nan, s_empty);

        // Bucketed run where middle bucket is entirely NaN and boundary lands on NaN
        let ts: Vec<u64> = (0..15).collect();
        let mut vals = vec![1.0; 15];
        // For len=15, buckets=3: [0..5), [5..10), [10..15). Make [5..10) all NaN.
        for v in &mut vals[5..10] {
            *v = f64::NAN;
        }
        vals[0] = -2.0;
        vals[14] = 4.0;
        let (buckets, stats) = decimate_min_max(&ts, &vals, 3);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].t_first, 0);
        assert_eq!(buckets[0].v_first, -2.0);
        assert_eq!(buckets[1].t_first, 10);
        assert_eq!(buckets[1].t_last, 14);
        assert_eq!(buckets[1].v_last, 4.0);
        assert_eq!(stats.count, 10);
        assert_eq!(stats.min, -2.0);
        assert_eq!(stats.max, 4.0);
        assert_eq!(stats.pk_pk, 6.0);
    }

    #[test]
    fn types_serialize_cleanly() {
        let trigger = TriggerConfig {
            mode: TriggerMode::Single,
            slope: TriggerSlope::Rising,
            level: 3.3,
            holdoff_us: 250,
        };
        let encoded = serde_json::to_string(&trigger).unwrap();
        let decoded: TriggerConfig = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, trigger);

        let (_, stats) = decimate_min_max(&[0], &[-5.0], 4);
        assert_eq!(stats.rms, 5.0);
        assert_eq!(stats.pk_pk, 0.0);
        let stats_json = serde_json::to_string(&stats).unwrap();
        assert!(stats_json.contains("\"count\":1"));
    }
}
