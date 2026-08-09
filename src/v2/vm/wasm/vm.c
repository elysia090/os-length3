/* Pinf-R codec -> image -> vm, as one freestanding wasm32 module.
 *
 * This is the fast half.  `vm/codec.py`, `vm/image.py` and `vm/machine.py`
 * are the definition; this file has to agree with them on every byte, and
 * `tests/test_vm.py` is what holds it to that rather than assuming it.
 *
 * Three deliberate finite-runtime limits, all reported rather than hidden:
 *
 *   * Values are i64, not unbounded. A subtraction that would overflow ends
 *     the call as a finite failure and raises a flag instead of wrapping into
 *     a different encoded image.
 *   * Memory is a fixed dense i64 arena. Running past it is a reported
 *     failure, never an address wrap or silent eviction.
 *   * A step budget exists so a caller can stop.  Exhausting it returns
 *     UNFINISHED, which is not an outcome: it is neither a byte nor a failure,
 *     and a caller must not turn it into either.
 *
 * No allocator, no libc, no imports.  The module is pure computation over its
 * own linear memory.
 */

typedef unsigned char      u8;
typedef unsigned int       u32;
typedef unsigned long long u64;
typedef long long          i64;

#define EXPORT __attribute__((visibility("default")))

#ifndef VM_DIRECT_BYTE_STATE
#define VM_DIRECT_BYTE_STATE 1
#endif

/* Outcomes shared with the JS and Python sides. */
#define R_BOTTOM     -1
#define R_UNFINISHED -2
#define R_DEAD        0
#define R_COMMITTED   1

/* Branch targets below zero are invocation events. */
#define EV_EMIT   -1
#define EV_COMMIT -2

/* -------------------------------------------------------------- memory ---
 * A flat array over i64 addresses, sized at load from the image's own extent.
 *
 * It used to be an open-addressing table, which cost a multiply-hash and a
 * probe on all five reads and the write of every transition. That is the wrong
 * shape for what this actually runs: an image encodes its addresses as gaps,
 * and the lowering emits them consecutively — one bit of gap per
 * cell across every example here — so the memory is dense and paying for
 * sparsity buys nothing. `vm/wasm/bench.c` puts the two side by side: 92.6
 * against 2.6 ns per transition on `ranks8`.
 *
 * An address past the finite arena is a reported failure rather than a wrap,
 * exposed through `vm_table_full`.
 */

/* Big enough for every artifact `vm/lower.py` produces today: the dynamic
 * gather is 241,841 cells and its top address is a little above that.  Sizing
 * this from the image is what an allocator would do, and there is not one here
 * on purpose. */
#define CAP_BITS 20
#define CAP      (1u << CAP_BITS)

static i64 cells[CAP];
static u32 extent;                 /* how much of it this image uses */
static int table_full;

/* Undo log, so a discarded read costs the writes it made and not a copy of
 * the whole table. */
#define JCAP (1u << 18)
static u32 j_slot[JCAP];
static i64 j_val[JCAP];
static u32 j_n;
/* Off while `vm_load` fills the table: those writes are the image itself, and
 * nothing rolls back past them.  Journalling them cost one log entry per cell
 * and put a ceiling on image size that had nothing to do with the machine. */
static int journaling = 1;

static int overflowed;
static int exhausted;
static u64 budget = 1ull << 22;
static u64 last_steps;
static int direct_byte_state;
static u64 direct_read_steps;

static i64 mem_get(i64 address)
{
    if (address < 0 || (u64)address >= CAP) return 0;
    return cells[address];
}

static int mem_set(i64 address, i64 value)
{
    if (address < 0 || (u64)address >= CAP) { table_full = 1; return 0; }
    if (journaling) {
        if (j_n >= JCAP) return 0;     /* cannot promise a rollback */
        j_slot[j_n] = (u32)address;
        j_val[j_n]  = cells[address];
        j_n += 1;
    }
    cells[address] = value;
    if ((u64)address >= extent) extent = (u32)address + 1u;
    return 1;
}

static void journal_begin(void) { j_n = 0; }

static void journal_rollback(void)
{
    while (j_n) {
        j_n -= 1;
        cells[j_slot[j_n]] = j_val[j_n];
    }
}

