"""Drive `pi -e src/index.ts` in a pseudo terminal and print screen snapshots.

Usage: python test/drive.py <script.json>
The script is a list of steps: {"send": "text"}, {"key": "enter"|"esc"|"alt+o"|...},
{"wait": seconds}, {"snap": "label"}, {"resize": [cols, rows]}.
"""
import fcntl
import json
import os
import pty
import select
import shutil
import struct
import sys
import tempfile
import termios
import time

import pyte

COLS, ROWS = int(os.environ.get("DRIVE_COLS", 140)), int(os.environ.get("DRIVE_ROWS", 36))
KEYS = {
    "enter": "\r",
    "esc": "\x1b",
    "alt+o": "\x1bo",
    "ctrl+c": "\x03",
    "pageup": "\x1b[5~",
    "alt+-": "\x1b-",
    "alt+=": "\x1b=",
    "shift+tab": "\x1b[Z",
    "pagedown": "\x1b[6~",
}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def isolated_agent_dir():
    """Copy the user's settings into a throwaway agent dir so /settings changes stay local."""
    src = os.path.expanduser("~/.pi/agent")
    dst = tempfile.mkdtemp(prefix="pi-btw-agent-")
    with open(os.path.join(src, "settings.json")) as f:
        settings = json.load(f)
    # The test runs with --no-extensions; dropping packages also avoids reinstalling them here.
    for key in ("packages", "extensions"):
        settings.pop(key, None)
    with open(os.path.join(dst, "settings.json"), "w") as f:
        json.dump(settings, f)
    for name in ("keybindings.json", "models.json"):
        if os.path.exists(os.path.join(src, name)):
            shutil.copy(os.path.join(src, name), dst)
    # Credentials are linked, not copied, so they never land in a temp dir.
    if os.path.exists(os.path.join(src, "auth.json")):
        os.symlink(os.path.join(src, "auth.json"), os.path.join(dst, "auth.json"))
    return dst


def main():
    steps = json.load(open(sys.argv[1]))
    agent_dir = isolated_agent_dir()
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.environ["TERM"] = "xterm-256color"
        os.environ["PI_CODING_AGENT_DIR"] = agent_dir
        extra = os.environ.get("DRIVE_EXTRA_ARGS", "").split()
        session = ["--session", os.environ["DRIVE_SESSION"]] if os.environ.get("DRIVE_SESSION") else ["--no-session"]
        os.execvp("pi", ["pi", *session, "--no-extensions", "--no-mcp", "-e", "src/index.ts", *extra])
    set_size(fd, COLS, ROWS)

    log_path = os.environ.get("DRIVE_RAW_LOG")
    raw_log = open(log_path, "wb") if log_path else None

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                stream.feed(data)
                if raw_log:
                    raw_log.write(data)
                    raw_log.flush()

    pump(4)
    for step in steps:
        if "send" in step:
            for ch in step["send"]:
                os.write(fd, ch.encode())
                pump(0.02)
        elif "key" in step:
            os.write(fd, KEYS[step["key"]].encode())
        elif "raw" in step:
            os.write(fd, step["raw"].encode())
        elif "wait" in step:
            pump(step["wait"])
        elif "resize" in step:
            cols, rows = step["resize"]
            screen.resize(rows, cols)
            set_size(fd, cols, rows)
            os.kill(pid, 28)  # SIGWINCH
        elif "snap" in step:
            pump(0.6)
            print(f"===== {step['snap']} =====")
            for y in range(screen.lines):
                row = screen.buffer[y]
                # One char per cell; a wide char's trailing cell is empty, a split one shows as "?".
                cells = [row[x].data if row[x].data else ("" if x and len(row[x - 1].data) and ord(row[x - 1].data[0]) > 0x2E80 else "?") for x in range(screen.columns)]
                print("".join(cells).rstrip())
        pump(0.3)
    os.kill(pid, 9)
    shutil.rmtree(agent_dir, ignore_errors=True)


main()
