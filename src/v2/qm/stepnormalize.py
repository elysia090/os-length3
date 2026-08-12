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


def _rewrite_physical(nodes, stack, locals_):
    """Recompose local quotient identities across a multi-input SSA cut.

    The single-input minimizer handles the expensive closed backward slices.
    This pass handles identities whose inputs remain separate physical
    coordinates, without packing them into a synthetic scalar or materializing
    a second plan.  Every replacement is one exact lane primitive and the
    following liveness pass proves the resulting work/span objective.
    """
    from .wasmwave import Operand, WaveNode

    outputs = {operand.value for operand in stack + locals_
               if operand.kind == 'node'}
    consumers = {node.value: [] for node in nodes}
    for node in nodes:
        for operand in node.arguments:
            if operand.kind == 'node':
                consumers[operand.value].append(node.op)

    remap = {}
    rebuilt = []
    forms = {}

    def resolve(operand):
        if operand.kind != 'node':
            return operand
        return remap[operand.value]

    def form(operand):
        return forms.get(operand.value) if operand.kind == 'node' else None

    def constant(operand):
        return operand.value if operand.kind == 'const' else None

    def emit(operation, arguments):
        value = len(rebuilt) + 1
        operand = Operand('node', value)
        rebuilt.append(WaveNode(value, operation, tuple(arguments)))
        forms[value] = (operation, tuple(arguments))
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
        if operation in ('memory.i64.repeat', 'memory.i64.find2'):
            operand = emit(operation, arguments)
            remap[node.value] = operand
            continue
        if operation.startswith('memory.'):
            store = '.store' in operation
            data_count = 2 if store else 1
            data = arguments[:data_count]
            offset, shape = arguments[data_count:data_count + 2]
            dependencies = arguments[data_count + 2:]
            raw_shape = constant(shape)
            if raw_shape is None:
                raise ValueError('memory width is not a physical constant')
            from .steppage import decode_memory_shape, memory_shape
            access_width, scale, virtual64 = decode_memory_shape(raw_shape)
            address_form = form(data[0])
            if (scale == 0 and address_form is not None
                    and address_form[0] == 'lane32.SHL'
                    and len(address_form[1]) == 2
                    and constant(address_form[1][1]) is not None):
                amount = constant(address_form[1][1]) % 32
                data = (address_form[1][0],) + data[1:]
                scale = amount
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

        def already_projected(operand):
            if bits == 64 or operand.kind == 'const':
                return True
            source = form(operand)
            return source is not None and source[0].startswith(width + '.')

        # Wasm values already use an unsigned host representation.  The
        # unsigned extension therefore changes the type observer, not the
        # stored coordinate.
        if name == 'EXTEND_I32_U':
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
            if (source is not None and source[0] == width + '.AND'
                    and mask is not None
                    and constant(source[1][1]) is not None):
                operation = width + '.AND'
                arguments = (
                    source[1][0], Operand(
                        'const', mask & constant(source[1][1])))
            elif source is not None and mask == 1 and source[0] in (
                    width + '.SHRR', width + '.SHR'):
                shift = form(source[1][1])
                if (shift is not None and shift[0] == width + '.ANDNR'
                        and constant(shift[1][1]) == 7):
                    operation = width + '.BIT_MSB8'
                    arguments = (source[1][0], shift[1][0])
                else:
                    operation = width + '.BIT'
                    arguments = source[1]
            elif source is not None and source[0] == width + '.XOR':
                inverted = source[1]
                if (len(inverted) == 2
                        and constant(inverted[1]) == full
                        and mask is not None):
                    operation = width + '.ANDNR'
                    arguments = (inverted[0], arguments[1])

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

        if replacement is not None:
            remap[node.value] = replacement
            continue
        operand = emit(operation, arguments)
        remap[node.value] = operand

    def output(operand):
        return resolve(operand) if operand.kind == 'node' else operand

    return tuple(rebuilt), tuple(map(output, stack)), tuple(map(output, locals_))


def _compact(nodes, stack, locals_):
    """Remove superseded SSA and rebuild dense physical dependency waves."""
    from .wasmphysical import DependencyWaves
    from .wasmwave import Operand, WaveNode

    nodes, stack, locals_ = _rewrite_physical(nodes, stack, locals_)

    trapping = {'DIV_S', 'DIV_U', 'REM_S', 'REM_U'}
    live = {node.value for node in nodes
            if (node.op.startswith('memory.')
                or node.op.split('.', 1)[-1] in trapping)}
    live.update(operand.value for operand in stack + locals_
                if operand.kind == 'node')
    pending = list(live)
    while pending:
        value = pending.pop()
        for operand in nodes[value - 1].arguments:
            if operand.kind == 'node' and operand.value not in live:
                live.add(operand.value)
                pending.append(operand.value)

    remap = {}
    kept = []
    common = {}
    for node in nodes:
        if node.value not in live:
            continue
        arguments = tuple(
            Operand('node', remap[operand.value])
            if operand.kind == 'node' else operand
            for operand in node.arguments)
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
        return (Operand('node', remap[operand.value])
                if operand.kind == 'node' else operand)

    depths = [0]
    by_depth = {}
    for node in kept:
        depth = 1 + max((depths[operand.value]
                         for operand in node.arguments
                         if operand.kind == 'node'), default=0)
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


def compose_plans(first, second):
    """Substitute one physical state-step page into its deterministic next.

    The second page's local and stack inputs are coordinates published by the
    first page, not a materialized intermediate frame. Memory nodes retain
    their ordering dependencies and the combined graph goes through the same
    liveness, quotient and wave normalization as every frontend slice.
    """
    from .wasmwave import Operand, PureSlice, WaveNode

    if first.function != second.function:
        raise ValueError('state-step composition crosses a function boundary')
    if len(first.stack) < second.stack_inputs:
        raise ValueError('second state-step reads an unavailable stack slot')

    nodes = list(first.nodes)
    last_memory = next((Operand('node', node.value)
                        for node in reversed(nodes)
                        if node.op.startswith('memory.')), None)
    remap = {}

    def substitute(operand):
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
        return remap[operand.value]

    for node in second.nodes:
        value = len(nodes) + 1
        arguments = tuple(map(substitute, node.arguments))
        if (node.op.startswith('memory.') and last_memory is not None
                and last_memory not in arguments):
            arguments += (last_memory,)
        nodes.append(WaveNode(
            value, node.op, arguments))
        remap[node.value] = Operand('node', value)
        if node.op.startswith('memory.'):
            last_memory = remap[node.value]

    stack = tuple(map(substitute, second.stack))
    locals_ = tuple(map(substitute, second.locals))
    instructions = first.instructions + second.instructions
    combined = PureSlice(
        first.function, first.start, first.start + instructions,
        instructions,
        first.stack_inputs, tuple(nodes), first.waves, stack, locals_)
    return normalize_plan(combined)