static void mem_clear(void)
{
    /* Only what the last image used, not the whole arena. */
    for (u32 i = 0; i < extent; ++i) cells[i] = 0;
    extent = 0;
    j_n = 0;
}

/* --------------------------------------------------------------- codec ---
 * E(0) = 0 ; E(n) = 1 || 0^k || bin(n).  The decoder stops when it has read
 * what the leading run announced, which is what makes the code prefix-free.
 */

static const u8 *bits_base;
static u64 bits_len;
static u64 bits_at;
static int bits_bad;

static u32 bit_next(void)
{
    if (bits_at >= bits_len) { bits_bad = 1; return 0; }
    u64 i = bits_at++;
    return (bits_base[i >> 3] >> (7u - (u32)(i & 7u))) & 1u;
}

/* The next 64 bits from `at`, most significant first, zero-filled past the
 * end.  Reading a word and counting its leading zeros is the whole reason
 * `decode_scalar` below is not a loop over bits: `E(n)` announces its own
 * width with a zero run, and a zero run is what `clz` measures. */
static u64 bits_window(u64 at)
{
    u64 bytes = (bits_len + 7u) >> 3;
    u64 base = at >> 3;
    u32 skew = (u32)(at & 7u);

    u64 word;
    if (base + 9u <= bytes) {
        /* The common case by far: nine bytes are in reach, so this is one
         * unaligned load rather than nine bounds-checked ones. */
        __builtin_memcpy(&word, bits_base + base, 8);
        word = __builtin_bswap64(word);
        if (!skew) return word;
        return (word << skew) | ((u64)bits_base[base + 8u] >> (8u - skew));
    }
    word = 0;
    for (u32 i = 0; i < 8u; ++i) {
        u64 j = base + i;
        word = (word << 8) | (u64)(j < bytes ? bits_base[j] : 0u);
    }
    if (!skew) return word;
    /* Nine bytes do not fit in one, so the ninth is folded in separately
     * rather than shifted through the accumulator and off the top. */
    u64 j = base + 8u;
    u64 extra = (u64)(j < bytes ? bits_base[j] : 0u);
    return (word << skew) | (extra >> (8u - skew));
}

static u64 decode_scalar(void)
{
    if (bits_bad) return 0;
    if (bits_at >= bits_len) { bits_bad = 1; return 0; }

    u64 window = bits_window(bits_at);
    if (!(window >> 63)) { bits_at += 1; return 0; }   /* E(0) */

    /* `window` is 1 || 0^k || 1 || (k-1 more bits).  The zero run is what
     * announces the width, so counting it is one `clz` on the word with the
     * leading 1 removed, and the payload is the next k+1 bits.  Running out
     * here is malformed, not a short word: `1` alone is not E(1), and
     * accepting it would make this disagree with the reference about which
     * artifacts are dead. */
    /* `rest` holds the 63 bits after the lead, so its leading zeros are the
     * run.  All 63 being zero does not yet mean the word is malformed: the
     * bit that ends the run may be the very next one, which is `k == 63` --
     * the widest word an i64 value can have, and the one the overflow test
     * builds.  Only a run that continues past it is too wide. */
    u64 rest = window << 1;
    u32 k;
    if (rest == 0) {
        if (bits_at + 64ull >= bits_len) { bits_bad = 1; return 0; }
        if (!(bits_window(bits_at + 64ull) >> 63)) { bits_bad = 1; return 0; }
        k = 63u;
    } else {
        k = (u32)__builtin_clzll(rest);
    }
    /* 1 for the lead, k for the run, 1 for the bit that ends it, k payload. */
    u64 width = 1ull + (u64)k + 1ull + (u64)k;
    if (bits_at + width > bits_len) { bits_bad = 1; return 0; }

    /* The word is 1 || 0^k || 1 || (k more bits), so it is 2k+2 wide and fits
     * the window already loaded whenever k <= 31 — which is every address and
     * every value this lowering emits. Taking a second window unconditionally
     * doubled the loads for the common case; it is needed only when the run
     * and the payload cannot sit in 64 bits together, which is the 2^62 case
     * the overflow test builds. */
    u64 value;
    if (k <= 31u) {
        value = (rest << k) >> (63u - k);
    } else {
        u64 tail = bits_window(bits_at + 1ull + (u64)k);
        value = (k == 63u) ? tail : (tail >> (63u - k));
    }
    bits_at += width;
    return value;
}

