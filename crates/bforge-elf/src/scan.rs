//! Pointer scanning (F3.5): find addresses in a line of firmware text.
//!
//! Firmware prints addresses in its own dialects: `0x0800412a` in a fault dump,
//! `PC: 0x400d1234` in an Arduino panic, `0x0000000080001234` on a 64-bit target.
//! The scanner only accepts 8 or 16 hex digits, and only at a word boundary, so a
//! CRC or a decimal number does not turn into a badge.

/// One pointer found in the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressHit {
    pub address: u64,
    /// The text as it appeared, for example `0x0800412a`.
    pub text: String,
    /// Byte offset of the `0` in the original string.
    pub byte_offset: usize,
}

/// Every 32-bit or 64-bit pointer in `text`, in the order they appear.
pub fn scan_pointers(text: &str) -> Vec<AddressHit> {
    let bytes = text.as_bytes();
    let mut hits = Vec::new();
    let mut index = 0;

    while index + 2 <= bytes.len() {
        let at_boundary = index == 0 || !is_word_byte(bytes[index - 1]);
        let prefix = &bytes[index..index + 2];
        if !(at_boundary && (prefix == b"0x" || prefix == b"0X")) {
            index += 1;
            continue;
        }

        let digits_start = index + 2;
        let mut end = digits_start;
        while end < bytes.len() && bytes[end].is_ascii_hexdigit() && end - digits_start < 16 {
            end += 1;
        }
        let digits = &text[digits_start..end];
        let length = digits.len();

        // A pointer prints as 8 hex digits on a 32-bit target and up to 16 on a
        // 64-bit one, without leading zeros (`0x140001434` is a real address).
        // Fewer than 8 is not a pointer, and a longer run is a different value.
        let continues = end < bytes.len() && is_word_byte(bytes[end]);
        if (8..=16).contains(&length)
            && !continues
            && let Ok(address) = u64::from_str_radix(digits, 16)
        {
            hits.push(AddressHit {
                address,
                text: text[index..end].to_string(),
                byte_offset: index,
            });
            index = end;
            continue;
        }
        index += 1;
    }

    hits
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addresses(text: &str) -> Vec<u64> {
        scan_pointers(text)
            .into_iter()
            .map(|hit| hit.address)
            .collect()
    }

    #[test]
    fn a_fault_dump_yields_both_kinds_of_pointer() {
        let text = "HardFault: PC: 0x0800412a LR: 0x08001234 SP: 0x20004ff0";
        assert_eq!(addresses(text), vec![0x0800_412a, 0x0800_1234, 0x2000_4ff0]);
    }

    #[test]
    fn a_sixty_four_bit_pointer_is_recognised() {
        let text = "abort at 0x0000000080001234 via 0xFFFFFFFFFFFFFFFF";
        assert_eq!(addresses(text), vec![0x8000_1234, u64::MAX]);
    }

    #[test]
    fn short_runs_are_ignored_and_wide_ones_are_addresses() {
        // Three and seven digits are not pointers. Nine to sixteen are, because a
        // 64-bit address is printed without its leading zeros.
        assert!(addresses("0x123 0x1234567").is_empty());
        assert_eq!(addresses("0x123456789"), vec![0x1_2345_6789]);
        assert_eq!(addresses("0xAABBCCDDEEFF"), vec![0xAABB_CCDD_EEFF]);
    }

    #[test]
    fn a_run_longer_than_sixteen_digits_is_not_a_pointer() {
        assert!(addresses("0x0800412a5b6c7d8e9f00").is_empty());
        assert!(addresses("id0x0800412a").is_empty());
    }

    #[test]
    fn uppercase_prefix_and_digits_work() {
        assert_eq!(addresses("PC=0XDEADBEEF"), vec![0xDEAD_BEEF]);
    }

    #[test]
    fn byte_offsets_point_at_the_prefix() {
        let text = "err 0x0800412a end";
        let hits = scan_pointers(text);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].byte_offset, 4);
        assert_eq!(&text[hits[0].byte_offset..][..10], "0x0800412a");
        assert_eq!(hits[0].text, "0x0800412a");
    }

    #[test]
    fn a_line_without_pointers_yields_nothing() {
        assert!(scan_pointers("watchdog reset after 2500 ms").is_empty());
        assert!(scan_pointers("").is_empty());
    }
}
