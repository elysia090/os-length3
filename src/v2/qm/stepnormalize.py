"""Normalize closed arithmetic before state-step page encoding."""

from . import isa
from .bits import mask_of
from .laneops import select


def _backward_nodes(plan, root):
    """Node coordinates that can affect one future-visible output."""
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
    return live


def _slice_sequence(plan, root):
    """Normalize one future-visible SSA residual, if its slice is closed."""
    if not plan.nodes or root < 1 or root > len(plan.nodes):
        return None
    live = _backward_nodes(plan, root)
    external = {operand for node in plan.nodes if node.value in live
                for operand in node.arguments
                if operand.kind in ('stack', 'local')}
    if len(external) != 1:
        return None
    input_operand = next(iter(external))

    kinds = {node.op.split('.', 1)[0] for node in plan.nodes
             if node.value in live
             if node.op.startswith(('i32.', 'i64.'))}
    if len(kinds) != 1:
        return None
    kind = next(iter(kinds))
    if any(not node.op.startswith(kind + '.')
           or node.op.split('.', 1)[1]
           in ('div_s', 'div_u', 'rem_s', 'rem_u')
           for node in plan.nodes if node.value in live):
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
            if node.value not in live:
                continue
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
            elif name in ('clz', 'ctz', 'popcnt', 'bswap'):
                op = {'clz': 'CLZ', 'ctz': 'CTZ',
                      'popcnt': 'POPCNT', 'bswap': 'BSWAP'}[name]
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
        # Propagate the future observer backward through the selected SSA. A
        # width-qualified lane masks every publication, so an earlier AND that
        # preserves every bit a later shift can expose is an identity in the
        # quotient even when 64-bit normalization needed it as a proof marker.
        required = [0] * (len(after.ins) + 1)
        required[after.result] = mask
        for index in range(len(after.ins), 0, -1):
            instruction = after.ins[index - 1]
            observed = required[index]
            if not observed:
                continue
            if instruction.op == 'SHL':
                inputs = observed >> instruction.shift
            elif instruction.op == 'SHR':
                inputs = (observed << instruction.shift) & mask
            elif instruction.op == 'SAR':
                inputs = (observed << instruction.shift) & mask
                filled = mask ^ mask_of(32 - instruction.shift)
                if observed & filled:
                    inputs |= 1 << 31
            elif instruction.op == 'AND' and instruction.const is not None:
                inputs = observed & int(instruction.const)
            else:
                inputs = mask
            for argument in instruction.args:
                required[argument] |= inputs

        compact = isa.Seq()
        remap = {0: 0}
        for index, instruction in enumerate(after.ins, start=1):
            if (instruction.op == 'AND'
                    and instruction.const is not None
                    and (int(instruction.const) & required[index])
                    == required[index]):
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
        if node.op.startswith('memory.'):
            operation, arguments = node.op, node.arguments
            # WebAssembly linear memory is an untyped byte array. Floating
            # loads and stores only change the register view of the same IEEE
            # bit pattern, so the physical memory lane is exactly the matching
            # integer-width access. This also lets load/select/store move bits
            # without materializing a host floating value.
            operation = (operation
                         .replace('memory.f32.', 'memory.i32.')
                         .replace('memory.f64.', 'memory.i64.'))
        else:
            operation, arguments = select(node.op, node.arguments)
        nodes.append(WaveNode(node.value, operation, tuple(arguments)))
    return PureSlice(
        plan.function, plan.start, plan.end, plan.instructions,
        plan.stack_inputs, tuple(nodes), plan.waves, plan.stack, plan.locals)


def _reopen_consumed_x86_alu(nodes, stack, locals_):
    """Expose a consumed ALU result to larger backward normal forms.

    X86_ALU is the canonical one-lane representation of arithmetic plus
    flags.  Once separately normalized blocks are composed, however, its
    result projection may become an internal input to a larger memory
    transaction. Reopening those projections restores the ordinary SSA
    spelling before memory recomposition; the final observer-aware pass fuses
    any arithmetic and flags that remain genuinely adjacent.
    """
    from .steppage import (decode_projection_coordinate,
                           projection_coordinate)
    from .wasmwave import Operand, WaveNode

    consumed = set()
    live_flags = set()
    for operand in tuple(stack) + tuple(locals_):
        if operand.kind == 'node':
            live_flags.add(operand.value)
        elif operand.kind == 'projection':
            source, selector = decode_projection_coordinate(operand.value)
            if selector != 16:
                live_flags.add(source)
    for node in nodes:
        descriptor = (node.arguments[3].value
                      if node.op == 'lane64.X86_ALU'
                      and len(node.arguments) == 4
                      and node.arguments[3].kind == 'const' else None)
        for index, operand in enumerate(node.arguments):
            if operand.kind == 'node':
                # A non-carry ALU preserves only flag bits that all preceding
                # ALUs also preserve, so its prior-flags edge is peeled to the
                # common root rather than keeping an intermediate producer.
                peeled_prior = (index == 0 and descriptor is not None
                                and (descriptor >> 8) & 7 in (1, 3)
                                and not descriptor & (1 << 11))
                if not peeled_prior:
                    live_flags.add(operand.value)
            if operand.kind != 'projection':
                continue
            source, selector = decode_projection_coordinate(operand.value)
            if selector == 16:
                consumed.add(source)
            else:
                live_flags.add(source)
    if not consumed:
        return tuple(nodes), tuple(stack), tuple(locals_)

    remap = {}
    results = {}
    flag_roots = {}
    rewritten = []

    def resolve(operand):
        if operand.kind == 'node':
            return remap[operand.value]
        if operand.kind != 'projection':
            return operand
        source, selector = decode_projection_coordinate(operand.value)
        if selector == 16 and source in results:
            return results[source]
        mapped = remap[source]
        if mapped.kind != 'node':
            raise ValueError('a live ALU projection lost its flag producer')
        return Operand('projection', projection_coordinate(
            mapped.value, selector))

    for node in nodes:
        arguments = tuple(map(resolve, node.arguments))
        descriptor = (node.arguments[3].value
                      if node.op == 'lane64.X86_ALU'
                      and len(node.arguments) == 4
                      and node.arguments[3].kind == 'const' else None)
        width = None if descriptor is None else descriptor & 0x7f
        mode = None if descriptor is None else (descriptor >> 8) & 7
        if (node.value in consumed and width in (8, 16, 32, 64)
                and mode in (0, 1, 3, 5, 6)):
            prior = arguments[0]
            original_prior = node.arguments[0]
            if (not descriptor & (1 << 11)
                    and original_prior.kind == 'node'):
                prior = flag_roots.get(original_prior.value, prior)
            result = Operand('node', len(rewritten) + 1)
            semantic = {
                0: 'and', 1: 'add', 3: 'sub',
                5: 'or', 6: 'xor',
            }[mode]
            arithmetic, arithmetic_arguments = select(
                'i%d.%s' % (width, semantic), arguments[1:3])
            rewritten.append(WaveNode(
                result.value, arithmetic, arithmetic_arguments))
            if node.value in live_flags:
                flags = Operand('node', len(rewritten) + 1)
                rewritten.append(WaveNode(
                    flags.value, 'lane64.X86_FLAGS',
                    (prior,) + arguments[1:3] + (result, arguments[3])))
                remap[node.value] = flags
            else:
                remap[node.value] = prior
            results[node.value] = result
            flag_roots[node.value] = prior
            continue
        value = len(rewritten) + 1
        rewritten.append(WaveNode(value, node.op, arguments))
        remap[node.value] = Operand('node', value)

    return (tuple(rewritten), tuple(map(resolve, stack)),
            tuple(map(resolve, locals_)))


