"""The other direction: a canonical image back out as bytes, C, wasm32 or x86.

`lower.lower_program` turns a minimized program into one artifact. This turns
that artifact back into the forms it can be read in — so there is one program
and several views of it, rather than one program per language kept in step by
hand.

`emit_code` is not one of the views: it is the artifact, `pack(code(z))`, with
the fields §1 and §2 define named. Everything else here is what those bits
decode to.

What comes out is the machine and the image, not a decompilation. That is the
honest rendering: an rSUBLEQ program *is* a memory and one instruction, and
each of these can say so exactly. Each emitted language exposes the same kernel
signature, so it can be compiled and put straight against the artifact.

Depends on `codec` and `image`.
"""

from .codec import encode_scalar, pack
from .image import Image, serialize

# The three targets share one interpreter shape, so a change to the machine is
# a change in one place per language and nowhere else.  `codec` is not one of
# them: it is the artifact, and the other four are what it decodes to.
LANGUAGES = ('codec', 'listing', 'c', 'wat', 'x86')


def _extent(picture):
    """How many cells the dense form needs: past the last address, plus a step."""
    return (max(picture.memory) if picture.memory else 0) + 4


def _pairs(picture):
    return sorted(picture.memory.items())


def _framing(input_bits, output_bits):
    return -(-input_bits // 8), -(-output_bits // 8)


# ---------------------------------------------------------------------------
# The image itself
# ---------------------------------------------------------------------------

def emit_listing(picture, name='kernel', input_bits=8, output_bits=64):
    """The image as an rSUBLEQ listing: one line per instruction.

    This is not a rendering *of* the program, it is the program. Every cell the
    image holds appears once — the instruction stream in place, and the data
    cells that are not on it named as data — so the listing and the artifact
    are the same object written two ways.
    """
    memory = picture.memory
    entries = {picture.pc_out: 'read', picture.pc_feed: 'feed'}

    # Walk the instruction stream from the two entry points; anything not
    # reached that way is data, and is listed as such rather than guessed at.
    code = set()
    top = max(memory) if memory else 0
    for start in (picture.pc_out, picture.pc_feed):
        at = start
        while at <= top:
            code.update((at, at + 1, at + 2))
            at += 3

    lines = [
        ';; %s — %d live cells, read at %d, feed at %d.' % (
            name, len(memory), picture.pc_out, picture.pc_feed),
        ';; M[b] -= M[a]; branch to c when M[b] <= 0.'
        '  c = -1 EMIT, -2 COMMIT.',
        ';; qm-input-bits: %d' % input_bits,
        ';; qm-output-bits: %d' % output_bits,
        '',
    ]

    at = 0
    while at <= top:
        if at in code and at % 3 == picture.pc_out % 3:
            a, b, c = (memory.get(at, 0), memory.get(at + 1, 0),
                       memory.get(at + 2, 0))
            label = ('  ; %s' % entries[at]) if at in entries else ''
            target = {-1: 'EMIT', -2: 'COMMIT'}.get(c, str(c))
            lines.append('%6d:  subleq %d, %d, %s%s' % (at, a, b, target, label))
            at += 3
            continue
        if at in memory:
            lines.append('%6d:  .quad %d' % (at, memory[at]))
        at += 1

    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------------------
# The codeword
# ---------------------------------------------------------------------------

def emit_code(picture, name='kernel', input_bits=8, output_bits=64,
              listing=True):
    """`pack(code(z))` as bytes, with the fields §1 and §2 define named.

    This is the artifact. The listing above is a rendering of what these bits
    decode to; these bits are the thing itself — the one word whose length is
    `L(z)` and whose rank is the final tie-break of the objective — so a view
    called *codec* shows this and nothing else.

    The field table is the codeword parsed by its own grammar. Reading it is
    how you check that the prefix is self-delimiting without trusting the
    decoder: each length below is `2k+2` for the value beside it, and they sum
    to the payload the header announces.
    """
    payload = serialize(picture)
    header = encode_scalar(len(payload))
    blob = pack(header + payload)

    entries = sorted(picture.memory.items())
    at = len(encode_scalar(len(entries)))
    at += len(encode_scalar(picture.pc_out))
    at += len(encode_scalar(picture.pc_feed))

    fields = [
        ('E(|z|)', len(payload), 0, len(header)),
        ('E(k)', len(entries), len(header),
         len(encode_scalar(len(entries)))),
        ('E(pc_o)', picture.pc_out,
         len(header) + len(encode_scalar(len(entries))),
         len(encode_scalar(picture.pc_out))),
        ('E(pc_a)', picture.pc_feed,
         len(header) + at - len(encode_scalar(picture.pc_feed)),
         len(encode_scalar(picture.pc_feed))),
        ('(gap, zigzag) pairs', len(entries), len(header) + at,
         len(payload) - at),
    ]

    total = len(header) + len(payload)
    lines = [
        ';; %s — the artifact: pack(code(z)), %d bytes.' % (name, len(blob)),
        ';;',
        ';; 1  code(z) = E(|z|) || z                        L(z) = %d bits'
        % total,
        ';; 2  z = E(k) || E(pc_o) || E(pc_a) '
        '|| (E(gap) || E(zigzag(v)))^k',
        ';;',
        ';;      bit  field                     value      bits',
    ]
    for label, value, start, width in fields:
        lines.append(';;  %7d  %-20s %10d  %8d'
                     % (start, label, value, width))
    pad = (-total) % 8
    lines.append(';;  %7d  %-20s %10d  %8d' % (total, 'pad (all zero)', 0, pad))
    lines += [
        ';;',
        ';; qm-input-bits: %d' % input_bits,
        ';; qm-output-bits: %d' % output_bits,
        '',
    ]

    for start in range(0, len(blob), 16):
        chunk = blob[start:start + 16]
        lines.append('%08x  %s' % (start, ' '.join('%02x' % b for b in chunk)))

    if listing:
        lines += [
            '',
            ';; ---- what those bits decode to -------------------------',
            '',
            emit_listing(picture, name, input_bits, output_bits).rstrip('\n'),
        ]
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------------------
# C
# ---------------------------------------------------------------------------

C_TEMPLATE = '''\
/* %(name)s — emitted from the canonical image, not from a source language.
 *
 * An rSUBLEQ program is a memory and one instruction. This is that memory and
 * that instruction: %(cells)d live cells, %(extent)d addressable, entered at
 * %(pc_out)d to read and %(pc_feed)d to feed.
 *
 * The kernel framing is the byte stream the artifact declares: %(in_bytes)d
 * input byte(s) little-endian, then %(out_bytes)d output byte(s), one feed
 * apart. A read discards its writes; a feed keeps them only on COMMIT.
 */

#include <stdint.h>

#define QM_EXTENT %(extent)d

static const int32_t QM_AT[] = {%(addresses)s};
static const int64_t QM_VALUE[] = {%(values)s};
#define QM_LIVE %(cells)d

static int64_t qm_mem[QM_EXTENT];
static int32_t qm_dirty[QM_EXTENT];
static int64_t qm_saved[QM_EXTENT];
static int32_t qm_touch[QM_EXTENT];
static int32_t qm_gen;
static int qm_dirty_n;

static void qm_reset(void)
{
    for (int32_t i = 0; i < QM_EXTENT; ++i) { qm_mem[i] = 0; qm_touch[i] = 0; }
    for (int i = 0; i < QM_LIVE; ++i) qm_mem[QM_AT[i]] = QM_VALUE[i];
    qm_gen = 0;
    qm_dirty_n = 0;
}

/* A transaction writes the same cell many times over, so only the first write
 * to each is journalled. That is also what bounds the log: one entry per cell
 * and never more, however long the call runs. */
static void qm_begin(void)
{
    qm_gen += 1;
    qm_dirty_n = 0;
}

static void qm_write(int64_t at, int64_t v)
{
    if (qm_touch[at] != qm_gen) {
        qm_touch[at] = qm_gen;
        qm_dirty[qm_dirty_n] = (int32_t)at;
        qm_saved[qm_dirty_n] = qm_mem[at];
        qm_dirty_n += 1;
    }
    qm_mem[at] = v;
}

static void qm_rollback(void)
{
    while (qm_dirty_n) {
        qm_dirty_n -= 1;
        qm_mem[qm_dirty[qm_dirty_n]] = qm_saved[qm_dirty_n];
    }
}

/* One transactional call. Returns the branch target that ended it, or 0 for a
 * finite failure. Operands are read before the write, which is what makes a
 * self-modifying instruction mean what it says. */
static int64_t qm_call(int64_t pc)
{
    for (;;) {
        int64_t a = qm_mem[pc], b = qm_mem[pc + 1], c = qm_mem[pc + 2];
        if (a < 0 || b < 0) return 0;
        int64_t v = qm_mem[b] - qm_mem[a];
        qm_write(b, v);
        if (v > 0) { pc += 3; continue; }
        if (c >= 0) { pc = c; continue; }
        return c;
    }
}

%(ctype_out)s %(name)s(%(ctype_in)s x)
{
    qm_reset();

    for (int k = 0; k < %(in_bytes)d; ++k) {
        qm_begin();
        qm_write(0, (int64_t)(((uint64_t)x >> (8 * k)) & 0xFF));
        if (qm_call(%(pc_feed)d) != -2) { qm_rollback(); return 0; }
        qm_dirty_n = 0;                       /* COMMIT keeps the writes */
    }

    %(ctype_out)s out = 0;
    for (int k = 0; k < %(out_bytes)d; ++k) {
        qm_begin();
        if (qm_call(%(pc_out)d) != -1) { qm_rollback(); return 0; }
        int64_t byte = qm_mem[1];
        qm_rollback();                        /* a read commits nothing */
        out |= (%(ctype_out)s)(byte & 0xFF) << (8 * k);
        if (k + 1 < %(out_bytes)d) {
            qm_begin();
            qm_write(0, 0);
            if (qm_call(%(pc_feed)d) != -2) { qm_rollback(); return 0; }
            qm_dirty_n = 0;
        }
    }
    return out;
}
'''


def _ctype(bits):
    for width in (8, 16, 32, 64):
        if bits <= width:
            return 'uint%d_t' % width
    return 'uint64_t'


def _columns(values, per_line=12, indent='    '):
    rows = []
    for start in range(0, len(values), per_line):
        rows.append(indent + ', '.join(str(v) for v in values[start:start + per_line]))
    return '\n' + ',\n'.join(rows) + '\n' if rows else ''


def emit_c(picture, name='kernel', input_bits=8, output_bits=64):
    pairs = _pairs(picture)
    in_bytes, out_bytes = _framing(input_bits, output_bits)
    return C_TEMPLATE % {
        'name': name,
        'cells': len(pairs),
        'extent': _extent(picture),
        'pc_out': picture.pc_out,
        'pc_feed': picture.pc_feed,
        'in_bytes': in_bytes,
        'out_bytes': out_bytes,
        'ctype_in': _ctype(input_bits),
        'ctype_out': _ctype(output_bits),
        'addresses': _columns([at for at, _ in pairs]),
        'values': _columns(['%dLL' % v for _, v in pairs]),
    }


# ---------------------------------------------------------------------------
# wasm32, as text
# ---------------------------------------------------------------------------

WAT_TEMPLATE = '''\
;; %(name)s — emitted from the canonical image.
;; %(cells)d live cells, %(extent)d addressable; read at %(pc_out)d,
;; feed at %(pc_feed)d. Memory is i64 cells at 8-byte stride, and the undo log
;; lives above them so a read can discard what it wrote.
;; qm-input-bits: %(input_bits)d
(module
  (memory (export "memory") %(pages)d)
  (global $dirty (mut i32) (i32.const 0))
  (global $gen (mut i32) (i32.const 0))

  (func $get (param $at i64) (result i64)
    (i64.load (i32.shl (i32.wrap_i64 (local.get $at)) (i32.const 3))))

  (func $begin
    (global.set $gen (i32.add (global.get $gen) (i32.const 1)))
    (global.set $dirty (i32.const 0)))

  ;; Only the first write to a cell is journalled, which is what bounds the log
  ;; at one entry per cell however long the call runs.
  (func $put (param $at i64) (param $v i64)
    (local $slot i32)
    (local.set $slot (i32.shl (i32.wrap_i64 (local.get $at)) (i32.const 2)))
    (if (i32.ne (i32.load (i32.add (local.get $slot)
                                   (i32.const %(touch_base)d)))
                (global.get $gen))
      (then
        (i32.store (i32.add (local.get $slot) (i32.const %(touch_base)d))
                   (global.get $gen))
        (i32.store (i32.add (i32.shl (global.get $dirty) (i32.const 2))
                            (i32.const %(log_base)d))
                   (i32.wrap_i64 (local.get $at)))
        (i64.store (i32.add (i32.shl (global.get $dirty) (i32.const 3))
                            (i32.const %(save_base)d))
                   (call $get (local.get $at)))
        (global.set $dirty (i32.add (global.get $dirty) (i32.const 1)))))
    (i64.store (i32.shl (i32.wrap_i64 (local.get $at)) (i32.const 3))
               (local.get $v)))

  (func $rollback
    (loop $again
      (if (global.get $dirty)
        (then
          (global.set $dirty (i32.sub (global.get $dirty) (i32.const 1)))
          (i64.store
            (i32.shl (i32.load (i32.add (i32.shl (global.get $dirty)
                                                 (i32.const 2))
                                        (i32.const %(log_base)d)))
                     (i32.const 3))
            (i64.load (i32.add (i32.shl (global.get $dirty) (i32.const 3))
                               (i32.const %(save_base)d))))
          (br $again))))
  )

  (func $call (param $pc i64) (result i64)
    (local $a i64) (local $b i64) (local $c i64) (local $v i64)
    (loop $step
      (local.set $a (call $get (local.get $pc)))
      (local.set $b (call $get (i64.add (local.get $pc) (i64.const 1))))
      (local.set $c (call $get (i64.add (local.get $pc) (i64.const 2))))
      (if (i32.or (i64.lt_s (local.get $a) (i64.const 0))
                  (i64.lt_s (local.get $b) (i64.const 0)))
        (then (return (i64.const 0))))
      (local.set $v (i64.sub (call $get (local.get $b))
                             (call $get (local.get $a))))
      (call $put (local.get $b) (local.get $v))
      (if (i64.gt_s (local.get $v) (i64.const 0))
        (then (local.set $pc (i64.add (local.get $pc) (i64.const 3)))
              (br $step)))
      (if (i64.ge_s (local.get $c) (i64.const 0))
        (then (local.set $pc (local.get $c)) (br $step)))
      (return (local.get $c)))
    (i64.const 0))

  (func $reset
    (local $i i32)
    (global.set $dirty (i32.const 0))
    (global.set $gen (i32.const 0))
    (local.set $i (i32.const 0))
    (loop $clear
      (i64.store (i32.shl (local.get $i) (i32.const 3)) (i64.const 0))
      (i32.store (i32.add (i32.shl (local.get $i) (i32.const 2))
                          (i32.const %(touch_base)d))
                 (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $clear (i32.lt_u (local.get $i) (i32.const %(extent)d))))
%(init)s  )

  (func (export "%(name)s") (param $x i64) (result i64)
    (local $k i32) (local $out i64) (local $byte i64)
    (call $reset)
    (local.set $k (i32.const 0))
    (loop $feed
      (call $begin)
      (call $put (i64.const 0)
        (i64.and (i64.shr_u (local.get $x)
                            (i64.extend_i32_u (i32.mul (local.get $k)
                                                       (i32.const 8))))
                 (i64.const 255)))
      (if (i64.ne (call $call (i64.const %(pc_feed)d)) (i64.const -2))
        (then (call $rollback) (return (i64.const 0))))
      (global.set $dirty (i32.const 0))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br_if $feed (i32.lt_u (local.get $k) (i32.const %(in_bytes)d))))

    (local.set $k (i32.const 0))
    (loop $read
      (call $begin)
      (if (i64.ne (call $call (i64.const %(pc_out)d)) (i64.const -1))
        (then (call $rollback) (return (i64.const 0))))
      (local.set $byte (i64.and (call $get (i64.const 1)) (i64.const 255)))
      (call $rollback)
      (local.set $out
        (i64.or (local.get $out)
                (i64.shl (local.get $byte)
                         (i64.extend_i32_u (i32.mul (local.get $k)
                                                    (i32.const 8))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (if (i32.lt_u (local.get $k) (i32.const %(out_bytes)d))
        (then
          (call $begin)
          (call $put (i64.const 0) (i64.const 0))
          (if (i64.ne (call $call (i64.const %(pc_feed)d)) (i64.const -2))
            (then (call $rollback) (return (i64.const 0))))
          (global.set $dirty (i32.const 0))
          (br $read))))
    (local.get $out))
)
'''


def emit_wat(picture, name='kernel', input_bits=8, output_bits=64):
    pairs = _pairs(picture)
    in_bytes, out_bytes = _framing(input_bits, output_bits)
    extent = _extent(picture)

    log_base = extent * 8
    save_base = log_base + extent * 4
    touch_base = save_base + extent * 8
    total = touch_base + extent * 4
    pages = -(-total // 65536) + 1

    init = ''.join(
        '    (i64.store (i32.const %d) (i64.const %d))\n' % (at * 8, value)
        for at, value in pairs)

    return WAT_TEMPLATE % {
        'name': name,
        'cells': len(pairs),
        'extent': extent,
        'pc_out': picture.pc_out,
        'pc_feed': picture.pc_feed,
        'in_bytes': in_bytes,
        'out_bytes': out_bytes,
        'input_bits': input_bits,
        'pages': pages,
        'log_base': log_base,
        'save_base': save_base,
        'touch_base': touch_base,
        'init': init,
    }


# ---------------------------------------------------------------------------
# x86-64
# ---------------------------------------------------------------------------

X86_TEMPLATE = '''\
# %(name)s — emitted from the canonical image.
# %(cells)d live cells, %(extent)d addressable; read at %(pc_out)d, feed at
# %(pc_feed)d. SysV: the input arrives in %%rdi and the result leaves in %%rax.
# qm-input-bits: %(input_bits)d
    .text
    .globl %(name)s
    .type %(name)s, @function

# qm_call: %%rdi = pc. Returns the ending branch target in %%rax, 0 on a finite
# failure. Clobbers %%rsi %%rdx %%rcx %%r8 %%r9.
qm_call:
    leaq qm_mem(%%rip), %%r8
    leaq qm_log(%%rip), %%r9
1:  movq (%%r8,%%rdi,8), %%rsi          # a
    movq 8(%%r8,%%rdi,8), %%rdx         # b
    movq 16(%%r8,%%rdi,8), %%rcx        # c
    testq %%rsi, %%rsi
    js 4f
    testq %%rdx, %%rdx
    js 4f
    movq (%%r8,%%rdx,8), %%rax
    subq (%%r8,%%rsi,8), %%rax
    movslq qm_dirty(%%rip), %%rsi       # journal the old value
    movq %%rdx, (%%r9,%%rsi,8)
    movq (%%r8,%%rdx,8), %%r10
    leaq qm_save(%%rip), %%r11
    movq %%r10, (%%r11,%%rsi,8)
    incl qm_dirty(%%rip)
    movq %%rax, (%%r8,%%rdx,8)
    testq %%rax, %%rax
    jg 2f
    testq %%rcx, %%rcx
    js 3f
    movq %%rcx, %%rdi
    jmp 1b
2:  addq $3, %%rdi
    jmp 1b
3:  movq %%rcx, %%rax
    ret
4:  xorq %%rax, %%rax
    ret

# qm_rollback: undo every journalled write, newest first.
qm_rollback:
    leaq qm_mem(%%rip), %%r8
    leaq qm_log(%%rip), %%r9
    leaq qm_save(%%rip), %%r11
1:  movl qm_dirty(%%rip), %%eax
    testl %%eax, %%eax
    jz 2f
    decl qm_dirty(%%rip)
    movslq qm_dirty(%%rip), %%rsi
    movq (%%r9,%%rsi,8), %%rdx
    movq (%%r11,%%rsi,8), %%rcx
    movq %%rcx, (%%r8,%%rdx,8)
    jmp 1b
2:  ret

%(name)s:
    pushq %%rbx
    pushq %%r12
    pushq %%r13
    pushq %%r14
    movq %%rdi, %%r14                   # the input word
    call qm_reset

    xorl %%r12d, %%r12d                 # feed index
1:  movl $0, qm_dirty(%%rip)
    movq %%r14, %%rax
    movl %%r12d, %%ecx
    shll $3, %%ecx
    shrq %%cl, %%rax
    andq $255, %%rax
    leaq qm_mem(%%rip), %%r8
    movq %%rax, (%%r8)
    movq $%(pc_feed)d, %%rdi
    call qm_call
    cmpq $-2, %%rax
    jne 9f
    movl $0, qm_dirty(%%rip)
    incl %%r12d
    cmpl $%(in_bytes)d, %%r12d
    jb 1b

    xorq %%rbx, %%rbx                   # the output word
    xorl %%r12d, %%r12d
2:  movl $0, qm_dirty(%%rip)
    movq $%(pc_out)d, %%rdi
    call qm_call
    cmpq $-1, %%rax
    jne 9f
    leaq qm_mem(%%rip), %%r8
    movq 8(%%r8), %%r13
    andq $255, %%r13
    call qm_rollback
    movl %%r12d, %%ecx
    shll $3, %%ecx
    shlq %%cl, %%r13
    orq %%r13, %%rbx
    incl %%r12d
    cmpl $%(out_bytes)d, %%r12d
    jae 8f
    movl $0, qm_dirty(%%rip)
    leaq qm_mem(%%rip), %%r8
    movq $0, (%%r8)
    movq $%(pc_feed)d, %%rdi
    call qm_call
    cmpq $-2, %%rax
    jne 9f
    movl $0, qm_dirty(%%rip)
    jmp 2b

8:  movq %%rbx, %%rax
    popq %%r14
    popq %%r13
    popq %%r12
    popq %%rbx
    ret
9:  call qm_rollback
    xorq %%rax, %%rax
    popq %%r14
    popq %%r13
    popq %%r12
    popq %%rbx
    ret
    .size %(name)s, .-%(name)s

# qm_reset: zero the memory, then lay the image back into it.
qm_reset:
    leaq qm_mem(%%rip), %%r8
    xorl %%eax, %%eax
    movl $%(extent)d, %%ecx
1:  movq $0, (%%r8,%%rax,8)
    incq %%rax
    cmpq %%rcx, %%rax
    jb 1b
    movl $0, qm_dirty(%%rip)
    leaq qm_at(%%rip), %%r9
    leaq qm_value(%%rip), %%r11
    xorl %%eax, %%eax
    movl $%(cells)d, %%ecx
    testl %%ecx, %%ecx
    jz 3f
2:  movslq (%%r9,%%rax,4), %%rdx
    movq (%%r11,%%rax,8), %%rsi
    movq %%rsi, (%%r8,%%rdx,8)
    incq %%rax
    cmpq %%rcx, %%rax
    jb 2b
3:  ret

    .section .rodata
    .align 8
qm_at:
%(addresses)s
qm_value:
%(values)s

    .bss
    .align 8
qm_mem:    .zero %(mem_bytes)d
qm_log:    .zero %(log_bytes)d
qm_save:   .zero %(log_bytes)d
    .align 4
qm_dirty:  .zero 4
    .section .note.GNU-stack,"",@progbits
'''


def _directive(values, directive, per_line=8):
    rows = []
    for start in range(0, len(values), per_line):
        rows.append('    %s %s' % (directive,
                                   ', '.join(str(v) for v in values[start:start + per_line])))
    return '\n'.join(rows) if rows else '    %s 0' % directive


def emit_x86(picture, name='kernel', input_bits=8, output_bits=64):
    pairs = _pairs(picture)
    in_bytes, out_bytes = _framing(input_bits, output_bits)
    extent = _extent(picture)
    return X86_TEMPLATE % {
        'name': name,
        'cells': len(pairs),
        'extent': extent,
        'pc_out': picture.pc_out,
        'pc_feed': picture.pc_feed,
        'in_bytes': in_bytes,
        'out_bytes': out_bytes,
        'input_bits': input_bits,
        'mem_bytes': extent * 8,
        'log_bytes': extent * 8,
        'addresses': _directive([at for at, _ in pairs], '.long'),
        'values': _directive([v for _, v in pairs], '.quad'),
    }


EMITTERS = {'codec': emit_code, 'listing': emit_listing, 'c': emit_c,
            'wat': emit_wat, 'x86': emit_x86}


def emit(picture, language, name='kernel', input_bits=8, output_bits=64):
    """One image, as the artifact or as one of the languages it decodes to."""
    if language not in EMITTERS:
        raise ValueError('no emitter for %r; have %s'
                         % (language, ', '.join(sorted(EMITTERS))))
    return EMITTERS[language](picture, name, input_bits, output_bits)
