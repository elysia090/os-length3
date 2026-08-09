/* lanecode.h — hand-written broadword implementations.
 *
 * Each function implements the corresponding example with scalar word-level
 * operations. The tests compare both versions over every finite test domain.
 *
 * It is not an input to the tool. The intrinsics here are x86-specific, and
 * the browser compiles to wasm32; the examples are the portable statements of
 * the same functions.
 */

#ifndef LANECODE_H
#define LANECODE_H

#include <immintrin.h>
#include <stdint.h>
#include <string.h>

#define LC_ONES 0x0101010101010101ull
#define LC_HIGH 0x8080808080808080ull
#define LC_LOW7 0x7f7f7f7f7f7f7f7full
#define LC_IOTA 0x0706050403020100ull

/* ------------------------------------------------------------------
 * predicate -> spread
 * ------------------------------------------------------------------ */

/*
 * Exact per-lane zero predicate.
 *
 * The classic
 *
 *     (v - ONES) & ~v & HIGH
 *
 * is useful for testing whether at least one zero byte exists, but it
 * is not an exact per-lane zero mask. Borrow can propagate into an
 * adjacent 0x01 byte and create a false-positive lane.
 */
static inline uint64_t
lc_zero_spread(uint64_t v)
{
    return _andn_u64(
        ((v & LC_LOW7) + LC_LOW7) | v,
        LC_HIGH);
}

/* 5 core ops when c is a compile-time constant. */
#define LC_EQ_SPREAD(x, c) \
    lc_zero_spread((x) ^ ((uint64_t)(c) * LC_ONES))

/*
 * Unsigned byte-wise x < c.
 *
 * z = (x | HIGH) - (c & LOW7) cannot borrow across byte lanes.
 * The remaining high-bit relation is a small Boolean function.
 */
#define LC_LT_SPREAD(x, c) __extension__ ({                        \
    uint64_t x_ = (x);                                             \
    uint64_t y_ = (uint64_t)(c) * LC_ONES;                         \
    uint64_t z_ = (x_ | LC_HIGH) - (y_ & LC_LOW7);                 \
    uint64_t u_ = x_ ^ z_;                                         \
    uint64_t e_ = x_ ^ y_;                                         \
    _andn_u64(x_ ^ _andn_u64(e_, u_), LC_HIGH);                    \
})

/* Requires lo <= hi < 0x80. */
#define LC_RANGE_SPREAD(x, lo, hi) __extension__ ({                \
    uint64_t x_ = (x);                                             \
    uint64_t z1_ = (x_ | LC_HIGH)                                  \
                 - ((uint64_t)(lo) * LC_ONES);                     \
    uint64_t z2_ = (((uint64_t)(hi) * LC_ONES) | LC_HIGH)          \
                 - (x_ & LC_LOW7);                                 \
    _andn_u64(x_, z1_ & z2_) & LC_HIGH;                            \
})

/* ------------------------------------------------------------------
 * spread consumers
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_byte_mask_from_spread(uint64_t s)
{
    return (s >> 7) * 0xFFull;
}

static inline uint64_t
lc_ranks_from_spread(uint64_t s)
{
    return (s >> 7) * 0x0101010101010100ull;
}

static inline unsigned
lc_popcount_from_spread(uint64_t s)
{
    return (unsigned)__builtin_popcountll(s);
}

static inline uint8_t
lc_mask_from_spread(uint64_t s)
{
    return (uint8_t)_mm_movemask_epi8(
        _mm_cvtsi64_si128((long long)s));
}

/* ------------------------------------------------------------------
 * SIMD physical representatives
 * ------------------------------------------------------------------ */

static inline uint32_t
lc_eq16(__m128i x, uint8_t c)
{
    return (uint32_t)_mm_movemask_epi8(
        _mm_cmpeq_epi8(x, _mm_set1_epi8((char)c)));
}

static inline uint32_t
lc_lt16(__m128i x, uint8_t c)
{
    return (uint32_t)_mm_movemask_epi8(
        _mm_cmpgt_epi8(
            _mm_set1_epi8((char)(c ^ 0x80)),
            _mm_xor_si128(x, _mm_set1_epi8((char)0x80))));
}

/* Requires lo <= hi. */
static inline uint32_t
lc_range16(__m128i x, uint8_t lo, uint8_t hi)
{
    __m128i t = _mm_sub_epi8(x, _mm_set1_epi8((char)lo));

    return (uint32_t)_mm_movemask_epi8(
        _mm_cmpeq_epi8(
            _mm_min_epu8(t, _mm_set1_epi8((char)(hi - lo))),
            t));
}

/* ------------------------------------------------------------------
 * mask -> address
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_byte_mask8(uint8_t m)
{
    return _pdep_u64((uint64_t)m, LC_ONES) * 0xFFull;
}

/* Exclusive rank. */
static inline uint64_t
lc_ranks8(uint8_t m)
{
    return _pdep_u64((uint64_t)m, LC_ONES)
         * 0x0101010101010100ull;
}

/* Inclusive rank. */
static inline uint64_t
lc_inclusive_ranks8(uint8_t m)
{
    return _pdep_u64((uint64_t)m, LC_ONES) * LC_ONES;
}

static inline uint64_t
lc_select8(uint8_t m)
{
    return _pext_u64(LC_IOTA, lc_byte_mask8(m));
}