def _fuse_live_x86_alu(nodes, stack, locals_):
    """Share one ALU lane after every live result observer is explicit.

    During forward rebuilding, a result can acquire a consumer from a later
    composed block that was not visible when its FLAGS node was first seen.
    At this final SSA graph there are no hidden CSE aliases: replace the
    arithmetic producer, route all of its value consumers through selector 16,
    and route flag consumers through the primary result.  One candidate is
    fused per fixed-point pass so coordinate renaming stays mechanical.
    """
    from .steppage import (decode_projection_coordinate,
                           projection_coordinate)
    from .wasmwave import Operand, WaveNode

    by_value = {node.value: node for node in nodes}
    def constant(operand):
        return operand.value if operand.kind == 'const' else None

    def modulo(operand, width):
        mask = mask_of(width)
        if operand.kind == 'const':
            return Operand('const', operand.value & mask)
        node = by_value.get(operand.value) if operand.kind == 'node' else None
        if (node is not None and node.op == 'lane64.AND'
                and len(node.arguments) == 2):
            left, right = node.arguments
            if constant(right) == mask:
                return modulo(left, width)
            if constant(left) == mask:
                return modulo(right, width)
        return operand

    def result_mode(flags, result):
        descriptor = constant(flags.arguments[4])
        if descriptor is None:
            return None
        width = descriptor & 0x7f
        mode = (descriptor >> 8) & 7
        if width not in (8, 16, 32, 64):
            return None
        left, right = (modulo(argument, width)
                       for argument in flags.arguments[1:3])
        source = result
        while (source.op == 'lane64.AND'
               and len(source.arguments) == 2
               and constant(source.arguments[1]) == mask_of(width)
               and source.arguments[0].kind == 'node'):
            source = by_value.get(source.arguments[0].value)
            if source is None:
                return None
        actual = tuple(modulo(argument, width)
                       for argument in source.arguments)
        expected = (left, right)
        name = source.op.split('.', 1)[-1]
        if mode in (0, 5, 6):
            logical = {
                'AND': 0, 'ANDR': 0,
                'OR': 5, 'ORR': 5,
                'XOR': 6, 'XORR': 6,
            }.get(name)
            if (logical is not None and mode in (0, logical)
                    and (actual == expected or actual == expected[::-1])):
                return logical
        if mode == 1 and name in ('ADD', 'ADDR') \
                and (actual == expected or actual == expected[::-1]):
            return mode
        if mode == 3:
            if name in ('SUB', 'SUBR') and actual == expected:
                return mode
            if name in ('ADD', 'ADDR') and len(actual) == 2:
                negated = (None if constant(right) is None else
                           Operand('const', (-constant(right))
                                   & mask_of(width)))
                if (negated is not None
                        and (actual == (left, negated)
                             or actual == (negated, left))):
                    return mode
        return None

    candidate = None
    for flags in nodes:
        if flags.op != 'lane64.X86_FLAGS' or len(flags.arguments) != 5:
            continue
        result_operand = flags.arguments[3]
        if result_operand.kind != 'node':
            continue
        result = by_value.get(result_operand.value)
        if result is None or result.op.startswith('memory.'):
            continue
        mode = result_mode(flags, result)
        descriptor = constant(flags.arguments[4])
        if mode is None or descriptor is None:
            continue
        width = descriptor & 0x7f
        alu_arguments = (
            flags.arguments[0], modulo(flags.arguments[1], width),
            modulo(flags.arguments[2], width), Operand(
                'const', (descriptor & ~(7 << 8)) | (mode << 8)))
        dependencies = []
        for operand in alu_arguments:
            if operand.kind == 'node':
                dependencies.append(operand.value)
            elif operand.kind == 'projection':
                dependencies.append(decode_projection_coordinate(
                    operand.value)[0])
        if any(dependency >= result.value for dependency in dependencies):
            continue
        candidate = result, flags, alu_arguments
        break
    if candidate is None:
        return tuple(nodes), tuple(stack), tuple(locals_)

    result, flags, alu_arguments = candidate
    dense = {}
    rewritten = []
    for node in nodes:
        if node.value == flags.value:
            continue
        value = len(rewritten) + 1
        dense[node.value] = value
        if node.value == result.value:
            arguments = tuple(
                Operand('node', dense[operand.value])
                if operand.kind == 'node'
                else Operand('projection', projection_coordinate(
                    dense[decode_projection_coordinate(operand.value)[0]],
                    decode_projection_coordinate(operand.value)[1]))
                if operand.kind == 'projection' else operand
                for operand in alu_arguments)
            rewritten.append(WaveNode(
                value, 'lane64.X86_ALU', arguments))
            continue

        arguments = []
        for operand in node.arguments:
            if operand.kind == 'node' and operand.value == result.value:
                operand = Operand('projection', projection_coordinate(
                    dense[result.value], 16))
            elif operand.kind == 'node' and operand.value == flags.value:
                operand = Operand('node', dense[result.value])
            elif operand.kind == 'node':
                operand = Operand('node', dense[operand.value])
            elif operand.kind == 'projection':
                source, selector = decode_projection_coordinate(
                    operand.value)
                source = result.value if source == flags.value else source
                operand = Operand('projection', projection_coordinate(
                    dense[source], selector))
            arguments.append(operand)
        rewritten.append(WaveNode(value, node.op, tuple(arguments)))

    def publish(operand):
        if operand.kind == 'node' and operand.value == result.value:
            return Operand('projection', projection_coordinate(
                dense[result.value], 16))
        if operand.kind == 'node' and operand.value == flags.value:
            return Operand('node', dense[result.value])
        if operand.kind == 'node':
            return Operand('node', dense[operand.value])
        if operand.kind == 'projection':
            source, selector = decode_projection_coordinate(operand.value)
            source = result.value if source == flags.value else source
            return Operand('projection', projection_coordinate(
                dense[source], selector))
        return operand

    return (tuple(rewritten), tuple(map(publish, stack)),
            tuple(map(publish, locals_)))


