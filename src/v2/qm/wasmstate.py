"""Compile a wasm32 module to a clonable, pure machine-state transition.

The scalar wasm reader evaluates small flat functions.  This module has a
different job: retain the program counter, call frames, locals, globals and
linear memory so a whole compiled driver can be stopped at an imported input
call and resumed on each possible byte.  No C syntax is involved after Clang
has produced the module.

``instruction_step`` is the lightweight compiler's primitive:

    MachineState -> MachineState

``stream_step`` runs those pure steps to the next ``qm_getchar`` boundary.
The resulting ``state, byte -> state`` and ``observe(state)`` pair can be fed
to the exact finite-transducer quotient.  Unsupported instructions are named;
an incomplete decode is never used as program semantics.
"""

from dataclasses import dataclass, replace

from .bits import mask_of
from .cfront.errors import CFrontError, UnsupportedC


PAGE = 65536
MEMORY_PAGE = 256
EOF = 256
I32 = mask_of(32)
I64 = mask_of(64)
VALTYPES = {0x7F: 'i32', 0x7E: 'i64', 0x7D: 'f32', 0x7C: 'f64',
            0x7B: 'v128', 0x70: 'funcref', 0x6F: 'externref'}


class WasmStateError(CFrontError):
    """A malformed module or an invalid machine transition."""


class PagedMemory(object):
    """Immutable linear memory with shared unchanged bytes.

    WebAssembly modules commonly reserve tens of MiB even when a transition
    writes only a handful of words.  Copying that reservation after every
    store changes the cost of the interpreter without changing its semantics.
    This value keeps the decoded module bytes as one shared base and records
    only complete 256-byte pages that differ from it.
    """

    __slots__ = ('base', 'length', 'pages', '_hash')

    def __init__(self, base, length=None, pages=()):
        self.base = bytes(base)
        self.length = len(self.base) if length is None else int(length)
        if self.length < len(self.base):
            raise ValueError('linear memory cannot be shorter than its base')
        self.pages = tuple(pages)
        self._hash = None

    def __len__(self):
        return self.length

    def __eq__(self, other):
        return (isinstance(other, PagedMemory)
                and self.length == other.length
                and self.pages == other.pages
                and (self.base is other.base or self.base == other.base))

    def __hash__(self):
        value = self._hash
        if value is None:
            value = hash((self.base, self.length, self.pages))
            self._hash = value
        return value

    def _base_page(self, index):
        start = index * MEMORY_PAGE
        raw = self.base[start:start + MEMORY_PAGE]
        if len(raw) < MEMORY_PAGE:
            raw += bytes(MEMORY_PAGE - len(raw))
        return raw

    def read(self, address, size):
        if address < 0 or size < 0 or address + size > self.length:
            raise WasmStateError('wasm memory access is out of bounds')
        if not size:
            return b''
        changed = dict(self.pages)
        out = bytearray()
        end = address + size
        while address < end:
            index, offset = divmod(address, MEMORY_PAGE)
            count = min(end - address, MEMORY_PAGE - offset)
            page = changed.get(index)
            if page is None:
                page = self._base_page(index)
            out.extend(page[offset:offset + count])
            address += count
        return bytes(out)

    def write(self, address, payload):
        payload = bytes(payload)
        if address < 0 or address + len(payload) > self.length:
            raise WasmStateError('wasm memory access is out of bounds')
        if not payload:
            return self
        changed = dict(self.pages)
        at = 0
        while at < len(payload):
            absolute = address + at
            index, offset = divmod(absolute, MEMORY_PAGE)
            count = min(len(payload) - at, MEMORY_PAGE - offset)
            page = bytearray(changed.get(index, self._base_page(index)))
            page[offset:offset + count] = payload[at:at + count]
            page = bytes(page)
            if page == self._base_page(index):
                changed.pop(index, None)
            else:
                changed[index] = page
            at += count
        return PagedMemory(self.base, self.length, sorted(changed.items()))

    def grow(self, pages):
        if pages < 0:
            raise ValueError('page count must be nonnegative')
        if not pages:
            return self
        return PagedMemory(self.base, self.length + pages * PAGE, self.pages)


