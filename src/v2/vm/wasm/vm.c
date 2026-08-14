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
#define GUEST_CONTROL_CAP 128u
#define STEP_PAGE_BYTES ARTIFACT_BYTES
#define STEP_VALUE_CAP GUEST_VALUE_CAP
#define STEP_COLUMN_COUNT 11u
#define STEP_MEMORY_PAGES 4u
#define STEP_NO_PAGE 0xffffffffu
#define STEP_NO_COORDINATE (~0ull)
#define STEP_RELATIVE_SAVE_CAP 4u
#define STEP_REGION_CAP 32u
#define STEP_REGION_RESULT_CAP 9u
#define PROGRAM_FRAME_CAP 256u
#define PROGRAM_GLOBAL_CAP 4096u
#define X86_REGISTER_COUNT 16u
#define X86_BLOCK_HEADER_BYTES 64u
#define X86_PHYSICAL_PAGE_BYTES 4096u
#define X86_PHYSICAL_PAGES 256u
#define X86_BLOCK_CACHE_SLOTS 2048u
#define X86_BLOCK_CACHE_BYTES 1024u
#define X86_NO_PAGE (~0ull)
#define X86_SYSTEM_COUNT 22u
#define X86_MSR_CAP 32u
#define X86_CONSOLE_CAP 4096u
#define X86_CONSOLE_OUTPUT_CAP 256u
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
    u32 control_target[GUEST_CONTROL_CAP];
    u32 control_stack[GUEST_CONTROL_CAP];
    u8 control_kind[GUEST_CONTROL_CAP];
    u32 code_bytes;
    u32 body_start;
    u32 body_end;
    u32 cursor;
    u32 requested_page;
    u32 stack_size;
    u32 local_count;
    u32 local_groups;
    u32 control_size;
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
    u64 alu_result[STEP_VALUE_CAP + 1u];
    u64 region_results[STEP_REGION_CAP][STEP_REGION_RESULT_CAP];
    u32 region_source[STEP_REGION_CAP];
    u32 region_width[STEP_REGION_CAP];
    u32 region_slots;
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
    u64 requested_memory_address;
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
    u32 prefix_active;
    u32 prefix_lane;
    u32 prefix_phase;
    u32 prefix_length;
    u64 prefix_address;
    u64 prefix_remaining;
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

/* A native x86 continuation consumes build-time packed STEP/control records.
 * The browser supplies records and physical pages by coordinate; CPU state,
 * control selection, and the virtual-memory lease remain in this module. */
typedef struct {
    u64 registers[X86_REGISTER_COUNT];
    u64 xmm[32];
    u64 rip;
    u64 rflags;
    u64 cr0;
    u64 cr3;
    u64 cr4;
    u64 efer;
    u64 system[X86_SYSTEM_COUNT];
    u64 msr_keys[X86_MSR_CAP];
    u64 msr_values[X86_MSR_CAP];
    u32 msr_count;
    u64 memory_bytes;
    u64 retired;
    u64 work;
    u64 span;
    u64 control_argument[3];
    u8 block_cache[X86_BLOCK_CACHE_SLOTS][X86_BLOCK_CACHE_BYTES];
    u64 block_cache_rip[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_bytes[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_valid[X86_BLOCK_CACHE_SLOTS];
    u8 physical[X86_PHYSICAL_PAGES][X86_PHYSICAL_PAGE_BYTES];
    u8 physical_transfer[X86_PHYSICAL_PAGE_BYTES];
    u64 physical_page[X86_PHYSICAL_PAGES];
    u64 physical_age[X86_PHYSICAL_PAGES];
    u64 physical_clock;
    u64 physical_lease;
    u64 physical_coordinate;
    u32 physical_valid[X86_PHYSICAL_PAGES];
    u32 physical_dirty[X86_PHYSICAL_PAGES];
    u32 step_physical_slot[STEP_MEMORY_PAGES];
    u32 step_physical_valid[STEP_MEMORY_PAGES];
    u32 step_physical_write[STEP_MEMORY_PAGES];
    u32 physical_status;
    u32 control;
    u32 block_loaded;
    u32 exception_pending;
    u32 exception_vector;
    u32 exception_has_error;
    u32 exception_error;
    u32 quantum_blocks;
    u32 quantum_cache_hits;
    u64 console_lease;
    u32 console_status;
    u8 console_output[X86_CONSOLE_OUTPUT_CAP];
    u32 console_output_count;
    u64 clock_lease;
    u32 clock_status;
    u64 entropy_lease;
    u32 entropy_status;
    u8 uart[8];
    u8 uart_valid[8];
    u32 pit_counter;
    u32 pit_low_latch;
    u32 pit_read_phase;
    u32 pit_write_phase;
    u8 pic_mask[2];
    u32 timer_source_instructions;
    u32 uart_tx_pending;
    u8 console_input[X86_CONSOLE_CAP];
    u32 console_head;
    u32 console_count;
    u32 active;
    u32 halted;
    u32 error;
} X86Workspace;

typedef struct {
    GuestWorkspace guest;
    StepWorkspace step;
    ProgramWorkspace program;
    X86Workspace x86;
} RuntimeWorkspace;

typedef union {
    CodecWorkspace codec;
    RuntimeWorkspace runtime;
} MachineWorkspace;

static MachineWorkspace workspace;
static u32 workspace_mode;

/* x86 STEP pages and the MMU share one physical byte array.  The STEP slot
 * retains a virtual tag/lease only; its data pointer is the translated
 * physical cache slot.  Generic Wasm state execution continues to use the
 * local STEP array. */
static int step_memory_is_direct(StepWorkspace *machine, u32 slot)
{
    X86Workspace *x86 = &workspace.runtime.x86;
    return machine == &workspace.runtime.step && x86->active
        && slot < STEP_MEMORY_PAGES && x86->step_physical_valid[slot]
        && x86->step_physical_slot[slot] < X86_PHYSICAL_PAGES;
}

static u8 *step_memory_bytes(StepWorkspace *machine, u32 slot)
{
    X86Workspace *x86 = &workspace.runtime.x86;
    return step_memory_is_direct(machine, slot)
         ? x86->physical[x86->step_physical_slot[slot]]
         : machine->memory[slot];
}
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

static void store_u64(u8 *target, u64 value)
{
    for (u32 i = 0; i < 8u; ++i)
        target[i] = (u8)(value >> (8u * i));
}

static void store_u32(u8 *target, u32 value)
{
    for (u32 i = 0; i < 4u; ++i)
        target[i] = (u8)(value >> (8u * i));
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
EXPORT u32 vm_guest_local_count(void) { return guest()->local_count; }
EXPORT u64 vm_guest_local(u32 index)
{
    GuestWorkspace *machine = guest();
    return index < machine->local_count ? machine->locals[index] : 0;
}
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
    machine->control_size = 0;
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
    machine->control_size = 0;
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

        if (opcode == 0x0fu
                || (opcode == 0x0bu && !machine->control_size)) {
            machine->cursor = at;
            machine->result = machine->stack_size
                              ? machine->values[machine->stack_size - 1u] : 0;
            machine->phase = 4u;
            return GUEST_RETURNED;
        } else if (opcode == 0x0bu) {
            machine->control_size -= 1u;
        } else if (opcode == 0x03u) {
            u8 block_type;
            if (!guest_byte(at++, &block_type))
                return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;
            if (block_type != 0x40u
                    || machine->control_size >= GUEST_CONTROL_CAP) {
                guest_trap(7u);
                return GUEST_TRAP;
            }
            u32 slot = machine->control_size++;
            machine->control_target[slot] = at;
            machine->control_stack[slot] = machine->stack_size;
            machine->control_kind[slot] = 1u;
        } else if (opcode == 0x0cu || opcode == 0x0du) {
            if (!guest_uleb(at, 32u, &index, &at))
                return machine->error ? GUEST_TRAP : GUEST_CODE_PAGE;
            u64 selected = 1u;
            if (opcode == 0x0du && !guest_pop(&selected)) return GUEST_TRAP;
            if (selected) {
                if (index >= machine->control_size) {
                    guest_trap(7u);
                    return GUEST_TRAP;
                }
                u32 slot = machine->control_size - 1u - (u32)index;
                if (machine->control_kind[slot] != 1u) {
                    guest_trap(7u);
                    return GUEST_TRAP;
                }
                machine->stack_size = machine->control_stack[slot];
                machine->control_size = slot + 1u;
                at = machine->control_target[slot];
            }
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
        } else if (opcode == 0x1bu) {
            u64 condition;
            if (!guest_pop(&condition) || !guest_pop(&right)
                    || !guest_pop(&left)
                    || !guest_push(condition ? left : right))
                return GUEST_TRAP;
        } else if (opcode >= 0x67u && opcode <= 0x69u) {
            if (!guest_pop(&left)) return GUEST_TRAP;
            u32 value = (u32)left;
            if (opcode == 0x67u) left = value ? (u32)__builtin_clz(value) : 32u;
            else if (opcode == 0x68u)
                left = value ? (u32)__builtin_ctz(value) : 32u;
            else left = (u32)__builtin_popcount(value);
            if (!guest_push(left)) return GUEST_TRAP;
        } else if (opcode >= 0x79u && opcode <= 0x7bu) {
            if (!guest_pop(&left)) return GUEST_TRAP;
            if (opcode == 0x79u)
                left = left ? (u64)__builtin_clzll(left) : 64u;
            else if (opcode == 0x7au)
                left = left ? (u64)__builtin_ctzll(left) : 64u;
            else left = (u64)__builtin_popcountll(left);
            if (!guest_push(left)) return GUEST_TRAP;
        } else if (opcode == 0xa7u || opcode == 0xacu || opcode == 0xadu) {
            if (!guest_pop(&left)) return GUEST_TRAP;
            if (opcode == 0xa7u) left = (u32)left;
            else if (opcode == 0xacu) left = (u64)(i64)(int)(u32)left;
            else left = (u32)left;
            if (!guest_push(left)) return GUEST_TRAP;
        } else {
            if (!guest_pop(&right) || !guest_pop(&left)) return GUEST_TRAP;
            if (opcode == 0x46u) left = (u32)left == (u32)right;
            else if (opcode == 0x47u) left = (u32)left != (u32)right;
            else if (opcode == 0x48u)
                left = (int)(u32)left < (int)(u32)right;
            else if (opcode == 0x49u) left = (u32)left < (u32)right;
            else if (opcode == 0x4au)
                left = (int)(u32)left > (int)(u32)right;
            else if (opcode == 0x4bu) left = (u32)left > (u32)right;
            else if (opcode == 0x4cu)
                left = (int)(u32)left <= (int)(u32)right;
            else if (opcode == 0x4du) left = (u32)left <= (u32)right;
            else if (opcode == 0x4eu)
                left = (int)(u32)left >= (int)(u32)right;
            else if (opcode == 0x4fu) left = (u32)left >= (u32)right;
            else if (opcode == 0x51u) left = left == right;
            else if (opcode == 0x52u) left = left != right;
            else if (opcode == 0x53u) left = (i64)left < (i64)right;
            else if (opcode == 0x54u) left = left < right;
            else if (opcode == 0x55u) left = (i64)left > (i64)right;
            else if (opcode == 0x56u) left = left > right;
            else if (opcode == 0x57u) left = (i64)left <= (i64)right;
            else if (opcode == 0x58u) left = left <= right;
            else if (opcode == 0x59u) left = (i64)left >= (i64)right;
            else if (opcode == 0x5au) left = left >= right;
            else if (opcode == 0x6au) left = (u32)left + (u32)right;
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

enum {
    STEP_PROJECTION_NONE = 0,
    STEP_PROJECTION_RELATIVE = 1,
    STEP_PROJECTION_FLAGS = 2,
    STEP_PROJECTION_ALU_RESULT = 3,
    STEP_PROJECTION_REGION = 4,
};

static int step_flag_projection_opcode(u32 opcode)
{
    return opcode == 183u || opcode == 187u || opcode == 191u
        || opcode == 193u || opcode == 195u || opcode == 197u;
}

static u32 step_projection_kind(u64 coordinate, u32 final_relative_source)
{
    StepWorkspace *machine = step_machine();
    u64 wide_source = coordinate >> 8u;
    u32 selector = (u32)coordinate & 255u;
    if (!wide_source || wide_source > machine->work)
        return STEP_PROJECTION_NONE;
    u32 source = (u32)wide_source;
    u32 opcode = step_u8(STEP_OPCODES, source - 1u);
    if (opcode == 203u || opcode == 204u)
        return selector < 16u ? STEP_PROJECTION_FLAGS
             : selector == 16u ? STEP_PROJECTION_ALU_RESULT
                               : STEP_PROJECTION_NONE;
    if (opcode == 205u) {
        u32 begin = step_u32(STEP_ARGUMENT_OFFSETS, source - 1u);
        u32 end = step_u32(STEP_ARGUMENT_OFFSETS, source);
        if (end - begin < 4u
                || step_u8(STEP_OPERAND_TAGS, begin + 2u) != 0u)
            return STEP_PROJECTION_NONE;
        u64 descriptor = step_u64(STEP_OPERAND_VALUES, begin + 2u);
        u32 count = (u32)descriptor & 255u;
        return count && count <= 8u && !(descriptor & ~0x3ffull)
                && selector <= count
            ? STEP_PROJECTION_REGION : STEP_PROJECTION_NONE;
    }
    if (step_flag_projection_opcode(opcode))
        return selector < 16u ? STEP_PROJECTION_FLAGS
                              : STEP_PROJECTION_NONE;
    if (source != final_relative_source || opcode != 188u)
        return STEP_PROJECTION_NONE;
    u32 begin = step_u32(STEP_ARGUMENT_OFFSETS, source - 1u);
    u32 end = step_u32(STEP_ARGUMENT_OFFSETS, source);
    if (end - begin < 7u) return STEP_PROJECTION_NONE;
    u64 layout = step_u64(STEP_OPERAND_VALUES, begin + 4u);
    u64 mode = step_u64(STEP_OPERAND_VALUES, begin + 6u);
    u32 count = (u32)layout & 255u;
    u32 selected;
    return (mode <= STEP_RELATIVE_SAVE_CAP
            && step_relative_selected(count, (u32)mode, selector, &selected))
        ? STEP_PROJECTION_RELATIVE : STEP_PROJECTION_NONE;
}

static int step_x86_condition_value(u64 flags, u64 code, u64 *result);

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
    if (!step_memory_is_direct(machine, slot)) {
        u8 *source = step_memory_bytes(machine, slot);
        for (u32 byte = 0; byte < machine->memory_valid[slot]; ++byte)
            machine->memory_transfer[byte] = source[byte];
    }
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
    machine->requested_memory_address = STEP_NO_COORDINATE;
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
    machine->requested_memory_address = STEP_NO_COORDINATE;
    machine->flush_memory_page = STEP_NO_COORDINATE;
    machine->memory_lease = 0;
    machine->memory_status = 0;
    workspace.runtime.x86.active = 0;
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot)
        workspace.runtime.x86.step_physical_valid[slot] = 0;
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
    machine->requested_memory_address = STEP_NO_COORDINATE;
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
    machine->requested_memory_address = STEP_NO_COORDINATE;
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
    if (!step_memory_is_direct(machine, slot)) {
        u8 *target = step_memory_bytes(machine, slot);
        for (u32 byte = 0; byte < bytes; ++byte)
            target[byte] = machine->memory_transfer[byte];
    }
    machine->memory_page[slot] = page;
    machine->memory_valid[slot] = bytes;
    machine->memory_next_epoch[slot] = epoch + 1u;
    step_slot_store(machine, slot,
                    step_slot_word(STEP_SLOT_CLEAN, 0, epoch));
    machine->requested_memory_page = STEP_NO_COORDINATE;
    machine->requested_memory_address = STEP_NO_COORDINATE;
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
        if (!machine->values[node] || step_u8(STEP_OPCODES, node - 1u) >= 210u)
            return step_fail(5u);
        u32 begin = step_u32(STEP_ARGUMENT_OFFSETS, node - 1u);
        u32 end = step_u32(STEP_ARGUMENT_OFFSETS, node);
        if (begin > end || end > machine->operands) return step_fail(5u);
        for (u32 at = begin; at < end; ++at) {
            u32 tag = step_u8(STEP_OPERAND_TAGS, at);
            u64 value = step_u64(STEP_OPERAND_VALUES, at);
            u32 projected = (u32)(value >> 8u);
            if (tag > 4u
                    || (tag == 1u && value >= machine->stack_inputs)
                    || (tag == 2u && value >= machine->local_extent)
                    || (tag == 3u && (!value || value > machine->work
                        || machine->values[value] >= machine->values[node]))
                    || (tag == 4u
                        && (!step_projection_kind(value, 0u)
                            || !projected || projected > machine->work
                            || machine->values[projected]
                               >= machine->values[node])))
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
                    && !step_projection_kind(value, projection_source)))
            return step_fail(5u);
    }
    for (u32 output = 0; output < machine->local_updates; ++output) {
        u32 tag = step_u8(STEP_LOCAL_TAGS, output);
        u64 value = step_u64(STEP_LOCAL_VALUES, output);
        if (tag > 4u || (tag == 1u && value >= machine->stack_inputs)
                || (tag == 2u && value >= machine->local_extent)
                || (tag == 3u && (!value || value > machine->work))
                || (tag == 4u
                    && !step_projection_kind(value, projection_source)))
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
    else if (tag == 4u) {
        u32 source = (u32)(coordinate >> 8u);
        u32 selector = (u32)coordinate & 255u;
        u32 projection = step_projection_kind(
            coordinate, machine->relative_completed_node);
        if (projection == STEP_PROJECTION_ALU_RESULT)
            *value = machine->alu_result[source];
        else if (projection == STEP_PROJECTION_FLAGS)
            return step_x86_condition_value(
                machine->values[source], selector, value);
        else if (projection == STEP_PROJECTION_REGION) {
            for (u32 slot = 0; slot < machine->region_slots; ++slot) {
                if (machine->region_source[slot] != source) continue;
                if (selector > machine->region_width[slot])
                    return step_fail(6u);
                *value = machine->region_results[slot][selector];
                return 1;
            }
            return step_fail(6u);
        }
        else
            return step_fail(6u);
    } else return step_fail(6u);
    return 1;
}

static u64 step_mask(u32 bits)
{
    return bits >= 64u ? ~0ull : (1ull << bits) - 1u;
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

static int x86_step_fault_is_write(void);

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
        X86Workspace *x86 = &workspace.runtime.x86;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        if (x86->active && x86_step_fault_is_write()
                && machine->memory_page[slot] == page
                && x86->step_physical_valid[slot]
                && !x86->step_physical_write[slot]) {
            u64 word = step_slot_load(machine, slot);
            if (step_slot_kind(word) != STEP_SLOT_CLEAN
                    || step_slot_pins(word))
                return step_fail(12u);
            x86->step_physical_valid[slot] = 0;
            machine->memory_page[slot] = STEP_NO_COORDINATE;
            machine->memory_valid[slot] = 0;
            step_slot_store(machine, slot, step_slot_word(
                STEP_SLOT_EMPTY, 0, step_slot_epoch(word)));
        }
        u64 page_first = page << page_shift;
        u64 required = address + width - page_first;
        if (required > page_bytes) required = page_bytes;
        machine->requested_memory_address = address > page_first
                                          ? address : page_first;
        if (!step_memory_pin(page, (u32)required, guard)) {
            step_memory_unpin(guard, 0);
            return 0;
        }
    }
    return 1;
}

