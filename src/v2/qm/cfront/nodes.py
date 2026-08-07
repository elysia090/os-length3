"""AST node definitions for the C subset.

Plain data holders: no evaluation logic lives here, so the parser and the
interpreter can be read independently.
"""


class Node(object):
    __slots__ = ('line',)

    def __init__(self, line=None):
        self.line = line


def _node(name, fields):
    """Build a small __slots__ AST class with a positional constructor."""
    slots = tuple(fields)

    def __init__(self, *args, **kw):
        line = kw.pop('line', None)
        if kw:
            raise TypeError('unexpected keyword arguments: %r' % (list(kw),))
        if len(args) != len(slots):
            raise TypeError('%s takes %d fields, got %d'
                            % (name, len(slots), len(args)))
        Node.__init__(self, line)
        for slot, value in zip(slots, args):
            setattr(self, slot, value)

    def __repr__(self):
        inner = ', '.join('%s=%r' % (s, getattr(self, s)) for s in slots)
        return '%s(%s)' % (name, inner)

    return type(name, (Node,), {
        '__slots__': slots, '__init__': __init__, '__repr__': __repr__,
        'fields': slots,
    })


# --- expressions -----------------------------------------------------------

Num = _node('Num', ['value', 'ctype'])
Var = _node('Var', ['name'])
Index = _node('Index', ['base', 'index'])
Call = _node('Call', ['name', 'args'])
Unary = _node('Unary', ['op', 'operand'])
IncDec = _node('IncDec', ['op', 'target', 'postfix'])
Cast = _node('Cast', ['ctype', 'operand'])
Binary = _node('Binary', ['op', 'left', 'right'])
Logical = _node('Logical', ['op', 'left', 'right'])
Cond = _node('Cond', ['cond', 'then', 'other'])
Assign = _node('Assign', ['op', 'target', 'value'])
Comma = _node('Comma', ['left', 'right'])
SizeOf = _node('SizeOf', ['ctype'])

# --- statements ------------------------------------------------------------

Decl = _node('Decl', ['ctype', 'name', 'array_size', 'init'])
ExprStmt = _node('ExprStmt', ['expr'])
If = _node('If', ['cond', 'then', 'other'])
While = _node('While', ['cond', 'body', 'is_do'])
For = _node('For', ['init', 'cond', 'step', 'body'])
Return = _node('Return', ['expr'])
Break = _node('Break', [])
Continue = _node('Continue', [])
Block = _node('Block', ['items'])
# `int a = 1, b = 2;` is several declarations in one statement. It is not a
# block: opening a scope for it would hide every declarator after the first.
DeclGroup = _node('DeclGroup', ['items'])
Switch = _node('Switch', ['expr', 'body'])
Case = _node('Case', ['value'])
Default = _node('Default', [])
Empty = _node('Empty', [])


class Param(object):
    __slots__ = ('ctype', 'name')

    def __init__(self, ctype, name):
        self.ctype = ctype
        self.name = name

    def to_dict(self):
        return {'name': self.name, 'type': self.ctype.to_dict()}


class Function(object):
    __slots__ = ('name', 'ret', 'params', 'body', 'line')

    def __init__(self, name, ret, params, body, line=None):
        self.name = name
        self.ret = ret
        self.params = params
        self.body = body
        self.line = line

    def signature(self):
        args = ', '.join('%s %s' % (p.ctype.name, p.name) for p in self.params)
        return '%s %s(%s)' % (self.ret.name, self.name, args or 'void')

    def to_dict(self):
        return {
            'name': self.name,
            'return': self.ret.to_dict(),
            'params': [p.to_dict() for p in self.params],
            'signature': self.signature(),
            'line': self.line,
        }


class TranslationUnit(object):
    __slots__ = ('functions', 'globals', 'skipped')

    def __init__(self, functions, globals_=None, skipped=None):
        self.functions = functions            # ordered dict-like list
        self.globals = globals_ or []
        # Definitions outside the subset, kept so the report can name them.
        self.skipped = list(skipped or [])

    def by_name(self, name):
        for f in self.functions:
            if f.name == name:
                return f
        return None

    def names(self):
        return [f.name for f in self.functions]
