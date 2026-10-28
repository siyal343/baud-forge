# The VPS lab

A 4 vCPU / 8 GiB / 20 GiB Linux machine can do work this workstation cannot. It
cannot do everything, and knowing which is which is the point of this page.

## What it is good for

| Job | Why the VPS helps | Existing gap |
| --- | --- | --- |
| **Long ingest soak** — 4 ports at 1.2 MB/s for an hour, 4.3 GB vault | Headless, unattended, 8 GiB for the RSS ceiling, and the disk only has to hold one run | `specs/0007` measured 60 seconds; the nightly workflow measures 600 |
| **Memory harness at scale** — 4 GiB vault, full read | Real Linux `/proc/self/status` numbers, not a cross-compiled branch | `specs/0007` measured 512 MiB |
| **Linux end-to-end checks** — `record`, `tail`, `assert` over the TCP simulator, the yield socket, `libudev` enumeration | The Linux code paths run for real instead of under a Windows test | the Linux branches were verified only by CI's test run |
| **Linux desktop build** — `.deb` and AppImage, screenshotted under Xvfb | Tauri on Linux needs no MSVC, so the GUI can be built and *seen* here without touching this workstation | Phase 2 is blocked locally (see `GUI-SETUP.md`) |

## What it cannot do

| Not this | Why |
| --- | --- |
| 12 Mbaud on a real UART | No serial port and no USB on a VPS. That needs a bridge on this desk (D-10). |
| Windows GUI iteration | The MSVC problem is local. CI or this workstation has to solve it. |
| A 100 GB session | 20 GiB of disk. The ceiling claim stays derived (D-14). |
| Hotplug, yield-with-a-flasher, pins at 1 kHz | All need the board, which is here (D-06, D-08, D-09). |

## Provisioning

Ubuntu 24.04, one idempotent script, about six minutes and 6 GiB:

```sh
ssh <user>@<vps>
curl -fsSL https://raw.githubusercontent.com/siyal343/baud-forge/main/deploy/lab-setup.sh -o lab-setup.sh
bash lab-setup.sh
```

The script installs the build dependencies, the Rust toolchain, Node 22, the Linux
desktop libraries, `Xvfb`, and then clones and builds the workspace as a check. It
prints the free space before and after, because 20 GiB is not much.

Then the first soak:

```sh
cd ~/baud-forge
cargo run -p bforge-core --release --example s5_stress -- --ports 4 --seconds 3600 --vault /tmp/soak.bflog
```

Expect about 4.3 GB in `/tmp`. Delete it when the numbers are recorded; the VPS is
not an archive.

## Continuous use: a self-hosted runner

A runner makes the VPS part of CI. The repository is public, so two rules are not
optional:

1. **Never let a pull request run on it.** A fork can change `build.rs` and read
   every secret the runner holds. Configure the job to run only on `schedule` and
   `workflow_dispatch`, on `main`.
2. **Give it no secrets beyond the ones a job needs.** The runner token is the only
   credential, and it is read-only for this repository.

```sh
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSL -o runner.tar.gz https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
tar xzf runner.tar.gz
./config.sh --url https://github.com/siyal343/baud-forge --token "$RUNNER_TOKEN" \
  --labels self-hosted,linux,lab --unattended
sudo ./svc.sh install && sudo ./svc.sh start
```

`RUNNER_TOKEN` comes from *Settings → Actions → Runners → New self-hosted runner*.
The workflow then names it:

```yaml
  soak:
    runs-on: [self-hosted, linux, lab]
    if: github.event_name != 'pull_request'
```

## What to record

Numbers go into `specs/0007-measurement.md`, with the run conditions, and the ledger
entry closes only when the number is there. A run without its conditions written
down is not evidence.
