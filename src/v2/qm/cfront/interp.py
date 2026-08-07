"""Tree-walking evaluator for the C subset.

Two jobs:
  1. give QM concrete input/output semantics for the pasted function;
  2. count the primitive operations actually executed, which is the honest
     "before" number in the result panel.

The interpreter is the semantic frontend, not a compiler.  It reports an
*unrolled reference operation count*, and the report labels it as such — it is
not a claim about what any particular compiler emits.
"""

from ..bits import mask_of, popcnt
from . import nodes as N
from .ctypes_model import (
    BOOL, INT, U32, U64, VOID, binary_op, convert, promote, unary_op,
)
from .errors import CFrontError, UnsupportedC

# Cost, in reference operations, of each modelled construct.
OP_COST = {
    'binary': 1, 'shift': 1, 'compare': 1, 'unary': 1, 'index': 1,
    'logical': 1, 'select': 1, 'call': 1,
}

BUILTIN_COST = {
    'popcount': 1, 'ctz': 1, 'clz': 1, 'parity': 2, 'bswap': 1,
    'rotate': 1, 'abs': 2, 'expect': 0, 'min': 1, 'max': 1,
}


class _Break(Exception):
    pass


class _Continue(Exception):
    pass


class _Return(Exception):
    def __init__(self, value, ctype):
        Exception.__init__(self)
        self.value = value
        self.ctype = ctype


class Array(object):
    __slots__ = ('items', 'ctype')

    def __init__(self, items, ctype):
        self.items = items
        self.ctype = ctype


