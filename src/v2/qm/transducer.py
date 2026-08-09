"""Exact quotient compilation for a finite deterministic transducer.

Scalar QM starts with a finite function ``x -> y``. A driver or VM instead
has persistent state:

    step(state, letter) -> next_state
    out(state)          -> observable

This module first closes the reachable state graph and then repeatedly splits
states by their observable and successor classes. The fixed point is the exact
future quotient: two states share a class only when no finite continuation can
distinguish them.

The result is build-side proof data, not a released runtime. States, letters
and shared transition rows are coordinate regions. Their access maps are
normalized to a constant, an affine coordinate expression, or dense storage,
and identical rows are stored once. Exploration is accepted only when the graph
closes below ``max_states``; reaching the bound raises ``StateLimit`` instead
of treating a bounded prefix as a proof of finiteness.
"""


class StateLimit(Exception):
    """Reachability did not close inside the caller's exact-state budget."""

    def __init__(self, limit):
        Exception.__init__(self, 'reachable state graph exceeds %d states'
                           % limit)
        self.limit = limit


class CoordinateCell(object):
    """A power-of-two coordinate cell and one live rank region inside it.

    ``select`` is the only operation that turns an internal rank into the
    cell's ordinary positive integer. Machine execution carries ranks.
    """

    __slots__ = ('ell', 'word', 'capacity', 'lo', 'hi')

    def __init__(self, count):
        if count < 0:
            raise ValueError('coordinate count must be nonnegative')
        self.ell = max(1, (max(1, count) - 1).bit_length() + 1)
        payload, width = _omega_payload(self.ell)
        self.word = (1 << width) | payload
        self.capacity = 1 << (self.ell - 1)
        self.lo = 0
        self.hi = count

    @property
    def count(self):
        return self.hi - self.lo

    def contains(self, rank, endpoint=False):
        limit = self.hi + (1 if endpoint else 0)
        return self.lo <= rank < limit

    def select(self, rank):
        if not self.contains(rank):
            raise ValueError('rank is outside the live region: %r' % rank)
        return (1 << (self.ell - 1)) + rank

    def rank(self, value):
        rank = value - (1 << (self.ell - 1))
        if not self.contains(rank):
            raise ValueError('value is outside the live region: %r' % value)
        return rank

    def cut(self, endpoint):
        """Return the selected and residual half-open rank regions."""
        if not self.lo <= endpoint <= self.hi:
            raise ValueError('cut is outside the live region: %r' % endpoint)
        return ((self.lo, endpoint), (endpoint, self.hi))

    def to_dict(self):
        return {'descriptor_word': self.word, 'ell': self.ell,
                'capacity': self.capacity,
                'region': [self.lo, self.hi]}


def _omega_payload(number):
    """Return the left-readable omega payload and its bit width."""
    if number < 1:
        raise ValueError('omega coding takes a positive integer')
    chunks = []
    while number > 1:
        width = number.bit_length()
        chunks.append((number, width))
        number = width - 1
    payload = 0
    width = 0
    for bits, bits_width in reversed(chunks):
        payload = (payload << bits_width) | bits
        width += bits_width
    return payload << 1, width + 1


class PhysicalMap(object):
    """A coordinate map stored as constant, affine, or dense values."""

    __slots__ = ('region', 'kind', 'base', 'step', 'values')

    def __init__(self, values):
        values = tuple(values)
        self.region = CoordinateCell(len(values))
        self.base = None
        self.step = None
        self.values = ()
        if not values:
            self.kind = 'dense'
            return
        if all(value == values[0] for value in values):
            self.kind = 'constant'
            self.base = values[0]
            return
        if all(isinstance(value, int) for value in values):
            step = values[1] - values[0]
            if all(value == values[0] + step * rank
                   for rank, value in enumerate(values)):
                self.kind = 'affine'
                self.base = values[0]
                self.step = step
                return
        self.kind = 'dense'
        self.values = values

    def at(self, rank):
        if not self.region.contains(rank):
            raise ValueError('rank is outside the map: %r' % rank)
        if self.kind == 'constant':
            return self.base
        if self.kind == 'affine':
            return self.base + self.step * rank
        return self.values[rank]

    __getitem__ = at

    @property
    def storage_cells(self):
        if not self.region.count:
            return 0
        if self.kind == 'constant':
            return 1
        if self.kind == 'affine':
            return 2
        return len(self.values)

    def to_dict(self):
        report = {'kind': self.kind,
                  'domain': self.region.to_dict(),
                  'storage_cells': self.storage_cells}
        if self.kind == 'constant':
            report['value'] = self.base
        elif self.kind == 'affine':
            report.update({'base': self.base, 'step': self.step})
        return report


