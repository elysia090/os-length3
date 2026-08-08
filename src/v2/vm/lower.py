"""Normalize a lowered QM sequence into one canonical rSUBLEQ artifact.

C, an x86-64 listing and a wasm32 listing all reach `qm.isa.Seq`, so this is
the one place any of the three becomes a program in the sense the codec means:
`pack(code(z))` over a canonical signed image. Run then means running *that*,
not interpreting a target-specific structure in whatever language built it.

Values are bit-sliced: a 64-bit word is 64 one-bit cells. That is what makes
the normalization cheap where it can be, because a shift, a deposit, an
extract, a byte swap and a carry-less multiply by a constant are all
*rewiring* — they move bits to other positions and cost no instruction at all.
A bit also carries a complement flag, so NOT is free for the same reason. What
is left costing real code is the gates and the adders, which is exactly the
part that is genuinely computation.

Depends on `asm` and `image`, and on `qm.isa` only for the shape of the
sequence it is handed.
"""

from . import asm as _asm
from .asm import Asm, COMMIT, EMIT

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


class Lowering(object):
    """Builds one artifact for one `qm.isa.Seq`."""

    def __init__(self, input_bits, output_bits):
        self.input_bits = input_bits
        self.output_bits = output_bits
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
        raise Unsupported('no bit-sliced form for %s' % op)


    # -- one abstract operation -------------------------------------------
    #
    # The semantic classes, not an ISA's mnemonics. This is what makes the
    # artifact a property of the solve rather than of the target you happen to
    # be looking at: LIN_CONST is a linear map here, not a PDEP.

    def linear(self, x, basis, input_bits):
        """`y = XOR_i basis[i] * bit_i(x)` — an XOR tree, position by position."""
        out = [ZERO] * WORD
        for source in range(min(input_bits, len(basis))):
            image = basis[source]
            if not image:
                continue
            for position in range(WORD):
                if (image >> position) & 1:
                    out[position] = self.gate_xor(out[position], x[source])
        return out

    def lane_less(self, lane, bound, lane_bits):
        """Unsigned `lane < bound` for one lane, as a borrow chain."""
        borrow = ZERO
        for i in range(lane_bits):
            a = lane[i]
            b = ONE_BIT if (bound >> i) & 1 else ZERO
            # borrow' = (~a & b) | (~(a ^ b) & borrow)
            borrow = self.gate_or(
                self.gate_and(invert(a), b),
                self.gate_and(invert(self.gate_xor(a, b)), borrow))
        return borrow

    def lane_interval(self, x, bounds, lane_bits):
        """`lo <= lane <= hi` on every lane, as that lane's top bit."""
        lo, hi = bounds
        out = [ZERO] * WORD
        top = lane_bits - 1
        for index in range(WORD // lane_bits):
            base = index * lane_bits
            lane = x[base:base + lane_bits]
            below = self.lane_less(lane, lo, lane_bits) if lo else ZERO
            above = (self.lane_less(lane, hi + 1, lane_bits)
                     if hi + 1 < (1 << lane_bits) else ONE_BIT)
            out[base + top] = self.gate_and(invert(below), above)
        return out

    def apply_point(self, x, steps):
        for mnemonic, const, shift in steps:
            if mnemonic == 'AND':
                x = self.word_and(x, word_of_const(const))
            elif mnemonic == 'OR':
                x = self.word_or(x, word_of_const(const))
            elif mnemonic == 'XOR':
                x = self.word_xor(x, word_of_const(const))
            elif mnemonic == 'ADD':
                x = self.add_words(x, word_of_const(const))
            elif mnemonic == 'SUB':
                x = self.add_words(x, self.negate(word_of_const(const)))
            elif mnemonic == 'NOT':
                x = self.word_not(x)
            elif mnemonic == 'SHL':
                x = self.shift_left(x, shift)
            elif mnemonic == 'SHR':
                x = self.shift_right(x, shift)
            elif mnemonic == 'BSWAP':
                x = self.byteswap(x)
            elif mnemonic == 'POPCNT':
                x = self.popcount(x)
            elif mnemonic == 'ANDN_PREV_SHL':
                x = self.word_and(x, self.word_not(self.shift_left(x, shift)))
            elif mnemonic == 'ANDN_PREV_SHR':
                x = self.word_and(x, self.word_not(self.shift_right(x, shift)))
            elif mnemonic == 'XOR_SHL':
                x = self.word_xor(x, self.shift_left(x, shift))
            elif mnemonic == 'LANE_INTERVAL':
                x = self.lane_interval(x, const, shift)
            elif mnemonic == 'NEG':
                x = self.negate(x)
            elif mnemonic == 'AND_NEG':
                x = self.word_and(x, self.negate(x))
            elif mnemonic == 'AND_DEC':
                x = self.word_and(x, self.add_words(x, word_of_const(M64_ALL)))
            elif mnemonic == 'OR_SHR':
                x = self.word_or(x, self.shift_right(x, shift))
            elif mnemonic == 'SAR':
                x = self.shift_right_signed(x, shift)
            elif mnemonic == 'XOR_SAR':
                width = const or WORD
                sign = x[width - 1]
                folded = [(x[i + shift] if i + shift < width else sign)
                          for i in range(WORD)]
                x = self.word_xor(x, folded)
                x = [b if i < width else ZERO for i, b in enumerate(x)]
            elif mnemonic == 'KEY':
                x = self.key_word(x, const)
            elif mnemonic == 'SMEAR':
                x = self.smear(x)
            elif mnemonic == 'CLZ':
                width = const or WORD
                masked = [b if i < width else ZERO for i, b in enumerate(x)]
                x = self.add_words(self.count_leading_zeros(masked),
                                   word_of_const((width - WORD) & M64_ALL))
            elif mnemonic == 'CTZ':
                width = const or WORD
                masked = [b if i < width else ZERO for i, b in enumerate(x)]
                if width < WORD:
                    masked[width] = ONE_BIT
                x = self.count_trailing_zeros(masked)
            elif mnemonic in ('LANE_MAX', 'LANE_MIN'):
                x = self.lane_reduce(x, shift, mnemonic == 'LANE_MAX')
            else:
                raise Unsupported('no bit-sliced form for POINT step %s'
                                  % mnemonic)
        return x

    def lane_reduce(self, x, lane_bits, want_max):
        """Maximum or minimum over the lanes, in the low lane.

        The same halving tournament the ISA lowering runs, except that here a
        comparison is a borrow chain and choosing a winner is a multiplexer, so
        neither one needs the lane masks to keep it inside its lane.
        """
        lanes = WORD // lane_bits
        values = [x[i * lane_bits:(i + 1) * lane_bits] for i in range(lanes)]
        while len(values) > 1:
            nxt = []
            for k in range(0, len(values), 2):
                if k + 1 == len(values):
                    nxt.append(values[k])
                    continue
                a, b = values[k], values[k + 1]
                below = self.less_unsigned(a + [ZERO] * (WORD - lane_bits),
                                           b + [ZERO] * (WORD - lane_bits),
                                           lane_bits)
                pick_b = below if want_max else invert(below)
                nxt.append(self.select_word(pick_b, b, a))
            values = nxt
        return values[0] + [ZERO] * (WORD - lane_bits)

    def key_word(self, x, key):
        """The SPLIT key as one two's-complement word."""
        total = None
        for shift, width, signed, coeff in key.terms:
            fill = x[shift + width - 1] if signed else ZERO
            term = [(x[shift + i] if i < width else fill) for i in range(WORD)]
            if coeff < 0:
                term = self.negate(term)
            total = term if total is None else self.add_words(total, term)
        return total

    def apply_split(self, x, detail):
        key = self.key_word(x, detail['key'])
        result = self.apply_program(x, detail['branches'][0])
        for threshold, branch in zip(detail['breaks'], detail['branches'][1:]):
            alternative = self.apply_program(x, branch)
            below = self.add_words(
                key, self.negate(word_of_const(threshold & M64_ALL)))[WORD - 1]
            result = self.select_word(below, result, alternative)
        return result

    def apply_program(self, x, program):
        for op in program.ops:
            x = self.apply_op(x, op)
        return x

    def apply_op(self, x, op):
        kind, detail = op.kind, op.detail
        if kind == 'IDENTITY':
            return x
        if kind == 'LIN_CONST':
            return self.linear(x, detail['basis'], detail['input_bits'])
        if kind == 'CONV':
            if detail['family'] == 'IMUL':
                return self.multiply(x, detail['const'])
            if detail['family'] == 'CLMUL':
                return self.clmul(x, detail['const'])
            raise Unsupported('no bit-sliced form for CONV(%s)'
                              % detail['family'])
        if kind == 'POINT':
            return self.apply_point(x, detail['steps'])
        if kind == 'PERM_DYN':
            if detail['direction'] == 'gather':
                return self.extract_dynamic(detail['source'], x)
            return self.deposit_dynamic(detail['source'], x)
        if kind == 'SPLIT':
            return self.apply_split(x, detail)
        raise Unsupported('no bit-sliced form for %s' % kind)


def _decode_byte(low, source, bits, one, pow2):
    """Split a byte in `source` into eight one-bit cells, high bit first."""
    scratch = low.temp('d')
    probe = low.temp('q')
    low.a.move(source, scratch)
    for index in range(7, -1, -1):
        set_here = low.a.label('set%d' % index)
        after = low.a.label('after%d' % index)
        low.a.move(pow2[index], probe)
        low.a.sub(scratch, probe)              # 2^i - value <= 0 iff bit is set
        low.a.if_le_zero(probe, set_here)
        low.a.clear(bits[index])
        low.a.goto(after)
        low.a.place(set_here)
        low.a.move(one, bits[index])
        low.a.sub(pow2[index], scratch)
        low.a.place(after)


def _encode_byte(low, bits, target, pow2):
    """Recombine eight one-bit cells into a byte."""
    low.a.clear(target)
    for index in range(8):
        after = low.a.label('skip%d' % index)
        low.a.if_le_zero(bits[index], after)
        low.a.add(pow2[index], target)
        low.a.place(after)


def _frame(low, compute, input_bits, output_bits):
    """The byte ABI around whatever `compute` makes of the input word.

    The framing is the one a function has under a byte stream: feed the input
    little-endian, then read the output a byte at a time, one feed apart.

        feed(x0) .. feed(x_{n-1})   the input word
        read()                      output byte 0
        feed(anything); read()      output byte 1, and so on

    `read` never commits, so reading the same byte twice gives the same byte
    twice; only a feed moves the stream on.
    """
    a = low.a

    in_bits = [a.cell('in%d' % i) for i in range(low.in_bytes * 8)]
    out_bytes = [a.cell('ob%d' % i) for i in range(low.out_bytes)]
    counter = a.cell('counter')
    index = a.cell('index')

    entry_out = a.label('read')
    entry_feed = a.label('feed')
    run_kernel = a.label('kernel')

    # -- read: emit the byte the stream is on ------------------------------
    #
    # `index - which <= 0` fires for the first `which` the index has reached,
    # and every smaller one has already branched away, so a chain of these is
    # an exact dispatch without any indirection.
    a.place(entry_out)
    probe = low.temp('r')
    emit_at = [a.label('emit%d' % i) for i in range(low.out_bytes)]
    skip_emit = [a.label('no_emit%d' % i) for i in range(low.out_bytes)]
    for which in range(low.out_bytes):
        a.move(index, probe)
        for _ in range(which):
            a.sub(low.one, probe)
        a.if_le_zero(probe, emit_at[which])
        a.goto(skip_emit[which])
        a.place(emit_at[which])
        a.move(out_bytes[which], Asm.OUTPUT)
        a.halt(EMIT)
        a.place(skip_emit[which])
    # Past the last output byte there is nothing left to emit.
    a.halt(_asm.FAIL)

    # -- feed --------------------------------------------------------------
    a.place(entry_feed)
    probe2 = low.temp('f')
    take_at = [a.label('take%d' % i) for i in range(low.in_bytes)]
    skip_take = [a.label('skip_take%d' % i) for i in range(low.in_bytes)]
    for which in range(low.in_bytes):
        a.move(counter, probe2)
        for _ in range(which):
            a.sub(low.one, probe2)
        a.if_le_zero(probe2, take_at[which])
        a.goto(skip_take[which])
        a.place(take_at[which])
        _decode_byte(low, Asm.INPUT, in_bits[which * 8:which * 8 + 8],
                     low.one, low.pow2)
        a.add(low.one, counter)
        if which == low.in_bytes - 1:
            a.goto(run_kernel)
        else:
            a.halt(COMMIT)
        a.place(skip_take[which])
    # Past the input, a feed advances the output stream by one byte.
    a.add(low.one, index)
    a.halt(COMMIT)

    # -- the kernel --------------------------------------------------------
    a.place(run_kernel)
    word = [(in_bits[i], False) if i < input_bits else ZERO
            for i in range(WORD)]
    result = compute(word)
    result = [b if i < output_bits else ZERO for i, b in enumerate(result)]

    for which in range(low.out_bytes):
        cells = [low.materialize(result[which * 8 + bit]) for bit in range(8)]
        _encode_byte(low, cells, out_bytes[which], low.pow2)
    a.halt(COMMIT)

    return low.a.build(entry_out, entry_feed)


def lower_program(program, input_bits, output_bits):
    """`qm.program.Program` -> a canonical image with the byte ABI.

    This is the one that makes the artifact a single source of truth: the
    abstract program is what the solve produced, and it is the same whichever
    target you happen to be looking at. Lowering from a target's `Seq` would
    make "the program" depend on a view of it.
    """
    low = Lowering(input_bits, output_bits)

    def compute(word):
        value = word
        for op in program.ops:
            value = low.apply_op(value, op)
        return value

    return _frame(low, compute, input_bits, output_bits)


def lower_seq(seq, input_bits, output_bits):
    """`qm.isa.Seq` -> a canonical image with the byte ABI.

    The framing is the one a function has under a byte stream: feed the input
    little-endian, then read the output a byte at a time, one feed apart.

        feed(x0) .. feed(x_{n-1})   the input word
        read()                      output byte 0
        feed(anything); read()      output byte 1, and so on

    `read` never commits, so reading the same byte twice gives the same byte
    twice; only a feed moves the stream on.

    Kept for the machine-level round trip; `lower_program` is what the artifact
    is built from.
    """
    low = Lowering(input_bits, output_bits)

    def compute(word):
        values = {0: word}
        for position, instruction in enumerate(seq.ins, start=1):
            args = [values[k] for k in instruction.args]
            values[position] = low.apply(instruction.op, args,
                                         instruction.const, instruction.shift)
        return values[seq.result]

    return _frame(low, compute, input_bits, output_bits)
