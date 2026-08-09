"""Execute pure WebAssembly slices as dependency waves.

Memory, calls, globals and control flow remain exact one-instruction
boundaries.  Between them, stack and local traffic is renamed into SSA values;
all nodes at one dependency depth read the previous value snapshot and publish
their results together.  The machine frame is written once at the end of the
slice instead of once per WebAssembly instruction.
"""

from dataclasses import dataclass, replace

from .wasmphysical import DependencyWaves
from .wasmstate import (Frame, WasmStateError, _numeric, instruction_step)


_UNARY = {
    'wrap_i64', 'extend_i32_s', 'extend_i32_u',
    'extend8_s', 'extend16_s', 'extend32_s',
    'eqz', 'clz', 'ctz', 'popcnt',
}
_BINARY = {
    'eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
    'le_s', 'le_u', 'ge_s', 'ge_u',
    'add', 'sub', 'mul', 'and', 'or', 'xor',
    'shl', 'shr_s', 'shr_u', 'rotl', 'rotr',
    'div_s', 'div_u', 'rem_s', 'rem_u',
}
_COMMUTATIVE = {'eq', 'ne', 'add', 'mul', 'and', 'or', 'xor'}
_TRAPPING = {'div_s', 'div_u', 'rem_s', 'rem_u'}


@dataclass(frozen=True)
class Operand:
    kind: str
    value: int


@dataclass(frozen=True)
class WaveNode:
    value: int
    op: str
    arguments: tuple


@dataclass(frozen=True)
class PureSlice:
    function: int
    start: int
    end: int
    instructions: int
    stack_inputs: int
    nodes: tuple
    waves: DependencyWaves
    stack: tuple
    locals: tuple

    def layout(self):
        layout = self.waves.layout()
        layout.update({
            'function': self.function,
            'start_pc': self.start,
            'end_pc': self.end,
            'wasm_instructions': self.instructions,
            'input_stack_slots': self.stack_inputs,
        })
        return layout


@dataclass(frozen=True)
class WaveCost:
    """Physical cost accumulated while advancing one machine state."""

    instructions: int = 0
    work: int = 0
    span: int = 0
    slices: int = 0
    barriers: int = 0
    max_parallel_width: int = 0

    def __add__(self, other):
        return WaveCost(
            self.instructions + other.instructions,
            self.work + other.work,
            self.span + other.span,
            self.slices + other.slices,
            self.barriers + other.barriers,
            max(self.max_parallel_width, other.max_parallel_width),
        )

    def layout(self):
        return {
            'wasm_instructions': self.instructions,
            'work': self.work,
            'span': self.span,
            'pure_slices': self.slices,
            'barriers': self.barriers,
            'max_parallel_width': self.max_parallel_width,
        }


def numeric_arity(op):
    """Return the integer data arity, or ``None`` for a barrier/unknown op."""
    if not op.startswith(('i32.', 'i64.')):
        return None
    name = op.split('.', 1)[1]
    if name in _UNARY:
        return 1
    if name in _BINARY:
        return 2
    return None


def is_barrier(op):
    """Whether an instruction must remain an ordered machine-state step."""
    return not (op == 'nop' or op in ('drop', 'select')
                or op.startswith('local.') or op.endswith('.const')
                or numeric_arity(op) is not None)


def _evaluate(op, arguments):
    if op == 'select':
        left, right, condition = arguments
        return left if condition else right
    stack = list(arguments)
    _numeric(op, stack)
    if len(stack) != 1:
        raise WasmStateError('%s did not produce one wave value' % op)
    return stack[0]


def _operand_key(operand):
    # Constants last makes identities such as ``x + 0`` canonical without
    # changing the source operation's integer type.
    return operand.kind == 'const', operand.kind, operand.value


