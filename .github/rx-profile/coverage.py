#!/usr/bin/env python3
"""Fail-closed coverage gate; only prints predefined lane IDs/status, never raw profile."""
import argparse
import json
import sys

LANES = (
    "matched_closure", "semantic_artifact_wait", "stock_cold_abba", "stock_warm_abba",
    "paired_semantic_phases", "native_function_samples", "sods_function_samples",
    "paired_function_self_cpu", "paired_function_inclusive_cpu", "paired_function_call_counts",
    "native_ir", "guest_x86_ir", "host_translated_ir", "native_perf",
    "v8_main_scopes", "v8_background_tier", "syscall_fs", "scheduler_wait_deschedule",
    "memory_ownership_highwater", "kernel_faults", "worker_lane",
)
REASONS = {"not_run", "unavailable", "partial", "fail", "pass"}
MANDATORY_NON_WORKER = tuple(k for k in LANES if k != "worker_lane")


def report(value):
    if not isinstance(value, dict) or not isinstance(value.get("lanes"), dict):
        raise ValueError("bad evidence")
    lanes = value["lanes"]
    if set(lanes) - set(LANES):
        raise ValueError("unknown lane")
    out = {}
    for key in LANES:
        item = lanes.get(key, {"status": "not_run"})
        if (not isinstance(item, dict) or not isinstance(item.get("status"), str)
                or item["status"] not in REASONS):
            raise ValueError("bad status")
        out[key] = item["status"]
    target = value.get("target", "inline_and_worker")
    if target not in ("inline_only", "inline_and_worker"):
        raise ValueError("bad target")
    required = LANES if target == "inline_and_worker" else MANDATORY_NON_WORKER
    state = "complete" if all(out[k] == "pass" for k in required) else "incomplete"
    return {"schema": "ricebox-cc1plus-coverage-v1", "target": target, "state": state,
            "worker_required": "worker_lane" in required, "lanes": out}


def unique_keys(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate field")
        out[key] = value
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    try:
        with open(parser.parse_args().report, encoding="utf-8") as stream:
            result = report(json.load(stream, object_pairs_hook=unique_keys))
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["state"] == "complete" else 2
    except (OSError, ValueError):
        print('{"schema":"ricebox-cc1plus-coverage-v1","state":"invalid"}')
        return 2


if __name__ == "__main__":
    sys.exit(main())
