# Signing the release

What a signed binary buys, what it costs, and how to turn it on. Nothing here is done
yet: this repository publishes **unsigned** binaries plus a checksum file, because a
certificate is a purchase only the project owner can make.

## What is already in place

| Item | State |
| --- | --- |
| `SHA256SUMS.txt` on every release | **done** — `publish` writes it from the files it uploads |
| Windows signing hook | **ready** — runs only when `WINDOWS_CERTIFICATE` is set |
| macOS signing hook | **ready** — runs only when `MACOS_CERTIFICATE` is set |
| Installer signing | **ready** — same hook in the `desktop` job |
| Certificate | **not bought** |

A reader can verify a download today:

```sh
sha256sum -c SHA256SUMS.txt
```

or, on Windows:

```powershell
Get-FileHash .\BaudForge_0.5.1_x64-setup.exe -Algorithm SHA256
```

## What signing changes

An unsigned `.exe` shows *"Windows protected your PC"* — SmartScreen — until it collects
enough reputation. A signed binary shows the publisher's name, and an EV certificate skips
the reputation wait. That warning is the whole reason to buy one.

## The three routes

| Route | Cost, estimate | Notes |
| --- | --- | --- |
| OV certificate from a CA (DigiCert, Sectigo, SSL.com) | ~200–400 USD per year | Signing a `.pfx` in CI; SmartScreen reputation builds over time |
| EV certificate | ~400–700 USD per year | Hardware token or cloud HSM; immediate SmartScreen trust |
| Azure Trusted Signing | ~10 USD per month, identity-verified | Cloud signing; a GitHub Action signs without a `.pfx` |
| SignPath.io for open source | free for OSS projects | Requires an application and a public repository |

The `.pfx` route is the least work for this repository, because the workflow already knows
how to use one.

## Turning it on

1. Buy a certificate and export it as a `.pfx` with a password.
2. Base64 the file:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("baudforge.pfx")) | Set-Clipboard
   ```

3. Add repository secrets:

   | Secret | Content |
   | --- | --- |
   | `WINDOWS_CERTIFICATE` | the base64 string above |
   | `WINDOWS_CERTIFICATE_PASSWORD` | the `.pfx` password |
   | `MACOS_CERTIFICATE` | base64 Developer ID `.p12`, if macOS signing is wanted |
   | `MACOS_CERTIFICATE_PASSWORD` | its password |
   | `MACOS_IDENTITY` | for example `Developer ID Application: Your Name (TEAMID)` |

4. Push a tag. The signing steps run; with the secrets absent they are skipped, which is
   why the release pipeline has stayed green without a certificate.

5. Verify on a Windows machine:

   ```powershell
   Get-AuthenticodeSignature .\bforge-windows-x86_64.exe | Format-List Status,SignerCertificate
   ```

   `Status: Valid` and a signer name is what a buyer expects.

## What signing does not fix

- macOS **notarisation** is a second step (`notarytool` and an Apple ID); unsigned macOS
  binaries are also blocked by Gatekeeper, and a Developer ID alone is not enough.
- Linux has no equivalent warning; a checksum and a package repository are the norm.
- A signed binary is still a binary. Signing says *who built it*, not that it is safe.

## Why this is the last step, not an early one

Every other improvement in this project changes what the tool does. This one changes what a
stranger's operating system says about it, and it costs money every year. It is worth doing
once the surface stops moving — which, after 0.5.0, it has.