class PhysicalTransitions(object):
    """Deduplicated transition rows over state and letter coordinates."""

    __slots__ = ('state_region', 'letter_region', 'row_region',
                 'row_of_state', 'rows')

    def __init__(self, transitions):
        transitions = tuple(tuple(row) for row in transitions)
        width = len(transitions[0]) if transitions else 0
        if any(len(row) != width for row in transitions):
            raise ValueError('transition rows must have equal width')

        unique = {}
        rows = []
        selector = []
        for row in transitions:
            index = unique.get(row)
            if index is None:
                index = len(rows)
                unique[row] = index
                rows.append(PhysicalMap(row))
            selector.append(index)

        self.state_region = CoordinateCell(len(transitions))
        self.letter_region = CoordinateCell(width)
        self.row_region = CoordinateCell(len(rows))
        self.row_of_state = PhysicalMap(selector)
        self.rows = tuple(rows)

    def at(self, state, letter_rank):
        row = self.row_of_state.at(state)
        return self.rows[row].at(letter_rank)

    def __getitem__(self, state):
        return self.rows[self.row_of_state.at(state)]

    @property
    def storage_cells(self):
        return (self.row_of_state.storage_cells
                + sum(row.storage_cells for row in self.rows))

    def to_dict(self):
        return {
            'states': self.state_region.to_dict(),
            'letters': self.letter_region.to_dict(),
            'rows': self.row_region.to_dict(),
            'unique_rows': len(self.rows),
            'row_selector': self.row_of_state.to_dict(),
            'row_forms': [row.to_dict() for row in self.rows],
            'storage_cells': self.storage_cells,
        }


class DirectByteCache(object):
    """A value cache over the complete right-zero ``Byte*`` quotient.

    The retained state is the final byte itself. A transition therefore needs
    neither a hash nor a 256-by-256 table: ``step(_state, byte) == byte``. The
    value attached to each state is one direct 256-slot coordinate map, which
    :class:`PhysicalMap` may reduce further when it is constant or affine.
    """

    __slots__ = ('initial', 'values')

    def __init__(self, initial, values):
        values = tuple(values)
        if len(values) != 256:
            raise ValueError('a direct Byte* cache has exactly 256 slots')
        if not 0 <= initial < 256:
            raise ValueError('the initial Byte* token must be one byte')
        self.initial = int(initial)
        self.values = PhysicalMap(values)

    @staticmethod
    def step(_state, byte):
        if not 0 <= byte < 256:
            raise ValueError('Byte* transition takes one byte: %r' % byte)
        return byte

    def lookup(self, state):
        if not 0 <= state < 256:
            raise ValueError('Byte* cache token is not one byte: %r' % state)
        return self.values.at(state)

    def run(self, history, state=None):
        at = self.initial if state is None else state
        if not 0 <= at < 256:
            raise ValueError('Byte* cache token is not one byte: %r' % at)
        for byte in history:
            at = self.step(at, byte)
        return at, self.lookup(at)

    def to_dict(self):
        return {
            'domain': 'Byte*',
            'classes': 256,
            'resume_bytes': 1,
            'transition': 'next = byte',
            'transition_storage_cells': 0,
            'value_slots': 256,
            'values': self.values.to_dict(),
        }


class DirectByteProjection(object):
    """Build-side proof that quotient classes are named by their last byte."""

    __slots__ = ('initial', 'state_by_byte')

    def __init__(self, initial, state_by_byte):
        state_by_byte = tuple(state_by_byte)
        if len(state_by_byte) != 256 or len(set(state_by_byte)) != 256:
            raise ValueError('direct byte projection must biject 256 classes')
        try:
            initial_byte = state_by_byte.index(initial)
        except ValueError:
            raise ValueError('the initial class has no direct byte token')
        self.initial = initial_byte
        self.state_by_byte = state_by_byte

    def state(self, history):
        at = self.state_by_byte[self.initial]
        for byte in history:
            if not 0 <= byte < 256:
                raise ValueError('Byte* transition takes one byte: %r' % byte)
            at = self.state_by_byte[byte]
        return at

    def cache(self, values_by_state):
        """Materialize one quotient-invariant value per direct byte token."""
        values_by_state = tuple(values_by_state)
        if max(self.state_by_byte) >= len(values_by_state):
            raise ValueError('value map does not cover every quotient class')
        return DirectByteCache(
            self.initial,
            (values_by_state[state] for state in self.state_by_byte),
        )


