"""Compile the C subset to Python closures.

Why this exists
===============
Extracting semantics for a 16-bit input means evaluating the kernel 65,536
times.  Walking the AST once per evaluation re-dispatches every node and
re-derives every operand type 65,536 times, which is the difference between a
responsive page and a minute of dead air.

C types are static, so all of that work belongs at compile time:

    * every expression's result type is computed once;
    * every variable is resolved to a frame slot once;
    * every operator becomes a closure that does the arithmetic and one mask.

`interp.py` remains the reference implementation and the instrumented path used
for the reference operation count.  `tests/test_cfront.py` checks the two agree
over whole domains, so the fast path can never quietly drift from the slow one.
"""

from ..bits import clmul as _clmul, mask_of, pdep as _pdep, pext as _pext
from . import nodes as N
from .ctypes_model import (
    BOOL, INT, U32, U64, VOID, CType, convert, promote, truncdiv,
    usual_arithmetic,
)
from .errors import CFrontError, UnsupportedC

# Statement signals.  `None` means "fell through".
BREAK = ('break',)
CONTINUE = ('continue',)


class _Return(object):
    __slots__ = ('value',)

    def __init__(self, value):
        self.value = value


# Frame layout: slot 0 holds a one-element list with the remaining loop budget.
BUDGET_SLOT = 0


def _converter(ctype):
    """Fast value normalizer for a fixed C type."""
    if ctype.kind == 'bool':
        return lambda v: 1 if v else 0
    mask = mask_of(ctype.bits)
    if not ctype.signed:
        return lambda v: v & mask
    sign = 1 << (ctype.bits - 1)
    modulus = 1 << ctype.bits

    def convert_signed(v):
        v &= mask
        return v - modulus if v & sign else v

    return convert_signed


class _Scope(object):
    """Static name resolution: name -> (slot, ctype, is_array)."""

    def __init__(self):
        self.stack = [{}]
        self.slots = 1        # slot 0 is the budget

    def push(self):
        self.stack.append({})

    def pop(self):
        self.stack.pop()

    def declare(self, name, ctype, is_array=False):
        slot = self.slots
        self.slots += 1
        self.stack[-1][name] = (slot, ctype, is_array)
        return slot

    def lookup(self, name, line=None):
        for scope in reversed(self.stack):
            if name in scope:
                return scope[name]
        raise CFrontError('undeclared identifier %r' % name, line=line)