class _Reader(object):
    __slots__ = ('data', 'at', 'end')

    def __init__(self, data, start=0, end=None):
        self.data = memoryview(data)
        self.at = start
        self.end = len(self.data) if end is None else end

    def byte(self):
        if self.at >= self.end:
            raise WasmStateError('unexpected end of wasm binary')
        value = self.data[self.at]
        self.at += 1
        return int(value)

    def take(self, count):
        if count < 0 or self.at + count > self.end:
            raise WasmStateError('wasm field exceeds its section')
        value = bytes(self.data[self.at:self.at + count])
        self.at += count
        return value

    def uleb(self, bits=32):
        value = 0
        shift = 0
        while True:
            byte = self.byte()
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                if value >= 1 << bits:
                    raise WasmStateError('unsigned LEB exceeds %d bits' % bits)
                return value
            shift += 7
            if shift >= bits + 7:
                raise WasmStateError('unterminated unsigned LEB')

    def sleb(self, bits=32):
        value = 0
        shift = 0
        while True:
            byte = self.byte()
            value |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                if shift < bits and byte & 0x40:
                    value |= -(1 << shift)
                return value
            if shift >= bits + 7:
                raise WasmStateError('unterminated signed LEB')

    def name(self):
        raw = self.take(self.uleb())
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:
            raise WasmStateError('wasm name is not UTF-8')

    def vector(self, read):
        return tuple(read() for _ in range(self.uleb()))

    def done(self):
        return self.at >= self.end


@dataclass(frozen=True)
class FunctionType:
    params: tuple
    results: tuple


@dataclass(frozen=True)
class Instruction:
    op: str
    args: tuple = ()


@dataclass(frozen=True)
class Function:
    type_index: int
    locals: tuple = ()
    code: tuple = ()
    imported: bool = False
    module: str = ''
    name: str = ''
    ends: tuple = ()
    elses: tuple = ()


@dataclass(frozen=True)
class Module:
    types: tuple
    functions: tuple
    globals: tuple
    global_mutable: tuple
    memory: PagedMemory
    memory_max: object
    exports: tuple
    start: object = None

    def export(self, name):
        for exported, kind, index in self.exports:
            if exported == name and kind == 0:
                return index
        available = [entry[0] for entry in self.exports if entry[1] == 0]
        raise WasmStateError('wasm function %r is not exported' % name,
                             hint='function exports: %s' %
                                  (', '.join(available) or 'none'))


def decode_module(data):
    """Decode the executable integer/control/memory core of a wasm module."""
    reader = _Reader(bytes(data))
    if reader.take(4) != b'\x00asm' or reader.take(4) != b'\x01\x00\x00\x00':
        raise WasmStateError('input is not a WebAssembly 1.0 binary')

    types = []
    imported = []
    defined_types = []
    bodies = []
    globals_ = []
    exports = []
    memories = []
    data_segments = []
    start = None

    while not reader.done():
        section_id = reader.byte()
        size = reader.uleb()
        section = _Reader(reader.data, reader.at, reader.at + size)
        reader.at += size
        if section_id == 0:
            continue
        if section_id == 1:
            for _ in range(section.uleb()):
                if section.byte() != 0x60:
                    raise UnsupportedC('non-function wasm type is not modelled')
                params = section.vector(lambda: _valtype(section))
                results = section.vector(lambda: _valtype(section))
                types.append(FunctionType(params, results))
        elif section_id == 2:
            for _ in range(section.uleb()):
                mod, name, kind = section.name(), section.name(), section.byte()
                if kind == 0:
                    imported.append(Function(section.uleb(), imported=True,
                                             module=mod, name=name))
                elif kind == 1:
                    raise UnsupportedC('imported wasm tables are not modelled')
                elif kind == 2:
                    raise UnsupportedC('imported wasm memories need an explicit '
                                       'deterministic host snapshot')
                elif kind == 3:
                    raise UnsupportedC('imported wasm globals need an explicit '
                                       'deterministic host value')
                else:
                    raise UnsupportedC('wasm import kind %d is not modelled'
                                       % kind)
        elif section_id == 3:
            defined_types.extend(section.vector(lambda: section.uleb()))
        elif section_id == 4:
            for _ in range(section.uleb()):
                _table_type(section)
        elif section_id == 5:
            memories.extend(section.vector(lambda: _limits(section)))
        elif section_id == 6:
            for _ in range(section.uleb()):
                ctype = _valtype(section)
                mutable = bool(section.byte())
                value = _const_expr(section, globals_)
                globals_.append((ctype, mutable, value, False))
        elif section_id == 7:
            for _ in range(section.uleb()):
                exports.append((section.name(), section.byte(), section.uleb()))
        elif section_id == 8:
            start = section.uleb()
        elif section_id == 9:
            _skip_elements(section)
        elif section_id == 10:
            for _ in range(section.uleb()):
                body_size = section.uleb()
                body = _Reader(section.data, section.at, section.at + body_size)
                section.at += body_size
                locals_ = []
                for _ in range(body.uleb()):
                    count, kind = body.uleb(), _valtype(body)
                    if count > 1 << 20:
                        raise WasmStateError('wasm function declares too many locals')
                    locals_.extend([kind] * count)
                code, ends, elses = _decode_code(body)
                bodies.append((tuple(locals_), code, ends, elses))
        elif section_id == 11:
            for _ in range(section.uleb()):
                flags = section.uleb()
                if flags == 0:
                    offset = _const_expr(section, globals_)
                    payload = section.take(section.uleb())
                    data_segments.append((0, offset, payload))
                elif flags == 1:
                    section.take(section.uleb())
                elif flags == 2:
                    memory_index = section.uleb()
                    offset = _const_expr(section, globals_)
                    payload = section.take(section.uleb())
                    data_segments.append((memory_index, offset, payload))
                else:
                    raise UnsupportedC('wasm data segment form %d is not '
                                       'modelled' % flags)
        else:
            continue
        if not section.done():
            raise WasmStateError('wasm section %d has trailing bytes' % section_id)

    if len(defined_types) != len(bodies):
        raise WasmStateError('wasm function and code section lengths disagree')
    functions = list(imported)
    for type_index, body in zip(defined_types, bodies):
        functions.append(Function(type_index, body[0], body[1], False,
                                  ends=body[2], elses=body[3]))

    minimum, maximum = memories[0] if memories else (0, None)
    if len(memories) > 1:
        raise UnsupportedC('multiple wasm memories are not modelled')
    memory = PagedMemory(bytes(minimum * PAGE))
    for memory_index, offset, payload in data_segments:
        if memory_index != 0:
            raise UnsupportedC('multiple wasm memories are not modelled')
        end = offset + len(payload)
        if offset < 0 or end > len(memory):
            raise WasmStateError('active data segment is outside memory')
        memory = memory.write(offset, payload)
    return Module(tuple(types), tuple(functions),
                  tuple(value for _kind, _mut, value, _imp in globals_),
                  tuple(mutable for _kind, mutable, _value, _imp in globals_),
                  memory, maximum, tuple(exports), start)