def _rewrite_physical(nodes, stack, locals_):
    """Recompose local quotient identities across a multi-input SSA cut.

    The single-input minimizer handles the expensive closed backward slices.
    This pass handles identities whose inputs remain separate physical
    coordinates, without packing them into a synthetic scalar or materializing
    a second plan.  Every replacement is one exact lane primitive and the
    following liveness pass proves the resulting work/span objective.
    """
    from .wasmwave import Operand, WaveNode
    from .steppage import (decode_projection_coordinate,
                           projection_coordinate)

    # Recover the largest closed memory transaction before local ALU/flags
    # fusion. A composed input may already contain ALU result projections;
    # reopen them so memory recomposition sees the ordinary value graph.
    original = _reopen_consumed_x86_alu(
        tuple(nodes), tuple(stack), tuple(locals_))
    folded = _rewrite_relative_exchange(*original)
    nodes, stack, locals_ = folded

    outputs = {operand.value for operand in stack + locals_
               if operand.kind == 'node'}
    consumers = {node.value: [] for node in nodes}
    equivalent_nodes = {}
    for node in nodes:
        equivalent_nodes.setdefault((node.op, node.arguments), []).append(
            node.value)
        for operand in node.arguments:
            if operand.kind == 'node':
                consumers[operand.value].append(node.op)

    remap = {}
    rebuilt = []
    forms = {}
    predicates = {}

    def resolve(operand):
        if operand.kind != 'node':
            return operand
        return remap[operand.value]

    def form(operand):
        return forms.get(operand.value) if operand.kind == 'node' else None

    def constant(operand):
        return operand.value if operand.kind == 'const' else None

    def result_observation(original, resolved):
        """Return all pre-rewrite coordinates sharing an arithmetic value."""
        aliases = [source for source, replacement in remap.items()
                   if replacement == resolved]
        if original.kind == 'node' and original.value not in aliases:
            aliases.append(original.value)
        if original.kind == 'node':
            source = nodes[original.value - 1]
            for alias in equivalent_nodes.get(
                    (source.op, source.arguments), ()):
                if alias not in aliases:
                    aliases.append(alias)
        observations = [operation for source in aliases
                        for operation in consumers.get(source, ())]
        return aliases, observations

    def modulo_operand(operand, bits):
        """Canonicalize one coordinate modulo its architectural width."""
        mask = mask_of(bits)
        if operand.kind == 'const':
            return Operand('const', operand.value & mask)
        source = form(operand)
        if (source is not None
                and source[0] == 'lane64.AND'
                and len(source[1]) == 2):
            left, right = source[1]
            if constant(right) == mask:
                return modulo_operand(left, bits)
            if constant(left) == mask:
                return modulo_operand(right, bits)
        return operand

    def x86_alu_result(arguments, descriptor):
        """Prove the result expression and return its physical ALU mode."""
        bits = descriptor & 0x7f
        mode = (descriptor >> 8) & 7
        if bits not in (8, 16, 32, 64):
            return None
        left, right = (modulo_operand(argument, bits)
                       for argument in arguments[1:3])
        result = modulo_operand(arguments[3], bits)
        source = form(result)

        def pair(expected, commutative=False):
            if source is None or len(source[1]) != 2:
                return False
            actual = tuple(modulo_operand(argument, bits)
                           for argument in source[1])
            return (actual == expected
                    or commutative and actual == expected[::-1])

        expected = (left, right)
        if mode == 0 and source is not None:
            logical = {
                'lane64.AND': 0, 'lane64.ANDR': 0,
                'lane32.AND': 0, 'lane32.ANDR': 0,
                'lane64.OR': 5, 'lane64.ORR': 5,
                'lane32.OR': 5, 'lane32.ORR': 5,
                'lane64.XOR': 6, 'lane64.XORR': 6,
                'lane32.XOR': 6, 'lane32.XORR': 6,
            }.get(source[0])
            if logical is not None and pair(expected, commutative=True):
                return logical
        if mode == 1:
            if (source is not None
                    and source[0] in (
                        'lane64.ADD', 'lane64.ADDR',
                        'lane32.ADD', 'lane32.ADDR')
                    and pair(expected, commutative=True)):
                return mode
            if constant(right) == 0 and result == left:
                return mode
        if mode == 3:
            if (source is not None
                    and source[0] in (
                        'lane64.SUB', 'lane64.SUBR',
                        'lane32.SUB', 'lane32.SUBR')
                    and pair(expected)):
                return mode
            if (source is not None
                    and source[0] in (
                        'lane64.ADD', 'lane64.ADDR',
                        'lane32.ADD', 'lane32.ADDR')
                    and len(source[1]) == 2):
                actual = tuple(modulo_operand(argument, bits)
                               for argument in source[1])
                negated = (None if constant(right) is None else
                           Operand('const', (-constant(right))
                                   & mask_of(bits)))
                if (negated is not None
                        and (actual == (left, negated)
                             or actual == (negated, left))):
                    return mode
            if (constant(right) == 0 and result == left
                    or left == right and constant(result) == 0):
                return mode
        return None

    def condition_can_consume_test(flags, condition_node):
        """Prove that other uses only carry preserved bits to another TEST."""
        if flags.kind != 'node' or flags.value in outputs:
            return False
        for consumer in nodes:
            for index, argument in enumerate(consumer.arguments):
                if argument != flags or consumer.value == condition_node:
                    continue
                if consumer.op != 'lane64.X86_TEST' or index != 0:
                    return False
        return True

    def unsigned_bits(operand):
        raw = constant(operand)
        if raw is not None:
            return max(1, int(raw).bit_length())
        source = form(operand)
        if source is None:
            return None
        operation, arguments = source
        if operation.startswith('lane32.'):
            return 32
        if operation in ('lane64.X86_CONDITION',
                         'lane64.X86_TEST_CONDITION'):
            return 1
        if operation == 'lane64.SELECT_U32':
            return 32
        if operation.startswith('memory.i64.load'):
            suffix = operation[len('memory.i64.load'):]
            if suffix in ('8_u', '16_u', '32_u'):
                return int(suffix.split('_', 1)[0])
        if operation == 'lane64.AND' and len(arguments) == 2:
            mask = constant(arguments[1])
            if mask is not None:
                return max(1, int(mask).bit_length())
        if operation.endswith(('.ANDR', '.ORR')) and len(arguments) == 2:
            widths = tuple(unsigned_bits(argument) for argument in arguments)
            if all(width is not None for width in widths):
                return (min(widths) if operation.endswith('.ANDR')
                        else max(widths))
        if operation.endswith('.SELECT') and len(arguments) == 3:
            widths = tuple(unsigned_bits(argument)
                           for argument in arguments[:2])
            if all(width is not None for width in widths):
                return max(widths)
        if operation == 'lane64.BEXTR' and len(arguments) == 3:
            width = constant(arguments[2])
            if width is not None:
                return max(1, int(width))
        return None

    def emit(operation, arguments):
        value = len(rebuilt) + 1
        operand = Operand('node', value)
        rebuilt.append(WaveNode(value, operation, tuple(arguments)))
        forms[value] = (operation, tuple(arguments))
        if (operation == 'lane64.X86_CONDITION'
                and len(arguments) == 2
                and arguments[1].kind == 'const'
                and 0 <= arguments[1].value < 16):
            predicates[(arguments[0], arguments[1].value)] = operand
        return operand

    def fuse_memory(operand, observer):
        """Move a zero observer into its sole physical memory-load lane."""
        source = form(operand)
        if (source is None or not source[0].startswith('memory.')
                or '.load' not in source[0]
                or operand.value in outputs
                or len(consumers.get(operand.value, ())) != 1):
            return None
        operation = source[0] + '.' + observer
        rebuilt[operand.value - 1] = WaveNode(
            operand.value, operation, source[1])
        forms[operand.value] = (operation, source[1])
        return operand

    for node in nodes:
        operation = node.op
        arguments = tuple(map(resolve, node.arguments))
        if operation in ('memory.i64.repeat', 'memory.i64.find2',
                         'memory.i64.copy_until',
                         'memory.i64.prefix_end',
                         'memory.i64.relative_exchange',
                         'memory.i64.relative_result',
                         'memory.i64.relative_address',
                         'lane64.X86_COMPARE',
                         'memory.i64.pre_store'):
            operand = emit(operation, arguments)
            remap[node.value] = operand
            continue
        if operation.startswith('memory.'):
            store = '.store' in operation
            data_count = 2 if store else 1
            data = arguments[:data_count]
            offset, shape = arguments[data_count:data_count + 2]
            dependencies = arguments[data_count + 2:]
            if not store:
                def prior_write(operand):
                    source = form(operand)
                    if source is None:
                        return (operand,)
                    prior_operation, prior_arguments = source
                    if prior_operation == 'memory.i64.relative_address':
                        prior_dependencies = prior_arguments[5:]
                    elif (prior_operation.startswith('memory.')
                          and '.load' in prior_operation):
                        prior_dependencies = prior_arguments[3:]
                    else:
                        return (operand,)
                    flattened = []
                    for dependency in prior_dependencies:
                        for resolved in prior_write(dependency):
                            if resolved not in flattened:
                                flattened.append(resolved)
                    return tuple(flattened)

                flattened = []
                for dependency in dependencies:
                    for resolved in prior_write(dependency):
                        if resolved not in flattened:
                            flattened.append(resolved)
                dependencies = tuple(flattened)
            raw_shape = constant(shape)
            if raw_shape is None:
                raise ValueError('memory width is not a physical constant')
            from .steppage import decode_memory_shape, memory_shape
            access_width, scale, virtual64 = decode_memory_shape(raw_shape)
            address_form = form(data[0])
            raw_offset = constant(offset)
            if (scale == 0 and raw_offset is not None
                    and address_form is not None
                    and address_form[0] in (
                        'lane64.ADD', 'lane64.ADDR', 'lane64.ADD3')):
                constants = tuple(
                    constant(argument) for argument in address_form[1])
                coordinates = tuple(
                    argument for argument, value in zip(
                        address_form[1], constants) if value is None)
                if len(coordinates) == 1:
                    data = (coordinates[0],) + data[1:]
                    offset = Operand('const', (
                        raw_offset + sum(
                            value for value in constants
                            if value is not None)) & ((1 << 64) - 1))
                    address_form = form(data[0])
            if (scale == 0 and address_form is not None
                    and address_form[0] == 'lane32.SHL'
                    and len(address_form[1]) == 2
                    and constant(address_form[1][1]) is not None):
                amount = constant(address_form[1][1]) % 32
                data = (address_form[1][0],) + data[1:]
                scale = amount
            if store:
                value_form = form(data[1])
                if (value_form is not None
                        and value_form[0] == 'lane64.AND'
                        and constant(value_form[1][1])
                        == (1 << (access_width * 8)) - 1):
                    data = (data[0], value_form[1][0])
            shape = Operand('const', memory_shape(
                access_width, scale, virtual64))
            arguments = (data + (offset, shape)
                         + dependencies)
            operand = emit(operation, arguments)
            remap[node.value] = operand
            continue
        width, name = operation.split('.', 1)
        bits = 32 if width == 'lane32' else 64
        full = mask_of(bits)
        replacement = None
        alu_result = None

        def already_projected(operand):
            if bits == 64 or operand.kind == 'const':
                return True
            source = form(operand)
            return source is not None and source[0].startswith(width + '.')

        # Keep affine constant motion in one modular spelling.  This makes
        # address updates such as rsp - 8 and rsp + (-8) the same SSA value.
        if name == 'SUB' and len(arguments) == 2:
            subtrahend = constant(arguments[1])
            if subtrahend is not None:
                name = 'ADD'
                operation = width + '.ADD'
                arguments = (arguments[0], Operand(
                    'const', (-subtrahend) & full))

        # Wasm values already use an unsigned host representation.  The
        # unsigned extension therefore changes the type observer, not the
        # stored coordinate.
        if name == 'ADD3' and len(arguments) == 3:
            for candidate in arguments:
                masked = form(candidate)
                if (masked is None or masked[0] != 'lane64.AND'
                        or constant(masked[1][1]) is None):
                    continue
                loaded = form(masked[1][0])
                if (loaded is None or loaded[0] != 'memory.i64.load'
                        or len(loaded[1]) < 3):
                    continue
                base, load_offset, shape = loaded[1][:3]
                raw_shape = constant(shape)
                if raw_shape is None:
                    continue
                from .steppage import decode_memory_shape
                try:
                    access_width, scale, virtual64 = decode_memory_shape(
                        raw_shape)
                except ValueError:
                    continue
                if access_width != 8 or scale or not virtual64:
                    continue
                remainder = list(arguments)
                remainder.remove(candidate)
                addend = next((operand for operand in remainder
                               if operand.kind == 'const'), None)
                if (addend is None or base not in remainder):
                    continue
                loaded_operand = masked[1][0]
                uses = tuple(
                    use for use in rebuilt
                    if loaded_operand in use.arguments)
                published = any(
                    original in outputs
                    and remap.get(original) == loaded_operand
                    for original in remap)
                if (published or len(uses) != 1
                        or uses[0].value != candidate.value):
                    continue
                fused_arguments = (
                    base, load_offset, masked[1][1], addend, shape,
                ) + loaded[1][3:]
                rebuilt[loaded_operand.value - 1] = WaveNode(
                    loaded_operand.value, 'memory.i64.relative_address',
                    fused_arguments)
                forms[loaded_operand.value] = (
                    'memory.i64.relative_address', fused_arguments)
                replacement = loaded_operand
                break
            if replacement is None:
                for index, candidate in enumerate(arguments):
                    masked = form(candidate)
                    original = node.arguments[index]
                    if (masked is None
                            or masked[0] != 'lane64.AND'
                            or constant(masked[1][1]) != 0xffffffff
                            or original.kind != 'node'
                            or original.value in outputs
                            or len(consumers.get(original.value, ())) != 1):
                        continue
                    remainder = list(arguments)
                    remainder.remove(candidate)
                    operation = 'lane64.ADD3_U32'
                    arguments = (remainder[0], masked[1][0], remainder[1])
                    break

        elif name == 'INSERT' and len(arguments) == 3:
            descriptor = constant(arguments[2])
            base = form(arguments[0])
            if (width == 'lane64' and descriptor is not None
                    and (descriptor & 0xff)
                    and ((descriptor >> 8) & 0xff)
                    + (descriptor & 0xff) <= 32
                    and base is not None
                    and base[0] == 'lane64.AND'
                    and constant(base[1][1]) == 0xffffffff):
                insert_base = base[1][0]
                prior_insert = form(insert_base)
                if (prior_insert is not None
                        and prior_insert[0] == 'lane64.INSERT'
                        and constant(prior_insert[1][2]) == descriptor):
                    insert_base = prior_insert[1][0]
                operation = 'lane32.INSERT'
                arguments = (insert_base, arguments[1], arguments[2])

        elif name == 'X86_FLAGS' and len(arguments) == 5:
            descriptor = constant(arguments[4])
            if (descriptor is not None
                    and (descriptor >> 8) & 7 not in (2, 4)
                    and not descriptor & (1 << 11)):
                prior = arguments[0]
                prior_form = form(prior)
                while (prior_form is not None
                       and prior_form[0] in (
                           'lane64.X86_FLAGS', 'lane64.X86_ALU')):
                    prior = prior_form[1][0]
                    prior_form = form(prior)
                arguments = (prior,) + arguments[1:]
            original_result = node.arguments[3]
            alu_mode = (None if descriptor is None else
                        x86_alu_result(arguments, descriptor))
            aliases, observations = result_observation(
                original_result, arguments[3])
            flags_only_result = observations == ['lane64.X86_FLAGS']
            result_published = any(alias in outputs for alias in aliases)
            if (descriptor is not None and alu_mode == 3
                    and flags_only_result and not result_published):
                operation = 'lane64.X86_COMPARE'
                width = descriptor & 0x7f
                arguments = ((arguments[0],)
                             + tuple(modulo_operand(argument, width)
                                     for argument in arguments[1:3])
                             + (arguments[4],))
            elif (descriptor is not None and alu_mode == 0
                  and not descriptor & (1 << 11)
                  and flags_only_result and not result_published):
                operation = 'lane64.X86_TEST'
                arguments = ((arguments[0],)
                             + tuple(modulo_operand(argument,
                                      descriptor & 0x7f)
                                     for argument in arguments[1:3])
                             + (arguments[4],))
            elif (descriptor is not None and alu_mode is not None
                  and flags_only_result
                  and 'lane64.SELECT' not in consumers.get(node.value, ())):
                width = descriptor & 0x7f
                descriptor = ((descriptor & ~(7 << 8))
                              | (alu_mode << 8))
                alu_arguments = ((arguments[0],)
                                 + tuple(modulo_operand(argument, width)
                                         for argument in arguments[1:3])
                                 + (Operand('const', descriptor),))
                operation = 'lane64.X86_ALU'
                arguments = alu_arguments
                alu_result = (original_result.value
                              if original_result.kind == 'node' else None)

        elif name == 'X86_CONDITION' and len(arguments) == 2:
            tested = form(arguments[0])
            condition = constant(arguments[1])
            original_flags = node.arguments[0]
            if (tested is not None
                    and tested[0] == 'lane64.X86_TEST'
                    and len(tested[1]) == 4
                    and condition is not None
                    and 0 <= condition < 16
                    and constant(tested[1][3]) in (8, 16, 32, 64)
                    and condition_can_consume_test(
                        original_flags, node.value)):
                width = constant(tested[1][3])
                operation = 'lane64.X86_TEST_CONDITION'
                arguments = (tested[1][1], tested[1][2], Operand(
                    'const', width | (condition << 8)))

        elif name == 'X86_TEST' and len(arguments) == 4:
            descriptor = constant(arguments[3])
            if descriptor in (8, 16, 32, 64):
                test_arguments = list(arguments[:3])
                prior = test_arguments[0]
                prior_form = form(prior)
                while (prior_form is not None
                       and prior_form[0] == 'lane64.X86_TEST'):
                    prior = prior_form[1][0]
                    prior_form = form(prior)
                test_arguments[0] = prior
                width_mask = (1 << descriptor) - 1
                for index in (1, 2):
                    masked = form(test_arguments[index])
                    original = node.arguments[index]
                    if (masked is not None
                            and masked[0] == 'lane64.AND'
                            and constant(masked[1][1]) == width_mask
                            and original.kind == 'node'
                            and original.value not in outputs
                            and len(consumers.get(
                                original.value, ())) == 1):
                        test_arguments[index] = masked[1][0]
                arguments = tuple(test_arguments) + (arguments[3],)
        elif name == 'EXTEND_I32_S':
            source = form(arguments[0])
            if (source is not None and source[0] == 'lane64.AND'
                    and constant(source[1][1]) == 0xffffffff
                    and node.arguments[0].kind == 'node'
                    and node.arguments[0].value not in outputs
                    and len(consumers.get(
                        node.arguments[0].value, ())) == 1):
                arguments = (source[1][0],)

        elif name == 'EXTEND_I32_U':
            replacement = arguments[0]

        # A wrap only publishes the low word.  When it is not itself visible
        # and every consumer is already a 32-bit lane, those consumers perform
        # the same projection at their input boundary.
        elif (name == 'WRAP_I64' and node.value not in outputs
              and consumers[node.value]
              and all(op.startswith('lane32.')
                      for op in consumers[node.value])):
            replacement = arguments[0]

        elif (name in ('ADD', 'OR', 'XOR') and len(arguments) == 2
              and constant(arguments[1]) == 0
              and already_projected(arguments[0])):
            replacement = arguments[0]

        elif (name == 'SUB' and len(arguments) == 2
              and constant(arguments[1]) == 0
              and already_projected(arguments[0])):
            replacement = arguments[0]

        elif (name == 'IMUL' and len(arguments) == 2
              and constant(arguments[1]) == 1
              and already_projected(arguments[0])):
            replacement = arguments[0]

        elif (name == 'AND' and len(arguments) == 2
              and constant(arguments[1]) == full
              and already_projected(arguments[0])):
            replacement = arguments[0]

        elif (name == 'AND' and len(arguments) == 2
              and constant(arguments[1]) is not None
              and constant(arguments[1]) > 0
              and unsigned_bits(arguments[0]) is not None
              and unsigned_bits(arguments[0])
              <= max(1, constant(arguments[1]).bit_length())
              and constant(arguments[1])
              == (1 << constant(arguments[1]).bit_length()) - 1):
            replacement = arguments[0]

        elif (name in ('SHL', 'SHR', 'SAR') and len(arguments) == 2
              and constant(arguments[1]) is not None
              and constant(arguments[1]) % bits == 0
              and already_projected(arguments[0])):
            replacement = arguments[0]

        elif name == 'ADD' and len(arguments) == 2:
            source = form(arguments[0])
            if (source is not None and source[0] == width + '.ADDR'
                    and constant(arguments[1]) is not None):
                operation = width + '.ADD3'
                arguments = source[1] + (arguments[1],)

        elif name == 'AND' and len(arguments) == 2:
            source = form(arguments[0])
            mask = constant(arguments[1])
            if (source is not None
                    and source[0] in ('lane32.INSERT', 'lane64.INSERT')
                    and mask is not None
                    and constant(source[1][2]) is not None
                    and ((constant(source[1][2]) >> 8) & 0xff) == 0
                    and mask & ~mask_of(
                        constant(source[1][2]) & 0xff) == 0):
                selected = source[1][1]
                selected_bits = unsigned_bits(selected)
                if (selected_bits is not None
                        and selected_bits <= max(1, mask.bit_length())
                        and mask == (1 << mask.bit_length()) - 1):
                    replacement = selected
                else:
                    operation = width + '.AND'
                    arguments = (selected, arguments[1])
            elif (source is not None and source[0] == width + '.AND'
                    and mask is not None
                    and constant(source[1][1]) is not None):
                operation = width + '.AND'
                arguments = (
                    source[1][0], Operand(
                        'const', mask & constant(source[1][1])))
            elif (source is not None and mask == 1
                  and source[0].split('.', 1)[-1] in ('SHRR', 'SHR')):
                # A one-bit observation has the same value after any integer
                # width projection.  Keep the shift's source width so mixed
                # signatures such as (i64 residual, i32 index) do not
                # materialize an i32 wrapper before the physical bit query.
                source_width = source[0].split('.', 1)[0]
                shift = form(source[1][1])
                if (shift is not None
                        and shift[0] == source_width + '.ANDNR'
                        and constant(shift[1][1]) == 7):
                    operation = source_width + '.BIT_MSB8'
                    arguments = (source[1][0], shift[1][0])
                else:
                    operation = source_width + '.BIT'
                    arguments = source[1]
            elif source is not None and source[0] == width + '.XOR':
                inverted = source[1]
                if (len(inverted) == 2
                        and constant(inverted[1]) == full
                        and mask is not None):
                    operation = width + '.ANDNR'
                    arguments = (inverted[0], arguments[1])
            elif (width == 'lane64' and mask == 0xffffffff
                  and source is not None
                  and node.arguments[0].kind == 'node'
                  and node.arguments[0].value not in outputs
                  and len(consumers.get(node.arguments[0].value, ())) == 1
                  and source[0] in (
                      'lane64.ADD', 'lane64.ADDR', 'lane64.ADD3',
                      'lane64.SUBR', 'lane64.MULR', 'lane64.AND',
                      'lane64.ANDR', 'lane64.ORR', 'lane64.XORR')):
                operation = 'lane32.' + source[0].split('.', 1)[1]
                arguments = source[1]

        elif name == 'ANDR' and len(arguments) == 2:
            shifted = form(arguments[0])
            bounded = form(arguments[1])
            if shifted is None or shifted[0] != width + '.SHRR':
                shifted, bounded = bounded, shifted
            if (shifted is not None and shifted[0] == width + '.SHRR'
                    and bounded is not None
                    and bounded[0] == width + '.XOR'
                    and constant(bounded[1][1]) == full):
                raised = form(bounded[1][0])
                if (raised is not None and raised[0] == width + '.SHLR'
                        and constant(raised[1][0]) == full):
                    operation = width + '.BEXTR'
                    arguments = (shifted[1][0], shifted[1][1], raised[1][1])

        elif name == 'EQZ' and len(arguments) == 1:
            source = form(arguments[0])
            fused = fuse_memory(arguments[0], 'eqz')
            if fused is not None:
                replacement = fused
            elif source is not None:
                inverse = {
                    'EQ': 'NE', 'NE': 'EQ',
                    'LT_S': 'GE_S', 'LT_U': 'GE_U',
                    'GT_S': 'LE_S', 'GT_U': 'LE_U',
                    'LE_S': 'GT_S', 'LE_U': 'GT_U',
                    'GE_S': 'LT_S', 'GE_U': 'LT_U',
                }
                source_width, source_name = source[0].split('.', 1)
                if source_name in ('BIT', 'BIT_MSB8'):
                    operation = (source_width + '.BITZ'
                                 if source_name == 'BIT'
                                 else source_width + '.BIT_MSB8Z')
                    arguments = source[1]
                elif source_name in inverse:
                    operation = source_width + '.' + inverse[source_name]
                    arguments = source[1]
                elif source_name == 'AND':
                    mask = constant(source[1][1])
                    if mask and mask & (mask - 1) == 0:
                        operation = source_width + '.BITZ'
                        arguments = (source[1][0], Operand(
                            'const', mask.bit_length() - 1))

        elif name == 'NE' and len(arguments) == 2:
            left, right = arguments
            candidate = (left if constant(right) == 0
                         else right if constant(left) == 0 else None)
            fused = None if candidate is None else fuse_memory(
                candidate, 'nez')
            if fused is not None:
                replacement = fused

        elif name == 'SELECT' and len(arguments) == 3:
            condition = form(arguments[2])
            left_form = form(arguments[0])
            right_form = form(arguments[1])
            if (condition is not None
                    and condition[0] == 'lane64.X86_CONDITION'
                    and len(condition[1]) == 2
                    and constant(condition[1][1]) is not None):
                code = constant(condition[1][1])
                inverse = predicates.get((condition[1][0], code ^ 1))
                if inverse is not None and inverse != arguments[2]:
                    arguments = (arguments[1], arguments[0], inverse)
                    condition = form(inverse)
            if (left_form is not None and right_form is not None
                    and left_form[0] == 'lane64.X86_FLAGS'
                    and right_form[0] == 'lane64.X86_FLAGS'):
                operation = 'lane64.X86_FLAGS_SELECT'
                arguments = (left_form[1] + right_form[1]
                             + (arguments[2],))
            if condition is not None:
                condition_width, relation = condition[0].split('.', 1)
                extrema = {
                    'LT_U': 'UMIN', 'LE_U': 'UMIN',
                    'GT_U': 'UMAX', 'GE_U': 'UMAX',
                    'LT_S': 'SMIN', 'LE_S': 'SMIN',
                    'GT_S': 'SMAX', 'GE_S': 'SMAX',
                }
                if (relation in extrema
                        and condition[1] == arguments[:2]):
                    operation = condition_width + '.' + extrema[relation]
                    arguments = arguments[:2]
            if (operation == 'lane64.SELECT'
                    and all((unsigned_bits(argument) or 65) <= 32
                            for argument in arguments[:2])):
                selected = []
                for argument in arguments[:2]:
                    source = form(argument)
                    selected.append(
                        source[1][0]
                        if source is not None
                        and source[0] == 'lane64.AND'
                        and constant(source[1][1]) == 0xffffffff
                        else argument)
                operation = 'lane64.SELECT_U32'
                arguments = tuple(selected) + (arguments[2],)

        if replacement is not None:
            remap[node.value] = replacement
            continue
        if operation == 'lane64.X86_ALU':
            operand = emit(operation, arguments)
            if alu_result is not None:
                remap[alu_result] = Operand(
                    'projection', projection_coordinate(operand.value, 16))
            remap[node.value] = operand
            continue
        prior = next((candidate for candidate in rebuilt
                      if operation.startswith(('lane32.', 'lane64.'))
                      and candidate.op == operation
                      and candidate.arguments == arguments), None)
        if prior is not None:
            remap[node.value] = Operand('node', prior.value)
            continue
        operand = emit(operation, arguments)
        remap[node.value] = operand

    def output(operand):
        if operand.kind == 'node':
            return resolve(operand)
        if operand.kind == 'projection':
            source, selector = decode_projection_coordinate(operand.value)
            return Operand('projection', projection_coordinate(
                remap[source].value, selector))
        return operand

    rewritten = _rewrite_relative_exchange(
        tuple(rebuilt), tuple(map(output, stack)),
        tuple(map(output, locals_)))
    rewritten = _rewrite_balanced_stack(*rewritten)
    rewritten = _rewrite_pre_store(*rewritten)
    rewritten = _fuse_live_x86_alu(*rewritten)
    return _rewrite_terminal_projections(*rewritten)


