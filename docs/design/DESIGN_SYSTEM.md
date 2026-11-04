# BaudForge Design System Specification

Document Version: 1.0.0  
Status: Authoritative Design Standard  
Target Platform: Desktop Engineering Workstation (Windows, macOS, Linux)  
References: `docs/UI-UX-DESIGNER-HANDOVER.md`, `specs/ADR & SRS.md`

---

## 1. Design Direction & Purpose

BaudForge is a professional engineering instrument. It serves embedded firmware engineers, aerospace test engineers, and hardware validation teams.
It provides high data density, sub-microsecond timing accuracy, and visual clarity.

### Core Visual Principles
1. **High Information Density Without Visual Clutter:**  
   Every pixel serves a functional purpose. We avoid decorative whitespace, oversized card paddings, and arbitrary rounded cards.
2. **Monospaced Data Precision:**  
   All hexadecimal values, memory addresses, timestamps, delta measurements, register flags, and packet payloads use monospaced fonts with tabular numbers (`tabular-nums`).
3. **Rigid Dimensional Alignment:**  
   The interface follows a compact 4px baseline grid. Borders are exactly 1px solid. Heights of table rows, toolbars, and tab headers are fixed to prevent layout shifts.
4. **State-Rich Semantic Color Vocabulary:**  
   Colors communicate hardware link status, fault conditions, and cross-panel correlations. Inactive structural surfaces stay neutral.
5. **Keyboard-First Engineering Flow:**  
   All primary actions provide single-stroke or standard workstation shortcuts (e.g. `/` for search, `Space` for DVR pause, `Ctrl+Shift+Y` for Flash Yield).

---

## 2. Color Palette & Semantic Tokens

BaudForge uses a dedicated dark instrument palette as its primary operational theme. It is optimized for laboratory environments, low-light test benches, and continuous multi-hour monitoring.

### 2.1 Surface & Neutral Tokens
| Token Name | CSS Variable | Hex Value | Usage Description |
| :--- | :--- | :--- | :--- |
| `surface-canvas` | `--bf-canvas` | `#0A0D13` | Deepest workstation canvas background |
| `surface-panel` | `--bf-panel` | `#10141D` | Standard dock panels, sidebars, toolbars |
| `surface-subpanel` | `--bf-subpanel` | `#161C28` | Inner containers, table headers, inactive tabs |
| `surface-hover` | `--bf-hover` | `#1E2638` | Hover state for rows, buttons, menu items |
| `surface-active` | `--bf-active` | `#26324A` | Active tab selection, pressed button states |
| `border-subtle` | `--bf-border-subtle` | `#1A2230` | Internal row dividers, subtle graticule lines |
| `border-strong` | `--bf-border-strong` | `#2D3A4E` | Panel boundaries, dock dividers, active inputs |

### 2.2 Foreground & Typography Tokens
| Token Name | CSS Variable | Hex Value | Usage Description |
| :--- | :--- | :--- | :--- |
| `text-primary` | `--bf-text-primary` | `#E2E8F0` | Primary numbers, field values, high-contrast labels |
| `text-secondary` | `--bf-text-secondary`| `#94A3B8` | Structural labels, table column headers, units |
| `text-muted` | `--bf-text-muted` | `#64748B` | Inactive hints, microsecond units, disabled text |
| `text-inverse` | `--bf-text-inverse` | `#0A0D13` | Text placed over high-contrast accent chips |

### 2.3 Semantic Instrument & Status Tokens
| Token Name | CSS Variable | Hex Value | Semantic Role |
| :--- | :--- | :--- | :--- |
| `status-ok` | `--bf-status-ok` | `#10B981` | Hardware connected, valid CRC, healthy bus, normal link |
| `status-warn` | `--bf-status-warn` | `#F59E0B` | Reconnecting link, framing errors, buffer pressure, warning alert |
| `status-fault` | `--bf-status-fault` | `#EF4444` | CRC mismatch, parity fault, active fault injection, missing packet |
| `accent-cyan` | `--bf-accent-cyan` | `#00E5FF` | Active inspection cursor, hex cross-highlight, primary crosshair |
| `accent-amber` | `--bf-accent-amber`| `#FBBF24` | Secondary scope cursor ($T_2$), flash yield countdown banner |
| `accent-purple`| `--bf-accent-purple`| `#A855F7` | MITM bridge forwarding, paired bus telemetry indicator |
| `direction-rx` | `--bf-direction-rx` | `#10B981` | Ingested packet badge (Emerald `#10B981`) |
| `direction-tx` | `--bf-direction-tx` | `#38BDF8` | Transmitted packet badge (Sky `#38BDF8`) |
| `direction-bridge`| `--bf-direction-bridge`| `#F59E0B` | Bridged A<->B packet badge (Amber `#F59E0B`) |

---

## 3. Typography System

The typography system separates textual data representation from interface navigation.

