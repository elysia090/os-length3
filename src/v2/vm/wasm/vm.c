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
#define I64_MAX_VALUE ((i64)(((u64)1 << 63) - 1))
#define I64_MIN_VALUE (-I64_MAX_VALUE - 1)

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

/* One coefficient per physical cell is the affine SSA residual over Byte.
 * Epoch tags make each proof proportional to cells actually reached by the
 * observer; the 2^20 coordinate space is never cleared or hashed. */
static u32 affine_tag[CAP];
static i64 affine_step[CAP];
static u32 affine_epoch = 1;

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

/* Consume the zero prefix a byte coordinate at a time.  Aligning the current
 * byte under CLZ preserves the MSB-first bit order while avoiding a separate
 * memory load and state materialization for every zero bit.  The terminating
 * one is consumed as part of the result. */
static u32 bit_zero_run(void)
{
    u32 zeros = 0;
    while (bits_at < bits_len && zeros < 64u) {
        u32 offset = (u32)(bits_at & 7u);
        u32 take = 8u - offset;
        u64 available = bits_len - bits_at;
        if ((u64)take > available) take = (u32)available;
        u32 chunk = ((u32)bits_base[bits_at >> 3] << offset) & 255u;
        if (chunk) {
            u32 in_byte = (u32)__builtin_clz(chunk) - 24u;
            if (in_byte < take) {
                bits_at += (u64)in_byte + 1u;
                return zeros + in_byte;
            }
        }
        bits_at += take;
        zeros += take;
    }
    bits_bad = 1;
    return 0;
}

static u64 bit_take(u32 count)
{
    if ((u64)count > bits_len - bits_at) {
        bits_bad = 1;
        return 0;
    }
    u64 value = 0;
    while (count) {
        u32 offset = (u32)(bits_at & 7u);
        u32 take = 8u - offset;
        if (take > count) take = count;
        u32 shift = 8u - offset - take;
        u32 part = ((u32)bits_base[bits_at >> 3] >> shift)
                 & ((1u << take) - 1u);
        value = (value << take) | part;
        bits_at += take;
        count -= take;
    }
    return value;
}

static u64 decode_scalar(void)
{
    if (bits_bad || bits_at >= bits_len) { bits_bad = 1; return 0; }
    if (!bit_next()) return 0;                         /* E(0) */
    u32 zeros = bit_zero_run();
    if (bits_bad) return 0;
    return (1ull << zeros) | bit_take(zeros);
}

/* ---------------------------------------------------------------- image ---
 * E(k) || E(pc_o) || E(pc_a) || (E(gap) || E(zigzag(value)))^k, with strictly
 * increasing addresses and no zero-valued entry.  Anything else is dead.
 */

static i64 pc_out, pc_feed;
static int dead = 1;
static int load_error;

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
    load_error = 0;
    direct_byte_state = 0;
    direct_read_steps = 0;

    bits_base = artifact;
    bits_len  = (u64)byte_len * 8ull;
    bits_at   = 0;
    bits_bad  = 0;

    /* code(z) = E(|z|) || z, then a shorter-than-byte all-zero pad. */
    u64 payload_bits = decode_scalar();
    if (bits_bad) { load_error = 1; return 0; }
    u64 payload_start = bits_at;
    if (payload_start + payload_bits > bits_len) { load_error = 2; return 0; }
    u64 payload_end = payload_start + payload_bits;
    if (bits_len - payload_end >= 8) { load_error = 3; return 0; }
    for (u64 i = payload_end; i < bits_len; ++i) {
        bits_at = i;
        if (bit_next()) { load_error = 3; return 0; } /* nonzero pad */
    }

    bits_len = payload_end;                        /* the image ends here */
    bits_at  = payload_start;

    u64 count = decode_scalar();
    u64 out   = decode_scalar();
    u64 feed  = decode_scalar();
    if (bits_bad) { load_error = 4; return 0; }

    i64 address = -1;
    journaling = 0;
    for (u64 i = 0; i < count; ++i) {
        u64 gap   = decode_scalar();
        u64 point = decode_scalar();
        if (bits_bad) {
            load_error = 5; journaling = 1; mem_clear(); return 0;
        }
        address += 1 + (i64)gap;
        i64 value = unzigzag(point);
        /* no canonical image */
        if (value == 0) {
            load_error = 6; journaling = 1; mem_clear(); return 0;
        }
        if (!mem_set(address, value)) {
            load_error = 7; journaling = 1; mem_clear(); return 0;
        }
    }
    journaling = 1;
    if (bits_at != bits_len) { load_error = 8; mem_clear(); return 0; }

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

