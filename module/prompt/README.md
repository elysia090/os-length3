# prompt — an attached terminal

One Rust program: terminal input, output, resize, and the frontend's terminal put back as it was. It attaches to a
terminal descriptor it is given and starts no process. Whoever runs muk starts the box; muk makes the box's
terminal and gives its other end away; prompt is what stands at that other end.

```
cargo build --locked --release
prompt attach FD
sh test/prompt.sh
```

**What crosses, and nothing else.** One descriptor: the terminal's master, received from muk's OCI
`--console-socket` by the caller and inherited by prompt (FD ≥ 3). prompt owns and closes its copy. It restores the
frontend's termios and the file status flags it inherited on normal exit, terminal hangup and handled signals. Two
bounded queues allow simultaneous input and output under backpressure. It depends on no other unit (`libc` alone),
knows no box, no image and no product, and is the same program wherever a terminal descriptor is one.

**What is not its.** Starting, naming or keeping a box, disconnect and box-lifetime policy: the caller's. A
terminal drawn in a page (keys, a screen, colours) is a product's face, not this.

**Checked at two real terminals** (`test/attach.c`): what is typed goes in and what is shown comes out, the size
follows, it ends as its box's terminal ends or as it is told to (under backpressure, and with both ways full at
once), and the outer terminal and the descriptors it was given are left as they were. The check is one static C
program, so it is the same where the terminals are Linux's (`sh test/prompt.sh`) and where they are sods' Linux's
(`sh ../sods/test/prompt/run.sh`: the same prompt, translated, with signalfd and the terminals answered there).

`why/core/src/prompt` is the existing product session adapter; migrating its launcher to this descriptor contract
remains separate work. `why/app/prompt` supplies product UI and configuration, while its backend assembly is in
`why/app/host/prompt`.
