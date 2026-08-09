"""Whole-word lowering for closed integer-affine instruction islands.

The bytecode machine already subtracts signed integers. Rebuilding an affine
word expression from Boolean gates therefore throws away the machine's native
operation. This module recognizes one deliberately closed form,

    y = scale * x + offset  (mod 2^64),

directly from the minimized wasm32 SSA sequence and emits it with whole-word
SUBLEQ cells. Any dependency outside the affine algebra rejects the candidate;
there is no sampled recognition and no partial fallback inside this form.
"""

from .asm import Asm

WORD = 64
LIMIT = 1 << WORD
M64 = LIMIT - 1

AFFINE_OPS = frozenset(('IMUL', 'SHL', 'ADD', 'SUB', 'NEG', 'ADDR', 'SUBR'))
WORD_WORK = frozenset(('IMUL', 'ADD', 'SUB', 'NEG', 'ADDR', 'SUBR'))


class _LazyPowers(object):
    """Allocate only powers the selected framing actually reads."""

    def __init__(self, assembler):
        self.assembler = assembler
        self.cells = {}

    def __getitem__(self, bit):
        if not 0 <= bit < WORD:
            raise IndexError(bit)
        if bit not in self.cells:
            self.cells[bit] = self.assembler.cell('p%d' % bit, 1 << bit)
        return self.cells[bit]


def extract_affine(seq):
    """Return the exact final `(scale, offset)`, or ``None``.

    Each SSA value is mapped to its two coefficients. Only the requested
    result is returned, so the VM compiler receives one expression rather than
    a chain of substituted intermediates.
    """
    forms = [(1, 0)]
    for instruction in seq.ins:
        args = [forms[index] for index in instruction.args]
        if any(form is None for form in args):
            forms.append(None)
            continue

        op = instruction.op
        if op == 'IMUL':
            scale, offset = args[0]
            value = (scale * instruction.const,
                     offset * instruction.const)
        elif op == 'SHL':
            scale, offset = args[0]
            factor = 1 << instruction.shift
            value = scale * factor, offset * factor
        elif op == 'ADD':
            scale, offset = args[0]
            value = scale, offset + instruction.const
        elif op == 'SUB':
            scale, offset = args[0]
            value = scale, offset - instruction.const
        elif op == 'NEG':
            scale, offset = args[0]
            value = -scale, -offset
        elif op in ('ADDR', 'SUBR'):
            left, right = args
            sign = 1 if op == 'ADDR' else -1
            value = (left[0] + sign * right[0],
                     left[1] + sign * right[1])
        else:
            value = None
        forms.append(None if value is None
                     else (value[0] & M64, value[1] & M64))
    return forms[seq.result]


def is_candidate(seq, output_bits):
    """Whether whole-word lowering can replace real bit-level work."""
    return (output_bits == WORD
            and extract_affine(seq) is not None
            and any(instruction.op in WORD_WORK for instruction in seq.ins))


