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
#define JCAP (1u << 18)
#define EVAL_CACHE_SIZE (1u << 16)
#define ARTIFACT_BYTES (1u << 20)
#define EVAL_BATCH_BYTES (ARTIFACT_BYTES >> 2)
#define EVAL_SOURCE_OFFSET (ARTIFACT_BYTES >> 1)
#define EVAL_TARGET_OFFSET (EVAL_SOURCE_OFFSET + EVAL_BATCH_BYTES)
#define GUEST_PAGE_BYTES (1u << 16)
#define GUEST_CODE_PAGES 4u
#define GUEST_VALUE_CAP 4096u
#define STEP_PAGE_BYTES ARTIFACT_BYTES
#define STEP_VALUE_CAP GUEST_VALUE_CAP
#define STEP_COLUMN_COUNT 11u
#define STEP_MEMORY_PAGES 4u
#define STEP_NO_PAGE 0xffffffffu
#define STEP_NO_COORDINATE (~0ull)
#define STEP_RELATIVE_SAVE_CAP 4u
#define PROGRAM_FRAME_CAP 256u
#define PROGRAM_GLOBAL_CAP 4096u
#define STEP_SLOT_STATE_BITS 3u
#define STEP_SLOT_PIN_SHIFT STEP_SLOT_STATE_BITS
#define STEP_SLOT_PIN_BITS 9u
#define STEP_SLOT_EPOCH_SHIFT (STEP_SLOT_PIN_SHIFT + STEP_SLOT_PIN_BITS)
#define STEP_SLOT_PIN_MASK ((1u << STEP_SLOT_PIN_BITS) - 1u)
#define STEP_SLOT_EPOCH_LIMIT (1ull << (64u - STEP_SLOT_EPOCH_SHIFT))

enum StepSlotState {
    STEP_SLOT_EMPTY = 0,
    STEP_SLOT_CLEAN = 1,
    STEP_SLOT_DIRTY = 2,
    STEP_SLOT_LOADING = 3,
    STEP_SLOT_FLUSHING = 4,
    STEP_SLOT_RETIRED = 5,
};

/* The codec machine and a child Wasm machine have disjoint lifetimes. Keep
 * their large working sets in one physical workspace so adding the general
 * machine does not reserve a second linear-memory arena. */
typedef struct {
    i64 cells[CAP];
    u32 j_slot[JCAP];
    i64 j_val[JCAP];
    u32 affine_tag[CAP];
    i64 affine_step[CAP];
    u8 artifact[ARTIFACT_BYTES];
    u32 eval_tag[EVAL_CACHE_SIZE];
    u64 eval_value[EVAL_CACHE_SIZE];
} CodecWorkspace;

typedef struct {
    u8 code[GUEST_CODE_PAGES][GUEST_PAGE_BYTES];
    u32 code_page[GUEST_CODE_PAGES];
    u32 code_valid[GUEST_CODE_PAGES];
    u64 values[GUEST_VALUE_CAP];
    u64 locals[GUEST_VALUE_CAP];
    u32 code_bytes;
    u32 body_start;
    u32 body_end;
    u32 cursor;
    u32 requested_page;
    u32 stack_size;
    u32 local_count;
    u32 local_groups;
    u32 phase;
    u32 error;
    u64 result;
} GuestWorkspace;

/* One mapped QM state-step page and its transient SSA cut.  The page already
 * is structure-of-arrays physical code, so the runtime never reconstructs a
 * decoded Wasm instruction graph or scalar expression tree. */
typedef struct {
    u8 page[STEP_PAGE_BYTES];
    u8 memory[STEP_MEMORY_PAGES][GUEST_PAGE_BYTES];
    u8 memory_transfer[GUEST_PAGE_BYTES];
    u8 copy_buffer[GUEST_PAGE_BYTES];
    u64 values[STEP_VALUE_CAP + 1u];
    u64 locals[STEP_VALUE_CAP];
    u64 stack[STEP_VALUE_CAP];
    u32 column_offset[STEP_COLUMN_COUNT];
    u32 column_count[STEP_COLUMN_COUNT];
    u32 page_bytes;
    u32 function;
    u32 start;
    u32 end;
    u32 instructions;
    u32 span;
    u32 work;
    u32 operands;
    u32 stack_inputs;
    u32 stack_count;
    u32 local_extent;
    u32 local_updates;
    u64 memory_page[STEP_MEMORY_PAGES];
    u32 memory_valid[STEP_MEMORY_PAGES];
    u64 memory_state[STEP_MEMORY_PAGES];
    u64 memory_next_epoch[STEP_MEMORY_PAGES];
    u64 memory_last_ack_session[STEP_MEMORY_PAGES];
    u64 memory_last_ack_generation[STEP_MEMORY_PAGES];
    u64 memory_last_ack_lease[STEP_MEMORY_PAGES];
    u64 memory_last_ack_page[STEP_MEMORY_PAGES];
    u64 memory_bytes;
    u64 requested_memory_page;
    u64 flush_memory_page;
    u32 memory_page_shift;
    u32 memory_unbounded;
    u64 memory_generation;
    u64 memory_lease;
    u64 flush_memory_epoch;
    u32 memory_status;
    u32 execution_active;
    u32 execution_depth;
    u32 execution_lane;
    u32 repeat_active;
    u32 repeat_lane;
    u32 repeat_width;
    u32 repeat_phase;
    u64 repeat_address;
    u64 repeat_remaining;
    u64 repeat_pattern;
    u32 find_active;
    u32 find_lane;
    u32 find_first;
    u32 find_second;
    u64 find_address;
    u64 find_offset;
    u32 copy_active;
    u32 copy_lane;
    u32 copy_phase;
    u32 copy_sentinel;
    u32 copy_pending;
    u32 copy_pending_at;
    u32 copy_advance;
    u32 copy_last;
    u32 copy_hit;
    u64 copy_source;
    u64 copy_target;
    u64 copy_index;
    u64 copy_limit;
    u64 copy_target_end;
    u32 relative_active;
    u32 relative_node;
    u32 relative_completed_node;
    u32 relative_count;
    u32 relative_lane;
    u32 relative_phase;
    u32 relative_selector;
    u32 relative_mode;
    u32 relative_save_lane;
    u32 relative_restore_lane;
    u64 relative_left;
    u64 relative_right;
    u64 relative_delta;
    u64 relative_prior_flags;
    u64 relative_layout;
    u64 relative_save_address[STEP_RELATIVE_SAVE_CAP];
    u64 relative_saved_value[STEP_RELATIVE_SAVE_CAP];
    u64 relative_last_left;
    u64 relative_results[19];
    u32 error;
} StepWorkspace;

typedef struct {
    u32 function;
    u32 pc;
    u32 local_base;
    u32 local_count;
    u32 stack_base;
    u32 stack_count;
    u32 result_count;
} ProgramFrame;

/* Retained machine state around disposable STEP and barrier pages.  Calls
 * allocate locals above their caller and use the caller's stack end as the
 * callee stack base, so return only moves the result coordinates that survive
 * the cut. */
typedef struct {
    u64 locals[GUEST_VALUE_CAP];
    u64 stack[GUEST_VALUE_CAP];
    u64 globals[PROGRAM_GLOBAL_CAP];
    ProgramFrame frames[PROGRAM_FRAME_CAP];
    u32 function;
    u32 pc;
    u32 local_base;
    u32 local_count;
    u32 local_top;
    u32 stack_base;
    u32 stack_count;
    u32 result_count;
    u32 result_base;
    u32 global_count;
    u32 frame_count;
    u32 step_active;
    u32 active;
    u32 halted;
    u32 error;
} ProgramWorkspace;

typedef struct {
    GuestWorkspace guest;
    StepWorkspace step;
    ProgramWorkspace program;
} RuntimeWorkspace;

typedef union {
    CodecWorkspace codec;
    RuntimeWorkspace runtime;
} MachineWorkspace;

static MachineWorkspace workspace;
static u32 workspace_mode;
/* Capabilities are never reused. Exhaustion retires this instance instead of
 * wrapping: a fresh instance has a distinct host lifetime, so an old async
 * completion cannot name its workspace. */
static u64 step_next_capability = 1u;
static u64 step_session;
static u32 step_workspace_initialized;
#define cells       (workspace.codec.cells)
#define j_slot      (workspace.codec.j_slot)
#define j_val       (workspace.codec.j_val)
#define affine_tag  (workspace.codec.affine_tag)
#define affine_step (workspace.codec.affine_step)
#define artifact    (workspace.codec.artifact)
#define eval_tag    (workspace.codec.eval_tag)
#define eval_value  (workspace.codec.eval_value)

static u32 extent;                 /* how much of it this image uses */
static int table_full;

/* Undo log, so a discarded read costs the writes it made and not a copy of
 * the whole table. */
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

EXPORT u8 *vm_buffer(void) { return artifact; }

/* Build tools use this address to project a suspended module onto the cells
 * that can affect later feed/read calls. Codec buffers, undo-log contents and
 * counters are deliberately outside that state boundary. */
EXPORT u8 *vm_cells(void) { return (u8 *)cells; }
EXPORT int vm_direct_byte_state(void) { return direct_byte_state; }

/* -------------------------------------------------------------- sponge ---
 * Batch fixed-size records through one SHA3-256 residual state. Keeping the
 * 25 lanes and incomplete rate block here makes a whole batch one host call.
 *
 * Input in `artifact` is seed[32] followed by records of
 * additional[16] || time[8]. The first record starts with seed and later
 * records start with zero. Each record performs `rounds` chained SHA3-256
 * digests, then appends digest || time to the retained rate-block tail.
 */

#define SPONGE_RATE 136u
#define SPONGE_RECORD 24u
static u64 sponge_lanes[25];
static u8 sponge_tail[SPONGE_RATE];
static u32 sponge_tail_len;

static u64 load_u64(const u8 *source)
{
    u64 value = 0;
    for (u32 i = 0; i < 8u; ++i) value |= (u64)source[i] << (8u * i);
    return value;
}

static u64 rotate_left(u64 value, u32 count)
{
    return (value << count) | (value >> (64u - count));
}

static void permute_lanes(u64 lanes[25])
{
    static const u8 rotations[24] = {
        1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
        27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
    };
    static const u8 permutation[24] = {
        10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
        15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
    };
    static const u64 constants[24] = {
        0x0000000000000001ull, 0x0000000000008082ull,
        0x800000000000808aull, 0x8000000080008000ull,
        0x000000000000808bull, 0x0000000080000001ull,
        0x8000000080008081ull, 0x8000000000008009ull,
        0x000000000000008aull, 0x0000000000000088ull,
        0x0000000080008009ull, 0x000000008000000aull,
        0x000000008000808bull, 0x800000000000008bull,
        0x8000000000008089ull, 0x8000000000008003ull,
        0x8000000000008002ull, 0x8000000000000080ull,
        0x000000000000800aull, 0x800000008000000aull,
        0x8000000080008081ull, 0x8000000000008080ull,
        0x0000000080000001ull, 0x8000000080008008ull,
    };

    for (u32 round = 0; round < 24u; ++round) {
        u64 columns[5];
        for (u32 x = 0; x < 5u; ++x)
            columns[x] = lanes[x] ^ lanes[x + 5u] ^ lanes[x + 10u]
                       ^ lanes[x + 15u] ^ lanes[x + 20u];
        for (u32 x = 0; x < 5u; ++x) {
            u64 theta = columns[(x + 4u) % 5u]
                      ^ rotate_left(columns[(x + 1u) % 5u], 1u);
            lanes[x] ^= theta;
            lanes[x + 5u] ^= theta;
            lanes[x + 10u] ^= theta;
            lanes[x + 15u] ^= theta;
            lanes[x + 20u] ^= theta;
        }

        u64 carried = lanes[1];
        for (u32 i = 0; i < 24u; ++i) {
            u32 target = permutation[i];
            u64 displaced = lanes[target];
            lanes[target] = rotate_left(carried, rotations[i]);
            carried = displaced;
        }

        for (u32 row = 0; row < 25u; row += 5u) {
            u64 a0 = lanes[row], a1 = lanes[row + 1u];
            u64 a2 = lanes[row + 2u], a3 = lanes[row + 3u];
            u64 a4 = lanes[row + 4u];
            lanes[row] = a0 ^ (~a1 & a2);
            lanes[row + 1u] = a1 ^ (~a2 & a3);
            lanes[row + 2u] = a2 ^ (~a3 & a4);
            lanes[row + 3u] = a3 ^ (~a4 & a0);
            lanes[row + 4u] = a4 ^ (~a0 & a1);
        }
        lanes[0] ^= constants[round];
    }
}

static void sponge_absorb_tail(void)
{
    for (u32 i = 0; i < SPONGE_RATE / 8u; ++i)
        sponge_lanes[i] ^= load_u64(sponge_tail + 8u * i);
    permute_lanes(sponge_lanes);
    sponge_tail_len = 0;
}

static void sponge_append_byte(u8 value)
{
    sponge_tail[sponge_tail_len++] = value;
    if (sponge_tail_len == SPONGE_RATE) sponge_absorb_tail();
}

EXPORT u8 *vm_sponge_lanes(void) { return (u8 *)sponge_lanes; }
EXPORT u8 *vm_sponge_tail(void) { return sponge_tail; }
EXPORT u32 vm_sponge_tail_size(void) { return sponge_tail_len; }

EXPORT int vm_set_sponge_tail_size(u32 size)
{
    if (size >= SPONGE_RATE) return 0;
    sponge_tail_len = size;
    return 1;
}

