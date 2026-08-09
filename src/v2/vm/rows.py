"""The direct physical row form of the transactional rSUBLEQ machine.

The scalar machine reads five cells per transition. This representation keeps
those reads resolved in resident rows and repairs them by broadcast when
memory changes.

A resident coordinate keeps a row:

    row_M(i) = (source      = M[i],
                destination = M[i+1],
                branch      = M[i+2],
                old         = M[M[i+1]],
                change      = -M[M[i]])

so a transition is `result = old + change` with no indirect read left to do:

    successor = pc+3           when result > 0
                branch         when result <= 0 and branch >= 0
                event(branch)  when result <= 0 and branch < 0

Writing coordinate `d` invalidates exactly the cached components that read it,
as follows: a row whose destination is `d` has a stale `old`, a row
whose source is `d` has a stale `change`, and rows `d`, `d-1`, `d-2` have stale
*descriptors* and are rebuilt whole. Every other entry is an independent
single-slot add of the same `change`, so the repair is one wave with no
reduction, no atomic and no order among lanes.

That is the cost model, and it is not the instruction count:

    work                 = Theta(k + 1)     per transition, k incidences
    row_dependency_span  = Theta(1)         per transition
    barriers             = 1 when change != 0 and k > 0

and when `change == 0` the undo, the store, the propagation, the repair and
the synchronization all disappear — such a transition costs its capture and
nothing else.

This module is a reference: it computes the same outcomes as `machine.py` and
counts the wave costs above. Nothing here is a second semantics — the tests
run both on the same artifacts and require identical outcomes.

Depends on `image` and `machine`.
"""

from . import machine
from .image import DEAD


class Cost(object):
    """Logical transitions and physical wave costs accumulated over a call."""

    __slots__ = ('transitions', 'work', 'span', 'barriers', 'incidences',
                 'quiet')

    def __init__(self):
        self.transitions = 0     # logical transitions, ordered through pc
        self.work = 0            # sum of Theta(k+1)
        self.span = 0            # sum of Theta(1) row-dependency spans
        self.barriers = 0        # worker barriers actually needed
        self.incidences = 0      # sum of k
        self.quiet = 0           # transitions with change == 0

    def to_dict(self):
        return {'transitions': self.transitions, 'work': self.work,
                'span': self.span, 'barriers': self.barriers,
                'incidences': self.incidences, 'quiet': self.quiet}

    def __repr__(self):
        return ('Cost(transitions=%d, work=%d, span=%d, barriers=%d, quiet=%d)'
                % (self.transitions, self.work, self.span, self.barriers,
                   self.quiet))


class Rows(object):
    """Resident rows over one memory, with reverse incidence indexes.

    Rows are created on first arrival and never have to be created any other
    way: the row is a function of memory, so a coordinate that is never entered
    costs nothing.
    """

    __slots__ = ('memory', 'source', 'destination', 'branch', 'old', 'change',
                 'paired', 'by_destination', 'by_source')

    def __init__(self, memory):
        self.memory = memory
        self.source = {}
        self.destination = {}
        self.branch = {}
        self.old = {}
        self.change = {}
        # Rows with source == destination need only one stored value:
        # `result = 0` and `change = -old`. Therefore `change`
        # is derived at use rather than cached. Caching it and updating only
        # `old` in the wave is exactly how it goes stale.
        self.paired = set()
        # Reverse incidence, so a write finds its dependents without a scan.
        self.by_destination = {}
        self.by_source = {}

    # -- residency --------------------------------------------------------

    def _index(self, at, add):
        table = self.by_destination.setdefault(self.destination[at], set())
        table.add(at) if add else table.discard(at)
        table = self.by_source.setdefault(self.source[at], set())
        table.add(at) if add else table.discard(at)

    def materialize(self, at):
        """Build row `at` from memory, replacing any earlier version."""
        if at in self.source:
            self._index(at, False)
        get = self.memory.get
        self.source[at] = source = get(at, 0)
        self.destination[at] = destination = get(at + 1, 0)
        self.branch[at] = get(at + 2, 0)
        # An invalid row has no value and therefore fails finitely.
        self.paired.discard(at)
        if source >= 0 and destination >= 0:
            self.old[at] = get(destination, 0)
            if source == destination:
                self.paired.add(at)
                self.change.pop(at, None)
            else:
                self.change[at] = -get(source, 0)
        else:
            self.old.pop(at, None)
            self.change.pop(at, None)
        self._index(at, True)

    def resident(self, at):
        return at in self.source

    def operands(self, at):
        """(old, change) for a valid row, deriving `change` where it must be."""
        old = self.old[at]
        return old, (-old if at in self.paired else self.change[at])

    def ensure(self, at):
        if at not in self.source:
            self.materialize(at)

    # -- the wave ---------------------------------------------------------

    def propagate(self, written, change, cost):
        """Perform one write, one incidence wave, then repair code rows.

        Every entry below writes a distinct component, so the loop has no
        reduction and no ordering dependency. `k` is the number of touched
        source/destination incidences.
        """
        special = set()
        for offset in (0, 1, 2):
            at = written - offset
            if self.resident(at):
                special.add(at)

        touched = 0
        for at in self.by_destination.get(written, ()):
            if at in special:
                continue
            # `old` is the whole story for a paired row and half of it
            # otherwise; either way this is the component that moved.
            self.old[at] += change
            touched += 1
        for at in self.by_source.get(written, ()):
            if at in special or self.destination[at] == written:
                continue
            self.change[at] -= change             # source = d, destination != d
            touched += 1

        # The coordinator owns the descriptors a write actually moved.
        for at in sorted(special):
            self.materialize(at)

        cost.incidences += touched
        cost.work += touched
        if touched:
            cost.barriers += 1
        return touched


def run(memory, pc, budget, cost=None):
    """Execute from `pc` over `memory` in the physical normal form.

    Returns `(event, cost)`; `event` is the negative branch target that ended
    the run, or None for a finite failure. Outcomes are identical to
    `machine._run`; what differs is what gets counted and what gets read.
    """
    cost = cost or Cost()
    rows = Rows(memory)

    while True:
        if cost.transitions >= budget:
            raise machine.Unfinished(cost.transitions)
        cost.transitions += 1
        cost.span += 1                      # Theta(1) row dependency
        cost.work += 1                      # the capture itself

        rows.ensure(pc)
        if pc not in rows.old:               # invalid row: source or dest < 0
            return None, cost

        old, change = rows.operands(pc)
        destination = rows.destination[pc]
        branch = rows.branch[pc]
        result = old + change

        if change:
            if result:
                memory[destination] = result
            else:
                memory.pop(destination, None)
            rows.propagate(destination, change, cost)
        else:
            cost.quiet += 1                  # nothing to store, nothing to fix

        if result > 0:
            pc = pc + 3
            continue
        if branch >= 0:
            pc = branch
            continue
        return branch, cost


def measure(residual, history=(), budget=1 << 24):
    """Cost of feeding `history` and then reading in the row-wave model."""
    if residual.dead:
        return None
    total = Cost()
    scratch = dict(residual.image.memory)
    for byte in history:
        if byte:
            scratch[0] = byte
        else:
            scratch.pop(0, None)
        event, _ = run(scratch, residual.image.pc_feed, budget, total)
        if event != machine.COMMIT:
            return None
    read_scratch = dict(scratch)
    run(read_scratch, residual.image.pc_out, budget, total)
    return total
