"""Normalize closed arithmetic before state-step page encoding."""

from . import isa
from .bits import mask_of
from .laneops import select
from .wasmphysical import schedule_sequence


def _slice_sequence(plan):
    """Return a canonical normalized one-coordinate island, if closed."""
    roots = {operand.value for operand in plan.stack + plan.locals
             if operand.kind == 'node'}
    if len(roots) != 1 or not plan.nodes:
        return None
    root = next(iter(roots))
    live = set()
    pending = [root]
    while pending:
        value = pending.pop()
        if value in live:
            continue
        live.add(value)
        pending.extend(operand.value
                       for operand in plan.nodes[value - 1].arguments
                       if operand.kind == 'node')
    if len(live) != len(plan.nodes):
        return None

    external = {operand for node in plan.nodes for operand in node.arguments
                if operand.kind in ('stack', 'local')}
    if len(external) != 1:
        return None
    input_operand = next(iter(external))

    kinds = {node.op.split('.', 1)[0] for node in plan.nodes
             if node.op.startswith(('i32.', 'i64.'))}
    if len(kinds) != 1:
        return None
    kind = next(iter(kinds))
    if any(not node.op.startswith(kind + '.')
           or node.op.split('.', 1)[1]
           in ('div_s', 'div_u', 'rem_s', 'rem_u')
           for node in plan.nodes):
        return None
    bits = 32 if kind == 'i32' else 64
    mask = mask_of(bits)
    before = isa.Seq()
    values = {}

    def item(operand):
        if operand.kind == 'const':
            return 'const', operand.value & mask
        if operand.kind == 'node':
            return 'value', values[operand.value]
        if operand == input_operand:
            return 'value', 0
        raise ValueError('a QM island acquired a second input coordinate')

    def number(value):
        return value[1] if value[0] == 'const' else None

    def reference(value):
        if value[0] == 'value':
            return value[1]
        zero = before.emit('AND', [0], const=0)
        return before.emit('OR', [zero], const=value[1]) if value[1] else zero

    def wrap(value, needed=True):
        if bits == 32 and needed:
            value = before.emit('AND', [value], const=mask)
        return 'value', value

    try:
        for node in plan.nodes:
            name = node.op.split('.', 1)[1]
            arguments = tuple(item(operand) for operand in node.arguments)
            if name == 'extend_i32_u' and node.op.startswith('i64.'):
                # An i32 frame value is already published in [0, 2^32), so
                # unsigned extension changes only its observer, not its lane.
                result = arguments[0]
            elif name == 'wrap_i64' and node.op.startswith('i32.'):
                result = wrap(before.emit(
                    'AND', [reference(arguments[0])], const=mask), False)
            elif name in ('extend_i32_s', 'extend8_s', 'extend16_s',
                          'extend32_s'):
                source_bits = {
                    'extend_i32_s': 32,
                    'extend8_s': 8,
                    'extend16_s': 16,
                    'extend32_s': 32,
                }[name]
                shift = bits - source_bits
                value = before.emit('SHL', [reference(arguments[0])],
                                    shift=shift)
                result = wrap(before.emit('SAR', [value], shift=shift), False)
            elif name in ('clz', 'ctz', 'popcnt'):
                op = {'clz': 'CLZ', 'ctz': 'CTZ',
                      'popcnt': 'POPCNT'}[name]
                result = wrap(before.emit(op, [reference(arguments[0])]),
                              False)
            elif len(arguments) == 2 and name in (
                    'add', 'sub', 'mul', 'and', 'or', 'xor',
                    'shl', 'shr_u', 'shr_s'):
                left, right = arguments
                a, b = number(left), number(right)
                if name in ('shl', 'shr_u', 'shr_s'):
                    if b is None:
                        return None
                    op = {'shl': 'SHL', 'shr_u': 'SHR',
                          'shr_s': 'SAR'}[name]
                    result = wrap(before.emit(
                        op, [reference(left)], shift=b % bits),
                        name in ('shl', 'shr_s'))
                elif name in ('and', 'or', 'xor'):
                    immediate = {'and': 'AND', 'or': 'OR', 'xor': 'XOR'}[name]
                    register = {'and': 'ANDR', 'or': 'ORR',
                                'xor': 'XORR'}[name]
                    if b is not None:
                        value = before.emit(immediate, [reference(left)],
                                            const=b)
                    elif a is not None:
                        value = before.emit(immediate, [reference(right)],
                                            const=a)
                    else:
                        value = before.emit(register,
                                            [reference(left), reference(right)])
                    result = wrap(value, False)
                elif name == 'add':
                    if b is not None:
                        value = before.emit('ADD', [reference(left)], const=b)
                    elif a is not None:
                        value = before.emit('ADD', [reference(right)], const=a)
                    else:
                        value = before.emit('ADDR',
                                            [reference(left), reference(right)])
                    result = wrap(value)
                elif name == 'sub':
                    if b is not None:
                        value = before.emit('SUB', [reference(left)], const=b)
                    elif a is not None:
                        value = before.emit('NEG', [reference(right)])
                        value = before.emit('ADD', [value], const=a)
                    else:
                        value = before.emit('SUBR',
                                            [reference(left), reference(right)])
                    result = wrap(value)
                else:
                    if b is not None:
                        value = before.emit('IMUL', [reference(left)], const=b)
                    elif a is not None:
                        value = before.emit('IMUL', [reference(right)], const=a)
                    else:
                        return None
                    result = wrap(value)
            else:
                return None
            values[node.value] = result[1]
    except (IndexError, ValueError):
        return None
    before.result = values[root]
    before = isa.dead_code(before)
    after = isa.normalize(before)
    if bits == 32:
        # A state page's width-qualified lanes mask every publication. The explicit
        # i32 masks above are proof markers needed while 64-bit isa.normalize
        # reasons about the expression; they are not executable work in the
        # selected 32-bit physical domain.
        compact = isa.Seq()
        remap = {0: 0}
        for index, instruction in enumerate(after.ins, start=1):
            if instruction.op == 'AND' and instruction.const == mask:
                remap[index] = remap[instruction.args[0]]
            else:
                remap[index] = compact.emit(
                    instruction.op, [remap[arg] for arg in instruction.args],
                    instruction.const, instruction.shift)
        compact.result = remap[after.result]
        after = isa.dead_code(compact)
    return after, bits, input_operand, root