EXPORT int vm_sponge_records(u32 count, u32 rounds)
{
    if (!rounds || rounds > 64u
            || count > ((u32)sizeof(artifact) - 32u) / SPONGE_RECORD)
        return 0;

    for (u32 record = 0; record < count; ++record) {
        u64 intermediary[4] = { 0, 0, 0, 0 };
        const u8 *entry = artifact + 32u + record * SPONGE_RECORD;
        if (!record)
            for (u32 i = 0; i < 4u; ++i)
                intermediary[i] = load_u64(artifact + 8u * i);

        for (u32 digest = 0; digest < rounds; ++digest) {
            u64 lanes[25] = { 0 };
            lanes[0] = intermediary[0];
            lanes[1] = intermediary[1];
            lanes[2] = intermediary[2];
            lanes[3] = intermediary[3];
            lanes[4] = load_u64(entry);
            lanes[5] = load_u64(entry + 8u);
            lanes[6] = 0x06u;
            lanes[16] = 0x8000000000000000ull;
            permute_lanes(lanes);
            for (u32 i = 0; i < 4u; ++i) intermediary[i] = lanes[i];
        }

        for (u32 i = 0; i < 4u; ++i)
            for (u32 byte = 0; byte < 8u; ++byte)
                sponge_append_byte((u8)(intermediary[i] >> (8u * byte)));
        for (u32 byte = 0; byte < 8u; ++byte)
            sponge_append_byte(entry[16u + byte]);
    }
    return 1;
}

static int detect_direct_byte_state(void);

static int enter_codec_workspace(void)
{
    if (step_session) return 0;
    if (workspace_mode) {
        u32 bytes = (u32)sizeof(RuntimeWorkspace);
        u32 touched = (bytes + sizeof(i64) - 1u) / sizeof(i64);
        if (extent < touched) extent = touched;
    }
    mem_clear();
    workspace_mode = 0;
    step_workspace_initialized = 0;
    return 1;
}

EXPORT int vm_load(u32 byte_len)
{
    if (byte_len > ARTIFACT_BYTES) return 0;
    if (!enter_codec_workspace()) return 0;
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

/* ------------------------------------------------------ child WebAssembly ---
 * Only this module is instantiated by the browser. Child Wasm bytes remain in
 * an authenticated page source and enter this direct four-slot code cache on
 * demand. The first implementation executes flat integer function bodies;
 * control, calls, memory and host operations are explicit future barriers,
 * never implicit native WebAssembly fallbacks.
 */
#define GUEST_CONTINUE 0
#define GUEST_CODE_PAGE 1
#define GUEST_RETURNED 2
#define GUEST_TRAP -1
#define GUEST_NO_PAGE 0xFFFFFFFFu

static GuestWorkspace *guest(void) { return &workspace.runtime.guest; }

static void guest_trap(u32 error)
{
    guest()->error = error;
    guest()->phase = 5u;
}

static int guest_byte(u32 at, u8 *value)
{
    GuestWorkspace *machine = guest();
    if (at >= machine->code_bytes) { guest_trap(2u); return 0; }
    u32 page = at >> 16;
    u32 slot = page & (GUEST_CODE_PAGES - 1u);
    if (machine->code_page[slot] != page) {
        machine->requested_page = page;
        return 0;
    }
    u32 within = at & (GUEST_PAGE_BYTES - 1u);
    if (within >= machine->code_valid[slot]) {
        guest_trap(2u);
        return 0;
    }
    *value = machine->code[slot][within];
    return 1;
}

static int guest_uleb(u32 start, u32 bits, u64 *value, u32 *next)
{
    u64 result = 0;
    u32 shift = 0;
    u32 at = start;
    for (;;) {
        u8 byte;
        if (!guest_byte(at, &byte)) return 0;
        at += 1u;
        if (shift >= bits && (byte & 0x7fu)) { guest_trap(3u); return 0; }
        if (shift < 64u) result |= (u64)(byte & 0x7fu) << shift;
        if (!(byte & 0x80u)) {
            *value = result;
            *next = at;
            return 1;
        }
        shift += 7u;
        if (shift > bits + 7u) { guest_trap(3u); return 0; }
    }
}

static int guest_sleb(u32 start, u32 bits, i64 *value, u32 *next)
{
    u64 result = 0;
    u32 shift = 0;
    u32 at = start;
    u8 byte = 0;
    for (;;) {
        if (!guest_byte(at, &byte)) return 0;
        at += 1u;
        if (shift >= bits && (byte & 0x7fu) != (byte & 0x40u ? 0x7fu : 0u)) {
            guest_trap(3u);
            return 0;
        }
        if (shift < 64u) result |= (u64)(byte & 0x7fu) << shift;
        shift += 7u;
        if (!(byte & 0x80u)) break;
        if (shift > bits + 7u) { guest_trap(3u); return 0; }
    }
    if (shift < 64u && (byte & 0x40u)) result |= ~0ull << shift;
    if (bits == 32u) result = (u64)(i64)(int)(u32)result;
    *value = (i64)result;
    *next = at;
    return 1;
}

static int guest_push(u64 value)
{
    GuestWorkspace *machine = guest();
    if (machine->stack_size >= GUEST_VALUE_CAP) {
        guest_trap(4u);
        return 0;
    }
    machine->values[machine->stack_size++] = value;
    return 1;
}

static int guest_pop(u64 *value)
{
    GuestWorkspace *machine = guest();
    if (!machine->stack_size) { guest_trap(4u); return 0; }
    *value = machine->values[--machine->stack_size];
    return 1;
}

static u32 rotate_left32(u32 value, u32 count)
{
    count &= 31u;
    return count ? (value << count) | (value >> (32u - count)) : value;
}

static u64 rotate_left64(u64 value, u32 count)
{
    count &= 63u;
    return count ? (value << count) | (value >> (64u - count)) : value;
}

EXPORT u8 *vm_guest_page_buffer(void)
{
    GuestWorkspace *machine = guest();
    u32 page = machine->requested_page == GUEST_NO_PAGE
             ? 0u : machine->requested_page;
    return machine->code[page & (GUEST_CODE_PAGES - 1u)];
}

EXPORT u64 *vm_guest_values(void) { return guest()->values; }
EXPORT u32 vm_guest_requested_page(void) { return guest()->requested_page; }
EXPORT u32 vm_guest_error(void) { return guest()->error; }
EXPORT u64 vm_guest_result(void) { return guest()->result; }

EXPORT int vm_guest_open(u32 code_bytes, u32 body_start, u32 body_end)
{
    if (step_session || code_bytes < 8u || body_start >= body_end
            || body_end > code_bytes)
        return 0;
    if (!workspace_mode) step_workspace_initialized = 0;
    workspace_mode = 1u;
    GuestWorkspace *machine = guest();
    machine->code_bytes = code_bytes;
    machine->body_start = body_start;
    machine->body_end = body_end;
    machine->cursor = 0;
    machine->requested_page = GUEST_NO_PAGE;
    machine->stack_size = 0;
    machine->local_count = 0;
    machine->local_groups = 0;
    machine->phase = 0;
    machine->error = 0;
    machine->result = 0;
    for (u32 slot = 0; slot < GUEST_CODE_PAGES; ++slot) {
        machine->code_page[slot] = GUEST_NO_PAGE;
        machine->code_valid[slot] = 0;
    }
    return 1;
}

EXPORT int vm_guest_begin(u32 arguments)
{
    GuestWorkspace *machine = guest();
    if (workspace_mode != 1u || arguments > GUEST_VALUE_CAP) return 0;
    for (u32 index = arguments; index; --index)
        machine->locals[index - 1u] = machine->values[index - 1u];
    machine->local_count = arguments;
    machine->stack_size = 0;
    machine->cursor = 0;
    machine->phase = 0;
    machine->error = 0;
    return 1;
}

EXPORT int vm_guest_supply_code(u32 page, u32 bytes)
{
    GuestWorkspace *machine = guest();
    u32 first = page << 16;
    u32 expected = machine->code_bytes - first;
    if (first >= machine->code_bytes) return 0;
    if (expected > GUEST_PAGE_BYTES) expected = GUEST_PAGE_BYTES;
    if (bytes != expected || page != machine->requested_page) return 0;
    u32 slot = page & (GUEST_CODE_PAGES - 1u);
    machine->code_page[slot] = page;
    machine->code_valid[slot] = bytes;
    machine->requested_page = GUEST_NO_PAGE;
    return 1;
}

EXPORT int vm_guest_step(u32 budget)
{
    GuestWorkspace *machine = guest();
    if (workspace_mode != 1u || machine->phase == 5u) return GUEST_TRAP;
    if (machine->phase == 4u) return GUEST_RETURNED;

    if (machine->phase == 0u) {
        static const u8 header[8] = { 0, 0x61, 0x73, 0x6d, 1, 0, 0, 0 };
        for (u32 index = 0; index < 8u; ++index) {
            u8 value;
            if (!guest_byte(index, &value))
                return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;
            if (value != header[index]) { guest_trap(1u); return GUEST_TRAP; }
        }
        machine->cursor = machine->body_start;
        machine->phase = 1u;
    }

    if (machine->phase == 1u) {
        u64 groups;
        u32 next;
        if (!guest_uleb(machine->cursor, 32u, &groups, &next))
            return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;
        if (groups > GUEST_VALUE_CAP) { guest_trap(5u); return GUEST_TRAP; }
        machine->local_groups = (u32)groups;
        machine->cursor = next;
        machine->phase = 2u;
    }

    while (machine->phase == 2u && machine->local_groups) {
        u64 count;
        u32 next;
        u8 type;
        if (!guest_uleb(machine->cursor, 32u, &count, &next)
                || !guest_byte(next, &type))
            return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;
        if ((type != 0x7fu && type != 0x7eu)
                || count > GUEST_VALUE_CAP - machine->local_count) {
            guest_trap(5u);
            return GUEST_TRAP;
        }
        for (u32 index = 0; index < (u32)count; ++index)
            machine->locals[machine->local_count++] = 0;
        machine->cursor = next + 1u;
        machine->local_groups -= 1u;
    }
    if (machine->phase == 2u) machine->phase = 3u;

    while (machine->phase == 3u && budget) {
        u32 at = machine->cursor;
        u8 opcode;
        u64 left, right, index;
        i64 constant;
        if (at >= machine->body_end) { guest_trap(2u); return GUEST_TRAP; }
        if (!guest_byte(at++, &opcode))
            return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;

        if (opcode == 0x0bu || opcode == 0x0fu) {
            machine->cursor = at;
            machine->result = machine->stack_size
                              ? machine->values[machine->stack_size - 1u] : 0;
            machine->phase = 4u;
            return GUEST_RETURNED;
        } else if (opcode == 0x01u) {
            /* nop */
        } else if (opcode == 0x1au) {
            if (!guest_pop(&left)) return GUEST_TRAP;
        } else if (opcode == 0x20u || opcode == 0x21u || opcode == 0x22u) {
            if (!guest_uleb(at, 32u, &index, &at))
                return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;
            if (index >= machine->local_count) { guest_trap(5u); return GUEST_TRAP; }
            if (opcode == 0x20u) {
                if (!guest_push(machine->locals[index])) return GUEST_TRAP;
            } else {
                if (!guest_pop(&left)) return GUEST_TRAP;
                machine->locals[index] = left;
                if (opcode == 0x22u && !guest_push(left)) return GUEST_TRAP;
            }
        } else if (opcode == 0x41u || opcode == 0x42u) {
            if (!guest_sleb(at, opcode == 0x41u ? 32u : 64u, &constant, &at))
                return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;
            if (!guest_push((u64)constant)) return GUEST_TRAP;
        } else if (opcode == 0x45u || opcode == 0x50u) {
            if (!guest_pop(&left) || !guest_push(left == 0)) return GUEST_TRAP;
        } else {
            if (!guest_pop(&right) || !guest_pop(&left)) return GUEST_TRAP;
            if (opcode == 0x6au) left = (u32)left + (u32)right;
            else if (opcode == 0x6bu) left = (u32)left - (u32)right;
            else if (opcode == 0x6cu) left = (u32)left * (u32)right;
            else if (opcode == 0x71u) left = (u32)left & (u32)right;
            else if (opcode == 0x72u) left = (u32)left | (u32)right;
            else if (opcode == 0x73u) left = (u32)left ^ (u32)right;
            else if (opcode == 0x74u) left = (u32)left << ((u32)right & 31u);
            else if (opcode == 0x75u) left = (u32)((int)(u32)left >> ((u32)right & 31u));
            else if (opcode == 0x76u) left = (u32)left >> ((u32)right & 31u);
            else if (opcode == 0x77u) left = rotate_left32((u32)left, (u32)right);
            else if (opcode == 0x78u) left = rotate_left32((u32)left, 0u - (u32)right);
            else if (opcode == 0x7cu) left += right;
            else if (opcode == 0x7du) left -= right;
            else if (opcode == 0x7eu) left *= right;
            else if (opcode == 0x83u) left &= right;
            else if (opcode == 0x84u) left |= right;
            else if (opcode == 0x85u) left ^= right;
            else if (opcode == 0x86u) left <<= (u32)right & 63u;
            else if (opcode == 0x87u) left = (u64)((i64)left >> ((u32)right & 63u));
            else if (opcode == 0x88u) left >>= (u32)right & 63u;
            else if (opcode == 0x89u) left = rotate_left64(left, (u32)right);
            else if (opcode == 0x8au) left = rotate_left64(left, 0u - (u32)right);
            else { guest_trap(6u); return GUEST_TRAP; }
            if (!guest_push(left)) return GUEST_TRAP;
        }
        machine->cursor = at;
        budget -= 1u;
    }
    return GUEST_CONTINUE;
}

/* --------------------------------------------------- physical state step ---
 * STEP v3 is the disposable execution projection emitted by qm.steppage. Its
 * eleven fixed-width columns are consumed in place. Only the input and output
 * cut crosses the ABI; intermediate SSA values stay in this workspace.
 */
#define STEP_HEADER_BYTES 144u
#define STEP_MEMORY_PAGE 1
#define STEP_OK 2
#define STEP_DIRTY_PAGE 3
#define STEP_TRAP -1
#define BARRIER_HEADER_BYTES 48u
#define BARRIER_GLOBAL_GET 1u
#define BARRIER_GLOBAL_SET 2u
#define BARRIER_CALL 3u
#define BARRIER_RETURN 4u

enum StepColumn {
    STEP_WAVE_OFFSETS = 0,
    STEP_LANE_VALUES,
    STEP_OPCODES,
    STEP_ARGUMENT_OFFSETS,
    STEP_OPERAND_TAGS,
    STEP_OPERAND_VALUES,
    STEP_STACK_TAGS,
    STEP_STACK_VALUES,
    STEP_LOCAL_INDICES,
    STEP_LOCAL_TAGS,
    STEP_LOCAL_VALUES,
};

static StepWorkspace *step_machine(void) { return &workspace.runtime.step; }

static u64 step_new_capability(void)
{
    u64 capability = step_next_capability;
    if (!capability || capability == ~0ull) {
        step_next_capability = 0;
        return 0;
    }
    step_next_capability = capability + 1u;
    return capability;
}

static int step_session_is(u64 session)
{
    return session && step_session == session && workspace_mode == 2u;
}

static u32 step_slot_kind(u64 word)
{
    return (u32)word & ((1u << STEP_SLOT_STATE_BITS) - 1u);
}

static u32 step_slot_pins(u64 word)
{
    return (u32)(word >> STEP_SLOT_PIN_SHIFT) & STEP_SLOT_PIN_MASK;
}

static u64 step_slot_epoch(u64 word)
{
    return word >> STEP_SLOT_EPOCH_SHIFT;
}

static u64 step_slot_word(u32 kind, u32 pins, u64 epoch)
{
    return (epoch << STEP_SLOT_EPOCH_SHIFT)
         | (u64)pins << STEP_SLOT_PIN_SHIFT | kind;
}

/* A normal build has one reactor agent, so these are ordinary accesses. A
 * shared-memory build uses the same state word with acquire/release ordering;
 * no adjacent tag or extent is read until ownership has been acquired. */
static u64 step_slot_load(StepWorkspace *machine, u32 slot)
{
#if defined(__wasm_atomics__)
    return __atomic_load_n(&machine->memory_state[slot], __ATOMIC_ACQUIRE);
#else
    return machine->memory_state[slot];
#endif
}

static void step_slot_store(StepWorkspace *machine, u32 slot, u64 word)
{
#if defined(__wasm_atomics__)
    __atomic_store_n(&machine->memory_state[slot], word, __ATOMIC_RELEASE);
#else
    machine->memory_state[slot] = word;
#endif
}

static int step_slot_change(StepWorkspace *machine, u32 slot,
                            u64 *expected, u64 desired)
{
#if defined(__wasm_atomics__)
    return __atomic_compare_exchange_n(
        &machine->memory_state[slot], expected, desired, 0,
        __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
#else
    if (machine->memory_state[slot] != *expected) {
        *expected = machine->memory_state[slot];
        return 0;
    }
    machine->memory_state[slot] = desired;
    return 1;
#endif
}

static void step_memory_slots_empty(StepWorkspace *machine)
{
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        machine->memory_page[slot] = STEP_NO_COORDINATE;
        machine->memory_valid[slot] = 0;
        machine->memory_next_epoch[slot] = 1u;
        machine->memory_last_ack_session[slot] = 0;
        machine->memory_last_ack_generation[slot] = 0;
        machine->memory_last_ack_lease[slot] = 0;
        machine->memory_last_ack_page[slot] = STEP_NO_COORDINATE;
        step_slot_store(machine, slot,
                        step_slot_word(STEP_SLOT_EMPTY, 0, 0));
    }
}

static u32 read_u16(const u8 *source)
{
    return (u32)source[0] | (u32)source[1] << 8;
}

static u32 read_u32(const u8 *source)
{
    return (u32)source[0] | (u32)source[1] << 8
         | (u32)source[2] << 16 | (u32)source[3] << 24;
}

static u32 step_u32(u32 column, u32 index)
{
    StepWorkspace *machine = step_machine();
    return read_u32(machine->page + machine->column_offset[column]
                    + index * 4u);
}

static u64 step_u64(u32 column, u32 index)
{
    StepWorkspace *machine = step_machine();
    return load_u64(machine->page + machine->column_offset[column]
                    + index * 8u);
}

static u32 step_u8(u32 column, u32 index)
{
    StepWorkspace *machine = step_machine();
    return machine->page[machine->column_offset[column] + index];
}

static u32 align8(u32 value) { return (value + 7u) & ~7u; }

static int step_fail(u32 error)
{
    step_machine()->error = error;
    return 0;
}

static int step_relative_selected(u32 count, u32 mode, u32 selector,
                                  u32 *selected)
{
    if (!count || count > 7u || mode > STEP_RELATIVE_SAVE_CAP)
        return 0;
    if (selector == 255u) *selected = count * 2u;
    else if (selector <= 254u && 254u - selector < mode)
        *selected = count * 2u + 1u + 254u - selector;
    else if (selector < count * 2u) *selected = selector;
    else return 0;
    return 1;
}

static int step_projection_is(u64 coordinate, u32 final_source)
{
    StepWorkspace *machine = step_machine();
    u64 wide_source = coordinate >> 8u;
    u32 selector = (u32)coordinate & 255u;
    if (!wide_source || wide_source != final_source
            || wide_source > machine->work)
        return 0;
    u32 source = (u32)wide_source;
    if (step_u8(STEP_OPCODES, source - 1u) != 188u)
        return 0;
    u32 begin = step_u32(STEP_ARGUMENT_OFFSETS, source - 1u);
    u32 end = step_u32(STEP_ARGUMENT_OFFSETS, source);
    if (end - begin < 7u) return 0;
    u64 layout = step_u64(STEP_OPERAND_VALUES, begin + 4u);
    u64 mode = step_u64(STEP_OPERAND_VALUES, begin + 6u);
    u32 count = (u32)layout & 255u;
    u32 selected;
    return mode <= STEP_RELATIVE_SAVE_CAP
        && step_relative_selected(count, (u32)mode, selector, &selected);
}

static int step_memory_start_flush(StepWorkspace *machine, u32 slot,
                                   u64 observed)
{
    if (step_slot_kind(observed) != STEP_SLOT_DIRTY
            || step_slot_pins(observed))
        return 0;
    u64 flushing = step_slot_word(
        STEP_SLOT_FLUSHING, 0, step_slot_epoch(observed));
    if (!step_slot_change(machine, slot, &observed, flushing)) return 0;
    u64 lease = step_new_capability();
    if (!lease) {
        step_slot_store(machine, slot, step_slot_word(
            STEP_SLOT_RETIRED, 0, step_slot_epoch(flushing)));
        return step_fail(11u);
    }
    machine->flush_memory_page = machine->memory_page[slot];
    machine->flush_memory_epoch = step_slot_epoch(flushing);
    machine->memory_lease = lease;
    for (u32 byte = 0; byte < machine->memory_valid[slot]; ++byte)
        machine->memory_transfer[byte] = machine->memory[slot][byte];
    machine->memory_status = STEP_DIRTY_PAGE;
    return 1;
}

static int step_memory_start_load(StepWorkspace *machine, u64 page,
                                  u32 slot, u64 observed)
{
    u32 kind = step_slot_kind(observed);
    if (kind == STEP_SLOT_DIRTY)
        return step_memory_start_flush(machine, slot, observed);
    if ((kind != STEP_SLOT_EMPTY && kind != STEP_SLOT_CLEAN)
            || step_slot_pins(observed))
        return 0;
    u64 loading = step_slot_word(
        STEP_SLOT_LOADING, 0, step_slot_epoch(observed));
    if (!step_slot_change(machine, slot, &observed, loading)) return 0;
    u64 lease = step_new_capability();
    if (!lease) {
        step_slot_store(machine, slot, step_slot_word(
            STEP_SLOT_RETIRED, 0, step_slot_epoch(loading)));
        return step_fail(11u);
    }
    machine->requested_memory_page = page;
    machine->memory_lease = lease;
    machine->memory_status = STEP_MEMORY_PAGE;
    return 1;
}

EXPORT u64 vm_step_acquire(void)
{
    if (step_session) return 0;
    u64 session = step_new_capability();
    if (!session) return 0;
    StepWorkspace *machine = step_machine();
    if (!step_workspace_initialized) {
        machine->memory_bytes = 0;
        machine->memory_page_shift = 16u;
        machine->memory_unbounded = 0;
        machine->memory_generation = 0;
        step_memory_slots_empty(machine);
        step_workspace_initialized = 1u;
    }
    workspace_mode = 2u;
    machine->requested_memory_page = STEP_NO_COORDINATE;
    machine->flush_memory_page = STEP_NO_COORDINATE;
    machine->memory_lease = 0;
    machine->memory_status = 0;
    machine->execution_active = 0;
    machine->error = 0;
    step_session = session;
    return session;
}

EXPORT int vm_step_release(u64 session)
{
    if (!step_session_is(session)) return 0;
    StepWorkspace *machine = step_machine();
    int reusable = !machine->execution_active && !machine->memory_status;
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        u64 word = step_slot_load(machine, slot);
        u32 kind = step_slot_kind(word);
        if (step_slot_pins(word) || kind == STEP_SLOT_DIRTY
                || kind == STEP_SLOT_LOADING || kind == STEP_SLOT_FLUSHING)
            reusable = 0;
    }
    if (!reusable) {
        step_memory_slots_empty(machine);
        machine->memory_bytes = 0;
        machine->memory_generation = 0;
    }
    machine->execution_active = 0;
    machine->requested_memory_page = STEP_NO_COORDINATE;
    machine->flush_memory_page = STEP_NO_COORDINATE;
    machine->memory_lease = 0;
    machine->memory_status = 0;
    step_session = 0;
    return 1;
}

