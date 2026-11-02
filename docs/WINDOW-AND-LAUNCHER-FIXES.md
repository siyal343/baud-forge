# Window Geometry, Native Controls, and Launcher Engine Resolution Fixes

## 1. Problem Description

The desktop application (`bforge-gui.exe`) had four issues:
1. The window could not resize.
2. The top-right control buttons (minimize, maximize, close) did not work.
3. The launcher interface did not fit on standard 1080p and 768p displays and caused vertical clipping.
4. Clicking launcher buttons failed to open the workbench.

## 2. Root Causes

1. **Frameless Window Configuration:**
   - In `crates/bforge-gui/src-tauri/tauri.conf.json`, `decorations` was set to `false` and `titleBarStyle` was `Overlay`.
   - On Windows, custom client decorations disable native four-edge border resizing, maximize snapping, and OS title bar buttons.
   - HTML buttons in `desktop.html` called `window.__TAURI__.window.getCurrentWindow()`. In Tauri v2, window APIs reside under `window.__TAURI__.webviewWindow.getCurrentWebviewWindow()`. The HTML buttons were inert.

2. **Screen Fit and Stale Coordinates:**
   - Default dimensions in `tauri.conf.json` were `1440x900`.
   - When the user closed the application in maximized mode on Windows, the OS recorded negative coordinates (`-8, -8`) into `window.json`.
   - On relaunch, `set_position(-8, -8)` placed the window edges outside the visible display.
   - `desktop.html` had `body { display: flex; align-items: center; }` without vertical scrolling (`overflow-y: auto`), which caused overflow to truncate at top and bottom.

3. **Dissector File Path Resolution:**
   - `examples/loopback-demo.bforge.toml` refers to `crates/bforge-dissect/tests/fixtures/imu_packet.h`.
   - In `crates/bforge-core/src/tail.rs`, dissector file loaders called `std::fs::read_to_string(file)`.
   - When `bforge-gui.exe` was executed from `target/debug`, the relative file path failed with `os error 3 (The system cannot find the path specified)`.
   - The failure halted `start_workspace`, and the error status was hidden below the screen viewport.

## 3. Implemented Changes

1. **Native OS Window Frame and Geometry (`crates/bforge-gui/src-tauri/tauri.conf.json` & `main.rs`):**
   - Enabled native window decorations (`"decorations": true`) and set `"resizable": true`.
   - Adjusted default window size to `1200x760` with minimum dimensions of `800x540`.
   - Clamped window position coordinates to `x >= 0, y >= 0` and size to `[800..1920, 540..1080]` in `restore_geometry`.
   - Removed dead HTML title bar and restored native Windows Aero Snap and title buttons.

2. **Launcher Layout and Responsive Scrolling (`ui/public/desktop.html`):**
   - Converted `.titlebar` to an in-flow header (`.launcher-header`).
   - Enabled natural document flow with `body { overflow-y: auto; }`.
   - Placed the `#status` banner below the hero header for immediate error visibility.
   - Replaced window navigation calls with `window.location.replace` to prevent back-button loops.

3. **Dissector File Path Resolution (`crates/bforge-core/src/tail.rs`):**
   - Implemented `read_dissector_file(file: &str) -> Result<String, TailError>`.
   - Resolves relative file paths against:
     1. Current working directory (`Path::new(file)`).
     2. Executable directory (`exe_dir.join(file)`).
     3. Workspace root ancestors (`exe_dir.join("../../").join(file)`).
     4. Build-time manifest directory (`CARGO_MANIFEST_DIR`).
   - Updated `c_header_ir`, `protobuf`, and `mavlink` dissector loaders.
   - Added demo workspace fallback path in `crates/bforge-gui/src-tauri/src/main.rs`.

## 4. Verification

- `cargo test --workspace`: 100% pass (0 failures, 12 CLI tests, 4 config checks, 5 vault tests, 34 core tests, 18 script tests, 14 storage tests).
- `bforge config check`: Validated `examples/loopback-demo.bforge.toml` from outside the workspace root with exit code 0.
- `bforge-gui.exe`: Verified clean process startup and native window frame rendering.
- `npm run build`: Frontend compiled and synced to `target/debug/ui/`.
