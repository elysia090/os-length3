"""Columnar physical layout for decoded WebAssembly instructions.

The logical instruction domain is the segmented product ``(function, pc)``.
One dense rank names each defined instruction. Opcode values are dictionary
coded, immediate operands use offsets into one packed column, and a second view
groups equal opcodes into contiguous spans. Ordinary fallthrough is derived as
``rank + 1`` inside a function segment and therefore needs no successor table.

This is layout metadata, not another evaluator. Execution continues to use the
exact instruction semantics in :mod:`qm.wasmstate`; the layout supplies the
coordinates needed by a compact state-step compiler.
"""

from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass

from .wasmstate import MEMORY_PAGE


@dataclass(frozen=True)
class SegmentedInstructions:
    """Dense ranks for a sequence of variable-length function segments."""

    offsets: tuple

    @property
    def functions(self):
        return len(self.offsets) - 1

    @property
    def instructions(self):
        return self.offsets[-1] if self.offsets else 0

    def rank(self, function, pc):
        if function < 0 or function >= self.functions:
            raise IndexError('wasm function coordinate is out of range')
        start, end = self.offsets[function:function + 2]
        if pc < 0 or start + pc >= end:
            raise IndexError('wasm instruction coordinate is out of range')
        return start + pc

    def select(self, rank):
        if rank < 0 or rank >= self.instructions:
            raise IndexError('wasm instruction rank is out of range')
        function = bisect_right(self.offsets, rank) - 1
        return function, rank - self.offsets[function]

    def next_coordinate(self, rank):
        function, _pc = self.select(rank)
        return rank + 1 if rank + 1 < self.offsets[function + 1] else -1

    # Compatibility name for the first version of the layout API.
    fallthrough = next_coordinate


@dataclass(frozen=True)
class GroupedInstructions:
    """A grouped-span view over the same dense instruction ranks."""

    names: tuple
    offsets: tuple
    ranks: tuple
    position: tuple

    def span(self, name):
        code = self.names.index(name)
        return self.ranks[self.offsets[code]:self.offsets[code + 1]]


@dataclass(frozen=True)
class DependencyWaves:
    """Independent SSA writes grouped by their dependency depth."""

    offsets: tuple
    values: tuple
    depth: tuple

    @property
    def span(self):
        return len(self.offsets) - 1

    @property
    def work(self):
        return len(self.values)

    def wave(self, depth):
        if depth < 1 or depth > self.span:
            raise IndexError('dependency wave is out of range')
        return self.values[self.offsets[depth - 1]:self.offsets[depth]]

    def layout(self):
        widths = [self.offsets[index + 1] - self.offsets[index]
                  for index in range(self.span)]
        return {
            'kind': 'dependency-waves',
            'work': self.work,
            'span': self.span,
            'wave_widths': widths,
            'max_parallel_width': max(widths, default=0),
        }


@dataclass(frozen=True)
class PhysicalWasm:
    domain: SegmentedInstructions
    opcode_names: tuple
    opcode_codes: bytes
    argument_offsets: tuple
    arguments: tuple
    groups: GroupedInstructions

    def instruction(self, function, pc):
        rank = self.domain.rank(function, pc)
        code = self.opcode_codes[rank]
        begin, end = self.argument_offsets[rank:rank + 2]
        return self.opcode_names[code], self.arguments[begin:end]

    def layout(self):
        return {
            'kind': 'physical-wasm',
            'functions': self.domain.functions,
            'instructions': self.domain.instructions,
            'opcode_dictionary': list(self.opcode_names),
            'opcode_groups': {
                name: self.groups.offsets[index + 1]
                      - self.groups.offsets[index]
                for index, name in enumerate(self.groups.names)
            },
            'argument_values': len(self.arguments),
            'next_coordinate_storage': 0,
            'memory_page_bytes': MEMORY_PAGE,
        }


