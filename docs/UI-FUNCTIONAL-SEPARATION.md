# Separation of UI and Business Logic in BaudForge

Date: 2026-11-03  
Document: Architecture & Integration Explainer

---

## 1. Architectural Answer

**Yes. The user interface (UI) and the functional logic are completely separate.**

BaudForge uses a modular architecture. The core functional engines do not contain graphical code.

```
                      +-----------------------------+
                      |       USER INTERFACES       |
                      |  • bforge-gui (Native egui) |
                      |  • bforge-cli (Terminal)    |
                      +--------------+--------------+
                                     |
                                     v  (Thread Channels / Function Calls)
                      +--------------+--------------+
                      |        bforge-core          |
                      |   Orchestration & State     |
                      +--------------+--------------+
                                     |
    +-----------------+--------------+-----------------+-----------------+
    |                 |                                |                 |
    v                 v                                v                 v
[bforge-hal]   [bforge-dissect]                 [bforge-framer]   [bforge-storage]
UART / CAN /   C-Structs / Protobuf /           COBS / Delimiter  Append-only
RTT Transports CCSDS Protocol Engines           CRC Decoders      .bflog Session Vault
```

---

## 2. Evidence from the Codebase

1. **Headless Core Libraries:**
   * `bforge-hal`: Handles serial ports, baud rates, and hardware lines.
   * `bforge-dissect`: Decodes raw binary packets into typed fields.
   * `bforge-framer`: Extracts packets using COBS or delimiter bytes.
   * `bforge-storage`: Writes `.bflog` session files to disk.
   * These crates do not import graphics libraries (`eframe`, `egui`, `wgpu`).

2. **Decoupled GUI Crate (`bforge-gui`):**
   * Functional workers run on background threads (`SessionController`, `HardwareScanner`).
   * Workers exchange data with the UI through message channels (`crossbeam_channel`).
   * The UI only renders current state data and sends user commands (`TabAction`).

---

## 3. How to Work with a UI Designer

A UI designer can build or refine the interface for your application. The collaboration method depends on the role of the designer.

### Scenario A: Visual / UX Designer (Figma / Adobe XD / Penpot)
* **What they do:** They create visual layouts, color themes, spacing systems, and user flows.
* **What you give them:**
  1. Functional specification: List of inputs (e.g. port, baud), outputs (e.g. packet rates, wave plots), and error states.
  2. Wireframes and screenshots of the current application.
* **What they provide:** A Figma project with exact pixel dimensions, typography, and color tokens.
* **Implementation:** A software engineer (or agent) writes the `egui` code in `crates/bforge-gui/src/tabs/` to match the Figma design.

### Scenario B: Rust GUI Developer (`egui` / Slint)
* **What they do:** They write desktop interface code directly in Rust.
* **What you give them:** The `crates/bforge-gui` repository.
* **What they edit:** Only files in `crates/bforge-gui/src/tabs/` and `crates/bforge-gui/src/theme.rs`.
* **Advantage:** They do not need to understand serial framing or packet decoders. They connect buttons to existing `SessionController` commands.

### Scenario C: Web Frontend Developer (HTML / CSS / React)
* **What they do:** They build web-based interfaces.
* **Integration path:**
  * BaudForge previously used Tauri v2 (archived in `crates/bforge-gui-legacy`).
  * If a web frontend is preferred, a lightweight IPC or local WebSocket bridge can expose the core functions.

---

## 4. Recommended Next Steps

1. Identify the workflow of your designer (Figma visual design vs. direct code implementation).
2. Use the existing panels in `crates/bforge-gui` as the functional reference model.
3. Keep business logic strictly inside `bforge-core` and background threads to prevent UI lockups.
