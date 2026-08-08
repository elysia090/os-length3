/* Pinf-R codec -> image -> vm, as one freestanding wasm32 module.
 *
 * This is the fast half.  `pinf/codec.py`, `pinf/image.py` and `pinf/vm.py`
 * are the definition; this file has to agree with them on every byte, and
 * `tests/test_pinf.py` is what holds it to that rather than assuming it.
 *
 * Three deliberate departures from the specification, all of them reported
 * rather than hidden:
 *
 *   * Values are i64, not unbounded.  The specification forbids an integer
 *     wrapping into a second image, so a subtraction that would overflow ends
 *     the call as a finite failure and raises a flag instead of wrapping.
 *   * Memory is a fixed open-addressing table.  Running out of it is a
 *     reported failure, never a silent eviction.
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

/* Outcomes shared with the JS and Python sides. */
#define R_BOTTOM     -1
#define R_UNFINISHED -2
#define R_DEAD        0
#define R_COMMITTED   1

/* Branch targets below zero are invocation events. */
#define EV_EMIT   -1
#define EV_COMMIT -2

/* -------------------------------------------------------------- memory ---
 * Open addressing over i64 addresses.  A slot may be occupied and hold zero:
 * deleting on a zero write would cost a tombstone pass and buys nothing, since
 * a read of an absent cell and a read of a zero cell are the same value.  Only
 * serialization cares about the difference, and this module never serializes.
 */

#define CAP_BITS 17
#define CAP      (1u << CAP_BITS)
#define CAP_MASK (CAP - 1u)

static i64 slot_key[CAP];
static i64 slot_val[CAP];
static u8  slot_used[CAP];
static u32 live;

/* Undo log, so a discarded read costs the writes it made and not a copy of
 * the whole table. */
#define JCAP (1u << 18)
static u32 j_slot[JCAP];
static i64 j_key[JCAP];
static i64 j_val[JCAP];
static u8  j_used[JCAP];
static u32 j_n;

static int overflowed;
static int exhausted;
static u64 budget = 1ull << 22;
static u64 last_steps;

static u32 hash_slot(i64 address)
{
    u64 x = (u64)address * 0x9E3779B97F4A7C15ull;
    x ^= x >> 29;
    x *= 0xBF58476D1CE4E5B9ull;
    x ^= x >> 32;
    return (u32)x & CAP_MASK;
}

/* Slot for `address`: the one holding it, or the first free slot on its probe
 * path.  Returns CAP when the table is full. */
static u32 find(i64 address)
{
    u32 i = hash_slot(address);
    for (u32 probe = 0; probe < CAP; ++probe) {
        if (!slot_used[i] || slot_key[i] == address) return i;
        i = (i + 1u) & CAP_MASK;
    }
    return CAP;
}

static i64 mem_get(i64 address)
{
    u32 i = find(address);
    if (i == CAP || !slot_used[i]) return 0;
    return slot_val[i];
}

static int mem_set(i64 address, i64 value)
{
    u32 i = find(address);
    if (i == CAP) return 0;
    if (j_n < JCAP) {
        j_slot[j_n] = i;
        j_key[j_n]  = slot_key[i];
        j_val[j_n]  = slot_val[i];
        j_used[j_n] = slot_used[i];
        j_n += 1;
    } else {
        return 0;                      /* cannot promise a rollback */
    }
    if (!slot_used[i]) {
        /* Keep a headroom margin: a full table probes forever. */
        if (live + 1u >= (CAP - (CAP >> 2))) return 0;
        slot_used[i] = 1;
        slot_key[i]  = address;
        live += 1u;
    }
    slot_val[i] = value;
    return 1;
}

static void journal_begin(void) { j_n = 0; }

static void journal_rollback(void)
{
    while (j_n) {
        j_n -= 1;
        u32 i = j_slot[j_n];
        if (slot_used[i] && !j_used[j_n]) live -= 1u;
        slot_key[i]  = j_key[j_n];
        slot_val[i]  = j_val[j_n];
        slot_used[i] = j_used[j_n];
    }
}

static void mem_clear(void)
{
    for (u32 i = 0; i < CAP; ++i) { slot_used[i] = 0; slot_val[i] = 0; }
    live = 0;
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

static u64 decode_scalar(void)
{
    if (bits_bad) return 0;
    if (!bit_next()) return 0;                     /* E(0) */

    /* Count the zero run, then take the bit that ends it as the leading
     * payload bit.  Running out here is malformed, not a short word: `1` alone
     * is not E(1), and accepting it would make this disagree with the
     * reference about which artifacts are dead. */
    u32 k = 0;
    for (;;) {
        if (bits_at >= bits_len) { bits_bad = 1; return 0; }
        if (bit_next()) break;
        k += 1;
        if (k > 63) { bits_bad = 1; return 0; }    /* wider than i64 */
    }
    if (bits_at + (u64)k > bits_len) { bits_bad = 1; return 0; }

    u64 value = 1;
    for (u32 i = 0; i < k; ++i) value = (value << 1) | bit_next();
    return bits_bad ? 0 : value;
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

EXPORT u8 *pinf_buffer(void);
static u8 artifact[1u << 20];

EXPORT u8 *pinf_buffer(void) { return artifact; }

EXPORT int pinf_load(u32 byte_len)
{
    mem_clear();
    dead = 1;
    overflowed = 0;
    exhausted = 0;

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
    for (u64 i = 0; i < count; ++i) {
        u64 gap   = decode_scalar();
        u64 point = decode_scalar();
        if (bits_bad) { mem_clear(); return 0; }
        address += 1 + (i64)gap;
        i64 value = unzigzag(point);
        if (value == 0) { mem_clear(); return 0; } /* no canonical image */
        if (!mem_set(address, value)) { mem_clear(); return 0; }
    }
    if (bits_at != bits_len) { mem_clear(); return 0; }

    journal_begin();                               /* the load is committed */
    pc_out  = (i64)out;
    pc_feed = (i64)feed;
    dead = 0;
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

EXPORT int pinf_read(void)
{
    if (dead) return R_BOTTOM;
    exhausted = 0;
    journal_begin();

    i64 event = 0;
    int finished = run(pc_out, &event);
    i64 out = mem_get(1);
    journal_rollback();                            /* a read never commits */

    if (!finished) return R_UNFINISHED;
    if (event != EV_EMIT) return R_BOTTOM;
    return (out >= 0 && out < 256) ? (int)out : R_BOTTOM;
}

EXPORT int pinf_feed(int byte)
{
    if (dead) return R_DEAD;
    if (byte < 0 || byte > 255) return R_DEAD;
    exhausted = 0;
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

EXPORT void pinf_set_budget(u32 high, u32 low)
{
    budget = ((u64)high << 32) | (u64)low;
}

EXPORT u32 pinf_steps_low(void)  { return (u32)(last_steps & 0xFFFFFFFFull); }
EXPORT u32 pinf_steps_high(void) { return (u32)(last_steps >> 32); }
EXPORT int pinf_overflowed(void) { return overflowed; }
EXPORT int pinf_exhausted(void)  { return exhausted; }
EXPORT int pinf_dead(void)       { return dead; }
