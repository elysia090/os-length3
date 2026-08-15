#!/usr/bin/env python3
"""Extend a native x86 artifact from an exact vm.wasm missing-block cut.

This is a build/oracle tool.  The snapshot is produced by vm.wasm and carries
only architectural state plus dirty physical pages.  No Python interpreter is
introduced into the browser runtime path.
"""

import argparse
import base64
from collections import Counter
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import sys
from time import perf_counter


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.machine import MachineEvent
from kernel.x86 import (PageFault, X86DBT, X86Error, X86Machine,
                        X86MachineState, read_virtual)
from kernel.x86snapshot import (canonical_native_x86_packed_records,
                                extend_loaded_native_x86_physical_machine,
                                load_native_x86_physical_machine,
                                load_x86_boot_cache,
                                native_x86_cut_coordinates,
                                native_x86_static_successors,
                                pack_native_x86_records,
                                physical_native_x86_record,
                                select_physical_cut)
from qm.steppage import StatePageError
from tools.build_native_x86_machine import _open_boot


def _word(value):
    return int(str(value), 16)


def realized_seed_cut(dbt, seed_cut):
    """Return the strongest cut proved at the requested coordinate."""
    return select_physical_cut(dbt, int(seed_cut.rip)) or seed_cut


def seed_cut_variants(requested_seed_cut, realized):
    """Retain a local fallback only when composition widened its proof."""
    if realized is requested_seed_cut:
        return (realized,)

    coordinate = int(requested_seed_cut.rip) & ((1 << 64) - 1)

    def primary_guard(cut):
        for rip, record in pack_native_x86_records(cut):
            if int(rip) & ((1 << 64) - 1) == coordinate:
                _fields, guard, _physical = physical_native_x86_record(
                    record, coordinate)
                return guard
        raise ValueError('native x86 seed cut has no primary record')

    # Equal proofs name the same executable identity, so the stronger
    # quotient replaces the eager lowering.  A wider proof may mention code
    # mapped later in the slice and therefore needs the entry-local fallback.
    if primary_guard(requested_seed_cut) == primary_guard(realized):
        return (realized,)
    return requested_seed_cut, realized


def realized_seed_cuts(dbt, requested_seed_cut):
    """Keep the requested proof beside any stronger realized composition."""
    realized = realized_seed_cut(dbt, requested_seed_cut)
    return seed_cut_variants(requested_seed_cut, realized)


def load_runtime_cut(artifact_root, source, snapshot_path):
    boot_payload, source_identity = _open_boot(artifact_root, source)
    state = load_x86_boot_cache(boot_payload).state
    raw = json.loads(snapshot_path.read_text(encoding='utf-8'))
    if raw.get('schema') not in (1, 2):
        raise ValueError('native runtime snapshot schema is unsupported')
    memory = state.memory
    for page, encoded in raw.get('dirty_pages', ()):
        page = int(page)
        payload = base64.b64decode(encoded, validate=True)
        if page < 0 or len(payload) != 4096:
            raise ValueError('native runtime dirty page is invalid')
        memory = memory.write(page * 4096, payload)
    saved = raw['state']
    system = tuple(map(_word, saved['system']))
    if len(saved['registers']) != 16 or len(system) != 22:
        raise ValueError('native runtime state shape is invalid')
    state = replace(
        state,
        memory=memory,
        registers=tuple(map(_word, saved['registers'])),
        rip=_word(saved['rip']), rflags=_word(saved['rflags']),
        cr0=_word(saved['cr0']), cr2=system[0], cr3=_word(saved['cr3']),
        cr4=_word(saved['cr4']), cr8=system[1], efer=_word(saved['efer']),
        gdtr=system[2:4], idtr=system[4:6],
        es=system[6], cs=system[7], ss=system[8], ds=system[9],
        fs=system[10], gs=system[11], ldtr=system[12], tr=system[13],
        debug=system[14:22],
        msrs=tuple((_word(key), _word(value))
                   for key, value in saved['msrs']),
        xmm=tuple(map(_word, saved.get('xmm', ('0',) * 32))))
    try:
        ports = tuple(sorted(
            (int(coordinate), _word(value))
            for coordinate, value in saved.get('io_ports', ())))
        console_input = base64.b64decode(
            saved.get('console_input', ''), validate=True)
        console_output = base64.b64decode(
            saved.get('console_output', ''), validate=True)
    except (TypeError, ValueError) as error:
        raise ValueError('native runtime device state is invalid') from error
    if (len({coordinate for coordinate, _value in ports}) != len(ports)
            or any(coordinate < 0 or value < 0
                   for coordinate, value in ports)):
        raise ValueError('native runtime device coordinates are invalid')
    machine = X86MachineState(
        state, io_ports=ports, console_input=console_input,
        console_output=console_output)
    return machine, source_identity, len(raw.get('dirty_pages', ()))


