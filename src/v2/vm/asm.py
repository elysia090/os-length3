"""A SUBLEQ assembler over the canonical image.

The machine has one instruction and no registers, so everything above it is a
convention. These are the conventions, and they are the only ones:

    subleq(a, b, target)      M[b] -= M[a]; branch to target when M[b] <= 0
    subleq(a, b)              ... and fall through either way, because the
                              branch target *is* the next instruction

`Z` is a scratch cell the assembler keeps at zero. Two idioms follow from that
and nothing else needs inventing:

    subleq(Z, x, L)           if M[x] <= 0 goto L      (x unchanged, Z is 0)
    subleq(Z, Z, L)           goto L                   (0 - 0 <= 0, always)

Addresses are assigned once, at `build`, so a caller writes symbols and never
counts cells. Data lands first and code after it, which keeps every branch
target inside the code region and every operand outside it.

Depends only on `image`.
"""

from .image import Image


class Cell(object):
    """A named data cell. Its address is decided at `build`."""

    __slots__ = ('name', 'initial', 'address')

    def __init__(self, name, initial=0):
        self.name = name
        self.initial = initial
        self.address = None

    def __repr__(self):
        return 'Cell(%s)' % self.name


class Label(object):
    """A position in the code. Bound by `place`, resolved at `build`."""

    __slots__ = ('name', 'index')

    def __init__(self, name):
        self.name = name
        self.index = None

    def __repr__(self):
        return 'Label(%s)' % self.name


# Branch targets that are not code positions.
EMIT = 'EMIT'
COMMIT = 'COMMIT'
FAIL = 'FAIL'
NEXT = 'NEXT'

_EVENTS = {EMIT: -1, COMMIT: -2, FAIL: -3}


class Asm(object):
    """Emit SUBLEQ, resolve symbols, hand back a canonical image."""

    # The ABI cells, fixed by the specification.
    INPUT = 0
    OUTPUT = 1

    def __init__(self):
        self._cells = []
        self._code = []                 # (a, b, c) with symbolic operands
        self._names = {}
        self._code_base = None
        self.Z = self.cell('Z')         # kept at zero by every macro that uses it

    # -- symbols ----------------------------------------------------------

    def cell(self, name, initial=0):
        if name in self._names:
            raise ValueError('duplicate cell %r' % name)
        made = Cell(name, initial)
        self._names[name] = made
        self._cells.append(made)
        return made

    def cells(self, prefix, count, initial=0):
        return [self.cell('%s%d' % (prefix, i), initial) for i in range(count)]

    def label(self, name):
        return Label(name)

    def place(self, label):
        label.index = len(self._code)
        return label

    # -- emission ---------------------------------------------------------

    def subleq(self, a, b, target=NEXT):
        self._code.append((a, b, target))

    def halt(self, event):
        """End the call with an invocation event.

        `Z - Z` is zero, so the branch is always taken and the event always
        fires; nothing downstream has to be arranged for it.
        """
        self.subleq(self.Z, self.Z, event)

    # -- the whole vocabulary ---------------------------------------------

    def goto(self, target):
        self.subleq(self.Z, self.Z, target)

    def if_le_zero(self, x, target):
        """Branch when M[x] <= 0, leaving x alone."""
        self.subleq(self.Z, x, target)

    def clear(self, x):
        self.subleq(x, x)

    def sub(self, source, target):
        """M[target] -= M[source]."""
        self.subleq(source, target)

    def add(self, source, target):
        """M[target] += M[source], through a negation this add owns.

        The scratch is private on purpose. Section 3.2 keeps every row's
        operands already dereferenced, so writing a cell costs one incidence
        per row that reads it — and a scratch shared by the whole program is
        read by the whole program. Funnelling every add through one cell put
        98.9% of `ranks8`'s measured work on that single coordinate; giving
        each add its own drops the work from 146,828 to 3,672 for 26% more
        L(z), and work precedes L(z) in the objective.
        """
        scratch = self.cell('z%d' % len(self._code))
        self.subleq(source, scratch)         # scratch = -source
        self.subleq(scratch, target)         # target -= -source
        self.subleq(scratch, scratch)        # scratch = 0

    def move(self, source, target):
        """M[target] = M[source]."""
        self.clear(target)
        self.add(source, target)

    def neg_into(self, source, target):
        """M[target] = -M[source]."""
        self.clear(target)
        self.sub(source, target)

    # -- image ------------------------------------------------------------

    def build(self, entry_out, entry_feed):
        """Assign addresses and return the canonical image.

        Data first, then code: a branch target is always a code address and an
        operand is always a data address, so a mistake in one cannot quietly
        read as the other.
        """
        at = 2                                   # 0 and 1 are the ABI cells
        for made in self._cells:
            made.address = at
            at += 1
        code_base = at
        self._code_base = code_base

        memory = {}
        for made in self._cells:
            if made.initial:
                memory[made.address] = made.initial

        def operand(value):
            if isinstance(value, Cell):
                if value.address is None:
                    raise ValueError('unplaced cell %r' % value.name)
                return value.address
            if isinstance(value, int):
                return value
            raise ValueError('not an operand: %r' % (value,))

        def resolve(target, index):
            if target is NEXT:
                return code_base + 3 * (index + 1)
            if target in _EVENTS:
                return _EVENTS[target]
            if isinstance(target, Label):
                if target.index is None:
                    raise ValueError('unplaced label %r' % target.name)
                return code_base + 3 * target.index
            if isinstance(target, int):
                return target
            raise ValueError('not a branch target: %r' % (target,))

        for index, (a, b, c) in enumerate(self._code):
            base = code_base + 3 * index
            for offset, value in enumerate((operand(a), operand(b),
                                            resolve(c, index))):
                if value:
                    memory[base + offset] = value

        return Image(memory, pc_out=resolve(entry_out, -1),
                     pc_feed=resolve(entry_feed, -1))

    def code_address(self, index):
        """Address of instruction `index`. Valid only after `build`.

        Needed to write a program that modifies itself: the operand words of
        instruction `i` live at `code_address(i) + 0, +1, +2`, and §3.2 calls
        the rows holding them `special` for exactly that reason.
        """
        if self._code_base is None:
            raise ValueError('addresses are assigned by build()')
        return self._code_base + 3 * index

    def __len__(self):
        return len(self._code)