class Interpreter(object):
    """Evaluate one translation unit.  One instance is reusable across calls."""

    def __init__(self, unit, max_steps=300000, max_depth=48):
        self.unit = unit
        self.max_steps = max_steps
        self.max_depth = max_depth
        self.ops = 0
        self.steps = 0
        self.depth = 0

    # -- public API ---------------------------------------------------------

    def call(self, name, args):
        """Call `name` with a list of Python ints; returns (value, ctype)."""
        fn = self.unit.by_name(name)
        if fn is None:
            raise CFrontError('function %r is not defined' % name)
        if len(args) != len(fn.params):
            raise CFrontError('%s expects %d argument(s), got %d'
                              % (name, len(fn.params), len(args)))
        if self.depth >= self.max_depth:
            raise CFrontError('call depth limit (%d) exceeded' % self.max_depth,
                              hint='recursion deeper than the interactive '
                                   'budget is outside this prototype')

        scope = {}
        for param, value in zip(fn.params, args):
            scope[param.name] = (convert(value, param.ctype), param.ctype)

        if self.depth == 0:
            # The step budget guards one evaluation against a runaway loop.
            # Evaluating a whole 2^16 domain is expected to cost 2^16 budgets,
            # not to share one.
            self.steps = 0
        self.depth += 1
        try:
            self.exec_block(fn.body, [scope])
        except _Return as r:
            return convert(r.value, fn.ret), fn.ret
        finally:
            self.depth -= 1

        if fn.ret.kind != 'void':
            raise CFrontError('control reached the end of non-void function %r'
                              % name, line=fn.line)
        return 0, VOID

    def evaluate(self, name, args):
        value, _ = self.call(name, args)
        return value

    def reset_counters(self):
        self.ops = 0
        self.steps = 0

    # -- statements ---------------------------------------------------------

    def _tick(self):
        self.steps += 1
        if self.steps > self.max_steps:
            raise CFrontError('execution budget of %d steps exceeded'
                              % self.max_steps,
                              hint='unbounded or very long loops are outside '
                                   'the interactive budget')

    def exec_block(self, block, scopes):
        scopes = scopes + [{}] if not isinstance(block, N.Block) else scopes
        if isinstance(block, N.Block):
            inner = scopes + [{}]
            for item in block.items:
                self.exec_stmt(item, inner)
        else:
            self.exec_stmt(block, scopes)

    def exec_stmt(self, node, scopes):
        self._tick()

        if isinstance(node, N.Empty):
            return
        if isinstance(node, N.Block):
            inner = scopes + [{}]
            for item in node.items:
                self.exec_stmt(item, inner)
            return
        if isinstance(node, N.Decl):
            self.exec_decl(node, scopes)
            return
        if isinstance(node, N.ExprStmt):
            self.eval(node.expr, scopes)
            return
        if isinstance(node, N.Return):
            if node.expr is None:
                raise _Return(0, VOID)
            value, ctype = self.eval(node.expr, scopes)
            raise _Return(value, ctype)
        if isinstance(node, N.If):
            cond, _ = self.eval(node.cond, scopes)
            if cond:
                self.exec_stmt(node.then, scopes)
            elif node.other is not None:
                self.exec_stmt(node.other, scopes)
            return
        if isinstance(node, N.While):
            if node.is_do:
                while True:
                    self._tick()
                    try:
                        self.exec_stmt(node.body, scopes)
                    except _Break:
                        break
                    except _Continue:
                        pass
                    cond, _ = self.eval(node.cond, scopes)
                    if not cond:
                        break
                return
            while True:
                self._tick()
                cond, _ = self.eval(node.cond, scopes)
                if not cond:
                    break
                try:
                    self.exec_stmt(node.body, scopes)
                except _Break:
                    break
                except _Continue:
                    continue
            return
        if isinstance(node, N.For):
            inner = scopes + [{}]
            if node.init is not None:
                self.exec_stmt(node.init, inner)
            while True:
                self._tick()
                if node.cond is not None:
                    cond, _ = self.eval(node.cond, inner)
                    if not cond:
                        break
                try:
                    self.exec_stmt(node.body, inner)
                except _Break:
                    break
                except _Continue:
                    pass
                if node.step is not None:
                    self.eval(node.step, inner)
            return
        if isinstance(node, N.Switch):
            self.exec_switch(node, scopes)
            return
        if isinstance(node, N.Break):
            raise _Break()
        if isinstance(node, N.Continue):
            raise _Continue()
        if isinstance(node, (N.Case, N.Default)):
            return          # labels outside a switch body behave as no-ops
        raise CFrontError('unsupported statement %s' % type(node).__name__,
                          line=getattr(node, 'line', None))

    def exec_switch(self, node, scopes):
        value, _ = self.eval(node.expr, scopes)
        items = node.body.items if isinstance(node.body, N.Block) else [node.body]

        start = None
        default_at = None
        for idx, item in enumerate(items):
            if isinstance(item, N.Case):
                label, _ = self.eval(item.value, scopes)
                if label == value and start is None:
                    start = idx
            elif isinstance(item, N.Default):
                default_at = idx
        if start is None:
            start = default_at
        if start is None:
            return

        inner = scopes + [{}]
        try:
            for item in items[start:]:
                self.exec_stmt(item, inner)
        except _Break:
            pass

    def exec_decl(self, node, scopes):
        scope = scopes[-1]
        if node.array_size is not None:
            size, _ = self.eval(node.array_size, scopes)
            if size <= 0 or size > 65536:
                raise CFrontError('array length %d is outside the supported '
                                  'range 1..65536' % size, line=node.line)
            items = [0] * size
            if node.init is not None:
                if not isinstance(node.init, list):
                    raise CFrontError('array initializer must be a brace list',
                                      line=node.line)
                if len(node.init) > size:
                    raise CFrontError('too many array initializers',
                                      line=node.line)
                for k, expr in enumerate(node.init):
                    v, _ = self.eval(expr, scopes)
                    items[k] = convert(v, node.ctype)
            scope[node.name] = Array(items, node.ctype)
            return

        if node.init is None:
            scope[node.name] = (0, node.ctype)
            return
        if isinstance(node.init, list):
            raise CFrontError('brace initializer on a scalar', line=node.line)
        value, _ = self.eval(node.init, scopes)
        scope[node.name] = (convert(value, node.ctype), node.ctype)

    # -- name resolution ----------------------------------------------------

    def lookup(self, name, scopes, line=None):
        for scope in reversed(scopes):
            if name in scope:
                return scope
        raise CFrontError('undeclared identifier %r' % name, line=line)

    # -- expressions --------------------------------------------------------

    def eval(self, node, scopes):
        self._tick()

        if isinstance(node, N.Num):
            return node.value, node.ctype

        if isinstance(node, N.Var):
            if node.name in ('true', 'false'):
                return (1 if node.name == 'true' else 0), BOOL
            slot = self.lookup(node.name, scopes, node.line)[node.name]
            if isinstance(slot, Array):
                raise CFrontError('array %r used as a value' % node.name,
                                  line=node.line)
            return slot

        if isinstance(node, N.Index):
            self.ops += OP_COST['index']
            arr, index = self.resolve_index(node, scopes)
            return arr.items[index], arr.ctype

        if isinstance(node, N.Cast):
            value, _ = self.eval(node.operand, scopes)
            return convert(value, node.ctype), node.ctype

        if isinstance(node, N.SizeOf):
            return max(1, node.ctype.bits // 8), U64

        if isinstance(node, N.Unary):
            value, vtype = self.eval(node.operand, scopes)
            self.ops += OP_COST['unary']
            return unary_op(node.op, value, vtype, line=node.line)

        if isinstance(node, N.Binary):
            lhs, lt = self.eval(node.left, scopes)
            rhs, rt = self.eval(node.right, scopes)
            kind = 'shift' if node.op in ('<<', '>>') else (
                'compare' if node.op in ('==', '!=', '<', '<=', '>', '>=')
                else 'binary')
            self.ops += OP_COST[kind]
            return binary_op(node.op, lhs, lt, rhs, rt, line=node.line)

        if isinstance(node, N.Logical):
            self.ops += OP_COST['logical']
            lhs, _ = self.eval(node.left, scopes)
            if node.op == '&&':
                if not lhs:
                    return 0, INT
                rhs, _ = self.eval(node.right, scopes)
                return (1 if rhs else 0), INT
            if lhs:
                return 1, INT
            rhs, _ = self.eval(node.right, scopes)
            return (1 if rhs else 0), INT

        if isinstance(node, N.Cond):
            self.ops += OP_COST['select']
            cond, _ = self.eval(node.cond, scopes)
            return self.eval(node.then if cond else node.other, scopes)

        if isinstance(node, N.Comma):
            self.eval(node.left, scopes)
            return self.eval(node.right, scopes)

        if isinstance(node, N.Assign):
            return self.eval_assign(node, scopes)

        if isinstance(node, N.IncDec):
            return self.eval_incdec(node, scopes)

        if isinstance(node, N.Call):
            return self.eval_call(node, scopes)

        raise CFrontError('unsupported expression %s' % type(node).__name__,
                          line=getattr(node, 'line', None))

    def resolve_index(self, node, scopes):
        if not isinstance(node.base, N.Var):
            raise UnsupportedC('only simple array indexing is supported',
                               line=node.line)
        scope = self.lookup(node.base.name, scopes, node.line)
        arr = scope[node.base.name]
        if not isinstance(arr, Array):
            raise CFrontError('%r is not an array' % node.base.name,
                              line=node.line)
        index, _ = self.eval(node.index, scopes)
        if index < 0 or index >= len(arr.items):
            raise CFrontError('array index %d out of bounds 0..%d'
                              % (index, len(arr.items) - 1), line=node.line)
        return arr, index

    def eval_assign(self, node, scopes):
        if isinstance(node.target, N.Index):
            arr, index = self.resolve_index(node.target, scopes)
            current, ctype = arr.items[index], arr.ctype
        else:
            scope = self.lookup(node.target.name, scopes, node.line)
            slot = scope[node.target.name]
            if isinstance(slot, Array):
                raise CFrontError('cannot assign to array %r'
                                  % node.target.name, line=node.line)
            current, ctype = slot

        value, vtype = self.eval(node.value, scopes)

        if node.op != '=':
            op = node.op[:-1]
            kind = 'shift' if op in ('<<', '>>') else 'binary'
            self.ops += OP_COST[kind]
            value, vtype = binary_op(op, current, ctype, value, vtype,
                                     line=node.line)

        stored = convert(value, ctype)
        if isinstance(node.target, N.Index):
            arr.items[index] = stored
        else:
            self.lookup(node.target.name, scopes,
                        node.line)[node.target.name] = (stored, ctype)
        return stored, ctype

    def eval_incdec(self, node, scopes):
        op = '+' if node.op == '++' else '-'
        if isinstance(node.target, N.Index):
            arr, index = self.resolve_index(node.target, scopes)
            current, ctype = arr.items[index], arr.ctype
        elif isinstance(node.target, N.Var):
            scope = self.lookup(node.target.name, scopes, node.line)
            current, ctype = scope[node.target.name]
        else:
            raise CFrontError('++/-- needs a variable or array element',
                              line=node.line)

        self.ops += OP_COST['binary']
        value, _ = binary_op(op, current, ctype, 1, INT, line=node.line)
        stored = convert(value, ctype)

        if isinstance(node.target, N.Index):
            arr.items[index] = stored
        else:
            self.lookup(node.target.name, scopes,
                        node.line)[node.target.name] = (stored, ctype)
        return (current if node.postfix else stored), ctype

    # -- calls and builtins -------------------------------------------------

    def eval_call(self, node, scopes):
        name = node.name
        args = [self.eval(a, scopes) for a in node.args]

        builtin = _BUILTINS.get(name)
        if builtin is not None:
            cost, fn, arity = builtin
            if arity is not None and len(args) != arity:
                raise CFrontError('%s expects %d argument(s), got %d'
                                  % (name, arity, len(args)), line=node.line)
            self.ops += cost
            return fn(self, args, node.line)

        if self.unit.by_name(name) is not None:
            self.ops += OP_COST['call']
            return self.call(name, [v for v, _ in args])

        raise CFrontError('call to unknown function %r' % name, line=node.line,
                          hint='define the helper in the same paste, or use a '
                               '__builtin_* the frontend models')


# ---------------------------------------------------------------------------
# Builtins
# ---------------------------------------------------------------------------

def _u(value, bits):
    return value & mask_of(bits)


def _bi_popcount(bits):
    def fn(interp, args, line):
        v, t = args[0]
        return popcnt(_u(convert(v, t), bits)), INT
    return fn


def _bi_parity(bits):
    def fn(interp, args, line):
        v, t = args[0]
        return popcnt(_u(convert(v, t), bits)) & 1, INT
    return fn


def _bi_ctz(bits):
    def fn(interp, args, line):
        v, t = args[0]
        x = _u(convert(v, t), bits)
        if x == 0:
            raise CFrontError('__builtin_ctz(0) is undefined', line=line,
                              hint='guard the zero case explicitly')
        return (x & -x).bit_length() - 1, INT
    return fn


def _bi_clz(bits):
    def fn(interp, args, line):
        v, t = args[0]
        x = _u(convert(v, t), bits)
        if x == 0:
            raise CFrontError('__builtin_clz(0) is undefined', line=line,
                              hint='guard the zero case explicitly')
        return bits - x.bit_length(), INT
    return fn


def _bi_bswap(bits):
    def fn(interp, args, line):
        v, t = args[0]
        x = _u(convert(v, t), bits)
        n = bits // 8
        out = int.from_bytes(x.to_bytes(n, 'little'), 'big')
        return out, (U32 if bits <= 32 else U64)
    return fn


def _bi_rotate(bits, left):
    def fn(interp, args, line):
        (v, t), (n, nt) = args[0], args[1]
        x = _u(convert(v, t), bits)
        k = convert(n, nt) % bits
        if not left:
            k = (bits - k) % bits
        out = ((x << k) | (x >> (bits - k))) & mask_of(bits) if k else x
        return out, (U32 if bits <= 32 else U64)
    return fn


def _bi_expect(interp, args, line):
    return args[0]


def _bi_abs(interp, args, line):
    v, t = args[0]
    t = promote(t)
    value = convert(v, t)
    return convert(-value if value < 0 else value, t), t


def _bi_minmax(is_min):
    def fn(interp, args, line):
        (a, at), (b, bt) = args[0], args[1]
        from .ctypes_model import usual_arithmetic
        ct = usual_arithmetic(at, bt)
        x, y = convert(a, ct), convert(b, ct)
        return (min(x, y) if is_min else max(x, y)), ct
    return fn


_BUILTINS = {}


def _register():
    table = {
        '__builtin_popcount': (BUILTIN_COST['popcount'], _bi_popcount(32), 1),
        '__builtin_popcountl': (BUILTIN_COST['popcount'], _bi_popcount(64), 1),
        '__builtin_popcountll': (BUILTIN_COST['popcount'], _bi_popcount(64), 1),
        '__builtin_parity': (BUILTIN_COST['parity'], _bi_parity(32), 1),
        '__builtin_parityl': (BUILTIN_COST['parity'], _bi_parity(64), 1),
        '__builtin_parityll': (BUILTIN_COST['parity'], _bi_parity(64), 1),
        '__builtin_ctz': (BUILTIN_COST['ctz'], _bi_ctz(32), 1),
        '__builtin_ctzl': (BUILTIN_COST['ctz'], _bi_ctz(64), 1),
        '__builtin_ctzll': (BUILTIN_COST['ctz'], _bi_ctz(64), 1),
        '__builtin_clz': (BUILTIN_COST['clz'], _bi_clz(32), 1),
        '__builtin_clzl': (BUILTIN_COST['clz'], _bi_clz(64), 1),
        '__builtin_clzll': (BUILTIN_COST['clz'], _bi_clz(64), 1),
        '__builtin_bswap16': (BUILTIN_COST['bswap'], _bi_bswap(16), 1),
        '__builtin_bswap32': (BUILTIN_COST['bswap'], _bi_bswap(32), 1),
        '__builtin_bswap64': (BUILTIN_COST['bswap'], _bi_bswap(64), 1),
        '__builtin_expect': (BUILTIN_COST['expect'], _bi_expect, 2),
        '__builtin_abs': (BUILTIN_COST['abs'], _bi_abs, 1),
        'abs': (BUILTIN_COST['abs'], _bi_abs, 1),
        'labs': (BUILTIN_COST['abs'], _bi_abs, 1),
        '__builtin_rotateleft32': (BUILTIN_COST['rotate'], _bi_rotate(32, True), 2),
        '__builtin_rotateleft64': (BUILTIN_COST['rotate'], _bi_rotate(64, True), 2),
        '__builtin_rotateright32': (BUILTIN_COST['rotate'], _bi_rotate(32, False), 2),
        '__builtin_rotateright64': (BUILTIN_COST['rotate'], _bi_rotate(64, False), 2),
        '__builtin_min': (BUILTIN_COST['min'], _bi_minmax(True), 2),
        '__builtin_max': (BUILTIN_COST['max'], _bi_minmax(False), 2),
    }
    _BUILTINS.update(table)


_register()

BUILTIN_NAMES = sorted(_BUILTINS)