def _rewrite_terminal_projections(nodes, stack, locals_):
    """Publish unused multi-result lanes as physical output coordinates."""
    from .steppage import (FLAG_PROJECTION_OPS,
                           decode_projection_coordinate,
                           projection_coordinate)
    from .wasmwave import Operand, WaveNode

    final_source = next((
        node.value for node in reversed(nodes)
        if node.op == 'memory.i64.relative_exchange'), None)
    outputs = tuple(stack) + tuple(locals_)
    output_values = {operand.value for operand in outputs
                     if operand.kind == 'node'}
    consumers = {node.value: [] for node in nodes}
    for node in nodes:
        for operand in node.arguments:
            if operand.kind == 'node':
                consumers.setdefault(operand.value, []).append(node.value)
    projected = {}
    for node in nodes:
        if (node.value not in output_values
                or consumers.get(node.value)
                or len(node.arguments) != 2
                or node.arguments[0].kind != 'node'
                or node.arguments[1].kind != 'const'):
            continue
        source = node.arguments[0].value
        selector = node.arguments[1].value
        source_operation = nodes[source - 1].op
        relative = (node.op == 'memory.i64.relative_result'
                    and source == final_source)
        condition = (node.op == 'lane64.X86_CONDITION'
                     and source_operation in FLAG_PROJECTION_OPS
                     and 0 <= selector < 16)
        if relative or condition:
            projected[node.value] = source, selector
    if not projected:
        return tuple(nodes), tuple(stack), tuple(locals_)

    dense = {}
    rewritten = []
    for node in nodes:
        if node.value in projected:
            continue
        value = len(rewritten) + 1
        dense[node.value] = value
        rewritten.append(WaveNode(value, node.op, tuple(
            Operand('node', dense[operand.value])
            if operand.kind == 'node' else operand
            for operand in node.arguments)))

    def publish(operand):
        if operand.kind == 'node':
            projection = projected.get(operand.value)
            if projection is not None:
                source, selector = projection
                return Operand('projection', projection_coordinate(
                    dense[source], selector))
            return Operand('node', dense[operand.value])
        if operand.kind == 'projection':
            old_source, selector = decode_projection_coordinate(
                operand.value)
            return Operand('projection', projection_coordinate(
                dense[old_source], selector))
        return operand

    return (tuple(rewritten), tuple(map(publish, stack)),
            tuple(map(publish, locals_)))


