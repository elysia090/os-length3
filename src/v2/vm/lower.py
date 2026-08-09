"""Normalize a lowered QM sequence into one canonical rSUBLEQ artifact.

C, an x86-64 listing and a wasm32 listing all reach `qm.isa.Seq`, so this is
the one place any of the three becomes a program in the sense the codec means:
`pack(code(z))` over a canonical signed image. Run then means running *that*,
not interpreting a target-specific structure in whatever language built it.

Bit-structural sequences use one cell per bit. A shift, deposit, extract, byte
swap, and carry-less multiply by a constant can then be rewiring rather than
runtime work. Closed integer-affine islands instead use the machine's native
whole-word subtraction. Both are exact candidates; the complete framed
artifacts compete under measured row-wave span, work, and code length.

Depends on `asm` and `image`, and on `qm.isa` only for the shape of the
sequence it is handed.
"""

from . import planner
from .asm import Asm
from .framing import frame_function, frame_word_function
from .word import WordAffineLowering, extract_affine, is_candidate

WORD = 64
M64_ALL = (1 << WORD) - 1


class Unsupported(Exception):
    """An instruction with no bit-sliced form here yet."""


# ---------------------------------------------------------------------------
# Bits
#
# A bit is (cell, invert) with cell None meaning a constant. Constants and
# complements are compile-time facts, so the code that comes out contains
# neither.
# ---------------------------------------------------------------------------

ZERO = (None, False)
ONE_BIT = (None, True)


def is_const(bit):
    return bit[0] is None


def const_value(bit):
    return 1 if bit[1] else 0


def invert(bit):
    return (bit[0], not bit[1])


def word_of_const(value):
    return [(None, bool((value >> i) & 1)) for i in range(WORD)]