def _valtype(reader):
    code = reader.byte()
    if code not in VALTYPES:
        raise UnsupportedC('wasm value type 0x%02X is not modelled' % code)
    return VALTYPES[code]


def _limits(reader):
    flags = reader.uleb()
    if flags & 2:
        raise UnsupportedC('shared wasm memory is not modelled')
    minimum = reader.uleb()
    maximum = reader.uleb() if flags & 1 else None
    if flags & ~1:
        raise UnsupportedC('64-bit wasm memory is not modelled')
    return minimum, maximum


def _table_type(reader):
    _valtype(reader)
    _limits(reader)


def _const_expr(reader, globals_):
    op = reader.byte()
    if op == 0x41:
        value = reader.sleb(32) & I32
    elif op == 0x42:
        value = reader.sleb(64) & I64
    elif op == 0x23:
        index = reader.uleb()
        value = globals_[index][2]
    else:
        raise UnsupportedC('wasm constant expression opcode 0x%02X is not '
                           'modelled' % op)
    if reader.byte() != 0x0B:
        raise WasmStateError('wasm constant expression has no end')
    return value


def _skip_elements(reader):
    for _ in range(reader.uleb()):
        flags = reader.uleb()
        if flags == 0:
            _const_expr(reader, ())
            reader.vector(lambda: reader.uleb())
        elif flags == 1:
            reader.byte()
            reader.vector(lambda: reader.uleb())
        elif flags == 2:
            reader.uleb()
            _const_expr(reader, ())
            reader.byte()
            reader.vector(lambda: reader.uleb())
        elif flags == 3:
            reader.byte()
            reader.vector(lambda: reader.uleb())
        else:
            raise UnsupportedC('reference-expression element segments are '
                               'not modelled')