EXPORT u8 *vm_step_buffer(u64 session)
{
    return step_session_is(session) ? step_machine()->page : (u8 *)0;
}

EXPORT u64 *vm_step_locals(u64 session)
{
    return step_session_is(session) ? step_machine()->locals : (u64 *)0;
}

EXPORT u64 *vm_step_stack(u64 session)
{
    return step_session_is(session) ? step_machine()->stack : (u64 *)0;
}

EXPORT u32 vm_step_input_stack_size(u64 session)
{
    return step_session_is(session) ? step_machine()->stack_inputs : 0;
}
EXPORT u32 vm_step_stack_size(u64 session)
{
    return step_session_is(session) ? step_machine()->stack_count : 0;
}
EXPORT u32 vm_step_local_size(u64 session)
{
    return step_session_is(session) ? step_machine()->local_extent : 0;
}
EXPORT u32 vm_step_function(u64 session)
{
    return step_session_is(session) ? step_machine()->function : STEP_NO_PAGE;
}
EXPORT u32 vm_step_next_pc(u64 session)
{
    return step_session_is(session) ? step_machine()->end : STEP_NO_PAGE;
}
EXPORT u32 vm_step_work(u64 session)
{
    return step_session_is(session) ? step_machine()->work : 0;
}
EXPORT u32 vm_step_span(u64 session)
{
    return step_session_is(session) ? step_machine()->span : 0;
}
EXPORT u32 vm_step_error(u64 session)
{
    return step_session_is(session) ? step_machine()->error : 12u;
}

EXPORT int vm_step_memory_open(u64 session, u32 bytes)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || !bytes || machine->execution_active
            || machine->memory_status)
        return 0;
    u64 generation = step_new_capability();
    if (!generation) return 0;
    machine->memory_bytes = bytes;
    machine->memory_page_shift = 16u;
    machine->memory_unbounded = 0;
    machine->memory_generation = generation;
    machine->requested_memory_page = STEP_NO_COORDINATE;
    machine->flush_memory_page = STEP_NO_COORDINATE;
    machine->memory_lease = 0;
    machine->memory_status = 0;
    step_memory_slots_empty(machine);
    return 1;
}

EXPORT int vm_step_memory_open_virtual(u64 session, u32 page_shift)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || page_shift < 12u || page_shift > 16u
            || machine->execution_active || machine->memory_status)
        return 0;
    u64 generation = step_new_capability();
    if (!generation) return 0;
    machine->memory_bytes = 0;
    machine->memory_page_shift = page_shift;
    machine->memory_unbounded = 1u;
    machine->memory_generation = generation;
    machine->requested_memory_page = STEP_NO_COORDINATE;
    machine->flush_memory_page = STEP_NO_COORDINATE;
    machine->memory_lease = 0;
    machine->memory_status = 0;
    step_memory_slots_empty(machine);
    return 1;
}

EXPORT u64 vm_step_memory_generation(u64 session)
{
    return step_session_is(session) ? step_machine()->memory_generation : 0;
}

EXPORT u64 vm_step_memory_lease(u64 session)
{
    StepWorkspace *machine = step_machine();
    return step_session_is(session) && machine->memory_status
         ? machine->memory_lease : 0;
}

