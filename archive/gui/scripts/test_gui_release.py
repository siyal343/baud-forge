import subprocess
import time
import os
import sys

def main():
    exe_path = os.path.abspath("target/release/bforge-gui.exe")
    if not os.path.exists(exe_path):
        print(f"Error: {exe_path} not found.")
        sys.exit(1)

    size_bytes = os.path.getsize(exe_path)
    size_mb = size_bytes / (1024 * 1024)
    print(f"Executable found: {exe_path}")
    print(f"File size: {size_bytes} bytes ({size_mb:.2f} MB)")

    print("Launching bforge-gui.exe...")
    proc = subprocess.Popen([exe_path])
    pid = proc.pid
    print(f"Process spawned with PID {pid}")

    try:
        # Run for 3 seconds
        time.sleep(3.0)
        ret = proc.poll()
        if ret is not None:
            print(f"Process terminated prematurely with code {ret}")
            sys.exit(1)
        print(f"Process is healthy and running after 3 seconds.")
    finally:
        print(f"Terminating PID {pid} cleanly...")
        proc.terminate()
        try:
            proc.wait(timeout=3.0)
            print(f"Process {pid} terminated cleanly.")
        except subprocess.TimeoutExpired:
            print(f"Process {pid} did not terminate in time, killing...")
            proc.kill()
            proc.wait()
            print(f"Process {pid} killed.")

if __name__ == "__main__":
    main()
