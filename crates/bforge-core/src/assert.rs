//! `bforge assert`: check a recorded session against a rule file (F1.5.5).
//!
//! The rule language is TOML, deliberately small. Three kinds cover the checks a
//! CI job needs on a captured session: text appears, bytes appear, and the
//! session holds an expected number of records. A fourth matcher would need a
//! parser or a dependency; scripting arrives with the Lua runtime in F4.4.

use bforge_storage::{LogReader, StorageError};
use serde::{Deserialize, Serialize};

/// A rule file.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AssertRules {
    #[serde(default)]
    pub checks: Vec<Check>,
}

/// One check.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Check {
    pub name: String,
    /// `contains`, `contains_hex`, `chunks` or `bytes`.
    pub kind: String,
    /// Text for `contains`, spaced hex for `contains_hex`.
    #[serde(default)]
    pub value: Option<String>,
    /// Lower bound for `chunks` and `bytes`.
    #[serde(default)]
    pub min: Option<u64>,
    /// Upper bound for `chunks` and `bytes`.
    #[serde(default)]
    pub max: Option<u64>,
}

/// The outcome of one check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckResult {
    pub name: String,
    pub kind: String,
    pub passed: bool,
    /// What was found, in words a CI log can show.
    pub detail: String,
}

/// The outcome of a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssertReport {
    pub vault: String,
    pub chunks: u64,
    pub payload_bytes: u64,
    pub checks: Vec<CheckResult>,
}

impl AssertReport {
    pub fn passed(&self) -> bool {
        self.checks.iter().all(|check| check.passed)
    }

    pub fn failures(&self) -> usize {
        self.checks.iter().filter(|check| !check.passed).count()
    }
}

/// Parse a rule file.
pub fn parse_rules(text: &str) -> Result<AssertRules, toml::de::Error> {
    toml::from_str(text)
}

/// Check a rule file without a session, so a typo fails before a run.
pub fn validate_rules(rules: &AssertRules) -> Vec<String> {
    let mut problems = Vec::new();
    if rules.checks.is_empty() {
        problems.push("a rule file needs at least one check".to_string());
    }
    for (index, check) in rules.checks.iter().enumerate() {
        let at = format!("checks[{index}]");
        if check.name.trim().is_empty() {
            problems.push(format!("{at}.name: must not be empty"));
        }
        match check.kind.as_str() {
            "contains" => {
                if check.value.as_deref().is_none_or(str::is_empty) {
                    problems.push(format!("{at}.value: `contains` needs text"));
                }
            }
            "contains_hex" => match check.value.as_deref().map(parse_hex) {
                Some(Some(bytes)) if !bytes.is_empty() => {}
                _ => problems.push(format!(
                    "{at}.value: `contains_hex` needs spaced hex bytes, for example `AA 55`"
                )),
            },
            "chunks" | "bytes" => {
                if check.min.is_none() && check.max.is_none() {
                    problems.push(format!("{at}: `{}` needs min or max", check.kind));
                }
                if let (Some(min), Some(max)) = (check.min, check.max)
                    && min > max
                {
                    problems.push(format!("{at}: min {min} is above max {max}"));
                }
            }
            other => problems.push(format!(
                "{at}.kind: `{other}` is not a check; use contains, contains_hex, chunks or bytes"
            )),
        }
    }
    problems
}

/// Run every check against a session.
pub fn evaluate(
    vault: &str,
    reader: &mut LogReader,
    rules: &AssertRules,
) -> Result<AssertReport, StorageError> {
    let total = reader.chunks();
    let mut matchers: Vec<Matcher> = rules
        .checks
        .iter()
        .filter_map(Matcher::from_check)
        .collect();

    // One pass over the file, in windows, so memory stays bounded.
    let mut frame = 0u64;
    while frame < total {
        let window = reader.window(frame, 256)?;
        if window.is_empty() {
            break;
        }
        for record in &window {
            for matcher in &mut matchers {
                matcher.push(&record.payload);
            }
        }
        frame += window.len() as u64;
    }

    let mut checks = Vec::with_capacity(rules.checks.len());
    for check in &rules.checks {
        let (passed, detail) = match check.kind.as_str() {
            "contains" | "contains_hex" => {
                let matcher = matchers.iter().find(|matcher| matcher.name == check.name);
                match matcher {
                    Some(matcher) if matcher.found => (true, describe_found(matcher)),
                    Some(matcher) => (
                        false,
                        format!(
                            "`{}` does not appear in {} bytes",
                            matcher.label,
                            reader.payload_bytes()
                        ),
                    ),
                    None => (false, "check could not be prepared".to_string()),
                }
            }
            "chunks" => compare(check, total),
            "bytes" => compare(check, reader.payload_bytes()),
            _ => (false, format!("unknown kind `{}`", check.kind)),
        };
        checks.push(CheckResult {
            name: check.name.clone(),
            kind: check.kind.clone(),
            passed,
            detail,
        });
    }

    Ok(AssertReport {
        vault: vault.to_string(),
        chunks: total,
        payload_bytes: reader.payload_bytes(),
        checks,
    })
}

