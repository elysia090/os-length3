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
    'eqz', 'clz', 'ctz', 'popcnt',
}
_BINARY = {
    'eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
    'le_s', 'le_u', 'ge_s', 'ge_u',
    'add', 'sub', 'mul', 'and', 'or', 'xor',
    'shl', 'shr_s', 'shr_u', 'rotl', 'rotr',
    'div_s', 'div_u', 'rem_s', 'rem_u',
}


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


def compile_slice(module, frame):
    """Rename the maximal pure region at ``frame.pc`` into an SSA wave plan."""
    function = module.functions[frame.function]
    pc = frame.pc
    if pc >= len(function.code) or is_barrier(function.code[pc].op):
        return None

    stack = [Operand('stack', index) for index in range(len(frame.stack))]
    locals_ = [Operand('local', index) for index in range(len(frame.locals))]
    nodes = []
    depths = [0]
    by_depth = {}

    def pop(op):
        if not stack:
            raise WasmStateError('%s pops an empty value stack' % op)
        return stack.pop()

    def emit(op, arguments):
        if all(argument.kind == 'const' for argument in arguments):
            return Operand('const', _evaluate(
                op, tuple(argument.value for argument in arguments)))
        value = len(nodes) + 1
        depth = 1 + max((depths[argument.value]
                         for argument in arguments
                         if argument.kind == 'node'), default=0)
        nodes.append(WaveNode(value, op, tuple(arguments)))
        depths.append(depth)
        by_depth.setdefault(depth, []).append(value)
        return Operand('node', value)

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

    offsets = [0]
    values = []
    for depth in range(1, max(by_depth, default=0) + 1):
        values.extend(by_depth.get(depth, ()))
        offsets.append(len(values))
    waves = DependencyWaves(tuple(offsets), tuple(values), tuple(depths))
    return PureSlice(frame.function, frame.pc, pc, pc - frame.pc,
                     tuple(nodes), waves, tuple(stack), tuple(locals_))


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


class WaveExecutor:
    """Cached barrier/slice executor for one decoded module."""

    def __init__(self, module):
        self.module = module
        self.cache = {}
        self.total_cost = WaveCost()

    def plan(self, frame):
        key = (frame.function, frame.pc, len(frame.stack))
        if key not in self.cache:
            self.cache[key] = compile_slice(self.module, frame)
        return self.cache[key]

    def step(self, state):
        if state.waiting is not None or state.halted:
            return state, WaveCost()
        if not state.frames:
            return instruction_step(self.module, state), WaveCost()
        plan = self.plan(state.frames[-1])
        if plan is None:
            return instruction_step(self.module, state), WaveCost(
                instructions=1, barriers=1)
        widths = [len(plan.waves.wave(depth))
                  for depth in range(1, plan.waves.span + 1)]
        return execute_slice(plan, state), WaveCost(
            instructions=plan.instructions,
            work=plan.waves.work,
            span=plan.waves.span,
            slices=1,
            max_parallel_width=max(widths, default=0),
        )

    def run_with_report(self, state, budget=1 << 20):
        cost = WaveCost()
        while state.waiting is None and not state.halted:
            next_state, step_cost = self.step(state)
            if cost.instructions + step_cost.instructions > budget:
                break
            state = next_state
            cost += step_cost
        else:
            self.total_cost += cost
            return state, cost
        raise WasmStateError(
            'wasm state step budget of %d was exhausted' % budget,
            hint='the program did not reach input or termination')

    def run(self, state, budget=1 << 20):
        return self.run_with_report(state, budget)[0]
