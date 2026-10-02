# VM control boundary checks

The new C product currently implements only scoped resource-operation admission.
It does not execute x86, lower Wasm, boot Linux or implement virtio/MMU devices.
The old `wasm/` implementation is not linked into `libvm.a`.

```
make -C src/v2/vm check
```

On 2026-10-02 the test initially could not build because `core/resource.c` did
not exist. After implementation the normal C build and an independent
ASan/UBSan build passed 100,000 seeded range/direction cases against a
128-bit-arithmetic reference, plus lifecycle witnesses. A subsequent two-lane
witness reproduced admission of the other lane's sequence-1 reply (three
assertions failed). The ticket now binds an explicit lane rank and that witness
passes without a shared hot sequence counter or a search through pending work.
This is native C
evidence, not an actual browser integration test.

Covered witnesses:

* wrong authority, workspace, resource, lane, generation, revision or sequence;
* interval overflow, zero length, budget excess and denied direction;
* duplicate or malformed completion, including while a newer batch is pending;
* cancel followed by a late completion; cancellation after a simulated aborted
  operation frees the control lane without claiming an automatic trap handler;
* revoke/regrant and Worker-generation rebind with old acknowledgements;
* invalid replacement preserving the prior live grant and reservation;
* sequence exhaustion and generation/revision rollback instead of wraparound.

Cells are owner-serialized and caller-owned, with one in-flight bounded batch
per independent lane, not one promise per guest page or instruction. There is
no allocator or payload buffer in the gate. The trusted broker must establish
actual browser permission, a non-reused authority scope and resource binding.
Completions only admit transport results; the C storage pipeline still verifies
payloads and the durable root authority still verifies publication receipts.

The browser diagnostic in `browser/` additionally inventories API presence
without requesting permissions, registering Service Workers, opening sockets,
writing OPFS or claiming a usable connection. Window and Worker inventories
are separate. The retained manual observation predates this inventory; no new
browser result is implied by the Node regression.