/* ---------------------------------------------------------------- image ---
 * E(k) || E(pc_o) || E(pc_a) || (E(gap) || E(zigzag(value)))^k, with strictly
 * increasing addresses and no zero-valued entry.  Anything else is dead.
 */

static i64 pc_out, pc_feed;
static int dead = 1;

static i64 unzigzag(u64 point)
{
    return (point & 1u) ? -(i64)((point + 1u) >> 1) : (i64)(point >> 1);
}

EXPORT u8 *vm_buffer(void);
EXPORT u8 *vm_cells(void);
EXPORT int vm_direct_byte_state(void);
static u8 artifact[1u << 20];

EXPORT u8 *vm_buffer(void) { return artifact; }

/* Build tools use this address to project a suspended module onto the cells
 * that can affect later feed/read calls. Codec buffers, undo-log contents and
 * counters are deliberately outside that state boundary. */
EXPORT u8 *vm_cells(void) { return (u8 *)cells; }
EXPORT int vm_direct_byte_state(void) { return direct_byte_state; }

static int detect_direct_byte_state(void);

EXPORT int vm_load(u32 byte_len)
{
    mem_clear();
    dead = 1;
    overflowed = 0;
    exhausted = 0;
    table_full = 0;
    direct_byte_state = 0;
    direct_read_steps = 0;

    bits_base = artifact;
    bits_len  = (u64)byte_len * 8ull;
    bits_at   = 0;
    bits_bad  = 0;

    /* code(z) = E(|z|) || z, then a shorter-than-byte all-zero pad. */
    u64 payload_bits = decode_scalar();
    if (bits_bad) return 0;
    u64 payload_start = bits_at;
    if (payload_start + payload_bits > bits_len) return 0;
    u64 payload_end = payload_start + payload_bits;
    if (bits_len - payload_end >= 8) return 0;
    for (u64 i = payload_end; i < bits_len; ++i) {
        bits_at = i;
        if (bit_next()) return 0;                  /* pad is not all zero */
    }

    bits_len = payload_end;                        /* the image ends here */
    bits_at  = payload_start;

    u64 count = decode_scalar();
    u64 out   = decode_scalar();
    u64 feed  = decode_scalar();
    if (bits_bad) return 0;

    i64 address = -1;
    journaling = 0;
    for (u64 i = 0; i < count; ++i) {
        u64 gap   = decode_scalar();
        u64 point = decode_scalar();
        if (bits_bad) { journaling = 1; mem_clear(); return 0; }
        address += 1 + (i64)gap;
        i64 value = unzigzag(point);
        /* no canonical image */
        if (value == 0) { journaling = 1; mem_clear(); return 0; }
        if (!mem_set(address, value)) { journaling = 1; mem_clear(); return 0; }
    }
    journaling = 1;
    if (bits_at != bits_len) { mem_clear(); return 0; }

    journal_begin();                               /* the load is committed */
    pc_out  = (i64)out;
    pc_feed = (i64)feed;
    dead = 0;
    direct_byte_state = VM_DIRECT_BYTE_STATE && detect_direct_byte_state();
    return 1;
}

/* ------------------------------------------------------------------- vm ---
 * a = M[pc]; b = M[pc+1]; c = M[pc+2] are read before the write, which is what
 * makes a self-modifying instruction mean what it says.
 */

static int run(i64 pc, i64 *event)
{
    u64 steps = 0;
    for (;;) {
        if (steps >= budget) { last_steps = steps; exhausted = 1; return 0; }
        steps += 1;

        i64 a = mem_get(pc);
        i64 b = mem_get(pc + 1);
        i64 c = mem_get(pc + 2);
        if (a < 0 || b < 0) { last_steps = steps; *event = 0; return 1; }

        i64 value;
        if (__builtin_ssubll_overflow(mem_get(b), mem_get(a), &value)) {
            overflowed = 1;
            last_steps = steps;
            *event = 0;
            return 1;
        }
        if (!mem_set(b, value)) { last_steps = steps; *event = 0; return 1; }

        if (value > 0) { pc = pc + 3; continue; }
        if (c >= 0)    { pc = c;      continue; }
        last_steps = steps;
        *event = c;
        return 1;
    }
}

