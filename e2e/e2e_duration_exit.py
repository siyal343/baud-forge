#!/usr/bin/env python3
"""Regression: tcp-server transports must not wedge the engine.

Two quirks shared one root cause — the HAL parked a thread inside a blocking
accept():
  1. `--duration` never fired: shutdown joined the parked reader and hung, so
     the process lived forever past its own deadline.
  2. A tcp-server port accepted exactly ONE connection per session.

This driver asserts both are gone: the engine exits on its own with no device
connected, and a device may drop and reconnect on the same port.
"""

import json
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = Path(sys.argv[1] if len(sys.argv) > 1 else "target/debug/bforge.exe")
WORKSPACE = Path(__file__).parent / "e2e-workspace.toml"
BASE = "http://127.0.0.1:7717"

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def get(path):
    # The host aborts loopback connections transiently; retry, don't flake.
    last = None
    for _ in range(4):
        try:
            with urllib.request.urlopen(BASE + path, timeout=5) as res:
                return json.loads(res.read().decode())
        except Exception as error:
            last = error
            time.sleep(0.3)
    raise last


def wait_up(timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            get("/api/health")
            return True
        except Exception:
            time.sleep(0.2)
    return False


def start_engine(duration):
    return subprocess.Popen(
        [str(ENGINE), "serve", "-c", str(WORKSPACE), "--duration", duration],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_exit(process, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            return True
        time.sleep(0.25)
    return False


def main():
    if not ENGINE.exists():
        print(f"engine missing: {ENGINE}")
        return 2

    # ---- 1. duration expiry with NO device connected -----------------------
    engine = start_engine("3s")
    try:
        check("engine up", wait_up())
        # The engine must end by itself; before the fix it hung in shutdown.
        exited = wait_exit(engine, timeout=20)
        check(
            "engine exits at --duration with no device connected",
            exited,
            f"exit code {engine.poll()}" if exited else "still running after 20 s",
        )
        if not exited:
            engine.kill()
    finally:
        if engine.poll() is None:
            engine.kill()

    # ---- 2. a device may drop and reconnect on the same port ---------------
    engine = start_engine("1h")
    try:
        check("engine up for reconnect test", wait_up())
        time.sleep(1.0)  # the reader binds its listener

        # First device: deliver a frame, then vanish.
        sock = socket.create_connection(("127.0.0.1", 9100), timeout=5)
        sock.sendall(b"DROP-TEST-1\n")
        time.sleep(0.3)
        sock.close()
        time.sleep(0.5)  # the reader notices the drop

        # Second device, same port: must be accepted again.
        sock2 = socket.create_connection(("127.0.0.1", 9100), timeout=5)
        sock2.sendall(b"DROP-TEST-2\n")
        time.sleep(0.5)
        sock2.close()

        deadline = time.time() + 8
        snapshot = {}
        while time.time() < deadline:
            snapshot = get("/api/snapshot")
            port = next((p for p in snapshot["ports"] if p["id"] == "devA"), {})
            if port.get("chunks", 0) >= 2:
                break
            time.sleep(0.3)
        port = next((p for p in snapshot.get("ports", []) if p["id"] == "devA"), {})
        check(
            "device reconnects on the same tcp-server port",
            port.get("chunks", 0) >= 2,
            f"chunks={port.get('chunks', 0)} state={port.get('state')}",
        )
    finally:
        engine.terminate()
        try:
            engine.wait(timeout=5)
        except subprocess.TimeoutExpired:
            engine.kill()

    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
