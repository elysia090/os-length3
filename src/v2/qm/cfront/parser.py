"""Recursive-descent parser for the C subset.

Grammar coverage is limited to small functions, fixed-width integers, and
bounded control flow. Anything outside that is rejected with a
located diagnostic rather than mis-parsed.
"""

from . import nodes as N
from .ctypes_model import (
    INT, VOID, is_type_name, type_from_keywords,
)
from .errors import CFrontError, NoEntry, UnsupportedC
from .lexer import lex

STORAGE = {'static', 'extern', 'inline', 'register', 'auto', '__inline',
           '__inline__', '__forceinline', '__extension__'}
QUALIFIERS = {'const', 'volatile', 'restrict', '__restrict', '__restrict__'}

ASSIGN_OPS = {'=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='}

# Binary operator precedence, loosest first.
PRECEDENCE = [
    ('||',), ('&&',), ('|',), ('^',), ('&',),
    ('==', '!='), ('<', '<=', '>', '>='), ('<<', '>>'),
    ('+', '-'), ('*', '/', '%'),
]


class Parser(object):
    def __init__(self, tokens):
        self.toks = tokens
        self.i = 0

    # -- token helpers ------------------------------------------------------

    @property
    def tok(self):
        return self.toks[self.i]

    def peek(self, offset=0):
        j = min(self.i + offset, len(self.toks) - 1)
        return self.toks[j]

    def at(self, value, kind=None):
        t = self.tok
        return t.value == value and (kind is None or t.kind == kind)

    def advance(self):
        t = self.toks[self.i]
        if t.kind != 'eof':
            self.i += 1
        return t

    def accept(self, value):
        if self.at(value):
            return self.advance()
        return None

    def expect(self, value):
        if not self.at(value):
            raise CFrontError('expected %r but found %r' % (value, self.tok.value),
                              line=self.tok.line, col=self.tok.col)
        return self.advance()

    def error(self, message, hint=None):
        return CFrontError(message, line=self.tok.line, col=self.tok.col,
                           hint=hint)

    # -- declaration specifiers --------------------------------------------

    def skip_attributes(self):
        while self.at('__attribute__'):
            self.advance()
            depth = 0
            while True:
                t = self.advance()
                if t.kind == 'eof':
                    raise self.error('unterminated __attribute__')
                if t.value == '(':
                    depth += 1
                elif t.value == ')':
                    depth -= 1
                    if depth == 0:
                        break

    def looks_like_declaration(self):
        t = self.tok
        if t.kind == 'kw' and (t.value in STORAGE or t.value in QUALIFIERS):
            return True
        if t.kind in ('kw', 'id') and is_type_name(t.value):
            # `uint64_t x` is a declaration; `x = 1` is not.
            return self.peek(1).kind in ('id', 'kw') or self.peek(1).value == '*'
        return False

    def parse_decl_specifiers(self):
        words = []
        line = self.tok.line
        while True:
            self.skip_attributes()
            t = self.tok
            if t.kind in ('kw', 'id') and t.value in STORAGE:
                self.advance()
                continue
            if t.kind in ('kw', 'id') and t.value in QUALIFIERS:
                self.advance()
                continue
            if t.kind in ('kw', 'id') and is_type_name(t.value):
                words.append(t.value)
                self.advance()
                continue
            break
        if not words:
            raise self.error('expected a type name')
        if self.at('*'):
            raise UnsupportedC('pointer types are not modelled',
                               line=self.tok.line, col=self.tok.col,
                               hint='pass values, or use a local array')
        return type_from_keywords(words, line=line)

    # -- top level ----------------------------------------------------------

    def parse_unit(self):
        """Parse every definition, skipping the ones outside the subset.

        A paste often carries helpers this frontend does not model — a wrapper
        around an SSE intrinsic, say.  Refusing the whole file over a helper the
        kernel never needs is the wrong trade, so an unparseable definition is
        skipped and recorded.  Nothing is silent: the skips travel with the
        translation unit, and if the kernel actually calls one, the call fails
        with "call to unknown function".
        """
        functions = []
        skipped = []
        while self.tok.kind != 'eof':
            if self.accept(';'):
                continue
            if self.at('_Static_assert') or self.at('typedef'):
                skipped.append(self._skip_definition(
                    UnsupportedC('%r is not supported' % self.tok.value,
                                 line=self.tok.line)))
                continue
            mark = self.i
            try:
                fn = self.parse_external()
            except CFrontError as exc:
                self.i = mark
                skipped.append(self._skip_definition(exc))
                continue
            if fn is not None:
                functions.append(fn)

        if not functions:
            if skipped:
                raise skipped[0]['error']
            raise NoEntry()
        return N.TranslationUnit(functions, skipped=skipped)

    def _skip_definition(self, error):
        """Consume one top-level definition, and say what was dropped.

        The name is the identifier immediately before the parameter list — the
        declarator, not the return type, which is what a reader needs to see.
        """
        name = None
        previous = None
        line = self.tok.line
        depth = 0
        started = False
        while self.tok.kind != 'eof':
            token = self.advance()
            if token.value == '(' and name is None and previous is not None:
                name = previous
            if token.kind in ('id', 'kw'):
                previous = token.value
            if token.value == '{':
                depth += 1
                started = True
            elif token.value == '}':
                depth -= 1
                if started and depth <= 0:
                    break
            elif token.value == ';' and not started:
                break
        return {'name': name, 'line': line, 'error': error,
                'reason': error.message}

    def parse_external(self):
        line = self.tok.line
        ctype = self.parse_decl_specifiers()
        self.skip_attributes()

        if self.tok.kind not in ('id', 'kw'):
            raise self.error('expected a declarator name')
        name = self.advance().value

        if not self.at('('):
            # File-scope variable: accepted syntactically, rejected as a
            # semantic input because QM models pure functions of the arguments.
            raise UnsupportedC('file-scope variables are not modelled',
                               line=line,
                               hint='QM extracts semantics of a pure function '
                                    'of its arguments')

        params = self.parse_params()
        self.skip_attributes()

        if self.accept(';'):
            return None                     # prototype
        body = self.parse_block()
        return N.Function(name, ctype, params, body, line)

    def parse_params(self):
        self.expect('(')
        params = []
        if self.accept(')'):
            return params
        if self.at('void') and self.peek(1).value == ')':
            self.advance()
            self.advance()
            return params
        while True:
            if self.at('...'):
                raise UnsupportedC('variadic functions are not modelled',
                                   line=self.tok.line)
            ptype = self.parse_decl_specifiers()
            if self.tok.kind not in ('id', 'kw'):
                raise self.error('parameter needs a name in this subset')
            pname = self.advance().value
            if self.at('['):
                raise UnsupportedC('array parameters decay to pointers, which '
                                   'are not modelled', line=self.tok.line)
            params.append(N.Param(ptype, pname))
            if self.accept(','):
                continue
            self.expect(')')
            return params

    # -- statements ---------------------------------------------------------

    def parse_block(self):
        line = self.tok.line
        self.expect('{')
        items = []
        while not self.at('}'):
            if self.tok.kind == 'eof':
                raise self.error('unterminated block')
            items.append(self.parse_statement())
        self.expect('}')
        return N.Block(items, line=line)

    def parse_statement(self):
        t = self.tok
        line = t.line

        if self.at('{'):
            return self.parse_block()
        if self.accept(';'):
            return N.Empty(line=line)
        if self.at('if'):
            return self.parse_if()
        if self.at('while'):
            return self.parse_while()
        if self.at('do'):
            return self.parse_do()
        if self.at('for'):
            return self.parse_for()
        if self.at('switch'):
            return self.parse_switch()
        if self.at('case'):
            self.advance()
            value = self.parse_conditional()
            self.expect(':')
            return N.Case(value, line=line)
        if self.at('default'):
            self.advance()
            self.expect(':')
            return N.Default(line=line)
        if self.at('return'):
            self.advance()
            expr = None if self.at(';') else self.parse_expression()
            self.expect(';')
            return N.Return(expr, line=line)
        if self.at('break'):
            self.advance()
            self.expect(';')
            return N.Break(line=line)
        if self.at('continue'):
            self.advance()
            self.expect(';')
            return N.Continue(line=line)
        if self.at('goto'):
            raise UnsupportedC(
                'goto is not supported', line=line,
                hint='use structured, statically bounded control flow')
        if self.looks_like_declaration():
            return self.parse_declaration()

        expr = self.parse_expression()
        self.expect(';')
        return N.ExprStmt(expr, line=line)

    def parse_declaration(self):
        line = self.tok.line
        ctype = self.parse_decl_specifiers()
        decls = []
        while True:
            if self.tok.kind not in ('id', 'kw'):
                raise self.error('expected a variable name')
            name = self.advance().value
            size = None
            if self.accept('['):
                size = self.parse_conditional()
                self.expect(']')
            init = None
            if self.accept('='):
                init = self.parse_initializer()
            decls.append(N.Decl(ctype, name, size, init, line=line))
            if self.accept(','):
                continue
            self.expect(';')
            break
        if len(decls) == 1:
            return decls[0]
        return N.DeclGroup(decls, line=line)

    def parse_initializer(self):
        if self.accept('{'):
            items = []
            while not self.at('}'):
                items.append(self.parse_initializer())
                if not self.accept(','):
                    break
            self.expect('}')
            return items
        return self.parse_assignment()

    def parse_if(self):
        line = self.tok.line
        self.expect('if')
        self.expect('(')
        cond = self.parse_expression()
        self.expect(')')
        then = self.parse_statement()
        other = self.parse_statement() if self.accept('else') else None
        return N.If(cond, then, other, line=line)

    def parse_while(self):
        line = self.tok.line
        self.expect('while')
        self.expect('(')
        cond = self.parse_expression()
        self.expect(')')
        return N.While(cond, self.parse_statement(), False, line=line)

    def parse_do(self):
        line = self.tok.line
        self.expect('do')
        body = self.parse_statement()
        self.expect('while')
        self.expect('(')
        cond = self.parse_expression()
        self.expect(')')
        self.expect(';')
        return N.While(cond, body, True, line=line)

    def parse_for(self):
        line = self.tok.line
        self.expect('for')
        self.expect('(')
        if self.at(';'):
            self.advance()
            init = None
        elif self.looks_like_declaration():
            init = self.parse_declaration()
        else:
            init = N.ExprStmt(self.parse_expression(), line=line)
            self.expect(';')
        cond = None if self.at(';') else self.parse_expression()
        self.expect(';')
        step = None if self.at(')') else self.parse_expression()
        self.expect(')')
        return N.For(init, cond, step, self.parse_statement(), line=line)

    def parse_switch(self):
        line = self.tok.line
        self.expect('switch')
        self.expect('(')
        expr = self.parse_expression()
        self.expect(')')
        return N.Switch(expr, self.parse_block(), line=line)

    # -- expressions --------------------------------------------------------

    def parse_expression(self):
        expr = self.parse_assignment()
        while self.at(','):
            line = self.advance().line
            expr = N.Comma(expr, self.parse_assignment(), line=line)
        return expr

    def parse_assignment(self):
        start = self.i
        target = self.parse_conditional()
        if self.tok.kind == 'punct' and self.tok.value in ASSIGN_OPS:
            op = self.advance()
            if not isinstance(target, (N.Var, N.Index)):
                self.i = start
                raise self.error('assignment target must be a variable or an '
                                 'array element')
            return N.Assign(op.value, target, self.parse_assignment(),
                            line=op.line)
        return target

    def parse_conditional(self):
        cond = self.parse_binary(0)
        if self.at('?'):
            line = self.advance().line
            then = self.parse_expression()
            self.expect(':')
            return N.Cond(cond, then, self.parse_conditional(), line=line)
        return cond

    def parse_binary(self, level):
        if level >= len(PRECEDENCE):
            return self.parse_unary()
        ops = PRECEDENCE[level]
        left = self.parse_binary(level + 1)
        while self.tok.kind == 'punct' and self.tok.value in ops:
            op = self.advance()
            right = self.parse_binary(level + 1)
            if op.value in ('&&', '||'):
                left = N.Logical(op.value, left, right, line=op.line)
            else:
                left = N.Binary(op.value, left, right, line=op.line)
        return left

    def is_cast(self):
        if not self.at('('):
            return False
        t = self.peek(1)
        if t.kind not in ('kw', 'id'):
            return False
        return is_type_name(t.value) or t.value in QUALIFIERS

    def parse_unary(self):
        t = self.tok
        if t.kind == 'punct' and t.value in ('+', '-', '~', '!'):
            self.advance()
            return N.Unary(t.value, self.parse_unary(), line=t.line)
        if t.kind == 'punct' and t.value in ('++', '--'):
            self.advance()
            return N.IncDec(t.value, self.parse_unary(), False, line=t.line)
        if t.value == '*' or t.value == '&':
            if t.value == '&' and self.peek(1).kind in ('id',):
                raise UnsupportedC('address-of is not modelled', line=t.line)
        if self.at('sizeof'):
            self.advance()
            if self.is_cast():
                self.expect('(')
                ctype = self.parse_decl_specifiers()
                self.expect(')')
                return N.SizeOf(ctype, line=t.line)
            raise UnsupportedC('sizeof of an expression is not supported',
                               line=t.line)
        if self.is_cast():
            self.expect('(')
            ctype = self.parse_decl_specifiers()
            self.expect(')')
            return N.Cast(ctype, self.parse_unary(), line=t.line)
        return self.parse_postfix()

    def parse_postfix(self):
        expr = self.parse_primary()
        while True:
            t = self.tok
            if self.accept('['):
                index = self.parse_expression()
                self.expect(']')
                expr = N.Index(expr, index, line=t.line)
            elif t.kind == 'punct' and t.value in ('++', '--'):
                self.advance()
                expr = N.IncDec(t.value, expr, True, line=t.line)
            elif t.value in ('.', '->'):
                raise UnsupportedC('struct/union member access is not modelled',
                                   line=t.line)
            else:
                return expr

    def parse_primary(self):
        t = self.tok
        if t.kind == 'num':
            self.advance()
            bits, signed = t.ctype_hint or (32, True)
            from .ctypes_model import CType
            ctype = INT if (bits, signed) == (32, True) else CType(
                ('int%d_t' % bits) if signed else ('uint%d_t' % bits),
                bits, signed)
            return N.Num(t.value, ctype, line=t.line)
        if t.kind == 'id':
            self.advance()
            if self.at('('):
                self.advance()
                args = []
                if not self.at(')'):
                    while True:
                        args.append(self.parse_assignment())
                        if self.accept(','):
                            continue
                        break
                self.expect(')')
                return N.Call(t.value, args, line=t.line)
            return N.Var(t.value, line=t.line)
        if self.accept('('):
            expr = self.parse_expression()
            self.expect(')')
            return expr
        if t.kind == 'kw' and t.value in ('true', 'false'):
            self.advance()
            return N.Num(1 if t.value == 'true' else 0, INT, line=t.line)
        raise self.error('unexpected token %r' % (t.value,))


def parse(source):
    """Parse C source text into a TranslationUnit."""
    return Parser(lex(source)).parse_unit()