### 3.1 Font Families
- **Monospace Family (Technical Data):**  
  `"JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace`  
  Applied to: Hex dumps, packet tables, relative timestamps ($\Delta t$), byte offsets, CRC readouts, baud rates, register flags, and backtraces.
- **UI Sans Family (Controls & Navigation):**  
  `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`  
  Applied to: Application menus, modal dialogs, tab headers, parameter labels, tooltips, and status captions.

### 3.2 Type Scale
| Level | Font Size | Line Height | Font Weight | Family | Typical Usage |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `micro` | 10px (`0.625rem`) | 12px | 500 / 600 | Monospace | Status LED labels, bit indices, unit captions |
| `compact` | 11px (`0.6875rem`)| 14px | 400 / 500 | Mono / Sans| Table headers, secondary readouts, tree offsets |
| `body` | 12px (`0.75rem`) | 16px | 400 / 500 | Mono / Sans| Standard data rows, hex dump, property values |
| `label` | 13px (`0.8125rem`)| 18px | 500 / 600 | Sans | Ribbon controls, input fields, tab titles |
| `title` | 14px (`0.875rem`) | 20px | 600 | Sans | Panel titles, modal dialog headers |
| `headline`| 16px (`1.0rem`) | 22px | 700 | Sans | Application title, critical alarm headers |

All monospace numerical displays must enforce `font-variant-numeric: tabular-nums lining-nums`.

---

## 4. Spacing, Geometry & Grid

BaudForge enforces a rigid 4px spatial rhythm:
- Spacing Scale: `4px`, `8px`, `12px`, `16px`, `24px`.
- Dense Workstation Row Height: Fixed at `24px` for virtualized packet rows.
- Table Header Height: Fixed at `28px`.
- Primary Ribbon Toolbar Height: Fixed at `42px`.
- Dock Tab Header Height: Fixed at `30px`.
- Global Status Footer Height: Fixed at `26px`.
- Corner Radius:
  - Chips & Badges: `3px`
  - Input Fields & Buttons: `4px`
  - Floating Overlays & Dialogs: `6px`
  - Outer Window Bounds: `0px` (desktop native frame)

---

## 5. Component Conventions

### 5.1 Ribbon Toolbar Controls
- **Segmented Chips:** Quick-fill baud selectors (`9600`, `115.2k`, `921.6k`, `12.0M`) display active selection with `--bf-active` and a 1px cyan highlight.
- **Hardware Port Selector:** Displays port identity, detected USB VID:PID, and link state.
- **Master Action Button:** High-contrast emerald button for `Connect Device`; switches to crimson outline for `Disconnect`.
- **Flash Yield Pill:** Amber warning indicator showing countdown timer and immediate reclaim action.

### 5.2 Hex & ASCII Viewer Grid
- 16 bytes per row with 4-byte grouped gutters.
- Byte offset displayed in monospace hexadecimal (`00000000`, `00000010`).
- Cross-highlight: When user hovers or selects a field in the protocol tree, the constituent byte cells illuminate with `--bf-accent-cyan` background and high-contrast border.
- Non-printable ASCII characters render as subtle dots (`.`) to prevent layout disturbance.

### 5.3 Protocol Dissector Tree
- Indented collapsible tree nodes displaying field name, data type, raw bytes, decoded value, and engineering units.
- CRC Status Badge: Emerald pill `CRC VALID ✓` or Crimson pill `CRC MISMATCH ⚠ [Exp: 0x9F2A, Got: 0x9F2B]`.

### 5.4 Oscilloscope & Logic Rails
- Continuous vector waveform rendered at 60 FPS via HTML5 Canvas.
- Grid: Subtle dashed graticule lines with horizontal time tick labels ($10\ \mu\text{s}$, $1\text{ ms}$, $10\text{ ms}$).
- Measurement Cursors:
  - $T_1$: Vertical cyan dashed crosshair line.
  - $T_2$: Vertical amber dashed crosshair line.
  - Floating HUD: Displays $\Delta t = T_2 - T_1$, frequency $f = 1/\Delta t$, and amplitude delta $\Delta V$.
- Waveform click synchronizes packet table and hex dump to that exact microsecond timestamp.

### 5.5 Fault Injection Safety Interlock
- Armed state triggers an unmistakable persistent red-striped indicator across the top header.
- A high-visibility `Disarm All Faults` button remains permanently visible.

---

## 6. Accessibility & Keyboard Navigation

- **Focus Indication:** Visible 2px outline in `--bf-accent-cyan` with 2px offset.
- **Color Contrast:** All text meets or exceeds WCAG AA (minimum 4.5:1 ratio against background). Data values in primary text reach > 10:1 contrast ratio.
- **Keyboard Shortcuts:**
  - `/`: Focus global stream search.
  - `Space`: Pause / Resume DVR playback.
  - `Left Arrow` / `Right Arrow`: Step one frame backward / forward in historical buffer.
  - `Ctrl+Shift+Y`: Trigger Flash-Yield.
  - `Ctrl+L`: Clear terminal view.
  - `Escape`: Cancel selection or dismiss modal overlay.