static u64 step_memory_read_pinned(u64 address, u32 width)
{
    StepWorkspace *machine = step_machine();
    u64 value = 0;
    for (u32 byte = 0; byte < width; ++byte) {
        u64 coordinate = address + byte;
        u64 page = coordinate >> machine->memory_page_shift;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        u64 offset = coordinate & ((1ull << machine->memory_page_shift) - 1u);
        value |= (u64)step_memory_bytes(machine, slot)[offset]
                 << (8u * byte);
    }
    return value;
}

static int step_memory_load(u64 address, u32 width,
                            StepMemoryGuard *guard, u64 *result)
{
    *result = step_memory_read_pinned(address, width);
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
        step_memory_bytes(machine, slot)[offset]
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

static int step_memory_load_region_lane(u32 node, u32 begin, u32 end,
                                        u64 *result)
{
    if (end - begin < 4u) return step_fail(9u);
    u64 address, offset, descriptor, shape;
    if (!step_operand(begin, &address)
            || !step_operand(begin + 1u, &offset)
            || !step_operand(begin + 2u, &descriptor)
            || !step_operand(begin + 3u, &shape))
        return 0;
    u32 count = (u32)descriptor & 255u;
    u32 bits = descriptor & 0x200u ? 32u : 64u;
    int signed_load = (descriptor & 0x100u) != 0u;
    u32 width = (u32)shape & 255u;
    u32 scale = (u32)(shape >> 8u) & 31u;
    int virtual64 = (shape & 0x10000u) != 0u;
    if (!count || count > 8u || (descriptor & ~0x3ffull)
            || (width != 1u && width != 2u
                && width != 4u && width != 8u)
            || scale || (shape & ~0x11fffull) || width * 8u > bits
            || (signed_load && width * 8u >= bits))
        return step_fail(9u);

    u64 base = virtual64 ? address : (u64)(u32)address;
    if (!virtual64 && offset > ~0ull - base) return step_fail(10u);
    u64 effective = base + offset;
    u32 extent = count * width;
    StepMemoryGuard guard;
    if (!step_memory_ready(effective, extent, &guard)) return 0;

    StepWorkspace *machine = step_machine();
    u32 slot = machine->region_slots;
    for (u32 at = 0; at < machine->region_slots; ++at)
        if (machine->region_source[at] == node) { slot = at; break; }
    if (slot == machine->region_slots) {
        if (slot == STEP_REGION_CAP) {
            step_memory_unpin(&guard, 0);
            return step_fail(9u);
        }
        machine->region_slots += 1u;
        machine->region_source[slot] = node;
    }
    machine->region_width[slot] = count;
    u64 mask = step_mask(bits);
    for (u32 index = 0; index < count; ++index) {
        u64 value = step_memory_read_pinned(
            effective + index * width, width);
        if (signed_load && value & (1ull << (width * 8u - 1u)))
            value |= ~0ull << (width * 8u);
        machine->region_results[slot][index] = value & mask;
    }
    machine->region_results[slot][count] = effective + extent;
    *result = machine->region_results[slot][0];
    return step_memory_unpin(&guard, 0);
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

static int step_x86_alu_lane(u32 node, u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin != 4u) return step_fail(7u);
    u64 prior, left, right, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &left)
            || !step_operand(begin + 2u, &right)
            || !step_operand(begin + 3u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    u32 mode = ((u32)descriptor >> 8u) & 7u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || mode > 6u)
        return step_fail(7u);
    u64 carry = prior & 1u;
    u64 value = mode == 0u ? left & right
              : mode == 1u ? left + right
              : mode == 2u ? left + right + carry
              : mode == 3u ? left - right
              : mode == 4u ? left - right - carry
              : mode == 5u ? left | right
                           : left ^ right;
    value &= step_mask(width);
    machine->alu_result[node] = value;
    return step_x86_flags_value(
        prior, left, right, value, descriptor, result);
}

static int step_x86_affine_alu_lane(
        u32 node, u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin != 5u) return step_fail(7u);
    u64 prior, left_base, left_addend, right, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &left_base)
            || !step_operand(begin + 2u, &left_addend)
            || !step_operand(begin + 3u, &right)
            || !step_operand(begin + 4u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    u32 mode = ((u32)descriptor >> 8u) & 7u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || mode > 6u)
        return step_fail(7u);
    u64 lane_mask = step_mask(width);
    u64 left = (left_base + left_addend) & lane_mask;
    u64 carry = prior & 1u;
    u64 value = mode == 0u ? left & right
              : mode == 1u ? left + right
              : mode == 2u ? left + right + carry
              : mode == 3u ? left - right
              : mode == 4u ? left - right - carry
              : mode == 5u ? left | right
                           : left ^ right;
    value &= lane_mask;
    machine->alu_result[node] = value;
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
                && group != 5u && group != 6u && group != 7u))
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
        else if (group == 6u)
            overflow = ((source ^ value) >> (width - 1u)) & 1u;
    }
    *result = (flags & ~(1ull << 11)) | (overflow << 11);
    return 1;
}

static int step_x86_condition_value(u64 flags, u64 code, u64 *result)
{
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

static int step_x86_condition_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 2u) return step_fail(7u);
    u64 flags, code;
    if (!step_operand(begin, &flags)
            || !step_operand(begin + 1u, &code))
        return 0;
    return step_x86_condition_value(flags, code, result);
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

static int step_x86_test_condition_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 3u) return step_fail(7u);
    u64 left, right, descriptor;
    if (!step_operand(begin, &left)
            || !step_operand(begin + 1u, &right)
            || !step_operand(begin + 2u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    u32 condition = ((u32)descriptor >> 8u) & 15u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || descriptor != (u64)(width | (condition << 8u)))
        return step_fail(7u);
    u64 flags;
    if (!step_x86_flags_value(
            0u, left, right, (left & right) & step_mask(width),
            width, &flags))
        return 0;
    return step_x86_condition_value(flags, condition, result);
}

static int step_bit_address_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 3u) return step_fail(7u);
    u64 base, index, descriptor;
    if (!step_operand(begin, &base)
            || !step_operand(begin + 1u, &index)
            || !step_operand(begin + 2u, &descriptor))
        return 0;
    u32 word_bits = (u32)descriptor & 0x7fu;
    u32 index_bits = ((u32)descriptor >> 8u) & 0x7fu;
    if ((word_bits != 16u && word_bits != 32u && word_bits != 64u)
            || (index_bits != 32u && index_bits != 64u)
            || descriptor != (u64)(word_bits | (index_bits << 8u)))
        return step_fail(7u);
    u32 word_shift = word_bits == 16u ? 4u : word_bits == 32u ? 5u : 6u;
    u32 byte_shift = word_shift - 3u;
    i64 signed_index = (i64)index;
    if (index_bits == 32u) {
        u32 low = (u32)index;
        signed_index = low & 0x80000000u
            ? (i64)((u64)low | ~0xffffffffull) : (i64)low;
    }
    i64 displacement = (signed_index >> word_shift)
                     * (i64)(1u << byte_shift);
    *result = base + (u64)displacement;
    return 1;
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

static int step_select_u32_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 3u) return step_fail(7u);
    u64 left, right, condition;
    if (!step_operand(begin, &left)
            || !step_operand(begin + 1u, &right)
            || !step_operand(begin + 2u, &condition))
        return 0;
    *result = (u32)(condition ? left : right);
    return 1;
}

static int step_x86_bit_flags_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 4u) return step_fail(7u);
    u64 prior, value, index, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &value)
            || !step_operand(begin + 2u, &index)
            || !step_operand(begin + 3u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    if ((width != 16u && width != 32u && width != 64u)
            || descriptor != width)
        return step_fail(7u);
    u64 carry = ((value & step_mask(width))
                 >> (index & (width - 1u))) & 1u;
    *result = (prior & ~1ull) | carry | 2u;
    return 1;
}

static int step_mul_high_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 3u) return step_fail(7u);
    u64 left, right, descriptor;
    if (!step_operand(begin, &left)
            || !step_operand(begin + 1u, &right)
            || !step_operand(begin + 2u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    u32 signed_product = ((u32)descriptor >> 8u) & 1u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || descriptor != (u64)(width | (signed_product << 8u)))
        return step_fail(7u);
    u64 lane_mask = step_mask(width);
    left &= lane_mask;
    right &= lane_mask;
    if (width < 64u) {
        u64 product = left * right;
        if (signed_product) {
            i64 signed_left = (i64)(left | ((left & (1ull << (width - 1u)))
                                      ? ~lane_mask : 0u));
            i64 signed_right = (i64)(right | ((right & (1ull << (width - 1u)))
                                        ? ~lane_mask : 0u));
            product = (u64)(signed_left * signed_right);
        }
        *result = (product >> width) & lane_mask;
        return 1;
    }
    u64 left_low = (u32)left;
    u64 right_low = (u32)right;
    u64 left_high = left >> 32u;
    u64 right_high = right >> 32u;
    u64 product_low = left_low * right_low;
    u64 cross_left = left_low * right_high;
    u64 cross_right = left_high * right_low;
    u64 middle = (product_low >> 32u)
               + (u32)cross_left + (u32)cross_right;
    u64 high = left_high * right_high
             + (cross_left >> 32u) + (cross_right >> 32u)
             + (middle >> 32u);
    if (signed_product) {
        if (left >> 63u) high -= right;
        if (right >> 63u) high -= left;
    }
    *result = high;
    return 1;
}

static int step_x86_mul_flags_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin != 4u) return step_fail(7u);
    u64 prior, low, high, descriptor;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &low)
            || !step_operand(begin + 2u, &high)
            || !step_operand(begin + 3u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    u32 signed_product = ((u32)descriptor >> 8u) & 1u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || descriptor != (u64)(width | (signed_product << 8u)))
        return step_fail(7u);
    u64 mask = step_mask(width);
    low &= mask;
    high &= mask;
    u64 expected = signed_product && (low & (1ull << (width - 1u)))
                 ? mask : 0u;
    u64 overflow = high != expected;
    *result = (prior & ~0x801ull) | 2u | (overflow * 0x801u);
    return 1;
}

