# prompt — an attached terminal

Rust terminal input, output, resize and local terminal restoration. The caller starts muk; muk creates the box, starts its program and supervises it. prompt attaches to an already supplied terminal descriptor and starts no process.

```
cargo build --locked --release
prompt attach FD
sh test/prompt.sh
```

The caller receives the terminal master through muk's OCI `--console-socket`, passes it as an inherited descriptor (FD ≥ 3), and owns disconnect and box-lifetime policy. prompt owns and closes its copy. It restores the frontend termios and inherited file status flags on normal exit, terminal hangup and handled signals. Two bounded queues allow simultaneous input and output under backpressure.

`why/core/src/prompt` is the existing product session adapter; migrating its launcher to this descriptor contract remains separate work. `why/app/prompt` supplies product UI and configuration, while its backend assembly is in `why/app/host/prompt`.
