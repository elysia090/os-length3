"""Diagnostics for the C subset frontend.

Every rejection carries a line/column and, where possible, a concrete
suggestion.  A frontend that says only "parse error" is not usable as the first
screen of an interactive product.
"""


class CFrontError(Exception):
    def __init__(self, message, line=None, col=None, hint=None):
        super(CFrontError, self).__init__(message)
        self.message = message
        self.line = line
        self.col = col
        self.hint = hint

    def __str__(self):
        where = ''
        if self.line is not None:
            where = ' at line %d' % self.line
            if self.col is not None:
                where += ', column %d' % self.col
        text = '%s%s' % (self.message, where)
        if self.hint:
            text += '\n  hint: %s' % self.hint
        return text

    def to_dict(self):
        return {
            'message': self.message,
            'line': self.line,
            'col': self.col,
            'hint': self.hint,
            'text': str(self),
        }


class UnsupportedC(CFrontError):
    """A valid C construct that this subset deliberately does not model."""