EXPORT u32 vm_step_memory_page(u64 session, u64 lease)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || !lease
            || machine->memory_lease != lease || !machine->memory_status)
        return STEP_NO_PAGE;
    u64 page = machine->memory_status == STEP_DIRTY_PAGE
             ? machine->flush_memory_page : machine->requested_memory_page;
    return page < STEP_NO_PAGE ? (u32)page : STEP_NO_PAGE;
}

EXPORT u64 vm_step_memory_coordinate(u64 session, u64 lease)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || !lease
            || machine->memory_lease != lease || !machine->memory_status)
        return STEP_NO_COORDINATE;
    return machine->memory_status == STEP_DIRTY_PAGE
         ? machine->flush_memory_page : machine->requested_memory_page;
}

EXPORT u8 *vm_step_memory_page_buffer(u64 session, u64 lease)
{
    return vm_step_memory_coordinate(session, lease) == STEP_NO_COORDINATE
         ? (u8 *)0 : step_machine()->memory_transfer;
}

EXPORT u32 vm_step_memory_page_size(u64 session, u64 lease)
{
    StepWorkspace *machine = step_machine();
    u64 page = vm_step_memory_coordinate(session, lease);
    if (page == STEP_NO_COORDINATE) return 0;
    if (machine->memory_status == STEP_DIRTY_PAGE)
        return machine->memory_valid[(u32)page & (STEP_MEMORY_PAGES - 1u)];
    u32 page_bytes = 1u << machine->memory_page_shift;
    if (machine->memory_unbounded) return page_bytes;
    u64 first = page << machine->memory_page_shift;
    if (first >= machine->memory_bytes) return 0;
    u64 remaining = machine->memory_bytes - first;
    return remaining < page_bytes ? (u32)remaining : page_bytes;
}

static int step_supply_memory_coordinate(
        u64 session, u64 lease, u64 page, u32 bytes)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || machine->memory_status != STEP_MEMORY_PAGE
            || machine->memory_lease != lease
            || machine->requested_memory_page != page
            || vm_step_memory_page_size(session, lease) != bytes)
        return 0;
    u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
    u64 word = step_slot_load(machine, slot);
    if (step_slot_kind(word) != STEP_SLOT_LOADING || step_slot_pins(word))
        return 0;
    u64 epoch = machine->memory_next_epoch[slot];
    if (!epoch || epoch >= STEP_SLOT_EPOCH_LIMIT) {
        step_slot_store(machine, slot, step_slot_word(
            STEP_SLOT_RETIRED, 0, step_slot_epoch(word)));
        return step_fail(11u);
    }
    for (u32 byte = 0; byte < bytes; ++byte)
        machine->memory[slot][byte] = machine->memory_transfer[byte];
    machine->memory_page[slot] = page;
    machine->memory_valid[slot] = bytes;
    machine->memory_next_epoch[slot] = epoch + 1u;
    step_slot_store(machine, slot,
                    step_slot_word(STEP_SLOT_CLEAN, 0, epoch));
    machine->requested_memory_page = STEP_NO_COORDINATE;
    machine->memory_lease = 0;
    machine->memory_status = 0;
    return 1;
}

EXPORT int vm_step_supply_memory_page(u64 session, u64 lease,
                                      u32 page, u32 bytes)
{
    return step_supply_memory_coordinate(session, lease, page, bytes);
}

EXPORT int vm_step_supply_memory_coordinate(u64 session, u64 lease,
                                             u64 page, u32 bytes)
{
    return step_supply_memory_coordinate(session, lease, page, bytes);
}

static int step_ack_memory_coordinate(u64 session, u64 lease, u64 page)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || !lease) return 0;
    u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
    if (machine->memory_last_ack_session[slot] == session
            && machine->memory_last_ack_generation[slot]
                == machine->memory_generation
            && machine->memory_last_ack_lease[slot] == lease
            && machine->memory_last_ack_page[slot] == page)
        return 1;
    if (machine->memory_status != STEP_DIRTY_PAGE
            || machine->memory_lease != lease
            || machine->flush_memory_page != page)
        return 0;
    u64 word = step_slot_load(machine, slot);
    if (step_slot_kind(word) != STEP_SLOT_FLUSHING
            || step_slot_pins(word)
            || step_slot_epoch(word) != machine->flush_memory_epoch
            || machine->memory_page[slot] != page)
        return 0;
    step_slot_store(machine, slot, step_slot_word(
        STEP_SLOT_CLEAN, 0, step_slot_epoch(word)));
    machine->memory_last_ack_session[slot] = session;
    machine->memory_last_ack_generation[slot] = machine->memory_generation;
    machine->memory_last_ack_lease[slot] = lease;
    machine->memory_last_ack_page[slot] = page;
    machine->flush_memory_page = STEP_NO_COORDINATE;
    machine->memory_lease = 0;
    machine->memory_status = 0;
    return 1;
}

EXPORT int vm_step_ack_memory_page(u64 session, u64 lease, u32 page)
{
    return step_ack_memory_coordinate(session, lease, page);
}

EXPORT int vm_step_ack_memory_coordinate(u64 session, u64 lease, u64 page)
{
    return step_ack_memory_coordinate(session, lease, page);
}

EXPORT u32 vm_step_first_dirty_memory_page(u64 session)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || machine->execution_active
            || machine->memory_status)
        return STEP_NO_PAGE;
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        u64 word = step_slot_load(machine, slot);
        if (step_memory_start_flush(machine, slot, word)) {
            u64 page = machine->flush_memory_page;
            return page < STEP_NO_PAGE ? (u32)page : STEP_NO_PAGE;
        }
    }
    return STEP_NO_PAGE;
}

EXPORT u64 vm_step_first_dirty_memory_coordinate(u64 session)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || machine->execution_active
            || machine->memory_status)
        return STEP_NO_COORDINATE;
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        u64 word = step_slot_load(machine, slot);
        if (step_memory_start_flush(machine, slot, word))
            return machine->flush_memory_page;
    }
    return STEP_NO_COORDINATE;
}

EXPORT int vm_step_open(u64 session, u32 bytes)
{
    static const u8 widths[STEP_COLUMN_COUNT] = {
        4, 4, 1, 4, 1, 8, 1, 8, 4, 1, 8,
    };
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || machine->execution_active
            || machine->memory_status)
        return 0;
    machine->error = 0;
    if (bytes < STEP_HEADER_BYTES || bytes > STEP_PAGE_BYTES)
        return step_fail(1u);
    const u8 *page = machine->page;
    if (page[0] != 'S' || page[1] != 'T' || page[2] != 'E'
            || page[3] != 'P' || read_u16(page + 4u) != 3u
            || read_u16(page + 6u) != STEP_HEADER_BYTES)
        return step_fail(2u);

    machine->page_bytes = bytes;
    machine->function = read_u32(page + 8u);
    machine->start = read_u32(page + 12u);
    machine->end = read_u32(page + 16u);
    machine->instructions = read_u32(page + 20u);
    machine->span = read_u32(page + 24u);
    machine->work = read_u32(page + 28u);
    machine->operands = read_u32(page + 32u);
    machine->stack_inputs = read_u32(page + 36u);
    machine->stack_count = read_u32(page + 40u);
    machine->local_extent = read_u32(page + 44u);
    machine->local_updates = read_u32(page + 48u);
    machine->execution_active = 0;
    if (machine->end < machine->start
            || machine->instructions != machine->end - machine->start
            || machine->work > STEP_VALUE_CAP
            || machine->stack_inputs > STEP_VALUE_CAP
            || machine->stack_count > STEP_VALUE_CAP
            || machine->local_extent > STEP_VALUE_CAP
            || machine->local_updates > machine->local_extent)
        return step_fail(3u);

    u32 expected[STEP_COLUMN_COUNT] = {
        machine->span + 1u, machine->work, machine->work,
        machine->work + 1u, machine->operands, machine->operands,
        machine->stack_count, machine->stack_count,
        machine->local_updates, machine->local_updates,
        machine->local_updates,
    };
    u32 cursor = STEP_HEADER_BYTES;
    for (u32 column = 0; column < STEP_COLUMN_COUNT; ++column) {
        u32 directory = 52u + column * 8u;
        u32 offset = read_u32(page + directory);
        u32 count = read_u32(page + directory + 4u);
        cursor = align8(cursor);
        if (offset != cursor || count != expected[column]
                || count > (bytes - cursor) / widths[column])
            return step_fail(4u);
        machine->column_offset[column] = offset;
        machine->column_count[column] = count;
        cursor += count * widths[column];
    }
    if (cursor != bytes)
        return step_fail(4u);
    for (u32 at = 52u + STEP_COLUMN_COUNT * 8u;
         at < STEP_HEADER_BYTES; ++at)
        if (page[at]) return step_fail(4u);

    if (step_u32(STEP_WAVE_OFFSETS, 0) != 0u
            || step_u32(STEP_WAVE_OFFSETS, machine->span) != machine->work
            || step_u32(STEP_ARGUMENT_OFFSETS, 0) != 0u
            || step_u32(STEP_ARGUMENT_OFFSETS, machine->work)
               != machine->operands)
        return step_fail(5u);

    /* Reuse the transient value array for validation depth; execution clears
     * exactly the live node region before publishing results into it. */
    for (u32 node = 0; node <= machine->work; ++node)
        machine->values[node] = 0;
    for (u32 depth = 1; depth <= machine->span; ++depth) {
        u32 begin = step_u32(STEP_WAVE_OFFSETS, depth - 1u);
        u32 end = step_u32(STEP_WAVE_OFFSETS, depth);
        if (begin > end || end > machine->work) return step_fail(5u);
        for (u32 lane = begin; lane < end; ++lane) {
            u32 node = step_u32(STEP_LANE_VALUES, lane);
            if (!node || node > machine->work || machine->values[node])
                return step_fail(5u);
            machine->values[node] = depth;
        }
    }
    for (u32 node = 1; node <= machine->work; ++node) {
        if (!machine->values[node] || step_u8(STEP_OPCODES, node - 1u) >= 197u)
            return step_fail(5u);
        u32 begin = step_u32(STEP_ARGUMENT_OFFSETS, node - 1u);
        u32 end = step_u32(STEP_ARGUMENT_OFFSETS, node);
        if (begin > end || end > machine->operands) return step_fail(5u);
        for (u32 at = begin; at < end; ++at) {
            u32 tag = step_u8(STEP_OPERAND_TAGS, at);
            u64 value = step_u64(STEP_OPERAND_VALUES, at);
            if (tag > 3u
                    || (tag == 1u && value >= machine->stack_inputs)
                    || (tag == 2u && value >= machine->local_extent)
                    || (tag == 3u && (!value || value > machine->work
                        || machine->values[value] >= machine->values[node])))
                return step_fail(5u);
        }
    }
    for (u32 index = 0, previous = 0; index < machine->local_updates; ++index) {
        u32 coordinate = step_u32(STEP_LOCAL_INDICES, index);
        if (coordinate >= machine->local_extent
                || (index && coordinate <= previous))
            return step_fail(5u);
        previous = coordinate;
    }
    u32 projection_source = 0u;
    for (u32 lane = 0; lane < machine->work; ++lane) {
        u32 node = step_u32(STEP_LANE_VALUES, lane);
        if (step_u8(STEP_OPCODES, node - 1u) == 188u)
            projection_source = node;
    }
    for (u32 output = 0; output < machine->stack_count; ++output) {
        u32 tag = step_u8(STEP_STACK_TAGS, output);
        u64 value = step_u64(STEP_STACK_VALUES, output);
        if (tag > 4u || (tag == 1u && value >= machine->stack_inputs)
                || (tag == 2u && value >= machine->local_extent)
                || (tag == 3u && (!value || value > machine->work))
                || (tag == 4u
                    && !step_projection_is(value, projection_source)))
            return step_fail(5u);
    }
    for (u32 output = 0; output < machine->local_updates; ++output) {
        u32 tag = step_u8(STEP_LOCAL_TAGS, output);
        u64 value = step_u64(STEP_LOCAL_VALUES, output);
        if (tag > 4u || (tag == 1u && value >= machine->stack_inputs)
                || (tag == 2u && value >= machine->local_extent)
                || (tag == 3u && (!value || value > machine->work))
                || (tag == 4u
                    && !step_projection_is(value, projection_source)))
            return step_fail(5u);
    }
    return 1;
}

static int step_operand(u32 at, u64 *value)
{
    StepWorkspace *machine = step_machine();
    u32 tag = step_u8(STEP_OPERAND_TAGS, at);
    u64 coordinate = step_u64(STEP_OPERAND_VALUES, at);
    if (tag == 0u) *value = coordinate;
    else if (tag == 1u) *value = machine->stack[coordinate];
    else if (tag == 2u) *value = machine->locals[coordinate];
    else if (tag == 3u) *value = machine->values[coordinate];
    else return step_fail(6u);
    return 1;
}

static u64 step_mask(u32 bits)
{
    return bits == 32u ? 0xffffffffull : ~0ull;
}

static i64 step_signed(u64 value, u32 bits)
{
    return bits == 32u ? (i64)(int)(u32)value : (i64)value;
}

static u64 step_pdep(u64 value, u64 mask, u32 bits)
{
    u64 result = 0;
    u64 source = 1;
    u64 limit = step_mask(bits);
    mask &= limit;
    while (mask) {
        u64 bit = mask & (0ull - mask);
        if (value & source) result |= bit;
        mask ^= bit;
        source <<= 1u;
    }
    return result & limit;
}