def _live_graph(nodes, stack, locals_):
    """Remove dead non-trapping nodes and rebuild dense dependency waves."""
    live = set(node.value for node in nodes
               if node.op.split('.', 1)[-1] in _TRAPPING)
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
    for node in nodes:
        if node.value not in live:
            continue
        value = len(kept) + 1
        remap[node.value] = value
        arguments = tuple(
            Operand('node', remap[operand.value])
            if operand.kind == 'node' else operand
            for operand in node.arguments)
        kept.append(WaveNode(value, node.op, arguments))

    def output(operand):
        if operand.kind == 'node':
            return Operand('node', remap[operand.value])
        return operand

    depths = [0]
    by_depth = {}
    for node in kept:
        depth = 1 + max((depths[argument.value]
                         for argument in node.arguments
                         if argument.kind == 'node'), default=0)
        depths.append(depth)
        by_depth.setdefault(depth, []).append(node.value)
    offsets = [0]
    values = []
    for depth in range(1, max(by_depth, default=0) + 1):
        values.extend(by_depth.get(depth, ()))
        offsets.append(len(values))
    waves = DependencyWaves(tuple(offsets), tuple(values), tuple(depths))
    return tuple(kept), waves, tuple(map(output, stack)), \
        tuple(map(output, locals_))


def compile_slice(module, frame):
    """Rename the maximal pure region at ``frame.pc`` into an SSA wave plan."""
    function = module.functions[frame.function]
    pc = frame.pc
    if pc >= len(function.code) or is_barrier(function.code[pc].op):
        return None

    stack = [Operand('stack', index) for index in range(len(frame.stack))]
    locals_ = [Operand('local', index) for index in range(len(frame.locals))]
    nodes = []
    common = {}

    def pop(op):
        if not stack:
            raise WasmStateError('%s pops an empty value stack' % op)
        return stack.pop()

    def emit(op, arguments):
        if all(argument.kind == 'const' for argument in arguments):
            return Operand('const', _evaluate(
                op, tuple(argument.value for argument in arguments)))
        name = op.split('.', 1)[-1]
        arguments = tuple(arguments)
        if name in _COMMUTATIVE:
            arguments = tuple(sorted(arguments, key=_operand_key))

        if op == 'select':
            left, right, condition = arguments
            if condition.kind == 'const':
                return left if condition.value else right
            if left == right:
                return left
        elif len(arguments) == 2:
            left, right = arguments
            bits = 32 if op.startswith('i32.') else 64
            if left == right:
                if name in ('sub', 'xor', 'ne', 'lt_s', 'lt_u',
                            'gt_s', 'gt_u'):
                    return Operand('const', 0)
                if name in ('and', 'or'):
                    return left
                if name in ('eq', 'le_s', 'le_u', 'ge_s', 'ge_u'):
                    return Operand('const', 1)
            if right.kind == 'const':
                constant = right.value & ((1 << bits) - 1)
                if name in ('add', 'sub', 'or', 'xor') and constant == 0:
                    return left
                if name == 'mul' and constant == 1:
                    return left
                if name == 'mul' and constant == 0:
                    return Operand('const', 0)
                if name == 'and' and constant == (1 << bits) - 1:
                    return left
                if name == 'and' and constant == 0:
                    return Operand('const', 0)
                if name in ('shl', 'shr_s', 'shr_u', 'rotl', 'rotr') \
                        and constant % bits == 0:
                    return left
                if name in ('div_s', 'div_u') and constant == 1:
                    return left
                if name in ('rem_s', 'rem_u') and constant == 1:
                    return Operand('const', 0)

        key = (op, arguments)
        if key in common:
            return common[key]
        value = len(nodes) + 1
        nodes.append(WaveNode(value, op, arguments))
        result = Operand('node', value)
        common[key] = result
        return result

    while pc < len(function.code):
        instruction = function.code[pc]
        op = instruction.op
        if is_barrier(op):
            break
        if op == 'nop':
            pass
        elif op == 'drop':
            pop(op)
        elif op == 'select':
            condition, right, left = pop(op), pop(op), pop(op)
            stack.append(emit(op, (left, right, condition)))
        elif op.startswith('local.'):
            index = instruction.args[0]
            if index >= len(locals_):
                raise WasmStateError('local index %d is outside the frame'
                                     % index)
            if op == 'local.get':
                stack.append(locals_[index])
            elif op == 'local.set':
                locals_[index] = pop(op)
            else:
                if not stack:
                    raise WasmStateError('%s reads an empty value stack' % op)
                locals_[index] = stack[-1]
        elif op.endswith('.const'):
            stack.append(Operand('const', instruction.args[0]))
        else:
            arity = numeric_arity(op)
            arguments = tuple(pop(op) for _ in range(arity))[::-1]
            stack.append(emit(op, arguments))
        pc += 1

    nodes, waves, stack, locals_ = _live_graph(
        tuple(nodes), tuple(stack), tuple(locals_))
    return PureSlice(frame.function, frame.pc, pc, pc - frame.pc,
                     len(frame.stack),
                     nodes, waves, stack, locals_)


