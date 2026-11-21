#!/usr/bin/env python3
"""Classify a private sandbox receipt. No diagnostic text or input values are ever printed."""
import re
import sys

ENTER = b"RX_ISOLATION_ENTERED\n"
OK = ENTER + b"RX_ISOLATION_OK\n"
LIMIT = 16384
GUEST = {
    71: "guest-namespace-contract", 72: "guest-privilege-contract",
    73: "guest-mount-contract", 74: "guest-input-contract", 75: "guest-device-contract",
    76: "guest-write-or-wait-contract", 79: "guest-smoke-protocol",
}
# Match only launcher-origin lines for known diagnostic families, not the path or free-form text.
BWRAP = (
    ("launcher-netns-loopback", rb"loopback: Failed "),
    ("launcher-id-map", rb"(?:setting up (?:uid|gid) map|unable to (?:switch to|drop root) (?:uid|gid))"),
    ("launcher-bind-source", rb"Can.t (?:find source path |get type of source )"),
    ("launcher-mount", rb"(?:Can.t (?:bind mount |mkdir parents for |mount )|Failed to mount tmpfs|"
                       rb"Failed to make / slave|setting up newroot bind|pivot_root|mount proc|mount devpts)"),
    ("launcher-exec-or-cwd", rb"(?:execvp |Can.t chdir to )"),
    ("launcher-namespace", rb"(?:Creating new namespace failed|No permissions to creat(?:e|ing) (?:a )?new namespace|"
                          rb"Unable to create a new namespace|Cannot create new cgroup namespace)"),
)


def classify(rc, stdout, stderr):
    if len(stdout) >= LIMIT or len(stderr) >= LIMIT:
        return "overflow"
    if rc == 0:
        return "passed" if stdout == OK and stderr == b"" else "unverified-success"
    if rc in (124, 137):
        return "bounded-timeout-or-kill"
    if stdout == ENTER:
        return GUEST.get(rc, "unclassified-guest")
    if stdout:
        return "unclassified-probe"
    found = set()
    for line in stderr.splitlines():
        if line.startswith(b"sudo: "):
            found.add("launcher-sudo")
        if line.startswith(b"bwrap: "):
            for kind, signature in BWRAP:
                if re.match(signature, line[7:]):
                    found.add(kind)
    return next(iter(found)) if len(found) == 1 else "unclassified-launcher"


def main():
    try:
        rc = int(sys.argv[1])
        if not 0 <= rc <= 255 or len(sys.argv) != 4:
            raise ValueError
        with open(sys.argv[2], "rb") as stdout, open(sys.argv[3], "rb") as stderr:
            result = classify(rc, stdout.read(LIMIT), stderr.read(LIMIT))
    except (IndexError, OSError, ValueError):
        result = "local-receipt"
    print(result)
    return 0 if result == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