def _rewrite_pre_store(nodes, stack, locals_):
    """Fuse one published pre-decrement coordinate with its exact store."""
    from .steppage import (decode_memory_shape,
                           decode_projection_coordinate,
                           projection_coordinate)
    from .wasmwave import Operand, WaveNode

    outputs = {operand.value for operand in tuple(stack) + tuple(locals_)
               if operand.kind == 'node'}
    full = (1 << 64) - 1

    def dependency_start(node):
        if node.op == 'memory.i64.relative_address':
            return 5
        if node.op == 'memory.i64.relative_exchange':
            mode = node.arguments[6] if len(node.arguments) > 6 else None
            return (7 + 3 * mode.value
                    if mode is not None and mode.kind == 'const' else 7)
        if node.op == 'memory.i64.pre_store':
            return 4
        if node.op.startswith('memory.'):
            return (4 if '.store' in node.op else 3)
        return None

    for store in nodes:
        if (store.op != 'memory.i64.store'
                or len(store.arguments) < 4
                or store.value in outputs):
            continue
        pointer, saved, offset, shape = store.arguments[:4]
        dependencies = store.arguments[4:]
        if (offset.kind != 'const' or shape.kind != 'const'
                or pointer.kind not in ('local', 'stack')):
            continue
        try:
            _width, scale, virtual64 = decode_memory_shape(shape.value)
        except ValueError:
            continue
        if scale or not virtual64:
            continue
        decrement = (-offset.value) & full
        if not decrement:
            continue
        address = next((node for node in nodes[:store.value - 1]
                        if node.op == 'lane64.ADD'
                        and node.arguments == (
                            pointer, Operand('const', offset.value))
                        and node.value in outputs), None)
        if (address is None
                or (saved.kind == 'node'
                    and saved.value >= address.value)
                or any(dependency.kind == 'node'
                       and dependency.value >= address.value
                       for dependency in dependencies)):
            continue
        safe = True
        for consumer in nodes:
            for index, operand in enumerate(consumer.arguments):
                if operand != Operand('node', store.value):
                    continue
                start = dependency_start(consumer)
                if start is None or index < start:
                    safe = False
                    break
            if not safe:
                break
        if not safe:
            continue

        replacement = address.value
        dense = {}
        rewritten = []
        for source in nodes:
            if source.value == store.value:
                continue
            operation = source.op
            arguments = source.arguments
            if source.value == address.value:
                operation = 'memory.i64.pre_store'
                arguments = (pointer, saved, Operand('const', decrement),
                             shape) + dependencies
            mapped = []
            for operand in arguments:
                if operand.kind != 'node':
                    mapped.append(operand)
                    continue
                old = replacement if operand.value == store.value \
                    else operand.value
                mapped.append(Operand('node', dense[old]))
            value = len(rewritten) + 1
            dense[source.value] = value
            rewritten.append(WaveNode(value, operation, tuple(mapped)))

        def publish(operand):
            if operand.kind == 'node':
                return Operand('node', dense[operand.value])
            if operand.kind == 'projection':
                source, selector = decode_projection_coordinate(
                    operand.value)
                return Operand('projection', projection_coordinate(
                    dense[source], selector))
            return operand

        return _rewrite_pre_store(
            tuple(rewritten), tuple(map(publish, stack)),
            tuple(map(publish, locals_)))
    return tuple(nodes), tuple(stack), tuple(locals_)