static u64 step_pext(u64 value, u64 mask, u32 bits)
{
    u64 result = 0;
    u64 target = 1;
    mask &= step_mask(bits);
    while (mask) {
        u64 bit = mask & (0ull - mask);
        if (value & bit) result |= target;
        mask ^= bit;
        target <<= 1u;
    }
    return result;
}

static u64 step_clmul(u64 left, u64 right, u32 bits)
{
    u64 result = 0;
    for (u32 bit = 0; bit < bits; ++bit)
        if ((right >> bit) & 1u) result ^= left << bit;
    return result & step_mask(bits);
}

static u64 step_rotate_left(u64 value, u64 count, u32 bits)
{
    u32 shift = (u32)count & (bits - 1u);
    u64 mask = step_mask(bits);
    value &= mask;
    return shift ? ((value << shift) | (value >> (bits - shift))) & mask
                 : value;
}

static u64 step_rotate_right(u64 value, u64 count, u32 bits)
{
    return step_rotate_left(value, 0u - (u32)count, bits);
}

static int step_lane(u32 opcode, u32 begin, u32 end, u64 *result)
{
    u32 bits = opcode < 70u ? 32u : 64u;
    u32 operation = opcode % 70u;
    u64 mask = step_mask(bits);
    u64 a = 0, b = 0, c = 0;
    if (begin < end && !step_operand(begin, &a)) return 0;
    if (begin + 1u < end && !step_operand(begin + 1u, &b)) return 0;
    if (begin + 2u < end && !step_operand(begin + 2u, &c)) return 0;
    if (operation != 32u) {
        a &= mask;
        b &= mask;
        c &= mask;
    }

    if (operation == 0u) *result = step_pdep(a, b, bits);
    else if (operation == 1u) *result = step_pext(a, b, bits);
    else if (operation == 2u) *result = step_pext(b, a, bits);
    else if (operation == 3u) *result = step_pdep(b, a, bits);
    else if (operation == 4u || operation == 50u) *result = a * b;
    else if (operation == 5u || operation == 29u) *result = step_clmul(a, b, bits);
    else if (operation == 6u || operation == 17u) *result = a & b;
    else if (operation == 7u || operation == 18u) *result = a | b;
    else if (operation == 8u || operation == 16u) *result = a ^ b;
    else if (operation == 9u || operation == 19u) *result = a + b;
    else if (operation == 10u || operation == 26u) *result = a - b;
    else if (operation == 11u) *result = ~a;
    else if (operation == 12u || operation == 51u) *result = a << (b & (bits - 1u));
    else if (operation == 13u || operation == 53u) *result = a >> (b & (bits - 1u));
    else if (operation == 14u) {
        *result = bits == 32u ? (u64)__builtin_bswap32((u32)a)
                              : __builtin_bswap64(a);
    } else if (operation == 15u) {
        *result = bits == 32u ? (u64)__builtin_popcount((u32)a)
                              : (u64)__builtin_popcountll(a);
    } else if (operation == 20u) *result = (~a) & b;
    else if (operation == 21u) {
        u32 constants = end - begin - 1u;
        if (!constants || (constants & (constants - 1u))) return step_fail(7u);
        if (!step_operand(begin + 1u + ((u32)a & (constants - 1u)), result))
            return 0;
    } else if (operation == 22u) *result = step_pext(b, a, bits);
    else if (operation == 23u) *result = a ^ (a << (b & (bits - 1u)));
    else if (operation == 24u || operation == 52u)
        *result = (u64)(step_signed(a, bits) >> (b & (bits - 1u)));
    else if (operation == 25u) *result = 0u - a;
    else if (operation == 27u)
        *result = a ? (bits == 32u ? (u64)__builtin_clz((u32)a)
                                   : (u64)__builtin_clzll(a)) : bits;
    else if (operation == 28u)
        *result = a ? (bits == 32u ? (u64)__builtin_ctz((u32)a)
                                   : (u64)__builtin_ctzll(a)) : bits;
    else if (operation == 30u) *result = step_rotate_left(a, b, 32u);
    else if (operation == 31u) *result = step_rotate_right(a, b, 32u);
    else if (operation == 32u) *result = c ? a : b;
    else if (operation == 33u) *result = (u32)a;
    else if (operation == 34u) *result = (u64)(i64)(int)(u32)a;
    else if (operation == 35u) *result = (u32)a;
    else if (operation == 36u) *result = (u64)(i64)(signed char)(u8)a;
    else if (operation == 37u) *result = (u64)(i64)(short)(u32)a;
    else if (operation == 38u) *result = (u64)(i64)(int)(u32)a;
    else if (operation == 39u) *result = a == 0u;
    else if (operation == 40u) *result = a == b;
    else if (operation == 41u) *result = a != b;
    else if (operation == 42u) *result = step_signed(a, bits) < step_signed(b, bits);
    else if (operation == 43u) *result = a < b;
    else if (operation == 44u) *result = step_signed(a, bits) > step_signed(b, bits);
    else if (operation == 45u) *result = a > b;
    else if (operation == 46u) *result = step_signed(a, bits) <= step_signed(b, bits);
    else if (operation == 47u) *result = a <= b;
    else if (operation == 48u) *result = step_signed(a, bits) >= step_signed(b, bits);
    else if (operation == 49u) *result = a >= b;
    else if (operation == 54u) *result = step_rotate_left(a, b, bits);
    else if (operation == 55u) *result = step_rotate_right(a, b, bits);
    else if (operation == 56u) {
        i64 left = step_signed(a, bits), right = step_signed(b, bits);
        i64 minimum = bits == 32u ? (i64)(-2147483647 - 1) : I64_MIN_VALUE;
        if (!right || (left == minimum && right == -1)) return step_fail(8u);
        *result = (u64)(left / right);
    } else if (operation == 57u) {
        if (!b) return step_fail(8u);
        *result = a / b;
    } else if (operation == 58u) {
        i64 left = step_signed(a, bits), right = step_signed(b, bits);
        i64 minimum = bits == 32u ? (i64)(-2147483647 - 1) : I64_MIN_VALUE;
        if (!right) return step_fail(8u);
        *result = left == minimum && right == -1 ? 0u : (u64)(left % right);
    } else if (operation == 59u) {
        if (!b) return step_fail(8u);
        *result = a % b;
    } else if (operation == 60u || operation == 61u) {
        *result = (a >> (b & (bits - 1u))) & 1u;
        if (operation == 61u) *result ^= 1u;
    } else if (operation == 62u || operation == 63u) {
        *result = (a >> ((~b) & 7u)) & 1u;
        if (operation == 63u) *result ^= 1u;
    } else if (operation == 64u) *result = a + b + c;
    else if (operation == 65u) {
        u32 count = (u32)c & (bits - 1u);
        *result = count ? (a >> (b & (bits - 1u))) & ((1ull << count) - 1u) : 0u;
    } else if (operation == 66u) *result = a < b ? a : b;
    else if (operation == 67u) *result = a > b ? a : b;
    else if (operation == 68u)
        *result = step_signed(a, bits) < step_signed(b, bits) ? a : b;
    else if (operation == 69u)
        *result = step_signed(a, bits) > step_signed(b, bits) ? a : b;
    else return step_fail(7u);
    /* SELECT preserves the selected publication width, and EXTEND_I32_S
     * publishes an i64 even if a malformed diagnostic page spells a 32-bit
     * lane. This mirrors the one shared lane vocabulary exactly. */
    if (operation != 32u && operation != 34u) *result &= mask;
    return 1;
}

typedef struct {
    u32 count;
    u64 page[2];
    u32 slot[2];
    u64 epoch[2];
} StepMemoryGuard;

static int step_memory_resident(u64 page)
{
    StepWorkspace *machine = step_machine();
    u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
    u64 word = step_slot_load(machine, slot);
    u32 kind = step_slot_kind(word);
    if ((kind == STEP_SLOT_CLEAN || kind == STEP_SLOT_DIRTY)
            && machine->memory_page[slot] == page)
        return 1;
    if (kind == STEP_SLOT_RETIRED) return step_fail(11u);
    if (kind == STEP_SLOT_LOADING || kind == STEP_SLOT_FLUSHING) return 0;
    step_memory_start_load(machine, page, slot, word);
    return 0;
}

static int step_memory_unpin(StepMemoryGuard *guard, int dirty)
{
    StepWorkspace *machine = step_machine();
    int ok = 1;
    while (guard->count) {
        u32 index = --guard->count;
        u32 slot = guard->slot[index];
        for (;;) {
            u64 word = step_slot_load(machine, slot);
            u32 kind = step_slot_kind(word);
            u32 pins = step_slot_pins(word);
            if ((kind != STEP_SLOT_CLEAN && kind != STEP_SLOT_DIRTY)
                    || !pins || step_slot_epoch(word) != guard->epoch[index]
                    || machine->memory_page[slot] != guard->page[index]) {
                step_fail(12u);
                ok = 0;
                break;
            }
            u32 next_kind = dirty ? STEP_SLOT_DIRTY : kind;
            u64 next = step_slot_word(
                next_kind, pins - 1u, step_slot_epoch(word));
            if (step_slot_change(machine, slot, &word, next)) break;
        }
    }
    return ok;
}

static int step_memory_pin(u64 page, u32 required, StepMemoryGuard *guard)
{
    StepWorkspace *machine = step_machine();
    u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
    for (;;) {
        u64 word = step_slot_load(machine, slot);
        u32 kind = step_slot_kind(word);
        u32 pins = step_slot_pins(word);
        if ((kind != STEP_SLOT_CLEAN && kind != STEP_SLOT_DIRTY)
                || machine->memory_page[slot] != page) {
            if (!step_memory_resident(page)) return 0;
            continue;
        }
        if (required > machine->memory_valid[slot]) return step_fail(10u);
        if (pins == STEP_SLOT_PIN_MASK) return step_fail(12u);
        u64 pinned = step_slot_word(
            kind, pins + 1u, step_slot_epoch(word));
        if (!step_slot_change(machine, slot, &word, pinned)) continue;
        /* The acquire transition freezes the adjacent tag and extent until
         * this guard releases its pin, closing check-to-access races. */
        guard->page[guard->count] = page;
        guard->slot[guard->count] = slot;
        guard->epoch[guard->count] = step_slot_epoch(pinned);
        guard->count += 1u;
        return 1;
    }
}

static int step_memory_ready(u64 address, u32 width, StepMemoryGuard *guard)
{
    StepWorkspace *machine = step_machine();
    guard->count = 0;
    if ((!machine->memory_unbounded
            && (!machine->memory_bytes || address > machine->memory_bytes
                || width > machine->memory_bytes - address))
            || !width || address > ~0ull - (width - 1u))
        return step_fail(10u);
    u32 page_shift = machine->memory_page_shift;
    u32 page_bytes = 1u << page_shift;
    u64 first = address >> page_shift;
    u64 last = (address + width - 1u) >> page_shift;
    for (u64 page = first; page <= last; ++page) {
        u64 page_first = page << page_shift;
        u64 required = address + width - page_first;
        if (required > page_bytes) required = page_bytes;
        if (!step_memory_pin(page, (u32)required, guard)) {
            step_memory_unpin(guard, 0);
            return 0;
        }
    }
    return 1;
}

static int step_memory_load(u64 address, u32 width,
                            StepMemoryGuard *guard, u64 *result)
{
    StepWorkspace *machine = step_machine();
    u64 value = 0;
    for (u32 byte = 0; byte < width; ++byte) {
        u64 coordinate = address + byte;
        u64 page = coordinate >> machine->memory_page_shift;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        u64 offset = coordinate & ((1ull << machine->memory_page_shift) - 1u);
        value |= (u64)machine->memory[slot][offset]
                 << (8u * byte);
    }
    *result = value;
    return step_memory_unpin(guard, 0);
}

static int step_memory_store(u64 address, u64 value, u32 width,
                             StepMemoryGuard *guard)
{
    StepWorkspace *machine = step_machine();
    for (u32 byte = 0; byte < width; ++byte) {
        u64 coordinate = address + byte;
        u64 page = coordinate >> machine->memory_page_shift;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        u64 offset = coordinate & ((1ull << machine->memory_page_shift) - 1u);
        machine->memory[slot][offset]
            = (u8)(value >> (8u * byte));
    }
    return step_memory_unpin(guard, 1);
}