struct affine_value { i64 base, step; };

static struct affine_value affine_get(i64 address)
{
    struct affine_value value;
    value.base = mem_get(address);
    value.step = (address >= 0 && (u64)address < CAP
                  && affine_tag[address] == affine_epoch)
        ? affine_step[address] : 0;
    return value;
}

static int affine_range(struct affine_value value, i64 *low, i64 *high)
{
    i64 delta, end;
    if (value.step > I64_MAX_VALUE / 255
            || value.step < I64_MIN_VALUE / 255) return 0;
    delta = value.step * 255;
    if (__builtin_saddll_overflow(value.base, delta, &end)) return 0;
    *low = value.base < end ? value.base : end;
    *high = value.base > end ? value.base : end;
    return 1;
}

/* Prove the byte-register state step over its complete finite input domain.
 * The feed row first proves that the persistent state is the final byte. The
 * observer is then interpreted once over affine SSA values `base + step*byte`.
 * Uniform branches retain one path; a branch whose two targets coincide needs
 * no predicate. An identity affine output proves all 256 bytes without
 * materializing or hashing a 256-state table. */
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
    u64 steps = 0;
    i64 event = 0;
    i64 pc = pc_out;

    affine_epoch += 1u;
    if (!affine_epoch) {
        for (u32 i = 0; i < CAP; ++i) affine_tag[i] = 0;
        affine_epoch = 1;
    }
    journal_begin();
    if (!mem_set(0, 0)) goto affine_fail;
    affine_tag[0] = affine_epoch;
    affine_step[0] = 1;

    for (;;) {
        if (steps >= budget) goto affine_fail;
        steps += 1;

        struct affine_value av = affine_get(pc);
        struct affine_value bv = affine_get(pc + 1);
        struct affine_value cv = affine_get(pc + 2);
        if (av.step || bv.step || cv.step) goto affine_fail;
        a = av.base;
        i64 b = bv.base;
        i64 c = cv.base;
        if (a < 0 || b < 0) goto affine_fail;

        struct affine_value left = affine_get(a);
        struct affine_value right = affine_get(b);
        struct affine_value result;
        if (__builtin_ssubll_overflow(right.base, left.base, &result.base)
                || __builtin_ssubll_overflow(right.step, left.step,
                                              &result.step))
            goto affine_fail;
        i64 low, high;
        if (!affine_range(result, &low, &high)) goto affine_fail;
        if (!mem_set(b, result.base)) goto affine_fail;
        affine_tag[b] = affine_epoch;
        affine_step[b] = result.step;

        if (low > 0 || (high > 0 && c == pc + 3)) {
            pc += 3;
            continue;
        }
        if (high <= 0 && c >= 0) {
            pc = c;
            continue;
        }
        if (high <= 0) {
            event = c;
            break;
        }
        goto affine_fail;
    }

    {
        struct affine_value out = affine_get(1);
        if (event != EV_EMIT || out.base != 0 || out.step != 1)
            goto affine_fail;
    }

    journal_rollback();
    last_steps = saved_steps;
    overflowed = saved_overflowed;
    exhausted = saved_exhausted;
    table_full = saved_table_full;
    journal_begin();
    direct_read_steps = steps;
    return 1;

affine_fail:
    journal_rollback();
    last_steps = saved_steps;
    overflowed = saved_overflowed;
    exhausted = saved_exhausted;
    table_full = saved_table_full;
    journal_begin();
    return 0;
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

