# LKL read-only root device

`block.c` adds one virtio block device after `lkl_start_kernel` has established
the LKL device model. Its backing bytes never enter the kernel module:
capacity, read, write, and flush requests cross `env.nccc_call64` group 6. The
host can therefore populate fixed-size pages on first access and discard clean
backing independently of dirty COW pages and the browser or kernel lifetime.

Apply `hostwasm.patch` to copies of the WasmLinux host stubs, then link those
copies with `block.c` and these LKL tool sources:

- `tools/lkl/lib/virtio.c`
- `tools/lkl/lib/virtio_blk.c`
- `tools/lkl/lib/iomem.c`
- `tools/lkl/lib/fs.c`

The build helper also regenerates the prefixed LKL userspace headers and
reconstructs `asm/syscall_defs.h` from the kernel archive's custom sections:

```sh
sh kernel/guest/build.sh /path/to/qm-linux-spike /path/to/kernel-rootfs.wasm
```

The linked wrapper is compiled with bulk-memory enabled, so its large memory
initializers become `memory.fill`/`memory.copy` barriers instead of byte loops.
Run the resulting module with a read-only ext image:

```sh
python3 kernel/run.py /path/to/kernel-rootfs.wasm \
    --rootfs /path/to/busybox-rootfs.ext2 \
    --start-init --max-events 3000 --budget 1048576
```

The patch exposes mount, probe, size and read calls. `rootfs_mount` mounts disk
zero as ext4 with `LKL_MS_RDONLY` and changes the calling LKL process root to
it. The runner then verifies and reads `/init`, discards the extraction buffer
after decoding, and starts the user module as a separate state machine whose
syscalls enter the retained kernel state.

The runner records every host barrier, every block read and its page domain,
root-image residency, slice normalization, and the mapped QM/codec cache size.
On the reference 16 MiB BusyBox image, mount plus `/init` verification touched
25 4-KiB pages (100 KiB resident); untouched image bytes were never loaded.
