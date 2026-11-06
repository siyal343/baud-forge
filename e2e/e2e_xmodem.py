#!/usr/bin/env python3
"""End-to-end X/YMODEM verification (spec 2.7): a real XMODEM-CRC conversation
between a fake device and the engine's state machine, both directions.

RECV: device sends 3 blocks + EOT after the engine polls 'C'; assert done +
drained bytes match. SEND: device polls 'C', validates the engine's blocks
(number, complement, CRC-16/XMODEM), ACKs; assert completion.
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

SOH, STX, EOT, ACK, NAK, CAN, CRC_CH = 0x01, 0x02, 0x04, 0x06, 0x15, 0x18, 0x43
SMALL = 128


def crc_xmodem(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def get(path):
    # The host aborts loopback connections transiently (WinError 10053/10054);
    # a retry absorbs it without masking real failures, which still raise.
    last = None
    for _ in range(4):
        try:
            with urllib.request.urlopen(BASE + path, timeout=5) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError:
            raise
        except Exception as error:
            last = error
            time.sleep(0.3)
    print(f"  (GET {path} failed after retries: {last})")
    raise last


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    last = None
    for _ in range(4):
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            return {"error": e.read().decode(), "http": e.code}
        except Exception as error:
            last = error
            time.sleep(0.3)
    return {"error": f"unreachable after retries: {last}", "http_error": True}


def post_raw(path, body: bytes):
    req = urllib.request.Request(BASE + path, data=body, headers={"Content-Type": "application/octet-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode())


def get_raw(path) -> bytes:
    with urllib.request.urlopen(BASE + path, timeout=10) as res:
        return res.read()


failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def sock_read_line_c(sock, timeout=5.0):
    """Read engine bytes until we see a 'C' poll (or NAK)."""
    sock.settimeout(timeout)
    deadline = time.time() + timeout
    buf = b""
    while time.time() < deadline:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            continue
        if not chunk:
            break
        buf += chunk
        if CRC_CH in buf or NAK in buf:
            return buf
    return buf


def main():
    if not ENGINE.exists():
        print(f"engine missing: {ENGINE}")
        return 2
    engine = subprocess.Popen(
        [str(ENGINE), "serve", "-c", str(WORKSPACE), "--duration", "1h"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=open(Path(__file__).parent / "engine-xfer.log", "w"),
    )
    try:
        up = False
        for _ in range(50):
            try:
                get("/api/health")
                up = True
                break
            except Exception:
                time.sleep(0.2)
        check("engine up", up)
        if not up:
            return 1

        file = bytes((i * 7 + 3) % 256 for i in range(300))  # 3 blocks

        # ---------- RECV: device -> engine ----------
        arm = post("/api/transfer", {"action": "arm", "port": "devA", "direction": "recv", "mode": "crc128", "name": "fw.bin", "size": len(file)})
        check("recv arm accepted", arm.get("ok") is True, json.dumps(arm))

        sock = socket.create_connection(("127.0.0.1", 9100), timeout=5)
        sock.settimeout(3.0)
        # Device waits for the 'C' poll.
        buf = b""
        deadline = time.time() + 8
        while CRC_CH not in buf and time.time() < deadline:
            try:
                buf += sock.recv(4096)
            except socket.timeout:
                pass
        check("engine polls 'C' in CRC mode", CRC_CH in buf, repr(buf[:8]))

        for number in 1, 2, 3:
            start = (number - 1) * SMALL
            body = file[start : start + SMALL]
            body = body + b"\x1a" * (SMALL - len(body))  # ^Z pad, xmodem convention
            crc = crc_xmodem(body)
            block = bytes([SOH, number, number ^ 0xFF]) + body + bytes([crc >> 8, crc & 0xFF])
            sock.sendall(block)
            ack = sock.recv(1)
            check(f"block {number} ACKed", ack == bytes([ACK]), repr(ack))

        sock.sendall(bytes([EOT]))
        ack = sock.recv(1)
        check("EOT ACKed", ack == bytes([ACK]), repr(ack))

        time.sleep(0.4)  # the status endpoint reads the 250ms snapshot
        status = get("/api/transfer?port=devA")
        check("transfer status done", status.get("phase") == "done", json.dumps(status))

        data = get_raw("/api/transfer/data?port=devA")
        check("drained bytes match (padding trimmed)", data == file, f"{len(data)} bytes")

        # ---------- SEND: engine -> device (same wire link; the HAL's
        # tcp-server transport serves one client at a time, which is also how
        # a real single serial link behaves) ----------
        staged = post_raw("/api/transfer/upload", file)
        check("file staged", staged.get("ok") is True, json.dumps(staged))

        arm = post("/api/transfer", {"action": "arm", "port": "devA", "direction": "send", "mode": "crc128", "name": "push.bin"})
        check("send arm accepted", arm.get("ok") is True, json.dumps(arm))

        # Device polls 'C'; engine responds with blocks; validate + ACK.
        sock2 = sock  # reuse the established link
        sock2.settimeout(3.0)
        sock2.sendall(bytes([CRC_CH]))

        received = b""
        blocks_seen = 0
        eot_seen = False
        deadline = time.time() + 10
        while time.time() < deadline and not eot_seen:
            try:
                chunk = sock2.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                break
            received += chunk
            while received:
                hdr = received[0]
                if hdr == EOT:
                    sock2.sendall(bytes([ACK]))
                    eot_seen = True
                    received = received[1:]
                    break
                if hdr not in (SOH, STX):
                    received = received[1:]
                    continue
                size = SMALL if hdr == SOH else 1024
                if len(received) < size + 5:
                    break  # partial block: read more
                block = received[: size + 5]
                received = received[size + 5 :]
                number, complement = block[1], block[2]
                body = block[3 : 3 + size]
                crc = (block[3 + size] << 8) | block[4 + size]
                if complement != (number ^ 0xFF) or crc_xmodem(body) != crc:
                    sock2.sendall(bytes([NAK]))
                    continue
                blocks_seen += 1
                sock2.sendall(bytes([ACK]))

        check("send transfer saw EOT", eot_seen)
        check("all blocks carried valid CRCs", blocks_seen == 3, f"{blocks_seen} blocks")
        time.sleep(0.4)
        status = get("/api/transfer?port=devA")
        check("send transfer completed", status.get("phase") == "done", json.dumps(status))
        sock.close()
        sock2.close()
        return 0 if not failures else 1
    finally:
        engine.terminate()
        try:
            engine.wait(timeout=5)
        except subprocess.TimeoutExpired:
            engine.kill()


if __name__ == "__main__":
    sys.exit(main())
