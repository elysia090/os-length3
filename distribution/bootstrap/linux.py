#!/usr/bin/env python3
"""Linux build-host plumbing. No part of this host enters the release payload.

The Alpine 3.24.1 cloud image is the pinned *build host* only; the product
`development-standard-v1` is a separate from-source musl closure.  This mirrors
distribution/bootstrap/windows.mjs with a native QEMU instead of the Windows portable
build.  Subcommands:

    prepare  verify image/key, create the differential disk and ephemeral key
    serve    stream source.tar, the upstream cache and the NoCloud seed
    boot     start the build host (TCG) with an SSH forward on 127.0.0.1:18022
    ssh ...  run a command inside the guest with the ephemeral key
"""

import hashlib
import http.server
import json
import os
import secrets
import shutil
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
WORK = os.path.join(REPO, "temp", "bootstrap")
INPUTS = os.path.join(REPO, "distribution", "upstream", "bootstrap")
LOCK = json.load(open(os.path.join(HERE, "windows.json")))
IMAGE = os.path.join(INPUTS, LOCK["image"]["file"])
DISK = os.path.join(WORK, "build-host.qcow2")
DISK_CAPACITY = "32G"
KEY = os.path.join(WORK, "id_ed25519")
PORT = 18081
SSH_PORT = 18022
# The build host needs user-mode (slirp) networking; the minimal oracle build
# deliberately disables it, so this uses a slirp-enabled system emulator.
QEMU = os.environ.get(
    "QM_QEMU", "/tmp/libqm-x86-host/qemu-build-11.1.0/qemu-system-x86_64")
QEMU_IMG = os.environ.get(
    "QM_QEMU_IMG", "/tmp/libqm-x86-host/qemu-build-11.1.0/qemu-img")
BIOS = os.environ.get(
    "QM_QEMU_BIOS", "/tmp/libqm-x86-host/qemu-build-11.1.0/pc-bios")


def run(args, **kwargs):
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, check=True, **kwargs)


def digest(path, algorithm):
    value = hashlib.new(algorithm)
    with open(path, "rb") as stream:
        for part in iter(lambda: stream.read(1 << 20), b""):
            value.update(part)
    return value.hexdigest()


def prepare():
    os.makedirs(WORK, exist_ok=True)
    if digest(IMAGE, "sha256") != LOCK["image"]["sha256"]:
        raise SystemExit("cloud image checksum mismatch")
    gpg_home = os.path.join(WORK, "gnupg")
    os.makedirs(gpg_home, exist_ok=True, mode=0o700)
    key_file = os.path.join(INPUTS, LOCK["image"]["key_file"])
    signature = os.path.join(INPUTS, LOCK["image"]["signature"])
    run(["gpg", "--homedir", gpg_home, "--batch", "--import", key_file])
    status = subprocess.run(
        ["gpg", "--homedir", gpg_home, "--batch", "--status-fd", "1",
         "--verify", signature, IMAGE],
        stdout=subprocess.PIPE, text=True).stdout
    if f"[GNUPG:] VALIDSIG {LOCK['image']['key_fingerprint']} " not in status:
        raise SystemExit("cloud image signer differs from the pinned key")
    if not os.path.exists(KEY):
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C",
             "local-build-host", "-f", KEY])
    if not os.path.exists(DISK):
        run([QEMU_IMG, "create", "-f", "qcow2", "-F", "qcow2", "-b", IMAGE,
             DISK, DISK_CAPACITY])
    print(f"build disk: {DISK}")


