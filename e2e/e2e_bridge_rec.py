#!/usr/bin/env python3
"""End-to-end verification for the REC and bridge endpoints (spec 2.1 / 2.5).

Software-only: two fake serial devices talk to the engine over TCP transports.
  device A -> 127.0.0.1:9100 (engine tcp-server) sends PING lines
  device B <- 127.0.0.1:9101 (engine tcp-server) receives the bridged lines

Flow: build bforge-cli, start `serve` with the e2e workspace, start the fakes,
drive POST /api/record start/stop, and assert:
  1. the sealed vault parses with the engine's own reader (records > 0)
  2. the bridge forwarded bytes A->B and device B actually received them
  3. the snapshot exposes the live BridgeView counters
No hardware, no browser.
"""

import json
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = Path(sys.argv[1] if len(sys.argv) > 1 else "target/debug/bforge.exe")
WORKSPACE = Path(__file__).parent / "e2e-workspace.toml"
VAULT_REL = f"vaults/e2e-rec-{int(time.time())}.bflog"
BASE = "http://127.0.0.1:7717"

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def get(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=5) as res:
            return json.loads(res.read().decode())
    except Exception as error:
        print(f"  (GET {path} failed: {error})")
        raise


def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  (POST {path} -> HTTP {e.code}: {body})")
        return {"error": body, "http_error": True}
    except Exception as error:
        print(f"  (POST {path} failed: {error})")
        raise


def fake_device_a(stop, sent):
    """Device A: push PING lines into the engine's port A."""
    sock = socket.create_connection(("127.0.0.1", 9100), timeout=5)
    i = 0
    while not stop.is_set() and i < 50:
        try:
            sock.sendall(f"PING-{i:03d}\n".encode())
            sent.append(i)
            i += 1
        except OSError:
            break
        time.sleep(0.15)
    sock.close()


def fake_device_b(stop, received):
    """Device B: read whatever the engine forwards out of port B."""
    sock = socket.create_connection(("127.0.0.1", 9101), timeout=5)
    sock.settimeout(0.5)
    buf = b""
    while not stop.is_set():
        try:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            received.extend(buf.split(b"\n")[:-1])
            buf = buf.rsplit(b"\n", 1)[-1]
        except socket.timeout:
            continue
        except OSError:
            break
    sock.close()


def main():
    if not ENGINE.exists():
        print(f"engine missing: {ENGINE} — run cargo build -p bforge-cli first")
        return 2

    engine = subprocess.Popen(
        [str(ENGINE), "serve", "-c", str(WORKSPACE), "--duration", "90s"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=open(ROOT / "e2e" / "engine.log", "w"),
    )
    stop = threading.Event()
    sent, received = [], []
    try:
        # Wait for the engine to come up.
        up = False
        for _ in range(50):
            try:
                get("/api/health")
                up = True
                break
            except Exception:
                time.sleep(0.2)
        check("engine serves /api/health", up)
        if not up:
            return 1

        threads = [
            threading.Thread(target=fake_device_a, args=(stop, sent), daemon=True),
            threading.Thread(target=fake_device_b, args=(stop, received), daemon=True),
        ]
        for t in threads:
            t.start()
        time.sleep(1.5)  # let frames flow before recording

        # --- REC: start -> bytes accumulate -> stop -> vault parses ---
        started = post("/api/record", {"action": "start", "path": VAULT_REL})
        check("record start returns the vault path", started.get("recording") is True and started.get("vault", "").endswith(".bflog"), json.dumps(started))

        time.sleep(3.0)
        snapshot = get("/api/snapshot")
        session = snapshot.get("session", {})
        check(
            "snapshot reports live recording with growing vault",
            session.get("mode") == "record" and session.get("vault", "").endswith(".bflog") and session.get("file_bytes", 0) > 0,
            f"mode={session.get('mode')} bytes={session.get('file_bytes')}",
        )

        stopped = post("/api/record", {"action": "stop"})
        check("record stop seals the vault", stopped.get("recording") is False, json.dumps(stopped))

        vault_info = get("/api/vault?path=" + VAULT_REL)
        check("sealed vault parses via engine reader (records > 0)", vault_info.get("records", 0) > 0, json.dumps(vault_info))

        # Double-stop is an honest error, not a crash.
        again = post("/api/record", {"action": "stop"})
        check("double stop reports NotRecording", "error" in again, json.dumps(again))

        # --- Bridge: bytes forwarded A->B with live counters ---
        time.sleep(2.5)  # let the bridge forward while fakes run
        snapshot = get("/api/snapshot")
        bridges = snapshot.get("bridges", [])
        bridge = next((b for b in bridges if b.get("a") == "devA" and b.get("b") == "devB"), None)
        check("snapshot carries the configured bridge", bridge is not None, json.dumps(bridges)[:120])
        check("bridge forwarded bytes A->B", bool(bridge) and bridge.get("forwarded", 0) > 0, json.dumps(bridge))
        check("device B received bridged lines", len(received) > 0, f"{len(received)} lines, first={received[0] if received else b''!r}")

        stop.set()
        for t in threads:
            t.join(timeout=3)
        return 0 if not failures else 1
    finally:
        stop.set()
        engine.terminate()
        try:
            engine.wait(timeout=5)
        except subprocess.TimeoutExpired:
            engine.kill()


if __name__ == "__main__":
    sys.exit(main())
