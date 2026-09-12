#include <stdint.h>

/* Portable CIOS spelling of OpenSSL 3.5.7
 * crypto/bn/asm/x86_64-mont.pl's
 *
 *     int bn_mul_mont(BN_ULONG *rp, const BN_ULONG *ap,
 *                     const BN_ULONG *bp, const BN_ULONG *np,
 *                     const BN_ULONG *n0, int num)
 *
 * valid-input contract.  Limbs are radix 2^64, num > 0, np is odd, ap and bp
 * are reduced modulo np, and n0[0] * np[0] == -1 (mod 2^64).  The temporary
 * keeps rp aliases with ap or bp safe.  Each outer iteration implements the
 * source generator's .Louter/.Linner recurrence; the final two loops are its
 * .Lsub/.Lcopy constant-time conditional subtraction.  Invalid num is a
 * defined C extension rather than part of OpenSSL's internal call contract.
 *
 * Differential result: green for 8,000 deterministic cases covering 1..8
 * limbs against the integer identity a*b*(2^(64*num))^-1 mod n.
 *
 * Measured production spelling:
 *
 *     cc -O2 -ffreestanding -fno-builtin -nostdlib -static
 *
 * emits a 1,112-byte .text.  This is the actual AT&T assembly of its hot
 * multiply/reduce recurrence (loads and the final store are execution cuts):
 *
 *     mov    %r11,%rax
 *     mulq   (%rcx,%r8,8)
 *     xor    %ebx,%ebx
 *     add    (%r15,%r8,8),%r10
 *     setb   %bl
 *     add    %rax,%r10
 *     adc    %rdx,%rbx
 *     mov    %r10,-8(%r15,%r8,8)
 *
 * The low-limb Montgomery cancellation in that same linked function is:
 *
 *     imul   %r9,%r11
 *     mov    %r11,%rax
 *     mulq   -0x58(%rbp)
 *     mov    %rdx,%r10
 *     add    %r9,%rax
 *     adc    $0,%r10
 *
 * The pure slice between that loop's load and store cuts is now a proved joint
 * minimum: 3 work / 2 span / 9 bytes.  The direct emitter reconstructs:
 *
 *     setb   %bl
 *     add    %rax,%r10
 *     adc    %rdx,%rbx
 *
 * SETB and ADD form wave one; ADC alone forms wave two.  It replaces the old
 * 4-work / 3-span SSA accounting which charged condition and low-byte insert
 * separately even though x86 SETB implements both.
 *
 * The current `-Oz -static` linked regression also exposes the variable-size
 * entry frame.  Complete-future selection changes its source allocation
 *
 *     mov    %r9d,%r15d
 *     mov    %rsp,%r14
 *     lea    0x1f(,%r15,8),%rax
 *     and    $-16,%rax
 *     sub    %rax,%r14
 *     mov    %r14,%rsp
 *     xor    %eax,%eax
 *     add    $2,%r9d
 *     test   %r9d,%r9d
 *     cmovle %eax,%r9d
 *     cmp    %rax,%r9
 *     je     .Lentry_done
 *
 * into the ordinary x86 sequence
 *
 *     mov    %r9d,%r15d
 *     lea    0x1f(,%r15,8),%r14
 *     and    $-16,%r14
 *     sub    %r14,%rsp
 *     mov    %rsp,%r14
 *     xor    %eax,%eax
 *     lea    2(%r9),%r9d
 *     test   %r9d,%r9d
 *     cmovle %eax,%r9d
 *     cmp    %rax,%r9
 *     je     .Lentry_done
 *
 * R14 is dead at the cut, so it owns the aligned subtraction operand before
 * receiving the shared RSP result.  This removes one materialization and
 * shortens the exact block from 42 bytes / 12 work / 7 span to 39 bytes /
 * 11 work / 5 span while retaining the final CMP flags as an architectural
 * publication.  Across the complete 410-coordinate linked input the same
 * general production recovers 11 source-copy coordinates: direct/source is
 * now 77/333, normalization escape is 101 classes / 125 coordinates, and
 * unsupported remains zero.
 *
 * Full post-link result over all 1,112 executable byte coordinates: 0
 * unsupported, maximum 16 work / 8 span, 156 direct classes, 636 source
 * classes, and 264 other normalization-escape classes.  Whole-ELF publication
 * is still correctly rejected because this small input is not smaller after
 * proof/layout fixed costs.  These numbers and instructions are observations,
 * not a hand-transcribed claim about the OpenSSL generator. */
int bn_mul_mont(uint64_t *rp, const uint64_t *ap, const uint64_t *bp,
                const uint64_t *np, const uint64_t *n0, int num)
{
    if (num <= 0)
        return 0;

    uint64_t t[(unsigned)num + 2u];
    for (int j = 0; j < num + 2; ++j)
        t[j] = 0;

    for (int i = 0; i < num; ++i) {
        uint64_t carry = 0;
        for (int j = 0; j < num; ++j) {
            __uint128_t z = (__uint128_t)ap[j] * bp[i] + t[j] + carry;
            t[j] = (uint64_t)z;
            carry = (uint64_t)(z >> 64);
        }
        __uint128_t top = (__uint128_t)t[num] + carry;
        t[num] = (uint64_t)top;
        t[num + 1] = (uint64_t)(top >> 64);

        uint64_t m = t[0] * n0[0];
        __uint128_t z = (__uint128_t)m * np[0] + t[0];
        carry = (uint64_t)(z >> 64);
        for (int j = 1; j < num; ++j) {
            z = (__uint128_t)m * np[j] + t[j] + carry;
            t[j - 1] = (uint64_t)z;
            carry = (uint64_t)(z >> 64);
        }
        z = (__uint128_t)t[num] + carry;
        t[num - 1] = (uint64_t)z;
        t[num] = t[num + 1] + (uint64_t)(z >> 64);
        t[num + 1] = 0;
    }

    uint64_t borrow = 0;
    for (int j = 0; j < num; ++j) {
        uint64_t difference = t[j] - np[j];
        uint64_t first = t[j] < np[j];
        rp[j] = difference - borrow;
        borrow = first | (difference < borrow);
    }
    uint64_t keep_t = 0u - (uint64_t)(t[num] < borrow);
    for (int j = 0; j < num; ++j)
        rp[j] = (rp[j] & ~keep_t) | (t[j] & keep_t);

    volatile uint64_t *wipe = t;
    for (int j = 0; j < num + 2; ++j)
        wipe[j] = 0;
    return 1;
}
