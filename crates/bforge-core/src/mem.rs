//! Resident memory of this process (F1.6.2).
//!
//! The target is 150 MB while viewing a 100 GB session. A harness has to read the
//! same number the operating system reports, so this module asks the operating
//! system and never guesses.

/// Resident set size in bytes, or `None` when the platform has no cheap answer.
pub fn resident_bytes() -> Option<u64> {
    platform::resident_bytes()
}

/// Peak resident set size in bytes, when the platform tracks it for us.
pub fn peak_resident_bytes() -> Option<u64> {
    platform::peak_resident_bytes()
}

#[cfg(target_os = "linux")]
mod platform {
    pub fn resident_bytes() -> Option<u64> {
        // VmRSS in /proc/self/status is in kB.
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        let line = status
            .lines()
            .find(|line| line.starts_with("VmRSS:"))?
            .split_whitespace()
            .nth(1)?;
        Some(line.parse::<u64>().ok()? * 1024)
    }

    pub fn peak_resident_bytes() -> Option<u64> {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        let line = status
            .lines()
            .find(|line| line.starts_with("VmHWM:"))?
            .split_whitespace()
            .nth(1)?;
        Some(line.parse::<u64>().ok()? * 1024)
    }
}

#[cfg(windows)]
mod platform {
    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetProcessMemoryInfo(
            process: isize,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    fn counters() -> Option<ProcessMemoryCounters> {
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            ..Default::default()
        };
        // SAFETY: the handle is this process, and the struct is sized and aligned
        // as the Win32 declaration requires. The call only writes into `counters`.
        let ok = unsafe {
            GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                std::mem::size_of::<ProcessMemoryCounters>() as u32,
            )
        };
        (ok != 0).then_some(counters)
    }

    pub fn resident_bytes() -> Option<u64> {
        counters().map(|counters| counters.working_set_size as u64)
    }

    pub fn peak_resident_bytes() -> Option<u64> {
        counters().map(|counters| counters.peak_working_set_size as u64)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    fn rss_kb(selector: &str) -> Option<u64> {
        // `ps` reports RSS in kB on macOS, the same unit the handbook target uses.
        let output = std::process::Command::new("ps")
            .args(["-o", selector, "-p", &std::process::id().to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8(output.stdout).ok()?;
        text.lines()
            .nth(1)?
            .trim()
            .parse::<u64>()
            .ok()
            .map(|kb| kb * 1024)
    }

    pub fn resident_bytes() -> Option<u64> {
        rss_kb("rss=")
    }

    pub fn peak_resident_bytes() -> Option<u64> {
        None
    }
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
mod platform {
    pub fn resident_bytes() -> Option<u64> {
        None
    }

    pub fn peak_resident_bytes() -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn this_platform_reports_something_plausible() {
        if let Some(bytes) = super::resident_bytes() {
            // A running test process holds at least a page and less than 16 GB.
            assert!(bytes > 4096, "{bytes}");
            assert!(bytes < 16 * 1024 * 1024 * 1024, "{bytes}");
        }
    }
}