_PLAIN = {
    0x00: 'unreachable', 0x01: 'nop', 0x05: 'else', 0x0B: 'end',
    0x0F: 'return', 0x1A: 'drop', 0x1B: 'select',
    0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne',
    0x48: 'i32.lt_s', 0x49: 'i32.lt_u', 0x4A: 'i32.gt_s',
    0x4B: 'i32.gt_u', 0x4C: 'i32.le_s', 0x4D: 'i32.le_u',
    0x4E: 'i32.ge_s', 0x4F: 'i32.ge_u',
    0x50: 'i64.eqz', 0x51: 'i64.eq', 0x52: 'i64.ne',
    0x53: 'i64.lt_s', 0x54: 'i64.lt_u', 0x55: 'i64.gt_s',
    0x56: 'i64.gt_u', 0x57: 'i64.le_s', 0x58: 'i64.le_u',
    0x59: 'i64.ge_s', 0x5A: 'i64.ge_u',
    0x67: 'i32.clz', 0x68: 'i32.ctz', 0x69: 'i32.popcnt',
    0x6A: 'i32.add', 0x6B: 'i32.sub', 0x6C: 'i32.mul',
    0x6D: 'i32.div_s', 0x6E: 'i32.div_u', 0x6F: 'i32.rem_s',
    0x70: 'i32.rem_u', 0x71: 'i32.and', 0x72: 'i32.or',
    0x73: 'i32.xor', 0x74: 'i32.shl', 0x75: 'i32.shr_s',
    0x76: 'i32.shr_u', 0x77: 'i32.rotl', 0x78: 'i32.rotr',
    0x79: 'i64.clz', 0x7A: 'i64.ctz', 0x7B: 'i64.popcnt',
    0x7C: 'i64.add', 0x7D: 'i64.sub', 0x7E: 'i64.mul',
    0x7F: 'i64.div_s', 0x80: 'i64.div_u', 0x81: 'i64.rem_s',
    0x82: 'i64.rem_u', 0x83: 'i64.and', 0x84: 'i64.or',
    0x85: 'i64.xor', 0x86: 'i64.shl', 0x87: 'i64.shr_s',
    0x88: 'i64.shr_u', 0x89: 'i64.rotl', 0x8A: 'i64.rotr',
    0xA7: 'i32.wrap_i64', 0xAC: 'i64.extend_i32_s',
    0xAD: 'i64.extend_i32_u',
}

_INDEXED = {0x0C: 'br', 0x0D: 'br_if', 0x10: 'call', 0x20: 'local.get',
            0x21: 'local.set', 0x22: 'local.tee', 0x23: 'global.get',
            0x24: 'global.set'}

_MEMORY = {
    0x28: ('i32.load', 4, False), 0x29: ('i64.load', 8, False),
    0x2C: ('i32.load8_s', 1, True), 0x2D: ('i32.load8_u', 1, False),
    0x2E: ('i32.load16_s', 2, True), 0x2F: ('i32.load16_u', 2, False),
    0x30: ('i64.load8_s', 1, True), 0x31: ('i64.load8_u', 1, False),
    0x32: ('i64.load16_s', 2, True), 0x33: ('i64.load16_u', 2, False),
    0x34: ('i64.load32_s', 4, True), 0x35: ('i64.load32_u', 4, False),
    0x36: ('i32.store', 4, False), 0x37: ('i64.store', 8, False),
    0x3A: ('i32.store8', 1, False), 0x3B: ('i32.store16', 2, False),
    0x3C: ('i64.store8', 1, False), 0x3D: ('i64.store16', 2, False),
    0x3E: ('i64.store32', 4, False),
}


def _decode_code(reader):
    code = []
    openers = []
    ends = {}
    elses = {}
    while not reader.done():
        opcode = reader.byte()
        if opcode in (0x02, 0x03, 0x04):
            blocktype = _blocktype(reader)
            name = {0x02: 'block', 0x03: 'loop', 0x04: 'if'}[opcode]
            openers.append((len(code), name))
            code.append(Instruction(name, (blocktype,)))
        elif opcode == 0x05:
            if not openers or openers[-1][1] != 'if':
                raise WasmStateError('wasm else is outside an if')
            elses[openers[-1][0]] = len(code)
            code.append(Instruction('else'))
        elif opcode == 0x0B:
            code.append(Instruction('end'))
            if not openers:
                if not reader.done():
                    raise WasmStateError('bytes follow the function end')
                break
            opener, _kind = openers.pop()
            ends[opener] = len(code) - 1
        elif opcode in _INDEXED:
            code.append(Instruction(_INDEXED[opcode], (reader.uleb(),)))
        elif opcode == 0x0E:
            labels = reader.vector(lambda: reader.uleb())
            code.append(Instruction('br_table', (labels, reader.uleb())))
        elif opcode == 0x11:
            type_index, table_index = reader.uleb(), reader.uleb()
            code.append(Instruction('call_indirect', (type_index, table_index)))
        elif opcode in _MEMORY:
            name, width, signed = _MEMORY[opcode]
            code.append(Instruction(name, (reader.uleb(), reader.uleb(),
                                            width, signed)))
        elif opcode in (0x3F, 0x40):
            memory_index = reader.uleb()
            code.append(Instruction('memory.size' if opcode == 0x3F
                                    else 'memory.grow', (memory_index,)))
        elif opcode == 0x41:
            code.append(Instruction('i32.const', (reader.sleb(32) & I32,)))
        elif opcode == 0x42:
            code.append(Instruction('i64.const', (reader.sleb(64) & I64,)))
        elif opcode == 0xFC:
            sub = reader.uleb()
            if sub == 10:
                code.append(Instruction('memory.copy',
                                        (reader.uleb(), reader.uleb())))
            elif sub == 11:
                code.append(Instruction('memory.fill', (reader.uleb(),)))
            else:
                raise UnsupportedC('wasm 0xFC instruction %d is not modelled'
                                   % sub)
        elif opcode in _PLAIN:
            code.append(Instruction(_PLAIN[opcode]))
        else:
            raise UnsupportedC('wasm binary instruction 0x%02X is not '
                               'modelled' % opcode)
    if openers:
        raise WasmStateError('unterminated wasm control block')
    if not code or code[-1].op != 'end':
        raise WasmStateError('wasm function body has no final end')
    end_table = tuple(ends.get(i, -1) for i in range(len(code)))
    else_table = tuple(elses.get(i, -1) for i in range(len(code)))
    return tuple(code), end_table, else_table