static int step_insert_lane(u32 begin, u32 end, u32 bits, u64 *result)
{
    if (end - begin != 3u) return step_fail(7u);
    u64 base, value, descriptor;
    if (!step_operand(begin, &base)
            || !step_operand(begin + 1u, &value)
            || !step_operand(begin + 2u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 255u;
    u32 offset = ((u32)descriptor >> 8u) & 255u;
    if (!width || width > bits || offset + width > bits)
        return step_fail(7u);
    u64 field = step_mask(width);
    u64 selected = field << offset;
    *result = ((base & ~selected) | ((value & field) << offset))
            & step_mask(bits);
    return 1;
}

static int step_memory_repeat_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    /* Later operands are dependency tokens.  Composition appends them to
     * serialize memory effects; the first four operands remain the complete
     * repeat semantics. */
    if (end - begin < 4u) return step_fail(9u);
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
            step_memory_bytes(machine, slot)[offset + byte] =
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

static int step_memory_copy_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    /* Later operands are dependency tokens.  The first four completely name
     * the immutable source extent and its destination. */
    if (end - begin < 4u) return step_fail(9u);
    if (!machine->copy_active) {
        u64 source, target, size, shape;
        if (!step_operand(begin, &source)
                || !step_operand(begin + 1u, &target)
                || !step_operand(begin + 2u, &size)
                || !step_operand(begin + 3u, &shape))
            return 0;
        u32 width = (u32)shape & 255u;
        u32 scale = (u32)(shape >> 8u) & 31u;
        int virtual64 = (shape & 0x10000u) != 0u;
        if (width != 1u || (shape & ~0x11fffull))
            return step_fail(9u);
        u64 source_base = virtual64 ? source : (u64)(u32)source;
        u64 target_base = virtual64 ? target : (u64)(u32)target;
        source_base <<= scale;
        target_base <<= scale;
        if (!virtual64) {
            source_base = (u32)source_base;
            target_base = (u32)target_base;
        }
        if (size && (source_base > ~0ull - (size - 1u)
                || target_base > ~0ull - (size - 1u)))
            return step_fail(10u);
        if (!size || source_base == target_base) {
            *result = 0;
            return 1;
        }
        machine->copy_active = 1u;
        machine->copy_lane = machine->execution_lane;
        machine->copy_phase = 0u;
        machine->copy_sentinel = source_base < target_base
                              && target_base - source_base < size;
        machine->copy_source = source_base;
        machine->copy_target = target_base;
        machine->copy_index = 0;
        machine->copy_limit = size;
    } else if (machine->copy_lane != machine->execution_lane) {
        return step_fail(12u);
    }

    for (;;) {
        if (machine->copy_phase == 1u) {
            u64 at = machine->copy_sentinel
                   ? machine->copy_limit - machine->copy_index
                     - machine->copy_pending
                   : machine->copy_index;
            while (machine->copy_pending_at < machine->copy_pending) {
                u64 address = machine->copy_target + at
                            + machine->copy_pending_at;
                u32 page_bytes = 1u << machine->memory_page_shift;
                u32 offset = (u32)(address & (page_bytes - 1u));
                u32 count = machine->copy_pending
                          - machine->copy_pending_at;
                if (count > page_bytes - offset) count = page_bytes - offset;
                StepMemoryGuard guard;
                if (!step_memory_ready(address, count, &guard)) return 0;
                u64 page = address >> machine->memory_page_shift;
                u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
                for (u32 byte = 0; byte < count; ++byte)
                    step_memory_bytes(machine, slot)[offset + byte]
                        = machine->copy_buffer[
                            machine->copy_pending_at + byte];
                if (!step_memory_unpin(&guard, 1)) return 0;
                machine->copy_pending_at += count;
            }
            machine->copy_index += machine->copy_pending;
            machine->copy_phase = 0u;
            if (machine->copy_index == machine->copy_limit) {
                machine->copy_active = 0u;
                *result = 0;
                return 1;
            }
        }

        u64 remaining = machine->copy_limit - machine->copy_index;
        u32 page_bytes = 1u << machine->memory_page_shift;
        u64 at = machine->copy_index;
        u32 count;
        if (machine->copy_sentinel) {
            u64 end = machine->copy_source + remaining;
            u32 tail = (u32)(end & (page_bytes - 1u));
            count = tail ? tail : page_bytes;
            if (count > remaining) count = (u32)remaining;
            at = remaining - count;
        } else {
            u64 address = machine->copy_source + at;
            u32 offset = (u32)(address & (page_bytes - 1u));
            count = (u32)(remaining < page_bytes - offset
                        ? remaining : page_bytes - offset);
        }
        u64 address = machine->copy_source + at;
        StepMemoryGuard guard;
        if (!step_memory_ready(address, count, &guard)) return 0;
        u64 page = address >> machine->memory_page_shift;
        u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
        u32 offset = (u32)(address & (page_bytes - 1u));
        for (u32 byte = 0; byte < count; ++byte)
            machine->copy_buffer[byte] =
                step_memory_bytes(machine, slot)[offset + byte];
        if (!step_memory_unpin(&guard, 0)) return 0;
        machine->copy_pending = count;
        machine->copy_pending_at = 0u;
        machine->copy_phase = 1u;
    }
}

static int step_memory_find2_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin < 4u) return step_fail(9u);
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
            u32 value = step_memory_bytes(machine, slot)[offset + byte];
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

static int step_memory_prefix_end_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin < 5u) return step_fail(9u);
    if (!machine->prefix_active) {
        u64 pointer, count, length, limit, shape;
        if (!step_operand(begin, &pointer)
                || !step_operand(begin + 1u, &count)
                || !step_operand(begin + 2u, &length)
                || !step_operand(begin + 3u, &limit)
                || !step_operand(begin + 4u, &shape))
            return 0;
        if ((shape & ~0x11fffull) || (shape & 255u) != 1u
                || ((shape >> 8) & 31u) || !(shape & 0x10000u)
                || count > limit || limit - count >= (1ull << 20)
                || (u32)length >= 0x80u)
            return step_fail(9u);
        machine->prefix_active = 1u;
        machine->prefix_lane = machine->execution_lane;
        machine->prefix_phase = 0u;
        machine->prefix_length = (u32)length;
        machine->prefix_address = pointer;
        machine->prefix_remaining = limit - count + 1u;
    } else if (machine->prefix_lane != machine->execution_lane) {
        return step_fail(12u);
    }

    for (;;) {
        if (machine->prefix_phase == 0u) {
            u64 advance = (u64)machine->prefix_length + 1u;
            if (machine->prefix_address > ~0ull - advance)
                return step_fail(10u);
            machine->prefix_address += advance;
            machine->prefix_remaining -= 1u;
            if (!machine->prefix_remaining) {
                *result = machine->prefix_address;
                machine->prefix_active = 0u;
                return 1;
            }
            machine->prefix_phase = 1u;
        }
        if (machine->prefix_phase == 1u) {
            StepMemoryGuard guard;
            u64 leading;
            if (!step_memory_ready(
                    machine->prefix_address, 1u, &guard)) return 0;
            if (!step_memory_load(
                    machine->prefix_address, 1u, &guard, &leading)) return 0;
            machine->prefix_length = (u32)leading;
            machine->prefix_phase = (leading & 0x80u) ? 2u : 0u;
        }
        if (machine->prefix_phase == 2u) {
            if (machine->prefix_address == ~0ull) return step_fail(10u);
            StepMemoryGuard guard;
            u64 high;
            if (!step_memory_ready(
                    machine->prefix_address + 1u, 1u, &guard)) return 0;
            if (!step_memory_load(
                    machine->prefix_address + 1u, 1u, &guard, &high)) return 0;
            machine->prefix_length = (machine->prefix_length & 0x7fu)
                                   + ((u32)high << 7u) + 1u;
            machine->prefix_phase = 0u;
        }
    }
}

static int step_memory_copy_until_lane(u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin < 7u) return step_fail(9u);
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
                    step_memory_bytes(machine, slot)[offset + byte]
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
            u32 value = step_memory_bytes(machine, slot)[offset + byte];
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
        u32 projection = step_projection_kind(
            coordinate, machine->relative_completed_node);
        if (projection == STEP_PROJECTION_ALU_RESULT) {
            *result = machine->alu_result[source];
            return 1;
        }
        if (projection == STEP_PROJECTION_FLAGS)
            return step_x86_condition_value(
                machine->values[source], selector, result);
        if (projection == STEP_PROJECTION_REGION) {
            for (u32 slot = 0; slot < machine->region_slots; ++slot) {
                if (machine->region_source[slot] != source) continue;
                if (selector > machine->region_width[slot])
                    return step_fail(6u);
                *result = machine->region_results[slot][selector];
                return 1;
            }
            return step_fail(6u);
        }
        if (projection != STEP_PROJECTION_RELATIVE
                || source != machine->relative_completed_node)
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
        machine->prefix_active = 0;
        machine->copy_active = 0;
        machine->relative_active = 0;
        machine->relative_completed_node = 0;
        machine->region_slots = 0;
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
                : opcode == 197u
                ? step_x86_bit_flags_lane(
                    first, last, &machine->values[node])
                : opcode == 198u
                ? step_insert_lane(
                    first, last, 64u, &machine->values[node])
                : opcode == 199u
                ? step_x86_test_condition_lane(
                    first, last, &machine->values[node])
                : opcode == 200u
                ? step_memory_prefix_end_lane(
                    first, last, &machine->values[node])
                : opcode == 201u
                ? step_insert_lane(
                    first, last, 32u, &machine->values[node])
                : opcode == 202u
                ? step_select_u32_lane(
                    first, last, &machine->values[node])
                : opcode == 203u
                ? step_x86_alu_lane(
                    node, first, last, &machine->values[node])
                : opcode == 204u
                ? step_x86_affine_alu_lane(
                    node, first, last, &machine->values[node])
                : opcode == 205u
                ? step_memory_load_region_lane(
                    node, first, last, &machine->values[node])
                : opcode == 206u
                ? step_memory_copy_lane(
                    first, last, &machine->values[node])
                : opcode == 207u
                ? step_mul_high_lane(
                    first, last, &machine->values[node])
                : opcode == 208u
                ? step_x86_mul_flags_lane(
                    first, last, &machine->values[node])
                : opcode == 209u
                ? step_bit_address_lane(
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

    /* State-page outputs are one SSA publication, not sequential assigns.
     * Resolve every value against the input frame before changing any local
     * or stack coordinate.  memory_transfer is idle at a completed slice and
     * exactly spans the maximum local+stack publication (8192 i64 words). */
    for (u32 index = 0; index < machine->local_updates; ++index) {
        u64 value;
        if (!step_output(STEP_LOCAL_TAGS, STEP_LOCAL_VALUES, index, &value))
            { machine->execution_active = 0; return STEP_TRAP; }
        store_u64(machine->memory_transfer + index * 8u, value);
    }
    for (u32 index = 0; index < machine->stack_count; ++index) {
        u64 value;
        if (!step_output(STEP_STACK_TAGS, STEP_STACK_VALUES, index, &value))
            { machine->execution_active = 0; return STEP_TRAP; }
        store_u64(machine->memory_transfer
                  + (machine->local_updates + index) * 8u, value);
    }
    for (u32 index = 0; index < machine->local_updates; ++index) {
        u32 coordinate = step_u32(STEP_LOCAL_INDICES, index);
        machine->locals[coordinate] = load_u64(
            machine->memory_transfer + index * 8u);
    }
    for (u32 index = 0; index < machine->stack_count; ++index) {
        machine->stack[index] = load_u64(
            machine->memory_transfer
            + (machine->local_updates + index) * 8u);
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

/* ------------------------------------------------ native x86 machine --- */
enum {
    X86_CONTROL_NEXT = 0,
    X86_CONTROL_BRANCH = 1,
    X86_CONTROL_CONDITIONAL = 2,
    X86_CONTROL_DYNAMIC = 3,
    X86_CONTROL_HALT = 4,
    X86_CONTROL_TIMESLICE = 5,
    X86_CONTROL_WRITE_MSR = 6,
    X86_CONTROL_READ_MSR = 7,
    X86_CONTROL_CPUID = 8,
    X86_CONTROL_REGISTER = 9,
    X86_CONTROL_SEGMENT = 10,
    X86_CONTROL_DESCRIPTOR = 11,
    X86_CONTROL_FAR_RETURN = 12,
    X86_CONTROL_DIVIDE = 13,
    X86_CONTROL_INTERRUPT_RETURN = 14,
    X86_CONTROL_INTERNAL = 15,
    X86_CONTROL_READ_SEGMENT = 16,
    X86_CONTROL_PORT_READ = 17,
    X86_CONTROL_PORT_WRITE = 18,
    X86_CONTROL_INVALIDATE_PAGE = 19,
    X86_CONTROL_CLOCK = 20,
    X86_CONTROL_DEBUG_REGISTER = 21,
    X86_CONTROL_EXCEPTION = 22,
    X86_CONTROL_WIDE_DIVIDE = 23,
    X86_CONTROL_RECURRENCE = 24,
    X86_CONTROL_ENTROPY = 25,
    X86_CONTROL_STORE_DESCRIPTOR = 26,
    X86_CONTROL_SYSTEM_SEGMENT = 27,
    X86_CONTROL_SWAP_GS = 28,
    X86_CONTROL_SYSCALL = 29,
    X86_CONTROL_SYSRET = 30,
    X86_CONTROL_SIMD_MOVE = 31,
    X86_CONTROL_SIMD_UNPACK = 32,
    X86_CONTROL_SIMD_STORE = 33,
    X86_CONTROL_SEGMENT_MEMORY = 34,
    X86_CONTROL_SIMD_XOR = 35,
    X86_CONTROL_SIMD_LOAD = 36,
};

enum {
    X86_SYS_CR2 = 0,
    X86_SYS_CR8 = 1,
    X86_SYS_GDTR_BASE = 2,
    X86_SYS_GDTR_LIMIT = 3,
    X86_SYS_IDTR_BASE = 4,
    X86_SYS_IDTR_LIMIT = 5,
    X86_SYS_ES = 6,
    X86_SYS_CS = 7,
    X86_SYS_SS = 8,
    X86_SYS_DS = 9,
    X86_SYS_FS = 10,
    X86_SYS_GS = 11,
    X86_SYS_LDTR = 12,
    X86_SYS_TR = 13,
    X86_SYS_DEBUG = 14,
};

enum {
    X86_RAX = 0,
    X86_RCX = 1,
    X86_RDX = 2,
    X86_RBX = 3,
    X86_RSP = 4,
    X86_R11 = 11,
};

enum {
    X86_NEED_BLOCK = 4,
    X86_YIELDED = 5,
    X86_HALTED = 6,
    X86_NEED_PHYSICAL = 7,
    X86_DIRTY_PHYSICAL = 8,
    X86_INTERNAL = 9,
    X86_CONSOLE_WRITE = 10,
    X86_CLOCK = 11,
    X86_ENTROPY = 12,
    X86_CODE_MISMATCH = 13,
};

static X86Workspace *x86_machine(void)
{
    return &workspace.runtime.x86;
}

static u64 x86_msr_read(u64 key)
{
    X86Workspace *x86 = x86_machine();
    if ((u32)key == 0xc0000080u) return x86->efer;
    for (u32 index = 0; index < x86->msr_count; ++index)
        if ((u32)x86->msr_keys[index] == (u32)key)
            return x86->msr_values[index];
    return 0;
}

static int x86_msr_write(u64 key, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if ((u32)key == 0xc0000080u) x86->efer = value;
    for (u32 index = 0; index < x86->msr_count; ++index) {
        if ((u32)x86->msr_keys[index] == (u32)key) {
            x86->msr_values[index] = value;
            return 1;
        }
    }
    if (x86->msr_count >= X86_MSR_CAP) return 0;
    x86->msr_keys[x86->msr_count] = (u32)key;
    x86->msr_values[x86->msr_count] = value;
    x86->msr_count += 1u;
    return 1;
}

static u64 x86_control_register_read(u32 coordinate)
{
    X86Workspace *x86 = x86_machine();
    if (coordinate == 0u) return x86->cr0;
    if (coordinate == 2u) return x86->system[X86_SYS_CR2];
    if (coordinate == 3u) return x86->cr3;
    if (coordinate == 4u) return x86->cr4;
    if (coordinate == 8u) return x86->system[X86_SYS_CR8];
    return 0;
}

static int x86_invalidate_address_space(void)
{
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    if (step->execution_active || step->memory_status) return 0;
    u64 generation = step_new_capability();
    if (!generation) return 0;
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        u64 word = step_slot_load(step, slot);
        u32 kind = step_slot_kind(word);
        if (step_slot_pins(word)
                || (kind != STEP_SLOT_EMPTY && kind != STEP_SLOT_CLEAN
                    && kind != STEP_SLOT_DIRTY))
            return 0;
        if (kind == STEP_SLOT_DIRTY) {
            if (!x86->step_physical_valid[slot]) return 0;
            u32 physical = x86->step_physical_slot[slot];
            if (physical >= X86_PHYSICAL_PAGES
                    || !x86->physical_valid[physical])
                return 0;
        }
    }
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        u32 kind = step_slot_kind(step_slot_load(step, slot));
        if (kind == STEP_SLOT_DIRTY) {
            u32 physical = x86->step_physical_slot[slot];
            x86->physical_dirty[physical] = 1u;
        }
        x86->step_physical_valid[slot] = 0;
        x86->step_physical_write[slot] = 0;
    }
    step_memory_slots_empty(step);
    step->memory_generation = generation;
    step->requested_memory_page = STEP_NO_COORDINATE;
    step->requested_memory_address = STEP_NO_COORDINATE;
    step->flush_memory_page = STEP_NO_COORDINATE;
    step->memory_lease = 0;
    step->memory_status = 0;
    return 1;
}