def _rewrite_balanced_stack(nodes, stack, locals_):
    """Substitute a balanced save/restore stack version out of the cut.

    A leaf ``push x; ...; pop x`` creates a transient byte version below the
    published stack coordinate.  If the matching load only restores the same
    local and the stack output has advanced by exactly that width, the value
    and coordinate both substitute to their inputs.  Memory dependencies are
    bypassed, but later memory still depends on the last intervening effect.
    """
    from .steppage import (decode_memory_shape, RELATIVE_SAVE_CAP,
                           decode_projection_coordinate,
                           projection_coordinate)
    from .wasmwave import Operand, WaveNode

    def ordinary_access(node):
        if not node.op.startswith('memory.i64.'):
            return None
        name = node.op[len('memory.i64.'):]
        if name == 'pre_store':
            if (len(node.arguments) < 4
                    or node.arguments[2].kind != 'const'
                    or node.arguments[3].kind != 'const'):
                return None
            try:
                width, scale, virtual64 = decode_memory_shape(
                    node.arguments[3].value)
            except ValueError:
                return None
            if scale or node.arguments[2].value != width:
                return None
            return (True, Operand('node', node.value), node.arguments[1],
                    0, width, 0, virtual64, node.arguments[4:])
        if name in ('repeat', 'find2', 'copy_until',
                    'relative_exchange', 'relative_result'):
            return None
        store = name.startswith('store')
        load = name.startswith('load')
        if not store and not load:
            return None
        fixed = 4 if store else 3
        if len(node.arguments) < fixed:
            return None
        offset_at = 2 if store else 1
        offset, shape = node.arguments[offset_at:offset_at + 2]
        if offset.kind != 'const' or shape.kind != 'const':
            return None
        try:
            width, scale, virtual64 = decode_memory_shape(shape.value)
        except ValueError:
            return None
        return (store, node.arguments[0],
                node.arguments[1] if store else None,
                int(offset.value), width, scale, virtual64,
                node.arguments[fixed:])

    for store in nodes:
        stored = ordinary_access(store)
        if stored is None or not stored[0]:
            continue
        address = stored[1]
        address_node = (nodes[address.value - 1]
                        if address.kind == 'node' else None)
        saved = stored[2]
        width = stored[4]
        pointer = None
        pre_store = store.op == 'memory.i64.pre_store'
        if (pre_store and len(store.arguments) >= 4
                and store.arguments[0].kind in (
                    'local', 'stack', 'node', 'const')
                and store.arguments[2] == Operand('const', width)):
            pointer = store.arguments[0]
            address_node = None
        elif (stored[3] == 0 and address_node is not None
                and address_node.op in ('lane64.SUB', 'lane64.ADD')
                and len(address_node.arguments) == 2
                and address_node.arguments[1].kind == 'const'):
            displacement = (address_node.arguments[1].value
                            if address_node.op == 'lane64.ADD'
                            else -address_node.arguments[1].value)
            if displacement & ((1 << 64) - 1) == -width & ((1 << 64) - 1):
                pointer = address_node.arguments[0]
        elif (address.kind == 'local'
              and stored[3] & ((1 << 64) - 1)
              == -width & ((1 << 64) - 1)):
            # Address folding may already have represented rsp-width as the
            # original pointer plus a modular displacement.
            pointer = address
            address_node = None
        if pointer is None or width != 8:
            continue
        load = next((node for node in nodes[store.value:]
                     if (lambda access: access is not None
                         and not access[0]
                         and access[1] == address
                         and access[3:7] == stored[3:7])(
                             ordinary_access(node))), None)
        if load is None:
            continue
        if (not any(operand == Operand('node', load.value)
                           for operand in tuple(stack) + tuple(locals_))
                and not any(Operand('node', load.value) in node.arguments
                            for node in nodes[load.value:])):
            continue
        restored_pointer = next((
            node for node in nodes[store.value:]
            if node.op == 'lane64.ADD'
            and node.arguments == (
                Operand('node', store.value), Operand('const', width))), None)
        pointer_already_published = (
            pointer.kind == 'local' and pointer.value < len(locals_)
            and locals_[pointer.value] == pointer)
        if restored_pointer is None and not pointer_already_published:
            continue
        address_users = [node.value for node in nodes
                         if any(argument == address
                                for argument in node.arguments)]
        if (not pre_store and address_node is not None
                and any(value not in (store.value, load.value)
                        for value in address_users)):
            continue

        intervening = tuple(
            node for node in nodes[store.value:load.value - 1]
            if node.op.startswith('memory.')
            and node.op != 'memory.i64.relative_result')
        transaction = (intervening[0]
                       if len(intervening) == 1
                       and intervening[0].op
                       == 'memory.i64.relative_exchange' else None)
        # With no intervening memory effect, store->load is an ordinary SSA
        # identity.  If one relative transaction intervenes, internalize the
        # save and restore so arbitrary pointer aliasing keeps the exact x86
        # order.  Any other effect needs a more general transaction grammar.
        if intervening and transaction is None:
            continue

        removed = {load.value}
        if transaction is not None:
            removed.add(store.value)
            if address_node is not None:
                removed.add(address_node.value)
        if restored_pointer is not None:
            removed.add(restored_pointer.value)
        restore_value = max(node.value for node in nodes) + 1
        value_substitution = {
            load.value: (Operand('node', restore_value)
                         if transaction is not None else saved),
        }
        if restored_pointer is not None:
            value_substitution[restored_pointer.value] = pointer
        dependency_substitution = {
            load.value: (
                tuple(ordinary_access(load)[-1])
                if transaction is not None
                else (Operand('node', store.value),)),
        }
        if transaction is not None:
            dependency_substitution[store.value] = tuple(stored[-1])

        def dependency_start(node):
            if node.op == 'memory.i64.relative_exchange':
                mode = (node.arguments[6]
                        if len(node.arguments) > 6 else None)
                return (7 + 3 * mode.value
                        if mode is not None and mode.kind == 'const' else 7)
            access = ordinary_access(node)
            if access is not None:
                return 4 if access[0] else 3
            return len(node.arguments)

        def expand_dependency(operand):
            if operand.kind != 'node':
                return (operand,)
            prior = dependency_substitution.get(operand.value)
            if prior is None:
                substituted = value_substitution.get(operand.value)
                return ((substituted,) if substituted is not None
                        else (operand,))
            expanded = []
            for dependency in prior:
                for resolved in expand_dependency(dependency):
                    if resolved not in expanded:
                        expanded.append(resolved)
            return tuple(expanded)

        staged = []
        valid = True
        for node in nodes:
            if node.value in removed:
                continue
            split = dependency_start(node)
            source_arguments = node.arguments
            if (transaction is not None
                    and node.op == 'memory.i64.relative_result'
                    and len(source_arguments) >= 2
                    and source_arguments[0]
                    == Operand('node', transaction.value)
                    and source_arguments[1].kind == 'const'):
                old_mode = transaction.arguments[6].value
                selector = source_arguments[1].value
                if 0xfe - old_mode < selector <= 0xfe:
                    source_arguments = (
                        source_arguments[:1]
                        + (Operand('const', selector - 1),)
                        + source_arguments[2:])
            access = ordinary_access(node)
            if (transaction is not None and pre_store
                    and access is not None and source_arguments
                    and source_arguments[0]
                    == Operand('node', store.value)
                    and node is not transaction):
                offset_at = 2 if access[0] else 1
                if source_arguments[offset_at].kind != 'const':
                    valid = False
                    break
                adjusted = list(source_arguments)
                adjusted[0] = pointer
                adjusted[offset_at] = Operand(
                    'const', (adjusted[offset_at].value - width)
                    & ((1 << 64) - 1))
                source_arguments = tuple(adjusted)
            if node is transaction:
                mode = (source_arguments[6]
                        if len(source_arguments) > 6 else None)
                if (mode is None or mode.kind != 'const'
                        or mode.value < 0
                        or mode.value >= RELATIVE_SAVE_CAP
                        or len(source_arguments) < 7 + 3 * mode.value):
                    valid = False
                    break
                dependency_at = 7 + 3 * mode.value
                existing = list(source_arguments[7:dependency_at])
                for at in range(0, len(existing), 3):
                    if existing[at] != Operand('node', store.value):
                        continue
                    if existing[at + 1].kind != 'const':
                        valid = False
                        break
                    existing[at] = pointer
                    existing[at + 1] = Operand(
                        'const', (existing[at + 1].value - width)
                        & ((1 << 64) - 1))
                if not valid:
                    break
                source_arguments = (
                    source_arguments[:6]
                    + (Operand('const', mode.value + 1),)
                    + (pointer, Operand(
                        'const', (-width) & ((1 << 64) - 1)), saved)
                    + tuple(existing)
                    + source_arguments[dependency_at:])
                split = dependency_at + 3
            arguments = []
            for index, operand in enumerate(source_arguments):
                if index >= split and operand.kind == 'node' \
                        and operand.value in dependency_substitution:
                    arguments.extend(expand_dependency(operand))
                else:
                    arguments.append(value_substitution.get(
                        operand.value, operand)
                        if operand.kind == 'node' else operand)
            staged.append(WaveNode(node.value, node.op, tuple(arguments)))
            if node is transaction:
                staged.append(WaveNode(
                    restore_value, 'memory.i64.relative_result', (
                        Operand('node', transaction.value),
                        Operand('const', 0xfe))))

        if not valid:
            continue

        staged_values = {node.value for node in staged}
        if any(operand.kind == 'node'
               and operand.value not in staged_values
               for node in staged for operand in node.arguments):
            continue

        dense = {}
        rewritten = []
        for node in staged:
            value = len(rewritten) + 1
            dense[node.value] = value
            rewritten.append(WaveNode(value, node.op, tuple(
                Operand('node', dense[operand.value])
                if operand.kind == 'node' else operand
                for operand in node.arguments)))

        def publish(operand):
            if operand.kind == 'projection':
                source, selector = decode_projection_coordinate(
                    operand.value)
                if transaction is not None and source == transaction.value:
                    old_mode = transaction.arguments[6].value
                    if 0xfe - old_mode < selector <= 0xfe:
                        selector -= 1
                source_operand = value_substitution.get(
                    source, Operand('node', source))
                if source_operand.kind != 'node':
                    raise ValueError(
                        'a projected transaction was removed from its cut')
                return Operand('projection', projection_coordinate(
                    dense[source_operand.value], selector))
            if operand.kind != 'node':
                return operand
            operand = value_substitution.get(operand.value, operand)
            return (Operand('node', dense[operand.value])
                    if operand.kind == 'node' else operand)

        return (tuple(rewritten), tuple(map(publish, stack)),
                tuple(map(publish, locals_)))
    return tuple(nodes), tuple(stack), tuple(locals_)