def execute_slice(plan, state):
    """Evaluate each wave from a stable snapshot, then commit one frame."""
    frame = state.frames[-1]
    values = {}

    def resolve(operand):
        if operand.kind == 'const':
            return operand.value
        if operand.kind == 'stack':
            return frame.stack[operand.value]
        if operand.kind == 'local':
            return frame.locals[operand.value]
        return values[operand.value]

    for depth in range(1, plan.waves.span + 1):
        # No node in this tuple can depend on another node in the tuple.  Delay
        # publication until all lane results have been evaluated so the Python
        # reference executor has the same simultaneous-write semantics as the
        # physical parallel implementation.
        produced = tuple(
            (value, _evaluate(plan.nodes[value - 1].op,
                              tuple(resolve(argument)
                                    for argument
                                    in plan.nodes[value - 1].arguments)))
            for value in plan.waves.wave(depth)
        )
        values.update(produced)

    next_frame = Frame(
        frame.function,
        plan.end,
        tuple(resolve(value) for value in plan.locals),
        tuple(resolve(value) for value in plan.stack),
        frame.controls,
    )
    return replace(state, frames=state.frames[:-1] + (next_frame,))


def compile_slice_executor(plan):
    """Compile one validated codec plan into a direct frame transition."""
    lines = ['def execute(frame, evaluate=evaluate):',
             '    stack = frame.stack',
             '    locals_ = frame.locals']

    def expression(operand):
        if operand.kind == 'const':
            return repr(operand.value)
        if operand.kind == 'stack':
            return 'stack[%d]' % operand.value
        if operand.kind == 'local':
            return 'locals_[%d]' % operand.value
        return 'value_%d' % operand.value

    for node in plan.nodes:
        arguments = ', '.join(expression(argument)
                              for argument in node.arguments)
        if len(node.arguments) == 1:
            arguments += ','
        lines.append("    value_%d = evaluate(%r, (%s))" %
                     (node.value, node.op, arguments))
    local_values = ', '.join(expression(value) for value in plan.locals)
    stack_values = ', '.join(expression(value) for value in plan.stack)
    if len(plan.locals) == 1:
        local_values += ','
    if len(plan.stack) == 1:
        stack_values += ','
    lines.append('    return (%s), (%s)' % (local_values, stack_values))
    namespace = {'evaluate': _evaluate}
    exec(compile('\n'.join(lines), '<qm-wasm-slice>', 'exec'),
         namespace, namespace)
    return namespace['execute']


def execute_compiled(plan, executor, state):
    """Commit the outputs of a hot compiled slice as one state update."""
    frame = state.frames[-1]
    locals_, stack = executor(frame)
    next_frame = Frame(frame.function, plan.end, tuple(locals_), tuple(stack),
                       frame.controls)
    return replace(state, frames=state.frames[:-1] + (next_frame,))