class BitVectorLowering(object):
    """Compile fixed-width values as vectors of one-bit cells.

    Structural bit operations only rearrange cell references. Gates and carry
    chains emit instructions. Other value representations can be added beside
    this class without changing the byte-stream machine.
    """

    def __init__(self, input_bits, output_bits):
        self.input_bits = input_bits
        self.output_bits = output_bits
        self.word_bits = WORD
        self.in_bytes = -(-input_bits // 8)
        self.out_bytes = -(-output_bits // 8)

        self.a = Asm()
        self.one = self.a.cell('one', 1)
        self.pow2 = [self.a.cell('p%d' % i, 1 << i) for i in range(8)]
        self._temp = 0
        self._materialized = {}

    # -- helpers ----------------------------------------------------------

    def temp(self, hint='t'):
        self._temp += 1
        return self.a.cell('%s%d' % (hint, self._temp))

    def materialize(self, bit):
        """A cell holding this bit's value, 0 or 1.

        Constants and complements are free to *carry*; they cost only when a
        gate actually needs the value in a cell, and each one is built once.
        """
        if is_const(bit):
            key = ('const', const_value(bit))
            if key not in self._materialized:
                out = self.temp('k')
                if const_value(bit):
                    self.a.move(self.one, out)
                self._materialized[key] = out
            return self._materialized[key]
        cell, inverted = bit
        if not inverted:
            return cell
        key = ('not', id(cell))
        if key not in self._materialized:
            out = self.temp('n')
            self.a.move(self.one, out)
            self.a.sub(cell, out)                  # out = 1 - cell
            self._materialized[key] = out
        return self._materialized[key]

    # -- gates ------------------------------------------------------------

    def gate_and(self, x, y):
        if is_const(x):
            return y if const_value(x) else ZERO
        if is_const(y):
            return x if const_value(y) else ZERO
        a, b = self.materialize(x), self.materialize(y)
        out = self.temp('and')
        zero = self.a.label('and_zero')
        done = self.a.label('and_done')
        # a + b - 1 is 1 exactly when both are set, and -1 or 0 otherwise, so
        # the answer is already in `out` on the path that does not branch.
        self.a.move(a, out)
        self.a.add(b, out)
        self.a.sub(self.one, out)
        self.a.if_le_zero(out, zero)
        self.a.goto(done)
        self.a.place(zero)
        self.a.clear(out)
        self.a.place(done)
        return (out, False)

    def gate_or(self, x, y):
        if is_const(x):
            return ONE_BIT if const_value(x) else y
        if is_const(y):
            return ONE_BIT if const_value(y) else x
        a, b = self.materialize(x), self.materialize(y)
        out = self.temp('or')
        done = self.a.label('or_done')
        self.a.move(a, out)
        self.a.add(b, out)                          # 0, 1 or 2
        self.a.if_le_zero(out, done)                # already 0
        self.a.move(self.one, out)                  # 1 or 2 -> 1
        self.a.place(done)
        return (out, False)

    def gate_xor(self, x, y):
        if is_const(x):
            return invert(y) if const_value(x) else y
        if is_const(y):
            return invert(x) if const_value(y) else x
        a, b = self.materialize(x), self.materialize(y)
        acc = self.temp('x')
        out = self.temp('xr')
        one_of = self.a.label('xor_one')
        zero_of = self.a.label('xor_zero')
        done = self.a.label('xor_done')
        # a + b - 1 is 0 exactly when exactly one of them is 1.
        self.a.move(a, acc)
        self.a.add(b, acc)
        self.a.sub(self.one, acc)                   # -1, 0 or 1
        self.a.if_le_zero(acc, one_of)              # -1 or 0
        self.a.goto(zero_of)                        # 1: both set
        self.a.place(one_of)
        self.a.add(self.one, acc)                   # 0 or 1
        self.a.if_le_zero(acc, zero_of)             # was -1: neither set
        self.a.move(self.one, out)
        self.a.goto(done)
        self.a.place(zero_of)
        self.a.clear(out)
        self.a.place(done)
        return (out, False)

    def _after(self, label):
        """Place `label` here and hand back a target meaning 'carry on'."""
        self.a.place(label)
        return label

    # -- words ------------------------------------------------------------

    def word_and(self, x, y):
        return [self.gate_and(p, q) for p, q in zip(x, y)]

    def word_or(self, x, y):
        return [self.gate_or(p, q) for p, q in zip(x, y)]

    def word_xor(self, x, y):
        return [self.gate_xor(p, q) for p, q in zip(x, y)]

    def word_not(self, x):
        return [invert(b) for b in x]

    def shift_left(self, x, n):
        return [ZERO] * n + x[:WORD - n] if n < WORD else [ZERO] * WORD

    def shift_right(self, x, n):
        return x[n:] + [ZERO] * n if n < WORD else [ZERO] * WORD

    def shift_right_signed(self, x, n):
        """Arithmetic shift: the top bit is copied down, not zeroed.

        Rewiring, like every other shift here, so a comparison costs one
        subtraction and nothing at all for the mask it turns into.
        """
        if n >= WORD:
            return [x[WORD - 1]] * WORD
        return x[n:] + [x[WORD - 1]] * n

    def smear(self, x):
        """Fill every bit below the highest set one, by doubling."""
        shift = 1
        while shift < WORD:
            x = self.word_or(x, self.shift_right(x, shift))
            shift <<= 1
        return x

    def count_leading_zeros(self, x):
        """`clz(x) == popcount(~smear(x))` — the leading zeros are what is left
        once every bit below the top one has been filled in."""
        return self.popcount(self.word_not(self.smear(x)))

    def count_trailing_zeros(self, x):
        """`ctz(x) == popcount((x & -x) - 1)`, which answers 64 for zero
        because the borrow runs the whole width."""
        low = self.word_and(x, self.negate(x))
        return self.popcount(self.add_words(low, word_of_const(M64_ALL)))

    def less_unsigned(self, x, y, width=WORD):
        """One bit: is `x` below `y`, both read as unsigned `width`-bit words."""
        borrow = ZERO
        for i in range(width):
            a, b = x[i], y[i]
            borrow = self.gate_or(
                self.gate_and(invert(a), b),
                self.gate_and(invert(self.gate_xor(a, b)), borrow))
        return borrow

    def select_word(self, condition, when_true, when_false):
        """Blend two words under one bit, position by position."""
        return [self.gate_or(self.gate_and(condition, t),
                             self.gate_and(invert(condition), f))
                for t, f in zip(when_true, when_false)]

    def deposit(self, x, mask):
        """PDEP: the j-th set bit of the mask takes the j-th bit of x."""
        out = [ZERO] * WORD
        source = 0
        for position in range(WORD):
            if (mask >> position) & 1:
                if source < WORD:
                    out[position] = x[source]
                source += 1
        return out

    def extract(self, x, mask):
        """PEXT: the bits under the mask, packed down."""
        out = [ZERO] * WORD
        target = 0
        for position in range(WORD):
            if (mask >> position) & 1:
                out[target] = x[position]
                target += 1
        return out

    def byteswap(self, x):
        out = [ZERO] * WORD
        for byte in range(8):
            for bit in range(8):
                out[(7 - byte) * 8 + bit] = x[byte * 8 + bit]
        return out

    def clmul(self, x, const):
        """Carry-less multiply by a constant: XOR of the shifts it names."""
        out = [ZERO] * WORD
        for position in range(WORD):
            if (const >> position) & 1:
                out = self.word_xor(out, self.shift_left(x, position))
        return out

    def _advance(self, selector, mask_bit):
        """Move the one-hot rank cursor on when this mask bit is set.

        `selector` marks how many mask bits have been seen so far, one-hot. A
        dynamic gather is a rank computation, and this is the rank: the cursor
        steps exactly on the set bits. Positions the cursor cannot have reached
        yet are still constants, so the gates for them fold away and the cost
        grows with the walk rather than as 64 squared.
        """
        moved = self.shift_left(selector, 1)
        return [self.gate_or(self.gate_and(mask_bit, ahead),
                             self.gate_and(invert(mask_bit), here))
                for ahead, here in zip(moved, selector)]

    def extract_dynamic(self, const, mask):
        """PEXT_DYN: `pext(K, v)` — constant source, dynamic mask.

        Output bit r is the bit of K under the r-th set bit of the mask, so
        walking the mask with a rank cursor and OR-ing the cursor in wherever K
        is set says exactly that, without any indirection.
        """
        selector = [ONE_BIT] + [ZERO] * (WORD - 1)
        out = [ZERO] * WORD
        for position in range(WORD):
            bit = mask[position]
            if (const >> position) & 1:
                out = self.word_or(out, [self.gate_and(s, bit)
                                         for s in selector])
            selector = self._advance(selector, bit)
        return out

    def deposit_dynamic(self, const, mask):
        """PDEP_DYN: `pdep(K, v)` — the same walk, read the other way."""
        selector = [ONE_BIT] + [ZERO] * (WORD - 1)
        out = [ZERO] * WORD
        for position in range(WORD):
            bit = mask[position]
            picked = ZERO
            for source in range(WORD):
                if (const >> source) & 1:
                    picked = self.gate_or(picked, selector[source])
            out[position] = self.gate_and(bit, picked)
            selector = self._advance(selector, bit)
        return out

    def add_words(self, x, y):
        """Ripple-carry add, modulo 2^64. The carry out simply goes nowhere."""
        out = []
        carry = ZERO
        for i in range(WORD):
            axb = self.gate_xor(x[i], y[i])
            out.append(self.gate_xor(axb, carry))
            carry = self.gate_or(self.gate_and(x[i], y[i]),
                                 self.gate_and(axb, carry))
        return out

    def negate(self, x):
        """Two's complement, so subtraction is one adder and not a second one."""
        return self.add_words(self.word_not(x), word_of_const(1))

    def multiply(self, x, const):
        """Multiply by a constant: the shifted copies its set bits name."""
        out = word_of_const(0)
        for position in range(WORD):
            if (const >> position) & 1:
                out = self.add_words(out, self.shift_left(x, position))
        return out

    def popcount(self, x):
        total = word_of_const(0)
        for bit in x:
            if is_const(bit) and not const_value(bit):
                continue
            total = self.add_words(total, [bit] + [ZERO] * (WORD - 1))
        return total

    def lookup(self, x, values):
        """Select a constant word with a balanced tree of bit multiplexers."""
        index_bits = (len(values) - 1).bit_length() if values else 0
        if not values or len(values) != 1 << index_bits:
            raise Unsupported('LUT size must be a nonzero power of two')

        choices = [word_of_const(value) for value in values]
        for bit in range(index_bits):
            choices = [self.select_word(x[bit], choices[i + 1], choices[i])
                       for i in range(0, len(choices), 2)]
        return choices[0]

    def _lane_cell(self, bits):
        """Materialize one byte coordinate and return `(cell, upper_bound)`."""
        terms = []
        constant = 0
        for position, bit in enumerate(bits):
            weight = 1 << position
            if is_const(bit):
                if const_value(bit):
                    constant += weight
                continue
            source = self.materialize(bit)
            if weight != 1:
                scaled = self.temp('lane_bit')
                after = self.a.label('lane_bit_done')
                self.a.if_le_zero(source, after)
                self.a.move(self.pow2[position], scaled)
                self.a.place(after)
                source = scaled
            terms.append((source, weight))

        if not terms:
            self._temp += 1
            return self.a.cell('lane_const%d' % self._temp, constant), constant
        if len(terms) == 1 and constant == 0:
            return terms[0][0], terms[0][1]

        out = self.temp('lane')
        if constant:
            self._temp += 1
            base = self.a.cell('lane_base%d' % self._temp, constant)
            self.a.add(base, out)
        for source, _bound in terms:
            self.a.add(source, out)
        return out, constant + sum(bound for _source, bound in terms)

    def _small_scale(self, source, factor):
        """Multiply one byte-sized cell by a small constant without carries."""
        if factor == 1:
            return source
        shifted = self.temp('lane_shift')
        self.a.move(source, shifted)
        out = self.temp('lane_product')
        initialized = False
        for position in range(factor.bit_length()):
            if (factor >> position) & 1:
                if not initialized:
                    self.a.move(shifted, out)
                    initialized = True
                else:
                    self.a.add(shifted, out)
            if position + 1 < factor.bit_length():
                self.a.add(shifted, shifted)
        return out

    def multiply_to_bytes(self, x, const, output_bits):
        """Direct base-256 convolution when every lane is carry-free.

        This is coordinate substitution, not a second multiply algorithm. The
        source bit vector is first viewed as eight byte coordinates. Constant
        multiplication becomes a triangular convolution of those coordinates.
        If any output coordinate can exceed 255, the form is rejected before
        code is emitted and the ordinary bit-vector multiply remains in use.
        """
        if output_bits != WORD:
            return None
        lane_bits = [x[start:start + 8] for start in range(0, WORD, 8)]
        bounds = []
        # Bounds are structural and can be checked before materialization.
        for bits in lane_bits:
            bound = 0
            for position, bit in enumerate(bits):
                if not is_const(bit) or const_value(bit):
                    bound += 1 << position
            bounds.append(bound)

        coefficients = [(const >> (8 * lane)) & 0xFF for lane in range(8)]
        for output in range(8):
            bound = sum(bounds[source] * coefficients[output - source]
                        for source in range(output + 1))
            if bound > 0xFF:
                return None

        lanes = [self._lane_cell(bits) for bits in lane_bits]
        scaled = {}
        outputs = []
        for output in range(8):
            terms = []
            for source in range(output + 1):
                coefficient = coefficients[output - source]
                if coefficient == 0 or lanes[source][1] == 0:
                    continue
                key = source, coefficient
                if key not in scaled:
                    scaled[key] = self._small_scale(lanes[source][0],
                                                    coefficient)
                terms.append(scaled[key])
            if not terms:
                outputs.append(self.materialize(ZERO))
            elif len(terms) == 1:
                outputs.append(terms[0])
            else:
                value = self.temp('lane_sum')
                for term in terms:
                    self.a.add(term, value)
                outputs.append(value)
        return outputs

    # -- one instruction --------------------------------------------------

    def apply(self, op, args, const, shift):
        one = args[0] if args else None
        two = args[1] if len(args) > 1 else None
        if op == 'AND':
            return self.word_and(one, word_of_const(const))
        if op == 'OR':
            return self.word_or(one, word_of_const(const))
        if op == 'XOR':
            return self.word_xor(one, word_of_const(const))
        if op == 'NOT':
            return self.word_not(one)
        if op == 'SHL':
            return self.shift_left(one, shift)
        if op == 'SHR':
            return self.shift_right(one, shift)
        if op == 'ANDR':
            return self.word_and(one, two)
        if op == 'ORR':
            return self.word_or(one, two)
        if op == 'XORR':
            return self.word_xor(one, two)
        if op == 'ANDNR':
            return self.word_and(self.word_not(one), two)
        if op == 'ADDR':
            return self.add_words(one, two)
        if op == 'ADD':
            return self.add_words(one, word_of_const(const))
        if op == 'SUB':
            return self.add_words(one, self.negate(word_of_const(const)))
        if op == 'PDEP':
            return self.deposit(one, const)
        if op == 'PEXT':
            return self.extract(one, const)
        if op == 'BSWAP':
            return self.byteswap(one)
        if op == 'SCANXOR':
            return self.word_xor(one, self.shift_left(one, shift))
        if op == 'CLMUL':
            return self.clmul(one, const)
        if op == 'IMUL':
            return self.multiply(one, const)
        if op in ('PEXT_DYN', 'LOOP8'):
            return self.extract_dynamic(const, one)
        if op == 'PDEP_DYN':
            return self.deposit_dynamic(const, one)
        if op == 'POPCNT':
            return self.popcount(one)
        if op == 'SAR':
            return self.shift_right_signed(one, shift)
        if op == 'NEG':
            return self.negate(one)
        if op == 'SUBR':
            return self.add_words(one, self.negate(two))
        if op == 'CLZ':
            return self.count_leading_zeros(one)
        if op == 'CTZ':
            return self.count_trailing_zeros(one)
        if op == 'LUT':
            return self.lookup(one, const)
        raise Unsupported('no bit-sliced form for %s' % op)


def _lower_bit_seq(seq, input_bits, output_bits):
    """The exact bit-vector representative for one minimized sequence."""
    low = BitVectorLowering(input_bits, output_bits)

    def compute(word):
        values = {0: word}
        for position, instruction in enumerate(seq.ins, start=1):
            args = [values[k] for k in instruction.args]
            if position == seq.result and instruction.op == 'IMUL':
                byte_cells = low.multiply_to_bytes(
                    args[0], instruction.const, output_bits)
                if byte_cells is not None:
                    return 'bytes', byte_cells
            values[position] = low.apply(instruction.op, args,
                                         instruction.const, instruction.shift)
        return values[seq.result]

    return frame_function(low, compute, input_bits, output_bits, ZERO)


def _lower_word_seq(seq, input_bits, output_bits):
    """The exact whole-word representative for an integer-affine island."""
    form = extract_affine(seq)
    if form is None:
        raise Unsupported('sequence is not integer-affine')
    low = WordAffineLowering(input_bits, output_bits)

    def compute(word):
        byte_cells = low.emit_affine_bytes(word, *form)
        if byte_cells is not None:
            return 'bytes', byte_cells
        return 'word', low.emit_affine(word, *form)

    return frame_word_function(
        low, compute, input_bits, output_bits)


_SELECTION = {}


def _sequence_key(seq, input_bits, output_bits):
    return (input_bits, output_bits, seq.result,
            tuple((instruction.op, instruction.args, instruction.const,
                   instruction.shift) for instruction in seq.ins))


def lower_seq(seq, input_bits, output_bits):
    """Compile a minimized wasm32 instruction sequence for the byte interface.

    The framing is the one a function has under a byte stream: feed the input
    little-endian, then read the output a byte at a time, one feed apart.

        feed(x0) .. feed(x_{n-1})   the input word
        read()                      output byte 0
        feed(anything); read()      output byte 1, and so on

    `read` never commits, so reading the same byte twice gives the same byte
    twice; only a feed moves the stream on.

    The browser always supplies the wasm32 target selected by QM. This compiler
    does not accept the abstract solver program or choose an instruction set.
    """
    if not is_candidate(seq, output_bits):
        return _lower_bit_seq(seq, input_bits, output_bits)

    key = _sequence_key(seq, input_bits, output_bits)
    selected = _SELECTION.get(key)
    if selected == 'word':
        return _lower_word_seq(seq, input_bits, output_bits)
    if selected == 'bits':
        return _lower_bit_seq(seq, input_bits, output_bits)

    candidates = [
        ('bits', _lower_bit_seq(seq, input_bits, output_bits)),
        ('word', _lower_word_seq(seq, input_bits, output_bits)),
    ]
    selected, picture = planner.choose(candidates, input_bits, output_bits)
    _SELECTION[key] = selected
    return picture


# Compatibility for the existing measurement tool.
Lowering = BitVectorLowering
