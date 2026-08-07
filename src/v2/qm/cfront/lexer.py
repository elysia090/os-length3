"""Tokenizer and minimal preprocessor for the C subset.

Handled here:
    line/block comments, line continuations
    #include / #pragma / #line          ignored
    #define NAME tokens...              object-like macros, expanded by token
    integer and character constants with C suffix rules

Deliberately not handled (reported, never silently ignored):
    function-like macros, conditional compilation, string literals as values
"""

import re

from .errors import CFrontError, UnsupportedC

KEYWORDS = {
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
    'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
    'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
    'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned',
    'void', 'volatile', 'while', '_Bool', 'bool', '_Static_assert',
    '__int128', '__inline', '__inline__', '__restrict', '__restrict__',
    '__attribute__', '__extension__', '__forceinline',
}

# Longest-first so that '<<=' wins over '<<' and '<'.
PUNCTUATORS = [
    '<<=', '>>=', '...',
    '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=',
    '{', '}', '(', ')', '[', ']', ';', ',', ':', '?',
    '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=', '.',
]

_IDENT = re.compile(r'[A-Za-z_$][A-Za-z_0-9$]*')
_NUMBER = re.compile(
    r'0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+\.[0-9]*([eE][-+]?[0-9]+)?|'
    r'\.[0-9]+([eE][-+]?[0-9]+)?|[0-9]+([eE][-+]?[0-9]+)?'
)
_SUFFIX = re.compile(r'[uUlL]*')

_ESCAPES = {
    'n': 10, 't': 9, 'r': 13, '0': 0, '\\': 92, "'": 39, '"': 34,
    'a': 7, 'b': 8, 'f': 12, 'v': 11, '?': 63,
}


class Token(object):
    __slots__ = ('kind', 'value', 'line', 'col', 'ctype_hint')

    def __init__(self, kind, value, line, col, ctype_hint=None):
        self.kind = kind          # 'id' | 'kw' | 'num' | 'punct' | 'eof'
        self.value = value
        self.line = line
        self.col = col
        self.ctype_hint = ctype_hint   # for 'num': (bits, signed) preference

    def __repr__(self):
        return 'Token(%s, %r, %d:%d)' % (self.kind, self.value, self.line, self.col)


def strip_comments(text):
    """Remove comments and line continuations, preserving line numbering."""
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    out = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == '\\' and i + 1 < n and text[i + 1] == '\n':
            # Line continuation: drop the backslash, keep the newline so that
            # reported line numbers still match the pasted source.
            out.append(' ')
            out.append('\n')
            i += 2
        elif c == '/' and i + 1 < n and text[i + 1] == '/':
            while i < n and text[i] != '\n':
                i += 1
        elif c == '/' and i + 1 < n and text[i + 1] == '*':
            j = text.find('*/', i + 2)
            if j < 0:
                raise CFrontError('unterminated block comment',
                                  line=text.count('\n', 0, i) + 1)
            out.append(' ' * 1)
            out.append('\n' * text.count('\n', i, j))
            i = j + 2
        elif c in '"\'':
            quote = c
            j = i + 1
            while j < n and text[j] != quote:
                if text[j] == '\\':
                    j += 1
                j += 1
            if j >= n:
                raise CFrontError('unterminated character/string literal',
                                  line=text.count('\n', 0, i) + 1)
            out.append(text[i:j + 1])
            i = j + 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def _parse_int_literal(text, line, col):
    """Return (value, bits, signed) following C integer-constant rules."""
    m = _SUFFIX.match(text, 0)
    body = text
    suffix = ''
    k = len(text)
    while k > 0 and text[k - 1] in 'uUlL':
        k -= 1
    body, suffix = text[:k], text[k:].lower()

    if body[:2] in ('0x', '0X'):
        value, decimal = int(body, 16), False
    elif body[:2] in ('0b', '0B'):
        value, decimal = int(body[2:], 2), False
    elif body.startswith('0') and len(body) > 1 and body[1:].isdigit():
        value, decimal = int(body, 8), False
    else:
        try:
            value, decimal = int(body, 10), True
        except ValueError:
            raise CFrontError('floating-point constants are not supported '
                              'by the bit-vector frontend: %r' % text,
                              line=line, col=col,
                              hint='QM models fixed-width integer kernels')

    unsigned = 'u' in suffix
    long_ = suffix.count('l')

    # Smallest type from the C rank ladder that can hold the value.
    if long_ >= 1:
        candidates = [(64, not unsigned)]
    else:
        candidates = [(32, not unsigned), (64, not unsigned)]
    if not unsigned and not decimal:
        # Hex/octal constants may land on an unsigned type.
        candidates = [(32, True), (32, False), (64, True), (64, False)]
    if value > (1 << 64) - 1:
        candidates = [(128, not unsigned)]

    for bits, signed in candidates:
        limit = (1 << (bits - 1)) - 1 if signed else (1 << bits) - 1
        if value <= limit:
            return value, bits, signed
    return value, 128, False


