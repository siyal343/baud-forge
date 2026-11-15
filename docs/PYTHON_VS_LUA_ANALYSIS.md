# Replacing Lua 5.4 with Python as BaudForge's Scripting Language: Scope, Architecture & Risk Analysis

**Document Status:** Architecture & Feasibility Analysis  
**Date:** 2026-11-16  
**Baseline Commit:** `d1c0122` (CI run `43721247956`)  
**Related Specs:** [`LUA_SCRIPTING_ENGINE.md`](../LUA_SCRIPTING_ENGINE.md) (`RFC-002`) · [`PLUGIN_ARCHITECTURE.md`](../PLUGIN_ARCHITECTURE.md) (`RFC-001`) · [`docs/LUA_SCRIPTING_TUTORIAL.md`](./LUA_SCRIPTING_TUTORIAL.md)

---

## 1. Executive Summary

Replacing Lua 5.4 (`mlua 0.10`) with Python in BaudForge is a **medium-to-large refactor**, not a workspace-wide rewrite — **provided you accept pure-Rust Python (`RustPython`) or an out-of-process hybrid model**. Attempting to swap in **standard CPython (`PyO3`)** as an inline packet hook causes severe sandboxing, threading (GIL), latency, and CI packaging regressions.

| Property | Assessment | Basis |
| :--- | :--- | :--- |
| **Estimated Effort (Pure-Rust `RustPython` replacement)** | **~3–5 engineering days** (including browser fallback rewrite & tests) | **Estimated** from measured file scope below |
| **Estimated Effort (`CPython`/`PyO3` full in-process replacement)** | **~7–10 engineering days** + major CI/packaging changes | **Estimated** (cross-compile toolchain, bundled Python runtime/DLLs, process sandbox workarounds) |
| **Estimated Effort (Dual-Plane Hybrid: Keep Lua Tier 2 + Add Python Tier 4 SDK)** | **~1–2 engineering days** | **Estimated** (zero changes to inline VM or browser sandbox; thin Python HTTP/SSE/WebSocket client) |
| **Core Rust Engine Impact (`bforge-core`, `bforge-cli`, `bforge-desktop`)** | **< 2% of code** (`~50` lines of fallback names/error strings) | **Measured** — zero direct `mlua` imports outside `crates/bforge-script` |
| **Main Rewrite Concentration** | `crates/bforge-script` VM bindings/tests + `ui/src/services/luaSandboxFallback.ts` + 18 `.lua` scripts + tutorial docs | **Measured** across all workspace crates & UI |