def _blocktype(reader):
    first = reader.byte()
    if first == 0x40:
        return ()
    if first in VALTYPES:
        return (VALTYPES[first],)
    reader.at -= 1
    return reader.sleb(33)


@dataclass(frozen=True)
class Control:
    kind: str
    start: int
    end: int
    height: int
    results: int


@dataclass(frozen=True)
class Frame:
    function: int
    pc: int
    locals: tuple
    stack: tuple
    controls: tuple = ()


@dataclass(frozen=True)
class HostRequest:
    module: str
    name: str
    result_count: int


@dataclass(frozen=True)
class MachineState:
    frames: tuple
    globals: tuple
    memory: PagedMemory
    waiting: object = None
    halted: bool = False
    result: tuple = ()
    output: bytes = b''


def start_state(module, function='main', args=(), run_start=True):
    """Instantiate the module and create one exported invocation."""
    base = MachineState((), module.globals, module.memory, halted=True)
    if run_start and module.start is not None:
        started = _invoke(module, base, module.start, ())
        started = run_until_boundary(module, started)
        if started.waiting is not None:
            raise UnsupportedC('wasm start function waits for host input')
        base = started
    index = module.export(function) if isinstance(function, str) else int(function)
    return _invoke(module, base, index, args)


def invoke(module, base, function, args=(), budget=1 << 20):
    """Run one exported call against an existing module snapshot.

    The returned value retains all global and memory changes.  Calling this
    function again starts a fresh wasm invocation over precisely that retained
    state; call frames, return values and output from the previous invocation
    are deliberately not carried into the next call.
    """
    index = module.export(function) if isinstance(function, str) else int(function)
    return run_until_boundary(module, _invoke(module, base, index, args),
                              budget=budget)


def write_memory(state, address, payload):
    """Return a snapshot with bytes copied into its linear memory."""
    return replace(state, memory=state.memory.write(address, payload))


def _invoke(module, base, index, args):
    """Invoke one function while retaining an instantiated memory snapshot."""
    fn = module.functions[index]
    ftype = module.types[fn.type_index]
    if fn.imported:
        raise WasmStateError('cannot start at an imported function')
    if len(args) != len(ftype.params):
        raise WasmStateError('function %d expects %d argument(s), got %d'
                             % (index, len(ftype.params), len(args)))
    locals_ = tuple(_coerce(value, kind)
                    for value, kind in zip(args, ftype.params))
    locals_ += tuple(0 for _ in fn.locals)
    frame = Frame(index, 0, locals_, ())
    return MachineState((frame,), base.globals, base.memory)