def _physical_plan(plan):
    """Select a lane primitive for every node; raw frontend ops cannot pass."""
    from .wasmwave import PureSlice, WaveNode

    nodes = []
    for node in plan.nodes:
        operation, arguments = select(node.op, node.arguments)
        nodes.append(WaveNode(node.value, operation, tuple(arguments)))
    return PureSlice(
        plan.function, plan.start, plan.end, plan.instructions,
        plan.stack_inputs, tuple(nodes), plan.waves, plan.stack, plan.locals)


def normalize_plan(plan):
    """Produce the sole canonical physical plan for one pure state step."""
    normalized = _slice_sequence(plan)
    if normalized is None:
        return _physical_plan(plan)
    after, bits, input_operand, old_root = normalized
    from .wasmwave import Operand, PureSlice, WaveNode

    nodes = []
    for instruction in after.ins:
        arguments = [input_operand if value == 0
                     else Operand('node', value)
                     for value in instruction.args]
        constants = instruction.const
        if constants is not None:
            if not isinstance(constants, (tuple, list)):
                constants = (constants,)
            arguments.extend(Operand('const', value) for value in constants)
        if instruction.shift is not None:
            arguments.append(Operand('const', instruction.shift))
        value = len(nodes) + 1
        nodes.append(WaveNode(value, 'lane%d.%s' % (bits, instruction.op),
                              tuple(arguments)))
    replacement = (input_operand if after.result == 0
                   else Operand('node', after.result))

    def output(operand):
        return replacement if operand == Operand('node', old_root) else operand

    return PureSlice(
        plan.function, plan.start, plan.end, plan.instructions,
        plan.stack_inputs, tuple(nodes), schedule_sequence(after),
        tuple(map(output, plan.stack)), tuple(map(output, plan.locals)))