def load_seed_coordinates(path):
    """Load explicit coordinates or executable symbols from ``System.map``."""
    if path is None:
        return ()
    coordinates = set()
    for number, raw in enumerate(Path(path).read_text(
            encoding='utf-8').splitlines(), 1):
        value = raw.split('#', 1)[0].strip()
        if not value:
            continue
        try:
            coordinate = int(value, 0)
        except ValueError as error:
            fields = value.split()
            if len(fields) >= 3 and len(fields[1]) == 1:
                # A complete System.map is a better closure seed than a
                # hand-maintained address list, but data symbols must never be
                # decoded speculatively.  Weak/local text symbols are valid
                # indirect call targets and therefore belong to the same set.
                if fields[1] not in 'TtWw':
                    continue
                try:
                    coordinate = int(fields[0], 16)
                except ValueError:
                    coordinate = -1
            else:
                coordinate = -1
            if coordinate < 0:
                raise ValueError(
                    'invalid x86 seed coordinate at line %d' % number
                ) from error
        if not 0 <= coordinate < (1 << 64):
            raise ValueError(
                'x86 seed coordinate at line %d is outside u64' % number)
        coordinates.add(coordinate)
    return tuple(sorted(coordinates))


def load_seed_catalog(path):
    """Load content-addressed instruction entries for executable ELF pages."""
    if path is None:
        return ()
    raw = json.loads(Path(path).read_text(encoding='utf-8'))
    if raw.get('schema') != 'native-x86-elf-page-catalog-v1':
        raise ValueError('native x86 ELF page catalog schema is unsupported')
    objects = []
    for object_index, item in enumerate(raw.get('objects', ())):
        try:
            identity = bytes.fromhex(item['identity'])
            pages = []
            for page in item['pages']:
                coordinate = int(page['virtual_page'], 0)
                digest = bytes.fromhex(page['sha256'])
                entries = tuple(sorted(set(map(int, page['entries']))))
                if (coordinate < 0 or coordinate >= (1 << 64)
                        or coordinate & 4095):
                    raise ValueError('page coordinate is not u64-aligned')
                if len(digest) != 32:
                    raise ValueError('page digest is not SHA-256')
                if any(offset < 0 or offset >= 4096
                       for offset in entries):
                    raise ValueError('instruction offset is outside page')
                pages.append((coordinate, digest, entries))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(
                'invalid native x86 ELF catalog object %d' % object_index
            ) from error
        if len(identity) != 32:
            raise ValueError(
                'native x86 ELF catalog identity is not SHA-256')
        objects.append((identity, tuple(pages)))
    return tuple(objects)


def match_seed_catalog(cpu, seed_rip, catalog):
    """Select every resident page of the ELF containing one exact cut.

    Executables routinely reuse the same virtual addresses.  Matching the
    saved executable page before applying instruction offsets keeps catalog
    admission tied to immutable code identity instead of RIP alone.  The
    delta also supports a position-independent image loaded at a different
    base when its executable bytes need no text relocation.
    """
    seed_page = int(seed_rip) & ~4095
    try:
        seed_payload = bytes(read_virtual(cpu, seed_page, 4096, 'execute'))
    except PageFault:
        return (), {
            'objects': 0,
            'pages': 0,
            'coordinates': 0,
        }
    seed_digest = hashlib.sha256(seed_payload).digest()
    coordinates = set()
    identities = set()
    verified_pages = set()
    for identity, pages in catalog:
        anchors = tuple(page for page in pages if page[1] == seed_digest)
        for anchor_page, _digest, _entries in anchors:
            delta = seed_page - anchor_page
            matched = False
            for source_page, digest, entries in pages:
                target_page = source_page + delta
                if not 0 <= target_page < (1 << 64) or target_page & 4095:
                    continue
                try:
                    payload = bytes(read_virtual(
                        cpu, target_page, 4096, 'execute'))
                except PageFault:
                    continue
                if hashlib.sha256(payload).digest() != digest:
                    continue
                matched = True
                verified_pages.add((identity, target_page))
                coordinates.update(target_page + offset for offset in entries)
            if matched:
                identities.add(identity)
    return tuple(sorted(coordinates)), {
        'objects': len(identities),
        'pages': len(verified_pages),
        'coordinates': len(coordinates),
        'identity_sample': [identity.hex()
                            for identity in sorted(identities)[:8]],
    }


