#!/usr/bin/env bash
# Provision a Linux machine as a BaudForge lab box.
#
# Ubuntu 24.04, 4 vCPU, 8 GiB, 20 GiB is the machine this was written for.
# The script is idempotent: run it again after a failure and it continues.
#
#   bash deploy/lab-setup.sh [--no-clone] [--runner-token TOKEN]
#
# It installs build dependencies, the Rust toolchain, Node 22, the Linux desktop
# libraries, and Xvfb for headless screenshots, then clones and builds the workspace
# as a check.

set -euo pipefail

REPO="${REPO:-https://github.com/siyal343/baud-forge.git}"
WORKDIR="${WORKDIR:-$HOME/baud-forge}"
CLONE=1
RUNNER_TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-clone) CLONE=0 ;;
    --runner-token) RUNNER_TOKEN="${2:-}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
free_space() { df -h / | awk 'NR==2 {print $4}'; }

say "before: $(free_space) free on /"

say "build dependencies"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq \
  build-essential pkg-config libudev-dev libssl-dev \
  curl git unzip xz-utils ca-certificates rsync

say "desktop libraries and a virtual display (Tauri on Linux, screenshots)"
sudo apt-get install -y -qq \
  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf \
  xvfb imagemagick

say "rust"
if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustc --version
cargo --version

say "node 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node --version
npm --version

say "swap: a release build of the workspace wants more than 8 GiB peak"
if ! swapon --show | grep -q .; then
  sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "added a 4 GiB swap file"
else
  echo "swap already present"
fi

if [ "$CLONE" = 1 ]; then
  say "repository"
  if [ -d "$WORKDIR/.git" ]; then
    git -C "$WORKDIR" fetch --all --quiet
    git -C "$WORKDIR" reset --hard origin/main --quiet
  else
    git clone --quiet "$REPO" "$WORKDIR"
  fi
  cd "$WORKDIR"

  say "build and test"
  cargo build --workspace --release
  cargo test --workspace
fi

if [ -n "$RUNNER_TOKEN" ]; then
  say "self-hosted runner"
  mkdir -p "$HOME/actions-runner"
  cd "$HOME/actions-runner"
  if [ ! -x ./config.sh ]; then
    curl -fsSL -o runner.tar.gz \
      https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
    tar xzf runner.tar.gz
  fi
  if [ ! -f .runner ]; then
    ./config.sh --url "${REPO%.git}" --token "$RUNNER_TOKEN" \
      --labels self-hosted,linux,lab --unattended --replace
    sudo ./svc.sh install
    sudo ./svc.sh start
  else
    echo "runner is already configured"
  fi
fi

say "after: $(free_space) free on /"
say "done"
cat <<'EOF'

Next, in the repository on the lab box:

  cargo run -p bforge-core --release --example s5_stress -- \
    --ports 4 --seconds 3600 --vault /tmp/soak.bflog

Record the numbers and the conditions in specs/0007-measurement.md, then delete the
vault: 20 GiB is not an archive.
EOF