/* --------------------------------------------------------- kernel ABI ---
 * A minimized scalar kernel is driven as one fixed-width byte history. Keep
 * that loop in wasm: importing one of these exports into the driver gives the
 * engine a direct wasm-to-wasm call instead of a JavaScript callback for every
 * kernel invocation and every byte.
 *
 * Up to 16 input bits have a finite domain of at most 65,536 words. The cache
 * below is exact over that whole domain; tags make changing artifacts O(1).
 * `direct_byte_state` is stronger: its exhaustive 256-byte proof says every
 * non-empty history denotes its final byte (one physical transition row), so
 * Byte* needs no table lookup or replay at all.
 */
#define EVAL_CACHE_SIZE (1u << 16)
static u32 eval_tag[EVAL_CACHE_SIZE];
static u64 eval_value[EVAL_CACHE_SIZE];
static u32 eval_epoch = 1;
static u32 eval_artifact_len;
static u32 eval_input_bits;
static u32 eval_input_bytes;
static u32 eval_output_bytes;
static u32 eval_calls;
static u32 eval_misses;
static int eval_ok;
static int eval_right_zero;

EXPORT int vm_prepare_eval(u32 byte_len, u32 input_bits,
                           u32 input_bytes, u32 output_bytes)
{
    eval_ok = 0;
    eval_calls = 0;
    eval_misses = 0;
    if (!byte_len || input_bits > 64u || !input_bytes || input_bytes > 8u
            || !output_bytes || output_bytes > 8u) return 0;
    eval_artifact_len = byte_len;
    eval_input_bits = input_bits;
    eval_input_bytes = input_bytes;
    eval_output_bytes = output_bytes;
    eval_epoch += 1u;
    if (!eval_epoch) {
        for (u32 i = 0; i < EVAL_CACHE_SIZE; ++i) eval_tag[i] = 0;
        eval_epoch = 1;
    }
    if (!vm_load(byte_len)) return 0;
    eval_right_zero = direct_byte_state;
    eval_ok = 1;
    return 1;
}

static u64 eval_word(u64 input)
{
    eval_calls += 1u;
    if (!eval_ok) return 0;
    if (eval_input_bits < 64u) input &= (1ull << eval_input_bits) - 1ull;

    u32 key = (u32)input;
    int cacheable = eval_input_bits <= 16u;
    if (cacheable && eval_tag[key] == eval_epoch) return eval_value[key];
    eval_misses += 1u;

    u64 out = 0;
    if (eval_right_zero) {
        /* Every feed is the constant map for its byte. A read gives that byte;
         * the ABI's zero feeds between later reads select zero. */
        out = (input >> (8u * (eval_input_bytes - 1u))) & 255u;
    } else {
        if (!vm_load(eval_artifact_len)) { eval_ok = 0; return 0; }
        for (u32 i = 0; i < eval_input_bytes; ++i) {
            if (vm_feed((int)((input >> (8u * i)) & 255u)) != R_COMMITTED) {
                eval_ok = 0;
                return 0;
            }
        }
        for (u32 i = 0; i < eval_output_bytes; ++i) {
            int byte = vm_read();
            if (byte < 0) { eval_ok = 0; return 0; }
            out |= (u64)(u32)byte << (8u * i);
            if (i + 1u < eval_output_bytes && vm_feed(0) != R_COMMITTED) {
                eval_ok = 0;
                return 0;
            }
        }
    }

    if (cacheable) {
        eval_value[key] = out;
        eval_tag[key] = eval_epoch;
    }
    return out;
}

EXPORT u32 vm_eval_i32_i32(u32 input) { return (u32)eval_word(input); }
EXPORT u64 vm_eval_i32_i64(u32 input) { return eval_word((u64)input); }
EXPORT u32 vm_eval_i64_i32(u64 input) { return (u32)eval_word(input); }
EXPORT u64 vm_eval_i64_i64(u64 input) { return eval_word(input); }
EXPORT u32 vm_eval_calls(void) { return eval_calls; }
EXPORT u32 vm_eval_misses(void) { return eval_misses; }
EXPORT int vm_eval_ok(void) { return eval_ok; }

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
EXPORT int vm_load_error(void) { return load_error; }
EXPORT int vm_exhausted(void)  { return exhausted; }
EXPORT int vm_dead(void)       { return dead; }
