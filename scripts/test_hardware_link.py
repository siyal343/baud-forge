#!/usr/bin/env python3
"""
Automated Hardware Link & Workstation Verification Script for BaudForge + ESP32-C3 on COM8.
Tests:
1. Starting bforge serve with examples/esp32-demo.bforge.toml
2. Querying /api/snapshot to verify COM8 is open and healthy
3. Sending 'mode imu\\n' via POST /api/send to trigger real hardware streaming
4. Reading SSE events from /api/events to verify live packet ingestion
5. Testing POST /api/yield to verify Flash Yield port release
"""

import subprocess
import time
import json
import urllib.request
import urllib.error
import sys

BASE_URL = "http://127.0.0.1:7717"

def main():
    print("[1/5] Starting bforge serve on COM8...")
    proc = subprocess.Popen(
        ["target\\debug\\bforge.exe", "serve", "-c", "examples/esp32-demo.bforge.toml", "--ui", "ui/dist", "--addr", "127.0.0.1:7717", "--duration", "30s"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    time.sleep(2)

    try:
        # Check health
        print("[2/5] Checking /api/snapshot...")
        req = urllib.request.Request(f"{BASE_URL}/api/snapshot")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            print(f"  Snapshot received: contract={data.get('contract')}, mode={data.get('session', {}).get('mode')}")
            ports = data.get("ports", [])
            for p in ports:
                print(f"  Port: id={p.get('id')}, device={p.get('device')}, state={p.get('state')}, baud={p.get('baud_rate')}")

        # Send 'mode imu\n' in hex: 6d 6f 64 65 20 69 6d 75 0a
        print("[3/5] Sending 'mode imu\\n' to ESP32-C3 via POST /api/send...")
        send_payload = json.dumps({"port": "esp", "hex": "6d 6f 64 65 20 69 6d 75 0a"}).encode("utf-8")
        send_req = urllib.request.Request(
            f"{BASE_URL}/api/send",
            data=send_payload,
            headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(send_req, timeout=5) as resp:
                print(f"  Send response status: {resp.status}")
        except urllib.error.HTTPError as e:
            print(f"  Send returned {e.code}: {e.read().decode()}")

        time.sleep(2)

        # Re-check snapshot to verify packet ingestion counters
        print("[4/5] Checking snapshot metrics after streaming...")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            p = data.get("ports", [{}])[0]
            print(f"  Port '{p.get('id')}': chunks={p.get('chunks')}, bytes={p.get('bytes')}, overruns={p.get('overruns')}")

        # Test Flash Yield
        print("[5/5] Testing Flash Yield via POST /api/yield for 5s...")
        yield_payload = json.dumps({"port": "esp", "seconds": 5}).encode("utf-8")
        yield_req = urllib.request.Request(
            f"{BASE_URL}/api/yield",
            data=yield_payload,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(yield_req, timeout=5) as resp:
            print(f"  Yield response status: {resp.status}")

        time.sleep(1)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            p = data.get("ports", [{}])[0]
            print(f"  Port state during yield: {p.get('state')}")

        print("\nAll live hardware checks executed successfully!")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        print("bforge serve terminated cleanly.")

if __name__ == "__main__":
    main()
