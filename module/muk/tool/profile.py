"""Native muk measurements. Safety/isolation are checked by test/, separately from these timings."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import selectors
import signal
import statistics
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
MODULE = HERE.parent

def emit(kind, **values):
    print(json.dumps({"kind": kind, **values}), flush=True)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def stamp(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        fields = text.rsplit(")", 1)[1].split()
        return {"pid": pid, "ppid": int(fields[1]), "start": fields[19], "state": fields[0]}
    except (OSError, ValueError, IndexError):
        return None

def descendants(pid):
    records = [r for p in Path("/proc").iterdir() if p.name.isdigit() and (r := stamp(int(p.name)))]
    selected, pending = [], {pid}
    while pending:
        next_ids = set()
        for row in records:
            if row["ppid"] in pending and row["pid"] != pid:
                selected.append(row); next_ids.add(row["pid"])
        pending = next_ids
    return selected

def pss(records):
    total, observed = 0, 0
    for record in records:
        if stamp(record["pid"]) != record:
            # State can change while sampling; PID plus start time is the stable identity.
            current = stamp(record["pid"])
            if current is None or current["start"] != record["start"]: continue
        try:
            for line in Path(f"/proc/{record['pid']}/smaps_rollup").read_text().splitlines():
                if line.startswith("Pss:"): total += int(line.split()[1]); observed += 1; break
        except OSError:
            pass
    return {"kib": total if observed else None, "observed": observed, "expected": len(records)}

def cgroup(path):
    if path is None: return None
    def number(name):
        try: return int((path / name).read_text())
        except (OSError, ValueError): return None
    try: fields = dict(line.split() for line in (path / "memory.stat").read_text().splitlines())
    except (OSError, ValueError): fields = {}
    return {"memory_current_bytes": number("memory.current"), "kernel_bytes": int(fields["kernel"]) if "kernel" in fields else None,
            "scope": "guest cgroup; muk supervisors stay in the caller's cgroup"}

class Box:
    def __init__(self, binary, bundle, timeout, group):
        args = [str(binary), "run", "--ids", f"{min(os.geteuid(), os.getegid())}-{max(os.geteuid(), os.getegid())}", "-b", str(bundle)]
        if group: args += ["--cgroup", str(group)]
        self.began = time.perf_counter_ns()
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        bufsize=0, start_new_session=True)
        self.timeout, self.guests, self.pidfds = timeout, [], []
        try:
            self.pidfd = os.pidfd_open(self.process.pid)
            os.set_blocking(self.process.stderr.fileno(), False)
            os.set_blocking(self.process.stdout.fileno(), False)
        except BaseException:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=timeout)
            for stream in (self.process.stdin,self.process.stdout,self.process.stderr): stream.close()
            if hasattr(self,"pidfd"): os.close(self.pidfd)
            raise
    def ready(self):
        with selectors.DefaultSelector() as events:
            events.register(self.process.stdout, selectors.EVENT_READ, "output")
            events.register(self.pidfd, selectors.EVENT_READ, "exit")
            selected = events.select(self.timeout)
            if not selected: raise RuntimeError("guest ready timed out")
            if not any(key.data == "output" for key,_ in selected) or self.process.stdout.read(1) != b"R":
                error = self.process.stderr.read(4096) or b""
                raise RuntimeError("guest did not become ready: " + error.decode(errors="replace"))
        self.ready_ns = time.perf_counter_ns() - self.began
    def observe(self):
        self.guests = descendants(self.process.pid)
        for guest in self.guests:
            try: fd = os.pidfd_open(guest["pid"])
            except ProcessLookupError: continue
            current = stamp(guest["pid"])
            if current and current["start"] == guest["start"] and current["ppid"] == guest["ppid"]:
                self.pidfds.append(fd)
            else:
                os.close(fd)
        parent = stamp(self.process.pid)
        return {"parent": pss([parent] if parent else []), "guest": pss(self.guests)}
    def stop(self):
        if os.waitid(os.P_PID,self.process.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None:
            raise RuntimeError("supervisor exited before guest EOF")
        began = time.perf_counter_ns()
        self.process.stdin.close()
        with selectors.DefaultSelector() as events:
            events.register(self.pidfd, selectors.EVENT_READ)
            if not events.select(self.timeout): raise RuntimeError("box did not exit after guest EOF")
        parent_ns = time.perf_counter_ns() - began
        status = os.waitid(os.P_PID,self.process.pid,os.WEXITED|os.WNOWAIT)
        if status.si_code != os.CLD_EXITED or status.si_status != 0:
            raise RuntimeError(f"supervisor exit was not success: code={status.si_code}, status={status.si_status}")
        deadline = time.monotonic() + self.timeout
        with selectors.DefaultSelector() as events:
            for fd in self.pidfds: events.register(fd, selectors.EVENT_READ)
            while events.get_map():
                left = deadline - time.monotonic()
                if left <= 0: raise RuntimeError("known guest processes remained after supervisor exit")
                for key, _ in events.select(left): events.unregister(key.fd)
        return {"status": status.si_status, "supervisor_exit_ns": parent_ns, "known_guest_exit_ns": time.perf_counter_ns() - began if self.pidfds else None}
    def terminate(self):
        # No wait/poll has reaped this child: the PID/PGID cannot have been recycled.
        try: os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        for fd in self.pidfds + [self.pidfd]:
            try: signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError: pass
    def cleanup(self, timeout):
        try: self.process.wait(timeout=max(0.001,timeout))
        finally:
            for fd in self.pidfds + [self.pidfd]: os.close(fd)
            for stream in (self.process.stdin,self.process.stdout,self.process.stderr): stream.close()

def fixture(directory):
    bundle = directory / "bundle"
    (bundle / "rootfs/dev").mkdir(parents=True)
    source = directory / "ready.c"
    source.write_text('#define UNIT "muk-ready"\n#include "' + str(MODULE.parent / "lib/sys.h") + '"\n'
        '__attribute__((noinline)) static int main_(int n,char **v,char **e){(void)n;(void)v;(void)e;char b[16]={82};'
        'if(sys3(SYS_write,1,(i64)&b,1)!=1)return 1;while(sys3(SYS_read,0,(i64)&b,1)>0){}return 0;}\n')
    subprocess.run(["sh", str(MODULE.parent / "lib/build.sh"), str(source), str(bundle / "rootfs/ready")], check=True)
    config = {"ociVersion": "1.2.0", "root": {"path": "rootfs", "readonly": True},
        "process": {"args": ["/ready"], "cwd": "/", "noNewPrivileges": True,
                    "capabilities": {name: [] for name in ("bounding", "effective", "permitted", "inheritable", "ambient")}},
        "linux": {"namespaces": [{"type": name} for name in ("mount", "pid", "ipc", "uts", "network", "user")],
                  "uidMappings": [{"containerID": 0, "hostID": os.geteuid(), "size": 1}],
                  "gidMappings": [{"containerID": 0, "hostID": os.getegid(), "size": 1}]}}
    (bundle / "config.json").write_text(json.dumps(config))
    return bundle

def run_boxes(binary, bundle, count, timeout, group, hold=False):
    boxes = []
    before = cgroup(group)
    try:
        for _ in range(count):
            boxes.append(Box(binary, bundle, timeout, group))
        for box in boxes: box.ready()
        memory = [box.observe() for box in boxes]
        during = cgroup(group)
        stopped = [box.stop() for box in boxes]
        result = {"ready_ns": [box.ready_ns for box in boxes], "stopped": stopped,
                "pss": memory if hold else None, "cgroup_before": before, "cgroup_during": during}
    finally:
        # A second cancellation signal must not cut cleanup short.
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM, signal.SIGHUP})
        try:
            errors=[]
            for box in boxes:
                try: box.terminate()
                except OSError as error: errors.append(str(error))
            deadline=time.monotonic()+timeout
            for box in reversed(boxes):
                try: box.cleanup(deadline-time.monotonic())
                except (OSError,subprocess.SubprocessError) as error: errors.append(f"owned pid {box.process.pid}: {error}")
            if errors: raise RuntimeError("cleanup: "+"; ".join(errors))
        finally: signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
    result["cgroup_after_cleanup"] = cgroup(group)
    return result

def parser_trials(work):
    config = {"ociVersion": "1.2.0", "process": {"args": ["/ready"], "cwd": "/"}, "root": {"path": "rootfs"},
              "linux": {"namespaces": [{"type": n} for n in ("mount", "pid", "ipc", "uts", "network")]},
              "mounts": [{"destination": f"/m{i}", "type": "tmpfs", "options": ["nosuid", "nodev", "size=4096", "mode=755"]} for i in range(96)]}
    path = work / "parse.json"; path.write_text(json.dumps(config))
    binaries = []
    for serial in (False, True):
        target = work / ("read-serial" if serial else "read-atomic")
        env = dict(os.environ)
        env["CFLAGS"] = env.get("CFLAGS", "") + " -UARENA_SERIAL" + (" -DARENA_SERIAL=1" if serial else "")
        subprocess.run(["sh", str(MODULE.parent / "lib/build.sh"), str(MODULE / "test/read.c"), str(target)], env=env, check=True)
        binaries.append(target)
    emit("parser_environment", input_sha256=sha(path), variants={b.name: sha(b) for b in binaries})
    for sample in range(9):
        for binary in binaries if sample % 2 == 0 else reversed(binaries):
            result = subprocess.check_output([str(binary), str(path), "20000"], text=True).split()
            emit("parser_trial", sample=sample, variant=binary.name, ns_per_parse=int(result[0]), checksum=int(result[1]))

def main():
    parser = argparse.ArgumentParser(description="Raw Linux muk trials: guest-ready and EOF-to-exit latency; small-N PSS; optional isolated-cgroup kernel memory. No throughput or global MemAvailable inference.")
    parser.add_argument("binary", nargs="?", type=Path)
    parser.add_argument("--baseline", type=Path, help="alternate the same workload with this binary")
    parser.add_argument("--lifecycle", action="store_true", help="repeat one-box startup and EOF shutdown")
    parser.add_argument("--memory", action="store_true", help="sample 1, 4 and up to 8 boxes and then reclaim them")
    parser.add_argument("--parser", action="store_true", help="same parser workload with atomic versus serial arenas; no boxes")
    parser.add_argument("--trials", type=int, default=9)
    parser.add_argument("--boxes", type=int, default=8)
    parser.add_argument("--cgroup", type=Path, help="an existing empty delegated cgroup, exclusively reserved for this run")
    args = parser.parse_args()
    if not 1 <= args.trials <= 50 or not 1 <= args.boxes <= 64: parser.error("trials must be 1..50 and boxes 1..64")
    if not (args.lifecycle or args.memory or args.parser): args.lifecycle = args.memory = True
    if args.cgroup and (args.cgroup / "cgroup.procs").read_text().strip(): parser.error("cgroup must be empty and exclusively reserved")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"): parser.error("Linux pidfd support is required")
    own_pid = int(Path("/proc/self/stat").read_text().split("(", 1)[0])
    if own_pid != os.getpid(): parser.error("getpid and /proc use different PID views")
    affinity = sorted(os.sched_getaffinity(0))
    os.sched_setaffinity(0, {affinity[0]})
    emit("environment", kernel=platform.release(), machine=platform.machine(), uid=os.geteuid(), cpu=affinity[0],
         allowed_cpus=affinity, python=platform.python_version(), compiler=subprocess.check_output([os.environ.get("CC", "cc"), "--version"], text=True).splitlines()[0],
         cflags=os.environ.get("CFLAGS", ""), profile_sha256=sha(__file__), source_sha256={p.name:sha(p) for p in sorted((MODULE / "src").glob("*")) if p.is_file()},
         cgroup=str(args.cgroup.resolve()) if args.cgroup else None, clock="perf_counter_ns", ready="observed first guest byte; includes launcher and observation", shutdown="EOF to supervisor exit, then known guest exit; cleanup uses SIGKILL separately")
    with tempfile.TemporaryDirectory(prefix="muk-profile-") as temporary:
        work = Path(temporary)
        if args.parser: parser_trials(work)
        if not (args.lifecycle or args.memory): return
        binary = args.binary.resolve() if args.binary else work / "muk"
        if args.binary is None: subprocess.run(["sh", str(MODULE.parent / "lib/build.sh"), str(MODULE / "src/muk.c"), str(binary)], check=True)
        variants = [("candidate", binary)]
        if args.baseline: variants.insert(0, ("baseline", args.baseline.resolve()))
        bundle = fixture(work)
        emit("artifacts", variants={label: {"path": str(b), "sha256": sha(b)} for label,b in variants},
             config_sha256=sha(bundle / "config.json"), guest_sha256=sha(bundle / "rootfs/ready"))
        values = {label: [] for label,_ in variants}
        if args.lifecycle:
            for trial in range(args.trials):
                for label, executable in variants if trial % 2 == 0 else reversed(variants):
                    row = run_boxes(executable, bundle, 1, 5, args.cgroup)
                    emit("lifecycle_trial", variant=label, trial=trial, **row)
                    values[label].append(row)
            for label, rows in values.items():
                for metric, samples in (("ready", [r["ready_ns"][0] for r in rows]), ("exit", [r["stopped"][0]["supervisor_exit_ns"] for r in rows])):
                    emit("summary", variant=label, metric=metric, observations=len(samples), median_ns=statistics.median(samples), max_ns=max(samples))
        if args.memory:
            for n in sorted({1, min(4,args.boxes),args.boxes}):
                for label,executable in variants: emit("footprint_trial", variant=label, boxes=n, **run_boxes(executable,bundle,n,5,args.cgroup,True))

if __name__ == "__main__":
    cancelled = False
    def cancel(signum, frame):
        global cancelled
        if not cancelled: cancelled = True; raise KeyboardInterrupt
    for signum in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP): signal.signal(signum,cancel)
    try: main()
    except KeyboardInterrupt: emit("interrupted", cleanup="owned processes only"); raise SystemExit(130)
    except (OSError,RuntimeError,subprocess.SubprocessError) as error: emit("failure", error=str(error)); raise SystemExit(1)
