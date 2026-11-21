#!/usr/bin/env python3
"""Manual umbrella gate. Collector adjudication remains separate."""
import json
import sys
from coverage import unique_keys

GROUPS = {
    "producer": ("build_clean", "build_warm", "aot_miss", "aot_hit", "pack_deploy"),
    "demo_browser": ("initial_navigation", "return_navigation", "isolated_worker"),
    "installed_terminal": ("shell_cli", "process_wait", "filesystem", "ipc"),
    "toolchain": ("c_matrix", "cpp_matrix", "representative_projects", "cpp_deep"),
    "everyday": ("input_to_frame", "frame_pacing", "focus_resize_ime"),
    "crosscut": ("identity_parity", "timing_and_tail", "cpu_and_instructions",
                 "runtime_io_wait", "memory_and_faults"),
}
STATES = {"pass", "partial", "unavailable", "not_run", "fail"}


def reduce(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get("groups"), dict):
        raise ValueError()
    batches = raw["groups"]
    if set(batches) - GROUPS.keys():
        raise ValueError()
    out = {}
    for group, fields in GROUPS.items():
        actual = batches.get(group, {})
        if not isinstance(actual, dict) or set(actual) - set(fields):
            raise ValueError()
        out[group] = {}
        for key in fields:
            v = actual.get(key, "not_run")
            if not isinstance(v, str) or v not in STATES:
                raise ValueError()
            out[group][key] = v
    full = all(v == "pass" for row in out.values() for v in row.values())
    return {"schema": "ricebox-workloads-coverage-v1", "state": "complete" if full else "incomplete", "groups": out}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError()
        with open(sys.argv[1], encoding="utf-8") as stream:
            result = reduce(json.load(stream, object_pairs_hook=unique_keys))
        print(json.dumps(result, separators=(",", ":")))
        sys.exit(0 if result["state"] == "complete" else 2)
    except (OSError, ValueError):
        print('{"schema":"ricebox-workloads-coverage-v1","state":"invalid"}')
        sys.exit(2)