def user_data():
    public = open(f"{KEY}.pub").read().strip()
    if not public.endswith(" local-build-host"):
        raise SystemExit("unexpected ephemeral build-host public key")
    password = secrets.token_hex(48)
    hashed = subprocess.run(
        ["openssl", "passwd", "-6", "-stdin"], input=password + "\n",
        stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
    return f"""#cloud-config
disable_root: false
ssh_pwauth: false
users:
  - name: root
    lock_passwd: false
    hashed_passwd: '{hashed}'
    ssh_authorized_keys:
      - {public}
growpart:
  mode: auto
  devices: ['/']
resize_rootfs: true
write_files:
  - path: /etc/ssh/sshd_config.d/90-build-host.conf
    permissions: '0644'
    content: |
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      AuthenticationMethods publickey
"""


def seed(name):
    if name == "meta-data":
        return "instance-id: local-build-host-v2\nlocal-hostname: build-host\n"
    if name == "vendor-data":
        return "#cloud-config\n{}\n"
    if name == "network-config":
        return "version: 2\nethernets:\n  eth0:\n    dhcp4: true\n"
    if name == "user-data":
        return user_data()
    return None


def snapshot():
    archive = os.path.join(WORK, "source.tar")
    excludes = [".git", "upstream", "build", "*/build-*/*", "node_modules",
                "dist", "gmon.out", "web"]
    args = ["tar", "-C", REPO, "-cf", archive]
    args += [f"--exclude={item}" for item in excludes]
    args += ["distribution", "compiler"]
    run(args)
    with tarfile.open(archive) as tar:
        names = set(tar.getnames())
    for entry in ["distribution/build.sh", "distribution/build-linked-kernel.sh",
                  "distribution/toolchain/build.sh", "distribution/packaging/build-init.sh",
                  "distribution/packaging/build-core-tools.sh",
                  "distribution/packaging/build-system-tools.sh",
                  "distribution/bootstrap/build-native.sh",
                  "distribution/bootstrap/environment.sh"]:
        if entry not in names:
            raise SystemExit(f"source snapshot omitted {entry}")
    return archive


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/seed/"):
            body = seed(path[6:])
            if body is None:
                self.send_response(404).end_headers()
                return
            body = body.encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/source.tar":
            self.stream(snapshot())
            return
        if path == "/upstream-index":
            names = sorted(
                entry.name for entry in os.scandir(os.path.join(REPO, "distribution/upstream"))
                if entry.is_file() and not entry.name.endswith(".part"))
            body = ("\n".join(names) + "\n").encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/upstream/"):
            name = path[10:]
            candidate = os.path.join(REPO, "distribution/upstream", name)
            if os.path.isfile(candidate) and name == os.path.basename(name):
                self.stream(candidate)
                return
        self.send_response(404)
        self.end_headers()

    def stream(self, path):
        self.send_response(200)
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.end_headers()
        with open(path, "rb") as stream:
            shutil.copyfileobj(stream, self.wfile)


def serve():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"build inputs: http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()


def boot():
    log = os.path.join(WORK, "serial.log")
    # Prefer KVM on a Linux host: the booted image is a build host, and TCG
    # makes a kernel build take hours instead of minutes.  Fall back to TCG
    # only when /dev/kvm is not usable.
    kvm = os.access("/dev/kvm", os.R_OK | os.W_OK)
    accelerator = "kvm" if kvm else "tcg"
    cpu = "host" if kvm else "qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-svm"
    execution = {
        "accelerator": accelerator, "machine": "q35", "cpus": 6,
        "memory_mib": 8192,
        "purpose": "build-host-not-product",
    }
    args = [
        QEMU, "-L", BIOS, "-machine", "q35", "-accel", accelerator,
        "-cpu", cpu,
        "-m", "8192", "-smp", "6", "-daemonize",
        "-drive", f"file={DISK},format=qcow2,if=virtio,discard=unmap,detect-zeroes=unmap",
        "-netdev", f"user,id=net0,hostfwd=tcp:127.0.0.1:{SSH_PORT}-:22",
        "-device", "virtio-net-pci,netdev=net0",
        "-smbios", f"type=1,serial=ds=nocloud;s=http://10.0.2.2:{PORT}/seed/",
        "-qmp", "tcp:127.0.0.1:18082,server=on,wait=off",
        "-display", "none", "-monitor", "none", "-serial", f"file:{log}",
        "-no-reboot",
    ]
    execution["args"] = args
    with open(os.path.join(WORK, "execution.json"), "w") as stream:
        json.dump(execution, stream, indent=2)
        stream.write("\n")
    run(args)
    print(f"build host started; serial log {log}")


def ssh_guest(argv):
    command = argv if argv else ["/bin/sh", "-l"]
    run(["ssh", "-p", str(SSH_PORT), "-i", KEY,
         "-o", "UserKnownHostsFile=" + os.path.join(WORK, "known_hosts"),
         "-o", "StrictHostKeyChecking=accept-new",
         "-o", "LogLevel=ERROR", "root@127.0.0.1", *command])


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "prepare":
        prepare()
    elif action == "serve":
        serve()
    elif action == "boot":
        boot()
    elif action == "snapshot":
        print(snapshot())
    elif action == "ssh":
        ssh_guest(sys.argv[2:])
    else:
        raise SystemExit("usage: linux.py prepare|serve|boot|snapshot|ssh ...")