static int x86_control_register_write(u32 coordinate, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if (coordinate == 0u) {
        if (x86->cr0 != value && !x86_invalidate_address_space()) return 0;
        x86->cr0 = value;
    }
    else if (coordinate == 2u) x86->system[X86_SYS_CR2] = value;
    else if (coordinate == 3u) {
        /* A CR3 write is a translation invalidation even when the numeric
         * root is unchanged.  The resident virtual tags are not PCID-tagged,
         * so retaining one here could bind another task's user page. */
        if (!x86_invalidate_address_space()) return 0;
        x86->cr3 = value;
    }
    else if (coordinate == 4u) {
        if (x86->cr4 != value && !x86_invalidate_address_space()) return 0;
        x86->cr4 = value;
    }
    else if (coordinate == 8u) x86->system[X86_SYS_CR8] = value;
    else return 0;
    return 1;
}

static u64 x86_port_read(u32 port, u32 width)
{
    X86Workspace *x86 = x86_machine();
    if (width == 1u && (port == 0x20u || port == 0xa0u)) return 0u;
    if (width == 1u && (port == 0x21u || port == 0xa1u))
        return x86->pic_mask[port == 0xa1u];
    if (width == 1u && port == 0x42u) {
        x86->pit_counter = (x86->pit_counter - 0x100u) & 0xffffu;
        u32 value = (x86->pit_counter >> (x86->pit_read_phase * 8u))
                  & 0xffu;
        x86->pit_read_phase ^= 1u;
        return value;
    }
    if (width == 1u && port == 0x3fdu)
        return 0x60u | (x86->console_count != 0u);
    if (width == 1u && port == 0x3fau) {
        if (x86->console_count && (x86->uart[1] & 1u)) return 4u;
        if (x86->uart_tx_pending && (x86->uart[1] & 2u)) {
            x86->uart_tx_pending = 0;
            return 2u;
        }
        return 1u;
    }
    if (width == 1u && port == 0x3feu) return 0xb0u;
    if (width == 1u && port == 0x64u) return 0u;
    if (width == 1u && port == 0x3f8u
            && !(x86->uart[3] & 0x80u)) {
        if (!x86->console_count) return 0u;
        u32 value = x86->console_input[x86->console_head];
        x86->console_head = (x86->console_head + 1u)
                          & (X86_CONSOLE_CAP - 1u);
        x86->console_count -= 1u;
        return value;
    }
    if (width == 1u && port >= 0x3f8u && port <= 0x3ffu) {
        u32 slot = port - 0x3f8u;
        return x86->uart_valid[slot] ? x86->uart[slot] : 0xffu;
    }
    return width == 1u ? 0xffu
         : width == 2u ? 0xffffu : 0xffffffffu;
}

static int x86_publish_console_output(X86Workspace *x86)
{
    if (x86->console_status) return (int)x86->console_status;
    if (!x86->console_output_count) return 0;
    x86->console_lease = step_new_capability();
    if (!x86->console_lease) return 0;
    x86->console_status = X86_CONSOLE_WRITE;
    return X86_CONSOLE_WRITE;
}

static int x86_port_write(u32 port, u32 width, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if (width == 1u && (port == 0x20u || port == 0xa0u))
        return 1;
    if (width == 1u && (port == 0x21u || port == 0xa1u)) {
        x86->pic_mask[port == 0xa1u] = (u8)value;
        return 1;
    }
    if (width == 1u && port == 0x43u) {
        if (((u32)value & 0xc0u) == 0x80u
                && ((u32)value & 0x30u) == 0x30u) {
            x86->pit_write_phase = 0;
            x86->pit_read_phase = 0;
        }
        return 1;
    }
    if (width == 1u && port == 0x42u) {
        if (!x86->pit_write_phase) {
            x86->pit_low_latch = (u32)value & 0xffu;
            x86->pit_write_phase = 1u;
        } else {
            x86->pit_counter = x86->pit_low_latch
                             | (((u32)value & 0xffu) << 8u);
            x86->pit_write_phase = 0;
            x86->pit_read_phase = 0;
        }
        return 1;
    }
    if (width == 1u && (port == 0xe9u
            || (port == 0x3f8u && !(x86->uart[3] & 0x80u)))) {
        if (x86->console_status
                || x86->console_output_count >= X86_CONSOLE_OUTPUT_CAP)
            return 0;
        u32 byte = (u32)value & 0xffu;
        x86->console_output[x86->console_output_count++] = (u8)byte;
        if (!x86_publish_console_output(x86)) {
            x86->console_output_count -= 1u;
            return 0;
        }
        if (port == 0x3f8u) x86->uart_tx_pending = 1u;
        return 1;
    }
    if (width == 1u && port >= 0x3f8u && port <= 0x3ffu) {
        u32 slot = port - 0x3f8u;
        x86->uart[slot] = (u8)value;
        x86->uart_valid[slot] = 1u;
    }
    return 1;
}

static int x86_fail(u32 error)
{
    X86Workspace *x86 = x86_machine();
    x86->error = error;
    x86->block_loaded = 0;
    return STEP_TRAP;
}

static u32 x86_scheduling_interrupt(
        const X86Workspace *x86, u32 timer_ready)
{
    if (!(x86->rflags & (1u << 9u))) return 0;
    if (((x86->console_count && (x86->uart[1] & 1u))
                || (x86->uart_tx_pending && (x86->uart[1] & 2u)))
            && !(x86->pic_mask[0] & (1u << 4u)))
        return 0x34u;
    return timer_ready && !(x86->pic_mask[0] & 1u) ? 0x30u : 0u;
}

static u32 x86_block_cache_slot(u64 rip)
{
    return (u32)(rip ^ (rip >> 12u) ^ (rip >> 24u))
         & (X86_BLOCK_CACHE_SLOTS - 1u);
}

static u32 x86_physical_slot(u64 page)
{
    X86Workspace *x86 = x86_machine();
    for (u32 slot = 0; slot < X86_PHYSICAL_PAGES; ++slot)
        if (x86->physical_valid[slot] && x86->physical_page[slot] == page)
            return slot;
    for (u32 slot = 0; slot < X86_PHYSICAL_PAGES; ++slot)
        if (!x86->physical_valid[slot]) return slot;
    /* A STEP virtual tag may point directly into this cache.  Never evict a
     * slot while that tag is clean, dirty, or being flushed. */
    u32 first = (u32)page & (X86_PHYSICAL_PAGES - 1u);
    u32 selected = X86_PHYSICAL_PAGES;
    u64 oldest = ~0ull;
    StepWorkspace *step = step_machine();
    for (u32 offset = 0; offset < X86_PHYSICAL_PAGES; ++offset) {
        u32 candidate = (first + offset) & (X86_PHYSICAL_PAGES - 1u);
        int bound = 0;
        for (u32 step_slot = 0; step_slot < STEP_MEMORY_PAGES; ++step_slot) {
            if (!x86->step_physical_valid[step_slot]
                    || x86->step_physical_slot[step_slot] != candidate)
                continue;
            u32 kind = step_slot_kind(step_slot_load(step, step_slot));
            if (kind == STEP_SLOT_CLEAN || kind == STEP_SLOT_DIRTY
                    || kind == STEP_SLOT_FLUSHING) {
                bound = 1;
                break;
            }
        }
        if (!bound && (selected == X86_PHYSICAL_PAGES
                || x86->physical_age[candidate] < oldest)) {
            selected = candidate;
            oldest = x86->physical_age[candidate];
        }
    }
    return selected < X86_PHYSICAL_PAGES ? selected : first;
}

static void x86_physical_touch(u32 slot)
{
    X86Workspace *x86 = x86_machine();
    x86->physical_clock += 1u;
    if (!x86->physical_clock) {
        /* Recency is not identity: collapsing it on wrap cannot revive an
         * old lease or change guest-visible state. */
        x86->physical_clock = 1u;
        for (u32 index = 0; index < X86_PHYSICAL_PAGES; ++index)
            x86->physical_age[index] = x86->physical_valid[index] ? 1u : 0u;
    }
    x86->physical_age[slot] = x86->physical_clock;
}

static int x86_start_physical(u64 page)
{
    X86Workspace *x86 = x86_machine();
    if (x86->physical_status) return 0;
    u32 slot = x86_physical_slot(page);
    u64 present = x86->physical_page[slot];
    u64 lease = step_new_capability();
    if (!lease) return x86_fail(20u);
    x86->physical_lease = lease;
    if (x86->physical_valid[slot] && x86->physical_dirty[slot]
            && present != page) {
        for (u32 index = 0; index < X86_PHYSICAL_PAGE_BYTES; ++index)
            x86->physical_transfer[index] = x86->physical[slot][index];
        x86->physical_coordinate = present;
        x86->physical_status = X86_DIRTY_PHYSICAL;
    } else {
        x86->physical_coordinate = page;
        x86->physical_status = X86_NEED_PHYSICAL;
    }
    return 0;
}

static int x86_physical_present(u64 page)
{
    X86Workspace *x86 = x86_machine();
    u32 slot = x86_physical_slot(page);
    if (x86->physical_valid[slot] && x86->physical_page[slot] == page) {
        x86_physical_touch(slot);
        return 1;
    }
    x86_start_physical(page);
    return 0;
}

static int x86_physical_u64(u64 address, u64 *value)
{
    X86Workspace *x86 = x86_machine();
    if (address > x86->memory_bytes
            || x86->memory_bytes - address < 8u)
        return -1;
    u64 page = address >> 12u;
    if (!x86_physical_present(page)) return 0;
    u32 offset = (u32)address & (X86_PHYSICAL_PAGE_BYTES - 1u);
    if (offset > X86_PHYSICAL_PAGE_BYTES - 8u) return -1;
    *value = load_u64(
        x86->physical[x86_physical_slot(page)] + offset);
    return 1;
}

static int x86_translate_page(u64 virtual_page, int write, int execute,
                              int user_access, u64 *physical_page)
{
    X86Workspace *x86 = x86_machine();
    u64 address = virtual_page << 12u;
    u64 upper = address >> 48u;
    if ((upper != 0 && upper != 0xffffu)
            || (!!upper != !!(address & (1ull << 47u))))
        return -1;
    if (!(x86->cr0 & (1ull << 31u))) {
        if (address >= x86->memory_bytes) return -1;
        *physical_page = virtual_page;
        return 1;
    }
    u64 table = x86->cr3 & 0x000ffffffffff000ull;
    u32 writable = 1u;
    u32 user = 1u;
    u32 no_execute = 0u;
    static const u8 shifts[4] = {39u, 30u, 21u, 12u};
    for (u32 level = 0; level < 4u; ++level) {
        u64 slot = (address >> shifts[level]) & 0x1ffu;
        u64 entry = 0;
        int loaded = x86_physical_u64(table + slot * 8u, &entry);
        if (loaded <= 0) return loaded;
        if (!(entry & 1u)) return -1;
        writable &= (entry >> 1u) & 1u;
        user &= (entry >> 2u) & 1u;
        if ((x86->efer & (1ull << 11u)) && (entry >> 63u))
            no_execute = 1u;
        if ((level == 1u || level == 2u) && (entry & (1u << 7u))) {
            u32 shift = shifts[level];
            u64 mask = 0x000fffffffffffffull
                     & ~((1ull << shift) - 1u);
            u64 physical = (entry & mask)
                         | (address & ((1ull << shift) - 1u));
            if (physical >= x86->memory_bytes) return -1;
            if ((user_access && !user) || (execute && no_execute)
                    || (write && !writable
                        && (user_access || (x86->cr0 & (1u << 16u)))))
                return -2;
            *physical_page = physical >> 12u;
            return 1;
        }
        table = entry & 0x000ffffffffff000ull;
    }
    if (table >= x86->memory_bytes) return -1;
    if ((user_access && !user) || (execute && no_execute)
            || (write && !writable
                && (user_access || (x86->cr0 & (1u << 16u)))))
        return -2;
    *physical_page = table >> 12u;
    return 1;
}

static int x86_virtual_read(u64 address, u8 *target, u32 bytes)
{
    X86Workspace *x86 = x86_machine();
    while (bytes) {
        u64 physical_page;
        int translated = x86_translate_page(
            address >> 12u, 0, 0, 0, &physical_page);
        if (translated <= 0) return translated;
        if (!x86_physical_present(physical_page)) return 0;
        u32 offset = (u32)address & (X86_PHYSICAL_PAGE_BYTES - 1u);
        u32 count = X86_PHYSICAL_PAGE_BYTES - offset;
        if (count > bytes) count = bytes;
        u32 slot = x86_physical_slot(physical_page);
        for (u32 index = 0; index < count; ++index)
            target[index] = x86->physical[slot][offset + index];
        target += count;
        address += count;
        bytes -= count;
    }
    return 1;
}

static int x86_virtual_matches(u64 address, const u8 *expected, u32 bytes)
{
    X86Workspace *x86 = x86_machine();
    while (bytes) {
        u64 physical_page;
        int translated = x86_translate_page(
            address >> 12u, 0, 1,
            (x86->system[X86_SYS_CS] & 3u) != 0u, &physical_page);
        if (translated <= 0) return translated < 0 ? -1 : 0;
        if (!x86_physical_present(physical_page)) return 0;
        u32 offset = (u32)address & (X86_PHYSICAL_PAGE_BYTES - 1u);
        u32 count = X86_PHYSICAL_PAGE_BYTES - offset;
        if (count > bytes) count = bytes;
        u32 slot = x86_physical_slot(physical_page);
        for (u32 index = 0; index < count; ++index)
            if (x86->physical[slot][offset + index] != expected[index])
                return -1;
        expected += count;
        address += count;
        bytes -= count;
    }
    return 1;
}

static int x86_virtual_write_u64(u64 address, u64 value, int user_access)
{
    X86Workspace *x86 = x86_machine();
    u8 bytes[8];
    store_u64(bytes, value);
    u32 written = 0;
    while (written < 8u) {
        u64 at = address + written;
        u64 physical_page;
        int translated = x86_translate_page(
            at >> 12u, 1, 0, user_access, &physical_page);
        if (translated <= 0) return translated;
        if (!x86_physical_present(physical_page)) return 0;
        u32 offset = (u32)at & (X86_PHYSICAL_PAGE_BYTES - 1u);
        u32 count = X86_PHYSICAL_PAGE_BYTES - offset;
        if (count > 8u - written) count = 8u - written;
        u32 slot = x86_physical_slot(physical_page);
        for (u32 index = 0; index < count; ++index)
            x86->physical[slot][offset + index] = bytes[written + index];
        x86->physical_dirty[slot] = 1u;
        x86_physical_touch(slot);
        written += count;
    }
    return 1;
}

static void x86_cancel_step_execution(void)
{
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    /* A fault discards the transient SSA publication, but memory lanes that
     * completed before the fault already own canonical physical pages. */
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        u32 kind = step_slot_kind(step_slot_load(step, slot));
        if (kind == STEP_SLOT_DIRTY && x86->step_physical_valid[slot]) {
            u32 physical = x86->step_physical_slot[slot];
            if (physical < X86_PHYSICAL_PAGES
                    && x86->physical_valid[physical])
                x86->physical_dirty[physical] = 1u;
        }
        x86->step_physical_valid[slot] = 0;
        x86->step_physical_write[slot] = 0;
    }
    step_memory_slots_empty(step);
    step->memory_generation = step_new_capability();
    step->requested_memory_page = STEP_NO_COORDINATE;
    step->requested_memory_address = STEP_NO_COORDINATE;
    step->flush_memory_page = STEP_NO_COORDINATE;
    step->memory_lease = 0;
    step->memory_status = 0;
    step->execution_active = 0;
    step->repeat_active = 0;
    step->find_active = 0;
    step->prefix_active = 0;
    step->copy_active = 0;
    step->relative_active = 0;
    step->region_slots = 0;
    x86->block_loaded = 0;
}

