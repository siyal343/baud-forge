# GUI setup on this machine

What the desktop app needs, how to install it, and how to check that it worked.
Written for the machine this project is developed on: Windows, no Visual Studio, a
GNU Rust toolchain, Node 22 already present.

## Why anything is needed

Tauri v2 renders through WebView2 and links it through the `windows` crate. That
crate ships MSVC import libraries, so the linker must be `link.exe` from Visual
Studio Build Tools. The toolchain here is `stable-x86_64-pc-windows-gnu`, whose
`ld` cannot consume those files, and there is no `cl.exe` at all. So:

```text
error: linking with `link.exe` failed
error: could not compile `webview2-com-sys`
```

That is the whole reason the GUI waits. Nothing else in the project needs MSVC.

## 1. Visual Studio Build Tools 2022

Download: <https://visualstudio.microsoft.com/downloads/> → *Tools for Visual
Studio* → **Build Tools for Visual Studio 2022**.

In the installer, tick exactly one workload:

- **Desktop development with C++**

Under *Installation details*, keep the defaults, which include:

- MSVC v143 build tools (x64/x86)
- Windows 11 SDK
- C++ CMake tools for Windows (not required, harmless)

Do not install the full IDE. The Build Tools download is about 2.5 GB and uses
about 7 GB on disk. A reboot is not needed; a **new terminal** is, because the
installer updates `PATH` and the `VS*` environment variables.

Check it:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
```

That must print a path ending in `BuildTools`. If it prints nothing, the C++
workload did not install.

## 2. WebView2 runtime

Windows 11 ships it. Check:

```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue | Select-Object pv
```

A version means it is there. If not, install the *Evergreen Bootstrapper* from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

## 3. The MSVC Rust toolchain

The GNU toolchain stays; the MSVC one is added beside it and used per command.

```powershell
rustup toolchain install stable-x86_64-pc-windows-msvc
rustup component add rustfmt clippy --toolchain stable-x86_64-pc-windows-msvc
```

Check the linker works, from a **new** terminal:

```powershell
cd F:\Datapack\Personal\Programa\baud-forge
cargo +stable-x86_64-pc-windows-msvc build -p bforge-cli
```

A green build means MSVC is wired up. If it still says `link.exe` not found, the
terminal was open before the installer finished: close it and try again.

## 4. Node and the Tauri CLI

Node 22.23.2 and npm 10.9.8 are already installed.

```powershell
cd F:\Datapack\Personal\Programa\baud-forge
npm install -g @tauri-apps/cli@^2
npx tauri --version
```

The global install is optional: `npm run tauri` from `ui/` works without it once the
frontend exists.

## 5. Check the whole toolchain

```powershell
cargo +stable-x86_64-pc-windows-msvc --version
rustc +stable-x86_64-pc-windows-msvc -vV | Select-String host
```

`host: x86_64-pc-windows-msvc` is what we need.

## What changes in the project afterwards

- CI keeps building with the default toolchain on the runners; nothing in the
  workflow changes.
- Local commands gain the toolchain pin, for example
  `cargo +stable-x86_64-pc-windows-msvc test --workspace`.
- The GNU toolchain stays the default, so existing scripts keep working. The one
  difference that matters: the MSVC build puts its artefacts in the same `target/`
  directory under a different fingerprint, so the first build after switching is a
  full rebuild.

## When it is done

Tell me, and the next step is `bforge serve` plus the frontend:

1. `bforge serve` publishes the existing F1.7 snapshot over loopback HTTP and the
   event stream as server-sent events. It is pure Rust and builds with either
   toolchain.
2. `ui/` gets the SolidJS app from the UI guide, consuming that contract, and runs
   in Edge with `npm run dev` — a fast loop with hot reload.
3. `bforge-gui` wraps the same files with Tauri, and CI builds the installer.

If the install turns out to be impossible, the fallback is CI-only: a job on
`windows-latest` builds the Tauri app and publishes the installer as an artefact.
That works, but every change costs a five to ten minute round trip and there is no
debugger, which is why the local install is worth the download.
