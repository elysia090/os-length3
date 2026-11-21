# Native terminal attachment

`prompt attach FD` connects the frontend terminal to a guest PTY master the
caller already holds. It copies input and output, propagates window size, and
restores the frontend terminal state on exit. It starts no process.

The OCI runner creates the guest terminal and sends its master through the
console socket. The caller passes its copy as an inherited descriptor
(`FD >= 3`). The helper owns and closes that descriptor; the caller still
owns the guest process. The two bounded queues permit simultaneous input
and output under backpressure.

From the repository root, on Linux:

```sh
cargo build --locked --release --manifest-path ricebox/distribution/terminal/Cargo.toml
sh ricebox/distribution/terminal/test/prompt.sh
```

The desktop package installs the same helper as a sidecar. The [Sods terminal
test](../../sods/test/prompt/run.sh) runs the translated helper against Sods'
Linux services.