static int x86_tss_stack(u32 selector, u32 ist, u64 *pointer)
{
    X86Workspace *x86 = x86_machine();
    u64 descriptor_offset = x86->system[X86_SYS_TR] & ~7ull;
    u64 gdt_base = x86->system[X86_SYS_GDTR_BASE];
    u64 gdt_limit = x86->system[X86_SYS_GDTR_LIMIT];
    if (!gdt_base || descriptor_offset + 15u > gdt_limit) return -1;
    u8 descriptor[16];
    int loaded = x86_virtual_read(
        gdt_base + descriptor_offset, descriptor, sizeof(descriptor));
    if (loaded <= 0) return loaded;
    u32 type = descriptor[5] & 0x0fu;
    if (!(descriptor[5] & 0x80u) || (type != 9u && type != 11u))
        return -1;
    u64 base = (u64)read_u16(descriptor + 2u)
             | ((u64)descriptor[4] << 16u)
             | ((u64)descriptor[7] << 24u)
             | ((u64)read_u32(descriptor + 8u) << 32u);
    u64 offset = ist ? 36u + ((u64)ist - 1u) * 8u
                     : 4u + ((u64)selector & 3u) * 8u;
    u8 encoded[8];
    loaded = x86_virtual_read(base + offset, encoded, sizeof(encoded));
    if (loaded <= 0) return loaded;
    *pointer = load_u64(encoded);
    return *pointer ? 1 : -1;
}

static int x86_step_fault_is_write(void)
{
    StepWorkspace *step = step_machine();
    if (step->execution_lane >= step->work) return 0;
    u32 node = step_u32(STEP_LANE_VALUES, step->execution_lane);
    u32 opcode = step_u8(STEP_OPCODES, node - 1u);
    if (opcode >= 152u && opcode <= 158u) return 1;
    if (opcode == 184u || opcode == 192u) return 1;
    if (opcode == 186u || opcode == 206u) return step->copy_phase == 1u;
    /* A relative exchange is one indivisible read/write transaction. */
    if (opcode == 188u) return 1;
    return 0;
}

static int x86_deliver_exception(void)
{
    X86Workspace *x86 = x86_machine();
    if (!x86->exception_pending) return X86_NEED_BLOCK;
    u64 base = x86->system[X86_SYS_IDTR_BASE];
    u64 limit = x86->system[X86_SYS_IDTR_LIMIT];
    u64 offset = (u64)x86->exception_vector * 16u;
    if (!base || offset + 15u > limit) return x86_fail(31u);
    u8 gate[16];
    int loaded = x86_virtual_read(base + offset, gate, sizeof(gate));
    if (!loaded) return (int)x86->physical_status;
    if (loaded < 0 || !(gate[5] & 0x80u) || (gate[4] & 7u))
        return x86_fail(31u);
    u64 target = (u64)read_u16(gate)
               | ((u64)read_u16(gate + 6u) << 16u)
               | ((u64)read_u32(gate + 8u) << 32u);
    u64 selector = read_u16(gate + 2u);
    u32 current_privilege = (u32)x86->system[X86_SYS_CS] & 3u;
    u32 target_privilege = (u32)selector & 3u;
    if (target_privilege > current_privilege) return x86_fail(31u);

    u64 restored_stack = x86->registers[X86_RSP];
    u32 ist = gate[4] & 7u;
    u64 pointer = restored_stack;
    if (target_privilege < current_privilege || ist) {
        int loaded_stack = x86_tss_stack((u32)selector, ist, &pointer);
        if (!loaded_stack) return (int)x86->physical_status;
        if (loaded_stack < 0) return x86_fail(31u);
    }
    const u64 values[6] = {
        x86->system[X86_SYS_SS], restored_stack, x86->rflags,
        x86->system[X86_SYS_CS], x86->rip, x86->exception_error,
    };
    u32 count = 5u + x86->exception_has_error;
    for (u32 index = 0; index < count; ++index) {
        pointer -= 8u;
        int written = x86_virtual_write_u64(
            pointer, values[index], target_privilege != 0u);
        if (!written) return (int)x86->physical_status;
        if (written < 0) return x86_fail(31u);
    }
    x86->registers[X86_RSP] = pointer;
    x86->rip = target;
    x86->system[X86_SYS_CS] = selector;
    if (target_privilege < current_privilege)
        x86->system[X86_SYS_SS] = (selector + 8u) & 0xffffu;
    if ((gate[5] & 0x0fu) == 0x0eu) x86->rflags &= ~(1u << 9u);
    x86->rflags |= 2u;
    x86->halted = 0;
    x86->exception_pending = 0;
    x86->exception_vector = 0;
    x86->exception_has_error = 0;
    x86->exception_error = 0;
    x86->quantum_blocks = 0;
    x86->quantum_cache_hits = 0;
    return X86_NEED_BLOCK;
}

static int x86_begin_exception(u32 vector, u64 rip,
                               u32 has_error, u32 error)
{
    X86Workspace *x86 = x86_machine();
    if (vector > 0xffu || has_error > 1u) return x86_fail(31u);
    x86->rip = rip;
    x86->exception_vector = vector;
    x86->exception_has_error = has_error;
    x86->exception_error = error;
    x86->exception_pending = 1u;
    x86->block_loaded = 0;
    return x86_deliver_exception();
}

static int x86_raise_page_fault(u64 address, int write, int execute,
                                int present)
{
    X86Workspace *x86 = x86_machine();
    x86_cancel_step_execution();
    if (!step_machine()->memory_generation) return x86_fail(20u);
    x86->system[X86_SYS_CR2] = address;
    x86->exception_error = present ? 1u : 0u;
    if (write) x86->exception_error |= 2u;
    if (x86->system[X86_SYS_CS] & 3u) x86->exception_error |= 4u;
    if (execute) x86->exception_error |= 16u;
    return x86_begin_exception(
        14u, x86->rip, 1u, x86->exception_error);
}

/* A missing artifact record is meaningful only after instruction fetch has
 * proved that RIP is mapped.  In particular, user entry commonly lands on a
 * guard page first; publishing that coordinate as a build-time grammar miss
 * would bypass the guest's ordinary #PF handler and make coverage closure
 * depend on runtime page-table state. */
static int x86_classify_block_miss(void)
{
    X86Workspace *x86 = x86_machine();
    u64 physical_page;
    int translated = x86_translate_page(
        x86->rip >> 12u, 0, 1,
        (x86->system[X86_SYS_CS] & 3u) != 0u, &physical_page);
    if (translated < 0)
        return x86_raise_page_fault(x86->rip, 0, 1, translated == -2);
    if (!translated) return (int)x86->physical_status;
    return X86_NEED_BLOCK;
}

static int x86_unsigned_divide_wide(u64 high, u64 low, u64 divisor,
                                    u64 *quotient, u64 *remainder)
{
    if (!divisor || high >= divisor) return 0;
    u64 result = 0;
    u64 residual = high;
    for (int bit = 63; bit >= 0; --bit) {
        u64 carry = residual >> 63u;
        u64 shifted = (residual << 1u) | ((low >> (u32)bit) & 1u);
        if (carry || shifted >= divisor) {
            shifted -= divisor;
            result |= 1ull << (u32)bit;
        }
        residual = shifted;
    }
    *quotient = result;
    *remainder = residual;
    return 1;
}

static int x86_divide_wide(u64 high, u64 low, u64 divisor, u32 signed_divide,
                           u64 *quotient, u64 *remainder)
{
    if (!signed_divide)
        return x86_unsigned_divide_wide(
            high, low, divisor, quotient, remainder);
    u32 dividend_negative = (u32)(high >> 63u);
    u32 divisor_negative = (u32)(divisor >> 63u);
    u64 magnitude_high = high;
    u64 magnitude_low = low;
    if (dividend_negative) {
        magnitude_low = ~low + 1u;
        magnitude_high = ~high + (magnitude_low == 0);
    }
    u64 magnitude_divisor = divisor_negative ? 0u - divisor : divisor;
    u64 magnitude_quotient = 0;
    u64 magnitude_remainder = 0;
    if (!x86_unsigned_divide_wide(
            magnitude_high, magnitude_low, magnitude_divisor,
            &magnitude_quotient, &magnitude_remainder))
        return 0;
    u32 negative = dividend_negative ^ divisor_negative;
    if ((!negative && magnitude_quotient > 0x7fffffffffffffffull)
            || (negative && magnitude_quotient > 0x8000000000000000ull))
        return 0;
    *quotient = negative ? 0u - magnitude_quotient : magnitude_quotient;
    *remainder = dividend_negative
               ? 0u - magnitude_remainder : magnitude_remainder;
    return 1;
}

static int x86_service_step_memory(u64 session, int status)
{
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    u64 lease = step->memory_lease;
    u64 virtual_page = status == STEP_DIRTY_PAGE
                     ? step->flush_memory_page : step->requested_memory_page;
    u32 step_slot = (u32)virtual_page & (STEP_MEMORY_PAGES - 1u);
    u64 physical_page = 0;
    u32 slot = 0;
    if (status == STEP_DIRTY_PAGE) {
        if (!x86->step_physical_valid[step_slot])
            return x86_fail(21u);
        slot = x86->step_physical_slot[step_slot];
        if (slot >= X86_PHYSICAL_PAGES || !x86->physical_valid[slot])
            return x86_fail(21u);
        physical_page = x86->physical_page[slot];
    } else {
        int write = x86_step_fault_is_write();
        int translated = x86_translate_page(
            virtual_page, write, 0,
            (x86->system[X86_SYS_CS] & 3u) != 0u, &physical_page);
        if (translated < 0) return x86_raise_page_fault(
            step->requested_memory_address, write, 0, translated == -2);
        if (!translated) return (int)x86->physical_status;
        if (!x86_physical_present(physical_page))
            return (int)x86->physical_status;
        slot = x86_physical_slot(physical_page);
    }
    if (status == STEP_MEMORY_PAGE) {
        x86->step_physical_slot[step_slot] = slot;
        x86->step_physical_valid[step_slot] = 1u;
        x86->step_physical_write[step_slot] = x86_step_fault_is_write();
        if (!vm_step_supply_memory_coordinate(
                session, lease, virtual_page, X86_PHYSICAL_PAGE_BYTES))
            return x86_fail(22u);
    } else {
        x86->physical_dirty[slot] = 1u;
        if (!vm_step_ack_memory_coordinate(
                session, lease, virtual_page))
            return x86_fail(23u);
    }
    return STEP_OK;
}

static int x86_invalidate_virtual(u64 address)
{
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    u64 page = address >> 12u;
    u32 slot = (u32)page & (STEP_MEMORY_PAGES - 1u);
    u64 word = step_slot_load(step, slot);
    u32 kind = step_slot_kind(word);
    if (step->memory_page[slot] != page || kind == STEP_SLOT_EMPTY)
        return 1;
    if (kind != STEP_SLOT_CLEAN || step_slot_pins(word))
        return 0;
    x86->step_physical_valid[slot] = 0;
    step->memory_page[slot] = STEP_NO_COORDINATE;
    step->memory_valid[slot] = 0;
    step_slot_store(step, slot, step_slot_word(
        STEP_SLOT_EMPTY, 0, step_slot_epoch(word)));
    return 1;
}

EXPORT int vm_x86_open(u64 session, u64 rip, u64 rflags,
                       u64 cr0, u64 cr3, u64 cr4, u64 efer,
                       u64 memory_bytes)
{
    if (!step_session_is(session) || !memory_bytes
            || step_machine()->execution_active
            || step_machine()->memory_status)
        return 0;
    X86Workspace *x86 = x86_machine();
    for (u32 index = 0; index < X86_REGISTER_COUNT; ++index)
        x86->registers[index] = 0;
    x86->rip = rip;
    x86->rflags = rflags | 2u;
    x86->cr0 = cr0;
    x86->cr3 = cr3;
    x86->cr4 = cr4;
    x86->efer = efer;
    for (u32 index = 0; index < X86_SYSTEM_COUNT; ++index)
        x86->system[index] = 0;
    for (u32 index = 0; index < X86_MSR_CAP; ++index) {
        x86->msr_keys[index] = 0;
        x86->msr_values[index] = 0;
    }
    x86->msr_count = 0;
    x86->memory_bytes = memory_bytes;
    x86->retired = 0;
    x86->work = 0;
    x86->span = 0;
    x86->control = X86_CONTROL_NEXT;
    x86->block_loaded = 0;
    for (u32 slot = 0; slot < X86_BLOCK_CACHE_SLOTS; ++slot) {
        x86->block_cache_rip[slot] = 0;
        x86->block_cache_bytes[slot] = 0;
        x86->block_cache_valid[slot] = 0;
    }
    x86->exception_pending = 0;
    x86->exception_vector = 0;
    x86->exception_has_error = 0;
    x86->exception_error = 0;
    x86->console_lease = 0;
    x86->console_status = 0;
    x86->console_output_count = 0;
    x86->clock_lease = 0;
    x86->clock_status = 0;
    x86->entropy_lease = 0;
    x86->entropy_status = 0;
    x86->console_head = 0;
    x86->console_count = 0;
    for (u32 index = 0; index < 8u; ++index) {
        x86->uart[index] = 0;
        x86->uart_valid[index] = 0;
    }
    x86->pit_counter = 0xffffu;
    x86->pit_low_latch = 0;
    x86->pit_read_phase = 0;
    x86->pit_write_phase = 0;
    x86->pic_mask[0] = 0xffu;
    x86->pic_mask[1] = 0xffu;
    x86->timer_source_instructions = 0;
    x86->uart_tx_pending = 0;
    x86->active = 1;
    x86->halted = 0;
    x86->error = 0;
    x86->physical_lease = 0;
    x86->physical_coordinate = X86_NO_PAGE;
    x86->physical_status = 0;
    x86->physical_clock = 0;
    for (u32 slot = 0; slot < X86_PHYSICAL_PAGES; ++slot) {
        x86->physical_page[slot] = X86_NO_PAGE;
        x86->physical_valid[slot] = 0;
        x86->physical_dirty[slot] = 0;
        x86->physical_age[slot] = 0;
    }
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        x86->step_physical_slot[slot] = 0;
        x86->step_physical_valid[slot] = 0;
        x86->step_physical_write[slot] = 0;
    }
    return vm_step_memory_open_virtual(session, 12u);
}

EXPORT u64 vm_x86_physical_lease(u64 session)
{
    return step_session_is(session) && x86_machine()->physical_status
         ? x86_machine()->physical_lease : 0;
}

EXPORT u64 vm_x86_first_dirty_physical_page(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || x86->physical_status
            || step_machine()->execution_active)
        return X86_NO_PAGE;
    /* A completed STEP may still own dirty virtual slots.  Their bytes live
     * directly in the x86 physical cache, but ownership is not published to
     * physical_dirty until the STEP flush is acknowledged.  Drain that first
     * so a persistent cut has one canonical backing-store root. */
    while (vm_step_first_dirty_memory_coordinate(session)
            != STEP_NO_COORDINATE) {
        int serviced = x86_service_step_memory(session, STEP_DIRTY_PAGE);
        if (serviced != STEP_OK) return X86_NO_PAGE;
    }
    for (u32 slot = 0; slot < X86_PHYSICAL_PAGES; ++slot) {
        if (!x86->physical_valid[slot] || !x86->physical_dirty[slot])
            continue;
        u64 lease = step_new_capability();
        if (!lease) {
            x86_fail(20u);
            return X86_NO_PAGE;
        }
        for (u32 index = 0; index < X86_PHYSICAL_PAGE_BYTES; ++index)
            x86->physical_transfer[index] = x86->physical[slot][index];
        x86->physical_lease = lease;
        x86->physical_coordinate = x86->physical_page[slot];
        x86->physical_status = X86_DIRTY_PHYSICAL;
        return x86->physical_coordinate;
    }
    return X86_NO_PAGE;
}