fn describe_found(matcher: &Matcher) -> String {
    match matcher.at {
        Some(offset) => format!("`{}` found, first byte near offset {offset}", matcher.label),
        None => format!("`{}` found", matcher.label),
    }
}

fn compare(check: &Check, value: u64) -> (bool, String) {
    let above = check.min.is_none_or(|min| value >= min);
    let below = check.max.is_none_or(|max| value <= max);
    let detail = match (check.min, check.max) {
        (Some(min), Some(max)) => format!("{value} in {min}..={max}"),
        (Some(min), None) => format!("{value} >= {min}"),
        (None, Some(max)) => format!("{value} <= {max}"),
        (None, None) => format!("{value}, no bounds"),
    };
    (above && below, detail)
}

/// Searches a byte stream for one needle, across record boundaries.
struct Matcher {
    name: String,
    label: String,
    needle: Vec<u8>,
    /// Tail of the previous record, so a needle that straddles two records is found.
    tail: Vec<u8>,
    found: bool,
    at: Option<u64>,
    consumed: u64,
}

impl Matcher {
    fn from_check(check: &Check) -> Option<Self> {
        let (needle, label) = match check.kind.as_str() {
            "contains" => (
                check.value.as_deref()?.as_bytes().to_vec(),
                check.value.clone()?,
            ),
            "contains_hex" => (parse_hex(check.value.as_deref()?)?, check.value.clone()?),
            _ => return None,
        };
        if needle.is_empty() {
            return None;
        }
        Some(Self {
            name: check.name.clone(),
            label,
            needle,
            tail: Vec::new(),
            found: false,
            at: None,
            consumed: 0,
        })
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.found {
            self.consumed += bytes.len() as u64;
            return;
        }
        let mut haystack = Vec::with_capacity(self.tail.len() + bytes.len());
        haystack.extend_from_slice(&self.tail);
        haystack.extend_from_slice(bytes);
        if let Some(position) = find(&haystack, &self.needle) {
            self.found = true;
            self.at = Some(self.consumed.saturating_sub(self.tail.len() as u64) + position as u64);
        } else {
            let keep = self.needle.len().saturating_sub(1).min(haystack.len());
            self.tail = haystack[haystack.len() - keep..].to_vec();
        }
        self.consumed += bytes.len() as u64;
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Parse `AA 55 01` or `AA5501` into bytes.
fn parse_hex(text: &str) -> Option<Vec<u8>> {
    let cleaned: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("")
        .trim_start_matches("0x")
        .to_string();
    if !cleaned.len().is_multiple_of(2) {
        return None;
    }
    let (pairs, _) = cleaned.as_bytes().as_chunks::<2>();
    let mut out = Vec::with_capacity(pairs.len());
    for [high, low] in pairs {
        let high = (*high as char).to_digit(16)?;
        let low = (*low as char).to_digit(16)?;
        out.push((high as u8) << 4 | low as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_parsing_accepts_spaced_and_compact_forms() {
        assert_eq!(parse_hex("AA 55 01"), Some(vec![0xAA, 0x55, 0x01]));
        assert_eq!(parse_hex("aa5501"), Some(vec![0xAA, 0x55, 0x01]));
        assert_eq!(parse_hex("0xAA55"), Some(vec![0xAA, 0x55]));
        assert_eq!(parse_hex("AA5"), None);
        assert_eq!(parse_hex("ZZ"), None);
    }

    #[test]
    fn a_needle_straddling_two_records_is_found() {
        let mut matcher = Matcher {
            name: "straddle".to_string(),
            label: "55 AA".to_string(),
            needle: vec![0x55, 0xAA],
            tail: Vec::new(),
            found: false,
            at: None,
            consumed: 0,
        };
        matcher.push(&[0x00, 0x55]);
        assert!(!matcher.found);
        matcher.push(&[0xAA, 0x01]);
        assert!(matcher.found);
        assert_eq!(matcher.at, Some(1));
    }

    #[test]
    fn rules_are_checked_before_a_run() {
        let rules = parse_rules(
            r#"
            [[checks]]
            name = "text"
            kind = "contains"
            value = "boot"

            [[checks]]
            name = "count"
            kind = "chunks"
            min = 1
        "#,
        )
        .unwrap();
        assert!(validate_rules(&rules).is_empty());
    }

    #[test]
    fn a_bad_rule_says_what_to_fix() {
        let rules = parse_rules(
            r#"
            [[checks]]
            name = "hex"
            kind = "contains_hex"
            value = "AA 5"

            [[checks]]
            name = "typo"
            kind = "regex"
            value = "x"
        "#,
        )
        .unwrap();
        let problems = validate_rules(&rules);
        assert_eq!(problems.len(), 2);
        assert!(problems[0].contains("spaced hex"));
        assert!(problems[1].contains("is not a check"));
    }
}