class WaveExecutor:
    """Cached barrier/slice executor for one decoded module."""

    def __init__(self, module):
        self.module = module
        self.cache = {}
        self.source_work = {}
        self.physical = {}
        self.executable = {}
        self.hits = {}
        self.compiled = {}
        self.total_cost = WaveCost()
        self.total_source_work = 0

    def plan(self, frame):
        key = (frame.function, frame.pc, len(frame.stack))
        if key not in self.cache:
            plan = compile_slice(self.module, frame)
            self.cache[key] = plan
            if plan is not None:
                function = self.module.functions[frame.function]
                self.source_work[key] = sum(
                    1 for instruction in function.code[plan.start:plan.end]
                    if instruction.op == 'select'
                    or numeric_arity(instruction.op) is not None)
        return self.cache[key]

    def normalization_layout(self):
        """Dynamic work removed before slices entered the codec cache."""
        source = self.total_source_work
        normalized = self.total_cost.work
        return {
            'source_work': source,
            'normalized_work': normalized,
            'removed_work': source - normalized,
            'cached_slices': sum(plan is not None
                                 for plan in self.cache.values()),
            'compiled_hot_slices': len(self.compiled),
        }

    def mapped(self, frame):
        """The disposable codec page for the current pure slice."""
        from .wasmcodec import pack, unpack
        key = (frame.function, frame.pc, len(frame.stack))
        if key not in self.physical:
            plan = self.plan(frame)
            self.physical[key] = None if plan is None else unpack(pack(plan))
        return self.physical[key]

    def decoded(self, frame):
        """Validated execution plan decoded once from its physical page."""
        from .wasmcodec import decode_plan
        key = (frame.function, frame.pc, len(frame.stack))
        if key not in self.executable:
            mapped = self.mapped(frame)
            self.executable[key] = (None if mapped is None
                                    else decode_plan(mapped))
        return self.executable[key]

    def step(self, state):
        if state.waiting is not None or state.halted:
            return state, WaveCost()
        if not state.frames:
            return instruction_step(self.module, state), WaveCost()
        frame = state.frames[-1]
        plan = self.plan(frame)
        if plan is None:
            return instruction_step(self.module, state), WaveCost(
                instructions=1, barriers=1)
        widths = [len(plan.waves.wave(depth))
                  for depth in range(1, plan.waves.span + 1)]
        key = (frame.function, frame.pc, len(frame.stack))
        hits = self.hits.get(key, 0) + 1
        self.hits[key] = hits
        decoded = self.decoded(frame)
        if hits >= 2:
            if key not in self.compiled:
                self.compiled[key] = compile_slice_executor(decoded)
            next_state = execute_compiled(
                decoded, self.compiled[key], state)
        else:
            next_state = execute_slice(decoded, state)
        return next_state, WaveCost(
            instructions=plan.instructions,
            work=plan.waves.work,
            span=plan.waves.span,
            slices=1,
            max_parallel_width=max(widths, default=0),
        )

    def run_quantum_with_report(self, state, budget=1 << 20):
        """Run one bounded quantum and retain its continuation on exhaustion."""
        cost = WaveCost()
        while state.waiting is None and not state.halted:
            source_key = None
            if state.frames:
                frame = state.frames[-1]
                source_key = (frame.function, frame.pc, len(frame.stack))
            next_state, step_cost = self.step(state)
            if cost.instructions + step_cost.instructions > budget:
                break
            state = next_state
            cost += step_cost
            if step_cost.slices:
                self.total_source_work += self.source_work[source_key]
        reached_boundary = state.waiting is not None or state.halted
        self.total_cost += cost
        return state, cost, reached_boundary

    def run_with_report(self, state, budget=1 << 20):
        state, cost, reached_boundary = self.run_quantum_with_report(
            state, budget)
        if reached_boundary:
            return state, cost
        raise WasmStateError(
            'wasm state step budget of %d was exhausted' % budget,
            hint='the program did not reach input or termination')

    def run(self, state, budget=1 << 20):
        return self.run_with_report(state, budget)[0]
