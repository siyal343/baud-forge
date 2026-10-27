//! Tauri v2 desktop host (ADR-001, FR-UI-01 to FR-UI-03).
//!
//! This crate will host the SolidJS + WebGPU frontend from `ui/`. It links the
//! same `bforge-core` library as the headless CLI, so the GUI adds no second
//! data path.
//!
//! Setup only: the crate exists to reserve the topology. Tauri v2 is added in
//! Milestone 2 together with the window, the IPC commands and the binary IPC
//! channel for frame windows.
