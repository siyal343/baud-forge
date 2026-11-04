# BaudForge Frontend Architecture Specification

Document Version: 1.0.0  
Status: Authoritative Architectural Standard  
Target: BaudForge Desktop GUI  
References: `specs/ADR & SRS.md`, `crates/bforge-core/src/contract.rs`, `crates/bforge-core/src/serve.rs`

---

## 1. Selected Technology Stack

| Layer | Technology | Version | Rationale |
| :--- | :--- | :--- | :--- |
| **Desktop Shell** | Tauri v2 / Modern Browser | 2.x | Tiny binary footprint (< 15 MB), zero GC in I/O, native OS windowing |
| **UI Framework** | React + TypeScript | 19.x / 5.x | Strict type safety, rich ecosystem, reliable component composition |
| **Build Tool** | Vite | 6.x | Instant HMR, minimal dev server overhead, optimized tree-shaken builds |
| **Styling** | Tailwind CSS v4 | 4.x | Utility-first design tokens, zero runtime CSS injection overhead |
| **Docking Engine**| Dockview | 1.x | Professional IDE-style multi-dock, resizable split panes, floating tabs |
| **State Management**| Zustand | 5.x | Minimal boilerplate, fine-grained selector re-renders, decoupled store |
| **Waveform Engine** | HTML5 Canvas 2D | Native | 60 FPS continuous telemetry rendering with sub-pixel interpolation |

---

## 2. Integration Boundary with Rust Engine

BaudForge maintains a clean architectural boundary between the high-speed data acquisition engine and the presentation UI:

```text
+-------------------------------------------------------------------------------+
| RUST ENGINE (bforge-core, bforge-hal, bforge-storage, bforge-dissect)         |
| - Dedicated OS thread with pre-allocated 64 KB BytesMut slabs                |
| - 12 Mbaud zero-copy ring-buffer (SPMC) & memory-mapped .bflog storage       |
| - Declarative C-struct parser & DWARF symbolizer                              |
| - Headless HTTP/SSE server (crates/bforge-core/src/serve.rs)                  |
+-------------------------------------------------------+-----------------------+
                                                        | Loopback HTTP & SSE
                                                        | (http://127.0.0.1:7717)
                                                        v
+-------------------------------------------------------------------------------+
| FRONTEND WORKSTATION (ui/)                                                    |
| - Server-Sent Events (SSE) listener: /api/events (snapshot, ui, frames)       |
| - REST Control Plane: /api/send, /api/pins, /api/yield, /api/fault, /api/diff|
| - Bounded Client Circular Ring-Buffer (holds latest 20,000 frames)           |
| - Virtualized Packet Table with sub-microsecond timestamps                    |
| - Cross-Panel Selection Store (Zustand: activeFrame, activeField, cursorTime) |
| - 60 FPS HTML5 Canvas Scope (requestAnimationFrame loop decoupled from React)  |
| - Self-Contained Simulated Telemetry Engine (Zero-Hardware Fallback)          |
+-------------------------------------------------------------------------------+
```

### 2.1 The Contract Endpoints (`crates/bforge-core/src/serve.rs`)
1. `GET /api/snapshot`: Delivers a full `UiSnapshot` containing session parameters, configured ports, and active bridges.
2. `GET /api/events`: Continuous Server-Sent Events (SSE) stream publishing:
   - `snapshot`: Periodic full state reconciliations (every 200 ms).
   - `ui`: Individual asynchronous events (`Started`, `Stats`, `PortStateChanged`, `Overrun`, `DamagedTail`, `Stopped`).
   - `frames`: Batched packet frames emitted at 50 ms intervals.
3. `POST /api/send`: Transmits raw hexadecimal payloads or structured values to a hardware port with optional pacing.
4. `POST /api/pins`: Controls hardware line states (DTR, RTS, bootloader pulse sequences).
5. `POST /api/yield`: Surrenders COM port access for $N$ seconds for external firmware flashing.
6. `POST /api/fault`: Arms or disarms active fault injection profiles.

---

## 3. High-Throughput & Zero-Overhead Constraints

At 12 Mbaud, raw UART streams deliver up to 1.2 million characters per second. To preserve smooth 60 FPS workstation interaction, the frontend implements four strict performance boundaries:

1. **Decoupled Acquisition Ring-Buffer:**  
   Incoming SSE frame batches are pushed into a bounded in-memory circular ring buffer (`RingBuffer<PacketRow>`, maximum 20,000 active display rows). React components never re-render on single-byte arrivals.
2. **Batched State Flush:**  
   UI frame counters and throughput gauges update at a throttled interval (100 ms to 200 ms) via requestAnimationFrame.
3. **Table Virtualization:**  
   The central packet stream table renders only the rows currently visible within the viewport height plus a small 5-row overscan buffer.
4. **Canvas-Driven Waveform Plots:**  
   Oscilloscope traces and digital bit rails bypass the React DOM completely. A dedicated Canvas render loop draws telemetry samples using `requestAnimationFrame`, maintaining 60 FPS even during high bus activity.
5. **Timestamp & Offset Precision:**  
   All timestamps preserve nanosecond/microsecond resolution using 64-bit integer strings or numeric bigints.

---

## 4. Hardware-less Simulation Fallback

When BaudForge starts without an attached physical device or when `bforge serve` is running in demo mode:
- The frontend client automatically activates its internal **Simulation Telemetry Driver**.
- The driver generates authentic aerospace IMU telemetry:
  - Structure: Identical to `crates/bforge-dissect/tests/fixtures/imu_packet.h`.
  - Content: Realistic sine/cosine gyro rates, slowly discharging battery millivolts (`v_batt_mv`), monotonic microsecond timestamps, animated mode flags, and computed CRC checksums.
- This guarantees immediate, hands-on user onboarding and automated test verification without requiring hardware access.