EXPORT u64 vm_x86_physical_coordinate(u64 session, u64 lease)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && lease
        && x86->physical_status && x86->physical_lease == lease
         ? x86->physical_coordinate : X86_NO_PAGE;
}

EXPORT u8 *vm_x86_physical_buffer(u64 session, u64 lease)
{
    return vm_x86_physical_coordinate(session, lease) == X86_NO_PAGE
         ? (u8 *)0 : x86_machine()->physical_transfer;
}

EXPORT int vm_x86_supply_physical(u64 session, u64 lease,
                                  u64 page, u32 bytes)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || x86->physical_status != X86_NEED_PHYSICAL
            || x86->physical_lease != lease
            || x86->physical_coordinate != page
            || bytes != X86_PHYSICAL_PAGE_BYTES
            || page >= (x86->memory_bytes + X86_PHYSICAL_PAGE_BYTES - 1u)
                       / X86_PHYSICAL_PAGE_BYTES)
        return 0;
    u32 slot = x86_physical_slot(page);
    for (u32 index = 0; index < X86_PHYSICAL_PAGE_BYTES; ++index)
        x86->physical[slot][index] = x86->physical_transfer[index];
    x86->physical_page[slot] = page;
    x86->physical_valid[slot] = 1u;
    x86->physical_dirty[slot] = 0;
    x86_physical_touch(slot);
    x86->physical_lease = 0;
    x86->physical_coordinate = X86_NO_PAGE;
    x86->physical_status = 0;
    return 1;
}

EXPORT int vm_x86_ack_physical(u64 session, u64 lease, u64 page)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || x86->physical_status != X86_DIRTY_PHYSICAL
            || x86->physical_lease != lease
            || x86->physical_coordinate != page)
        return 0;
    u32 slot = x86_physical_slot(page);
    if (!x86->physical_valid[slot]
            || x86->physical_page[slot] != page
            || !x86->physical_dirty[slot])
        return 0;
    x86->physical_dirty[slot] = 0;
    x86_physical_touch(slot);
    x86->physical_lease = 0;
    x86->physical_coordinate = X86_NO_PAGE;
    x86->physical_status = 0;
    return 1;
}

EXPORT u64 vm_x86_console_lease(u64 session)
{
    return step_session_is(session) && x86_machine()->console_status
         ? x86_machine()->console_lease : 0;
}

EXPORT u32 vm_x86_console_value(u64 session, u64 lease)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session)
        && x86->console_status == X86_CONSOLE_WRITE
        && lease && x86->console_lease == lease
         ? x86->console_output[0] : 0;
}

EXPORT u32 vm_x86_console_output_count(u64 session, u64 lease)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session)
        && x86->console_status == X86_CONSOLE_WRITE
        && lease && x86->console_lease == lease
         ? x86->console_output_count : 0;
}

EXPORT u32 vm_x86_console_output_peek(
        u64 session, u64 lease, u32 index)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session)
        && x86->console_status == X86_CONSOLE_WRITE
        && lease && x86->console_lease == lease
        && index < x86->console_output_count
         ? x86->console_output[index] : 0;
}

EXPORT int vm_x86_ack_console(u64 session, u64 lease)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || x86->console_status != X86_CONSOLE_WRITE
            || !lease || x86->console_lease != lease)
        return 0;
    x86->console_lease = 0;
    x86->console_status = 0;
    x86->console_output_count = 0;
    return 1;
}

EXPORT int vm_x86_restore_console_output(u64 session, u32 value)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->console_status
            || value > 0xffu
            || x86->console_output_count >= X86_CONSOLE_OUTPUT_CAP)
        return 0;
    x86->console_output[x86->console_output_count++] = (u8)value;
    if ((x86->uart[1] & 2u) && !(x86->uart[3] & 0x80u))
        x86->uart_tx_pending = 1u;
    return 1;
}

EXPORT u32 vm_x86_pending_console_output_count(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->active
         ? x86->console_output_count : 0;
}

EXPORT u32 vm_x86_pending_console_output_peek(u64 session, u32 index)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->active
        && index < x86->console_output_count
         ? x86->console_output[index] : 0;
}

EXPORT int vm_x86_console_feed(u64 session, u32 value)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active
            || value > 0xffu || x86->console_count >= X86_CONSOLE_CAP)
        return 0;
    u32 tail = (x86->console_head + x86->console_count)
             & (X86_CONSOLE_CAP - 1u);
    x86->console_input[tail] = (u8)value;
    x86->console_count += 1u;
    x86->halted = 0;
    return 1;
}

/* Canonical device coordinates used by the build-time machine as well.  A
 * restart needs device state, not cache contents: the latter may be dropped
 * and reconstructed without changing the next port observation. */
EXPORT int vm_x86_io_valid(u64 session, u32 coordinate)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active) return 0;
    if (coordinate >= 0x3f8u && coordinate <= 0x3ffu)
        return x86->uart_valid[coordinate - 0x3f8u] != 0u;
    if (coordinate == 0x21u || coordinate == 0xa1u) return 1;
    return coordinate >= 0x10042u && coordinate <= 0x10047u;
}

EXPORT u64 vm_x86_io_value(u64 session, u32 coordinate)
{
    X86Workspace *x86 = x86_machine();
    if (!vm_x86_io_valid(session, coordinate)) return 0;
    if (coordinate >= 0x3f8u && coordinate <= 0x3ffu)
        return x86->uart[coordinate - 0x3f8u];
    if (coordinate == 0x21u || coordinate == 0xa1u)
        return x86->pic_mask[coordinate == 0xa1u];
    if (coordinate == 0x10042u) return x86->pit_counter;
    if (coordinate == 0x10043u) return x86->pit_read_phase;
    if (coordinate == 0x10044u) return x86->pit_write_phase;
    if (coordinate == 0x10045u) return x86->pit_low_latch;
    if (coordinate == 0x10046u) return x86->timer_source_instructions;
    return x86->uart_tx_pending;
}

EXPORT int vm_x86_restore_io(u64 session, u32 coordinate, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || value > 0xffffffffu)
        return 0;
    if (coordinate >= 0x3f8u && coordinate <= 0x3ffu) {
        u32 slot = coordinate - 0x3f8u;
        if (value > 0xffu) return 0;
        x86->uart[slot] = (u8)value;
        x86->uart_valid[slot] = 1u;
        return 1;
    }
    if (coordinate == 0x21u || coordinate == 0xa1u) {
        if (value > 0xffu) return 0;
        x86->pic_mask[coordinate == 0xa1u] = (u8)value;
        return 1;
    }
    if (coordinate == 0x10042u) x86->pit_counter = (u32)value & 0xffffu;
    else if (coordinate == 0x10043u) x86->pit_read_phase = (u32)value & 1u;
    else if (coordinate == 0x10044u) x86->pit_write_phase = (u32)value & 1u;
    else if (coordinate == 0x10045u)
        x86->pit_low_latch = (u32)value & 0xffu;
    else if (coordinate == 0x10046u)
        x86->timer_source_instructions = (u32)value & 0xfffu;
    else if (coordinate == 0x10047u)
        x86->uart_tx_pending = (u32)value & 1u;
    else return 0;
    return 1;
}

EXPORT u32 vm_x86_console_count(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->console_count : 0;
}

EXPORT u32 vm_x86_console_peek(u64 session, u32 index)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || index >= x86->console_count)
        return 0;
    return x86->console_input[(x86->console_head + index)
                            & (X86_CONSOLE_CAP - 1u)];
}

EXPORT u64 vm_x86_clock_lease(u64 session)
{
    return step_session_is(session) && x86_machine()->clock_status
         ? x86_machine()->clock_lease : 0;
}

EXPORT int vm_x86_supply_clock(u64 session, u64 lease, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || x86->clock_status != X86_CLOCK
            || !lease || x86->clock_lease != lease)
        return 0;
    if (!x86_msr_write(0x10u, value)) return 0;
    x86->registers[X86_RAX] = (u32)value;
    x86->registers[X86_RDX] = (u32)(value >> 32u);
    x86->rip = x86->control_argument[0];
    x86->clock_lease = 0;
    x86->clock_status = 0;
    return 1;
}

EXPORT u64 vm_x86_entropy_lease(u64 session)
{
    return step_session_is(session) && x86_machine()->entropy_status
         ? x86_machine()->entropy_lease : 0;
}

EXPORT int vm_x86_supply_entropy(u64 session, u64 lease, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || x86->entropy_status != X86_ENTROPY
            || !lease || x86->entropy_lease != lease)
        return 0;
    u32 descriptor = (u32)x86->control_argument[1];
    u32 reg = descriptor & 0xffu;
    u32 bits = (descriptor >> 8u) & 0xffu;
    u32 source = (descriptor >> 16u) & 1u;
    if (reg >= X86_REGISTER_COUNT || (bits != 32u && bits != 64u)
            || descriptor != (reg | (bits << 8u) | (source << 16u)))
        return 0;
    x86->registers[reg] = bits == 32u ? (u32)value : value;
    x86->rflags = (x86->rflags & ~0x8d5ull) | 3u;
    x86->rip = x86->control_argument[0];
    x86->entropy_lease = 0;
    x86->entropy_status = 0;
    return 1;
}

EXPORT u64 *vm_x86_registers(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->registers : (u64 *)0;
}

EXPORT u64 *vm_x86_xmm(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->xmm : (u64 *)0;
}

EXPORT u64 *vm_x86_system(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->system : (u64 *)0;
}

EXPORT u64 *vm_x86_msr_keys(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->msr_keys : (u64 *)0;
}

EXPORT u64 *vm_x86_msr_values(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->msr_values : (u64 *)0;
}

EXPORT int vm_x86_msr_count(u64 session, u32 count)
{
    if (!step_session_is(session) || !x86_machine()->active
            || count > X86_MSR_CAP) return 0;
    x86_machine()->msr_count = count;
    return 1;
}

EXPORT u64 vm_x86_rip(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->rip : 0;
}

EXPORT u64 vm_x86_rflags(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->rflags : 0;
}

EXPORT u64 vm_x86_cr0(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->cr0 : 0;
}

EXPORT u64 vm_x86_cr3(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->cr3 : 0;
}

EXPORT u64 vm_x86_cr4(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->cr4 : 0;
}

EXPORT u64 vm_x86_efer(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->efer : 0;
}

EXPORT u32 vm_x86_msr_extent(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->msr_count : 0;
}

EXPORT u64 vm_x86_retired(u64 session)
{
    return step_session_is(session) ? x86_machine()->retired : 0;
}

EXPORT u64 vm_x86_work(u64 session)
{
    return step_session_is(session) ? x86_machine()->work : 0;
}

EXPORT u64 vm_x86_span(u64 session)
{
    return step_session_is(session) ? x86_machine()->span : 0;
}

EXPORT u32 vm_x86_error(u64 session)
{
    return step_session_is(session) ? x86_machine()->error : 1u;
}

EXPORT int vm_x86_halted(u64 session)
{
    return step_session_is(session) && x86_machine()->halted;
}

static int x86_apply_step_parameters(u8 *page, u32 bytes,
                                     const u8 *template, u32 template_bytes,
                                     const u8 *parameters,
                                     u32 parameter_bytes)
{
    static const u8 widths[STEP_COLUMN_COUNT] = {
        4, 4, 1, 4, 1, 8, 1, 8, 4, 1, 8,
    };
    if (bytes < STEP_HEADER_BYTES || template_bytes < 52u
            || template[0] != 'S' || template[1] != 'T'
            || template[2] != 'Q' || template[3] != 'T'
            || read_u16(template + 4u) != 1u
            || read_u16(template + 6u) != 52u)
        return 0;
    u32 span = read_u32(template + 24u);
    u32 work = read_u32(template + 28u);
    u32 operands = read_u32(template + 32u);
    u32 stack_count = read_u32(template + 40u);
    u32 local_updates = read_u32(template + 48u);
    u32 expected[STEP_COLUMN_COUNT] = {
        span + 1u, work, work, work + 1u, operands, operands,
        stack_count, stack_count, local_updates, local_updates,
        local_updates,
    };
    u32 offset[STEP_COLUMN_COUNT];
    u32 count[STEP_COLUMN_COUNT];
    u32 end = STEP_HEADER_BYTES;
    for (u32 column = 0; column < STEP_COLUMN_COUNT; ++column) {
        end = align8(end);
        offset[column] = end;
        count[column] = expected[column];
        if (count[column] > (bytes - end) / widths[column])
            return 0;
        end += count[column] * widths[column];
    }
    if (end != bytes) return 0;

    for (u32 index = 0; index < bytes; ++index) page[index] = 0;
    page[0] = 'S'; page[1] = 'T'; page[2] = 'E'; page[3] = 'P';
    page[4] = 3u; page[5] = 0u;
    page[6] = (u8)STEP_HEADER_BYTES;
    page[7] = (u8)(STEP_HEADER_BYTES >> 8u);
    for (u32 index = 8u; index < 52u; ++index)
        page[index] = template[index];
    for (u32 column = 0; column < STEP_COLUMN_COUNT; ++column) {
        u32 directory = 52u + column * 8u;
        store_u32(page + directory, offset[column]);
        store_u32(page + directory + 4u, count[column]);
    }

    u32 template_cursor = 52u;
    static const u8 fixed_columns[4] = {
        STEP_WAVE_OFFSETS, STEP_LANE_VALUES,
        STEP_OPCODES, STEP_ARGUMENT_OFFSETS,
    };
    for (u32 fixed = 0; fixed < 4u; ++fixed) {
        u32 column = fixed_columns[fixed];
        u32 extent = count[column] * widths[column];
        if (template_cursor > template_bytes
                || extent > template_bytes - template_cursor)
            return 0;
        for (u32 index = 0; index < extent; ++index)
            page[offset[column] + index] = template[template_cursor + index];
        template_cursor += extent;
    }

    u32 parameter_cursor = 0;
    static const u8 tag_columns[3] = {
        STEP_OPERAND_TAGS, STEP_STACK_TAGS, STEP_LOCAL_TAGS,
    };
    static const u8 value_columns[3] = {
        STEP_OPERAND_VALUES, STEP_STACK_VALUES, STEP_LOCAL_VALUES,
    };
    for (u32 pair = 0; pair < 3u; ++pair) {
        u32 tags = tag_columns[pair];
        u32 values = value_columns[pair];
        if (template_cursor > template_bytes
                || count[tags] > template_bytes - template_cursor)
            return 0;
        for (u32 index = 0; index < count[tags]; ++index)
            page[offset[tags] + index] = template[template_cursor + index];
        template_cursor += count[tags];
        for (u32 index = 0; index < count[tags]; ++index) {
            u32 tag = page[offset[tags] + index];
            if (tag > 4u) return 0;
            u32 width = tag == 0u ? 8u : tag == 1u || tag == 2u ? 2u : 0u;
            u8 *target = page + offset[values] + index * 8u;
            u64 value;
            if (width) {
                if (parameter_cursor > parameter_bytes
                        || width > parameter_bytes - parameter_cursor)
                    return 0;
                value = width == 8u
                      ? load_u64(parameters + parameter_cursor)
                      : read_u16(parameters + parameter_cursor);
                parameter_cursor += width;
            } else {
                if (template_cursor > template_bytes
                        || 8u > template_bytes - template_cursor)
                    return 0;
                value = load_u64(template + template_cursor);
                template_cursor += 8u;
            }
            store_u64(target, value);
        }
    }
    for (u32 index = 0; index < count[STEP_LOCAL_INDICES]; ++index) {
        u8 *target = page + offset[STEP_LOCAL_INDICES] + index * 4u;
        if (parameter_cursor > parameter_bytes
                || 2u > parameter_bytes - parameter_cursor)
            return 0;
        store_u32(target, read_u16(parameters + parameter_cursor));
        parameter_cursor += 2u;
    }
    return (template_cursor == template_bytes
            && parameter_cursor == parameter_bytes);
}