def _parse_char_literal(text, line, col):
    body = text[1:-1]
    if not body:
        raise CFrontError('empty character constant', line=line, col=col)
    if body[0] == '\\':
        rest = body[1:]
        if rest[:1] == 'x':
            return int(rest[1:], 16)
        if rest[:1] in _ESCAPES and len(rest) == 1:
            return _ESCAPES[rest]
        if rest.isdigit():
            return int(rest, 8)
        raise CFrontError('unsupported escape sequence %r' % body,
                          line=line, col=col)
    if len(body) != 1:
        raise CFrontError('multi-character constants are not supported',
                          line=line, col=col)
    return ord(body)


def tokenize(text):
    """Tokenize preprocessed-enough C into a flat token list."""
    tokens = []
    line = 1
    line_start = 0
    i = 0
    n = len(text)

    while i < n:
        c = text[i]

        if c == '\n':
            line += 1
            i += 1
            line_start = i
            continue
        if c in ' \t\f\v':
            i += 1
            continue

        col = i - line_start + 1

        if c == '#':
            end = text.find('\n', i)
            end = n if end < 0 else end
            tokens.append(Token('directive', text[i:end].strip(), line, col))
            i = end
            continue

        if c == '"':
            raise UnsupportedC('string literals have no bit-vector meaning here',
                               line=line, col=col)

        if c == "'":
            j = i + 1
            while j < n and text[j] != "'":
                if text[j] == '\\':
                    j += 1
                j += 1
            value = _parse_char_literal(text[i:j + 1], line, col)
            tokens.append(Token('num', value, line, col, (32, True)))
            i = j + 1
            continue

        m = _NUMBER.match(text, i)
        if m and (c.isdigit() or (c == '.' and i + 1 < n and text[i + 1].isdigit())):
            raw = m.group(0)
            j = m.end()
            while j < n and text[j] in 'uUlL':
                j += 1
            literal = text[i:j]
            if '.' in raw or (('e' in raw or 'E' in raw) and not raw.lower().startswith('0x')):
                raise UnsupportedC('floating-point constant %r' % raw,
                                   line=line, col=col,
                                   hint='QM models fixed-width integer kernels')
            value, bits, signed = _parse_int_literal(literal, line, col)
            tokens.append(Token('num', value, line, col, (bits, signed)))
            i = j
            continue

        m = _IDENT.match(text, i)
        if m:
            word = m.group(0)
            kind = 'kw' if word in KEYWORDS else 'id'
            tokens.append(Token(kind, word, line, col))
            i = m.end()
            continue

        for p in PUNCTUATORS:
            if text.startswith(p, i):
                tokens.append(Token('punct', p, line, col))
                i += len(p)
                break
        else:
            raise CFrontError('unexpected character %r' % c, line=line, col=col)

    tokens.append(Token('eof', None, line, 1))
    return tokens


def apply_directives(tokens, max_expansions=10000):
    """Handle `#define` object-like macros; ignore includes and pragmas."""
    macros = {}
    body = []

    for tok in tokens:
        if tok.kind != 'directive':
            body.append(tok)
            continue

        text = tok.value.lstrip('#').strip()
        head = text.split(None, 1)
        if not head:
            continue
        name = head[0]

        if name in ('include', 'pragma', 'line', 'warning', 'error'):
            continue
        if name in ('if', 'ifdef', 'ifndef', 'elif', 'else', 'endif', 'undef'):
            raise UnsupportedC('conditional compilation (#%s) is not supported'
                               % name, line=tok.line,
                               hint='paste the already-selected branch')
        if name != 'define':
            raise UnsupportedC('directive #%s is not supported' % name,
                               line=tok.line)

        rest = head[1] if len(head) > 1 else ''
        m = _IDENT.match(rest)
        if not m:
            raise CFrontError('malformed #define', line=tok.line)
        macro_name = m.group(0)
        tail = rest[m.end():]
        if tail.startswith('('):
            raise UnsupportedC('function-like macro %r is not supported'
                               % macro_name, line=tok.line,
                               hint='inline the macro, or use a static inline '
                                    'function instead')
        macros[macro_name] = tokenize(tail)[:-1]  # drop EOF

    if not macros:
        return body

    expansions = 0
    changed = True
    while changed:
        changed = False
        out = []
        for tok in body:
            if tok.kind == 'id' and tok.value in macros:
                expansions += 1
                if expansions > max_expansions:
                    raise CFrontError('macro expansion did not terminate')
                for rep in macros[tok.value]:
                    out.append(Token(rep.kind, rep.value, tok.line, tok.col,
                                     rep.ctype_hint))
                changed = True
            else:
                out.append(tok)
        body = out
    return body


def lex(source):
    """Full path: source text -> token list ready for the parser."""
    return apply_directives(tokenize(strip_comments(source)))
