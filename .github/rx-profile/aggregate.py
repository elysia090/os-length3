#!/usr/bin/env python3
"""Validate only this CI's actual warm one-TU pair and redact the profile handoff."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import tempfile

import coverage as envelope

REV = "28c45a65649b1058da0ad5077624e8fd4fa3cee9"
SCOPE = "cxx-ninja-v1.13.2-j1-warm-a-to-b-edit-distance"
NAMES = ("native-first", "sods-first", "sods-second", "native-second")
ARTS = ("edit_distance.o", "driver.o", "proof")
FIXTURE = ("fixture.sh", "build.ninja", "driver.cc", "edit_distance-A.cc",
           "edit_distance-B.cc", "edit_distance.h", "string_piece.h", "rx-time.c")
MARKS = ("RX_A", "RX_B_START", "RX_B_END", "RX_B", "RX_NINJA_LOG", "RX_NINJA_DEPS",
         "RX_INVALID", "RX_INVALID_STATUS 1", "RX_AFTER_INVALID", "RX_DONE")
HEX = r"[a-f0-9]{64}"
UUID = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"
MAX_WALL_NS = 3_600_000_000_000
MAX_ART = 256 * 1024 * 1024


class Invalid(ValueError):
    """Reason is local only; output fixed enums instead of raw evidence."""


def need(b, why):
    if not b:
        raise Invalid(why)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def is_sha(s):
    return isinstance(s, str) and re.fullmatch(HEX, s) is not None


def finite_int(v, lo, hi):
    return type(v) is int and lo <= v <= hi


def definite_file(path, maxsize=4 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        s = os.fstat(f.fileno())
        need(stat.S_ISREG(s.st_mode) and s.st_size <= maxsize, "input type/length")
        data = f.read(maxsize + 1)
        need(len(data) == s.st_size, "input length changed")
        return data


def available(path):
    # Dangling symlinks are not silently treated as absent.
    return os.path.lexists(path)


def jread(path, maxsize=512 * 1024):
    def nonfinite(_):
        raise Invalid("nonfinite JSON number")
    return json.loads(definite_file(path, maxsize), object_pairs_hook=envelope.unique_keys, parse_constant=nonfinite)


def put(path, payload):
    fd, name = tempfile.mkstemp(prefix=".profile-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, sort_keys=True, separators=(",", ":"), allow_nan=False)
            f.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def checksums(lines):
    need(len(lines) == len(ARTS), "artifact count")
    out = {}
    for at, line in zip(ARTS, lines):
        match = re.fullmatch(r"(" + HEX + r")  (.+)", line)
        need(match and match[2] == at, "ordered digest rows")
        out[at] = match[1]
    return out


def ninja_log(lines):
    need(len(lines) == 6 and lines[0] == "# ninja log v7", "v7 log shape")
    rows = []
    for line in lines[1:]:
        m = re.fullmatch(r"(\d{1,10})\t(\d{1,10})\t(\d{1,19})\t(edit_distance\.o|driver\.o|proof)\t([a-f0-9]{1,16})", line)
        need(m is not None, "v7 row")
        a, b, mtime = map(int, m.group(1, 2, 3))
        need(0 <= a <= b <= MAX_WALL_NS // 1_000_000 and mtime > 0, "v7 time")
        rows.append(dict(start_ms=a, end_ms=b, mtime_ns=mtime, output=m[4], command_hash=m[5]))
    names = [r["output"] for r in rows]
    need(set(names[:2]) == set(ARTS[:2]) and names[2:] == ["proof", "edit_distance.o", "proof"],
         "unexpected compile/link/dependency graph")
    for left, right in ((0, 1), (1, 2), (3, 4)):
        need(rows[left]["end_ms"] <= rows[right]["start_ms"], "overlapping serial commands")
    by_prime = {r["output"]: r["command_hash"] for r in rows[:3]}
    need(all(by_prime[r["output"]] == r["command_hash"] for r in rows[3:]), "commands changed")
    return rows, by_prime


def ninja_deps(lines):
    need(bool(lines), "missing dependency dump")
    m = re.fullmatch(r"edit_distance\.o: #deps 3, deps mtime (\d{1,19}) \(VALID\)", lines[0])
    need(m and int(m[1]) > 0, "outdated/suspicious depfile")
    data = [l for l in lines[1:] if l]
    need(len(data) == 3 and set(data) == {"    edit_distance.cc", "    edit_distance.h", "    string_piece.h"},
         "dependency inventory")


def fixture(out):
    lines = definite_file(out / "stdout").decode("latin-1").split("\n")
    idx = [i for i, l in enumerate(lines) if l.startswith("RX_") and not l.startswith("RX_WALL_NS ")]
    need(tuple(lines[i] for i in idx) == MARKS, "duplicate, unknown or misordered markers")
    need(not any(lines[i] for i in range(idx[-1] + 1, len(lines))), "post-done output")
    start, end = idx[1:3]
    wall = [i for i, l in enumerate(lines) if l.startswith("RX_WALL_NS ")]
    need(len(wall) == 1 and start < wall[0] < end, "wall at wrong endpoint")
    match = re.fullmatch(r"RX_WALL_NS (\d{1,13})", lines[wall[0]])
    need(match and 0 < int(match[1]) <= MAX_WALL_NS, "wall bound")
    prime = checksums(lines[idx[0]+1:start])
    changed = checksums(lines[idx[3]+1:idx[4]])
    after = checksums(lines[idx[8]+1:idx[9]])
    need(prime["driver.o"] == changed["driver.o"] and after == changed, "driver/failure parity")
    need(all(prime[k] != changed[k] for k in ("edit_distance.o", "proof")), "cache hit / no-op")
    rows, commands = ninja_log(lines[idx[4]+1:idx[5]])
    ninja_deps(lines[idx[5]+1:idx[6]])
    return dict(prime=prime, changed=changed, rows=rows, commands=commands, wall_ns=int(match[1]))


def static_pie(b):
    size = len(b)
    need(size >= 64 and b[:6] == b"\x7fELF\x02\x01", "not x64 LE ELF")
    e = struct.unpack_from("<HHIQQQIHHHHHH", b, 16)
    need(e[0] == 3 and e[1] == 62 and e[2] == 1 and e[8] == 56 and 1 <= e[9] <= 128, "not x64 ELF PIE")
    need(64 <= e[4] <= size - 56 * e[9], "program headers out of bounds")
    counts = {"stack": 0, "relro": 0, "entry": 0, "dynamic": 0}
    flags1 = None
    now = False
    for i in range(e[9]):
        t, flags, off, v, _, fs, ms, _ = struct.unpack_from("<IIQQQQQQ", b, e[4] + 56 * i)
        need(off <= size and fs <= size-off and fs <= ms and t != 3, "invalid/interpreted program header")
        if t == 1:
            need(not (flags & 3 == 3), "writable executable load")
            counts["entry"] += bool(flags & 1 and v <= e[3] < v + fs)
        elif t == 0x6474e551:
            need(flags & 1 == 0, "executable stack")
            counts["stack"] += 1
        elif t == 0x6474e552:
            counts["relro"] += bool(ms)
        elif t == 2:
            counts["dynamic"] += 1
            need(fs and fs % 16 == 0, "invalid dynamic segment")
            ended = False
            for off2 in range(off, off + fs, 16):
                tag, value = struct.unpack_from("<qQ", b, off2)
                if not tag:
                    ended = True
                    break
                need(tag not in (1, 0x7ffffffd, 0x7fffffff), "shared binary dependency")
                if tag == 0x6ffffffb:
                    need(flags1 is None, "duplicate ELF flags")
                    flags1 = value
                now |= tag == 24 or (tag == 30 and bool(value & 8))
            need(ended, "unterminated dynamic array")
    need(all(n == 1 for n in counts.values()) and flags1 is not None and flags1 & 0x08000000 and
         (now or flags1 & 1), "expected static PIE RELRO/NOW/nonexec stack")


def artifacts(out, r, native):
    metadata_file = out / "artifacts.json"
    proof_file = out / "proof.bin"
    live = out / "work/rx-out"
    meta = None
    if available(metadata_file):
        meta = jread(metadata_file)
        need(isinstance(meta, dict) and set(meta) == set(ARTS), "bad output metadata inventory")
        for k, d in meta.items():
            need(isinstance(d, dict) and set(d) == {"size", "mode", "uid", "gid"}, "malformed metadata")
            need(finite_int(d["size"], 1, MAX_ART) and finite_int(d["mode"], 0, 0o777) and
                 all(finite_int(d[n], 0, (1 << 32)-1) for n in ("uid", "gid")), "bad metadata type or mode")
            need((d["mode"] & 0o111 != 0) == (k == "proof"), "unexpected executable mode")
    if native:
        # Native bytes and independent custody, not merely stdout's digest text.
        for k in ARTS:
            f = live / k
            b = definite_file(f, MAX_ART)
            if k == "proof":
                static_pie(b)
            need(digest(b) == r["changed"][k], "native output digest mismatch")
            if meta is not None:
                st = os.lstat(f)
                need(meta[k] == dict(size=len(b), mode=stat.S_IMODE(st.st_mode),
                                     uid=st.st_uid, gid=st.st_gid), "native output metadata disagrees")
    if available(proof_file):
        b = definite_file(proof_file, MAX_ART)
        static_pie(b)
        need(digest(b) == r["changed"]["proof"], "proof byte path disagrees")
        if meta is not None:
            need(meta["proof"]["size"] == len(b), "proof metadata size disagrees")
    return meta, available(proof_file)


def host_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()


def capture(root, identity):
    file = root / "capture.json"
    if not available(file):
        return False
    v = jread(file)
    need(isinstance(v, dict) and v.get("revision") == REV and v.get("calibration") == "inline-v1" and
         all(v.get(k) == identity[q] for k, q in
             (("archiveSha", "root"), ("rootIndex", "index"), ("translator", "translator"))), "capture scope mismatched")
    boot = v.get("runnerBootId")
    need(isinstance(boot, str) and re.fullmatch(UUID, boot) and boot == host_id(), "different runner VM")
    arr = v.get("trials")
    need(isinstance(arr, list) and len(arr) == len(NAMES), "missing ABBA ledger")
    for tag, row in zip(NAMES, arr):
        need(isinstance(row, dict) and row.get("name") == tag and row.get("mode") == "warm-a-to-b" and
             row.get("engine") == tag.split("-")[0] and row.get("vmId") == boot, "ABBA host/mode/order")
        lane_dir = root / tag
        need(stat.S_ISDIR(os.lstat(lane_dir).st_mode) and
             definite_file(lane_dir / "runner-vm", 128).decode("ascii") == boot + "\n",
             "per-lane runner witness")
    return True


def materials(root):
    f = root / "materials"
    if not available(f):
        return None
    from_m = {}
    for line in definite_file(f, 65536).decode("utf-8", "strict").splitlines():
        m = re.fullmatch(r"(" + HEX + r")  (/.+)", line)
        need(m is not None, "malformed input digest")
        name = Path(m[2]).name
        need(name not in from_m, "duplicate tool/fixture identity")
        from_m[name] = m[1]
    need(set(from_m) == set(FIXTURE) | {"cc1plus", "ninja", "rx-time"}, "material inventory")
    prefix = Path(__file__).with_name("fixture")
    need(all(digest(definite_file(prefix / n)) == from_m[n] for n in FIXTURE), "fixture copy differs")
    need(from_m["edit_distance-A.cc"] != from_m["edit_distance-B.cc"], "fixture not changed")
    return from_m


def accepted_outputs(run, prior):
    need(run["prime"] == prior["prime"] and run["changed"] == prior["changed"] and
         run["commands"] == prior["commands"], "native/Sods or independent trial artifact mismatch")


# Fixed fields only; release no symbol, path, binary address, per-event detail or identity bytes.
PROFILE_CATS = (("jit_fg", "engine-jit-scope"), ("gc_fg", "engine-gc-scope"),
                ("other_engine_fg", "other-known-engine-scope"), ("sync_file", "sync-file-io"),
                ("sync_runtime", "sync-runtime-import"), ("remainder", "dispatch-remainder-guest-or-unseen-engine"))

def diagnostic_aggregate(total, lots, rows):
    if any("exclusive_wall_us" not in r or "exclusive_thread_cpu_us" not in r for r in rows):
        return None # Old structural test receipts; never synthesize timing.
    numeric = {"profile_samples": lots, "selected_top_samples": total,
               "mapped_guest_main_top_samples": 0, "opaque_or_runtime_top_samples": 0,
               "background_jit_overlap_us": 0}
    cap = MAX_WALL_NS // 1000
    saved = {"wall": {short:0 for short,_ in PROFILE_CATS}, "cpu": {short:0 for short,_ in PROFILE_CATS}}
    for r in rows:
        for category, breakdown, denom in (("wall", "exclusive_wall_us", "target_dispatch_wall_us"),
                                           ("cpu", "exclusive_thread_cpu_us", "target_dispatch_current_thread_cpu_us")):
            pieces = r[breakdown]; n = r.get(denom)
            need(isinstance(pieces, dict) and set(pieces) <= {label for _,label in PROFILE_CATS} and
                 finite_int(n, 0, cap) and all(finite_int(v, 0, cap) for v in pieces.values()) and
                 sum(pieces.values())==n, "nonexclusive or invalid diagnostic partition")
            for short, label in PROFILE_CATS:
                saved[category][short] += pieces.get(label, 0)
        bg = r.get("background_named_jit_wall_overlap_us_not_additive")
        need(finite_int(bg, 0, r["target_dispatch_wall_us"]), "invalid background JIT overlap")
        numeric["background_jit_overlap_us"] += bg
        for k,n in r["strict_dispatch_top_samples"].items():
            m = re.match(r"^#(\d{1,9}) ", k)
            part = "mapped_guest_main_top_samples" if m and int(m[1])>=13 else "opaque_or_runtime_top_samples"
            numeric[part] += n
    need(numeric["mapped_guest_main_top_samples"]+numeric["opaque_or_runtime_top_samples"]==total, "missing diagnostic sample share")
    for values in saved.values():
        need(finite_int(sum(values.values()), 0, cap), "excessive diagnostic interval")
    return {"observed":numeric, "exclusive":saved}


def diagnostic(root, reference, mat):
    layer = root / "sods-profile"
    if not available(layer):
        return "not_run", False, None
    f = layer / "reduced.json"
    if not available(f):
        return "unavailable", False, None
    try:
        run = fixture(layer)
        accepted_outputs(run, reference)
        v = jread(f, 8 * 1024 * 1024)
        need(isinstance(v, dict) and v.get("kind") == "diagnostic only; never a stock timer or a function-ms estimator",
             "unrecognized diagnostic kind")
        lots, owner = v.get("samples"), v.get("rows")
        need(finite_int(lots, 0, 1_000_000_000) and isinstance(owner, list) and
             0 < len(owner) <= 99_999 and mat, "missing selected-compiler identities")
        total = named = 0
        for q in owner:
            need(isinstance(q, dict) and q.get("role") == "cc1plus" and
                 q.get("phase") == "changed-source-template-TU" and q.get("elfSha256") == mat["cc1plus"] and
                 is_sha(q.get("wasmSha256")) and finite_int(q.get("all_strict_dispatch_top_samples"), 0, lots),
                 "diagnostic belongs to a different image/phase")
            need(all(k in q and q[k] is None for k in ("per_function_elapsed_ms", "guest_x86_Ir",
                                                       "translated_host_Ir", "kernel_proved_blocked_us")),
                 "out-of-contract inferred values")
            counts = q.get("strict_dispatch_top_samples")
            need(isinstance(counts, dict) and all(finite_int(n, 0, lots) for n in counts.values()) and
                 sum(counts.values()) == q["all_strict_dispatch_top_samples"], "invalid sample denominator")
            total += sum(counts.values())
            named += sum(n for k, n in counts.items() if re.match(r"^#\d+ ", k))
        need(total <= lots, "double counting samples")
        # Even when the selected compiler proves useful, it isn't the whole build, a direct timer,
        # host Ir, or matched native instrumentation. Preserve this limit on the envelope.
        return "partial", named > 0, diagnostic_aggregate(total, lots, owner)
    except (OSError, ValueError, struct.error, UnicodeError):
        return "fail", False, None


def collect(root, do_diag):
    ident = jread(root / "identity.json")
    need(isinstance(ident, dict) and all(is_sha(ident.get(k)) for k in ("root", "index", "translator")) and
         finite_int(ident.get("files"), 1, 2_000_000), "identity")
    launches_bound = capture(root, ident)
    mat = materials(root)
    runs = {}
    all_meta, all_proof = [], []
    for tag in NAMES:
        out = root / tag
        need(stat.S_ISDIR(os.lstat(out).st_mode), "unexpected lane path")
        r = fixture(out)
        if runs:
            accepted_outputs(r, runs[NAMES[0]])
        meta, pv = artifacts(out, r, tag.startswith("native-"))
        all_meta.append(meta)
        all_proof.append(pv)
        runs[tag] = r
    ready_meta = all(x is not None for x in all_meta)
    if ready_meta:
        need(all(x == all_meta[0] for x in all_meta[1:]), "native/Sods output metadata mismatch")
    exact_tool_inputs = bool(mat and launches_bound)
    proven_scope = exact_tool_inputs and ready_meta and all(all_proof)
    pairs = []
    for a, b in ((NAMES[0], NAMES[1]), (NAMES[3], NAMES[2])):
        n, s = runs[a], runs[b]
        p = {"native_ns": n["wall_ns"], "sods_ns": s["wall_ns"], "sods_minus_native_ns": s["wall_ns"]-n["wall_ns"]}
        for k, i in (("compile", 3), ("link", 4)):
            ct = lambda r: r["rows"][i]["end_ms"]-r["rows"][i]["start_ms"]
            p[k+"_ninja"] = {"native_ms_quantized": ct(n), "sods_ms_quantized": ct(s),
                             "sods_minus_native_ms_quantized": ct(s)-ct(n)}
        pairs.append(p)
    states = dict.fromkeys(envelope.LANES, "not_run")
    states["matched_closure"] = "pass" if exact_tool_inputs else "partial"
    states["semantic_artifact_wait"] = "pass" if proven_scope else "partial"
    states["stock_warm_abba"] = "pass" if proven_scope else "partial"
    # Successful Ninja edge whole intervals are separately observed on each side, not all semantic internals.
    states["paired_semantic_phases"] = "partial"
    detail = "not_run"
    named = False
    diag_agg = None
    if do_diag:
        detail, named, diag_agg = diagnostic(root, runs[NAMES[0]], mat)
        # Profile cannot satisfy any paired function or instruction lane.
        for lane in ("sods_function_samples", "v8_main_scopes", "v8_background_tier", "syscall_fs"):
            states[lane] = detail
    return {"schema": "rx-cxx-warm-stock-receipt-v1", "scope": SCOPE,
            "workload": {"only": "C++ single changed translation unit, j1, A-primed",
                         "productMatrix": "separate, not certified by this sublane"},
            "bound_launches_same_vm": launches_bound, "complete_phase_alignment": False,
            "matched_output_metadata": ready_meta, "paired": pairs,
            "phase_quantization_note": "1 ms per endpoint, paired edge error <2 ms within Ninja clock only; runner/clock calibration beyond this unknown",
            "timing_note": "fork to verified positive-child terminal wait; two pairs, no p95 or SLA claim",
            "diagnostic_scoped_named_leafs_observed": named,
            "diagnostic_aggregate": diag_agg,
            "target": "inline_and_worker", "lanes": {k: {"status": z} for k, z in states.items()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stock", action="store_true")
    parser.add_argument("result", type=Path)
    args = parser.parse_args()
    try:
        need(stat.S_ISDIR(os.lstat(args.result).st_mode), "result root type")
        r = collect(args.result, not args.stock)
        put(args.result / ("stock.json" if args.stock else "coverage.json"), r)
        if args.stock:
            print("RX_STOCK warm-a-to-b-preflight-ok")
        else:
            if r["bound_launches_same_vm"] and r["lanes"]["stock_warm_abba"]["status"] == "pass":
                for i, p in enumerate(r["paired"], 1):
                    print("RX_PAIR_WARM_A_TO_B ordinal=%d native_ns=%d sods_ns=%d delta_ns=%d" %
                          (i, p["native_ns"], p["sods_ns"], p["sods_minus_native_ns"]))
            else:
                print("RX_STOCK warm-a-to-b-with-unbound-coverage")
            print("RX_CXX_SCOPE warm-one-tu-j1-only")
            if r["bound_launches_same_vm"] and r["lanes"]["stock_warm_abba"]["status"]=="pass" and r["diagnostic_aggregate"]:
                q = r["diagnostic_aggregate"]
                print("RX_PROFILE_SODS_ONLY " + " ".join(f"{k}={v}" for k,v in q["observed"].items()))
                for scale, v in q["exclusive"].items():
                    print("RX_PROFILE_SODS_ONLY_" + scale.upper() + "_US " +
                          " ".join(f"{k}={n}" for k,n in v.items()) + f" total={sum(v.values())}")
        return 0
    except (ValueError, OSError, struct.error, OverflowError):
        print("RX_STOCK invalid-evidence" if args.stock else "RX_AGGREGATE invalid-evidence")
        return 2


if __name__ == "__main__":
    sys.exit(main())