/* The caller places one record in vm_step_buffer(). Version two carries exact
 * executable bytes and a STEP. Version three carries the same proof followed
 * by a typed parameter projection and a shared SSA template. */
EXPORT int vm_x86_load_block(u64 session, u32 bytes)
{
    if (!step_session_is(session)) return STEP_TRAP;
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    const u8 *record = step->page;
    if (!x86->active || x86->halted || x86->error || x86->block_loaded
            || step->execution_active || step->memory_status
            || bytes > STEP_PAGE_BYTES
            || bytes < X86_BLOCK_HEADER_BYTES
            || record[0] != 'X' || record[1] != '8'
            || record[2] != '6' || record[3] != 'B'
            || (read_u16(record + 4u) != 1u
                && read_u16(record + 4u) != 2u
                && read_u16(record + 4u) != 3u)
            || read_u16(record + 6u) != X86_BLOCK_HEADER_BYTES
            || load_u64(record + 8u) != x86->rip)
        return x86_fail(1u);
    u32 version = read_u16(record + 4u);
    u64 boundary_rip = load_u64(record + 16u);
    u32 step_bytes = read_u32(record + 24u);
    u32 control = read_u32(record + 28u);
    u32 parameter_bytes = version == 3u ? read_u32(record + 56u) : 0u;
    u32 template_bytes = version == 3u ? read_u32(record + 60u)
                                         : step_bytes;
    if (!step_bytes || !template_bytes
            || template_bytes > bytes - X86_BLOCK_HEADER_BYTES
            || parameter_bytes > bytes - X86_BLOCK_HEADER_BYTES
                                  - template_bytes
            || control > X86_CONTROL_SIMD_LOAD)
        return x86_fail(2u);
    u32 guard_bytes = bytes - X86_BLOCK_HEADER_BYTES
                    - parameter_bytes - template_bytes;
    u32 cache_slot = x86_block_cache_slot(x86->rip);
    if ((version == 1u && (guard_bytes || parameter_bytes))
            || (version == 2u && guard_bytes < 2u))
        return x86_fail(2u);
    if (version == 2u || (version == 3u && guard_bytes)) {
        const u8 *guard = record + X86_BLOCK_HEADER_BYTES;
        u32 count = read_u16(guard);
        u32 cursor = 2u;
        if (!count) return x86_fail(2u);
        for (u32 index = 0; index < count; ++index) {
            if (cursor > guard_bytes || guard_bytes - cursor < 10u)
                return x86_fail(2u);
            u64 address = load_u64(guard + cursor);
            u32 length = read_u16(guard + cursor + 8u);
            cursor += 10u;
            if (!length || cursor > guard_bytes
                    || guard_bytes - cursor < length)
                return x86_fail(2u);
            int matches = x86_virtual_matches(
                address, guard + cursor, length);
            if (!matches) return (int)x86->physical_status;
            if (matches < 0) {
                x86->block_cache_valid[cache_slot] = 0;
                return X86_CODE_MISMATCH;
            }
            cursor += length;
        }
        if (cursor != guard_bytes) return x86_fail(2u);
    }
    x86->control = control;
    x86->control_argument[0] = load_u64(record + 32u);
    x86->control_argument[1] = load_u64(record + 40u);
    x86->control_argument[2] = load_u64(record + 48u);
    u32 resident_bytes = X86_BLOCK_HEADER_BYTES + guard_bytes + step_bytes;
    u32 cacheable = resident_bytes <= X86_BLOCK_CACHE_BYTES;
    if (cacheable) {
        x86->block_cache_valid[cache_slot] = 0;
        for (u32 index = 0; index < X86_BLOCK_HEADER_BYTES + guard_bytes;
             ++index)
            x86->block_cache[cache_slot][index] = record[index];
        if (version == 3u) {
            x86->block_cache[cache_slot][4] = guard_bytes ? 2u : 1u;
            x86->block_cache[cache_slot][5] = 0u;
            for (u32 index = 56u; index < X86_BLOCK_HEADER_BYTES; ++index)
                x86->block_cache[cache_slot][index] = 0u;
        }
    }
    /* NEXT and TIMESLICE use the boundary coordinate without duplicating it
     * in the control argument columns. */
    if (control == X86_CONTROL_NEXT || control == X86_CONTROL_TIMESLICE)
        x86->control_argument[0] = boundary_rip;
    u32 step_offset = X86_BLOCK_HEADER_BYTES + guard_bytes + parameter_bytes;
    if (version == 3u) {
        u32 projection_bytes = parameter_bytes + template_bytes;
        u32 projection_source = X86_BLOCK_HEADER_BYTES + guard_bytes;
        u32 projection_target = STEP_PAGE_BYTES - projection_bytes;
        if (step_bytes > projection_target) return x86_fail(3u);
        for (u32 index = projection_bytes; index; --index)
            step->page[projection_target + index - 1u] =
                step->page[projection_source + index - 1u];
        if (!x86_apply_step_parameters(
                step->page, step_bytes,
                step->page + projection_target + parameter_bytes,
                template_bytes, step->page + projection_target,
                parameter_bytes))
            return x86_fail(3u);
    } else {
        for (u32 index = 0; index < step_bytes; ++index)
            step->page[index] = step->page[step_offset + index];
    }
    if (cacheable)
        for (u32 index = 0; index < step_bytes; ++index)
            x86->block_cache[cache_slot][
                X86_BLOCK_HEADER_BYTES + guard_bytes + index] =
                step->page[index];
    if (!vm_step_open(session, step_bytes)
            || step->local_extent < X86_REGISTER_COUNT + 1u)
        return x86_fail(3u);
    for (u32 index = 0; index < step->local_extent; ++index)
        step->locals[index] = 0;
    for (u32 index = 0; index < X86_REGISTER_COUNT; ++index)
        step->locals[index] = x86->registers[index];
    step->locals[X86_REGISTER_COUNT] = x86->rflags;
    if (control == X86_CONTROL_READ_SEGMENT
            && (x86->control_argument[2] & (1u << 16u))) {
        u32 segment = (u32)x86->control_argument[1];
        u32 descriptor = (u32)x86->control_argument[2];
        u32 local = descriptor & 0xffu;
        if (segment >= 6u || local < X86_REGISTER_COUNT + 1u
                || local >= step->local_extent
                || descriptor != (local | (16u << 8u) | (1u << 16u)))
            return x86_fail(3u);
        step->locals[local] = x86->system[X86_SYS_ES + segment] & 0xffffu;
    }
    if (control == X86_CONTROL_STORE_DESCRIPTOR) {
        u32 name = (u32)x86->control_argument[1];
        u32 descriptor = (u32)x86->control_argument[2];
        u32 limit_local = descriptor & 0xffu;
        u32 base_local = (descriptor >> 8u) & 0xffu;
        u32 system = name ? X86_SYS_IDTR_BASE : X86_SYS_GDTR_BASE;
        if (name > 1u || limit_local < X86_REGISTER_COUNT + 1u
                || base_local != limit_local + 1u
                || base_local >= step->local_extent
                || descriptor != (limit_local | (base_local << 8u)))
            return x86_fail(3u);
        step->locals[limit_local] = x86->system[system + 1u] & 0xffffu;
        step->locals[base_local] = x86->system[system];
    }
    if (control == X86_CONTROL_SIMD_STORE) {
        u32 vector = (u32)x86->control_argument[1];
        u32 descriptor = (u32)x86->control_argument[2];
        u32 low = descriptor & 0xffu;
        u32 high = (descriptor >> 8u) & 0xffu;
        if (vector >= 16u || low < X86_REGISTER_COUNT + 1u
                || high != low + 1u || high >= step->local_extent
                || descriptor != (low | (high << 8u)))
            return x86_fail(44u);
        step->locals[low] = x86->xmm[vector * 2u];
        step->locals[high] = x86->xmm[vector * 2u + 1u];
    }
    if (control == X86_CONTROL_SEGMENT_MEMORY) {
        u32 segment = (u32)x86->control_argument[1];
        u32 local = (u32)x86->control_argument[2];
        if (segment > 1u || local < X86_REGISTER_COUNT + 1u
                || local >= step->local_extent)
            return x86_fail(47u);
        step->locals[local] = x86_msr_read(0xc0000100u + segment);
    }
    if (cacheable) {
        x86->block_cache_rip[cache_slot] = x86->rip;
        x86->block_cache_bytes[cache_slot] = resident_bytes;
        x86->block_cache_valid[cache_slot] = 1u;
    }
    x86->block_loaded = 1;
    return STEP_OK;
}

/* Exact-tagged direct cache: the RIP byte chooses a slot, while the full RIP
 * proves identity. A collision is only a miss and never aliases code. */
EXPORT int vm_x86_load_cached_block(u64 session)
{
    if (!step_session_is(session)) return STEP_TRAP;
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    if (!x86->active || x86->halted || x86->error || x86->block_loaded)
        return STEP_TRAP;
    u32 slot = x86_block_cache_slot(x86->rip);
    if (!x86->block_cache_valid[slot]
            || x86->block_cache_rip[slot] != x86->rip)
        return 0;
    u32 bytes = x86->block_cache_bytes[slot];
    if (bytes < X86_BLOCK_HEADER_BYTES || bytes > X86_BLOCK_CACHE_BYTES)
        return x86_fail(36u);
    for (u32 index = 0; index < bytes; ++index)
        step->page[index] = x86->block_cache[slot][index];
    int loaded = vm_x86_load_block(session, bytes);
    if (loaded == X86_CODE_MISMATCH)
        x86->block_cache_valid[slot] = 0;
    return loaded;
}