static int step_memory_lane(u32 opcode, u32 begin, u32 end, u64 *result)
{
    u32 observer = STEP_NO_PAGE;
    if (opcode >= 159u) {
        observer = (opcode - 159u) & 1u;
        opcode = 140u + (opcode - 159u) / 2u;
    }
    int store = opcode >= 152u;
    u32 width = 0, bits = 0;
    int signed_load = 0;
    if (opcode == 140u) { width = 4; bits = 32; }
    else if (opcode == 141u) { width = 1; bits = 32; signed_load = 1; }
    else if (opcode == 142u) { width = 1; bits = 32; }
    else if (opcode == 143u) { width = 2; bits = 32; signed_load = 1; }
    else if (opcode == 144u) { width = 2; bits = 32; }
    else if (opcode == 145u) { width = 8; bits = 64; }
    else if (opcode == 146u) { width = 1; bits = 64; signed_load = 1; }
    else if (opcode == 147u) { width = 1; bits = 64; }
    else if (opcode == 148u) { width = 2; bits = 64; signed_load = 1; }
    else if (opcode == 149u) { width = 2; bits = 64; }
    else if (opcode == 150u) { width = 4; bits = 64; signed_load = 1; }
    else if (opcode == 151u) { width = 4; bits = 64; }
    else if (opcode == 152u) { width = 4; bits = 32; }
    else if (opcode == 153u) { width = 1; bits = 32; }
    else if (opcode == 154u) { width = 2; bits = 32; }
    else if (opcode == 155u) { width = 8; bits = 64; }
    else if (opcode == 156u) { width = 1; bits = 64; }
    else if (opcode == 157u) { width = 2; bits = 64; }
    else if (opcode == 158u) { width = 4; bits = 64; }
    else return step_fail(9u);

    u32 data_count = store ? 2u : 1u;
    if (end - begin < data_count + 2u) return step_fail(9u);
    u64 address, value = 0, offset, shape;
    if (!step_operand(begin, &address)
            || (store && !step_operand(begin + 1u, &value))
            || !step_operand(begin + data_count, &offset)
            || !step_operand(begin + data_count + 1u, &shape))
        return 0;
    u32 physical_width = (u32)shape & 255u;
    u32 scale = (u32)(shape >> 8) & 31u;
    int virtual64 = (shape & 0x10000u) != 0u;
    if (physical_width != width || (shape & ~0x11fffu))
        return step_fail(9u);
    u64 base = virtual64 ? address : (u64)(u32)address;
    base <<= scale;
    if (!virtual64) base = (u32)base;
    if (!virtual64 && offset > ~0ull - base) return step_fail(10u);
    u64 effective = base + offset;
    StepMemoryGuard guard;
    if (!step_memory_ready(effective, width, &guard)) return 0;
    if (store) {
        if (!step_memory_store(effective, value, width, &guard)) return 0;
        *result = 0;
        return 1;
    }
    if (!step_memory_load(effective, width, &guard, &value)) return 0;
    if (signed_load && width < 8u && value & (1ull << (width * 8u - 1u)))
        value |= ~0ull << (width * 8u);
    value &= step_mask(bits);
    if (observer != STEP_NO_PAGE) value = observer ? value != 0u : value == 0u;
    *result = value;
    return 1;
}

static int step_x86_flags_value(u64 prior, u64 left, u64 right, u64 value,
                                u64 descriptor, u64 *result)
{
    u32 width = (u32)descriptor & 0x7fu;
    u32 mode = ((u32)descriptor >> 8) & 7u;
    int preserve_carry = ((u32)descriptor & (1u << 11)) != 0;
    if (width != 8u && width != 16u && width != 32u && width != 64u)
        return step_fail(7u);
    u64 lane_mask = step_mask(width);
    u64 sign = 1ull << (width - 1u);
    left &= lane_mask;
    right &= lane_mask;
    value &= lane_mask;
    u64 carry_in = (mode == 2u || mode == 4u) ? prior & 1u : 0u;
    u64 flags = prior & ~0x8c5ull;
    int carry = preserve_carry ? (prior & 1u) != 0u : 0;
    if (!preserve_carry) {
        if (mode == 1u || mode == 2u)
            carry = left > lane_mask - right
                 || (carry_in && left + right == lane_mask);
        else if (mode == 3u || mode == 4u)
            carry = left < right || (carry_in && left == right);
    }
    if (carry) flags |= 1u;
    if ((__builtin_popcount((u32)value & 255u) & 1u) == 0u)
        flags |= 1u << 2;
    if (!value) flags |= 1u << 6;
    if (value & sign) flags |= 1u << 7;
    int overflow = 0;
    if (mode == 1u || mode == 2u)
        overflow = !((left ^ right) & sign) && ((left ^ value) & sign);
    else if (mode == 3u || mode == 4u)
        overflow = ((left ^ right) & sign) && ((left ^ value) & sign);
    if (overflow) flags |= 1u << 11;
    *result = flags | 2u;
    return 1;
}

static int step_x86_flags_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 5u) return step_fail(7u);
    u64 prior, left, right, value, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &left)
            || !step_operand(begin + 2u, &right)
            || !step_operand(begin + 3u, &value)
            || !step_operand(begin + 4u, &descriptor))
        return 0;
    return step_x86_flags_value(
        prior, left, right, value, descriptor, result);
}

static int step_x86_flags_select_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 11u) return step_fail(7u);
    u64 condition;
    if (!step_operand(begin + 10u, &condition)) return 0;
    u32 selected = condition ? begin : begin + 5u;
    return step_x86_flags_lane(selected, selected + 5u, result);
}

static int step_x86_compare_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 4u) return step_fail(7u);
    u64 prior, left, right, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &left)
            || !step_operand(begin + 2u, &right)
            || !step_operand(begin + 3u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    if (width != 8u && width != 16u && width != 32u && width != 64u)
        return step_fail(7u);
    return step_x86_flags_value(
        prior, left, right, (left - right) & step_mask(width),
        descriptor, result);
}

static int step_x86_shift_flags_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 5u) return step_fail(7u);
    u64 prior, source, value, amount, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &source)
            || !step_operand(begin + 2u, &value)
            || !step_operand(begin + 3u, &amount)
            || !step_operand(begin + 4u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    u32 group = ((u32)descriptor >> 8) & 7u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || (group != 0u && group != 1u && group != 4u
                && group != 5u && group != 7u))
        return step_fail(7u);
    amount &= width - 1u;
    if (!amount) {
        *result = prior;
        return 1;
    }
    u64 lane_mask = step_mask(width);
    source &= lane_mask;
    value &= lane_mask;
    u64 carry;
    if (group == 0u) carry = value & 1u;
    else if (group == 1u) carry = (value >> (width - 1u)) & 1u;
    else if (group == 4u) carry = (source >> (width - amount)) & 1u;
    else carry = (source >> (amount - 1u)) & 1u;
    u64 flags = prior;
    if (group != 0u && group != 1u
            && !step_x86_flags_value(
                prior, value, 0u, value, width, &flags))
        return 0;
    flags = (flags & ~1ull) | carry;
    u64 overflow = 0u;
    if (amount == 1u) {
        if (group == 0u || group == 4u)
            overflow = ((value >> (width - 1u)) ^ carry) & 1u;
        else if (group == 1u)
            overflow = ((value >> (width - 1u))
                       ^ (value >> (width - 2u))) & 1u;
        else if (group == 5u)
            overflow = (source >> (width - 1u)) & 1u;
    }
    *result = (flags & ~(1ull << 11)) | (overflow << 11);
    return 1;
}

static int step_x86_condition_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 2u) return step_fail(7u);
    u64 flags, code;
    if (!step_operand(begin, &flags)
            || !step_operand(begin + 1u, &code))
        return 0;
    u64 carry = flags & 1u;
    u64 parity = (flags >> 2u) & 1u;
    u64 zero = (flags >> 6u) & 1u;
    u64 sign = (flags >> 7u) & 1u;
    u64 overflow = (flags >> 11u) & 1u;
    u64 less = sign ^ overflow;
    switch ((u32)code & 15u) {
    case 0u: *result = overflow; break;
    case 1u: *result = overflow ^ 1u; break;
    case 2u: *result = carry; break;
    case 3u: *result = carry ^ 1u; break;
    case 4u: *result = zero; break;
    case 5u: *result = zero ^ 1u; break;
    case 6u: *result = carry | zero; break;
    case 7u: *result = (carry | zero) ^ 1u; break;
    case 8u: *result = sign; break;
    case 9u: *result = sign ^ 1u; break;
    case 10u: *result = parity; break;
    case 11u: *result = parity ^ 1u; break;
    case 12u: *result = less; break;
    case 13u: *result = less ^ 1u; break;
    case 14u: *result = zero | less; break;
    default: *result = (zero | less) ^ 1u; break;
    }
    return 1;
}

static int step_x86_test_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 4u) return step_fail(7u);
    u64 prior, left, right, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &left)
            || !step_operand(begin + 2u, &right)
            || !step_operand(begin + 3u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || descriptor != width)
        return step_fail(7u);
    return step_x86_flags_value(
        prior, left, right, (left & right) & step_mask(width),
        descriptor, result);
}

static int step_add3_u32_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 3u) return step_fail(7u);
    u64 left, unsigned32, right;
    if (!step_operand(begin, &left)
            || !step_operand(begin + 1u, &unsigned32)
            || !step_operand(begin + 2u, &right))
        return 0;
    *result = left + (unsigned32 & 0xffffffffu) + right;
    return 1;
}

static int step_memory_repeat_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin != 4u) return step_fail(9u);
    if (!machine->repeat_active) {
        u64 address, pattern, size, shape;
        if (!step_operand(begin, &address)
                || !step_operand(begin + 1u, &pattern)
                || !step_operand(begin + 2u, &size)
                || !step_operand(begin + 3u, &shape))
            return 0;
        u32 width = (u32)shape & 255u;
        u32 scale = (u32)(shape >> 8) & 31u;
        int virtual64 = (shape & 0x10000u) != 0u;
        if ((width != 1u && width != 2u && width != 4u && width != 8u)
                || (shape & ~0x11fffull))
            return step_fail(9u);
        u64 base = virtual64 ? address : (u64)(u32)address;
        base <<= scale;
        if (!virtual64) base = (u32)base;
        if (size && base > ~0ull - (size - 1u)) return step_fail(10u);
        machine->repeat_active = 1u;
        machine->repeat_lane = machine->execution_lane;
        machine->repeat_width = width;
        machine->repeat_phase = 0u;
        machine->repeat_address = base;
        machine->repeat_remaining = size;
        machine->repeat_pattern = pattern;
    } else if (machine->repeat_lane != machine->execution_lane) {
        return step_fail(12u);
    }

    while (machine->repeat_remaining) {
        u32 page_shift = machine->memory_page_shift;
        u32 page_bytes = 1u << page_shift;
        u32 offset = (u32)(machine->repeat_address & (page_bytes - 1u));
        u64 available = page_bytes - offset;
        u32 count = (u32)(machine->repeat_remaining < available
                        ? machine->repeat_remaining : available);
        StepMemoryGuard guard;
        if (!step_memory_ready(machine->repeat_address, count, &guard))
            return 0;
        u64 page = machine->repeat_address >> page_shift;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        for (u32 byte = 0; byte < count; ++byte) {
            u32 phase = machine->repeat_phase;
            machine->memory[slot][offset + byte] =
                (u8)(machine->repeat_pattern >> (phase * 8u));
            machine->repeat_phase = (phase + 1u == machine->repeat_width)
                                  ? 0u : phase + 1u;
        }
        if (!step_memory_unpin(&guard, 1)) return 0;
        machine->repeat_address += count;
        machine->repeat_remaining -= count;
    }
    machine->repeat_active = 0u;
    *result = 0;
    return 1;
}

static int step_memory_find2_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin != 4u) return step_fail(9u);
    if (!machine->find_active) {
        u64 address, first, second, shape;
        if (!step_operand(begin, &address)
                || !step_operand(begin + 1u, &first)
                || !step_operand(begin + 2u, &second)
                || !step_operand(begin + 3u, &shape))
            return 0;
        u32 width = (u32)shape & 255u;
        u32 scale = (u32)(shape >> 8) & 31u;
        int virtual64 = (shape & 0x10000u) != 0u;
        if (width != 1u || (shape & ~0x11fffull))
            return step_fail(9u);
        u64 base = virtual64 ? address : (u64)(u32)address;
        base <<= scale;
        if (!virtual64) base = (u32)base;
        machine->find_active = 1u;
        machine->find_lane = machine->execution_lane;
        machine->find_first = (u32)first & 255u;
        machine->find_second = (u32)second & 255u;
        machine->find_address = base;
        machine->find_offset = 0u;
    } else if (machine->find_lane != machine->execution_lane) {
        return step_fail(12u);
    }

    for (;;) {
        if (machine->find_offset >= (1ull << 56)
                || machine->find_address > ~0ull - machine->find_offset)
            return step_fail(10u);
        u64 address = machine->find_address + machine->find_offset;
        u32 page_shift = machine->memory_page_shift;
        u32 page_bytes = 1u << page_shift;
        u32 offset = (u32)(address & (page_bytes - 1u));
        u32 count = page_bytes - offset;
        StepMemoryGuard guard;
        if (!step_memory_ready(address, count, &guard)) return 0;
        u64 page = address >> page_shift;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        for (u32 byte = 0; byte < count; ++byte) {
            u32 value = machine->memory[slot][offset + byte];
            if (value == machine->find_first
                    || value == machine->find_second) {
                if (!step_memory_unpin(&guard, 0)) return 0;
                *result = ((machine->find_offset + byte) << 8) | value;
                machine->find_active = 0u;
                return 1;
            }
        }
        if (!step_memory_unpin(&guard, 0)) return 0;
        machine->find_offset += count;
    }
}

