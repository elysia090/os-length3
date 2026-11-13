"""A terminal endpoint tested through two real PTYs, including shutdown under backpressure."""
import fcntl
import os
import pty
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import tty

exe = sys.argv[1]

def receive(fd, expected):
    result = b""
    until = time.monotonic() + 3
    while len(result) < len(expected):
        assert time.monotonic() < until, (expected, result)
        if select.select([fd], [], [], 0.1)[0]:
            result += os.read(fd, len(expected) - len(result))
    assert result == expected, (expected, result)

for how in ("hangup", "signal", "backpressure", "broken-output"):
    outer, outer_slave = pty.openpty()
    inner, inner_slave = pty.openpty()
    tty.setraw(inner_slave)
    before = termios.tcgetattr(outer_slave)
    flags = (fcntl.fcntl(inner, fcntl.F_GETFL), fcntl.fcntl(outer_slave, fcntl.F_GETFL))
    pipe = os.pipe() if how == "broken-output" else None
    child = subprocess.Popen([exe, "attach", str(inner)], stdin=outer_slave,
                             stdout=pipe[1] if pipe else outer_slave, stderr=subprocess.PIPE,
                             pass_fds=(inner,))
    until = time.monotonic() + 3
    while termios.tcgetattr(outer_slave) == before:
        assert child.poll() is None, child.stderr.read()
        assert time.monotonic() < until
        time.sleep(0.005)
    assert child.poll() is None, (how, child.returncode, child.stderr.read())
    if how != "broken-output":
        os.write(outer, b"typed\n")
        receive(inner_slave, b"typed\n")
        os.write(inner_slave, b"shown\n")
        receive(outer, b"shown\n")
        fcntl.ioctl(outer_slave, termios.TIOCSWINSZ, struct.pack("HHHH", 31, 97, 0, 0))
        os.kill(child.pid, signal.SIGWINCH)
        until = time.monotonic() + 3
        while struct.unpack("HHHH", fcntl.ioctl(inner_slave, termios.TIOCGWINSZ, bytes(8)))[:2] != (31, 97):
            assert time.monotonic() < until
            time.sleep(0.005)
    if how == "hangup":
        os.close(inner_slave); inner_slave = -1
        expected = 0
    elif how == "signal":
        os.kill(child.pid, signal.SIGTERM); expected = 143
    elif how == "backpressure":
        os.set_blocking(inner_slave, False)
        until = time.monotonic() + 0.2
        while time.monotonic() < until:
            try: os.write(inner_slave, b"x" * 65536)
            except BlockingIOError: time.sleep(0.001)
        os.kill(child.pid, signal.SIGTERM); expected = 143
    else:
        os.close(pipe[0]); os.close(pipe[1])
        os.write(inner_slave, b"output with no reader")
        expected = 1
    assert child.wait(timeout=3) == expected, (how, child.returncode, child.stderr.read())
    assert termios.tcgetattr(outer_slave) == before, "terminal mode was not restored"
    assert flags == (fcntl.fcntl(inner, fcntl.F_GETFL), fcntl.fcntl(outer_slave, fcntl.F_GETFL)), "descriptor flags were not restored"
    for fd in (outer, outer_slave, inner, inner_slave):
        if fd >= 0: os.close(fd)
    print("ok", how)
for fd in ("0", "-1", "999999999999999999999", "no"):
    assert subprocess.run([exe, "attach", fd], capture_output=True).returncode == 1
print("ok invalid descriptors")

# The guest writes a full reply before reading the remainder of a large request.
# Both directions must advance together even when both PTY queues fill.
import threading
outer, outer_slave = pty.openpty()
inner, inner_slave = pty.openpty()
tty.setraw(inner_slave)
before = termios.tcgetattr(outer_slave)
child = subprocess.Popen([exe, "attach", str(inner)], stdin=outer_slave, stdout=outer_slave,
                         stderr=subprocess.PIPE, pass_fds=(inner,))
until = time.monotonic() + 3
while termios.tcgetattr(outer_slave) == before:
    assert child.poll() is None
    assert time.monotonic() < until
    time.sleep(0.005)
request = b"i" * (512 << 10)
reply = b"o" * (512 << 10)
guest_errors = []
def guest():
    try:
        first = os.read(inner_slave, 1)
        assert first == b"i"
        sent = 0
        while sent < len(reply): sent += os.write(inner_slave, reply[sent:])
        total = first
        while len(total) < len(request): total += os.read(inner_slave, min(65536, len(request) - len(total)))
        assert total == request
    except BaseException as e: guest_errors.append(e)
thread = threading.Thread(target=guest, daemon=True)
thread.start()
os.set_blocking(outer, False)
sent, received = 0, bytearray()
until = time.monotonic() + 8
while sent < len(request) or len(received) < len(reply):
    assert time.monotonic() < until, ("crossed backpressure", sent, len(received))
    reads, writes, _ = select.select([outer], [outer] if sent < len(request) else [], [], 0.05)
    if writes:
        try: sent += os.write(outer, request[sent:sent + 65536])
        except BlockingIOError: pass
    if reads:
        try: received.extend(os.read(outer, 65536))
        except BlockingIOError: pass
thread.join(timeout=2)
assert not thread.is_alive() and not guest_errors, guest_errors
assert bytes(received) == reply
os.kill(child.pid, signal.SIGTERM)
assert child.wait(timeout=3) == 143
assert termios.tcgetattr(outer_slave) == before
for fd in (outer, outer_slave, inner, inner_slave): os.close(fd)
print("ok crossed backpressure")
