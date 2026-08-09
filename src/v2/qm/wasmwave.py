"""Execute pure WebAssembly slices as dependency waves.

Memory, calls, globals and control flow remain exact one-instruction
boundaries.  Between them, stack and local traffic is renamed into SSA values;
all nodes at one dependency depth read the previous value snapshot and publish
their results together.  The machine frame is written once at the end of the
slice instead of once per WebAssembly instruction.
"""

from dataclasses import dataclass, replace

from .bits import mask_of
from .wasmphysical import DependencyWaves
from .laneops import evaluate as evaluate_physical
from .stepnormalize import normalize_plan
from .wasmstate import (I32, Control, Frame, WasmStateError, _block_results,
                        _branch, _coerce, _memory_read, _memory_write,
                        _numeric, instruction_step)


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


def _evaluate_source(op, arguments):
    """Evaluate a source operation only while constructing the SSA graph."""
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
            return Operand('const', _evaluate_source(
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

    # Renaming does not assign a second, provisional dependency layout.  The
    # persistent cut builder owns liveness, CSE and waves exactly once before
    # any backward work minimization can observe this graph.
    return normalize_plan(PureSlice(
        frame.function, frame.pc, pc, pc - frame.pc, len(frame.stack),
        tuple(nodes), None, tuple(stack), tuple(locals_)))


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
            (value, evaluate_physical(
                plan.nodes[value - 1].op,
                tuple(resolve(argument)
                      for argument in plan.nodes[value - 1].arguments)))
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


_EMPTY = object()


class _CoordinateArray(object):
    """Direct ``(function, pc)`` storage with stack extent as a guard."""

    def __init__(self, module):
        self.module = module
        # The first level is the exact function coordinate.  The pc row is
        # allocated only after that function body is touched and decoded.
        self.rows = [None] * len(module.functions)
        self.count = 0

    def _row(self, function):
        row = self.rows[function]
        if row is None:
            row = [_EMPTY] * len(self.module.functions[function].code)
            self.rows[function] = row
        return row

    def _at(self, key):
        function, pc, extent = map(int, key)
        if function < 0 or function >= len(self.rows):
            raise KeyError(key)
        row = self._row(function)
        if pc < 0 or pc >= len(row):
            raise KeyError(key)
        return row, pc, extent

    def __contains__(self, key):
        try:
            row, pc, extent = self._at(key)
        except KeyError:
            return False
        entry = row[pc]
        return entry is not _EMPTY and entry[0] == extent

    def __getitem__(self, key):
        row, pc, extent = self._at(key)
        entry = row[pc]
        if entry is _EMPTY or entry[0] != extent:
            raise KeyError(key)
        return entry[1]

    def __setitem__(self, key, value):
        row, pc, extent = self._at(key)
        entry = row[pc]
        if entry is not _EMPTY and entry[0] != extent:
            raise WasmStateError(
                'state-step coordinate changed its input stack extent')
        if entry is _EMPTY:
            self.count += 1
        row[pc] = (extent, value)

    def get(self, key, default=None):
        """Read one coordinate without a separate membership traversal."""
        try:
            row, pc, extent = self._at(key)
        except KeyError:
            return default
        entry = row[pc]
        return (default if entry is _EMPTY or entry[0] != extent
                else entry[1])

    def values(self):
        return (entry[1] for row in self.rows if row is not None
                for entry in row if entry is not _EMPTY)

    def items(self):
        return (((function, pc, entry[0]), entry[1])
                for function, row in enumerate(self.rows) if row is not None
                for pc, entry in enumerate(row) if entry is not _EMPTY)

    @property
    def resident_rows(self):
        return sum(row is not None for row in self.rows)

    def __len__(self):
        return self.count


@dataclass
class _PhysicalStep:
    """One resident physical page and its terminal executable projection."""

    mapped: object
    execute: object
    cost: WaveCost
    source_work: int
    executions: int = 0


@dataclass(frozen=True)
class _PhysicalPage:
    """Immutable QM result shared by executors of one decoded module."""

    mapped: object
    execute: object
    cost: WaveCost
    source_work: int


class WaveExecutor:
    """Cached barrier/slice executor for one decoded module."""

    def __init__(self, module):
        self.module = module
        # Function and source-pc are already dense physical coordinates.  One
        # entry owns the mapped page and its terminal executable projection;
        # the construction SSA is released before the entry becomes resident.
        self.steps = _CoordinateArray(module)
        self.total_cost = WaveCost()
        self.total_source_work = 0
        self.state_materializations = 0
        self.avoided_state_materializations = 0

    def _entry(self, frame):
        key = (frame.function, frame.pc, len(frame.stack))
        entry = self.steps.get(key)
        if entry is None:
            page = self.module._physical_pages.get(key)
            if page is None:
                plan = compile_slice(self.module, frame)
                if plan is None:
                    raise WasmStateError(
                        'a barrier has no physical residual state-step')
                from .steppage import compile_mapped_executor, pack, unpack

                function = self.module.functions[frame.function]
                source_work = sum(
                    1 for instruction in function.code[plan.start:plan.end]
                    if instruction.op == 'select'
                    or numeric_arity(instruction.op) is not None)
                mapped = unpack(pack(plan))
                widths = [
                    mapped.value('wave_offsets', depth + 1)
                    - mapped.value('wave_offsets', depth)
                    for depth in range(mapped.span)
                ]
                cost = WaveCost(
                    instructions=mapped.instructions,
                    work=mapped.work,
                    span=mapped.span,
                    slices=1,
                    max_parallel_width=max(widths, default=0),
                )
                page = _PhysicalPage(
                    mapped, compile_mapped_executor(mapped), cost,
                    source_work)
                self.module._physical_pages[key] = page
            self.steps[key] = _PhysicalStep(
                page.mapped, page.execute, page.cost, page.source_work)
            entry = self.steps.get(key)
        return entry

    def plan(self, frame):
        """Reconstruct scalar SSA only when a diagnostic explicitly asks."""
        from .steppage import decode_plan
        function = self.module.functions[frame.function]
        if (frame.pc >= len(function.code)
                or is_barrier(function.code[frame.pc].op)):
            return None
        entry = self._entry(frame)
        return decode_plan(entry.mapped)

    def normalization_layout(self):
        """Dynamic work removed before slices entered the codec cache."""
        source = self.total_source_work
        normalized = self.total_cost.work
        dominant = sorted(
            ((entry.executions * entry.mapped.work, entry.executions,
              key, entry.mapped.work, entry.mapped.span)
             for key, entry in self.steps.items()),
            reverse=True,
        )[:8]
        return {
            'source_work': source,
            'normalized_work': normalized,
            'removed_work': source - normalized,
            'cached_slices': len(self.steps),
            'compiled_state_steps': len(self.steps),
            'normalized_state_steps': sum(
                entry.mapped.work > 0
                for entry in self.steps.values()),
            'projection_state_steps': sum(
                entry.mapped.work == 0 for entry in self.steps.values()),
            'changed_local_coordinates': sum(
                entry.mapped.local_updates for entry in self.steps.values()),
            'resident_scalar_plans': 0,
            'state_materializations': self.state_materializations,
            'avoided_state_materializations':
                self.avoided_state_materializations,
            'dominant_residuals': [
                {
                    'dynamic_work': work,
                    'executions': executions,
                    'coordinate': list(key),
                    'work': static_work,
                    'span': span,
                }
                for work, executions, key, static_work, span in dominant
                if work
            ],
        }

    def mapped(self, frame):
        """The sole disposable codec page for the current pure slice."""
        function = self.module.functions[frame.function]
        if (frame.pc >= len(function.code)
                or is_barrier(function.code[frame.pc].op)):
            return None
        entry = self._entry(frame)
        return entry.mapped

    def _internal_control(self, function, pc, stack, controls):
        """Advance control state that no external cut can observe."""
        fn = self.module.functions[function]
        instruction = fn.code[pc]
        op = instruction.op
        next_pc = pc + 1
        next_stack = list(stack)
        next_controls = list(controls)

        def pop():
            if not next_stack:
                raise WasmStateError('%s pops an empty value stack' % op)
            return next_stack.pop()

        if op in ('block', 'loop', 'if'):
            results = _block_results(self.module, instruction.args[0])
            condition = pop() if op == 'if' else None
            control = Control(op, pc, fn.ends[pc], len(next_stack), results)
            next_controls.append(control)
            if op == 'if' and not condition:
                alternate = fn.elses[pc]
                next_pc = ((alternate + 1) if alternate >= 0
                           else control.end)
        elif op == 'else':
            if not next_controls or next_controls[-1].kind != 'if':
                raise WasmStateError('runtime else is outside an if')
            target = next_controls.pop()
            values = (next_stack[-target.results:]
                      if target.results else [])
            next_stack[:] = next_stack[:target.height] + values
            next_pc = target.end + 1
        elif op == 'end':
            if not next_controls:
                return None
            target = next_controls.pop()
            values = (next_stack[-target.results:]
                      if target.results else [])
            next_stack[:] = next_stack[:target.height] + values
        elif op in ('br', 'br_if'):
            take = True if op == 'br' else bool(pop())
            if take:
                depth = instruction.args[0]
                if depth == len(next_controls):
                    return None
                next_pc, next_stack, next_controls = _branch(
                    depth, next_stack, next_controls)
        elif op == 'br_table':
            labels, default = instruction.args
            selector = pop()
            depth = labels[selector] if selector < len(labels) else default
            if depth == len(next_controls):
                return None
            next_pc, next_stack, next_controls = _branch(
                depth, next_stack, next_controls)
        else:
            return None
        return next_pc, tuple(next_stack), tuple(next_controls)

    def _internal_effect(self, function, pc, stack, globals_, memory):
        """Apply an ordered guest effect without sealing the machine state."""
        instruction = self.module.functions[function].code[pc]
        op = instruction.op
        next_stack = list(stack)

        def pop():
            if not next_stack:
                raise WasmStateError('%s pops an empty value stack' % op)
            return next_stack.pop()

        if op.startswith('global.'):
            index = instruction.args[0]
            if index >= len(globals_):
                raise WasmStateError(
                    'global index %d is outside the module' % index)
            if op == 'global.get':
                next_stack.append(globals_[index])
            else:
                if not self.module.global_mutable[index]:
                    raise WasmStateError(
                        'write to immutable global %d' % index)
                changed = list(globals_)
                changed[index] = pop()
                globals_ = tuple(changed)
        elif ('.load' in op and '.atomic.' not in op
              and not op.startswith('memory.atomic.')):
            _align, offset, width, signed = instruction.args
            address = (pop() & I32) + offset
            raw = _memory_read(memory, address, width)
            value = int.from_bytes(raw, 'little')
            bits = 32 if op.startswith('i32') else 64
            if signed and value & (1 << (width * 8 - 1)):
                value -= 1 << (width * 8)
            next_stack.append(value & mask_of(bits))
        elif ('.store' in op and '.atomic.' not in op
              and not op.startswith('memory.atomic.')):
            _align, offset, width, _signed = instruction.args
            value = pop()
            address = (pop() & I32) + offset
            memory = _memory_write(
                memory, address,
                int(value & mask_of(width * 8)).to_bytes(width, 'little'))
        elif op == 'memory.size':
            from .wasmstate import PAGE
            next_stack.append(len(memory) // PAGE)
        else:
            return None
        return pc + 1, tuple(next_stack), globals_, memory

    def step(self, state, budget=None):
        if state.waiting is not None or state.halted:
            return state, WaveCost()
        if not state.frames:
            self.state_materializations += 1
            return instruction_step(self.module, state), WaveCost()
        frame = state.frames[-1]
        prefix_frames = list(state.frames[:-1])
        function_index = frame.function
        pc = frame.pc
        locals_ = frame.locals
        stack = frame.stack
        controls = frame.controls
        globals_ = state.globals
        memory = state.memory
        instructions = 0
        work = 0
        span = 0
        slices = 0
        barriers = 0
        max_parallel_width = 0
        transient_steps = 0

        while budget is None or instructions < budget:
            function = self.module.functions[function_index]
            if pc >= len(function.code):
                break
            instruction = function.code[pc]
            if not is_barrier(instruction.op):
                probe = Frame(function_index, pc, locals_, stack, controls)
                entry = self._entry(probe)
                if (budget is not None
                        and instructions + entry.cost.instructions
                        > budget):
                    break
                mapped = entry.mapped
                if len(locals_) != mapped.local_extent:
                    raise WasmStateError(
                        'state-step local extent changed at a physical '
                        'coordinate')
                entry.executions += 1
                locals_, stack = entry.execute(locals_, stack)
                pc = mapped.end
                instructions += entry.cost.instructions
                work += entry.cost.work
                span += entry.cost.span
                slices += entry.cost.slices
                max_parallel_width = max(
                    max_parallel_width, entry.cost.max_parallel_width)
                self.total_source_work += entry.source_work
                transient_steps += 1
                continue

            if (instruction.op == 'return'
                    or (instruction.op == 'end' and not controls)):
                if not prefix_frames:
                    break
                if budget is not None and instructions + 1 > budget:
                    break
                ftype = self.module.types[function.type_index]
                count = len(ftype.results)
                values = stack[-count:] if count else ()
                parent = prefix_frames.pop()
                function_index = parent.function
                pc = parent.pc
                locals_ = parent.locals
                stack = parent.stack + tuple(values)
                controls = parent.controls
                instructions += 1
                barriers += 1
                transient_steps += 1
                continue

            if instruction.op == 'call':
                callee_index = instruction.args[0]
                callee = self.module.functions[callee_index]
                if not callee.imported:
                    if budget is not None and instructions + 1 > budget:
                        break
                    callee_type = self.module.types[callee.type_index]
                    next_stack = list(stack)
                    count = len(callee_type.params)
                    if len(next_stack) < count:
                        raise WasmStateError(
                            'call pops an empty value stack')
                    arguments = (next_stack[-count:] if count else [])
                    if count:
                        del next_stack[-count:]
                    prefix_frames.append(Frame(
                        function_index, pc + 1, locals_, tuple(next_stack),
                        controls))
                    locals_ = tuple(
                        _coerce(value, kind)
                        for value, kind in zip(arguments, callee_type.params))
                    locals_ += tuple(0 for _ in callee.locals)
                    function_index = callee_index
                    pc = 0
                    stack = ()
                    controls = ()
                    instructions += 1
                    barriers += 1
                    transient_steps += 1
                    continue

            advanced = self._internal_control(
                function_index, pc, stack, controls)
            if advanced is not None:
                if budget is not None and instructions + 1 > budget:
                    break
                pc, stack, controls = advanced
                instructions += 1
                barriers += 1
                transient_steps += 1
                continue

            effected = self._internal_effect(
                function_index, pc, stack, globals_, memory)
            if effected is not None:
                if budget is not None and instructions + 1 > budget:
                    break
                pc, stack, globals_, memory = effected
                instructions += 1
                barriers += 1
                transient_steps += 1
                continue
            break

        if transient_steps:
            cost = WaveCost(
                instructions, work, span, slices, barriers,
                max_parallel_width)
            next_frame = Frame(function_index, pc, locals_, stack, controls)
            next_state = replace(
                state, frames=tuple(prefix_frames) + (next_frame,),
                globals=globals_, memory=memory)
            self.state_materializations += 1
            self.avoided_state_materializations += transient_steps - 1
            return next_state, cost

        if budget is not None and budget < 1:
            return state, WaveCost()
        self.state_materializations += 1
        return instruction_step(self.module, state), WaveCost(
            instructions=1, barriers=1)

    def run_quantum_with_report(self, state, budget=1 << 20):
        """Run one bounded quantum and retain its continuation on exhaustion."""
        cost = WaveCost()
        while state.waiting is None and not state.halted:
            next_state, step_cost = self.step(
                state, budget - cost.instructions)
            if not step_cost.instructions:
                if next_state is not state:
                    state = next_state
                break
            state = next_state
            cost += step_cost
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