EXPORT int vm_x86_execute(u64 session)
{
    if (!step_session_is(session)) return STEP_TRAP;
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    if (!x86->active || x86->error) return x86_fail(4u);
    if (x86->halted) return X86_HALTED;
    /* A restored snapshot may already own bytes written before its cut.
     * Publish them before executing another guest block. */
    if (!x86->console_status && x86->console_output_count
            && !x86_publish_console_output(x86))
        return x86_fail(44u);
    if (x86->console_status) return (int)x86->console_status;
    if (x86->clock_status) return (int)x86->clock_status;
    if (x86->entropy_status) return (int)x86->entropy_status;
    if (x86->exception_pending) return x86_deliver_exception();
    if (!x86->block_loaded) return X86_NEED_BLOCK;
    int status;
    for (;;) {
        status = vm_step_execute(
            session, step->local_extent, step->stack_inputs);
        if (status != STEP_MEMORY_PAGE && status != STEP_DIRTY_PAGE)
            break;
        int serviced = x86_service_step_memory(session, status);
        if (serviced != STEP_OK) return serviced;
    }
    if (status != STEP_OK) return x86_fail(5u);
    if (step->stack_count) return x86_fail(6u);
    for (u32 index = 0; index < X86_REGISTER_COUNT; ++index)
        x86->registers[index] = step->locals[index];
    x86->rflags = step->locals[X86_REGISTER_COUNT] | 2u;
    x86->retired += step->instructions;
    x86->work += step->work;
    x86->span += step->span;

    u64 next = x86->control_argument[0];
    if (x86->control == X86_CONTROL_BRANCH) {
        next = x86->control_argument[0];
    } else if (x86->control == X86_CONTROL_CONDITIONAL) {
        u64 selected = 0;
        if (!step_x86_condition_value(
                x86->rflags, x86->control_argument[2], &selected))
            return x86_fail(7u);
        next = selected ? x86->control_argument[1]
                        : x86->control_argument[0];
    } else if (x86->control == X86_CONTROL_DYNAMIC) {
        u64 local = x86->control_argument[0];
        if (local >= step->local_extent) return x86_fail(8u);
        next = step->locals[(u32)local];
    } else if (x86->control == X86_CONTROL_WRITE_MSR) {
        u64 key = (u32)x86->registers[X86_RCX];
        u64 value = ((u64)(u32)x86->registers[X86_RDX] << 32u)
                  | (u32)x86->registers[X86_RAX];
        if (!x86_msr_write(key, value)) return x86_fail(24u);
    } else if (x86->control == X86_CONTROL_READ_MSR) {
        u64 value = x86_msr_read((u32)x86->registers[X86_RCX]);
        x86->registers[X86_RAX] = (u32)value;
        x86->registers[X86_RDX] = (u32)(value >> 32u);
    } else if (x86->control == X86_CONTROL_CPUID) {
        u32 leaf = (u32)x86->registers[X86_RAX];
        u32 subleaf = (u32)x86->registers[X86_RCX];
        u32 eax = 0, ebx = 0, ecx = 0, edx = 0;
        if (leaf == 0u) {
            eax = 7u; ebx = 0x756e6547u;
            ecx = 0x6c65746eu; edx = 0x49656e69u;
        } else if (leaf == 1u) {
            eax = 0x000306a9u; ecx = 1u << 30u;
            edx = 0x07008131u | (1u << 3u);
        } else if (leaf == 7u && subleaf == 0u) {
            ebx = 1u << 18u;
        } else if (leaf == 0x80000000u) {
            eax = 0x80000008u;
        } else if (leaf == 0x80000001u) {
            ecx = 1u;
            edx = (1u << 11u) | (1u << 20u) | (1u << 29u);
        } else if (leaf == 0x80000008u) {
            eax = (48u << 8u) | 40u;
        }
        x86->registers[X86_RAX] = eax;
        x86->registers[X86_RBX] = ebx;
        x86->registers[X86_RCX] = ecx;
        x86->registers[X86_RDX] = edx;
    } else if (x86->control == X86_CONTROL_REGISTER) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 opcode = descriptor & 0xffu;
        u32 coordinate = (descriptor >> 8u) & 0xffu;
        u32 reg = (descriptor >> 16u) & 0xffu;
        if (reg >= X86_REGISTER_COUNT) return x86_fail(25u);
        if (opcode == 0x20u) {
            x86->registers[reg] = x86_control_register_read(coordinate);
        } else if (opcode == 0x22u) {
            if (!x86_control_register_write(
                    coordinate, x86->registers[reg]))
                return x86_fail(25u);
        } else {
            return x86_fail(25u);
        }
    } else if (x86->control == X86_CONTROL_DEBUG_REGISTER) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 opcode = descriptor & 0xffu;
        u32 debug = (descriptor >> 8u) & 0xffu;
        u32 reg = (descriptor >> 16u) & 0xffu;
        if (debug >= 8u || reg >= X86_REGISTER_COUNT
                || descriptor != (opcode | (debug << 8u) | (reg << 16u)))
            return x86_fail(37u);
        if (opcode == 0x21u)
            x86->registers[reg] = x86->system[X86_SYS_DEBUG + debug];
        else if (opcode == 0x23u)
            x86->system[X86_SYS_DEBUG + debug] = x86->registers[reg];
        else
            return x86_fail(37u);
    } else if (x86->control == X86_CONTROL_SEGMENT) {
        u32 segment = (u32)x86->control_argument[1];
        u32 reg = (u32)x86->control_argument[2];
        if (segment >= 6u || reg >= X86_REGISTER_COUNT)
            return x86_fail(26u);
        x86->system[X86_SYS_ES + segment] = x86->registers[reg] & 0xffffu;
    } else if (x86->control == X86_CONTROL_DESCRIPTOR) {
        u32 base = x86->control_argument[1]
                 ? X86_SYS_IDTR_BASE : X86_SYS_GDTR_BASE;
        if (step->local_extent < X86_REGISTER_COUNT + 3u)
            return x86_fail(27u);
        x86->system[base] = step->locals[X86_REGISTER_COUNT + 2u];
        x86->system[base + 1u] =
            step->locals[X86_REGISTER_COUNT + 1u] & 0xffffu;
    } else if (x86->control == X86_CONTROL_FAR_RETURN) {
        u32 target = (u32)x86->control_argument[0];
        u32 selector = (u32)x86->control_argument[1];
        if (target >= step->local_extent || selector >= step->local_extent)
            return x86_fail(28u);
        next = step->locals[target];
        x86->system[X86_SYS_CS] = step->locals[selector] & 0xffffu;
    } else if (x86->control == X86_CONTROL_DIVIDE) {
        u32 error = (u32)x86->control_argument[1];
        if (error >= step->local_extent) return x86_fail(29u);
        if (step->locals[error]) return x86_begin_exception(
            0u, x86->control_argument[2], 0u, 0u);
    } else if (x86->control == X86_CONTROL_INTERRUPT_RETURN) {
        u32 target = (u32)x86->control_argument[0];
        u32 selector = (u32)x86->control_argument[1];
        u32 restored_ss = (u32)x86->control_argument[2];
        if (target >= step->local_extent || selector >= step->local_extent
                || restored_ss >= step->local_extent)
            return x86_fail(30u);
        next = step->locals[target];
        x86->system[X86_SYS_CS] = step->locals[selector] & 0xffffu;
        x86->system[X86_SYS_SS] = step->locals[restored_ss] & 0xffffu;
    } else if (x86->control == X86_CONTROL_INTERNAL) {
        next = x86->control_argument[0];
    } else if (x86->control == X86_CONTROL_READ_SEGMENT) {
        u32 segment = (u32)x86->control_argument[1];
        u32 descriptor = (u32)x86->control_argument[2];
        u32 reg = descriptor & 0xffu;
        u32 bits = (descriptor >> 8u) & 0xffu;
        u32 memory = (descriptor >> 16u) & 1u;
        if (segment >= 6u
                || (memory && (bits != 16u
                    || reg < X86_REGISTER_COUNT + 1u
                    || reg >= step->local_extent
                    || descriptor != (reg | (16u << 8u) | (1u << 16u))))
                || (!memory && (reg >= X86_REGISTER_COUNT
                    || (bits != 16u && bits != 32u && bits != 64u)
                    || descriptor != (reg | (bits << 8u)))))
            return x86_fail(31u);
        u64 value = x86->system[X86_SYS_ES + segment] & 0xffffu;
        if (memory) {
            /* The value was admitted before STEP execution; its store and any
             * page fault have already crossed the canonical memory barrier. */
        } else if (bits == 16u)
            x86->registers[reg] =
                (x86->registers[reg] & ~0xffffull) | value;
        else
            x86->registers[reg] = value;
    } else if (x86->control == X86_CONTROL_PORT_READ
            || x86->control == X86_CONTROL_PORT_WRITE) {
        u32 descriptor = (u32)x86->control_argument[2];
        u32 width = descriptor & 0xffu;
        u32 dynamic = (descriptor >> 8u) & 1u;
        u64 encoded_port = x86->control_argument[1];
        u32 port = dynamic ? (u32)x86->registers[X86_RDX] & 0xffffu
                           : (u32)encoded_port;
        if ((width != 1u && width != 2u && width != 4u)
                || descriptor != (width | (dynamic << 8u))
                || (!dynamic && encoded_port > 0xffffu))
            return x86_fail(32u);
        if (x86->control == X86_CONTROL_PORT_READ) {
            u64 value = x86_port_read(port, width);
            u64 mask = step_mask(width * 8u);
            x86->registers[X86_RAX] = width == 4u ? value & mask
                : (x86->registers[X86_RAX] & ~mask) | (value & mask);
        } else {
            u64 value = x86->registers[X86_RAX]
                      & step_mask(width * 8u);
            if (!x86_port_write(port, width, value))
                return x86_fail(33u);
        }
    } else if (x86->control == X86_CONTROL_INVALIDATE_PAGE) {
        u64 local = x86->control_argument[1];
        if (local >= step->local_extent
                || !x86_invalidate_virtual(step->locals[(u32)local]))
            return x86_fail(34u);
    } else if (x86->control == X86_CONTROL_CLOCK) {
        x86->clock_lease = step_new_capability();
        if (!x86->clock_lease) return x86_fail(35u);
        x86->clock_status = X86_CLOCK;
    } else if (x86->control == X86_CONTROL_EXCEPTION) {
        u64 encoded_error = x86->control_argument[2];
        if (x86->control_argument[1] > 0xffu
                || (encoded_error != ~0ull && encoded_error > 0xffffffffu))
            return x86_fail(38u);
        return x86_begin_exception(
            (u32)x86->control_argument[1], next,
            encoded_error != ~0ull, (u32)encoded_error);
    } else if (x86->control == X86_CONTROL_WIDE_DIVIDE) {
        u32 descriptor = (u32)x86->control_argument[2];
        u32 reg = descriptor & 0xffu;
        u32 signed_divide = (descriptor >> 8u) & 1u;
        u64 quotient = 0;
        u64 remainder = 0;
        if (reg >= X86_REGISTER_COUNT
                || descriptor != (reg | (signed_divide << 8u)))
            return x86_fail(39u);
        if (!x86_divide_wide(
                x86->registers[X86_RDX], x86->registers[X86_RAX],
                x86->registers[reg], signed_divide,
                &quotient, &remainder))
            return x86_begin_exception(
                0u, x86->control_argument[1], 0u, 0u);
        x86->registers[X86_RAX] = quotient;
        x86->registers[X86_RDX] = remainder;
    } else if (x86->control == X86_CONTROL_RECURRENCE) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 local = descriptor & 0xffu;
        u32 bits = (descriptor >> 8u) & 0xffu;
        u64 source_instructions = x86->control_argument[2];
        if (local < X86_REGISTER_COUNT + 1u || local >= step->local_extent
                || (bits != 32u && bits != 64u)
                || descriptor != (local | (bits << 8u))
                || !source_instructions)
            return x86_fail(40u);
        u64 iterations = step->locals[local];
        if (bits == 32u) iterations = (u32)iterations;
        x86->retired -= step->instructions;
        x86->retired += iterations * source_instructions;
    } else if (x86->control == X86_CONTROL_ENTROPY) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 reg = descriptor & 0xffu;
        u32 bits = (descriptor >> 8u) & 0xffu;
        u32 source = (descriptor >> 16u) & 1u;
        if (reg >= X86_REGISTER_COUNT || (bits != 32u && bits != 64u)
                || descriptor != (reg | (bits << 8u) | (source << 16u)))
            return x86_fail(41u);
        x86->entropy_lease = step_new_capability();
        if (!x86->entropy_lease) return x86_fail(41u);
        x86->entropy_status = X86_ENTROPY;
    } else if (x86->control == X86_CONTROL_STORE_DESCRIPTOR) {
        /* The descriptor value was injected before STEP execution; the two
         * stores and any page fault therefore use the common memory path. */
    } else if (x86->control == X86_CONTROL_SYSTEM_SEGMENT) {
        u32 name = (u32)x86->control_argument[1];
        u32 descriptor = (u32)x86->control_argument[2];
        u32 source = descriptor & 0xffu;
        u32 memory = (descriptor >> 8u) & 1u;
        if (name > 1u || source >= step->local_extent
                || (memory && source < X86_REGISTER_COUNT + 1u)
                || (!memory && source >= X86_REGISTER_COUNT)
                || descriptor != (source | (memory << 8u)))
            return x86_fail(42u);
        x86->system[X86_SYS_LDTR + name] = step->locals[source] & 0xffffu;
    } else if (x86->control == X86_CONTROL_SWAP_GS) {
        u64 current = x86_msr_read(0xc0000101u);
        u64 kernel = x86_msr_read(0xc0000102u);
        if (!x86_msr_write(0xc0000101u, kernel)
                || !x86_msr_write(0xc0000102u, current))
            return x86_fail(43u);
    } else if (x86->control == X86_CONTROL_SYSCALL) {
        if (!(x86->efer & 1u))
            return x86_begin_exception(6u, x86->rip, 0u, 0u);
        u64 star = x86_msr_read(0xc0000081u);
        x86->registers[X86_RCX] = next;
        x86->registers[X86_R11] = x86->rflags;
        x86->rflags &= ~x86_msr_read(0xc0000084u);
        x86->rflags |= 2u;
        u64 selector = (star >> 32u) & 0xfffcu;
        x86->system[X86_SYS_CS] = selector;
        x86->system[X86_SYS_SS] = (selector + 8u) & 0xffffu;
        next = x86_msr_read(0xc0000082u);
    } else if (x86->control == X86_CONTROL_SYSRET) {
        u64 star = x86_msr_read(0xc0000081u);
        u64 selector = (star >> 48u) & 0xffffu;
        next = x86->registers[X86_RCX];
        x86->rflags = x86->registers[X86_R11] | 2u;
        x86->system[X86_SYS_CS] = (selector + 16u) | 3u;
        x86->system[X86_SYS_SS] = (selector + 8u) | 3u;
    } else if (x86->control == X86_CONTROL_SIMD_MOVE) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 vector = descriptor & 0xffu;
        u32 source = (descriptor >> 8u) & 0xffu;
        if (vector >= 16u || source >= X86_REGISTER_COUNT
                || descriptor != (vector | (source << 8u)))
            return x86_fail(45u);
        x86->xmm[vector * 2u] = x86->registers[source];
        x86->xmm[vector * 2u + 1u] = 0;
    } else if (x86->control == X86_CONTROL_SIMD_UNPACK) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 vector = descriptor & 0xffu;
        u32 source = (descriptor >> 8u) & 0xffu;
        if (vector >= 16u || source >= 16u
                || descriptor != (vector | (source << 8u)))
            return x86_fail(46u);
        x86->xmm[vector * 2u + 1u] = x86->xmm[source * 2u];
    } else if (x86->control == X86_CONTROL_SIMD_STORE) {
        /* Both disjoint 64-bit stores ran through the ordinary memory STEP. */
    } else if (x86->control == X86_CONTROL_SEGMENT_MEMORY) {
        /* The admitted FS/GS base participated in the ordinary memory STEP. */
    } else if (x86->control == X86_CONTROL_SIMD_XOR) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 vector = descriptor & 0xffu;
        u32 source = (descriptor >> 8u) & 0xffu;
        if (vector >= 16u || source >= 16u
                || descriptor != (vector | (source << 8u)))
            return x86_fail(48u);
        x86->xmm[vector * 2u] ^= x86->xmm[source * 2u];
        x86->xmm[vector * 2u + 1u] ^= x86->xmm[source * 2u + 1u];
    } else if (x86->control == X86_CONTROL_SIMD_LOAD) {
        u32 vector = (u32)x86->control_argument[1];
        u32 descriptor = (u32)x86->control_argument[2];
        u32 low = descriptor & 0xffu;
        u32 high = (descriptor >> 8u) & 0xffu;
        if (vector >= 16u || low < X86_REGISTER_COUNT + 1u
                || high != low + 1u || high >= step->local_extent
                || descriptor != (low | (high << 8u)))
            return x86_fail(49u);
        x86->xmm[vector * 2u] = step->locals[low];
        x86->xmm[vector * 2u + 1u] = step->locals[high];
    } else if (x86->control == X86_CONTROL_HALT) {
        x86->halted = 1;
    }
    if (!x86->clock_status && !x86->entropy_status) x86->rip = next;
    u32 control = x86->control;
    x86->block_loaded = 0;
    /* The build-time machine treats the legacy timer as the deterministic
     * event at a scheduling cut.  Keep the native path identical: PIC state
     * is guest-owned, and an unmasked IRQ0 enters the installed 0x30 gate
     * before another basic block is requested. */
    if ((control == X86_CONTROL_TIMESLICE || control == X86_CONTROL_HALT)
            && (x86->rflags & (1u << 9u))) {
        u32 vector = x86_scheduling_interrupt(x86, 1u);
        if (vector) {
            x86->halted = 0;
            return x86_begin_exception(vector, next, 0u, 0u);
        }
    }
    return x86->console_status ? (int)x86->console_status
         : x86->clock_status ? (int)x86->clock_status
         : x86->entropy_status ? (int)x86->entropy_status
         : control == X86_CONTROL_HALT ? X86_HALTED
         : control == X86_CONTROL_TIMESLICE ? X86_YIELDED
         : control == X86_CONTROL_INTERNAL ? X86_INTERNAL
                                           : X86_NEED_BLOCK;
}

/* Keep the quotient closed across cached basic-block boundaries.  Host code
 * regains control only for an absent record, a physical/device barrier, or a
 * requested scheduling cut; the common cache-hit path never crosses the
 * WebAssembly boundary. */
EXPORT int vm_x86_execute_quantum(u64 session, u32 max_blocks)
{
    if (!step_session_is(session) || !max_blocks) return STEP_TRAP;
    X86Workspace *x86 = x86_machine();
    x86->quantum_blocks = 0;
    x86->quantum_cache_hits = 0;
    while (x86->quantum_blocks < max_blocks) {
        if (!x86->console_status && x86->console_output_count
                && !x86_publish_console_output(x86))
            return x86_fail(44u);
        if (x86->console_status) return (int)x86->console_status;
        if (!x86->block_loaded && !x86->exception_pending) {
            int loaded = vm_x86_load_cached_block(session);
            if (loaded == STEP_OK) {
                x86->quantum_cache_hits += 1u;
            } else if (loaded == 0) {
                return x86_classify_block_miss();
            } else {
                return loaded;
            }
        }
        u32 had_block = x86->block_loaded;
        u64 retired_before = x86->retired;
        int status = vm_x86_execute(session);
        if (had_block && !x86->block_loaded && status != X86_INTERNAL) {
            x86->quantum_blocks += 1u;
            /* Work while IRQ0 cannot be accepted belongs to the current
             * barrier interval. Counting the handler itself toward the next
             * period would publish another IRQ immediately after iret and
             * starve the interrupted pure path. */
            if ((x86->rflags & (1u << 9u))
                    && !(x86->pic_mask[0] & 1u)) {
                u64 source = x86->retired - retired_before;
                if (source > 4096u) source = 4096u;
                source += x86->timer_source_instructions;
                x86->timer_source_instructions = source >= 4096u
                                                ? 4096u : (u32)source;
            }
        }
        /* A timer cut belongs to the persistent machine, not to a particular
         * decoded block.  Otherwise quotienting a polling loop into one
         * recurrence can accidentally remove the only point at which IRQ0
         * becomes observable. */
        u32 vector = x86_scheduling_interrupt(
            x86, x86->timer_source_instructions >= 4096u);
        if (vector
                && !x86->block_loaded && !x86->exception_pending
                && !x86->console_status && !x86->clock_status
                && !x86->entropy_status) {
            u32 blocks = x86->quantum_blocks;
            u32 hits = x86->quantum_cache_hits;
            if (vector == 0x30u) x86->timer_source_instructions = 0;
            status = x86_begin_exception(vector, x86->rip, 0u, 0u);
            /* Exception entry resets its local execution window.  Preserve
             * the publication counters that belong to this host quantum. */
            x86->quantum_blocks = blocks;
            x86->quantum_cache_hits = hits;
        }
        if (status != X86_NEED_BLOCK && status != X86_INTERNAL)
            return status;
    }
    return X86_YIELDED;
}

EXPORT u32 vm_x86_quantum_blocks(u64 session)
{
    return step_session_is(session) ? x86_machine()->quantum_blocks : 0;
}

EXPORT u32 vm_x86_quantum_cache_hits(u64 session)
{
    return step_session_is(session) ? x86_machine()->quantum_cache_hits : 0;
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
