//! Address badges for frames (spec 0024).
//!
//! A firmware panic usually reaches the host as a number inside a frame. When the
//! workspace names an image, every plausible code address in a decoded frame is
//! resolved to a function and a source line, so the badge can say
//! `panic @ main.rs:41` instead of `0x4200A1B8`.
//!
//! The resolver is a parameter, not a global: a test resolves with a stub, and the
//! live path resolves with the image the workspace loaded.

use crate::tail::SymbolHit;

/// Highest number of addresses one frame may contribute. A frame full of numbers
/// must not turn into a hundred lookups.
const MAX_HITS: usize = 4;

/// Below this, a number is data, not an address. Firmware images on embedded
/// targets start above it, and a small integer is never a function.
const MIN_ADDRESS: u64 = 0x1000;

/// Resolve the plausible addresses in one frame.
///
/// `resolve` answers `(function, file, line)` for an address inside the image.
/// Fields are visited in order, so the earliest field wins when a frame carries
/// several addresses.
pub fn symbolize(
    fields: &[(String, Option<f64>)],
    resolve: impl Fn(u64) -> Option<(String, Option<String>, Option<u32>)>,
) -> Vec<SymbolHit> {
    let mut hits = Vec::new();
    for (name, value) in fields {
        if hits.len() >= MAX_HITS {
            break;
        }
        let Some(value) = value else {
            continue;
        };
        if !value.is_finite() || *value < MIN_ADDRESS as f64 || value.fract() != 0.0 {
            continue;
        }
        let address = *value as u64;
        if let Some((function, file, line)) = resolve(address) {
            hits.push(SymbolHit {
                field: name.clone(),
                address,
                function,
                file,
                line,
            });
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(address: u64) -> Option<(String, Option<String>, Option<u32>)> {
        if (0x4200_0000..0x4201_0000).contains(&address) {
            Some((
                "app_main".to_string(),
                Some("main.rs".to_string()),
                Some(41),
            ))
        } else {
            None
        }
    }

    #[test]
    fn an_address_inside_the_image_becomes_a_badge() {
        let fields = vec![("pc".to_string(), Some(0x4200_A1B8 as f64))];
        let hits = symbolize(&fields, resolve);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].function, "app_main");
        assert_eq!(hits[0].line, Some(41));
        assert_eq!(hits[0].field, "pc");
    }

    #[test]
    fn small_numbers_and_fractions_are_not_addresses() {
        let fields = vec![
            ("battery".to_string(), Some(7400.0)),
            ("gain".to_string(), Some(0.25)),
            ("count".to_string(), Some(3.0)),
        ];
        assert!(symbolize(&fields, resolve).is_empty());
    }

    #[test]
    fn an_address_outside_the_image_is_skipped_and_the_next_one_is_tried() {
        let fields = vec![
            ("noise".to_string(), Some(0x7FFE_0000 as f64)),
            ("pc".to_string(), Some(0x4200_1000 as f64)),
        ];
        let hits = symbolize(&fields, resolve);
        assert_eq!(hits.len(), 1, "the noise did not stop the real address");
        assert_eq!(hits[0].field, "pc");
    }

    #[test]
    fn one_frame_yields_at_most_four_badges() {
        let fields: Vec<(String, Option<f64>)> = (0..8)
            .map(|index| {
                (
                    format!("pc{index}"),
                    Some(0x4200_0000 as f64 + index as f64),
                )
            })
            .collect();
        assert_eq!(symbolize(&fields, resolve).len(), 4);
    }
}
