# GUI setup on this machine

What the desktop app needs, how to install it, and how to check that it worked.
State measured on 28 October 2026, after the install:

| Item | State |
| --- | --- |
| Windows | 10 Pro, 22H2, build 19045.6466 |
| Visual Studio Build Tools | **installed**, `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`, MSVC 14.51.36231 |
| Windows SDK | 10.0.26100.0 |
| WebView2 runtime | **present**, 156.0.4314.50 |
| Rust toolchain | `stable-x86_64-pc-windows-msvc` installed and **default**, `host: x86_64-pc-windows-msvc` |
| GNU toolchain | `stable-x86_64-pc-windows-gnu`, kept for cross-checks |
| Node / npm | 22.23.2 / 10.9.8 |

A desktop build links and runs:

```text
$ cargo +stable-x86_64-pc-windows-msvc build -p bforge-cli
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 00s
$ ./target/debug/bforge version
bforge 0.1.0
```

## Why MSVC is required

Tauri v2 renders through WebView2 and links it through the `windows` crate, which
ships MSVC import libraries. The GNU toolchain's `ld` cannot read them, and there is
no `cl.exe` without Build Tools. Nothing else in the project needs MSVC: the engine,
the CLI and the tests build with either toolchain.

## One thing still missing: the cargo folder is not on PATH

`rustup.exe` and `cargo.exe` live in `%USERPROFILE%\.cargo\bin`, and that folder is
not on the user PATH, so PowerShell answers `rustup : The term 'rustup' is not
recognized`. Bash sessions in this repository add the folder by hand, which is why
the same command works there.

Fix it once, for the current user:

```powershell
$cargoBin = "$env:USERPROFILE\.cargo\bin"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$cargoBin*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$cargoBin", 'User')
}
$env:Path += ";$cargoBin"
rustup --version
```

New terminals then find `cargo` and `rustup` without the path. Until then, call them
by full path:

```powershell
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build -p bforge-cli
```

## What the install did, for the next machine

1. **Build Tools for Visual Studio 2022** from
   <https://visualstudio.microsoft.com/downloads/> → *Tools for Visual Studio*, with
   one workload: **Desktop development with C++**. The defaults bring MSVC v143+ and
   a Windows SDK. The Windows 11 SDK installs and targets Windows 10 without issue.
2. **WebView2** was already present; Windows 10 gets it from the Edge update channel.
   Check with:
   ```powershell
   Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue | Select-Object pv
   ```
3. **Rust MSVC toolchain**, which this machine already had:
   ```powershell
   rustup toolchain install stable-x86_64-pc-windows-msvc
   ```

No reboot is needed. A new terminal is, because the installer updates environment
variables that open shells keep.

## Checks, in order

```powershell
# 1. the linker exists
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath

# 2. the host target is MSVC
rustc -vV | Select-String host          # host: x86_64-pc-windows-msvc

# 3. a real link happens
cd F:\Datapack\Personal\Programa\baud-forge
cargo build -p bforge-cli
```

All three pass on this machine.

## Next: the GUI itself

1. `bforge serve` publishes the F1.7 snapshot over loopback HTTP and the events as
   server-sent events. Pure Rust, no new dependency, builds with either toolchain.
2. `ui/` gets the SolidJS frontend from `specs/UI-UX-Guide.md`, consuming that
   contract, and runs in Edge with `npm run dev` — hot reload, devtools, fast loop.
3. `bforge-gui` wraps the same files with Tauri; CI builds the installer for the six
   targets.

Step 1 and 2 do not need Tauri at all, which is why the frontend can be developed
here even if the packaged shell is only built in CI.

## Troubleshooting

- **`link.exe not found`** — Build Tools is installed but the shell predates it.
  Open a new terminal. If it persists, run `cargo build` from a *Developer Command
  Prompt* to see whether the install itself is complete.
- **`error: linker link.exe not found`** while `vswhere` finds a path — check that the
  workload *Desktop development with C++* was ticked, not only the installer shell.
- **A Rust build picks the wrong toolchain** — `rustup show` prints the default. Pin
  per command with `cargo +stable-x86_64-pc-windows-msvc …`.
- **The first MSVC build recompiles everything** — the two toolchains share
  `target/` under different fingerprints. That is expected once per switch.
