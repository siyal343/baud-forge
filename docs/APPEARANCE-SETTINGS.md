# BaudForge Appearance & Settings Subsystem Report

This document records the design and implementation of the BaudForge Appearance, Theme, Column Configuration, and Command Router subsystems.

## 1. Implemented Components

### 1.1 Settings Persistence Engine (`ui/src/lib/settings.ts`)
- Manages application configuration in browser `localStorage` using key `baudforge:settings:v1`.
- Sanitizes incoming JSON to guarantee complete type safety and valid fallback defaults.
- Implements:
  - `loadSettings()`: Reads stored settings and validates all attributes.
  - `saveSettings(settings)`: Saves active configuration and broadcasts window update events.
  - `exportSettingsJson()`: Serializes current configuration to formatted JSON string.
  - `importSettingsJson(json)`: Validates and applies configuration from external JSON.
  - `resetToDefaults()`: Restores factory defaults safely.

### 1.2 Theme & Density Controller (`ui/src/lib/theme.ts`)
- Dynamically controls visual classes on `document.documentElement`:
  - Theme classes: `theme-carbon-dark`, `theme-paper-light`, `theme-high-contrast`.
  - Density classes: `density-compact`, `density-default`, `density-spacious`.
  - Accent attributes: `data-accent="cyan | green | amber | purple"`.
- Sets `--font-ui-size`, `--row-height`, and `--table-font-size` dynamically via CSS properties.
- Exposes reactive SolidJS signals (`currentTheme`, `currentDensity`, `currentAccent`, `currentFontSize`).

### 1.3 Design System & Theme Tokens (`ui/src/index.css`)
- Defines color tokens for `carbon-dark` (default phosphor ground), `paper-light` (high-illumination lab), and `high-contrast` (WCAG AAA compliant pure yellow on obsidian).
- Implements row density tiers:
  - Compact: 22 px height, 11 px font size.
  - Default: 26 px height, 12 px font size.
  - Spacious: 32 px height, 13 px font size.
- Updates virtualizer stream row rules to bind directly to `--row-height`.

### 1.4 Configurable Stream Columns (`ui/src/lib/columns.ts`)
- Registry with 11 standard stream columns:
  - `index` (#, 56 px, fixed)
  - `time` (Timestamp, 96 px)
  - `port` (Port, 72 px)
  - `dir` (Direction, 52 px)
  - `kind` (Kind, 64 px)
  - `delta` (Δ Time, 72 px, default hidden)
  - `payload` (Length, 56 px)
  - `hex` (Hex Dump, 240 px)
  - `ascii` (ASCII Text, 160 px)
  - `protocol` (Protocol, 80 px)
  - `symbol` (DWARF Symbol, 140 px, default hidden)
- Exposes `toggleColumnVisibility`, `resizeColumn`, `reorderColumns`, `moveColumnUp`, and `moveColumnDown`.

### 1.5 Centralized Command Router (`ui/src/lib/commands.ts`)
- Central registry mapping command IDs to shortcut combinations.
- Global keydown listener matches event combos against current keybindings.
- Protects form inputs by ignoring key events inside `<input>`, `<textarea>`, and `contenteditable` (except `Esc` and `Ctrl+*`).
- Supports live rebind recording and execution dispatching.

### 1.6 Settings Modal Component (`ui/src/components/SettingsModal.tsx`)
- Four dedicated tabs:
  1. **Appearance**: Theme cards with mini-table swatches, density tier cards, font size slider, accent selector.
  2. **Stream Columns**: Column visibility toggles, width adjustment steppers, and reorder controls.
  3. **Shortcuts**: Categorized table with keybinding badges and interactive rebind recorder.
  4. **Presets & Backup**: Preset cards, JSON export download, JSON import picker/paste, and factory reset.

## 2. Verification

- Ran `npm --prefix ui run build` (`tsc -b && vite build`).
- Zero compilation errors.
- Zero runtime dependencies beyond `solid-js`.