class WordAffineLowering(object):
    """Emit one extracted affine form with bounded whole-word cells."""

    def __init__(self, input_bits, output_bits):
        if output_bits != WORD:
            raise ValueError('whole-word lowering currently emits 64 bits')
        self.input_bits = input_bits
        self.output_bits = output_bits
        self.word_bits = WORD
        self.in_bytes = -(-input_bits // 8)
        self.out_bytes = -(-output_bits // 8)

        self.a = Asm()
        # Wide reduction constants are created only by paths that use them.
        # Carry-free byte forms such as repeat8 never need 2^64, and retaining
        # an unused out-of-i64 cell made an otherwise small artifact impossible
        # for the production wasm VM to open.
        self._modulus = None
        self._max_word = None
        self.one = self.a.cell('one', 1)
        self.pow2 = _LazyPowers(self.a)
        self._temp = 0

    @property
    def modulus(self):
        if self._modulus is None:
            self._modulus = self.a.cell('modulus', LIMIT)
        return self._modulus

    @property
    def max_word(self):
        if self._max_word is None:
            self._max_word = self.a.cell('max_word', M64)
        return self._max_word

    def temp(self, hint='w'):
        self._temp += 1
        return self.a.cell('%s%d' % (hint, self._temp))

    def _reduce_once(self, cell):
        """Reduce a nonnegative value no larger than `2 * (2^64 - 1)`."""
        probe = self.temp('mod')
        done = self.a.label('mod_done%d' % self._temp)
        self.a.move(cell, probe)
        self.a.sub(self.max_word, probe)
        self.a.if_le_zero(probe, done)
        self.a.sub(self.modulus, cell)
        self.a.place(done)

    def _add_bounded(self, source, target, source_bound, target_bound):
        self.a.add(source, target)
        bound = source_bound + target_bound
        if bound > M64:
            self._reduce_once(target)
            return M64
        return bound

    def _multiply_positive(self, source, coefficient, input_bound):
        """Constant shift/add multiplication, reducing only when required."""
        out = self.temp('product')
        if coefficient == 0:
            return out, 0

        shifted = self.temp('shifted')
        self.a.move(source, shifted)
        shifted_bound = input_bound
        out_bound = 0
        initialized = False
        top = coefficient.bit_length()

        for position in range(top):
            if (coefficient >> position) & 1:
                if not initialized:
                    self.a.move(shifted, out)
                    out_bound = shifted_bound
                    initialized = True
                else:
                    out_bound = self._add_bounded(
                        shifted, out, shifted_bound, out_bound)
            if position + 1 < top:
                shifted_bound = self._add_bounded(
                    shifted, shifted, shifted_bound, shifted_bound)
        return out, out_bound

    def _negate(self, source):
        """Return `-source mod 2^64` for a known word-sized source."""
        out = self.temp('negated')
        done = self.a.label('neg_done%d' % self._temp)
        self.a.if_le_zero(source, done)
        self.a.move(self.modulus, out)
        self.a.sub(source, out)
        self.a.place(done)
        return out

    def emit_affine(self, source, scale, offset):
        """Emit the extracted form and return its one result cell."""
        scale &= M64
        offset &= M64
        input_bound = (1 << self.input_bits) - 1

        negative = scale > (LIMIT >> 1)
        magnitude = LIMIT - scale if negative else scale
        result, bound = self._multiply_positive(
            source, magnitude, input_bound)
        if negative:
            result = self._negate(result)
            bound = M64

        if offset:
            constant = self.a.cell('offset', offset)
            bound = self._add_bounded(constant, result, offset, bound)
        return result

    def emit_affine_bytes(self, source, scale, offset):
        """Emit independent output-byte forms when carries are impossible.

        For one-byte input, write the coefficient and offset in base 256. If
        every lane stays within one byte for the complete input domain, no lane
        can carry into the next and each output byte is exactly

            coefficient_byte * x + offset_byte.

        The byte cells are then already the ABI representation; constructing a
        64-bit word only to decompose it again would be redundant work.
        """
        if self.input_bits != 8:
            return None
        scale &= M64
        offset &= M64
        maximum = (1 << self.input_bits) - 1
        forms = []
        for byte in range(self.out_bytes):
            coefficient = (scale >> (8 * byte)) & 0xFF
            constant = (offset >> (8 * byte)) & 0xFF
            if coefficient * maximum + constant > 0xFF:
                return None
            forms.append((coefficient, constant))

        emitted = {}
        out = []
        for coefficient, constant in forms:
            key = coefficient, constant
            if key in emitted:
                out.append(emitted[key])
                continue
            if coefficient == 0:
                value = self.a.cell('byte_const%d' % len(emitted), constant)
            elif coefficient == 1:
                value = source
                if constant:
                    value = self.temp('byte')
                    self.a.move(source, value)
                    addend = self.a.cell('byte_add%d' % len(emitted), constant)
                    self.a.add(addend, value)
            else:
                value, _bound = self._multiply_positive(
                    source, coefficient, maximum)
                if constant:
                    addend = self.a.cell('byte_add%d' % len(emitted), constant)
                    self.a.add(addend, value)
            emitted[key] = value
            out.append(value)
        return out