def _rewrite_relative_exchange(nodes, stack, locals_):
    """Fold an adjacent relative-coordinate exchange into one transaction.

    The recognized graph has one shared ``delta = left - right`` and, for
    every adjacent lane, the closed form ``(right - delta, left + delta)``.
    Detection is based only on SSA and byte coordinates; it is independent of
    the source frontend and of symbol names.
    """
    from .steppage import (decode_memory_shape,
                           decode_projection_coordinate,
                           projection_coordinate, relative_layout)
    from .wasmwave import Operand, WaveNode

    by_value = {node.value: node for node in nodes}
    outputs = tuple(stack) + tuple(locals_)
    output_values = {operand.value for operand in outputs
                     if operand.kind == 'node'}
    consumers = {node.value: [] for node in nodes}
    for node in nodes:
        for operand in node.arguments:
            if operand.kind == 'node':
                consumers.setdefault(operand.value, []).append(node.value)

    def node_of(operand):
        return (by_value.get(operand.value)
                if operand.kind == 'node' else None)

    def access(node):
        if node is None or not node.op.startswith('memory.i64.'):
            return None
        name = node.op[len('memory.i64.'):]
        if name in ('repeat', 'find2', 'copy_until',
                    'relative_exchange', 'relative_result'):
            return None
        store = name.startswith('store')
        load = name.startswith('load')
        if not store and not load:
            return None
        fixed = 4 if store else 3
        if len(node.arguments) < fixed:
            return None
        base = node.arguments[0]
        value = node.arguments[1] if store else None
        offset_at = 2 if store else 1
        offset, shape = node.arguments[offset_at:offset_at + 2]
        if offset.kind != 'const' or shape.kind != 'const':
            return None
        try:
            width, scale, virtual64 = decode_memory_shape(shape.value)
        except ValueError:
            return None
        if scale:
            return None
        return (store, base, value, int(offset.value), width, virtual64,
                node.arguments[fixed:])

    def arithmetic(node, name, delta):
        if node is None or node.op not in (
                'lane32.' + name, 'lane64.' + name):
            return None
        left, right = node.arguments
        if right == delta:
            return left
        if name == 'ADDR' and left == delta:
            return right
        return None

    for delta_node in nodes:
        if delta_node.op != 'lane64.SUBR':
            continue
        left_base, right_base = delta_node.arguments
        delta = Operand('node', delta_node.value)
        lanes = []
        for left_store in nodes:
            stored = access(left_store)
            if stored is None or not stored[0] or stored[1] != left_base:
                continue
            _store, _base, left_value, offset, width, virtual64, _deps = stored
            left_result = node_of(left_value)
            right_load_operand = arithmetic(left_result, 'SUBR', delta)
            right_load = node_of(right_load_operand) \
                if right_load_operand is not None else None
            loaded_right = access(right_load)
            if (loaded_right is None or loaded_right[0]
                    or loaded_right[1] != right_base
                    or loaded_right[3:6] != (offset, width, virtual64)):
                continue
            match = None
            for right_store in nodes:
                candidate = access(right_store)
                if (candidate is None or not candidate[0]
                        or candidate[1] != right_base
                        or candidate[3:6] != (offset, width, virtual64)):
                    continue
                right_value = candidate[2]
                right_result = node_of(right_value)
                left_load_operand = arithmetic(right_result, 'ADDR', delta)
                left_load = node_of(left_load_operand) \
                    if left_load_operand is not None else None
                loaded_left = access(left_load)
                if (loaded_left is not None and not loaded_left[0]
                        and loaded_left[1] == left_base
                        and loaded_left[3:6]
                        == (offset, width, virtual64)):
                    match = (left_store, right_store, left_result,
                             right_result, right_load, left_load)
                    break
            if match is not None:
                lanes.append((offset, width, virtual64) + match)

        lanes.sort(key=lambda lane: lane[0])
        if (len(lanes) < 2 or lanes[0][0] != 0
                or any(lanes[index][0]
                       != lanes[index - 1][0] + lanes[index - 1][1]
                       for index in range(1, len(lanes)))
                or len({lane[2] for lane in lanes}) != 1):
            continue
        left_stores = [lane[3] for lane in lanes]
        right_stores = [lane[4] for lane in lanes]
        if ([node.value for node in left_stores]
                != sorted(node.value for node in left_stores)
                or min(node.value for node in right_stores)
                < max(node.value for node in left_stores)):
            continue

        last = lanes[-1]
        last_width = last[1]
        last_right_result = Operand('node', last[6].value)
        last_left_load = Operand('node', last[8].value)
        flags = next((node for node in nodes
                      if node.op == 'lane64.X86_FLAGS'
                      and len(node.arguments) == 5
                      and node.arguments[1:4]
                      == (delta, last_left_load, last_right_result)
                      and node.arguments[4].kind == 'const'
                      and node.arguments[4].value
                      == last_width * 8 | (1 << 8)), None)
        if flags is None:
            continue

        replaced = {flags.value}
        selectors = {flags.value: 0xff}
        observed_loads = set()
        for lane_index, lane in enumerate(lanes):
            (_offset, _width, _virtual64, left_store, right_store,
             left_result, right_result, right_load, left_load) = lane
            replaced.update((left_store.value, right_store.value,
                             left_result.value, right_result.value,
                             right_load.value, left_load.value))
            observed_loads.update((right_load.value, left_load.value))
            selectors[left_result.value] = lane_index * 2
            selectors[right_result.value] = lane_index * 2 + 1

        # The transaction publishes the transformed lanes, not arbitrary
        # observations of a pre-transaction load.  Keep the scalar graph when
        # such an observation survives outside the affine exchange.
        if any(value in output_values
               or any(consumer not in replaced
                      for consumer in consumers.get(value, ()))
               for value in observed_loads):
            continue

        first_memory = min(node.value for node in nodes
                           if node.value in replaced
                           and node.op.startswith('memory.'))
        last_memory = max(node.value for node in nodes
                          if node.value in replaced
                          and node.op.startswith('memory.'))
        if any(node.op.startswith('memory.') and node.value not in replaced
               for node in nodes[first_memory - 1:last_memory]):
            continue
        visible = []
        for value, selector in selectors.items():
            if (value in output_values
                    or any(consumer not in replaced
                           for consumer in consumers.get(value, ()))):
                visible.append((
                    value, selector,
                    any(consumer not in replaced
                        for consumer in consumers.get(value, ()))))
        if not visible:
            visible.append((None, 0, False))

        # A transaction already owns all result lanes in one physical array.
        # Only values consumed by another SSA node need scalar result nodes.
        # Terminal frame publications name the array lane directly, so they
        # do not add work or another materialized state coordinate.
        materialized = [entry for entry in visible if entry[2]]
        if materialized:
            primary_entry = materialized[0]
        else:
            primary_entry = visible[0]
        projected = {
            value: selector for value, selector, consumed in visible
            if value is not None and not consumed
            and value != primary_entry[0]
        }

        dependencies = []
        for node in nodes:
            if node.value not in replaced or not node.op.startswith('memory.'):
                continue
            details = access(node)
            if details is None:
                continue
            for dependency in details[-1]:
                if (dependency.kind == 'node'
                        and dependency.value not in replaced
                        and dependency not in dependencies):
                    dependencies.append(dependency)

        next_value = len(nodes) + 1
        primary_value, primary_selector, _primary_consumed = primary_entry
        primary = WaveNode(next_value, 'memory.i64.relative_exchange', (
            left_base, right_base, delta, flags.arguments[0],
            Operand('const', relative_layout(
                tuple(lane[1] for lane in lanes))),
            Operand('const', primary_selector),
            Operand('const', 0),
        ) + tuple(dependencies))
        inserted = [primary]
        substitutions = {value: next_value for value in replaced}
        if primary_value is not None:
            substitutions[primary_value] = next_value
        for old_value, selector, consumed in visible:
            if (old_value is None or old_value == primary_value
                    or not consumed):
                continue
            result_value = next_value + len(inserted)
            inserted.append(WaveNode(
                result_value, 'memory.i64.relative_result', (
                    Operand('node', next_value),
                    Operand('const', selector))))
            substitutions[old_value] = result_value

        insertion_at = min(replaced)
        ordered = []
        for node in nodes:
            if node.value == insertion_at:
                ordered.extend(inserted)
            if node.value not in replaced:
                ordered.append(node)

        dense = {}
        rewritten = []

        def substitute(operand):
            if operand.kind != 'node':
                return operand
            value = substitutions.get(operand.value, operand.value)
            return Operand('node', dense[value])

        for node in ordered:
            value = len(rewritten) + 1
            dense[node.value] = value
            rewritten.append(WaveNode(
                value, node.op, tuple(map(substitute, node.arguments))))

        def publish(operand):
            if operand.kind == 'projection':
                source, selector = decode_projection_coordinate(
                    operand.value)
                return Operand('projection', projection_coordinate(
                    dense[source], selector))
            if operand.kind != 'node':
                return operand
            selector = projected.get(operand.value)
            if selector is not None:
                return Operand('projection', projection_coordinate(
                    dense[next_value], selector))
            value = substitutions.get(operand.value, operand.value)
            return Operand('node', dense[value])

        return (tuple(rewritten), tuple(map(publish, stack)),
                tuple(map(publish, locals_)))
    return tuple(nodes), tuple(stack), tuple(locals_)


def _compact_once(nodes, stack, locals_):
    """Remove superseded SSA and rebuild dense physical dependency waves."""
    from .wasmphysical import DependencyWaves
    from .wasmwave import Operand, WaveNode
    from .steppage import (decode_projection_coordinate,
                           projection_coordinate)

    nodes, stack, locals_ = _rewrite_physical(nodes, stack, locals_)

    trapping = {'DIV_S', 'DIV_U', 'REM_S', 'REM_U'}
    live = {node.value for node in nodes
            if (node.op.startswith('memory.')
                or node.op.split('.', 1)[-1] in trapping)}
    live.update(operand.value for operand in stack + locals_
                if operand.kind == 'node')
    live.update(decode_projection_coordinate(operand.value)[0]
                for operand in stack + locals_
                if operand.kind == 'projection')
    pending = list(live)
    while pending:
        value = pending.pop()
        for operand in nodes[value - 1].arguments:
            dependency = (operand.value if operand.kind == 'node'
                          else decode_projection_coordinate(
                              operand.value)[0]
                          if operand.kind == 'projection' else None)
            if dependency is not None and dependency not in live:
                live.add(dependency)
                pending.append(dependency)

    remap = {}
    kept = []
    common = {}
    for node in nodes:
        if node.value not in live:
            continue
        arguments = []
        for operand in node.arguments:
            if operand.kind == 'node':
                operand = Operand('node', remap[operand.value])
            elif operand.kind == 'projection':
                source, selector = decode_projection_coordinate(
                    operand.value)
                operand = Operand('projection', projection_coordinate(
                    remap[source], selector))
            arguments.append(operand)
        arguments = tuple(arguments)
        key = (node.op, arguments)
        previous = None if node.op.startswith('memory.') else common.get(key)
        if previous is not None:
            remap[node.value] = previous
            continue
        value = len(kept) + 1
        remap[node.value] = value
        kept.append(WaveNode(value, node.op, arguments))
        if not node.op.startswith('memory.'):
            common[key] = value

    def output(operand):
        if operand.kind == 'node':
            return Operand('node', remap[operand.value])
        if operand.kind == 'projection':
            source, selector = decode_projection_coordinate(operand.value)
            return Operand('projection', projection_coordinate(
                remap[source], selector))
        return operand

    depths = [0]
    by_depth = {}
    for node in kept:
        dependencies = []
        for operand in node.arguments:
            if operand.kind == 'node':
                dependencies.append(operand.value)
            elif operand.kind == 'projection':
                dependencies.append(decode_projection_coordinate(
                    operand.value)[0])
        depth = 1 + max((depths[value] for value in dependencies), default=0)
        depths.append(depth)
        by_depth.setdefault(depth, []).append(node.value)
    offsets = [0]
    values = []
    for depth in range(1, max(by_depth, default=0) + 1):
        values.extend(by_depth.get(depth, ()))
        offsets.append(len(values))
    return (tuple(kept),
            DependencyWaves(tuple(offsets), tuple(values), tuple(depths)),
            tuple(map(output, stack)), tuple(map(output, locals_)))