def lower_module(module):
    """Build both physical views without materializing any state transitions."""
    function_offsets = [0]
    names = []
    name_to_code = {}
    codes = bytearray()
    argument_offsets = [0]
    arguments = []

    for function in module.functions:
        for instruction in function.code:
            code = name_to_code.get(instruction.op)
            if code is None:
                code = len(names)
                if code >= 256:
                    raise ValueError('physical wasm opcode dictionary exceeds one byte')
                name_to_code[instruction.op] = code
                names.append(instruction.op)
            codes.append(code)
            for value in instruction.args:
                if not isinstance(value, int):
                    raise ValueError('wasm instruction operand is not an integer')
                arguments.append(value)
            argument_offsets.append(len(arguments))
        function_offsets.append(len(codes))

    counts = [0] * len(names)
    for code in codes:
        counts[code] += 1
    group_offsets = [0]
    for count in counts:
        group_offsets.append(group_offsets[-1] + count)
    cursor = group_offsets[:-1].copy()
    grouped_ranks = [0] * len(codes)
    position = [0] * len(codes)
    for rank, code in enumerate(codes):
        placed = cursor[code]
        cursor[code] += 1
        grouped_ranks[placed] = rank
        position[rank] = placed

    groups = GroupedInstructions(
        tuple(names), tuple(group_offsets), tuple(grouped_ranks),
        tuple(position),
    )
    return PhysicalWasm(
        SegmentedInstructions(tuple(function_offsets)),
        tuple(names), bytes(codes), tuple(argument_offsets), tuple(arguments),
        groups,
    )


def schedule_sequence(sequence):
    """Schedule an SSA DAG; values in one wave have no mutual dependency."""
    depths = [0]
    by_depth = {}
    for value, instruction in enumerate(sequence.ins, start=1):
        if instruction.op in ('WASM_PARAM', 'WASM_ZERO'):
            depths.append(0)
            continue
        depth = 1 + max((depths[source] for source in instruction.args),
                        default=0)
        depths.append(depth)
        by_depth.setdefault(depth, []).append(value)
    offsets = [0]
    values = []
    for depth in range(1, max(by_depth, default=0) + 1):
        values.extend(by_depth.get(depth, ()))
        offsets.append(len(values))
    return DependencyWaves(tuple(offsets), tuple(values), tuple(depths))


def frame_coordinate(frame_base, index):
    """Affine slot used by locals and the operand stack in one call frame."""
    if frame_base < 0 or index < 0:
        raise ValueError('frame coordinates must be nonnegative')
    return frame_base + index


def memory_coordinate(address):
    """Split a linear-memory address into the shared page and byte axes."""
    if address < 0:
        raise ValueError('memory address must be nonnegative')
    return divmod(address, MEMORY_PAGE)


def summarize_binary(data):
    """Measure the physical columns of a large module without retaining them."""
    # Local import keeps the executable state decoder independent of the
    # large-binary indexing path.
    from .wasmbinary import index_module

    index = index_module(data)
    opcodes = Counter()
    instructions = 0
    argument_values = 0
    nonempty_functions = 0
    failures = []
    for body in index.bodies:
        try:
            _locals, code, _ends, _elses = index.decode(body)
        except Exception as error:
            failures.append({
                'function_index': body.function_index,
                'reason': str(error),
            })
            continue
        if code:
            nonempty_functions += 1
        instructions += len(code)
        for instruction in code:
            opcodes[instruction.op] += 1
            argument_values += len(instruction.args)
    return {
        'functions': len(index.bodies),
        'imported_functions': index.imported_functions,
        'decoded_functions': len(index.bodies) - len(failures),
        'decode_failures': failures,
        'instructions': instructions,
        'nonempty_functions': nonempty_functions,
        'opcode_dictionary': len(opcodes),
        'opcode_groups': dict(sorted(opcodes.items())),
        'argument_values': argument_values,
        'derived_next_coordinates': instructions - nonempty_functions,
        'next_coordinate_storage': 0,
        'memory_page_bytes': MEMORY_PAGE,
    }