class QuotientMachine(object):
    """A minimal reachable Moore-machine closure witness.

    ``step`` and ``run`` let tests check the witness. Product inference must
    still execute the selected canonical artifact; this object is erased after
    candidate equivalence and physical ordering have been established.
    """

    __slots__ = ('alphabet', 'initial', 'outputs', 'transitions',
                 'reachable_states', '_letter_index')

    def __init__(self, alphabet, initial, outputs, transitions,
                 reachable_states):
        self.alphabet = tuple(alphabet)
        self.initial = int(initial)
        self.outputs = PhysicalMap(outputs)
        self.transitions = PhysicalTransitions(transitions)
        self.reachable_states = int(reachable_states)
        self._letter_index = {letter: i
                              for i, letter in enumerate(self.alphabet)}

    @property
    def classes(self):
        return self.outputs.region.count

    def step(self, state, letter):
        """Advance one letter from a quotient-state index."""
        try:
            column = self._letter_index[letter]
        except KeyError:
            raise ValueError('letter is outside the compiled alphabet: %r'
                             % (letter,))
        if not 0 <= state < self.classes:
            raise ValueError('state is outside the quotient: %r' % (state,))
        return self.transitions.at(state, column)

    def out(self, state):
        """Read the observable attached to a quotient-state index."""
        if not 0 <= state < self.classes:
            raise ValueError('state is outside the quotient: %r' % (state,))
        return self.outputs.at(state)

    def run(self, letters, state=None):
        """Check a left fold inside the build-side quotient witness."""
        at = self.initial if state is None else state
        for letter in letters:
            at = self.step(at, letter)
        return at, self.out(at)

    def direct_byte_projection(self):
        """Return the exact last-byte projection, or ``None`` if not proved.

        This checks the completed quotient, not samples: the alphabet must be
        all bytes, all 256 classes must be reached by one byte, and every class
        must have that same successor row. Only then may a byte replace a
        general state identity or a hash key.
        """
        if self.alphabet != tuple(range(256)) or self.classes != 256:
            return None
        state_by_byte = tuple(
            self.transitions.at(self.initial, byte) for byte in range(256))
        if len(set(state_by_byte)) != 256:
            return None
        for state in range(self.classes):
            if any(self.transitions.at(state, byte) != state_by_byte[byte]
                   for byte in range(256)):
                return None
        return DirectByteProjection(self.initial, state_by_byte)

    def to_dict(self):
        result = {
            'reachable_states': self.reachable_states,
            'classes': self.classes,
            'alphabet_size': len(self.alphabet),
            'initial': self.initial,
            'build_form': {
                'outputs': self.outputs.to_dict(),
                'transitions': self.transitions.to_dict(),
                'storage_cells': (self.outputs.storage_cells
                                  + self.transitions.storage_cells),
            },
        }
        projection = self.direct_byte_projection()
        if projection is not None:
            result['direct_byte_cache'] = projection.cache(
                self.outputs.at(state) for state in range(self.classes)
            ).to_dict()
        return result

    def semantic_key(self):
        """Canonical complete-future key rooted at the initial class.

        Quotient class numbers are build-local. Renumbering them by a breadth
        first walk from the initial class makes independently built equivalent
        machines compare byte-for-byte without retaining their concrete VM
        states.
        """
        canonical = {self.initial: 0}
        pending = [self.initial]
        outputs = []
        transitions = []
        at = 0
        while at < len(pending):
            state = pending[at]
            at += 1
            outputs.append(self.out(state))
            row = []
            for column in range(len(self.alphabet)):
                target = self.transitions.at(state, column)
                if target not in canonical:
                    canonical[target] = len(canonical)
                    pending.append(target)
                row.append(canonical[target])
            transitions.append(tuple(row))
        return (tuple(self.alphabet), tuple(outputs), tuple(transitions))


def compile_transducer(initial, delta, observe, alphabet, key=None,
                       max_states=4096):
    """Close and minimize one deterministic transducer exactly.

    ``key`` maps runtime states to stable, hashable identities. It may discard
    representation detail only when equal keys denote equal future behavior;
    the default requires the states themselves to be hashable.
    """
    if max_states < 1:
        raise ValueError('max_states must be positive')
    alphabet = tuple(alphabet)
    if len(set(alphabet)) != len(alphabet):
        raise ValueError('alphabet entries must be unique')
    key = key or (lambda state: state)

    states = [initial]
    identities = {key(initial): 0}
    transitions = []
    outputs = []
    at = 0
    while at < len(states):
        state = states[at]
        outputs.append(observe(state))
        row = []
        for letter in alphabet:
            after = delta(state, letter)
            identity = key(after)
            target = identities.get(identity)
            if target is None:
                if len(states) >= max_states:
                    raise StateLimit(max_states)
                target = len(states)
                identities[identity] = target
                states.append(after)
            row.append(target)
        transitions.append(tuple(row))
        at += 1

    classes = _initial_classes(outputs)
    while True:
        refined = _refine(outputs, transitions, classes)
        if refined == classes:
            break
        classes = refined

    count = max(classes) + 1
    representatives = [None] * count
    for state, cls in enumerate(classes):
        if representatives[cls] is None:
            representatives[cls] = state

    quotient_outputs = []
    quotient_transitions = []
    for representative in representatives:
        quotient_outputs.append(outputs[representative])
        quotient_transitions.append(tuple(
            classes[target] for target in transitions[representative]))

    return QuotientMachine(
        alphabet=alphabet,
        initial=classes[0],
        outputs=quotient_outputs,
        transitions=quotient_transitions,
        reachable_states=len(states),
    )


def _initial_classes(outputs):
    numbers = {}
    classes = []
    for output in outputs:
        if output not in numbers:
            numbers[output] = len(numbers)
        classes.append(numbers[output])
    return tuple(classes)


def _refine(outputs, transitions, classes):
    numbers = {}
    refined = []
    for state, output in enumerate(outputs):
        signature = (output,
                     tuple(classes[target]
                           for target in transitions[state]))
        if signature not in numbers:
            numbers[signature] = len(numbers)
        refined.append(numbers[signature])
    return tuple(refined)
