# CPL0 outer IRETQ — 2026-10-05

The completed, unchanged-bundle `775fe27` receipt stops at `48 cf`,
`0xffffffff81000b7e`, after 214,809,102 retirements. The old C return boundary
refuses every nonzero return CS.RPL with result 6. The new model reproduces
`6 != 0` using that frozen VM; `/init` announcement is not successful PID 1.

## Return frontier

For an origin at CPL0, long code, VM=0 and CET disabled, a 64-bit IRET frame
contains `(RIP, CS, RFLAGS, RSP, SS)`, including same-privilege returns.
Let `p = CS.RPL`. Admission requires a present code descriptor, L=1/D=0,
`DPL=p` for nonconforming code or `DPL<=p` for conforming code. A nonnull SS
must have RPL/DPL=p and be a present writable data descriptor. Null SS is
allowed only at p!=3 with matching RPL. Compatibility and CPL1..3 origins
remain explicit refusals; this is not full IRET, TSS or IST closure.

The common C boundary reads descriptors through the same supervisor MMU.
It does not turn an outer return into a host callback or change Linux code.
Successful CS loading can set the descriptor's Accessed bit before a later
SS failure. Successful SS loading can also set Accessed before a target-RIP
#GP. Register/cache/RFLAGS/retirement publication stays deferred. Those
descriptor memory effects must not be incorrectly rolled back or hidden.

Restoring a noncanonical RSP is not a memory dereference and succeeds in the
observed 64-bit profile. The later memory instruction must perform its own
canonicality check. Outer return invalidates data/nonconforming selectors
whose cached DPL is below p, but preserves cached bases/limits, notably the
independently observable FS/GS bases. The cached Present bit is cleared and
the existing unusable marker represents the invalid selector. Conforming
code and already unusable caches are not discarded.

The compiled IRET body calls this boundary, restores RF without clearing it,
and retires exactly once on success. The C provider revokes the old execution
context; dispatcher result 5 with completed=1/sourceRetired=1 means that the
next context needs admission, not an unretired IRET. Repeating the old row
must refuse without another retirement. Failures complete/retire zero.

References: [Intel descriptor Accessed rules](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-3a-part-1-manual.pdf),
[Intel FS/GS base separation](https://www.intel.com/content/www/us/en/developer/articles/technical/software-security-guidance/best-practices/guidance-enabling-fsgsbase.html).
The linked old Volume 2A has obsolete #NP wording for a nonpresent return SS;
it is not used to override the observed hardware #SS or newer stack-fault
contract. The primary APM also distinguishes IRET-induced null selectors from
explicit selector writes. Observable differences are measured below, not
inferred from a generic selector-load helper.

## Independent oracle, including disagreement

`data/oracle/iret-entry.S` is an independent Multiboot test executable. Real
GDT/TSS/IDT transitions perform IRET to CPL1/2/3; an INT gate records the
resulting processor frame, selectors, FS/GS bases and descriptor bytes.
Sixteen stack alignments cover Accessed=0/1, flags, nonpresent CS/SS,
null SS, wrong privilege/type, noncanonical RIP and noncanonical restored RSP.
No fixture continuation is a product fallback.

The same 320 rows were run under Windows Hypervisor Platform and TCG through
QEMU 11.1.0 as independent test machinery, never as product execution.
Hardware-assisted results: 208 successes, 16 #NP, 16 #SS, 80 #GP.
TCG: 208 successes, 32 #NP, 80 #GP. There are **384 differing fields**, not
384 instructions: 224 Accessed-byte differences, 16 wrong-SS exception
vectors, and 144 saved-frame/selector differences at noncanonical RIP.
In that last case TCG publishes the outer state and faults at the target,
whereas hardware faults the original IRET. These are retained differences,
not waived correctness tests. C agrees with every hardware-observed field.
Hidden-cache fields not exposed by the fixture are explicit models, not
hardware measurements. No physical bare-metal or full-mode claim is made.

Native fixture ELF: 1e6fc27199dc57633b004fdeb0594734678c07b82f36004b339e16a719810780.
Hardware rows: [receipt](2026-10-05-iret-hardware.txt), SHA-256
aefcbbca8691432e494c1e5f6ff05643672528659a44ea16152cda3d201e07ed.
TCG rows: [receipt](2026-10-05-iret-tcg.txt), SHA-256
d7ec9b515f391057505de075d3ea1ca90ad76a7640329fdbbff82d5042a9114f.

## Candidate checks and costs

[Green receipt](2026-10-05-outer-iret-green.json): 120 complete 1,256-byte
CPU/136-byte hidden-state return models, 12 fault models, 2 residency retries,
1 stale refusal; 132 corresponding cold-C/generated-Wasm/C-dispatch cases;
320 independent hardware-assisted comparisons. C `make check` is green;
the new native return check also passes GCC ASan/UBSan. IRQ, source-cohort,
entry-binding and independently observed FXRSTOR regressions are green.

VM: **68,291 bytes**, +347 from the frozen full-run provider; SHA-256
115a70061c6f6bfc233f51c430401931ab76c153fce756b161e78245fb971239.
Compiler remains the branch-sharing candidate: **450,892 bytes**, SHA-256
b235e3ec3ac39db29b87acc545ea07b17c0bf3011b24e985c456c74811dd4bb6.
No new import, interpreter, CPU snapshot, cache quota or source metadata.
The native publication, distribution payload and human UI are unchanged.

Not proved: mixed-fault stack/descriptor priority across every page boundary,
compatibility targets, nonzero-origin IRET, CET, NMI unblock, outer-origin
fault/IRQ delivery, secondary escalation or Linux/browser acceptance.
The new full same-bundle run is a separate measurement; none of these fixture
passes establish PID 1, root mount, shell or cold shell within 3 seconds.