def _compact(nodes, stack, locals_):
    """Substitute, delete and reschedule until the physical graph is fixed."""
    current = tuple(nodes), tuple(stack), tuple(locals_)
    seen = set()
    limit = max(2, len(current[0]) + 2)
    for _pass in range(limit):
        if current in seen:
            raise ValueError('physical normalization entered a rewrite cycle')
        seen.add(current)
        compacted = _compact_once(*current)
        following = compacted[0], compacted[2], compacted[3]
        if following == current:
            return compacted
        current = following
    raise ValueError('physical normalization did not reach a fixed point')


def _semantic_cut(plan):
    """Expose only lane forms the scalar solver can prove, without escape.

    Node coordinates, outputs and waves remain those of the canonical
    persistent cut.  This view changes operation spelling only; unsupported
    terminal primitives remain physical and make that backward island closed
    to the scalar solver.
    """
    from .wasmwave import PureSlice, WaveNode

    names = {
        'ADD': 'add', 'ADDR': 'add',
        'SUB': 'sub', 'SUBR': 'sub',
        'IMUL': 'mul', 'MULR': 'mul',
        'AND': 'and', 'ANDR': 'and',
        'OR': 'or', 'ORR': 'or',
        'XOR': 'xor', 'XORR': 'xor',
        'SHL': 'shl', 'SHLR': 'shl',
        'SHR': 'shr_u', 'SHRR': 'shr_u',
        'SAR': 'shr_s', 'SARR': 'shr_s',
        'CLZ': 'clz', 'CTZ': 'ctz', 'POPCNT': 'popcnt',
        'WRAP_I64': 'wrap_i64',
        'EXTEND_I32_S': 'extend_i32_s',
        'EXTEND_I32_U': 'extend_i32_u',
        'EXTEND8_S': 'extend8_s',
        'EXTEND16_S': 'extend16_s',
        'EXTEND32_S': 'extend32_s',
    }
    nodes = []
    for node in plan.nodes:
        if node.op.startswith('memory.'):
            nodes.append(node)
            continue
        prefix, name = node.op.split('.', 1)
        semantic = names.get(name)
        operation = node.op
        if semantic is not None:
            bits = prefix[len('lane'):]
            operation = 'i%s.%s' % (bits, semantic)
        nodes.append(WaveNode(node.value, operation, node.arguments))
    return PureSlice(
        plan.function, plan.start, plan.end, plan.instructions,
        plan.stack_inputs, tuple(nodes), plan.waves, plan.stack, plan.locals)


def normalize_plan(plan):
    """Normalize dominant future-visible work backward into one wave."""
    from .wasmwave import Operand, PureSlice, WaveNode

    # A decoded basic block may be reopened and extended with another
    # future-visible root (for example a branch predicate).  Its nodes already
    # have canonical physical lane names; sending those through frontend
    # selection a second time used to make residual composition impossible.
    # Mixed/raw frontend graphs still take the one mandatory selection pass.
    already_physical = all(
        node.op.startswith(('lane32.', 'lane64.', 'memory.'))
        for node in plan.nodes)
    raw = plan if already_physical else _physical_plan(plan)
    nodes, waves, stack, locals_ = _compact(
        raw.nodes, raw.stack, raw.locals)
    physical = PureSlice(
        raw.function, raw.start, raw.end, raw.instructions,
        raw.stack_inputs, nodes, waves, stack, locals_)
    semantic = _semantic_cut(physical)
    source_nodes = list(physical.nodes)
    roots = {operand.value for operand in physical.stack + physical.locals
             if operand.kind == 'node'}
    roots = sorted(roots, key=lambda root: (-len(_backward_nodes(semantic, root)),
                                            root))
    replacements = {}
    # Multi-coordinate cuts may have no closed single-input island at all.
    # Recompose the physical graph once unconditionally so those residuals do
    # not escape every QM pass merely because the scalar solver cannot pack
    # their independent inputs.
    best = (physical.nodes, physical.waves,
            physical.stack, physical.locals)
    for root in roots:
        normalized = _slice_sequence(semantic, root)
        if normalized is None:
            continue
        after, bits, input_operand, old_root = normalized
        trial_nodes = list(source_nodes)
        values = {0: input_operand}
        for result, instruction in enumerate(after.ins, start=1):
            arguments = [values[value] for value in instruction.args]
            constants = instruction.const
            if constants is not None:
                if not isinstance(constants, (tuple, list)):
                    constants = (constants,)
                arguments.extend(Operand('const', value)
                                 for value in constants)
            if instruction.shift is not None:
                arguments.append(Operand('const', instruction.shift))
            value = len(trial_nodes) + 1
            trial_nodes.append(WaveNode(
                value, 'lane%d.%s' % (bits, instruction.op),
                tuple(arguments)))
            values[result] = Operand('node', value)
        trial_replacements = dict(replacements)
        trial_replacements[old_root] = values[after.result]

        def output(operand):
            if operand.kind == 'node':
                return trial_replacements.get(operand.value, operand)
            return operand

        stack = tuple(map(output, physical.stack))
        locals_ = tuple(map(output, physical.locals))
        candidate = _compact(tuple(trial_nodes), stack, locals_)
        nodes, waves, _stack, _locals = candidate
        best_nodes, best_waves, _best_stack, _best_locals = best
        # A smaller root may share the dominant root's source prefix. Admit it
        # only after recomposition proves that neither physical dimension grew.
        if (len(nodes) <= len(best_nodes)
                and waves.span <= best_waves.span):
            source_nodes = trial_nodes
            replacements = trial_replacements
            best = candidate

    nodes, waves, stack, locals_ = best
    return PureSlice(
        plan.function, plan.start, plan.end, plan.instructions,
        plan.stack_inputs, nodes, waves, stack, locals_)


def physical_work(plan):
    """Count primitive lane work, excluding terminal scalarization.

    Most SSA nodes are one physical operation.  A relative exchange is one
    multi-result transaction whose adjacent record lanes remain the actual
    parallel work domain, so its encoded node contributes one unit per lane.
    Output projections are coordinates and therefore contribute no node at
    all after normalization.
    """
    from .steppage import decode_relative_layout

    work = 0
    for node in plan.nodes:
        if node.op != 'memory.i64.relative_exchange':
            work += 1
            continue
        if (len(node.arguments) < 5
                or node.arguments[4].kind != 'const'):
            raise ValueError(
                'relative exchange layout is not a physical constant')
        work += len(decode_relative_layout(node.arguments[4].value))
    return work


def compose_plans(first, second):
    """Substitute one physical state-step page into its deterministic next.

    The second page's local and stack inputs are coordinates published by the
    first page, not a materialized intermediate frame. Memory nodes retain
    their ordering dependencies and the combined graph goes through the same
    liveness, quotient and wave normalization as every frontend slice.
    """
    from .wasmwave import Operand, PureSlice, WaveNode
    from .steppage import (FLAG_PROJECTION_OPS, decode_projection_coordinate,
                           projection_coordinate)

    if first.function != second.function:
        raise ValueError('state-step composition crosses a function boundary')
    if len(first.stack) < second.stack_inputs:
        raise ValueError('second state-step reads an unavailable stack slot')

    nodes = list(first.nodes)
    last_memory = next((Operand('node', node.value)
                        for node in reversed(nodes)
                        if node.op.startswith('memory.')), None)
    remap = {}
    projection_nodes = {}

    def substitute_output(operand):
        if operand.kind == 'const':
            return operand
        if operand.kind == 'local':
            if operand.value >= len(first.locals):
                raise ValueError(
                    'second state-step reads an unavailable local slot')
            return first.locals[operand.value]
        if operand.kind == 'stack':
            if operand.value >= len(first.stack):
                raise ValueError(
                    'second state-step reads an unavailable stack slot')
            return first.stack[operand.value]
        if operand.kind == 'projection':
            source, selector = decode_projection_coordinate(operand.value)
            return Operand('projection', projection_coordinate(
                remap[source].value, selector))
        return remap[operand.value]

    def substitute_argument(operand):
        nonlocal last_memory
        resolved = substitute_output(operand)
        if resolved.kind != 'projection':
            return resolved
        source, selector = decode_projection_coordinate(resolved.value)
        if nodes[source - 1].op in FLAG_PROJECTION_OPS:
            return resolved
        key = source, selector
        projected = projection_nodes.get(key)
        if projected is None:
            value = len(nodes) + 1
            arguments = (
                Operand('node', source), Operand('const', selector))
            nodes.append(WaveNode(
                value, 'memory.i64.relative_result', arguments))
            projected = Operand('node', value)
            projection_nodes[key] = projected
            last_memory = projected
        return projected

    for node in second.nodes:
        value = len(nodes) + 1
        arguments = tuple(map(substitute_argument, node.arguments))
        if (node.op.startswith('memory.') and last_memory is not None
                and last_memory not in arguments):
            arguments += (last_memory,)
        nodes.append(WaveNode(
            value, node.op, arguments))
        remap[node.value] = Operand('node', value)
        if node.op.startswith('memory.'):
            last_memory = remap[node.value]

    stack = tuple(map(substitute_output, second.stack))
    locals_ = tuple(map(substitute_output, second.locals))
    instructions = first.instructions + second.instructions
    combined = PureSlice(
        first.function, first.start, first.start + instructions,
        instructions,
        first.stack_inputs, tuple(nodes), first.waves, stack, locals_)
    return normalize_plan(combined)