/* Prove the byte-register state step over its complete finite input domain.
 * The feed row must commit after changing no persistent cell except input.
 * Each possible byte is then read through the ordinary transactional engine;
 * only a byte-for-byte identity result selects the direct implementation.
 * Nothing sampled or remembered at runtime participates in the decision. */
static int detect_direct_byte_state(void)
{
    i64 a = mem_get(pc_feed);
    i64 b = mem_get(pc_feed + 1);
    i64 c = mem_get(pc_feed + 2);
    i64 initial = mem_get(0);
    if (a != b || a < 2 || c != EV_COMMIT || mem_get(a) != 0
            || initial < 0 || initial >= 256) return 0;

    u64 saved_steps = last_steps;
    int saved_overflowed = overflowed;
    int saved_exhausted = exhausted;
    int saved_table_full = table_full;
    u64 read_steps = 0;

    for (u32 byte = 0; byte < 256u; ++byte) {
        journal_begin();
        if (!mem_set(0, (i64)byte)) {
            journal_rollback();
            last_steps = saved_steps;
            overflowed = saved_overflowed;
            exhausted = saved_exhausted;
            table_full = saved_table_full;
            return 0;
        }
        i64 event = 0;
        int finished = run(pc_out, &event);
        i64 out = mem_get(1);
        u64 steps = last_steps;
        journal_rollback();
        if (!finished || event != EV_EMIT || out != (i64)byte
                || (byte && steps != read_steps)) {
            last_steps = saved_steps;
            overflowed = saved_overflowed;
            exhausted = saved_exhausted;
            table_full = saved_table_full;
            return 0;
        }
        read_steps = steps;
    }

    last_steps = saved_steps;
    overflowed = saved_overflowed;
    exhausted = saved_exhausted;
    table_full = saved_table_full;
    journal_begin();
    direct_read_steps = read_steps;
    return 1;
}

EXPORT int vm_read(void)
{
    if (dead) return R_BOTTOM;
    exhausted = 0;
    if (direct_byte_state) {
        if (budget < direct_read_steps) {
            last_steps = budget;
            exhausted = 1;
            return R_UNFINISHED;
        }
        last_steps = direct_read_steps;
        i64 out = cells[0];
        return (out >= 0 && out < 256) ? (int)out : R_BOTTOM;
    }
    journal_begin();

    i64 event = 0;
    int finished = run(pc_out, &event);
    i64 out = mem_get(1);
    journal_rollback();                            /* a read never commits */

    if (!finished) return R_UNFINISHED;
    if (event != EV_EMIT) return R_BOTTOM;
    return (out >= 0 && out < 256) ? (int)out : R_BOTTOM;
}

EXPORT int vm_feed(int byte)
{
    if (dead) return R_DEAD;
    if (byte < 0 || byte > 255) return R_DEAD;
    exhausted = 0;
    if (direct_byte_state) {
        if (budget < 1) {
            last_steps = 0;
            exhausted = 1;
            return R_UNFINISHED;
        }
        cells[0] = (i64)byte;
        last_steps = 1;
        return R_COMMITTED;
    }
    journal_begin();

    if (!mem_set(0, (i64)byte)) { journal_rollback(); dead = 1; return R_DEAD; }

    i64 event = 0;
    int finished = run(pc_feed, &event);
    if (!finished) { journal_rollback(); return R_UNFINISHED; }
    if (event != EV_COMMIT) {
        journal_rollback();
        dead = 1;                                  /* the fixed dead residual */
        return R_DEAD;
    }
    journal_begin();                               /* the writes are now real */
    return R_COMMITTED;
}

EXPORT void vm_set_budget(u32 high, u32 low)
{
    budget = ((u64)high << 32) | (u64)low;
}

EXPORT u32 vm_steps_low(void)  { return (u32)(last_steps & 0xFFFFFFFFull); }
EXPORT u32 vm_steps_high(void) { return (u32)(last_steps >> 32); }
EXPORT int vm_overflowed(void) { return overflowed; }
/* Set when a write had nowhere to go.  That is this module's limit, not a
 * statement about the artifact, and the two must not be reported alike. */
EXPORT int vm_table_full(void) { return table_full; }
EXPORT int vm_exhausted(void)  { return exhausted; }
EXPORT int vm_dead(void)       { return dead; }
