#!/usr/bin/env python3
"""Run a native LKL WebAssembly kernel to its next scheduler boundary.

The guest owns Linux syscalls and VFS state. This runner resolves only the
deterministic, nonblocking part of ``env.nccc_call64`` and stops before an
operation that requires choosing or waking a continuation.
"""

import argparse
from dataclasses import replace
import json
import mmap
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.host import (DirectPageStore, LinuxHostState, NCCC_IMPORT,
                         allocate_host_memory, attach_block,
                         prepare_linux_memory)
from kernel.process import prepare_user_process
from kernel.scheduler import KernelScheduler, start_scheduler
from qm.wasmstate import MEMORY_PAGE, decode_module, start_state
from qm.wasmwave import WaveExecutor


def _signed_i32(value):
    value = int(value) & 0xffffffff
    return value - (1 << 32) if value & (1 << 31) else value


def _process_stopped(process, boundary):
    """Whether a cross-module boundary cannot make cooperative progress."""
    if process.user.halted:
        return True
    if boundary.domain == 'user' and boundary.action == 'blocked':
        return True
    return (boundary.domain == 'kernel'
            and boundary.operation == 'scheduler'
            and boundary.action == 'stalled')


def run(path, entry='init', max_events=64, budget=1 << 17, rootfs=None,
        event_callback=None, start_init=False, init_module=None):
    with open(path, 'rb') as handle:
        source = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
    started = time.perf_counter()
    # LKL's C syscall table casts handlers of smaller arity to its uniform
    # six-i32 dispatch signature. Native C ABIs ignore the extra registers;
    # strict WebAssembly traps, so this compatibility is explicit and scoped
    # to the kernel module rather than weakening ordinary Wasm execution.
    module = decode_module(source, indirect_abi='c-extra-args')
    decoded_seconds = time.perf_counter() - started
    machine = start_state(module, entry, host_imports=(NCCC_IMPORT,))
    host = LinuxHostState()
    root_store = None
    root_handle = None
    if rootfs is not None:
        root_handle = open(rootfs, 'rb')
        root_handle.seek(0, 2)
        root_length = root_handle.tell()

        def load_rootfs(offset, length):
            root_handle.seek(offset)
            return root_handle.read(length)

        root_store = DirectPageStore(root_length, loader=load_rootfs)
        host, device = attach_block(host, root_store, read_only=True)
        if device != 0:
            raise RuntimeError('the root filesystem must be block device zero')
    try:
        machine, host = prepare_linux_memory(machine, host)
        executor = WaveExecutor(module)
        scheduler = KernelScheduler(module, executor)
        state = start_scheduler(machine, host)
    except Exception:
        if root_handle is not None:
            root_handle.close()
        raise
    events = []
    stages = []
    user_report = None
    init_image = None

    def drive_stage(current, name):
        stage_start = len(events)
        for _unused in range(max_events - len(events)):
            tick = time.perf_counter()
            current, boundary = scheduler.step(current, budget=budget)
            event = {
                'index': len(events),
                'stage': name,
                'domain': 'kernel',
                'thread': boundary.thread,
                'operation': boundary.operation,
                'action': boundary.action,
                'seconds': time.perf_counter() - tick,
                'execution': boundary.cost.layout(),
            }
            if boundary.detail is not None:
                event['detail'] = boundary.detail
            events.append(event)
            if event_callback is not None:
                event_callback(event)
            if current.thread(1).status == 'halted' \
                    or boundary.action == 'stalled':
                break
        thread = current.thread(1)
        result = _signed_i32(thread.result) if thread.status == 'halted' else None
        stages.append({'name': name, 'event_start': stage_start,
                       'event_end': len(events), 'status': thread.status,
                       'result': result})
        return current, result

    def drive_user(current, user_wasm):
        """Enter one WasmLinux user image over the retained kernel state."""
        clone_vm_sigchld = 0x100 | 17
        current = scheduler.invoke(
            current, 'taskmgmt', (4, clone_vm_sigchld, 0, 0))
        current, process_context = drive_stage(current, 'process_create')
        if process_context is None or process_context < 0:
            return current, None
        current = scheduler.invoke(
            current, 'taskmgmt', (3, process_context, 0, 0))
        current, apply_result = drive_stage(current, 'process_apply')
        if apply_result != 0:
            return current, None

        launch = prepare_user_process(
            scheduler, current, user_wasm, argv=('/init',),
            relocation_budget=budget)
        stages.append({
            'name': 'user_relocate',
            'event_start': len(events),
            'event_end': len(events),
            'status': 'halted',
            'result': 0,
            'execution': launch.relocation_cost.layout(),
        })
        process = launch.state
        process_start = len(events)
        terminal_boundary = None
        while len(events) < max_events:
            tick = time.perf_counter()
            process, boundary = launch.coordinator.step(
                process, budget=budget)
            event = {
                'index': len(events),
                'stage': 'user_init',
                'domain': boundary.domain,
                'thread': boundary.thread,
                'operation': boundary.operation,
                'action': boundary.action,
                'seconds': time.perf_counter() - tick,
                'execution': boundary.cost.layout(),
            }
            if boundary.detail is not None:
                event['detail'] = boundary.detail
            events.append(event)
            if event_callback is not None:
                event_callback(event)
            if _process_stopped(process, boundary):
                terminal_boundary = boundary
                break

        current = process.kernel
        if process.user.halted:
            user_status = 'halted'
            user_result = tuple(map(int, process.user.result))
        elif terminal_boundary is not None:
            user_status = 'blocked'
            user_result = None
        else:
            user_status = 'running'
            user_result = None
        stages.append({
            'name': 'user_init',
            'event_start': process_start,
            'event_end': len(events),
            'status': user_status,
            'result': user_result,
        })
        layout = launch.layout
        report = {
            'module_bytes': len(user_wasm),
            'functions': len(launch.module.functions),
            'table_slots': [len(table) for table in launch.module.tables],
            'globals': len(launch.module.globals),
            'layout': {
                'data_pointer': layout.data_pointer,
                'data_bytes': layout.data_bytes,
                'stack_pointer': layout.stack_pointer,
                'stack_bytes': layout.stack_bytes,
                'environment_pointer': layout.environment_pointer,
                'environment_bytes': layout.environment_bytes,
                'table_slots': layout.table_slots,
            },
            'tls': process.tls,
            'status': user_status,
            'result': user_result,
            'execution':
                launch.coordinator.user_executor.total_cost.layout(),
            'normalization':
                launch.coordinator.user_executor.normalization_layout(),
        }
        return current, report

    try:
        state, init_result = drive_stage(state, entry)
        if root_store is not None and init_result == 0 \
                and start_init and init_module is not None:
            with open(init_module, 'rb') as handle:
                user_wasm = handle.read()
            init_image = {
                'bytes': len(user_wasm),
                'source': 'external diagnostic module',
                'discarded_bytes': 0,
            }
            state, user_report = drive_user(state, user_wasm)
        elif root_store is not None and init_result == 0:
            state = scheduler.invoke(state, 'rootfs_mount')
            state, mount_result = drive_stage(state, 'rootfs_mount')
            if mount_result == 0:
                state = scheduler.invoke(state, 'init_probe')
                state, probe_result = drive_stage(state, 'init_probe')
                if start_init and probe_result == 0:
                    if init_module is not None:
                        with open(init_module, 'rb') as handle:
                            user_wasm = handle.read()
                        init_image = {
                            'bytes': len(user_wasm),
                            'source': 'external diagnostic module',
                            'discarded_bytes': 0,
                        }
                        state, user_report = drive_user(state, user_wasm)
                    else:
                        state = scheduler.invoke(state, 'init_size')
                        state, image_bytes = drive_stage(state, 'init_size')
                        if image_bytes is not None and image_bytes > 0:
                            host, image_pointer = allocate_host_memory(
                                state.host, image_bytes,
                                alignment=MEMORY_PAGE)
                            state = replace(state, host=host)
                            state = scheduler.invoke(
                                state, 'init_read',
                                (image_pointer, image_bytes))
                            state, read_result = drive_stage(
                                state, 'init_read')
                            if read_result == 0:
                                user_wasm = state.memory.read(
                                    image_pointer, image_bytes)
                                discard_bytes = (
                                    (image_bytes + MEMORY_PAGE - 1)
                                    // MEMORY_PAGE * MEMORY_PAGE)
                                state = replace(
                                    state,
                                    memory=state.memory.discard(
                                        image_pointer, discard_bytes))
                                init_image = {
                                    'bytes': image_bytes,
                                    'buffer_pointer': image_pointer,
                                    'discarded_bytes': discard_bytes,
                                }
                                state, user_report = drive_user(
                                    state, user_wasm)
    finally:
        if root_handle is not None:
            root_handle.close()

    resident = len(module.memory.base) + sum(
        len(page) for _index, page in module.memory.pages)
    runtime_resident = len(state.memory.base) + sum(
        len(page) for _index, page in state.memory.pages)
    block_events = [event for event in events
                    if event['operation'].startswith('block_')]
    touched_pages = set()
    for event in block_events:
        detail = event.get('detail') or ()
        if len(detail) > 5 and detail[0:2] == ('block', 'read'):
            touched_pages.update(detail[5])
    mapped_pages = tuple(entry.mapped for entry in executor.steps.values()
                         if entry is not None)
    codec = {
        'mapped_pages': len(mapped_pages),
        'mapped_bytes': sum(len(page.data) for page in mapped_pages),
        'execution': executor.total_cost.layout(),
        'normalization': executor.normalization_layout(),
    }
    code_layout = module.code_layout()
    code_layout['coordinate_rows'] = executor.steps.resident_rows
    report = {
        'module_bytes': len(source),
        'decode_seconds': decoded_seconds,
        'functions': len(module.functions),
        'table_slots': [len(table) for table in module.tables],
        'indirect_abi': module.indirect_abi,
        'memory_bytes': len(module.memory),
        'logical_runtime_memory_bytes': len(state.memory),
        'resident_initial_bytes': resident,
        'resident_runtime_bytes': runtime_resident,
        'events': events,
        'stages': stages,
        'barrier_trace': [
            {'index': event['index'], 'stage': event['stage'],
             'domain': event.get('domain', 'kernel'),
             'thread': event['thread'], 'operation': event['operation'],
             'action': event['action'], 'detail': event.get('detail')}
            for event in events if event['operation'] != 'timeslice'
        ],
        'block_trace': block_events,
        'threads': [
            {'handle': thread.handle, 'status': thread.status,
             'wait': thread.wait, 'result': thread.result}
            for thread in state.threads[1:] if thread is not None
        ],
        'codec': codec,
        'code': code_layout,
        'materialization': {
            'source': 'read-only mmap',
            'source_heap_copy_bytes': 0,
            'decoded_body_bytes': code_layout['decoded_body_bytes'],
            'encoded_body_bytes': code_layout['encoded_body_bytes'],
        },
        'physical_pages': len(mapped_pages),
        'stopped_at_scheduler': bool(events and
                                     events[-1]['action'] == 'stalled'),
    }
    if root_store is not None:
        report['rootfs'] = {
            'bytes': root_store.length,
            'resident_pages': root_store.resident_pages,
            'resident_bytes': root_store.resident_bytes,
            'backing_pages': root_store.backing_pages,
            'cow_pages': root_store.cow_pages,
            'dirty_pages': root_store.dirty_pages,
            'touched_pages': sorted(touched_pages),
        }
    if init_image is not None:
        report['init_image'] = init_image
    if user_report is not None:
        report['user'] = user_report
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('module')
    parser.add_argument('--entry', default='init')
    parser.add_argument('--max-events', type=int, default=64)
    parser.add_argument('--budget', type=int, default=1 << 17,
                        help='maximum Wasm instructions per resumable quantum')
    parser.add_argument('--rootfs',
                        help='read-only block image attached as device zero')
    parser.add_argument('--start-init', action='store_true',
                        help='load /init through LKL VFS and enter its _start_c')
    parser.add_argument('--init-module',
                        help=('diagnostic /init override; attach the root device '
                              'but skip mount, probe, and VFS extraction'))
    parser.add_argument('--progress', action='store_true',
                        help='stream each boundary to stderr while running')
    parser.add_argument('--events', action='store_true',
                        help='print every recorded boundary after running')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    def progress(event):
        detail = event.get('detail') or ()
        message = ''
        if isinstance(detail, (tuple, list)) and len(detail) == 2 \
                and detail[0] == 'print':
            message = '  ' + bytes(detail[1]).decode('utf-8', 'replace').rstrip()
        print('%3d  %-12s t%-3d %-22s %7.3f s' %
              (event['index'], event['stage'], event['thread'],
               event['operation'], event['seconds']) + message,
              file=sys.stderr, flush=True)

    report = run(args.module, args.entry, args.max_events, args.budget,
                 args.rootfs, progress if args.progress else None,
                 args.start_init, args.init_module)
    if args.json:
        print(json.dumps(report, indent=2, default=list))
    else:
        print('module       %d bytes' % report['module_bytes'])
        print('decode       %.3f s' % report['decode_seconds'])
        code = report['code']
        print('code         %d/%d functions, %d/%d body bytes decoded'
              % (code['decoded_functions'], code['defined_functions'],
                 code['decoded_body_bytes'], code['encoded_body_bytes']))
        if args.events:
            for event in report['events']:
                suffix = ' [%s]' % event['action']
                print('%3d  t%-3d %-22s %9d instructions  %7.3f s%s'
                      % (event['index'], event['thread'], event['operation'],
                         event['execution']['wasm_instructions'],
                         event['seconds'], suffix))
        for stage in report['stages']:
            print('stage        %-14s %-8s result=%s events=%d'
                  % (stage['name'], stage['status'], stage['result'],
                     stage['event_end'] - stage['event_start']))
        codec = report['codec']
        execution = codec['execution']
        print('codec        %d pages, %d bytes mapped' %
              (codec['mapped_pages'], codec['mapped_bytes']))
        print('waves        work=%d span=%d slices=%d barriers=%d width=%d' %
              (execution['work'], execution['span'],
               execution['pure_slices'], execution['barriers'],
               execution['max_parallel_width']))
        normalization = codec['normalization']
        print('normalized   %d -> %d work (%d removed), %d hot slices' %
              (normalization['source_work'],
               normalization['normalized_work'],
               normalization['removed_work'],
               normalization['compiled_state_steps']))
        print('state cuts   %d materialized, %d internal states carried' %
              (normalization['state_materializations'],
               normalization['avoided_state_materializations']))
        if 'rootfs' in report:
            root = report['rootfs']
            print('rootfs       %d/%d bytes resident, %d page(s) touched'
                  % (root['resident_bytes'], root['bytes'],
                     len(root['touched_pages'])))
        if 'init_image' in report:
            image = report['init_image']
            print('init image   %d bytes, %d temporary bytes discarded' %
                  (image['bytes'], image['discarded_bytes']))
        if 'user' in report:
            user = report['user']
            print('user         %d functions, %s, tls=0x%x' %
                  (user['functions'], user['status'], user['tls']))
        if report['events']:
            last = report['events'][-1]
            if last['action'] in ('blocked', 'stalled'):
                print('boundary     %s.%s [%s] %s' %
                      (last.get('domain', 'kernel'), last['operation'],
                       last['action'], last.get('detail')))
            if last['operation'] == 'scheduler' \
                    and last['action'] == 'stalled':
                for thread in report['threads']:
                    if thread['status'] != 'halted':
                        print('thread       t%d %s wait=%s' %
                              (thread['handle'], thread['status'],
                               thread['wait']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