def instruction_step(module, state):
    """Execute exactly one wasm or host-call instruction, purely."""
    if state.halted or state.waiting is not None:
        return state
    if not state.frames:
        return replace(state, halted=True)

    frames = list(state.frames)
    frame = frames[-1]
    fn = module.functions[frame.function]
    if frame.pc >= len(fn.code):
        raise WasmStateError('program counter is outside function %d'
                             % frame.function)
    inst = fn.code[frame.pc]
    stack = list(frame.stack)
    locals_ = list(frame.locals)
    controls = list(frame.controls)
    globals_ = list(state.globals)
    memory = state.memory
    pc = frame.pc + 1

    def pop():
        if not stack:
            raise WasmStateError('%s pops an empty value stack' % inst.op)
        return stack.pop()

    def put_frame():
        frames[-1] = Frame(frame.function, pc, tuple(locals_), tuple(stack),
                           tuple(controls))

    op = inst.op
    if op == 'unreachable':
        raise WasmStateError('wasm unreachable executed')
    if op == 'nop':
        pass
    elif op in ('block', 'loop', 'if'):
        blocktype = inst.args[0]
        results = _block_results(module, blocktype)
        condition = pop() if op == 'if' else None
        control = Control(op, frame.pc, fn.ends[frame.pc], len(stack), results)
        controls.append(control)
        if op == 'if' and not condition:
            alternate = fn.elses[frame.pc]
            pc = (alternate + 1) if alternate >= 0 else control.end
    elif op == 'else':
        if not controls or controls[-1].kind != 'if':
            raise WasmStateError('runtime else is outside an if')
        target = controls.pop()
        values = stack[-target.results:] if target.results else []
        stack[:] = stack[:target.height] + values
        pc = target.end + 1
    elif op == 'end':
        if controls:
            target = controls.pop()
            values = stack[-target.results:] if target.results else []
            stack[:] = stack[:target.height] + values
        else:
            put_frame()
            return _return_from_frame(module, replace(state, frames=tuple(frames),
                                                      globals=tuple(globals_),
                                                      memory=memory))
    elif op in ('br', 'br_if'):
        take = True if op == 'br' else bool(pop())
        if take:
            depth = inst.args[0]
            if depth == len(controls):
                put_frame()
                return _return_from_frame(
                    module, replace(state, frames=tuple(frames),
                                    globals=tuple(globals_), memory=memory))
            pc, stack, controls = _branch(depth, stack, controls)
    elif op == 'br_table':
        labels, default = inst.args
        selector = pop()
        depth = labels[selector] if selector < len(labels) else default
        if depth == len(controls):
            put_frame()
            return _return_from_frame(
                module, replace(state, frames=tuple(frames),
                                globals=tuple(globals_), memory=memory))
        pc, stack, controls = _branch(depth, stack, controls)
    elif op == 'return':
        put_frame()
        return _return_from_frame(module, replace(state, frames=tuple(frames),
                                                  globals=tuple(globals_),
                                                  memory=memory))
    elif op == 'call':
        callee_index = inst.args[0]
        callee = module.functions[callee_index]
        callee_type = module.types[callee.type_index]
        args = [pop() for _ in callee_type.params][::-1]
        put_frame()
        if callee.imported:
            return _host_call(module, replace(state, frames=tuple(frames),
                                              globals=tuple(globals_),
                                              memory=memory), callee,
                              callee_type, args)
        child_locals = tuple(_coerce(v, t) for v, t in zip(args,
                                                            callee_type.params))
        child_locals += tuple(0 for _ in callee.locals)
        frames.append(Frame(callee_index, 0, child_locals, ()))
        return replace(state, frames=tuple(frames), globals=tuple(globals_),
                       memory=memory)
    elif op == 'call_indirect':
        raise UnsupportedC('wasm call_indirect is not modelled',
                           hint='direct calls and the complete C call stack '
                                'are supported')
    elif op == 'drop':
        pop()
    elif op == 'select':
        condition, right, left = pop(), pop(), pop()
        stack.append(left if condition else right)
    elif op.startswith('local.'):
        index = inst.args[0]
        if index >= len(locals_):
            raise WasmStateError('local index %d is outside the frame' % index)
        if op == 'local.get':
            stack.append(locals_[index])
        elif op == 'local.set':
            locals_[index] = pop()
        else:
            locals_[index] = stack[-1]
    elif op.startswith('global.'):
        index = inst.args[0]
        if index >= len(globals_):
            raise WasmStateError('global index %d is outside the module' % index)
        if op == 'global.get':
            stack.append(globals_[index])
        else:
            if not module.global_mutable[index]:
                raise WasmStateError('write to immutable global %d' % index)
            globals_[index] = pop()
    elif op.endswith('.const'):
        stack.append(inst.args[0])
    elif '.load' in op:
        _align, offset, width, signed = inst.args
        address = (pop() & I32) + offset
        raw = _memory_read(memory, address, width)
        value = int.from_bytes(raw, 'little')
        bits = 32 if op.startswith('i32') else 64
        if signed and value & (1 << (width * 8 - 1)):
            value -= 1 << (width * 8)
        stack.append(value & mask_of(bits))
    elif '.store' in op:
        _align, offset, width, _signed = inst.args
        value, address = pop(), (pop() & I32) + offset
        memory = _memory_write(memory, address,
                               int(value & mask_of(width * 8))
                               .to_bytes(width, 'little'))
    elif op == 'memory.size':
        stack.append(len(memory) // PAGE)
    elif op == 'memory.grow':
        pages = pop() & I32
        old = len(memory) // PAGE
        maximum = module.memory_max
        if maximum is not None and old + pages > maximum:
            stack.append(I32)
        else:
            memory = memory.grow(pages)
            stack.append(old)
    elif op == 'memory.copy':
        count, source, target = pop() & I32, pop() & I32, pop() & I32
        payload = _memory_read(memory, source, count)
        memory = _memory_write(memory, target, payload)
    elif op == 'memory.fill':
        count, value, target = pop() & I32, pop() & 255, pop() & I32
        memory = _memory_write(memory, target, bytes([value]) * count)
    else:
        _numeric(op, stack)

    put_frame()
    return replace(state, frames=tuple(frames), globals=tuple(globals_),
                   memory=memory)


def _block_results(module, blocktype):
    if isinstance(blocktype, tuple):
        return len(blocktype)
    if blocktype < 0 or blocktype >= len(module.types):
        raise WasmStateError('block type index is outside the type section')
    return len(module.types[blocktype].results)


def _branch(depth, stack, controls):
    if depth >= len(controls):
        raise WasmStateError('branch depth %d exceeds control stack' % depth)
    index = len(controls) - 1 - depth
    target = controls[index]
    result_count = 0 if target.kind == 'loop' else target.results
    values = stack[-result_count:] if result_count else []
    stack = stack[:target.height] + values
    if target.kind == 'loop':
        return target.start + 1, stack, controls[:index + 1]
    return target.end + 1, stack, controls[:index]


def _return_from_frame(module, state):
    frames = list(state.frames)
    frame = frames.pop()
    ftype = module.types[module.functions[frame.function].type_index]
    count = len(ftype.results)
    values = frame.stack[-count:] if count else ()
    if not frames:
        return replace(state, frames=(), halted=True, result=tuple(values))
    parent = frames[-1]
    frames[-1] = replace(parent, stack=parent.stack + tuple(values))
    return replace(state, frames=tuple(frames))


_INPUT_NAMES = {'qm_getchar', 'getchar'}
_OUTPUT_NAMES = {'qm_putchar', 'putchar'}


def _host_call(module, state, function, ftype, args):
    name = function.name
    if name in _INPUT_NAMES:
        if args:
            raise WasmStateError('%s import unexpectedly takes arguments' % name)
        return replace(state, waiting=HostRequest(function.module, name,
                                                  len(ftype.results)))
    if name in _OUTPUT_NAMES:
        if len(args) != 1:
            raise WasmStateError('%s import expects one byte' % name)
        output = state.output + bytes([args[0] & 255])
        if ftype.results:
            parent = state.frames[-1]
            frames = state.frames[:-1] + (replace(parent,
                                                   stack=parent.stack
                                                   + (args[0] & I32,)),)
            return replace(state, frames=frames, output=output)
        return replace(state, output=output)
    raise UnsupportedC('wasm host import %s.%s is not modelled'
                       % (function.module, name),
                       hint='make environment state an explicit input, or '
                            'provide a deterministic host adapter')


def resume_input(module, state, byte):
    """Answer one suspended input import without mutating its snapshot."""
    if state.waiting is None or state.waiting.name not in _INPUT_NAMES:
        raise WasmStateError('machine is not waiting for an input byte')
    if byte != EOF and not 0 <= byte <= 255:
        raise ValueError('input letter must be a byte or EOF')
    value = I32 if byte == EOF else byte
    frames = state.frames
    if state.waiting.result_count:
        parent = frames[-1]
        frames = frames[:-1] + (replace(parent,
                                        stack=parent.stack + (value,)),)
    return replace(state, frames=frames, waiting=None, output=b'')


def run_until_boundary(module, state, budget=1 << 20, executor=None):
    """Run dependency waves and ordered barriers to input or termination."""
    if executor is None:
        from .wasmwave import WaveExecutor
        executor = WaveExecutor(module)
    return executor.run(state, budget)


def stream_initial(module, function='main', args=(), budget=1 << 20,
                   executor=None):
    return run_until_boundary(module, start_state(module, function, args),
                              budget=budget, executor=executor)


def stream_step(module, state, byte, budget=1 << 20, executor=None):
    """Pure ``state, byte -> state`` at imported input boundaries."""
    if state.halted:
        return replace(state, output=b'')
    return run_until_boundary(module, resume_input(module, state, byte),
                              budget=budget, executor=executor)


def observe(state):
    """The complete externally visible event attached to one machine state."""
    return (state.output, state.halted, state.result)


def compile_stream(module, function='main', alphabet=None, max_states=4096,
                   budget=1 << 20, args=(), executor=None):
    """Build the exact finite future quotient of a compiled wasm driver."""
    from .transducer import compile_transducer
    if executor is None:
        from .wasmwave import WaveExecutor
        executor = WaveExecutor(module)
    initial = stream_initial(module, function, args=args, budget=budget,
                             executor=executor)
    alphabet = tuple(range(257)) if alphabet is None else tuple(alphabet)
    return compile_transducer(
        initial,
        lambda state, letter: stream_step(module, state, letter, budget,
                                          executor=executor),
        observe,
        alphabet,
        max_states=max_states,
    )


def _coerce(value, kind):
    if kind == 'i32':
        return int(value) & I32
    if kind == 'i64':
        return int(value) & I64
    raise UnsupportedC('runtime value type %s is not modelled' % kind)


def _memory_read(memory, address, size):
    return memory.read(address, size)


def _memory_write(memory, address, payload):
    return memory.write(address, payload)


def _signed(value, bits):
    value &= mask_of(bits)
    sign = 1 << (bits - 1)
    return value - (1 << bits) if value & sign else value


def _truncdiv(left, right):
    return abs(left) // abs(right) * (-1 if (left < 0) != (right < 0) else 1)


def _rot(value, count, bits, left):
    count %= bits
    mask = mask_of(bits)
    if not count:
        return value & mask
    if left:
        return ((value << count) | (value >> (bits - count))) & mask
    return ((value >> count) | (value << (bits - count))) & mask


def _numeric(op, stack):
    if not op.startswith(('i32.', 'i64.')):
        raise UnsupportedC('wasm instruction %r is not modelled' % op)
    bits = 32 if op.startswith('i32.') else 64
    mask = mask_of(bits)
    name = op.split('.', 1)[1]

    def pop():
        if not stack:
            raise WasmStateError('%s pops an empty value stack' % op)
        return stack.pop() & mask

    if name == 'wrap_i64':
        stack.append(stack.pop() & I32)
        return
    if name in ('extend_i32_s', 'extend_i32_u'):
        value = stack.pop() & I32
        stack.append((_signed(value, 32) if name.endswith('_s') else value) & I64)
        return
    if name == 'eqz':
        stack.append(1 if pop() == 0 else 0)
        return
    if name in ('clz', 'ctz', 'popcnt'):
        value = pop()
        if name == 'clz':
            result = bits - value.bit_length()
        elif name == 'ctz':
            result = bits if not value else (value & -value).bit_length() - 1
        else:
            result = value.bit_count()
        stack.append(result)
        return

    right, left = pop(), pop()
    if name in ('eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
                'le_s', 'le_u', 'ge_s', 'ge_u'):
        signed = name.endswith('_s')
        a = _signed(left, bits) if signed else left
        b = _signed(right, bits) if signed else right
        relation = name[:2]
        result = {'eq': a == b, 'ne': a != b, 'lt': a < b, 'gt': a > b,
                  'le': a <= b, 'ge': a >= b}[relation]
        stack.append(1 if result else 0)
        return
    if name == 'add': result = left + right
    elif name == 'sub': result = left - right
    elif name == 'mul': result = left * right
    elif name == 'and': result = left & right
    elif name == 'or': result = left | right
    elif name == 'xor': result = left ^ right
    elif name == 'shl': result = left << (right % bits)
    elif name == 'shr_u': result = left >> (right % bits)
    elif name == 'shr_s': result = _signed(left, bits) >> (right % bits)
    elif name == 'rotl': result = _rot(left, right, bits, True)
    elif name == 'rotr': result = _rot(left, right, bits, False)
    elif name in ('div_u', 'rem_u'):
        if not right:
            raise WasmStateError('integer division by zero')
        result = left // right if name == 'div_u' else left % right
    elif name in ('div_s', 'rem_s'):
        a, b = _signed(left, bits), _signed(right, bits)
        if not b:
            raise WasmStateError('integer division by zero')
        if name == 'div_s' and a == -(1 << (bits - 1)) and b == -1:
            raise WasmStateError('signed integer division overflow')
        quotient = _truncdiv(a, b)
        result = quotient if name == 'div_s' else a - quotient * b
    else:
        raise UnsupportedC('wasm integer instruction %r is not modelled' % op)
    stack.append(result & mask)