static inline uint64_t
lc_shuffle_control8(uint8_t m)
{
    return ~_pext_u64(~LC_IOTA, lc_byte_mask8(m));
}

/* ------------------------------------------------------------------
 * compact / expand / partition
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_compact8(uint64_t x, uint8_t m)
{
    return _pext_u64(x, lc_byte_mask8(m));
}

static inline uint64_t
lc_expand8(uint64_t p, uint8_t m)
{
    return _pdep_u64(p, lc_byte_mask8(m));
}

static inline uint64_t
lc_stable_partition8(uint64_t x, uint8_t m)
{
    const uint64_t bm = lc_byte_mask8(m);
    const unsigned k  =
        (unsigned)__builtin_popcount((unsigned)m);
    const uint64_t yes = _pext_u64(x, bm);
    const uint64_t no  = _pext_u64(x, ~bm);

    return yes | (no << (8u * (k & 7u)));
}

/* ------------------------------------------------------------------
 * stream output
 *
 * PRECONDITION:
 *
 * The destination has at least 7 writable bytes of slack past the
 * logical end, because these variants always perform an 8-byte store.
 * Use a bounded tail store when this cannot be guaranteed.
 * ------------------------------------------------------------------ */

static inline void
lc_compress_store8(uint8_t **dst, uint64_t x, uint8_t m)
{
    const uint64_t packed = lc_compact8(x, m);

    memcpy(*dst, &packed, 8);
    *dst += __builtin_popcount((unsigned)m);
}

static inline void
lc_split_store8(uint8_t **yes, uint8_t **no,
                uint64_t x, uint8_t m)
{
    const uint64_t bm = lc_byte_mask8(m);
    const unsigned k  =
        (unsigned)__builtin_popcount((unsigned)m);
    const uint64_t a = _pext_u64(x, bm);
    const uint64_t b = _pext_u64(x, ~bm);

    memcpy(*yes, &a, 8);
    memcpy(*no,  &b, 8);

    *yes += k;
    *no  += 8u - k;
}

/* ------------------------------------------------------------------
 * difference / prefix
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_changes(uint64_t x)
{
    return x ^ (x << 1);
}

static inline uint64_t
lc_starts(uint64_t x)
{
    return x & ~(x << 1);
}

static inline uint64_t
lc_ends(uint64_t x)
{
    return x & ~(x >> 1);
}

/* Multiply by (1+x)^-1 in GF(2)[x]/(x^64). */
static inline uint64_t
lc_prefix_xor64(uint64_t x)
{
    return (uint64_t)_mm_cvtsi128_si64(
        _mm_clmulepi64_si128(
            _mm_cvtsi64_si128((long long)x),
            _mm_set1_epi64x(-1),
            0));
}

/* ------------------------------------------------------------------
 * prefix parity
 * ------------------------------------------------------------------ */

/* Inclusive running parity expanded as 00/FF bytes. */
static inline uint64_t
lc_prefix_parity_mask8(uint8_t m)
{
    const uint64_t a = _pdep_u64((uint64_t)m, LC_ONES);

    return (uint64_t)_mm_cvtsi128_si64(
        _mm_clmulepi64_si128(
            _mm_cvtsi64_si128((long long)a),
            _mm_set1_epi64x(-1),
            0));
}

/* Exclusive running parity: quote state entering each byte. */
static inline uint64_t
lc_quote_state_before8(uint8_t q)
{
    const uint64_t a = _pdep_u64((uint64_t)q, LC_ONES);

    return (uint64_t)_mm_cvtsi128_si64(
        _mm_clmulepi64_si128(
            _mm_cvtsi64_si128((long long)a),
            _mm_set_epi64x(
                0,
                (long long)0xFFFFFFFFFFFFFF00ull),
            0));
}

/* ------------------------------------------------------------------
 * 16 lanes, 4-bit exclusive rank
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_ranks16_nibble(uint16_t m)
{
    return _pdep_u64((uint64_t)m,
                     0x1111111111111111ull)
         * 0x1111111111111110ull;
}

/* ------------------------------------------------------------------
 * Morton interleave and compact operations
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_morton_dilate32(uint32_t x)
{
    return _pdep_u64((uint64_t)x,
                     0x5555555555555555ull);
}

static inline uint32_t
lc_morton_compact_even(uint64_t x)
{
    return (uint32_t)_pext_u64(x,
                               0x5555555555555555ull);
}

/* ------------------------------------------------------------------
 * run IDs
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_run_ids8(uint8_t m)
{
    const uint8_t starts =
        (uint8_t)(m & (uint8_t)~((uint8_t)(m << 1)));

    return lc_inclusive_ranks8(starts);
}

/* ------------------------------------------------------------------
 * compact non-zero bytes
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_compact_nonzero8(uint64_t x)
{
    const uint64_t spread =
        (((x & LC_LOW7) + LC_LOW7) | x) & LC_HIGH;
    const uint64_t bm = (spread >> 7) * 0xFFull;

    return _pext_u64(x, bm);
}

/* ------------------------------------------------------------------
 * block prefix
 *
 * Requires every inclusive prefix to fit in one byte.
 * ------------------------------------------------------------------ */

static inline uint64_t
lc_block_offsets8(uint64_t counts)
{
    return counts * LC_ONES;
}

#endif /* LANECODE_H */
