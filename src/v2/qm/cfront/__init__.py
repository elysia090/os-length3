"""C-subset frontend: source text -> callable semantics.

Public surface:

    parse(source)                 -> TranslationUnit
    Interpreter(unit).call(...)   -> (value, ctype)
    CFrontError / UnsupportedC    -> located diagnostics

The subset is documented in ``docs/C_SUBSET.md``.
"""

from .compile import Compiler, compile_unit             # noqa: F401
from .errors import CFrontError, NoEntry, UnsupportedC  # noqa: F401
from .interp import BUILTIN_NAMES, Interpreter          # noqa: F401
from .parser import parse                               # noqa: F401

__all__ = [
    'CFrontError', 'NoEntry', 'UnsupportedC', 'Interpreter', 'Compiler',
    'compile_unit', 'parse', 'BUILTIN_NAMES',
]
