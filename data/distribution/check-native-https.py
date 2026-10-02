#!/usr/bin/env python3
"""Exercise the released curl and Git HTTPS clients against a local TLS server.

The Python server and fixture Git repository run on the build host, not in the
release root.  This check needs no external network or runtime Python package.
"""

import functools
import http.server
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading


def run(*argv: object, quiet: bool = False) -> None:
    subprocess.run(
        [str(arg) for arg in argv], check=True,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.PIPE if quiet else None,
    )


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} RELEASE_ROOT", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve(strict=True)
    if os.geteuid() != 0 or not (root / "bin/busybox").is_file():
        print("native HTTPS check needs root and an extracted release root", file=sys.stderr)
        return 2
    openssl = root / "usr/bin/openssl"
    if not openssl.is_file():
        print("native HTTPS check: missing released OpenSSL", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="native-https-") as directory:
        scratch = Path(directory)
        cert = scratch / "ca.pem"
        key = scratch / "server.key"
        run(
            openssl, "req", "-new", "-x509", "-newkey", "rsa:2048",
            "-nodes", "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-keyout", key, "-out", cert,
            quiet=True,
        )
        (scratch / "hello.txt").write_text("native-https-ready\n", encoding="ascii")
        source = scratch / "source"
        repository = scratch / "repository.git"
        run("git", "init", "-q", source)
        (source / "hello.c").write_text(
            '#include <stdio.h>\nint main(void) { puts("https-git-ready"); return 0; }\n',
            encoding="ascii",
        )
        run("git", "-C", source, "add", "hello.c")
        run(
            "git", "-C", source, "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial",
        )
        run("git", "init", "--bare", "-q", repository)
        run("git", "-C", source, "push", "-q", repository, "HEAD:refs/heads/main")
        run("git", "--git-dir", repository, "symbolic-ref", "HEAD", "refs/heads/main")
        run("git", "--git-dir", repository, "update-server-info")

        handler = functools.partial(QuietHandler, directory=str(scratch))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert, keyfile=key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            try:
                run(
                    "bash", Path(__file__).with_suffix(".sh"), "--inside",
                    root, cert, server.server_address[1],
                )
            except subprocess.CalledProcessError as error:
                print(
                    f"native HTTPS: released client check failed "
                    f"(exit {error.returncode})",
                    file=sys.stderr,
                )
                return 1
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
    print("native HTTPS: green (certificate validation, curl, Git clone, C build)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
