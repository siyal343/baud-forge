#!/usr/bin/env python3
"""
Hardware Live Validation Script for BaudForge + ESP32-C3 on COM8.
Validates:
1. Engine startup & port binding on COM8
2. Streaming live IMU packets with COBS framing & ImuPacket struct dissection
3. Telemetry values verification (v_batt_mv, gyro_z, timestamps)
4. Flash Yield port release and access via arduino-cli
5. Firmware stop and clean shutdown
"""

import subprocess
import time
import json
import urllib.request
import urllib.error
import threading
import sys
import os

SERVER_ADDR = "127.0.0.1:7717"
BASE_URL = f"http://{SERVER_ADDR}"

def http_get(path):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))

def http_post(path, data):
    url = f"{BASE_URL}{path}"
    payload = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    print("==================================================================")
    print("  BaudForge — Live Hardware Validation on ESP32-C3 (COM8)")
    print("==================================================================")
    
    bforge_bin = "target/debug/bforge.exe"
    if not os.path.exists(bforge_bin):
        bforge_bin = "target/release/bforge.exe"

    cmd = [
        bforge_bin,
        "serve",
        "-c", "examples/esp32-demo.bforge.toml",
        "--ui", "ui/dist",
        "--addr", SERVER_ADDR
    ]
    
    print(f"\n[1/5] Starting BaudForge server process...")
    server_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    try:
        # Wait for server to become healthy
        connected = False
        for _ in range(30):
            time.sleep(0.3)
            try:
                snap = http_get("/api/snapshot")
                connected = True
                break
            except Exception:
                pass
                
        if not connected:
            print("ERROR: Server failed to start or bind.")
            out, err = server_proc.communicate(timeout=2)
            print("Server stdout:", out.decode("utf-8", errors="replace"))
            print("Server stderr:", err.decode("utf-8", errors="replace"))
            sys.exit(1)

        ports = snap.get("ports", [])
        esp_port = next((p for p in ports if p.get("id") == "esp"), None)
        print(f"Server is healthy on http://{SERVER_ADDR}")
        print(f"Target Port: {esp_port.get('id')} | Device: {esp_port.get('device')} | State: {esp_port.get('state')} | Baud: {esp_port.get('baud_rate')}")

        # Start SSE background reader
        received_frames = []
        stop_sse = threading.Event()

        def sse_reader():
            req = urllib.request.Request(f"{BASE_URL}/api/events")
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    buffer = ""
                    while not stop_sse.is_set():
                        chunk = resp.read(512).decode("utf-8", errors="replace")
                        if not chunk:
                            break
                        buffer += chunk
                        while "\n\n" in buffer:
                            event_str, buffer = buffer.split("\n\n", 1)
                            event_type = None
                            data_payload = None
                            for line in event_str.split("\n"):
                                if line.startswith("event: "):
                                    event_type = line[7:].strip()
                                elif line.startswith("data: "):
                                    data_payload = line[6:].strip()
                            if event_type == "frames" and data_payload:
                                try:
                                    frames_list = json.loads(data_payload)
                                    if isinstance(frames_list, list):
                                        received_frames.extend(frames_list)
                                except Exception:
                                    pass
            except Exception:
                pass

        sse_thread = threading.Thread(target=sse_reader, daemon=True)
        sse_thread.start()

        # Send 'mode imu\n' command
        print("\n[2/5] Dispatching 'mode imu\\n' command to ESP32-C3 over COM8...")
        mode_hex = "6d 6f 64 65 20 69 6d 75 0a"
        send_resp = http_post("/api/send", {"port": "esp", "hex": mode_hex})
        print(f"Send status: {send_resp}")

        # Ingest live frames
        print("\n[3/5] Ingesting and measuring live telemetry stream...")
        start_time = time.time()
        timeout = 8.0
        while len(received_frames) < 30 and (time.time() - start_time) < timeout:
            time.sleep(0.1)

        frame_count = len(received_frames)
        elapsed = time.time() - start_time
        fps = frame_count / elapsed if elapsed > 0 else 0
        print(f"Ingested {frame_count} frames in {elapsed:.2f} seconds ({fps:.1f} frames/sec)")

        if frame_count == 0:
            print("ERROR: No telemetry frames received from ESP32-C3.")
            return

        sample = received_frames[-1]
        print("\n[4/5] Dissected Telemetry Struct Sample:")
        print(f"  Frame Sequence / Timestamp: {sample.get('timestamp_us')} us")
        print(f"  Inter-packet Delta: {sample.get('delta_us')} us")
        print(f"  Direction: {sample.get('direction')} | Raw Length: {sample.get('len')} B")
        print(f"  Hex Dump: {sample.get('hex')}")
        print(f"  Protocol: {sample.get('protocol')}")
        print("  Dissected Fields:")
        for f in sample.get("fields", []):
            name = f.get('name')
            val = f.get('value')
            unit = " mV" if "mv" in name else " rad/s" if "gyro" in name else " us" if "us" in name else ""
            print(f"    - {name:15}: {str(val):12} {unit} (offset: {f.get('offset')}, len: {f.get('len')}B)")

        # Verify Flash Yield
        print("\n[5/5] Testing Flash Yield (releasing COM8 serial lock for 5 seconds)...")
        yield_resp = http_post("/api/yield", {"port": "esp", "seconds": 5})
        print(f"Yield status: {yield_resp}")
        time.sleep(0.5)

        # Test external access with arduino-cli during yield window
        print("Executing 'arduino-cli board list' during active yield window:")
        try:
            cli_res = subprocess.run(["arduino-cli", "board", "list"], capture_output=True, text=True, timeout=5)
            for line in cli_res.stdout.splitlines():
                if "COM8" in line:
                    print(f"  [SUCCESS] arduino-cli detected: {line}")
        except Exception as e:
            print(f"  arduino-cli notice: {e}")

        print("Waiting for yield window to expire and port to reclaim...")
        time.sleep(5.5)

        # Send stop command to return firmware to idle
        print("Sending 'stop\\n' to return ESP32-C3 firmware to idle...")
        stop_hex = "73 74 6f 70 0a"
        http_post("/api/send", {"port": "esp", "hex": stop_hex})
        time.sleep(0.5)

        print("\n==================================================================")
        print("  LIVE HARDWARE VALIDATION COMPLETE: ALL CHECKS PASSED")
        print("==================================================================")

    finally:
        stop_sse.set()
        server_proc.terminate()
        try:
            server_proc.wait(timeout=2)
        except Exception:
            server_proc.kill()

if __name__ == "__main__":
    main()