def close(machine_payload, state, budget, max_internal,
          seed_coordinates=(), seed_catalog=()):
    started = perf_counter()
    dbt = X86DBT(profile_controls=True)
    runtime = X86Machine(dbt)
    terminal = state if isinstance(state, X86MachineState) \
        else runtime.start(state)
    # A vm.wasm coverage fault may name the retry coordinate of a faultable
    # instruction split from the block that first reached it. Execution
    # profiling starts only after a transition completes, so seed that exact
    # coordinate before advancing. Otherwise a long oracle run can discover
    # thousands of neighboring cuts yet omit the one record the VM requested.
    try:
        seed_cut = dbt.physical_block(terminal.cpu)
    except PageFault:
        # Composition may inspect an as-yet-unmapped call target.  The exact
        # current block is still a valid closure seed; the guest page-fault
        # path will make the stronger successor available in a later round.
        seed_cut = dbt.block(terminal.cpu)
    response = None
    event = None
    remaining = max(1, int(budget))
    handled = Counter()
    console = bytearray()
    stalled = None
    while remaining > 0:
        terminal, event = runtime.machine_step(
            terminal, response, budget=remaining, max_internal=max_internal,
            clock_step=1)
        response = None
        cost = getattr(event, 'cost', None) or runtime.last_cost
        spent = int(cost.instructions) if cost is not None else 0
        # Output, entropy, and interrupt publication are barriers, not
        # discovery endpoints.  In particular, an interrupt can be published
        # while the guest is halted without retiring an instruction in this
        # turn.  Treating that zero-cost acknowledgement as a stall used to
        # stop the oracle at every timer/UART interrupt and forced the cold
        # closure driver to discover one small neighbourhood per reboot.
        answerable = (event is not None and event.operation in (
            'console_write', 'entropy', 'interrupt'))
        if (not terminal.cpu.halted and spent <= 0 and not answerable):
            stalled = {
                'rip': '%016x' % terminal.cpu.rip,
                'event': None if event is None else event.operation,
            }
            break
        remaining -= min(remaining, max(0, spent))
        if event is None:
            if terminal.cpu.halted:
                break
            continue
        handled[event.operation] += 1
        if event.operation == 'console_write':
            if event.data:
                console.extend(bytes(event.data))
            continue
        if event.operation == 'entropy':
            value = ((terminal.cpu.rip * 0x9e3779b97f4a7c15
                      + 0xd1b54a32d192ed03) & ((1 << 64) - 1))
            response = MachineEvent(
                'entropy', event.coordinate, value)
            continue
        if event.operation == 'interrupt':
            response = MachineEvent('interrupt', event.coordinate)
            continue
        break
    trace_finished = perf_counter()

    seed_rip = int(seed_cut.rip)
    requested_seed_cut = seed_cut
    # The realized slice can prove a stronger recurrence, scan, or composed
    # register cut at the exact missing coordinate. A realized cut may compose
    # the requested instruction with code that is
    # mapped only later in the same oracle slice.  Its wider proof is valuable
    # once that mapping exists, but cannot replace the exact cut requested by
    # the saved runtime state: vm.wasm must be able to reject the wider guard
    # and fall back to the entry-local proof.  Keep both physical variants;
    # canonical packing and the guarded directory deduplicate them when their
    # proofs are identical.
    cuts = list(realized_seed_cuts(dbt, requested_seed_cut))
    cuts.extend(cut for rip, cut in dbt._physical_retry_cuts.items()
                if int(rip) != seed_rip)
    # Freeze the required closure before speculative ELF seeding.  dbt.block
    # deliberately remembers every attempted decode, including an otherwise
    # valid instruction whose lowering is outside the current physical
    # grammar.  Letting those speculative entries flow back through
    # native_x86_cut_coordinates made one optional catalog miss fail the
    # entire runtime closure.  Only the exact runtime seed and cuts proved by
    # the realized trace are mandatory; the build-time catalog is a monotone
    # best-effort superset.
    required_coordinates = tuple(
        rip for rip in native_x86_cut_coordinates(dbt)
        if int(rip) != seed_rip)
    rejected = []
    packed_blocks = []
    required_rips = set()

    def retain_cut(cut):
        try:
            packed = pack_native_x86_records(cut)
        except (StatePageError, TypeError, ValueError) as error:
            rejected.append({
                'rip': '%016x' % cut.rip,
                'operation': cut.boundary.operation,
                'detail': repr(cut.boundary.detail),
                'reason': str(error),
            })
            return
        primary = int(cut.rip) & ((1 << 64) - 1)
        packed_blocks.append((primary, packed))
        required_rips.add(primary)

    for cut in cuts:
        retain_cut(cut)
    del cuts
    for rip in required_coordinates:
        cut = select_physical_cut(dbt, rip)
        if cut is None:
            rejected.append({
                'rip': '%016x' % rip,
                'operation': 'missing-cut',
            })
            continue
        retain_cut(cut)
    cut_finished = perf_counter()

    metadata, memory, resident_by_proof = \
        load_native_x86_physical_machine(machine_payload)
    load_finished = perf_counter()
    matched_coordinates, catalog_report = match_seed_catalog(
        state.cpu, seed_rip, seed_catalog)
    seed_coordinates = tuple(sorted(
        set(seed_coordinates).union(matched_coordinates)))

    # Build-time ELF instruction catalogs provide exact decoder entry
    # coordinates for stripped static executables.  Probe execute permission
    # once per 4 KiB page in the saved cut, then decode only resident pages.
    # Seeding happens after the realized trace so it cannot perturb oracle
    # block grouping or timer retirement.  Unsupported speculative entries
    # remain visible in seed_catalog, but do not make required closure fail.
    seed_cpu = state.cpu
    executable_pages = {}
    seeded_coordinates = set()
    seed_variants = {}
    seed_dbt = X86DBT()
    seed_batch_blocks = 0
    seed_rejected = []
    seed_rejected_count = 0
    seed_required_rips_skipped = 0
    for rip in seed_coordinates:
        rip = int(rip) & ((1 << 64) - 1)
        if rip in required_rips:
            seed_required_rips_skipped += 1
            continue
        page = int(rip) >> 12
        executable = executable_pages.get(page)
        if executable is None:
            try:
                read_virtual(seed_cpu, page << 12, 1, 'execute')
                executable = True
            except PageFault:
                executable = False
            executable_pages[page] = executable
        if not executable:
            continue
        try:
            cut = seed_dbt.block(replace(seed_cpu, rip=rip))
            packed_records = pack_native_x86_records(cut)
        except (PageFault, StatePageError, TypeError, ValueError,
                X86Error) as error:
            seed_rejected_count += 1
            if len(seed_rejected) < 32:
                seed_rejected.append({
                    'rip': '%016x' % rip,
                    'reason': str(error),
                })
            continue
        # Seed cuts are a build-time superset, not future-visible state.  Keep
        # their compact physical records immediately and release each SSA cut
        # before decoding the next symbol.  Retaining thousands of Python
        # graphs here made System.map seeding scale with the unpacked compiler
        # representation and could exhaust host memory.
        for coordinate, record in packed_records:
            coordinate = int(coordinate) & ((1 << 64) - 1)
            _fields, guard, _physical = physical_native_x86_record(
                record, coordinate)
            proof = coordinate, guard
            internal = coordinate != rip
            prior = seed_variants.get(proof)
            if prior is None or (prior[1] and not internal):
                seed_variants[proof] = record, internal
        seeded_coordinates.add(rip)
        seed_batch_blocks += 1
        if seed_batch_blocks >= 256:
            # X86DBT deliberately caches decoded blocks and normalization
            # proofs for runtime reuse.  Catalog seeding has already converted
            # them to immutable records, so retaining that cache would make
            # build memory proportional to every symbol in a large kernel.
            seed_dbt = X86DBT()
            seed_batch_blocks = 0
    seed_finished = perf_counter()
    records = list(canonical_native_x86_packed_records(packed_blocks))
    del packed_blocks
    records.extend((coordinate, record)
                   for (coordinate, _guard), (record, _internal)
                   in seed_variants.items())
    record_finished = perf_counter()
    # Close the same static descriptor edges as the initial artifact build.
    # Retry records often end at the next instruction coordinate; requiring a
    # second runtime miss for an edge already named by the descriptor is an
    # avoidable N+1 admission path.
    # Bulk closure is monotone by proof, not by virtual RIP.  Linux routinely
    # maps unrelated ET_EXEC images at the same coordinates, so treating one
    # resident RIP as complete prevents the first cut in a new process image
    # from closing any of its neighbours.  Equal (RIP, source guard) proofs
    # retain the published physical record; a distinct guard is an independent
    # executable identity and may be appended without changing first-match
    # semantics.
    retained_records = []
    skipped_known_proofs = set()
    optimized_replacements = []
    for candidate_rip, candidate_record in records:
        candidate_rip = int(candidate_rip) & ((1 << 64) - 1)
        fields, candidate_guard, candidate_physical = \
            physical_native_x86_record(candidate_record, candidate_rip)
        proof = candidate_rip, candidate_guard
        prior = resident_by_proof.get(proof)
        if prior is not None:
            skipped_known_proofs.add(proof)
            if prior != candidate_physical:
                optimized_replacements.append((
                    candidate_rip, int(fields[6])))
            continue
        retained_records.append((candidate_rip, candidate_record))
    records = retained_records
    known_proofs = set(resident_by_proof)
    for rip, record in records:
        _fields, guard, _physical = physical_native_x86_record(record, rip)
        known_proofs.add((int(rip) & ((1 << 64) - 1), guard))
    # A changed image can enter through a short prefix whose exact proof is
    # shared with an older image, then diverge a few blocks later.  Cross a
    # small number of already-closed proofs to find that divergence, but do
    # not recursively reopen the resident kernel graph.
    known_bridge = 4
    frontier = [(rip, record, known_bridge) for rip, record in records]
    attempted = set()
    expanded = set()
    decoded_coordinates = set(native_x86_cut_coordinates(dbt))
    static_records = 0
    reused_decoded_coordinates = 0
    while frontier and len(attempted) < 65536:
        successor_bridges = {}
        for rip, record, bridge in frontier:
            _fields, guard, _physical = physical_native_x86_record(record, rip)
            proof = int(rip) & ((1 << 64) - 1), guard
            if proof in expanded:
                continue
            expanded.add(proof)
            for successor in native_x86_static_successors(record):
                successor_bridges[successor] = max(
                    bridge, successor_bridges.get(successor, -1))
        frontier = []
        next_frontier = []
        for rip in sorted(set(successor_bridges).difference(attempted)):
            if len(attempted) >= 65536:
                break
            bridge = successor_bridges[rip]
            attempted.add(rip)
            # A threaded physical_block publishes every decoded interior entry
            # into this DBT.  Static successors frequently name one of those
            # entries again.  Rebuilding its complete SSA graph is redundant
            # and, on a kernel-sized closure, retains enough transient Python
            # tuples to exhaust the host before the next checkpoint.  The DBT
            # is tied to this immutable terminal memory image, so its strongest
            # already-decoded cut is the exact proof needed here.
            if rip in decoded_coordinates:
                cut = select_physical_cut(dbt, rip)
                if cut is None:
                    continue
                candidate_cuts = {rip: cut}
                reused_decoded_coordinates += 1
            else:
                decoded_revision = dbt.decoded_block_revision()
                try:
                    cut = dbt.physical_block(replace(state.cpu, rip=rip))
                except (PageFault, StatePageError, TypeError, ValueError,
                        X86Error):
                    continue
                # physical_block may thread a whole connected component while
                # returning one maximal cut.  Any interior basic-block entry
                # can later become visible at a page, fault, or scheduling
                # boundary; publish every entry decoded by this traversal now
                # instead of admitting it through another runtime miss.
                new_coordinates = set(
                    dbt.decoded_block_coordinates_since(decoded_revision))
                new_coordinates.difference_update(decoded_coordinates)
                decoded_coordinates.update(new_coordinates)
                candidate_cuts = {int(cut.rip) & ((1 << 64) - 1): cut}
                for coordinate in new_coordinates:
                    selected = select_physical_cut(dbt, coordinate)
                    if selected is not None:
                        candidate_cuts[coordinate] = selected
            for candidate in candidate_cuts.values():
                try:
                    packed = pack_native_x86_records(candidate)
                except (StatePageError, TypeError, ValueError):
                    continue
                for coordinate, record in packed:
                    _fields, guard, _physical = physical_native_x86_record(
                        record, coordinate)
                    proof = (int(coordinate) & ((1 << 64) - 1), guard)
                    if proof in known_proofs:
                        # This exact source proof was already closed when the
                        # resident artifact was built.  Re-expanding it turns
                        # one changed userspace image or patched kernel page
                        # into a traversal of the entire old CFG.
                        if bridge > 0 and proof not in expanded:
                            next_frontier.append(
                                (coordinate, record, bridge - 1))
                        continue
                    known_proofs.add(proof)
                    records.append((coordinate, record))
                    next_frontier.append(
                        (coordinate, record, known_bridge))
                    static_records += 1
        frontier = next_frontier
    static_finished = perf_counter()
    extended = extend_loaded_native_x86_physical_machine(
        metadata, memory, resident_by_proof, records,
        reject_conflicts=False,
        replace_proved=False)
    encode_finished = perf_counter()
    return extended, {
        'budget': int(budget),
        'consumed_instructions': int(budget) - remaining,
        'handled_events': dict(sorted(handled.items())),
        'console_bytes': len(console),
        'console_tail': bytes(console[-4096:]).decode(
            'utf-8', errors='replace'),
        'records': len(records),
        'static_records': static_records,
        'reused_decoded_coordinates': reused_decoded_coordinates,
        'bulk_existing_proofs_skipped': len(skipped_known_proofs),
        'seed_catalog': {
            'coordinates': len(tuple(seed_coordinates)),
            'executable_pages': sum(executable_pages.values()),
            'decoded': len(seeded_coordinates),
            'required_rips_skipped': seed_required_rips_skipped,
            'rejected': seed_rejected_count,
            'rejected_sample': seed_rejected,
            'object_catalog': catalog_report,
        },
        'optimized_replacements': len(optimized_replacements),
        'optimized_replacement_controls': dict(sorted(Counter(
            control for _rip, control in optimized_replacements).items())),
        'optimized_replacement_sample': [
            {'rip': '%016x' % rip, 'control': control}
            for rip, control in optimized_replacements[:32]],
        'added_bytes': len(extended) - len(machine_payload),
        'timing_ms': {
            'trace': (trace_finished - started) * 1000.0,
            'cut_projection': (cut_finished - trace_finished) * 1000.0,
            'machine_load': (load_finished - cut_finished) * 1000.0,
            'seed_projection': (seed_finished - load_finished) * 1000.0,
            'record_projection': (record_finished - seed_finished) * 1000.0,
            'static_closure': (static_finished - record_finished) * 1000.0,
            'canonical_encode': (encode_finished - static_finished) * 1000.0,
            'total': (encode_finished - started) * 1000.0,
        },
        'terminal_rip': '%016x' % terminal.cpu.rip,
        'terminal_event': None if event is None else event.operation,
        'halted': bool(terminal.cpu.halted),
        'stalled': stalled,
        'grammar_misses': {
            'count': len(rejected),
            'by_operation': dict(sorted(Counter(
                item['operation'] for item in rejected).items())),
            'sample': rejected[:32],
        },
        'layout': dbt.layout(),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    parser.add_argument('--machine', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path)
    # Retain the exact runtime cut, then follow its realized state across
    # deterministic interrupt/output barriers.  A wider slice amortizes one
    # build-oracle launch over the whole nearby workload while static edge
    # closure below admits both sides of every proved conditional descriptor.
    parser.add_argument('--budget', type=int, default=262144)
    parser.add_argument('--max-internal', type=int, default=64)
    parser.add_argument(
        '--seed-addresses', type=Path,
        help=('newline-delimited x86 instruction coordinates from a trusted '
              'build-time ELF disassembly; only execute-mapped pages in the '
              'saved cut are decoded'))
    parser.add_argument(
        '--seed-catalog', type=Path,
        help=('content-addressed ELF executable-page catalog; when the exact '
              'runtime page matches, every resident page of that object is '
              'seeded without confusing executables that share a RIP'))
    arguments = parser.parse_args(argv)

    state, source_identity, dirty_pages = load_runtime_cut(
        arguments.artifact_root, arguments.source, arguments.snapshot)
    seed_coordinates = load_seed_coordinates(arguments.seed_addresses)
    seed_catalog = load_seed_catalog(arguments.seed_catalog)
    machine_payload = arguments.machine.read_bytes()
    extended, report = close(
        machine_payload, state, arguments.budget, arguments.max_internal,
        seed_coordinates, seed_catalog)
    report.update({
        'kind': 'native-x86-runtime-closure-v1',
        'source_identity': source_identity,
        'dirty_pages': dirty_pages,
        'before_bytes': len(machine_payload),
        'after_bytes': len(extended),
    })
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(extended)
    encoded = json.dumps(report, indent=2, sort_keys=True) + '\n'
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(encoded, encoding='utf-8', newline='\n')
    print(encoded, end='')
    return int(bool(report['grammar_misses']['count']))


if __name__ == '__main__':
    raise SystemExit(main())