### Key Architectural Discovery
Inspection of the Rust workspace shows that **every boundary outside [`crates/bforge-script/`](../crates/bforge-script)** is already completely language-agnostic:
- `crates/bforge-core`, `crates/bforge-cli`, and `crates/bforge-desktop` **contain zero imports or references to `mlua`** (verified via workspace grep on commit `d1c0122`).
- [`Session`](../crates/bforge-core/src/session.rs) and [`serve.rs`](../crates/bforge-core/src/serve.rs) communicate exclusively through plain Rust structs exported by [`crates/bforge-script/src/lib.rs`](../crates/bforge-script/src/lib.rs): `ScriptRuntime`, `FrameMeta`, `HookKind`, `FrameVerdict`, `FaultPolicy`, `ScriptAction`, `DryRunReport`, `ScriptSnapshot`, and `ScriptError`.
- Even within [`crates/bforge-script/`](../crates/bforge-script), `FrameState` ([`frame.rs:88-275`](../crates/bforge-script/src/frame.rs#L88-L275)), lazy decode caching, `crc16_modbus` / `crc_width_and_compute`, [`xymodem.rs`](../crates/bforge-script/src/xymodem.rs) (`1,222` lines), and all runtime data structures/rate limiters/PRNG in [`runtime.rs:1-348`](../crates/bforge-script/src/runtime.rs#L1-L348) have **zero dependency on Lua**.

---

## 2. Measured Codebase Footprint

All line counts, byte sizes, and reference counts below are **measured** on commit `d1c0122`; impact percentages and rewrite line counts are **estimated** from code inspection.

| Layer / File | Measured Size | Language Coupling (Measured) | Estimated Change Needed to Swap Lua $\rightarrow$ Python |
| :--- | :--- | :--- | :--- |
| [`crates/bforge-script/Cargo.toml`](../crates/bforge-script/Cargo.toml) | `12` lines (`386` B) | Depends on `mlua = "0.10"` (`lua54`, `vendored`, `send`) | **100% (`1` dep)**: Swap `mlua` for `rustpython-vm` (or `pyo3`). Keep `bforge-dissect` and `bforge-framer`. |
| [`crates/bforge-script/src/lib.rs`](../crates/bforge-script/src/lib.rs) | `78` lines (`2,361` B) | Re-exports `LuaFrame` alongside `xymodem` & fault structs | **~10% (`~10` lines)**: Rename/re-export `PyFrame`; `FrameState`, `FrameVerdict`, `ScriptAction`, `FaultInjector`, and `xymodem` stay intact. |
| [`crates/bforge-script/src/frame.rs`](../crates/bforge-script/src/frame.rs) | `828` lines (`31,584` B) | `FrameState` (`88–275`) + helpers (`21–85, 277–360`) + tests (`740–828`) are pure Rust; `LuaFrame` (`mlua::UserData`, `363–738`) + byte parsers (`56–85, 199–239`) use `mlua` | **~45% (`~375` lines)**: Replace `impl UserData for LuaFrame` and `parse_lua_bytes` with `PyClass` / `#[pyclass]` getters, setters, and methods. `FrameState` stays untouched. |
| [`crates/bforge-script/src/runtime.rs`](../crates/bforge-script/src/runtime.rs) | `3,560` lines (`127,304` B) | Core types, PRNG, log bucket (`23–348`); `mlua` VM, watchdog, `bforge.*`, hook runner (`351–1901`); `35` Rust unit tests (`1902–3560`, `1,659` lines) | **~85% (`~3,000` lines)**: Keep types/PRNG/rate-limiter (`~325` lines); rewrite VM creation, `bforge` Python module bindings, hook execution, watchdog/memory guard, and rewrite all `35` Lua test strings in Python. |
| [`crates/bforge-script/src/xymodem.rs`](../crates/bforge-script/src/xymodem.rs) | `1,222` lines (`42,971` B) | Pure Rust X/YMODEM transfer engine (`bforge-cli` uses `9` symbols) | **0%**: No Lua dependency; untouched. |
| `crates/bforge-core/` (`lib.rs`, `contract.rs`, `session.rs`, `serve.rs`, `validate.rs`) | `~10,127` lines across these 5 files | `0` `mlua` imports; `31` references to `bforge_script`/`ScriptRuntime` (`lib.rs: 2`, `validate.rs: 5`, `session.rs: 14`, `serve.rs: 10`); `4` `"inline.lua"` fallback names | **< 1% (`~20` lines)**: Change `"inline.lua"` default names to `"inline.py"` (or accept `.py` in upload/CLI). Pipeline, `/api/script`, `UiSnapshot`, `SeriesSet`, and `Session` stay identical. |
| `crates/bforge-core/tests/` (`serve.rs`, `session.rs`) | `1,510` + `338` lines | `10` inline test Lua scripts in `serve.rs` and `1` in `session.rs` | **~120 lines**: Translate the inline script strings inside test cases from Lua to Python. |
| `crates/bforge-cli/` & `crates/bforge-desktop/` | `1,279` + `1,096` lines | `0` `mlua` imports (`cli` calls `enable_script` twice + `xymodem` `9` times; `desktop` calls `enable_script` twice) | **< 1% (`~5` lines)**: Optional CLI help/UI text updates (`script_path` works for any file path). |
| [`ui/src/components/ScriptLabView.tsx`](../ui/src/components/ScriptLabView.tsx) | `1,186` lines (`51,745` B) | Talks via `/api/script` JSON; Lua assumptions limited to UI labels (`LUA SCRIPT LAB`), `SCRIPT_API_DOCS`, comment syntax, and `.lua` download/upload | **~10% (`~120` lines)**: Update copy, Python API docs table, `.py` file extensions, and optional syntax hints (`Cmd/Ctrl+Enter` runner stays identical). |
| [`ui/src/services/luaSandboxFallback.ts`](../ui/src/services/luaSandboxFallback.ts) + [`.test.ts`](../ui/src/services/luaSandboxFallback.test.ts) | `3,788` + `551` = `4,339` lines (`150,963` B) | Custom TypeScript Lua 5.4 tokenizer/parser/VM (`STEP_LIMIT = 20,000`) + `SCRIPT_TEMPLATES` (`5` starter + `15` tutorials) + parity tests | **100% rewrite (`~2,500–3,500` lines + tests)**: Must either build an indentation-aware TypeScript Python-subset interpreter (`def`, `class`, slicing, list/dict comprehensions, `struct.pack`/`unpack`, f-strings) OR embed **Pyodide (Wasm)** in the frontend bundle. |
| [`ui/src/services/engineApi.ts`](../ui/src/services/engineApi.ts), [`useWorkstationStore.ts`](../ui/src/store/useWorkstationStore.ts), [`ui-smoke.mjs`](../ui/scripts/ui-smoke.mjs) | `1,082` + `1,365` + `980` lines | Store/API contract is JSON-agnostic; `ui-smoke.mjs` `T15` tests Script Lab | **< 2% (`~30` lines)**: Update test assertions if UI labels/template IDs change. |
| [`examples/*.lua` & `examples/tutorials/*.lua`](../examples/tutorials) | `18` files, `600` lines | Standalone Lua scripts | **100% (`18` files)**: Rewrite to `.py`. |
| [`docs/LUA_SCRIPTING_TUTORIAL.md`](../docs/LUA_SCRIPTING_TUTORIAL.md) & [`LUA_SCRIPTING_ENGINE.md`](../LUA_SCRIPTING_ENGINE.md) | `1,177` + `348` lines | Engineering spec & 15-script tutorial manual | **100% (`~1,525` lines)**: Rewrite/update documentation for Python syntax and semantics. |

---

## 3. Why Python Is Fundamentally Harder Than Lua Inside `bforge-script`

While changing `crates/bforge-script` looks localized on paper, Python breaks **five core invariants** that BaudForge's hot data plane relies on ([`LUA_SCRIPTING_ENGINE.md` §5–§6](../LUA_SCRIPTING_ENGINE.md)):

### 3.1 Inline Latency Budget ($\le 50\ \mu\text{s}$ at $10\ \text{kHz}+$ Packet Rate)
- **Measured Lua baseline:** `crates/bforge-script` compiles vendored **Lua 5.4** (`C`, register-based bytecode VM), where empty hook overhead is in the low single-digit microseconds and fits within the **$\le 50\ \mu\text{s}$** inline MITM budget (`specs/ADR & SRS.md:267`).
- **Python (Estimated):**
  - **CPython (`PyO3`)** dispatches via Python C-API boxing (`PyObject` refcounts, dict lookups, frame allocation on every callback). Simple hooks take roughly `~5–25 µs` once warmed, but object creation/GC pauses easily exceed `50 µs`.
  - **RustPython** is an AST-to-bytecode stack interpreter in pure Rust; per-frame dispatch and method calls are typically **5–20× slower** than Lua 5.4 / CPython, making sustained `10 kHz+` (`< 100 µs` total per packet) inline MITM hooks prone to saturating the pump loop.

### 3.2 Memory Cap (`4 MiB` Default / `16 MiB` Max) & `Send` Isolation
- **Measured Lua design (`runtime.rs:24-27, 447`):** Each `ScriptRuntime` owns a completely independent `mlua::Lua` VM with `Send` and an exact OS-agnostic allocator hook (`lua.set_memory_limit(4 MiB)`). Running a `/api/script` `test_frame` dry-run in an HTTP worker thread runs in **zero contention** with an armed `Session` VM on the pump thread.
- **CPython (`PyO3`) problem:**
  - CPython has **no native per-interpreter hard memory cap**: `malloc` belongs to the entire process. Two VMs cannot enforce isolated `4 MiB` limits cleanly.
  - Because `CPython` has a **process-global GIL** (unless sub-interpreters with PEP 684 per-interpreter GIL are hand-wired via unsafe C-API, still immature for cross-crate crates), `/api/script` dry-run testing in `serve.rs` contends on the same GIL as live serial/MITM packet pumping, causing telemetry jitter.
  - CPython fails on infinite memory allocation (`x = [0] * 10**9`) inside C `PyMem_Malloc` unless you install a custom global C allocator hook, which then affects the entire Rust host (`Session` / Tauri WebView process).
- **RustPython note:** Supports independent `vm::Interpreter` instances in pure Rust (improving isolation over CPython), **but lacks a built-in per-VM hard heap allocator limit (`set_memory_limit`) and lacks an instruction-count hook equivalent to `lua.set_hook(every_nth_instruction)`** out of the box without maintaining a custom fork/VM wrapper.

### 3.3 Instruction-Budget Watchdog (`200,000` VM Instructions)
- **Measured Lua design (`runtime.rs:33-37, 435-445`):** `lua.set_hook(HookTriggers::new().every_nth_instruction(500), ...)` aborts infinite loops (`while true do end`) deterministically within `200,000` VM instructions without killing threads or corrupting state.
- **CPython (`PyO3`):** `sys.settrace` executes a Python/C trace callback per *bytecode line or call*, adding huge runtime overhead (`3–10×` slower when enabled) and still fails to preempt tight C-extension loops (`b"a" * (10**9)` or `itertools.repeat` / big exponentiation `9**9**9`). `PyErr_SetInterrupt` uses process-wide signals, which are unsafe/coarse inside a multi-threaded desktop engine.

### 3.4 Sandboxing Security (Preventing Filesystem / OS Escape)
- **Measured Lua sandbox (`runtime.rs:420-422`):** Whitelists `StdLib::{TABLE, STRING, MATH, UTF8}` only. `io`, `os`, `package`, `debug`, `dofile`, `loadfile`, and `require` are never even loaded into the Lua state (`the_sandbox_has_no_filesystem_or_process` test in `runtime.rs`).
- **Python sandbox pitfall:** Even if you hide `__import__` and `open`, **CPython cannot be reliably sandboxed in-process**. Any Python code with object introspection (`().__class__.__base__.__subclasses__()`) can traverse live type subclasses in CPython memory (such as `os._wrap_close` or `_io.FileIO`) to open files or spawn shells. This is a well-known unsolved property of CPython's object model. **RustPython** mitigates OS escape *only* if you build it with zero filesystem/OS stdlib modules compiled in (`freeze-stdlib` stripped), though Python's `().__class__.__mro__` traversal still requires careful audit of every exposed type.

### 3.5 Packaging, Cross-Compilation & CI Impact (`10` Jobs, `6` Architectures)
From `.github/workflows/ci.yml` and the artifacts downloaded from run `43721247956`:
- CI currently builds & tests cleanly across **6 targets** (`linux-x86_64`, `linux-aarch64`, `macos-aarch64`, `macos-x86_64`, `windows-x86_64`, `windows-aarch64`) producing **single self-contained executables**:
  - Measured `bforge-windows-x86_64.exe` = **`4,813,312` bytes (`4.59 MiB`)**
  - Measured `bforge-desktop.exe` = **`13,241,344` bytes (`12.63 MiB`)**
- **`mlua` (`vendored` Lua 5.4)** compiles as pure ANSI C alongside `cargo build` with zero external libraries or DLLs on Windows ARM64, Windows x64, Linux ARM64/x64, or macOS.
- **`PyO3` (CPython)** breaks zero-dependency builds:
  - Requires matching target Python headers + `python3xx.dll` / `libpython3.xx.so` / `libpython3.xx.dylib` on **every one of the 6 CI runners** (especially fragile for `windows-aarch64` and `linux-aarch64` cross/native builds), plus shipping the Python DLL + standard library `Lib/` alongside `bforge-desktop.exe` and `bforge.exe`, inflating distribution size by **~25–60 MiB** (estimated).
- **`RustPython`** compiles in Cargo cleanly across architectures without DLLs, **but** pulls dozens of crates, increases compile times substantially, and increases binary size by **~5–10 MiB** (estimated).

### 3.6 The Hidden Frontend Cost: Browser / Simulated Mode Fallback
Because BaudForge runs **entirely client-side in Simulated Mode / offline UI tests** ([`ui/src/services/luaSandboxFallback.ts`](../ui/src/services/luaSandboxFallback.ts), `3,788` lines), removing Lua also breaks Script Lab's offline simulator unless replaced:
- **Option 1 — Custom TypeScript Python-Subset Interpreter:** Writing and testing a whitespace/indentation-sensitive lexer, recursive-descent parser, slicing (`data[2:6]`), `struct.pack`/`unpack`, dict/list methods, f-strings, and `xorshift64*` runtime is roughly **~2,500–3,500 lines of TypeScript + tests** — equivalent in effort to rewriting `crates/bforge-script` itself.
- **Option 2 — Embed Pyodide (CPython WebAssembly) in `ui/`:** Gives true Python in the browser without maintaining a custom TS parser, **but** adds **~10+ MiB** of Wasm/stdlib assets and ~`1–3 s` cold boot latency to a desktop bundle whose entire minified JS today is `1.19 MiB` (`1,247,679` bytes).

---

## 4. Side-by-Side Comparison of Approaches

| Criterion | Current: Lua 5.4 (`mlua`) | Option A: `RustPython` (Replace Lua) | Option B: `CPython` / `PyO3` (Replace Lua) | Option C: Dual-Plane Hybrid (**Recommended**) |
| :--- | :--- | :--- | :--- | :--- |
| **Inline MITM Latency ($\le 50\ \mu\text{s}$)** | Excellent (measured/designed for `10 kHz+`) | Slow (`~5–20×` slower interpreter, estimated) | Marginal (`GIL` + `PyObject` boxing) | **Best of both**: Lua inline ($\le 50\ \mu\text{s}$), Python out-of-process |
| **Deterministic Watchdog & RAM Cap (`4 MiB`)** | **Built-in & proven** (`35` tests passing) | **Missing upstream**; needs custom VM instrumentation | **Cannot enforce per-VM RAM cap** cleanly | **Lua stays sandboxed**; Python runs as OS subprocess (Tier 4) |
| **Sandbox Security** | **Strong** (whitelist `TABLE/STRING/MATH/UTF8`) | **Medium** (must strip stdlib + guard reflection) | **Unsafe in-process** (object graph escape) | **Safe**: OS process isolation for Python, VM sandbox for Lua |
| **Full Ecosystem (`numpy`, `scipy`, `pytest`, `pyserial`)** | None (minimal embedded runtime) | Partial (pure-Python stdlib subset; **no C extensions**) | Full CPython on host (needs bundled `site-packages`) | **Full host Python** (users use their own `venv`, `pytest`, `numpy`, `scipy`) |
| **6-Target Single-Binary CI (`4.6 MiB` CLI)** | **Already green (`10/10` jobs)** | Compiles statically, heavier build & binary | **Breaks single-file binary** (needs `python3xx.dll` + `Lib/` across 6 targets) | **Zero CI breakage** (`cargo`/`pnpm` binaries unchanged) |
| **Browser / Simulated Mode Sandbox (`ui/`)** | **Already built & tested** (`187` UI tests, `T15`) | Rewrite `3,788`-line TS fallback or add Pyodide | Rewrite `3,788`-line TS fallback or add Pyodide | **No UI fallback rewrite needed** |
| **Estimated Effort** | **0 days (done)** | **3–5 days** | **7–10 days + CI risk** | **1–2 days** (`pip`-installable `bforge` Python SDK) |

---

## 5. Recommendation

### Recommended Path 1 (Highest Engineering ROI): **Keep Lua 5.4 for Inline Hot Hooks + Add a Python HIL Automation SDK / Sidecar (Tier 4)**
BaudForge's [`PLUGIN_ARCHITECTURE.md`](../PLUGIN_ARCHITECTURE.md#L17-L28) already separates **Tier 2 (Embedded Lua 5.4 for $\le 50\ \mu\text{s}$ packet manipulation)** from **Tier 4 (Out-of-Process Sidecars for Python libraries, `pytest`, CAN/VISA instruments)**. Because `bforge` already exposes a complete HTTP + SSE control plane (`crates/bforge-core/src/serve.rs`: `/api/snapshot`, `/api/events`, `/api/send`, `/api/script`, `/api/pins`, `/api/transfer`, `/api/vault/*`), a thin **`python/baudforge/` SDK (~300–500 lines, zero Rust VM complexity)** gives users:
- Real Python scripts (`pytest` test suites, `numpy`/`scipy` post-processing, CI hardware regression runners, custom device emulators) running in their local `venv` against `127.0.0.1:7717`,
- Zero GIL stalls on UART/MITM packet forwarding,
- Zero impact on the `4.59 MiB` CLI binary or the `10/10` GitHub CI matrix, and
- Full compatibility with the existing 15 Lua tutorials and Script Lab sandbox.

### Recommended Path 2 (If You Specifically Want Users to Write Python Inside Script Lab)
Do **not** replace Lua with `CPython`/`PyO3` in-process. Instead, add Python as a **second backend inside `crates/bforge-script` using `RustPython` behind a language tag (`inline.py` / `.py`)**, keeping `mlua` for `.lua`:
1. Keep `FrameState` and all of `bforge-core` untouched (`Session`, `serve.rs`, `SeriesSet`).
2. Add a `ScriptLanguage::{Lua, Python}` enum in `bforge-script` (~**2–3 days** for core Rust runtime + `PyFrame` + basic Python fallback in `ui/`), gated clearly with a note that `.lua` should be used for high-rate (`> 1 kHz`) deterministic MITM hooks and `.py` for ergonomic bench logic (`< 1 kHz`).

### Only Replace Lua Completely If:
A strict product requirement mandates "zero Lua anywhere in the product" **and** you are willing to:
1. Rewrite `crates/bforge-script/src/{frame,runtime}.rs` (~`3,400` lines + tests) onto `RustPython` (accepting weaker instruction/memory enforcement unless patching the VM, and slower per-frame execution),
2. Rewrite `ui/src/services/luaSandboxFallback.ts` (`3,788` lines) + tests (`551` lines) for Python syntax & `struct.pack`, and
3. Translate all `18` `.lua` scripts (`600` lines) and `docs/LUA_SCRIPTING_TUTORIAL.md` (`1,177` lines) to Python.
