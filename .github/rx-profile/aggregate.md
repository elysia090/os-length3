# C++ sublane gate: A-primed one-TU Ninja -j1

Run with the existing private root-package diagnostic envelope:

    python3 -B aggregate.py --stock RESULT
    python3 -B aggregate.py RESULT
    python3 -B coverage.py RESULT/coverage.json

No tool install, exec, or probe is done by the reducer. The first invocation validates the stock artifacts and writes private stock.json before any diagnostic attempt. The second writes private coverage.json and repeats the same checks; only fixed status strings and measured integer nanoseconds for a proved pair can appear in stdout. A valid narrow report does not make coverage.py succeed when other lanes are uncollected.

Required generated runner files: identity.json from the verified mutually independent root extraction/layer projection; materials with the pinned tool and fixture identities; the same-VM capture.json plus each lane's runner-vm; each lane's genuine fixture transcript, artifacts.json and proof.bin; native lane's actual work/rx-out object/ELF files. If custody is incomplete but available evidence is structurally valid, pair coverage stays partial; a mismatching/invalid receipt fails instead. Trust the authorized CI producer and its checkout, not a standalone caller supplying this JSON.

This reducer validates real A→B effect/unchanged driver/terminal wait, exactly valid v7 compile+link logs, exact header deps, expected failure path and unchanged output, independently rehashed native files, and matching proof bytes+regular static-PIE/RELRO/NOW/NX metadata. Optional reduced.json from the separate instrumented cc1plus run must bind the compiler and observed phase and not relabel samples as CPU ms or instrumented Ir. It can make certain sublanes partial, never a whole-C++ or product pass.

Wall is stock, no probe, from immediately before timer fork through reaping the matching successful process. Fields use signed Sods−native integer ns per true pair; edge-level integer ms are from the same successful v7 Ninja graph, not all compiler/VM phases. Only two pairs here. No target/SLA, p95, sum-of-medians, physical function-millisecond, or ABI/clock-resolution extrapolation. Product-wide workload and ordinary cold/clean/header/fanout/link-only/no-op/parallel/larger workloads are separate; none are counted by this lane.

    python3 -B test-aggregate.py HOST_ONLY_FIXTURE_TRANSCRIPT_DIR

The test uses a real local Ninja v1.13.2 host GCC/GLIBC transcript and proof.bin, plus intentionally malformed and synthetic pair receipt controls. It requires DIRECTORY/stdout, DIRECTORY/proof.bin and DIRECTORY/work/rx-out/{driver.o,edit_distance.o,proof}. To generate one parser-only fixture on a capable Linux host, use a disposable directory, copy fixture files, local Ninja v1.13.2, compile rx-time.c with local gcc, replace /tmp/rx-in with the disposable absolute input path in the copy of fixture.sh, and set the host-only build.ninja link to -static-pie -Wl,-z,relro,-z,now,-z,noexecstack. Run the copied fixture; keep stdout, then copy the actual proof into proof.bin. This is a host transcript format check, not a benchmark, matched Alpine toolchain, or Ricebox pair; never submit the fixture as a real run.