class Compiler(object):
    """Compile a translation unit to callables."""

    def __init__(self, unit, loop_budget=200000):
        self.unit = unit
        self.loop_budget = loop_budget
        self._cache = {}
        self._in_progress = set()

    def function(self, name):
        """Return `callable(*args) -> int` for the named function."""
        if name in self._cache:
            return self._cache[name]
        fn = self.unit.by_name(name)
        if fn is None:
            raise CFrontError('function %r is not defined' % name)
        if name in self._in_progress:
            # Recursive call: return a trampoline that resolves on first use.
            return lambda *args, _n=name: self._cache[_n](*args)

        self._in_progress.add(name)
        try:
            compiled = self._compile_function(fn)
        finally:
            self._in_progress.discard(name)
        self._cache[name] = compiled
        return compiled

    def unary_target(self, name):
        """Convenience wrapper for the unary kernels the solvers accept."""
        call = self.function(name)
        return lambda x: call(x)

    # -- function ----------------------------------------------------------

    def _compile_function(self, fn):
        scope = _Scope()
        param_slots = []
        for param in fn.params:
            param_slots.append((scope.declare(param.name, param.ctype),
                                _converter(param.ctype)))
        body = self._stmt(fn.body, scope)
        n_slots = scope.slots
        ret_conv = _converter(fn.ret) if fn.ret.kind != 'void' else None
        budget = self.loop_budget
        name = fn.name
        line = fn.line

        def call(*args):
            if len(args) != len(param_slots):
                raise CFrontError('%s expects %d argument(s), got %d'
                                  % (name, len(param_slots), len(args)))
            frame = [None] * n_slots
            frame[BUDGET_SLOT] = [budget]
            for (slot, conv), value in zip(param_slots, args):
                frame[slot] = conv(value)
            signal = body(frame)
            if type(signal) is _Return:
                return ret_conv(signal.value) if ret_conv else 0
            if ret_conv is not None:
                raise CFrontError('control reached the end of non-void '
                                  'function %r' % name, line=line)
            return 0

        return call

    # -- statements --------------------------------------------------------

    def _stmt(self, node, scope):
        method = _STMT_DISPATCH.get(type(node))
        if method is None:
            raise CFrontError('unsupported statement %s' % type(node).__name__,
                              line=getattr(node, 'line', None))
        return method(self, node, scope)

    def _stmt_decl_group(self, node, scope):
        # Same scope, several declarators.
        parts = [self._stmt(item, scope) for item in node.items]
        return self._sequence(parts)

    def _stmt_block(self, node, scope):
        scope.push()
        parts = [self._stmt(item, scope) for item in node.items]
        scope.pop()
        return self._sequence(parts)

    @staticmethod
    def _sequence(parts):
        if not parts:
            return lambda frame: None
        if len(parts) == 1:
            return parts[0]

        def run(frame):
            for part in parts:
                signal = part(frame)
                if signal is not None:
                    return signal
            return None

        return run

    def _stmt_empty(self, node, scope):
        return lambda frame: None

    def _stmt_expr(self, node, scope):
        expr, _ = self._expr(node.expr, scope)

        def run(frame):
            expr(frame)
            return None

        return run

    def _stmt_decl(self, node, scope):
        if node.array_size is not None:
            size_expr, _ = self._expr(node.array_size, scope)
            size = size_expr([None] * 1) if _is_constant(node.array_size) else None
            if size is None:
                raise CFrontError('array length must be a constant expression',
                                  line=node.line)
            if size <= 0 or size > 65536:
                raise CFrontError('array length %d is outside the supported '
                                  'range 1..65536' % size, line=node.line)
            conv = _converter(node.ctype)
            inits = []
            if node.init is not None:
                if not isinstance(node.init, list):
                    raise CFrontError('array initializer must be a brace list',
                                      line=node.line)
                if len(node.init) > size:
                    raise CFrontError('too many array initializers',
                                      line=node.line)
                inits = [self._expr(item, scope)[0] for item in node.init]
            slot = scope.declare(node.name, node.ctype, is_array=True)

            def run(frame):
                items = [0] * size
                for k, emit in enumerate(inits):
                    items[k] = conv(emit(frame))
                frame[slot] = items
                return None

            return run

        conv = _converter(node.ctype)
        init = None
        if node.init is not None:
            if isinstance(node.init, list):
                raise CFrontError('brace initializer on a scalar',
                                  line=node.line)
            init, _ = self._expr(node.init, scope)
        slot = scope.declare(node.name, node.ctype)

        if init is None:
            def run(frame):
                frame[slot] = 0
                return None
        else:
            def run(frame):
                frame[slot] = conv(init(frame))
                return None

        return run

    def _stmt_return(self, node, scope):
        if node.expr is None:
            return lambda frame: _Return(0)
        expr, _ = self._expr(node.expr, scope)
        return lambda frame: _Return(expr(frame))

    def _stmt_break(self, node, scope):
        return lambda frame: BREAK

    def _stmt_continue(self, node, scope):
        return lambda frame: CONTINUE

    def _stmt_if(self, node, scope):
        cond, _ = self._expr(node.cond, scope)
        then = self._stmt(node.then, scope)
        other = self._stmt(node.other, scope) if node.other is not None else None

        if other is None:
            def run(frame):
                return then(frame) if cond(frame) else None
        else:
            def run(frame):
                return then(frame) if cond(frame) else other(frame)

        return run

    def _stmt_while(self, node, scope):
        cond, _ = self._expr(node.cond, scope)
        body = self._stmt(node.body, scope)
        is_do = node.is_do

        def run(frame):
            budget = frame[BUDGET_SLOT]
            if is_do:
                while True:
                    signal = body(frame)
                    if signal is not None:
                        if signal is BREAK:
                            return None
                        if signal is not CONTINUE:
                            return signal
                    budget[0] -= 1
                    if budget[0] < 0:
                        raise _budget_error()
                    if not cond(frame):
                        return None
            while cond(frame):
                budget[0] -= 1
                if budget[0] < 0:
                    raise _budget_error()
                signal = body(frame)
                if signal is not None:
                    if signal is BREAK:
                        return None
                    if signal is not CONTINUE:
                        return signal
            return None

        return run

    def _stmt_for(self, node, scope):
        scope.push()
        init = self._stmt(node.init, scope) if node.init is not None else None
        cond = self._expr(node.cond, scope)[0] if node.cond is not None else None
        step = self._expr(node.step, scope)[0] if node.step is not None else None
        body = self._stmt(node.body, scope)
        scope.pop()

        def run(frame):
            budget = frame[BUDGET_SLOT]
            if init is not None:
                init(frame)
            while cond is None or cond(frame):
                budget[0] -= 1
                if budget[0] < 0:
                    raise _budget_error()
                signal = body(frame)
                if signal is not None:
                    if signal is BREAK:
                        return None
                    if signal is not CONTINUE:
                        return signal
                if step is not None:
                    step(frame)
            return None

        return run

    def _stmt_switch(self, node, scope):
        selector, _ = self._expr(node.expr, scope)
        items = node.body.items if isinstance(node.body, N.Block) else [node.body]

        scope.push()
        labels = {}
        default_at = None
        parts = []
        for index, item in enumerate(items):
            if isinstance(item, N.Case):
                if not _is_constant(item.value):
                    raise CFrontError('case labels must be constants',
                                      line=item.line)
                value = self._expr(item.value, scope)[0]([None])
                labels.setdefault(value, index)
                parts.append(None)
            elif isinstance(item, N.Default):
                default_at = index
                parts.append(None)
            else:
                parts.append(self._stmt(item, scope))
        scope.pop()

        def run(frame):
            start = labels.get(selector(frame), default_at)
            if start is None:
                return None
            for part in parts[start:]:
                if part is None:
                    continue
                signal = part(frame)
                if signal is not None:
                    return None if signal is BREAK else signal
            return None

        return run

    def _stmt_label(self, node, scope):
        return lambda frame: None

    # -- expressions -------------------------------------------------------

    def _expr(self, node, scope):
        """Compile an expression to (closure, ctype)."""
        method = _EXPR_DISPATCH.get(type(node))
        if method is None:
            raise CFrontError('unsupported expression %s'
                              % type(node).__name__,
                              line=getattr(node, 'line', None))
        return method(self, node, scope)

    def _expr_num(self, node, scope):
        value = convert(node.value, node.ctype)
        return (lambda frame: value), node.ctype

    def _expr_var(self, node, scope):
        if node.name in ('true', 'false'):
            value = 1 if node.name == 'true' else 0
            return (lambda frame: value), BOOL
        slot, ctype, is_array = scope.lookup(node.name, node.line)
        if is_array:
            raise CFrontError('array %r used as a value' % node.name,
                              line=node.line)
        return (lambda frame: frame[slot]), ctype

    def _expr_index(self, node, scope):
        if not isinstance(node.base, N.Var):
            raise UnsupportedC('only simple array indexing is supported',
                               line=node.line)
        slot, ctype, is_array = scope.lookup(node.base.name, node.line)
        if not is_array:
            raise CFrontError('%r is not an array' % node.base.name,
                              line=node.line)
        index, _ = self._expr(node.index, scope)
        name = node.base.name
        line = node.line

        def emit(frame):
            items = frame[slot]
            k = index(frame)
            if k < 0 or k >= len(items):
                raise CFrontError('array index %d out of bounds 0..%d in %r'
                                  % (k, len(items) - 1, name), line=line)
            return items[k]

        return emit, ctype

    def _expr_cast(self, node, scope):
        inner, _ = self._expr(node.operand, scope)
        conv = _converter(node.ctype)
        return (lambda frame: conv(inner(frame))), node.ctype

    def _expr_sizeof(self, node, scope):
        size = max(1, node.ctype.bits // 8)
        return (lambda frame: size), U64

    def _expr_unary(self, node, scope):
        inner, itype = self._expr(node.operand, scope)
        op = node.op
        if op == '!':
            return (lambda frame: 0 if inner(frame) else 1), INT
        rtype = promote(itype)
        conv = _converter(rtype)
        if op == '+':
            return (lambda frame: conv(inner(frame))), rtype
        if op == '-':
            return (lambda frame: conv(-inner(frame))), rtype
        if op == '~':
            return (lambda frame: conv(~inner(frame))), rtype
        raise CFrontError('unsupported unary operator %r' % op, line=node.line)

    def _expr_binary(self, node, scope):
        left, ltype = self._expr(node.left, scope)
        right, rtype = self._expr(node.right, scope)
        op = node.op
        line = node.line

        if op in ('<<', '>>'):
            result_type = promote(ltype)
            conv = _converter(result_type)
            bits = result_type.bits
            signed = result_type.signed

            def emit(frame):
                count = right(frame)
                if count < 0 or count >= bits:
                    raise CFrontError(
                        'shift count %d is undefined for a %d-bit operand'
                        % (count, bits), line=line,
                        hint='mask or widen the operand so the shift stays in '
                             'range')
                value = left(frame)
                if op == '<<':
                    return conv(value << count)
                return conv(value >> count) if signed else (value >> count)

            return emit, result_type

        if op in ('==', '!=', '<', '<=', '>', '>='):
            common = usual_arithmetic(ltype, rtype)
            lc = _rewrap(left, ltype, common)
            rc = _rewrap(right, rtype, common)
            compare = _COMPARE[op]
            return (lambda frame: 1 if compare(lc(frame), rc(frame)) else 0), INT

        common = usual_arithmetic(ltype, rtype)
        conv = _converter(common)
        lc = _rewrap(left, ltype, common)
        rc = _rewrap(right, rtype, common)
        mask = mask_of(common.bits)

        if op == '+':
            return (lambda frame: conv(lc(frame) + rc(frame))), common
        if op == '-':
            return (lambda frame: conv(lc(frame) - rc(frame))), common
        if op == '*':
            return (lambda frame: conv(lc(frame) * rc(frame))), common
        if op == '&':
            return (lambda frame: conv((lc(frame) & mask) & (rc(frame) & mask))), common
        if op == '|':
            return (lambda frame: conv((lc(frame) & mask) | (rc(frame) & mask))), common
        if op == '^':
            return (lambda frame: conv((lc(frame) & mask) ^ (rc(frame) & mask))), common
        if op == '/':
            def emit_div(frame):
                divisor = rc(frame)
                if divisor == 0:
                    raise CFrontError('division by zero', line=line)
                return conv(truncdiv(lc(frame), divisor))
            return emit_div, common
        if op == '%':
            def emit_mod(frame):
                divisor = rc(frame)
                if divisor == 0:
                    raise CFrontError('remainder by zero', line=line)
                dividend = lc(frame)
                return conv(dividend - truncdiv(dividend, divisor) * divisor)
            return emit_mod, common

        raise CFrontError('unsupported binary operator %r' % op, line=line)

    def _expr_logical(self, node, scope):
        left, _ = self._expr(node.left, scope)
        right, _ = self._expr(node.right, scope)
        if node.op == '&&':
            return (lambda frame: 1 if (left(frame) and right(frame)) else 0), INT
        return (lambda frame: 1 if (left(frame) or right(frame)) else 0), INT

    def _expr_cond(self, node, scope):
        cond, _ = self._expr(node.cond, scope)
        then, ttype = self._expr(node.then, scope)
        other, otype = self._expr(node.other, scope)
        common = usual_arithmetic(ttype, otype)
        tc = _rewrap(then, ttype, common)
        oc = _rewrap(other, otype, common)
        return (lambda frame: tc(frame) if cond(frame) else oc(frame)), common

    def _expr_comma(self, node, scope):
        left, _ = self._expr(node.left, scope)
        right, rtype = self._expr(node.right, scope)

        def emit(frame):
            left(frame)
            return right(frame)

        return emit, rtype

    def _expr_assign(self, node, scope):
        value, vtype = self._expr(node.value, scope)
        target = node.target

        if isinstance(target, N.Index):
            store = self._array_store(target, scope)
            load, ctype = self._expr_index(target, scope)
        else:
            slot, ctype, is_array = scope.lookup(target.name, node.line)
            if is_array:
                raise CFrontError('cannot assign to array %r' % target.name,
                                  line=node.line)
            store = None
            load = lambda frame: frame[slot]

        conv = _converter(ctype)

        if node.op == '=':
            combine = None
        else:
            combine = _compound(node.op[:-1], ctype, vtype, node.line)

        if store is None:
            if combine is None:
                def emit(frame):
                    result = conv(value(frame))
                    frame[slot] = result
                    return result
            else:
                def emit(frame):
                    result = conv(combine(frame[slot], value(frame)))
                    frame[slot] = result
                    return result
            return emit, ctype

        index_of, slot_of = store
        if combine is None:
            def emit(frame):
                result = conv(value(frame))
                frame[slot_of][index_of(frame)] = result
                return result
        else:
            def emit(frame):
                items = frame[slot_of]
                k = index_of(frame)
                result = conv(combine(items[k], value(frame)))
                items[k] = result
                return result
        return emit, ctype

    def _array_store(self, target, scope):
        slot, _ctype, is_array = scope.lookup(target.base.name, target.line)
        if not is_array:
            raise CFrontError('%r is not an array' % target.base.name,
                              line=target.line)
        index, _ = self._expr(target.index, scope)
        return index, slot

    def _expr_incdec(self, node, scope):
        delta = 1 if node.op == '++' else -1
        target = node.target
        postfix = node.postfix

        if isinstance(target, N.Index):
            index_of, slot = self._array_store(target, scope)
            _, ctype, _is_array = scope.lookup(target.base.name, target.line)
            conv = _converter(ctype)

            def emit(frame):
                items = frame[slot]
                k = index_of(frame)
                old = items[k]
                new = conv(old + delta)
                items[k] = new
                return old if postfix else new

            return emit, ctype

        if not isinstance(target, N.Var):
            raise CFrontError('++/-- needs a variable or array element',
                              line=node.line)
        slot, ctype, is_array = scope.lookup(target.name, node.line)
        if is_array:
            raise CFrontError('cannot increment array %r' % target.name,
                              line=node.line)
        conv = _converter(ctype)

        def emit(frame):
            old = frame[slot]
            new = conv(old + delta)
            frame[slot] = new
            return old if postfix else new

        return emit, ctype

    def _expr_call(self, node, scope):
        args = [self._expr(a, scope) for a in node.args]
        builtin = BUILTINS.get(node.name)
        if builtin is not None:
            return builtin(self, node, args, scope)

        fn = self.unit.by_name(node.name)
        if fn is None:
            raise CFrontError('call to unknown function %r' % node.name,
                              line=node.line,
                              hint='define the helper in the same paste, or '
                                   'use a __builtin_* the frontend models')
        if len(args) != len(fn.params):
            raise CFrontError('%s expects %d argument(s), got %d'
                              % (node.name, len(fn.params), len(args)),
                              line=node.line)
        callee = self.function(node.name)
        emits = [a for a, _ in args]

        if len(emits) == 1:
            single = emits[0]
            return (lambda frame: callee(single(frame))), fn.ret
        return (lambda frame: callee(*[e(frame) for e in emits])), fn.ret


def _budget_error():
    return CFrontError('loop budget exceeded',
                       hint='unbounded or very long loops are outside the '
                            'interactive budget')


def _rewrap(emit, from_type, to_type):
    """Insert a conversion only when the static types actually differ."""
    if from_type == to_type:
        return emit
    conv = _converter(to_type)
    return lambda frame: conv(emit(frame))


def _compound(op, target_type, value_type, line):
    """Build `lhs <op> rhs` for a compound assignment, statically typed."""
    common = usual_arithmetic(target_type, value_type)
    conv = _converter(common)
    mask = mask_of(common.bits)
    bits = promote(target_type).bits
    signed = promote(target_type).signed
    target_conv = _converter(promote(target_type))

    if op == '+':
        return lambda a, b: conv(conv(a) + conv(b))
    if op == '-':
        return lambda a, b: conv(conv(a) - conv(b))
    if op == '*':
        return lambda a, b: conv(conv(a) * conv(b))
    if op == '&':
        return lambda a, b: conv((conv(a) & mask) & (conv(b) & mask))
    if op == '|':
        return lambda a, b: conv((conv(a) & mask) | (conv(b) & mask))
    if op == '^':
        return lambda a, b: conv((conv(a) & mask) ^ (conv(b) & mask))
    if op == '/':
        def divide(a, b):
            if b == 0:
                raise CFrontError('division by zero', line=line)
            return conv(truncdiv(conv(a), conv(b)))
        return divide
    if op == '%':
        def modulo(a, b):
            if b == 0:
                raise CFrontError('remainder by zero', line=line)
            x, y = conv(a), conv(b)
            return conv(x - truncdiv(x, y) * y)
        return modulo
    if op in ('<<', '>>'):
        def shift(a, b):
            if b < 0 or b >= bits:
                raise CFrontError(
                    'shift count %d is undefined for a %d-bit operand'
                    % (b, bits), line=line)
            if op == '<<':
                return target_conv(a << b)
            return target_conv(a >> b) if signed else ((a & mask_of(bits)) >> b)
        return shift
    raise CFrontError('unsupported compound assignment %r=' % op, line=line)


_COMPARE = {
    '==': lambda a, b: a == b,
    '!=': lambda a, b: a != b,
    '<': lambda a, b: a < b,
    '<=': lambda a, b: a <= b,
    '>': lambda a, b: a > b,
    '>=': lambda a, b: a >= b,
}


def _is_constant(node):
    """Conservative check that an expression needs no frame."""
    if isinstance(node, N.Num):
        return True
    if isinstance(node, (N.Binary, N.Logical)):
        return _is_constant(node.left) and _is_constant(node.right)
    if isinstance(node, N.Unary):
        return _is_constant(node.operand)
    if isinstance(node, N.Cast):
        return _is_constant(node.operand)
    if isinstance(node, N.SizeOf):
        return True
    return False


# ---------------------------------------------------------------------------
# Builtins
# ---------------------------------------------------------------------------

def _builtin_unary(bits, fn, ret_type=INT):
    def build(compiler, node, args, scope):
        if len(args) != 1:
            raise CFrontError('%s expects 1 argument' % node.name,
                              line=node.line)
        emit, atype = args[0]
        mask = mask_of(bits)
        line = node.line
        return (lambda frame: fn(emit(frame) & mask, line)), ret_type
    return build


def _popcount(value, line):
    return bin(value).count('1')


def _parity(value, line):
    return bin(value).count('1') & 1


def _ctz(value, line):
    if value == 0:
        raise CFrontError('__builtin_ctz(0) is undefined', line=line,
                          hint='guard the zero case explicitly')
    return (value & -value).bit_length() - 1


def _clz_for(bits):
    def clz(value, line):
        if value == 0:
            raise CFrontError('__builtin_clz(0) is undefined', line=line,
                              hint='guard the zero case explicitly')
        return bits - value.bit_length()
    return clz


def _bswap_for(bits):
    width = bits // 8

    def bswap(value, line):
        return int.from_bytes(value.to_bytes(width, 'little'), 'big')

    return bswap


def _builtin_pair(bits, fn, ret_type=U64):
    """Two 64-bit operands in, one out: PDEP, PEXT, carry-less multiply."""
    def build(compiler, node, args, scope):
        if len(args) != 2:
            raise CFrontError('%s expects 2 arguments' % node.name,
                              line=node.line)
        left, _lt = args[0]
        right, _rt = args[1]
        mask = mask_of(bits)
        return (lambda frame: fn(left(frame) & mask, right(frame) & mask)), ret_type
    return build


def _builtin_expect(compiler, node, args, scope):
    if len(args) != 2:
        raise CFrontError('__builtin_expect expects 2 arguments',
                          line=node.line)
    return args[0]


def _builtin_abs(compiler, node, args, scope):
    emit, atype = args[0]
    rtype = promote(atype)
    conv = _converter(rtype)
    return (lambda frame: conv(abs(emit(frame)))), rtype


def _builtin_rotate(bits, left):
    def build(compiler, node, args, scope):
        if len(args) != 2:
            raise CFrontError('%s expects 2 arguments' % node.name,
                              line=node.line)
        value, _ = args[0]
        count, _ = args[1]
        mask = mask_of(bits)
        rtype = U32 if bits <= 32 else U64

        def emit(frame):
            x = value(frame) & mask
            k = count(frame) % bits
            if not left:
                k = (bits - k) % bits
            return ((x << k) | (x >> (bits - k))) & mask if k else x

        return emit, rtype
    return build


def _builtin_minmax(is_min):
    def build(compiler, node, args, scope):
        (a, at), (b, bt) = args[0], args[1]
        common = usual_arithmetic(at, bt)
        ac = _rewrap(a, at, common)
        bc = _rewrap(b, bt, common)
        pick = min if is_min else max
        return (lambda frame: pick(ac(frame), bc(frame))), common
    return build


BUILTINS = {
    '__builtin_popcount': _builtin_unary(32, _popcount),
    '__builtin_popcountl': _builtin_unary(64, _popcount),
    '__builtin_popcountll': _builtin_unary(64, _popcount),
    '__builtin_parity': _builtin_unary(32, _parity),
    '__builtin_parityl': _builtin_unary(64, _parity),
    '__builtin_parityll': _builtin_unary(64, _parity),
    '__builtin_ctz': _builtin_unary(32, _ctz),
    '__builtin_ctzl': _builtin_unary(64, _ctz),
    '__builtin_ctzll': _builtin_unary(64, _ctz),
    '__builtin_clz': _builtin_unary(32, _clz_for(32)),
    '__builtin_clzl': _builtin_unary(64, _clz_for(64)),
    '__builtin_clzll': _builtin_unary(64, _clz_for(64)),
    '__builtin_bswap16': _builtin_unary(16, _bswap_for(16), U32),
    '__builtin_bswap32': _builtin_unary(32, _bswap_for(32), U32),
    '__builtin_bswap64': _builtin_unary(64, _bswap_for(64), U64),
    '__builtin_expect': _builtin_expect,
    # QM emits these; modelling them means QM can read its own output.
    '_pdep_u64': _builtin_pair(64, lambda v, m: _pdep(v, m)),
    '_pext_u64': _builtin_pair(64, lambda v, m: _pext(v, m)),
    'qm_clmul64': _builtin_pair(64, lambda a, b: _clmul(a, b, 64) & mask_of(64)),
    '__builtin_abs': _builtin_abs,
    'abs': _builtin_abs,
    'labs': _builtin_abs,
    '__builtin_rotateleft32': _builtin_rotate(32, True),
    '__builtin_rotateleft64': _builtin_rotate(64, True),
    '__builtin_rotateright32': _builtin_rotate(32, False),
    '__builtin_rotateright64': _builtin_rotate(64, False),
    '__builtin_min': _builtin_minmax(True),
    '__builtin_max': _builtin_minmax(False),
}


_STMT_DISPATCH = {
    N.Block: Compiler._stmt_block,
    N.DeclGroup: Compiler._stmt_decl_group,
    N.Empty: Compiler._stmt_empty,
    N.ExprStmt: Compiler._stmt_expr,
    N.Decl: Compiler._stmt_decl,
    N.Return: Compiler._stmt_return,
    N.Break: Compiler._stmt_break,
    N.Continue: Compiler._stmt_continue,
    N.If: Compiler._stmt_if,
    N.While: Compiler._stmt_while,
    N.For: Compiler._stmt_for,
    N.Switch: Compiler._stmt_switch,
    N.Case: Compiler._stmt_label,
    N.Default: Compiler._stmt_label,
}

_EXPR_DISPATCH = {
    N.Num: Compiler._expr_num,
    N.Var: Compiler._expr_var,
    N.Index: Compiler._expr_index,
    N.Cast: Compiler._expr_cast,
    N.SizeOf: Compiler._expr_sizeof,
    N.Unary: Compiler._expr_unary,
    N.Binary: Compiler._expr_binary,
    N.Logical: Compiler._expr_logical,
    N.Cond: Compiler._expr_cond,
    N.Comma: Compiler._expr_comma,
    N.Assign: Compiler._expr_assign,
    N.IncDec: Compiler._expr_incdec,
    N.Call: Compiler._expr_call,
}


def compile_unit(unit, loop_budget=200000):
    return Compiler(unit, loop_budget)
