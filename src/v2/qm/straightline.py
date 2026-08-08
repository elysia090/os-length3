"""Compiling a straight-line integer program to a Python function.

Four things here are straight-line programs over 64-bit integers: a lowered
`isa.Seq`, a normalized `program.Program`, and the two assembly readers. All
four are evaluated over a declared domain — 65,536 points for a 16-bit kernel,
several times over — and each used to walk its own instruction list per point.
Resolving each instruction to a closure took the opcode test out of the loop;
this takes the loop out too, by writing the whole program down as one Python
function and letting the interpreter run it as straight code.

What gets compiled is closed. Every name in the generated source is either a
temporary this module named or a helper the caller passed in `env`, and every
constant is formatted from an `int`. No text from a paste reaches it, and there
is nothing for a paste to reach it with — the callers hand over integers, not
strings.

`fn.qm_source` keeps the generated text on the function. A tool whose whole
claim is that you can check what it computed should not have a step you cannot
read.

Layer 0: depends on nothing.
"""

MAX_LINES = 200000


class TooLong(Exception):
    """The program is longer than is worth compiling in one function."""


def build(name, params, body, result, env):
    """Assemble and compile `def name(params): ... ; return result`.

    `body` is a list of `(variable, expression)` pairs in evaluation order.
    `env` supplies any helper the expressions call; it is copied, not shared.
    """
    if len(body) > MAX_LINES:
        raise TooLong('%d instructions exceed the straight-line budget' % len(body))

    lines = ['def %s(%s):' % (name, ', '.join(params))]
    lines += ['    %s = %s' % (variable, expression)
              for variable, expression in body]
    lines.append('    return %s' % result)
    source = '\n'.join(lines)

    scope = dict(env)
    exec(compile(source, '<qm:%s>' % name, 'exec'), scope)
    function = scope[name]
    function.qm_source = source
    return function
