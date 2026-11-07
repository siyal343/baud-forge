//! End-to-end smoke for the crash hook: install it, register a ring, panic.
//! Run manually; the crash report lands in the temp directory.

fn main() {
    bforge_core::crash::install_panic_hook();
    let ring = std::sync::Arc::new(bforge_core::logs::LogRing::default());
    bforge_core::crash::register_ring(&ring);
    ring.log(
        bforge_core::logs::LogLevel::Info,
        bforge_core::logs::LogSource::Engine,
        "smoke",
        "about to die on purpose",
    );
    bforge_core::crash::set_activity_path(Some("C:\\tmp\\demo.bflog".into()));
    panic!("crash smoke test");
}