static int step_memory_copy_until_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin != 7u) return step_fail(9u);
    if (!machine->copy_active) {
        u64 source, target, start, limit, target_end, sentinel, shape;
        if (!step_operand(begin, &source)
                || !step_operand(begin + 1u, &target)
                || !step_operand(begin + 2u, &start)
                || !step_operand(begin + 3u, &limit)
                || !step_operand(begin + 4u, &target_end)
                || !step_operand(begin + 5u, &sentinel)
                || !step_operand(begin + 6u, &shape))
            return 0;
        u32 width = (u32)shape & 255u;
        u32 scale = (u32)(shape >> 8) & 31u;
        int virtual64 = (shape & 0x10000u) != 0u;
        if (width != 1u || (shape & ~0x11fffull)
                || start > 0xffffffffull || limit > 0xffffffffull
                || start >= limit)
            return step_fail(9u);
        u64 source_base = virtual64 ? source : (u64)(u32)source;
        u64 target_base = virtual64 ? target : (u64)(u32)target;
        source_base <<= scale;
        target_base <<= scale;
        if (!virtual64) {
            source_base = (u32)source_base;
            target_base = (u32)target_base;
        }
        machine->copy_active = 1u;
        machine->copy_lane = machine->execution_lane;
        machine->copy_phase = 0u;
        machine->copy_sentinel = (u32)sentinel & 255u;
        machine->copy_source = source_base;
        machine->copy_target = target_base;
        machine->copy_index = start;
        machine->copy_limit = limit;
        machine->copy_target_end = target_end;
    } else if (machine->copy_lane != machine->execution_lane) {
        return step_fail(12u);
    }

    for (;;) {
        if (machine->copy_phase == 1u) {
            while (machine->copy_pending_at < machine->copy_pending) {
                u64 address = machine->copy_target + machine->copy_index
                            + machine->copy_pending_at;
                u32 page_shift = machine->memory_page_shift;
                u32 page_bytes = 1u << page_shift;
                u32 offset = (u32)(address & (page_bytes - 1u));
                u32 count = machine->copy_pending
                          - machine->copy_pending_at;
                if (count > page_bytes - offset) count = page_bytes - offset;
                StepMemoryGuard guard;
                if (!step_memory_ready(address, count, &guard)) return 0;
                u64 page = address >> page_shift;
                u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
                for (u32 byte = 0; byte < count; ++byte)
                    machine->memory[slot][offset + byte]
                        = machine->copy_buffer[
                            machine->copy_pending_at + byte];
                if (!step_memory_unpin(&guard, 1)) return 0;
                machine->copy_pending_at += count;
            }
            machine->copy_index += machine->copy_advance;
            machine->copy_phase = 0u;
            if (machine->copy_hit
                    || machine->copy_index == machine->copy_limit) {
                *result = ((u64)machine->copy_last << 32)
                        | machine->copy_index;
                machine->copy_active = 0u;
                return 1;
            }
        }

        u64 address = machine->copy_source + machine->copy_index;
        u32 page_shift = machine->memory_page_shift;
        u32 page_bytes = 1u << page_shift;
        u32 offset = (u32)(address & (page_bytes - 1u));
        u64 remaining = machine->copy_limit - machine->copy_index;
        u32 count = (u32)(remaining < page_bytes - offset
                        ? remaining : page_bytes - offset);
        u64 target_at = machine->copy_target + machine->copy_index;
        if (target_at > ~0ull - (count - 1u))
            count = (u32)(~target_at + 1u);
        u64 dependency = machine->copy_target - machine->copy_source;
        if (target_at < machine->copy_target_end
                && dependency && dependency < count)
            count = (u32)dependency;
        StepMemoryGuard guard;
        if (!step_memory_ready(address, count, &guard)) return 0;
        u64 page = address >> page_shift;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        u32 observed = count;
        machine->copy_hit = 0u;
        for (u32 byte = 0; byte < count; ++byte) {
            u32 value = machine->memory[slot][offset + byte];
            if (value == machine->copy_sentinel) {
                observed = byte;
                machine->copy_hit = 1u;
                machine->copy_last = value;
                break;
            }
            machine->copy_buffer[byte] = (u8)value;
            machine->copy_last = value;
        }
        if (!step_memory_unpin(&guard, 0)) return 0;
        u64 writable = target_at < machine->copy_target_end
                     ? machine->copy_target_end - target_at : 0u;
        machine->copy_pending = observed < writable
                              ? observed : (u32)writable;
        machine->copy_pending_at = 0u;
        machine->copy_advance = observed;
        machine->copy_phase = 1u;
    }
}

static u32 step_relative_width(StepWorkspace *machine, u32 lane)
{
    return (u32)(machine->relative_layout >> (8u * (lane + 1u))) & 255u;
}

static int step_memory_relative_exchange_lane(
    u32 node, u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin < 7u) return step_fail(9u);
    if (!machine->relative_active) {
        u64 selector, mode;
        if (!step_operand(begin, &machine->relative_left)
                || !step_operand(begin + 1u, &machine->relative_right)
                || !step_operand(begin + 2u, &machine->relative_delta)
                || !step_operand(begin + 3u, &machine->relative_prior_flags)
                || !step_operand(begin + 4u, &machine->relative_layout)
                || !step_operand(begin + 5u, &selector)
                || !step_operand(begin + 6u, &mode))
            return 0;
        machine->relative_count = (u32)machine->relative_layout & 255u;
        machine->relative_mode = (u32)mode;
        u32 selected;
        if (!machine->relative_count || machine->relative_count > 7u
                || machine->relative_mode > STEP_RELATIVE_SAVE_CAP
                || end - begin < 7u + machine->relative_mode * 3u
                || (machine->relative_count < 7u
                    && machine->relative_layout
                       >> (8u * (machine->relative_count + 1u)))
                || !step_relative_selected(
                    machine->relative_count, machine->relative_mode,
                    (u32)selector, &selected))
            return step_fail(9u);
        for (u32 save = 0; save < machine->relative_mode; ++save) {
            u64 base, offset;
            u32 at = begin + 7u + save * 3u;
            if (!step_operand(at, &base)
                    || !step_operand(at + 1u, &offset)
                    || !step_operand(
                        at + 2u, &machine->relative_saved_value[save]))
                return 0;
            machine->relative_save_address[save] = base + offset;
        }
        for (u32 lane = 0; lane < machine->relative_count; ++lane) {
            u32 width = step_relative_width(machine, lane);
            if (width != 1u && width != 2u
                    && width != 4u && width != 8u)
                return step_fail(9u);
        }
        machine->relative_active = 1u;
        machine->relative_node = node;
        machine->relative_lane = 0u;
        machine->relative_phase = machine->relative_mode ? 4u : 0u;
        machine->relative_save_lane = 0u;
        machine->relative_restore_lane = 0u;
        machine->relative_selector = (u32)selector;
        machine->relative_last_left = 0u;
    } else if (machine->relative_node != node) {
        return step_fail(12u);
    }

    if (machine->relative_phase == 4u) {
        while (machine->relative_save_lane < machine->relative_mode) {
            u32 save = machine->relative_save_lane;
            StepMemoryGuard guard;
            if (!step_memory_ready(
                    machine->relative_save_address[save], 8u, &guard))
                return 0;
            if (!step_memory_store(
                    machine->relative_save_address[save],
                    machine->relative_saved_value[save], 8u, &guard))
                return 0;
            machine->relative_save_lane += 1u;
        }
        machine->relative_phase = 0u;
    }

    u32 offset = 0u;
    for (u32 lane = 0; lane < machine->relative_lane; ++lane)
        offset += step_relative_width(machine, lane);
    while (machine->relative_phase < 3u) {
        u32 lane = machine->relative_lane;
        u32 width = step_relative_width(machine, lane);
        u64 mask = step_mask(width * 8u);
        StepMemoryGuard guard;
        if (machine->relative_phase == 0u) {
            u64 value;
            if (!step_memory_ready(
                    machine->relative_right + offset, width, &guard))
                return 0;
            if (!step_memory_load(
                    machine->relative_right + offset, width, &guard, &value))
                return 0;
            machine->relative_results[lane * 2u]
                = (value - machine->relative_delta) & mask;
            machine->relative_phase = 1u;
        }
        if (machine->relative_phase == 1u) {
            u64 value;
            if (!step_memory_ready(
                    machine->relative_left + offset, width, &guard))
                return 0;
            if (!step_memory_load(
                    machine->relative_left + offset, width, &guard, &value))
                return 0;
            machine->relative_last_left = value;
            machine->relative_results[lane * 2u + 1u]
                = (value + machine->relative_delta) & mask;
            machine->relative_phase = 2u;
        }
        if (!step_memory_ready(
                machine->relative_left + offset, width, &guard))
            return 0;
        if (!step_memory_store(
                machine->relative_left + offset,
                machine->relative_results[lane * 2u], width, &guard))
            return 0;
        machine->relative_lane += 1u;
        if (machine->relative_lane == machine->relative_count) {
            machine->relative_lane = 0u;
            machine->relative_phase = 3u;
            break;
        }
        offset += width;
        machine->relative_phase = 0u;
    }

    offset = 0u;
    while (machine->relative_lane < machine->relative_count) {
        u32 lane = machine->relative_lane;
        u32 width = step_relative_width(machine, lane);
        StepMemoryGuard guard;
        if (!step_memory_ready(
                machine->relative_right + offset, width, &guard))
            return 0;
        if (!step_memory_store(
                machine->relative_right + offset,
                machine->relative_results[lane * 2u + 1u], width, &guard))
            return 0;
        machine->relative_lane += 1u;
        offset += width;
    }

    u32 last_width = step_relative_width(
        machine, machine->relative_count - 1u);
    if (!step_x86_flags_value(
            machine->relative_prior_flags, machine->relative_delta,
            machine->relative_last_left,
            machine->relative_results[machine->relative_count * 2u - 1u],
            last_width * 8u | (1u << 8),
            &machine->relative_results[machine->relative_count * 2u]))
        return 0;
    while (machine->relative_restore_lane < machine->relative_mode) {
        u32 save = machine->relative_restore_lane;
        StepMemoryGuard guard;
        if (!step_memory_ready(
                machine->relative_save_address[save], 8u, &guard))
            return 0;
        if (!step_memory_load(
                machine->relative_save_address[save], 8u, &guard,
                &machine->relative_results[
                    machine->relative_count * 2u + 1u + save]))
            return 0;
        machine->relative_restore_lane += 1u;
    }
    machine->relative_active = 0u;
    machine->relative_completed_node = node;
    u32 selected;
    if (!step_relative_selected(
            machine->relative_count, machine->relative_mode,
            machine->relative_selector, &selected))
        return step_fail(9u);
    *result = machine->relative_results[selected];
    return 1;
}

static int step_memory_relative_result_lane(
    u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin != 2u
            || step_u8(STEP_OPERAND_TAGS, begin) != 3u)
        return step_fail(9u);
    u64 source = step_u64(STEP_OPERAND_VALUES, begin);
    u64 selector;
    if (!step_operand(begin + 1u, &selector)) return 0;
    u32 selected;
    if (source != machine->relative_completed_node
            || !step_relative_selected(
                machine->relative_count, machine->relative_mode,
                (u32)selector, &selected))
        return step_fail(9u);
    *result = machine->relative_results[selected];
    return 1;
}

static int step_memory_relative_address_lane(
    u32 begin, u32 end, u64 *result)
{
    if (end - begin < 5u) return step_fail(9u);
    u64 base, load_offset, mask, addend, shape;
    if (!step_operand(begin, &base)
            || !step_operand(begin + 1u, &load_offset)
            || !step_operand(begin + 2u, &mask)
            || !step_operand(begin + 3u, &addend)
            || !step_operand(begin + 4u, &shape))
        return 0;
    if ((shape & ~0x11fffull) || (shape & 255u) != 8u
            || ((shape >> 8) & 31u) || !(shape & 0x10000u))
        return step_fail(9u);
    u64 address = base + load_offset;
    StepMemoryGuard guard;
    u64 observed;
    if (!step_memory_ready(address, 8u, &guard)) return 0;
    if (!step_memory_load(address, 8u, &guard, &observed)) return 0;
    *result = base + addend + (observed & mask);
    return 1;
}

static int step_memory_pre_store_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin < 4u) return step_fail(9u);
    u64 pointer, value, decrement, shape;
    if (!step_operand(begin, &pointer)
            || !step_operand(begin + 1u, &value)
            || !step_operand(begin + 2u, &decrement)
            || !step_operand(begin + 3u, &shape))
        return 0;
    u32 width = (u32)shape & 255u;
    if ((shape & ~0x11fffull) || !width || width > 8u
            || (width & (width - 1u)) || ((shape >> 8) & 31u)
            || !(shape & 0x10000u))
        return step_fail(9u);
    u64 address = pointer - decrement;
    StepMemoryGuard guard;
    if (!step_memory_ready(address, width, &guard)) return 0;
    if (!step_memory_store(address, value, width, &guard)) return 0;
    *result = address;
    return 1;
}

static int step_output(u32 tag_column, u32 value_column, u32 index,
                       u64 *result)
{
    StepWorkspace *machine = step_machine();
    u32 tag = step_u8(tag_column, index);
    u64 coordinate = step_u64(value_column, index);
    if (tag == 0u) *result = coordinate;
    else if (tag == 1u) *result = machine->stack[coordinate];
    else if (tag == 2u) *result = machine->locals[coordinate];
    else if (tag == 3u) *result = machine->values[coordinate];
    else if (tag == 4u) {
        u64 source = coordinate >> 8u;
        u32 selector = (u32)coordinate & 255u;
        if (source != machine->relative_completed_node
                || !step_projection_is(
                    coordinate, machine->relative_completed_node))
            return step_fail(6u);
        u32 selected;
        if (!step_relative_selected(
                machine->relative_count, machine->relative_mode,
                selector, &selected))
            return step_fail(6u);
        *result = machine->relative_results[selected];
    }
    else return step_fail(6u);
    return 1;
}

