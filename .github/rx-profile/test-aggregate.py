"""Adversarial receipt tests. Host transcript/bytes are parser controls only, not a Ricebox pair."""
import copy
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

import aggregate as a
import coverage as c

host = Path(sys.argv[1]).resolve()
# Actual host output poisons assumptions about a fabricated header format. This does not prove pair custody.
r = a.fixture(host)
a.artifacts(host, r, True)
boot = a.host_id()
assert re.fullmatch(a.UUID, boot)
ident = {"root": "1"*64, "index": "2"*64, "translator": "3"*64, "files": 1}
cap = dict(revision=a.REV, archiveSha=ident["root"], rootIndex=ident["index"], translator=ident["translator"],
           calibration="inline-v1", runnerBootId=boot,
           trials=[dict(name=name,engine=name.split("-")[0],mode="warm-a-to-b",vmId=boot) for name in a.NAMES])
elf_bad = bytes(bytearray((host/"proof.bin").read_bytes())[:64])
case_records = []

def write_json(p,v):
    p.write_text(json.dumps(v)+"\n")

def clean_case(d):
    d.mkdir()
    for tag in a.NAMES:
        side = d/tag
        shutil.copytree(host, side)
        dur = {"native-first": 80_000_000,"native-second": 80_000_000,"sods-first": 70_000_000,"sods-second": 90_000_000}[tag]
        p = side/"stdout"
        p.write_bytes(re.sub(rb"RX_WALL_NS +[0-9]+", b"RX_WALL_NS "+str(dur).encode(),p.read_bytes(),count=1))
        (side/"runner-vm").write_text(boot+"\n")
        m={}
        for name in a.ARTS:
            st = (side/"work/rx-out"/name).stat()
            m[name] = dict(size=st.st_size, mode=stat.S_IMODE(st.st_mode), uid=st.st_uid, gid=st.st_gid)
        write_json(side/"artifacts.json",m)
    write_json(d/"identity.json",ident)
    write_json(d/"capture.json",cap)
    p = Path(a.__file__).with_name("fixture")
    (d/"materials").write_text("".join(a.digest((p/n).read_bytes())+"  /fake-UNIT-only/"+n+"\n" for n in a.FIXTURE)
        + "".join("4"*64+"  /fake-UNIT-only/"+n+"\n" for n in ("ninja","rx-time","cc1plus")))


def bad(d, name, mutate):
    case = d/name
    clean_case(case)
    mutate(case)
    p = subprocess.run([sys.executable,"-B",a.__file__,str(case)],capture_output=True,check=False)
    assert p.returncode == 2 and p.stdout == b"RX_AGGREGATE invalid-evidence\n" and not p.stderr, (name,p)
    assert not (case/"coverage.json").exists()
    case_records.append(name)


with tempfile.TemporaryDirectory(prefix="rx-aggregate-unit-control.") as holder:
    d = Path(holder)
    good = d/"ok-unit"
    clean_case(good)
    v = a.collect(good,True)
    assert v["bound_launches_same_vm"] and v["lanes"]["stock_warm_abba"]["status"] == "pass"
    assert [p["sods_minus_native_ns"] for p in v["paired"]] == [-10_000_000,10_000_000]
    assert c.report(v)["state"] == "incomplete"
    for k in ("stock_cold_abba","worker_lane","paired_function_self_cpu","paired_function_inclusive_cpu",
              "paired_function_call_counts","native_perf","kernel_faults","memory_ownership_highwater","guest_x86_ir","host_translated_ir"):
        assert v["lanes"][k]["status"] == "not_run"
    (good/"capture.json").unlink()
    v = a.collect(good,True)
    assert not v["bound_launches_same_vm"] and v["lanes"]["stock_warm_abba"]["status"] == "partial"

    def later(lane, x, y):
        p = lane/"stdout"
        b = p.read_bytes()
        assert x in b
        p.write_bytes(b.replace(x,y,1))
    def edit_capture(case, f):
        x=copy.deepcopy(cap);f(x);write_json(case/"capture.json",x)

    bad(d,"different_runner",lambda p:edit_capture(p,lambda q:q["trials"][1].update(vmId="0"*36)))
    bad(d,"runner_file_disagrees",lambda p:(p/"sods-first/runner-vm").write_text("0"*36+"\n"))
    bad(d,"wrong_modes",lambda p:edit_capture(p,lambda q:q["trials"][1].update(mode="cold")))
    bad(d,"not_ABBA",lambda p:edit_capture(p,lambda q:q["trials"].reverse()))
    bad(d,"wrong_archive",lambda p:edit_capture(p,lambda q:q.update(archiveSha="8"*64)))
    bad(d,"duplicate_marker",lambda p:later(p/"sods-first",b"RX_B_START\n",b"RX_A\nRX_B_START\n"))
    bad(d,"timer_without_matching_wait_window",lambda p:later(p/"sods-first",b"RX_B_END\n",b"RX_WALL_NS 123\nRX_B_END\n"))
    bad(d,"impostor_log_version",lambda p:later(p/"sods-first",b"ninja log v7",b"ninja log v6"))
    bad(d,"changed_wrong_edge",lambda p:later(p/"sods-first",b"\tedit_distance.o\t",b"\tdriver.o\t"))
    bad(d,"outdated_deps",lambda p:later(p/"sods-first",b"(VALID)",b"(STALE)"))
    bad(d,"non_matching_failure",lambda p:later(p/"sods-first",b"RX_INVALID_STATUS 1",b"RX_INVALID_STATUS 0"))
    bad(d,"proof_link_wrong_bytes",lambda p:(p/"sods-first/proof.bin").write_bytes(elf_bad))
    bad(d,"wrong_native_actual_object",lambda p:(p/"native-first/work/rx-out/driver.o").write_bytes(b"unit invalid"))
    def wrong_meta(p):
        f=p/"sods-first/artifacts.json";v=json.loads(f.read_text());v["proof"]["uid"]+=1;write_json(f,v)
    bad(d,"artifact_mode_owner_mismatch",wrong_meta)

    # A profile file cannot satisfy unrelated lanes, and malformed/inferred estimates fail only diagnostic lanes.
    good=d/"optional-unit"; clean_case(good)
    dst=good/"sods-profile";shutil.copytree(host,dst)
    write_json(dst/"reduced.json",{"kind":"diagnostic only; never a stock timer or a function-ms estimator","samples":4,
        "rows":[{"role":"cc1plus","phase":"changed-source-template-TU","elfSha256":"4"*64,"wasmSha256":"5"*64,
                 "all_strict_dispatch_top_samples":4, "strict_dispatch_top_samples":{"#13 unit-symbol":3,"unknown":1},
                 "per_function_elapsed_ms":None, "guest_x86_Ir":None,"translated_host_Ir":None,"kernel_proved_blocked_us":None}]})
    assert a.collect(good,True)["lanes"]["sods_function_samples"]["status"] == "partial"
    x=json.loads((dst/"reduced.json").read_text())
    x["rows"][0]["per_function_elapsed_ms"]=0.1
    write_json(dst/"reduced.json",x)
    out=a.collect(good,True)
    assert out["lanes"]["sods_function_samples"]["status"] == "fail"
    assert out["lanes"]["paired_function_self_cpu"]["status"] == "not_run"
    assert out["lanes"]["native_perf"]["status"] == "not_run"
    assert out["lanes"]["stock_warm_abba"]["status"] == "pass"

print("PASS real host transcript parser + %d malformed cases + workload/mode/scope/status controls; fixture-only, no live Ricebox result" % len(case_records))