EXPORT int vm_step_execute(u64 session, u32 local_count, u32 stack_count)
{
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || machine->error
            || local_count != machine->local_extent
            || stack_count != machine->stack_inputs)
        return STEP_TRAP;
    if (machine->memory_status) return machine->memory_status;
    if (!machine->execution_active) {
        for (u32 node = 0; node <= machine->work; ++node)
            machine->values[node] = 0;
        machine->execution_active = 1;
        machine->execution_depth = 0;
        machine->execution_lane = step_u32(STEP_WAVE_OFFSETS, 0);
        machine->repeat_active = 0;
        machine->find_active = 0;
        machine->copy_active = 0;
        machine->relative_active = 0;
        machine->relative_completed_node = 0;
    }
    while (machine->execution_depth < machine->span) {
        u32 end = step_u32(
            STEP_WAVE_OFFSETS, machine->execution_depth + 1u);
        while (machine->execution_lane < end) {
            u32 node = step_u32(
                STEP_LANE_VALUES, machine->execution_lane);
            u32 first = step_u32(STEP_ARGUMENT_OFFSETS, node - 1u);
            u32 last = step_u32(STEP_ARGUMENT_OFFSETS, node);
            u32 opcode = step_u8(STEP_OPCODES, node - 1u);
            int produced = (opcode < 140u
                ? step_lane(opcode, first, last, &machine->values[node])
                : opcode < 183u
                ? step_memory_lane(opcode, first, last,
                                   &machine->values[node])
                : opcode == 183u
                ? step_x86_flags_lane(first, last, &machine->values[node])
                : opcode == 184u
                ? step_memory_repeat_lane(first, last, &machine->values[node])
                : opcode == 185u
                ? step_memory_find2_lane(first, last,
                                         &machine->values[node])
                : opcode == 186u
                ? step_memory_copy_until_lane(first, last,
                                              &machine->values[node])
                : opcode == 187u
                ? step_x86_flags_select_lane(first, last,
                                             &machine->values[node])
                : opcode == 188u
                ? step_memory_relative_exchange_lane(
                    node, first, last, &machine->values[node])
                : opcode == 189u
                ? step_memory_relative_result_lane(
                    first, last, &machine->values[node])
                : opcode == 190u
                ? step_memory_relative_address_lane(
                    first, last, &machine->values[node])
                : opcode == 191u
                ? step_x86_compare_lane(
                    first, last, &machine->values[node])
                : opcode == 192u
                ? step_memory_pre_store_lane(
                    first, last, &machine->values[node])
                : opcode == 193u
                ? step_x86_shift_flags_lane(
                    first, last, &machine->values[node])
                : opcode == 194u
                ? step_x86_condition_lane(
                    first, last, &machine->values[node])
                : opcode == 195u
                ? step_x86_test_lane(
                    first, last, &machine->values[node])
                : opcode == 196u
                ? step_add3_u32_lane(
                    first, last, &machine->values[node])
                : step_fail(7u));
            if (!produced) {
                if (machine->memory_status) return machine->memory_status;
                machine->execution_active = 0;
                return STEP_TRAP;
            }
            machine->execution_lane += 1u;
        }
        machine->execution_depth += 1u;
        if (machine->execution_depth < machine->span)
            machine->execution_lane = step_u32(
                STEP_WAVE_OFFSETS, machine->execution_depth);
    }

    for (u32 index = 0; index < machine->local_updates; ++index) {
        u32 coordinate = step_u32(STEP_LOCAL_INDICES, index);
        u64 value;
        if (!step_output(STEP_LOCAL_TAGS, STEP_LOCAL_VALUES, index, &value))
            { machine->execution_active = 0; return STEP_TRAP; }
        machine->locals[coordinate] = value;
    }
    for (u32 index = 0; index < machine->stack_count; ++index) {
        u64 value;
        if (!step_output(STEP_STACK_TAGS, STEP_STACK_VALUES, index, &value))
            { machine->execution_active = 0; return STEP_TRAP; }
        machine->stack[index] = value;
    }
    machine->execution_active = 0;
    return STEP_OK;
}

/* ---------------------------------------------- retained program state ---
 * A program consumes only physical STEP pages and fixed-width barrier pages.
 * Arithmetic never falls back to this scheduler.  The scheduler retains call
 * state inside vm.wasm and copies a cut to the STEP columns only while the two
 * workspaces are distinct; sharing those arrays is a later layout change, not
 * a second execution route.
 */
static ProgramWorkspace *program_machine(void)
{
    return &workspace.runtime.program;
}

static int program_fail(u32 error)
{
    ProgramWorkspace *program = program_machine();
    program->error = error;
    program->step_active = 0;
    return STEP_TRAP;
}

EXPORT int vm_program_open(u64 session, u32 function, u32 local_count,
                           u32 argument_count, u32 result_count,
                           u32 global_count)
{
    if (!step_session_is(session) || argument_count > local_count
            || local_count > GUEST_VALUE_CAP
            || global_count > PROGRAM_GLOBAL_CAP)
        return 0;
    ProgramWorkspace *program = program_machine();
    program->function = function;
    program->pc = 0;
    program->local_base = 0;
    program->local_count = local_count;
    program->local_top = local_count;
    program->stack_base = 0;
    program->stack_count = 0;
    program->result_count = result_count;
    program->result_base = 0;
    program->global_count = global_count;
    program->frame_count = 0;
    program->step_active = 0;
    program->active = 1;
    program->halted = 0;
    program->error = 0;
    for (u32 index = argument_count; index < local_count; ++index)
        program->locals[index] = 0;
    return 1;
}

EXPORT u64 *vm_program_locals(u64 session)
{
    return step_session_is(session) ? program_machine()->locals : (u64 *)0;
}

EXPORT u64 *vm_program_globals(u64 session)
{
    return step_session_is(session) ? program_machine()->globals : (u64 *)0;
}

EXPORT u64 *vm_program_results(u64 session)
{
    ProgramWorkspace *program = program_machine();
    return step_session_is(session) && program->halted
         ? program->stack + program->result_base : (u64 *)0;
}

EXPORT u32 vm_program_result_count(u64 session)
{
    return step_session_is(session) && program_machine()->halted
         ? program_machine()->result_count : 0;
}

EXPORT u32 vm_program_function(u64 session)
{
    return step_session_is(session) && program_machine()->active
         ? program_machine()->function : STEP_NO_PAGE;
}

EXPORT u32 vm_program_pc(u64 session)
{
    return step_session_is(session) && program_machine()->active
         ? program_machine()->pc : STEP_NO_PAGE;
}

EXPORT u32 vm_program_stack_size(u64 session)
{
    return step_session_is(session) && program_machine()->active
         ? program_machine()->stack_count : 0;
}

EXPORT u32 vm_program_error(u64 session)
{
    return step_session_is(session) ? program_machine()->error : 1u;
}

EXPORT int vm_program_halted(u64 session)
{
    return step_session_is(session) && program_machine()->halted;
}

EXPORT int vm_program_apply_step(u64 session, u32 bytes)
{
    if (!step_session_is(session)) return STEP_TRAP;
    ProgramWorkspace *program = program_machine();
    StepWorkspace *step = step_machine();
    if (!program->active || program->halted || program->error)
        return program_fail(2u);
    if (!program->step_active) {
        if (!vm_step_open(session, bytes)) return program_fail(3u);
        if (step->function != program->function || step->start != program->pc
                || step->local_extent != program->local_count
                || step->stack_inputs != program->stack_count)
            return program_fail(4u);
        for (u32 index = 0; index < program->local_count; ++index)
            step->locals[index] = program->locals[
                program->local_base + index];
        for (u32 index = 0; index < program->stack_count; ++index)
            step->stack[index] = program->stack[
                program->stack_base + index];
        program->step_active = 1;
    } else if (bytes != step->page_bytes) {
        return program_fail(5u);
    }

    int status = vm_step_execute(
        session, program->local_count, program->stack_count);
    if (status != STEP_OK) {
        if (status == STEP_TRAP) return program_fail(6u);
        return status;
    }
    if (program->stack_base + step->stack_count > GUEST_VALUE_CAP)
        return program_fail(7u);
    for (u32 index = 0; index < program->local_count; ++index)
        program->locals[program->local_base + index] = step->locals[index];
    for (u32 index = 0; index < step->stack_count; ++index)
        program->stack[program->stack_base + index] = step->stack[index];
    program->stack_count = step->stack_count;
    program->pc = step->end;
    program->step_active = 0;
    return STEP_OK;
}

EXPORT int vm_program_apply_barrier(u64 session, u32 bytes)
{
    if (!step_session_is(session)) return STEP_TRAP;
    ProgramWorkspace *program = program_machine();
    StepWorkspace *step = step_machine();
    if (!program->active || program->halted || program->error
            || program->step_active || step->memory_status
            || bytes != BARRIER_HEADER_BYTES)
        return program_fail(8u);
    const u8 *page = step->page;
    if (page[0] != 'B' || page[1] != 'A' || page[2] != 'R'
            || page[3] != 'R' || read_u16(page + 4u) != 1u
            || read_u16(page + 6u) != BARRIER_HEADER_BYTES
            || read_u32(page + 8u) != program->function
            || read_u32(page + 12u) != program->pc
            || read_u32(page + 24u) != program->stack_count
            || read_u32(page + 44u))
        return program_fail(9u);

    u32 next_pc = read_u32(page + 16u);
    u32 operation = read_u32(page + 20u);
    u32 a = read_u32(page + 28u);
    u32 b = read_u32(page + 32u);
    u32 c = read_u32(page + 36u);
    u32 d = read_u32(page + 40u);
    if (operation == BARRIER_GLOBAL_GET) {
        if (a >= program->global_count
                || program->stack_base + program->stack_count
                   >= GUEST_VALUE_CAP)
            return program_fail(10u);
        program->stack[program->stack_base + program->stack_count++]
            = program->globals[a];
        program->pc = next_pc;
    } else if (operation == BARRIER_GLOBAL_SET) {
        if (a >= program->global_count || !program->stack_count)
            return program_fail(11u);
        program->globals[a] = program->stack[
            program->stack_base + --program->stack_count];
        program->pc = next_pc;
    } else if (operation == BARRIER_CALL) {
        u32 callee = a, callee_locals = b, parameters = c, results = d;
        if (parameters > program->stack_count
                || parameters > callee_locals
                || program->frame_count >= PROGRAM_FRAME_CAP
                || program->local_top + callee_locals > GUEST_VALUE_CAP)
            return program_fail(12u);
        u32 argument_at = program->stack_base
                        + program->stack_count - parameters;
        ProgramFrame *parent = &program->frames[program->frame_count++];
        parent->function = program->function;
        parent->pc = next_pc;
        parent->local_base = program->local_base;
        parent->local_count = program->local_count;
        parent->stack_base = program->stack_base;
        parent->stack_count = program->stack_count - parameters;
        parent->result_count = program->result_count;
        u32 local_base = program->local_top;
        for (u32 index = 0; index < parameters; ++index)
            program->locals[local_base + index]
                = program->stack[argument_at + index];
        for (u32 index = parameters; index < callee_locals; ++index)
            program->locals[local_base + index] = 0;
        program->function = callee;
        program->pc = 0;
        program->local_base = local_base;
        program->local_count = callee_locals;
        program->local_top = local_base + callee_locals;
        program->stack_base = argument_at;
        program->stack_count = 0;
        program->result_count = results;
    } else if (operation == BARRIER_RETURN) {
        u32 results = a;
        if (results != program->result_count
                || results > program->stack_count)
            return program_fail(13u);
        u32 source = program->stack_base + program->stack_count - results;
        if (!program->frame_count) {
            program->result_base = source;
            program->stack_count = results;
            program->pc = next_pc;
            program->halted = 1;
            return STEP_OK;
        }
        ProgramFrame parent = program->frames[--program->frame_count];
        u32 target = parent.stack_base + parent.stack_count;
        for (u32 index = 0; index < results; ++index)
            program->stack[target + index] = program->stack[source + index];
        program->local_top = program->local_base;
        program->function = parent.function;
        program->pc = parent.pc;
        program->local_base = parent.local_base;
        program->local_count = parent.local_count;
        program->stack_base = parent.stack_base;
        program->stack_count = parent.stack_count + results;
        program->result_count = parent.result_count;
    } else {
        return program_fail(14u);
    }
    return STEP_OK;
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

/* Apply a 16-bit-to-8-bit artifact to a byte vector with one fixed high
 * input byte. The source and target occupy the unused tail of the artifact
 * buffer, so the operation needs no second arena and crosses the host boundary
 * once per vector rather than once per byte. `clear_target` selects assignment
 * for the first vector and XOR accumulation for later vectors. */
EXPORT u8 *vm_eval_source(void) { return artifact + EVAL_SOURCE_OFFSET; }
EXPORT u8 *vm_eval_target(void) { return artifact + EVAL_TARGET_OFFSET; }
EXPORT u32 vm_eval_batch_capacity(void) { return EVAL_BATCH_BYTES; }

EXPORT int vm_eval_byte_combine(u32 count, u32 fixed_byte, u32 clear_target)
{
    if (!eval_ok || eval_artifact_len > EVAL_SOURCE_OFFSET
            || eval_input_bits != 16u || eval_input_bytes != 2u
            || eval_output_bytes != 1u || count > EVAL_BATCH_BYTES
            || fixed_byte > 255u) return 0;

    u8 *source = artifact + EVAL_SOURCE_OFFSET;
    u8 *target = artifact + EVAL_TARGET_OFFSET;
    u32 high = fixed_byte << 8u;
    if (clear_target) {
        for (u32 i = 0; i < count; ++i) {
            target[i] = (u8)eval_word((u32)source[i] | high);
            if (!eval_ok) return 0;
        }
    } else {
        for (u32 i = 0; i < count; ++i) {
            target[i] ^= (u8)eval_word((u32)source[i] | high);
            if (!eval_ok) return 0;
        }
    }
    return 1;
}

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
