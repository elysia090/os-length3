#include <postlink/executable.h>
#include <postlink/cpu.h>
#include <postlink/entrymap.h>
#include <postlink/opcodes.h>
#include <postlink/residual.h>

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
typedef signed int         i32;
typedef __UINTPTR_TYPE__    uptr;
typedef long long          i64;

void pl_vm_math_sincos(double value, double *sine, double *cosine);
double pl_vm_math_tan(double value);
double pl_vm_math_exp2m1(double value);
double pl_vm_math_log2_positive(double value);
double pl_vm_math_atan_positive(double value);

/* Some freestanding Clang releases form an i128 multiply while optimizing
 * the 64-bit arithmetic below.  There is no compiler-rt in this module, so
 * provide the standard modulo-2^128 operation using native wasm i64
 * multiplies. */
typedef __int128 i128;
typedef unsigned __int128 u128;
typedef union {
    u128 value;
    struct { u64 low, high; } words;
} U128Words;

__attribute__((noinline, optnone))
static u64 multiply_high_u64(u64 left, u64 right)
{
    u64 left_low = (u32)left;
    u64 left_high = left >> 32u;
    u64 right_low = (u32)right;
    u64 right_high = right >> 32u;
    u64 low = left_low * right_low;
    u64 middle = left_high * right_low + (low >> 32u);
    u64 carry = middle >> 32u;
    middle = (u32)middle + left_low * right_high;
    return left_high * right_high + carry + (middle >> 32u);
}

__attribute__((noinline, optnone))
i128 __multi3(i128 left, i128 right)
{
    U128Words first = { .value = (u128)left };
    U128Words second = { .value = (u128)right };
    U128Words product;
    product.words.low = first.words.low * second.words.low;
    product.words.high = multiply_high_u64(
        first.words.low, second.words.low)
        + first.words.high * second.words.low
        + first.words.low * second.words.high;
    return (i128)product.value;
}

__attribute__((noinline, optnone))
u128 __lshrti3(u128 value, int shift)
{
    U128Words source = { .value = value };
    U128Words result = { .value = 0u };
    if (shift <= 0) return value;
    if (shift >= 128) return 0u;
    if (shift >= 64) {
        result.words.low = source.words.high >> (u32)(shift - 64);
    } else {
        result.words.low = (source.words.low >> (u32)shift)
                         | (source.words.high << (u32)(64 - shift));
        result.words.high = source.words.high >> (u32)shift;
    }
    return result.value;
}

__attribute__((noinline, optnone))
i128 __ashlti3(i128 value, int shift)
{
    U128Words source = { .value = (u128)value };
    U128Words result = { .value = 0u };
    if (shift <= 0) return value;
    if (shift >= 128) return 0;
    if (shift >= 64) {
        result.words.high = source.words.low << (u32)(shift - 64);
    } else {
        result.words.high = (source.words.high << (u32)shift)
                          | (source.words.low >> (u32)(64 - shift));
        result.words.low = source.words.low << (u32)shift;
    }
    return (i128)result.value;
}

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
#define X86_BLOCK_CLASS_HEADER_BYTES 68u
#define X86_PHYSICAL_PAGE_BYTES 4096u
#define X86_PHYSICAL_PAGES 2048u
#define X86_PHYSICAL_DIRECT_PAGES (1u << 15u)
#define X86_PHYSICAL_LOOKUP_SLOTS 4096u
#define X86_BLOCK_CACHE_SETS 8192u
#define X86_BLOCK_CACHE_WAYS 4u
#define X86_BLOCK_CACHE_SLOTS (X86_BLOCK_CACHE_SETS * X86_BLOCK_CACHE_WAYS)
#define X86_BLOCK_CACHE_SMALL_SLOTS 16384u
#define X86_BLOCK_CACHE_SMALL_BYTES 512u
#define X86_BLOCK_CACHE_MEDIUM_SLOTS 4096u
#define X86_BLOCK_CACHE_MEDIUM_BYTES 1024u
#define X86_BLOCK_CACHE_LARGE_SLOTS 512u
#define X86_BLOCK_CACHE_LARGE_BYTES 4096u
#define X86_BLOCK_CACHE_SMALL 0u
#define X86_BLOCK_CACHE_MEDIUM 1u
#define X86_BLOCK_CACHE_LARGE 2u
#define X86_BLOCK_CACHE_CLASSES 3u
#define X86_NO_PAGE (~0ull)
#define X86_SYSTEM_COUNT 22u
#define X86_MSR_CAP 32u
#define X86_CONSOLE_CAP 4096u
#define X86_CONSOLE_OUTPUT_CAP 256u
#define X86_DIRECT_REGION_CAP 32u
#define X86_DIRECT_REGION_RESULT_CAP 9u
#define X86_DIRECT_MEMORY_CAP 64u
#define X86_EXECUTABLE_REQUEST_NONE 0u
#define X86_EXECUTABLE_REQUEST_INDEX 1u
#define X86_EXECUTABLE_REQUEST_MODULE 2u
#define X86_EXECUTABLE_REQUEST_INSTALL 3u
#define X86_EXECUTABLE_REQUEST_READY 4u
#define X86_EXECUTABLE_REQUEST_RESOURCE 5u
#define X86_EXECUTABLE_REQUEST_PAGE_READY 6u
#define X86_EXECUTABLE_REQUEST_CODE_READY 7u
#define X86_EXECUTABLE_REQUEST_MAP_READY 8u
#define X86_EXECUTABLE_REQUEST_RESIDUAL_READY 9u
#define X86_EXECUTABLE_REQUEST_KERNEL_READY 10u
#define X86_EXECUTABLE_REQUEST_INSTANTIATION_READY 11u
#define X86_EXECUTABLE_INDEX_BINDING 1u
#define X86_EXECUTABLE_INDEX_MODULE 2u
#define X86_EXECUTABLE_INDEX_RESOURCE_BASE 3u
#define X86_EXECUTABLE_INDEX_RESOURCE_PAGE 4u
#define X86_EXECUTABLE_INDEX_CODE_BINDING 5u
#define X86_EXECUTABLE_INDEX_CODE_MODULE 6u
#define X86_EXECUTABLE_INDEX_ENTRY_PAGE_ROWS 7u
#define X86_EXECUTABLE_INDEX_ENTRY_TAIL_ROW 8u
#define X86_EXECUTABLE_INDEX_RESIDUAL_STATE 9u
#define X86_EXECUTABLE_INDEX_RESIDUAL_EDGE 10u
#define X86_EXECUTABLE_INDEX_KERNEL_MODULE 11u
#define X86_EXECUTABLE_INDEX_INSTANTIATION 12u
#define X86_EXECUTABLE_INDEX_PARAMETER 13u
#define X86_EXECUTABLE_PAGE_CACHE 64u
#define X86_EXECUTABLE_MODULE_CACHE 32u
#define X86_EXECUTABLE_BINDING_CACHE \
    PL_VM_EXECUTABLE_BINDING_CACHE_SLOTS
#define X86_EXECUTABLE_ENTRY_PAGE_CACHE \
    PL_VM_EXECUTABLE_PAGE_ROW_CACHE_SLOTS
#define X86_EXECUTABLE_ENTRY_TAIL_CACHE \
    PL_VM_EXECUTABLE_TAIL_ROW_CACHE_SLOTS
#define X86_EXECUTABLE_RESIDUAL_STATE_CACHE 32u
#define X86_EXECUTABLE_RESIDUAL_EDGE_CACHE 64u
#define X86_EXECUTABLE_INSTANTIATION_CACHE 32u
#define X86_EXECUTABLE_PARAMETER_CACHE 32u
#define X86_EXECUTABLE_PARAMETER_VALUES 255u
#define X86_EXECUTABLE_MODULE_PAGE_CACHE 128u
#define X86_EXECUTABLE_INDEX_CACHE_SETS 16u
#define X86_EXECUTABLE_INDEX_CACHE_WAYS 4u
#define X86_EXECUTABLE_INDEX_CACHE \
    (X86_EXECUTABLE_INDEX_CACHE_SETS * X86_EXECUTABLE_INDEX_CACHE_WAYS)
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
    const u8 *execution_page;
    u8 memory[STEP_MEMORY_PAGES][GUEST_PAGE_BYTES];
    u8 memory_transfer[GUEST_PAGE_BYTES];
    u8 copy_buffer[GUEST_PAGE_BYTES];
    u64 values[STEP_VALUE_CAP + 1u];
    u64 alu_result[STEP_VALUE_CAP + 1u];
    u64 alu_aux[STEP_VALUE_CAP + 1u];
    u64 divide_quotient[STEP_VALUE_CAP + 1u];
    u64 divide_remainder[STEP_VALUE_CAP + 1u];
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
    /* Guest work/span price the source program.  These counters price the
     * resident engine itself, including retries, so an emitted representative
     * can be compared with STEP interpretation without blaming artifact I/O. */
    u64 profile_step_opens;
    u64 profile_step_restores;
    u64 profile_execute_calls;
    u64 profile_nodes_executed;
    u64 profile_projection_queries;
    u32 template_rank;
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
    u32 template_rank;
    u32 column_offset[STEP_COLUMN_COUNT];
    u32 column_count[STEP_COLUMN_COUNT];
} X86CachedStep;

/* A native x86 continuation consumes build-time packed STEP/control records.
 * The browser supplies records and physical pages by coordinate; CPU state,
 * control selection, and the virtual-memory lease remain in this module. */
typedef struct {
    union {
        pl_vm_x86_state architectural;
        struct {
            u64 *registers;
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
            u32 mxcsr;
            u64 memory_bytes;
            u64 retired;
            u64 work;
            u64 span;
            u64 x87_significand[PL_VM_X86_X87_REGISTERS];
            pl_u16 x87_sign_exponent[PL_VM_X86_X87_REGISTERS];
            pl_u16 x87_control;
            pl_u16 x87_status;
            pl_u16 x87_tag;
            pl_u16 x87_opcode;
            u64 x87_ip;
            u64 x87_dp;
        };
    };
    u64 control_argument[3];
    pl_vm_executable_context executable;
    u32 executable_published;
    u32 direct_blocks;
    u32 direct_function;
    u32 direct_residual;
    pl_vm_result direct_memory_result;
    /* A load_region is one translated, page-pinned physical operation.  Its
     * at-most-eight values and end coordinate stay in this fixed physical
     * array until the direct block consumes their projections; no scalar
     * load list or STEP region dictionary is reconstructed. */
    u64 direct_region_results[X86_DIRECT_REGION_CAP]
                             [X86_DIRECT_REGION_RESULT_CAP];
    u32 direct_region_width[X86_DIRECT_REGION_CAP];
    u64 direct_divide_result[2];
    u64 direct_rotate_carry_result;
    u64 direct_memory_value[X86_DIRECT_MEMORY_CAP];
    u32 direct_transaction_active;
    u32 direct_transaction_block;
    u32 direct_transaction_completed;
    u32 direct_repeat_active;
    u32 direct_repeat_width;
    u32 direct_repeat_phase;
    u64 direct_repeat_key_address;
    u64 direct_repeat_key_pattern;
    u64 direct_repeat_key_size;
    u64 direct_repeat_key_shape;
    u64 direct_repeat_address;
    u64 direct_repeat_remaining;
    u32 direct_copy_active;
    u32 direct_copy_phase;
    u32 direct_copy_backward;
    u32 direct_copy_pending;
    u32 direct_copy_pending_at;
    u64 direct_copy_key_source;
    u64 direct_copy_key_target;
    u64 direct_copy_key_size;
    u64 direct_copy_key_shape;
    u64 direct_copy_source;
    u64 direct_copy_target;
    u64 direct_copy_index;
    u64 direct_copy_limit;
    u8 direct_copy_buffer[X86_PHYSICAL_PAGE_BYTES];
    u32 direct_find_active;
    u32 direct_find_first;
    u32 direct_find_second;
    u64 direct_find_key_address;
    u64 direct_find_key_first;
    u64 direct_find_key_second;
    u64 direct_find_key_shape;
    u64 direct_find_address;
    u64 direct_find_offset;
    u32 direct_frame_active;
    u32 direct_frame_index;
    u32 direct_frame_pending;
    u64 direct_frame_key_frame;
    u64 direct_frame_key_base;
    u64 direct_frame_key_level;
    u64 direct_frame_key_shape;
    u64 direct_frame_value;
    pl_executable executable_root;
    u32 executable_root_loading;
    u32 executable_table_base;
    u32 executable_request;
    u32 executable_index_kind;
    pl_index_key executable_index_key;
    pl_index_ref executable_index_ref;
    pl_executable_binding executable_entry_binding;
    pl_executable_module executable_entry_module;
    pl_executable_resource executable_base_resource;
    pl_executable_resource executable_page_resource;
    pl_sha256 executable_module_hash;
    u64 executable_module_offset;
    u32 executable_page_loading;
    u32 executable_code_loading;
    u32 executable_map_loading;
    u32 executable_map_tail;
    u32 executable_map_rank;
    u32 executable_residual_loading;
    u32 executable_residual_edge;
    u32 executable_residual_rank;
    u32 executable_kernel_loading;
    u32 executable_kernel_rank;
    u32 executable_instantiation_loading;
    u32 executable_instantiation_parameter;
    u32 executable_instantiation_rank;
    /* These counts expose cold-path amplification.  In particular,
     * index_starts / admitted_payloads distinguishes useful page admission
     * from repeated root-to-leaf directory work. */
    u64 executable_index_starts;
    u64 executable_index_nodes;
    u64 executable_index_cache_hits;
    u64 executable_index_cache_misses;
    u64 executable_resource_payloads;
    u64 executable_module_chunks;
    u64 executable_parameter_materializations;
    u64 executable_parameter_words;
    /* Index objects are immutable after digest verification.  A small
     * set-associative page cache keeps authenticated roots and hot branches
     * resident, so a cold payload does not cause another complete directory
     * descent.  Metadata is published before valid, as with every other
     * physical cache in this workspace. */
    u8 executable_index_cache_bytes[X86_EXECUTABLE_INDEX_CACHE]
                                   [PL_INDEX_NODE_BYTES];
    u8 executable_index_cache_digest[X86_EXECUTABLE_INDEX_CACHE]
                                    [PL_SHA256_BYTES];
    pl_index_key executable_index_cache_first[X86_EXECUTABLE_INDEX_CACHE];
    pl_index_key executable_index_cache_last[X86_EXECUTABLE_INDEX_CACHE];
    u64 executable_index_cache_age[X86_EXECUTABLE_INDEX_CACHE];
    u64 executable_index_cache_clock;
    u32 executable_index_cache_length[X86_EXECUTABLE_INDEX_CACHE];
    u32 executable_index_cache_level[X86_EXECUTABLE_INDEX_CACHE];
    u32 executable_index_cache_leaf_row_bytes[X86_EXECUTABLE_INDEX_CACHE];
    u32 executable_index_cache_row_bytes[X86_EXECUTABLE_INDEX_CACHE];
    u32 executable_index_cache_row_count[X86_EXECUTABLE_INDEX_CACHE];
    u32 executable_index_cache_valid[X86_EXECUTABLE_INDEX_CACHE];
    u64 executable_code_page[X86_EXECUTABLE_PAGE_CACHE];
    u64 executable_code_generation[X86_EXECUTABLE_PAGE_CACHE];
    u32 executable_code_function[X86_EXECUTABLE_PAGE_CACHE];
    u32 executable_code_argument[X86_EXECUTABLE_PAGE_CACHE];
    u32 executable_code_valid[X86_EXECUTABLE_PAGE_CACHE];
    u32 executable_module_first[X86_EXECUTABLE_MODULE_CACHE];
    u32 executable_module_count[X86_EXECUTABLE_MODULE_CACHE];
    u32 executable_module_valid[X86_EXECUTABLE_MODULE_CACHE];
    u32 executable_module_page_tag[X86_EXECUTABLE_MODULE_PAGE_CACHE];
    u32 executable_module_page_first[X86_EXECUTABLE_MODULE_PAGE_CACHE];
    u32 executable_module_page_count[X86_EXECUTABLE_MODULE_PAGE_CACHE];
    u32 executable_binding_tag[X86_EXECUTABLE_BINDING_CACHE];
    u32 executable_binding_generation[X86_EXECUTABLE_BINDING_CACHE];
    u32 executable_binding_argument[X86_EXECUTABLE_BINDING_CACHE];
    u32 executable_entry_page_tag[X86_EXECUTABLE_ENTRY_PAGE_CACHE];
    u32 executable_entry_page_rows[X86_EXECUTABLE_ENTRY_PAGE_CACHE]
                                  [PL_ENTRY_PAGE_ROWS];
    u32 executable_entry_tail_tag[X86_EXECUTABLE_ENTRY_TAIL_CACHE];
    u32 executable_entry_tail_rows[X86_EXECUTABLE_ENTRY_TAIL_CACHE]
                                  [PL_ENTRY_TAIL_VALUES];
    /* Canonical delivery pages are expanded once at admission.  The hot
     * residual runner then touches only the selected physical columns: one
     * kernel rank, two degree bits, two local rank prefixes, and one edge.
     * Tags publish last, so eviction cannot expose a mixed generation. */
    u32 executable_residual_state_tag[
        X86_EXECUTABLE_RESIDUAL_STATE_CACHE];
    u32 executable_residual_state_count[
        X86_EXECUTABLE_RESIDUAL_STATE_CACHE];
    u32 executable_residual_state_first_edge[
        X86_EXECUTABLE_RESIDUAL_STATE_CACHE];
    u32 executable_residual_kernel[X86_EXECUTABLE_RESIDUAL_STATE_CACHE]
                                  [PL_RESIDUAL_STATE_PAGE_STATES];
    u64 executable_residual_zero[X86_EXECUTABLE_RESIDUAL_STATE_CACHE]
                                [PL_RESIDUAL_STATE_PAGE_WORDS];
    u64 executable_residual_two[X86_EXECUTABLE_RESIDUAL_STATE_CACHE]
                               [PL_RESIDUAL_STATE_PAGE_WORDS];
    u32 executable_residual_zero_prefix[
        X86_EXECUTABLE_RESIDUAL_STATE_CACHE]
        [PL_RESIDUAL_STATE_PAGE_WORDS + 1u];
    u32 executable_residual_two_prefix[
        X86_EXECUTABLE_RESIDUAL_STATE_CACHE]
        [PL_RESIDUAL_STATE_PAGE_WORDS + 1u];
    u32 executable_residual_edge_tag[
        X86_EXECUTABLE_RESIDUAL_EDGE_CACHE];
    u32 executable_residual_edge_count[
        X86_EXECUTABLE_RESIDUAL_EDGE_CACHE];
    u32 executable_residual_next[X86_EXECUTABLE_RESIDUAL_EDGE_CACHE]
                                [PL_RESIDUAL_EDGE_PAGE_EDGES];
    i32 executable_residual_delta[X86_EXECUTABLE_RESIDUAL_EDGE_CACHE]
                                 [PL_RESIDUAL_EDGE_PAGE_EDGES];
    u32 executable_instantiation_tag[X86_EXECUTABLE_INSTANTIATION_CACHE];
    u32 executable_instantiation_count[X86_EXECUTABLE_INSTANTIATION_CACHE];
    u32 executable_instantiation_topology[X86_EXECUTABLE_INSTANTIATION_CACHE]
                                         [PL_INSTANTIATION_PAGE_ROWS];
    u32 executable_instantiation_first[X86_EXECUTABLE_INSTANTIATION_CACHE]
                                      [PL_INSTANTIATION_PAGE_ROWS];
    u8 executable_instantiation_words[X86_EXECUTABLE_INSTANTIATION_CACHE]
                                     [PL_INSTANTIATION_PAGE_ROWS];
    u32 executable_parameter_tag[X86_EXECUTABLE_PARAMETER_CACHE];
    u32 executable_parameter_count[X86_EXECUTABLE_PARAMETER_CACHE];
    u64 executable_parameter_page[X86_EXECUTABLE_PARAMETER_CACHE]
                                 [PL_PARAMETER_PAGE_WORDS];
    u64 executable_parameter_values[X86_EXECUTABLE_PARAMETER_VALUES];
    /* Root and cold index/module chunks have disjoint phases, so one physical
     * page is their complete bounded materialization budget. */
    u8 executable_stage[PL_INDEX_NODE_BYTES];
    u8 block_cache_small[X86_BLOCK_CACHE_SMALL_SLOTS]
                        [X86_BLOCK_CACHE_SMALL_BYTES];
    u8 block_cache_medium[X86_BLOCK_CACHE_MEDIUM_SLOTS]
                         [X86_BLOCK_CACHE_MEDIUM_BYTES];
    u8 block_cache_large[X86_BLOCK_CACHE_LARGE_SLOTS]
                        [X86_BLOCK_CACHE_LARGE_BYTES];
    u64 block_cache_rip[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_bytes[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_valid[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_age[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_class[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_data_slot[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_small_owner[X86_BLOCK_CACHE_SMALL_SLOTS];
    u32 block_cache_medium_owner[X86_BLOCK_CACHE_MEDIUM_SLOTS];
    u32 block_cache_large_owner[X86_BLOCK_CACHE_LARGE_SLOTS];
    u32 block_cache_next[X86_BLOCK_CACHE_CLASSES];
    u32 block_cache_victim[X86_BLOCK_CACHE_CLASSES];
    X86CachedStep block_cache_step[X86_BLOCK_CACHE_SLOTS];
    u32 block_cache_clock;
    u8 physical[X86_PHYSICAL_PAGES][X86_PHYSICAL_PAGE_BYTES];
    u8 physical_transfer[X86_PHYSICAL_PAGE_BYTES];
    u64 physical_page[X86_PHYSICAL_PAGES];
    u32 physical_direct[X86_PHYSICAL_DIRECT_PAGES];
    u64 physical_lookup_page[X86_PHYSICAL_LOOKUP_SLOTS];
    u32 physical_lookup_slot[X86_PHYSICAL_LOOKUP_SLOTS];
    u32 physical_lookup_valid[X86_PHYSICAL_LOOKUP_SLOTS];
    u64 physical_lookup_probes;
    u64 physical_victim_probes;
    u32 physical_lookup_tombstones;
    u32 physical_free_cursor;
    u32 physical_victim_cursor;
    u32 physical_referenced[X86_PHYSICAL_PAGES];
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
    u32 entropy_direct_request;
    u32 entropy_direct_ready;
    u32 entropy_direct_descriptor;
    u8 uart[8];
    u8 uart_valid[8];
    u32 pit_counter;
    u32 pit_low_latch;
    u32 pit_read_phase;
    u32 pit_write_phase;
    u8 pic_mask[2];
    u32 ferr_pending;
    u32 timer_source_instructions;
    u32 uart_tx_pending;
    u8 console_input[X86_CONSOLE_CAP];
    u32 console_head;
    u32 console_count;
    u32 interrupt_shadow;
    u32 active;
    u32 halted;
    u32 error;
} X86Workspace;

_Static_assert(X86_REGISTER_COUNT == PL_VM_X86_REGISTER_COUNT,
               "direct block ABI register count");
_Static_assert(32u == PL_VM_X86_XMM_WORDS,
               "direct block ABI vector-state width");
_Static_assert(X86_SYSTEM_COUNT == PL_VM_X86_SYSTEM_WORDS,
               "direct block ABI system-state width");
_Static_assert(X86_MSR_CAP == PL_VM_X86_MSR_WORDS,
               "direct block ABI MSR width");
_Static_assert(__builtin_offsetof(X86Workspace, registers)
               == __builtin_offsetof(pl_vm_x86_state, registers),
               "direct block ABI register pointer offset");
_Static_assert(__builtin_offsetof(X86Workspace, rip)
               == __builtin_offsetof(pl_vm_x86_state, rip),
               "direct block ABI RIP offset");
_Static_assert(__builtin_offsetof(X86Workspace, cr3)
               == __builtin_offsetof(pl_vm_x86_state, cr3),
               "direct block ABI CR3 offset");
_Static_assert(__builtin_offsetof(X86Workspace, span)
               == __builtin_offsetof(pl_vm_x86_state, span),
               "direct block ABI final field offset");
_Static_assert(__builtin_offsetof(X86Workspace, control_argument)
               == sizeof(pl_vm_x86_state),
               "direct block ABI is the complete architectural prefix");
_Static_assert(sizeof(pl_vm_executable_context)
               == PL_VM_EXECUTABLE_CONTEXT_BYTES,
               "direct executable context ABI size");
#if defined(__wasm32__)
_Static_assert(__builtin_offsetof(pl_vm_x86_state, registers)
               == PL_VM_X86_WASM32_OFF_REGISTERS,
               "direct ABI wasm32 register offset");
_Static_assert(__builtin_offsetof(pl_vm_x86_state, rip)
               == PL_VM_X86_WASM32_OFF_RIP,
               "direct ABI wasm32 RIP offset");
_Static_assert(__builtin_offsetof(pl_vm_x86_state, rflags)
               == PL_VM_X86_WASM32_OFF_RFLAGS,
               "direct ABI wasm32 RFLAGS offset");
_Static_assert(__builtin_offsetof(pl_vm_x86_state, retired)
               == PL_VM_X86_WASM32_OFF_RETIRED,
               "direct ABI wasm32 retired offset");
_Static_assert(__builtin_offsetof(pl_vm_x86_state, work)
               == PL_VM_X86_WASM32_OFF_WORK,
               "direct ABI wasm32 work offset");
_Static_assert(__builtin_offsetof(pl_vm_x86_state, span)
               == PL_VM_X86_WASM32_OFF_SPAN,
               "direct ABI wasm32 span offset");
_Static_assert(sizeof(pl_vm_x86_state) == PL_VM_X86_WASM32_STATE_BYTES,
               "direct ABI wasm32 state extent");
#endif

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
    return read_u32(machine->execution_page + machine->column_offset[column]
                    + index * 4u);
}

static u64 step_u64(u32 column, u32 index)
{
    StepWorkspace *machine = step_machine();
    return load_u64(machine->execution_page + machine->column_offset[column]
                    + index * 8u);
}

static u32 step_u8(u32 column, u32 index)
{
    StepWorkspace *machine = step_machine();
    return machine->execution_page[machine->column_offset[column] + index];
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
    STEP_PROJECTION_DIVIDE = 5,
    STEP_PROJECTION_ROTATE_ACTIVE = 6,
};

#define STEP_SPECIALIZED_PROJECTION(kind) (4u + (kind))

static int step_flag_projection_opcode(u32 opcode)
{
    return opcode == 183u || opcode == 187u || opcode == 191u
        || opcode == 193u || opcode == 195u || opcode == 197u;
}

static int x86_divide_value(u64 high, u64 low, u64 divisor, u32 width,
                            u32 signed_divide, u64 *quotient,
                            u64 *remainder);

static u32 step_projection_kind_uncached(
        u64 coordinate, u32 final_relative_source)
{
    StepWorkspace *machine = step_machine();
    u64 wide_source = coordinate >> 8u;
    u32 selector = (u32)coordinate & 255u;
    if (!wide_source || wide_source > machine->work)
        return STEP_PROJECTION_NONE;
    u32 source = (u32)wide_source;
    u32 opcode = step_u8(STEP_OPCODES, source - 1u);
    if (opcode == 203u || opcode == 204u || opcode == 211u)
        return selector < 16u ? STEP_PROJECTION_FLAGS
             : selector == 16u ? STEP_PROJECTION_ALU_RESULT
             : opcode == 211u && selector == 17u
                 ? STEP_PROJECTION_ROTATE_ACTIVE
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
    if (opcode == 210u)
        return selector < 2u ? STEP_PROJECTION_DIVIDE
                             : STEP_PROJECTION_NONE;
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

static u32 step_projection_kind(u64 coordinate, u32 final_relative_source)
{
    StepWorkspace *machine = step_machine();
    machine->profile_projection_queries += 1u;
    return step_projection_kind_uncached(coordinate, final_relative_source);
}

static int step_specialize_projection_column(
        u32 tag_column, u32 value_column, u32 count,
        u32 final_relative_source)
{
    StepWorkspace *machine = step_machine();
    u32 tags = machine->column_offset[tag_column];
    for (u32 index = 0; index < count; ++index) {
        if (machine->execution_page[tags + index] != 4u) continue;
        u64 coordinate = step_u64(value_column, index);
        u32 kind = step_projection_kind(
            coordinate, final_relative_source);
        if (!kind) return 0;
        /* The concrete STEP page is the delivery projection owned by this
         * session.  Replace the generic projection tag once; cached execution
         * reads its semantic class directly and never walks the opcode graph. */
        machine->page[tags + index] = (u8)STEP_SPECIALIZED_PROJECTION(kind);
    }
    return 1;
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
    machine->profile_step_opens = 0;
    machine->profile_step_restores = 0;
    machine->profile_execute_calls = 0;
    machine->profile_nodes_executed = 0;
    machine->profile_projection_queries = 0;
    machine->template_rank = 0;
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

EXPORT u64 vm_step_profile_opens(u64 session)
{
    return step_session_is(session) ? step_machine()->profile_step_opens : 0;
}

EXPORT u64 vm_step_profile_restores(u64 session)
{
    return step_session_is(session) ? step_machine()->profile_step_restores : 0;
}

EXPORT u64 vm_step_profile_execute_calls(u64 session)
{
    return step_session_is(session) ? step_machine()->profile_execute_calls : 0;
}

EXPORT u64 vm_step_profile_nodes(u64 session)
{
    return step_session_is(session) ? step_machine()->profile_nodes_executed : 0;
}

EXPORT u64 vm_step_profile_projection_queries(u64 session)
{
    return step_session_is(session)
         ? step_machine()->profile_projection_queries : 0;
}

EXPORT u32 vm_x86_resident_abi(void)
{
    return 4u;
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

static int step_open_class(u64 session, u32 bytes, u32 template_rank)
{
    static const u8 widths[STEP_COLUMN_COUNT] = {
        4, 4, 1, 4, 1, 8, 1, 8, 4, 1, 8,
    };
    StepWorkspace *machine = step_machine();
    if (!step_session_is(session) || machine->execution_active
            || machine->memory_status)
        return 0;
    machine->error = 0;
    machine->profile_step_opens += 1u;
    machine->template_rank = template_rank;
    if (bytes < STEP_HEADER_BYTES || bytes > STEP_PAGE_BYTES)
        return step_fail(1u);
    const u8 *page = machine->page;
    machine->execution_page = page;
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
        if (!machine->values[node] || step_u8(STEP_OPCODES, node - 1u) >= 211u)
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
    if (!step_specialize_projection_column(
            STEP_OPERAND_TAGS, STEP_OPERAND_VALUES, machine->operands, 0u)
            || !step_specialize_projection_column(
                STEP_STACK_TAGS, STEP_STACK_VALUES,
                machine->stack_count, projection_source)
            || !step_specialize_projection_column(
                STEP_LOCAL_TAGS, STEP_LOCAL_VALUES,
                machine->local_updates, projection_source))
        return step_fail(5u);
    return 1;
}

EXPORT int vm_step_open(u64 session, u32 bytes)
{
    return step_open_class(session, bytes, 0u);
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
    else if (tag >= STEP_SPECIALIZED_PROJECTION(STEP_PROJECTION_RELATIVE)
             && tag <= STEP_SPECIALIZED_PROJECTION(
                 STEP_PROJECTION_ROTATE_ACTIVE)) {
        u32 source = (u32)(coordinate >> 8u);
        u32 selector = (u32)coordinate & 255u;
        u32 projection = tag - 4u;
        if (projection == STEP_PROJECTION_ALU_RESULT)
            *value = machine->alu_result[source];
        else if (projection == STEP_PROJECTION_ROTATE_ACTIVE)
            *value = machine->alu_aux[source];
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
        } else if (projection == STEP_PROJECTION_DIVIDE) {
            *value = selector ? machine->divide_remainder[source]
                              : machine->divide_quotient[source];
        } else
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

static int step_memory_store_if_lane(u32 begin, u32 end, u64 *result)
{
    if (end - begin < 5u) return step_fail(9u);
    u64 address, value, predicate, offset, shape;
    if (!step_operand(begin, &address)
            || !step_operand(begin + 1u, &value)
            || !step_operand(begin + 2u, &predicate)
            || !step_operand(begin + 3u, &offset)
            || !step_operand(begin + 4u, &shape))
        return 0;
    u32 width = (u32)shape & 0xffu;
    u32 scale = (u32)(shape >> 8u) & 31u;
    if ((width != 1u && width != 2u && width != 4u && width != 8u)
            || scale || !(shape & 0x10000u) || (shape & ~0x11fffull))
        return step_fail(9u);
    if (!predicate) {
        *result = 0u;
        return 1;
    }
    if (offset > ~0ull - address
            || address + offset > ~0ull - (width - 1u))
        return step_fail(10u);
    u64 effective = address + offset;
    StepMemoryGuard guard;
    if (!step_memory_ready(effective, width, &guard)) return 0;
    if (!step_memory_store(effective, value, width, &guard)) return 0;
    *result = 0u;
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
    amount &= width == 64u ? 63u : 31u;
    if ((group == 0u || group == 1u) && width < 32u)
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
    else if (group == 4u)
        carry = amount <= width ? (source >> (width - amount)) & 1u : 0u;
    else carry = amount <= width ? (source >> (amount - 1u)) & 1u : 0u;
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

static int x86_rotate_carry_value(
        u64 prior, u64 source, u64 amount, u64 descriptor,
        u64 *flags, u64 *value)
{
    u32 width = (u32)descriptor & 0x7fu;
    u32 right = ((u32)descriptor >> 8u) & 1u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || descriptor != (u64)(width | (right << 8u)))
        return 0;
    u64 mask = step_mask(width);
    source &= mask;
    u32 count = (u32)amount & (width == 64u ? 63u : 31u);
    if (width < 32u) count %= width + 1u;
    if (!count) {
        *flags = prior;
        *value = source;
        return 1;
    }
    u32 distance = width - count;
    u64 carry_in = prior & 1u;
    u64 carry;
    u64 overflow;
    if (right) {
        *value = ((source >> count)
                | (carry_in << distance)
                | ((source << distance) << 1u)) & mask;
        carry = (source >> (count - 1u)) & 1u;
        overflow = ((*value >> (width - 1u))
                  ^ (*value >> (width - 2u))) & 1u;
    } else {
        *value = ((source << count)
                | (carry_in << (count - 1u))
                | ((source >> distance) >> 1u)) & mask;
        carry = (source >> distance) & 1u;
        overflow = ((*value >> (width - 1u)) ^ carry) & 1u;
    }
    if (count != 1u) overflow = 0u;
    *flags = (prior & ~((1ull << 11u) | 1u))
           | carry | (overflow << 11u) | 2u;
    return 1;
}

static int step_x86_rotate_carry_lane(
        u32 node, u32 begin, u32 end, u64 *result)
{
    if (end - begin != 4u) return step_fail(7u);
    u64 prior, source, amount, descriptor, value;
    if (!step_operand(begin, &prior)
            || !step_operand(begin + 1u, &source)
            || !step_operand(begin + 2u, &amount)
            || !step_operand(begin + 3u, &descriptor))
        return 0;
    if (!x86_rotate_carry_value(
            prior, source, amount, descriptor, result, &value))
        return step_fail(7u);
    StepWorkspace *machine = step_machine();
    u32 width = (u32)descriptor & 0x7fu;
    u32 count = (u32)amount & (width == 64u ? 63u : 31u);
    if (width < 32u) count %= width + 1u;
    machine->alu_result[node] = value;
    machine->alu_aux[node] = count != 0u;
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
            || (index_bits != 16u && index_bits != 32u && index_bits != 64u)
            || descriptor != (u64)(word_bits | (index_bits << 8u)))
        return step_fail(7u);
    u32 word_shift = word_bits == 16u ? 4u : word_bits == 32u ? 5u : 6u;
    u32 byte_shift = word_shift - 3u;
    i64 signed_index = (i64)index;
    if (index_bits == 16u) {
        u32 low = (u32)index & 0xffffu;
        signed_index = low & 0x8000u
            ? (i64)((u64)low | ~0xffffull) : (i64)low;
    } else if (index_bits == 32u) {
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

static int step_x86_divide_lane(u32 node, u32 begin, u32 end, u64 *result)
{
    StepWorkspace *machine = step_machine();
    if (end - begin != 4u) return step_fail(7u);
    u64 high, low, divisor, descriptor;
    if (!step_operand(begin, &high)
            || !step_operand(begin + 1u, &low)
            || !step_operand(begin + 2u, &divisor)
            || !step_operand(begin + 3u, &descriptor))
        return 0;
    u32 width = (u32)descriptor & 0x7fu;
    u32 signed_divide = ((u32)descriptor >> 8u) & 1u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || descriptor != (u64)(width | (signed_divide << 8u)))
        return step_fail(7u);
    u64 quotient = 0u, remainder = 0u;
    int valid = x86_divide_value(
        high, low, divisor, width, signed_divide,
        &quotient, &remainder);
    machine->divide_quotient[node] = quotient;
    machine->divide_remainder[node] = remainder;
    *result = valid ? 0u : 1u;
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
    else if (tag >= STEP_SPECIALIZED_PROJECTION(STEP_PROJECTION_RELATIVE)
             && tag <= STEP_SPECIALIZED_PROJECTION(
                 STEP_PROJECTION_ROTATE_ACTIVE)) {
        u64 source = coordinate >> 8u;
        u32 selector = (u32)coordinate & 255u;
        u32 projection = tag - 4u;
        if (projection == STEP_PROJECTION_ALU_RESULT) {
            *result = machine->alu_result[source];
            return 1;
        }
        if (projection == STEP_PROJECTION_ROTATE_ACTIVE) {
            *result = machine->alu_aux[source];
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
        if (projection == STEP_PROJECTION_DIVIDE) {
            *result = selector ? machine->divide_remainder[source]
                               : machine->divide_quotient[source];
            return 1;
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
    machine->profile_execute_calls += 1u;
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
                : opcode == 210u
                ? step_x86_divide_lane(
                    node, first, last, &machine->values[node])
                : opcode == 211u
                ? step_x86_rotate_carry_lane(
                    node, first, last, &machine->values[node])
                : opcode == 212u
                ? step_memory_store_if_lane(
                    first, last, &machine->values[node])
                : step_fail(7u));
            if (!produced) {
                if (machine->memory_status) return machine->memory_status;
                machine->execution_active = 0;
                return STEP_TRAP;
            }
            machine->profile_nodes_executed += 1u;
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
    X86_CONTROL_SIMD_REGISTER = 37,
    X86_CONTROL_SIMD_COMPARE = 38,
    X86_CONTROL_SIMD_CONVERT = 39,
    X86_CONTROL_SIMD_SCALAR = 40,
    X86_CONTROL_FPU_SAVE = 41,
    X86_CONTROL_FPU_RESTORE = 42,
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
    X86_RSI = 6,
    X86_RDI = 7,
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
            return (u32)key == 0x10u
                 ? x86->msr_values[index] + x86->retired
                 : x86->msr_values[index];
    return (u32)key == 0x10u ? x86->retired : 0u;
}

static int x86_msr_write(u64 key, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if ((u32)key == 0xc0000080u) x86->efer = value;
    if ((u32)key == 0x10u) value -= x86->retired;
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

/* SWAPGS is one atomic exchange in the architectural MSR bank.  Missing
 * coordinates read as zero, so reserve every nonzero destination before
 * changing either resident slot; an exhausted bank can never publish half
 * of the exchange. */
static int x86_swap_gs_bases(void)
{
    X86Workspace *x86 = x86_machine();
    u32 current_at = X86_MSR_CAP, kernel_at = X86_MSR_CAP;
    for (u32 index = 0u; index < x86->msr_count; ++index) {
        u32 key = (u32)x86->msr_keys[index];
        if (key == 0xc0000101u) current_at = index;
        else if (key == 0xc0000102u) kernel_at = index;
    }
    u64 current = current_at < X86_MSR_CAP
                ? x86->msr_values[current_at] : 0u;
    u64 kernel = kernel_at < X86_MSR_CAP
               ? x86->msr_values[kernel_at] : 0u;
    u32 needed = (current_at == X86_MSR_CAP && kernel != 0u)
               + (kernel_at == X86_MSR_CAP && current != 0u);
    if (needed > X86_MSR_CAP - x86->msr_count) return 0;
    if (current_at < X86_MSR_CAP) x86->msr_values[current_at] = kernel;
    else if (kernel != 0u) {
        x86->msr_keys[x86->msr_count] = 0xc0000101u;
        x86->msr_values[x86->msr_count++] = kernel;
    }
    if (kernel_at < X86_MSR_CAP) x86->msr_values[kernel_at] = current;
    else if (current != 0u) {
        x86->msr_keys[x86->msr_count] = 0xc0000102u;
        x86->msr_values[x86->msr_count++] = current;
    }
    return 1;
}

static int x86_invalidate_virtual(u64 address);

/* One deterministic virtual CPU model is shared by legacy artifact migration
 * and compiler-emitted blocks.  Keeping the leaf projection here prevents a
 * second CPUID identity from growing beside the direct execution path. */
static void x86_cpuid_model(u32 leaf, u32 subleaf,
                            u32 *eax, u32 *ebx, u32 *ecx, u32 *edx)
{
    *eax = 0u; *ebx = 0u; *ecx = 0u; *edx = 0u;
    if (leaf == 0u) {
        *eax = PL_X86_CPUID_MAX_BASIC;
        *ebx = PL_X86_CPUID_VENDOR_EBX;
        *ecx = PL_X86_CPUID_VENDOR_ECX;
        *edx = PL_X86_CPUID_VENDOR_EDX;
    } else if (leaf == 1u) {
        *eax = PL_X86_CPUID_SIGNATURE;
        *ecx = PL_X86_CPUID_1_ECX;
        *edx = PL_X86_CPUID_1_EDX;
    } else if (leaf == 7u && subleaf == 0u) {
        *ebx = PL_X86_CPUID_7_0_EBX;
        *ecx = PL_X86_CPUID_7_0_ECX;
        *edx = PL_X86_CPUID_7_0_EDX;
    } else if (leaf == 0x80000000u) {
        *eax = PL_X86_CPUID_MAX_EXTENDED;
    } else if (leaf == 0x80000001u) {
        *ecx = PL_X86_CPUID_80000001_ECX;
        *edx = PL_X86_CPUID_80000001_EDX;
    } else if (leaf == 0x80000008u) {
        *eax = PL_X86_CPUID_80000008_EAX;
    }
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
        /* Only PE/WP/PG change translation identity.  MP/EM/TS are execution
         * status and must not evict resident physical pages on LMSW/CLTS. */
        if (((x86->cr0 ^ value) & ((1ull << 0u) | (1ull << 16u)
                                   | (1ull << 31u)))
                && !x86_invalidate_address_space()) return 0;
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
    if (x86->ferr_pending && !(x86->pic_mask[0] & (1u << 2u))
            && !(x86->pic_mask[1] & (1u << 5u)))
        return 0x3du;
    if (((x86->console_count && (x86->uart[1] & 1u))
                || (x86->uart_tx_pending && (x86->uart[1] & 2u)))
            && !(x86->pic_mask[0] & (1u << 4u)))
        return 0x34u;
    return timer_ready && !(x86->pic_mask[0] & 1u) ? 0x30u : 0u;
}

static u32 x86_block_cache_set(u64 rip)
{
    return ((u32)(rip ^ (rip >> 12u) ^ (rip >> 24u))
         & (X86_BLOCK_CACHE_SETS - 1u)) * X86_BLOCK_CACHE_WAYS;
}

static u32 x86_block_cache_find(const X86Workspace *x86, u64 rip)
{
    u32 first = x86_block_cache_set(rip);
    for (u32 way = 0; way < X86_BLOCK_CACHE_WAYS; ++way) {
        u32 slot = first + way;
        if (x86->block_cache_valid[slot]
                && x86->block_cache_rip[slot] == rip)
            return slot;
    }
    return X86_BLOCK_CACHE_SLOTS;
}

static u32 x86_block_cache_choose(const X86Workspace *x86, u64 rip)
{
    u32 first = x86_block_cache_set(rip);
    u32 selected = first;
    u32 oldest = ~0u;
    for (u32 way = 0; way < X86_BLOCK_CACHE_WAYS; ++way) {
        u32 slot = first + way;
        if (!x86->block_cache_valid[slot]) return slot;
        if (x86->block_cache_age[slot] < oldest) {
            selected = slot;
            oldest = x86->block_cache_age[slot];
        }
    }
    return selected;
}

static u32 x86_block_cache_size_class(u32 bytes)
{
    if (bytes <= X86_BLOCK_CACHE_SMALL_BYTES)
        return X86_BLOCK_CACHE_SMALL;
    if (bytes <= X86_BLOCK_CACHE_MEDIUM_BYTES)
        return X86_BLOCK_CACHE_MEDIUM;
    if (bytes <= X86_BLOCK_CACHE_LARGE_BYTES)
        return X86_BLOCK_CACHE_LARGE;
    return X86_BLOCK_CACHE_CLASSES;
}

static u32 x86_block_cache_class_slots(u32 size_class)
{
    return size_class == X86_BLOCK_CACHE_SMALL
         ? X86_BLOCK_CACHE_SMALL_SLOTS
         : size_class == X86_BLOCK_CACHE_MEDIUM
         ? X86_BLOCK_CACHE_MEDIUM_SLOTS
         : size_class == X86_BLOCK_CACHE_LARGE
         ? X86_BLOCK_CACHE_LARGE_SLOTS : 0u;
}

static u32 *x86_block_cache_owner(
        X86Workspace *x86, u32 size_class, u32 data_slot)
{
    return size_class == X86_BLOCK_CACHE_SMALL
         ? &x86->block_cache_small_owner[data_slot]
         : size_class == X86_BLOCK_CACHE_MEDIUM
         ? &x86->block_cache_medium_owner[data_slot]
         : &x86->block_cache_large_owner[data_slot];
}

static u8 *x86_block_cache_data(X86Workspace *x86, u32 slot)
{
    u32 size_class = x86->block_cache_class[slot];
    u32 data_slot = x86->block_cache_data_slot[slot];
    return size_class == X86_BLOCK_CACHE_SMALL
         ? x86->block_cache_small[data_slot]
         : size_class == X86_BLOCK_CACHE_MEDIUM
         ? x86->block_cache_medium[data_slot]
         : x86->block_cache_large[data_slot];
}

static void x86_block_cache_invalidate(X86Workspace *x86, u32 slot)
{
    if (slot >= X86_BLOCK_CACHE_SLOTS) return;
    u32 size_class = x86->block_cache_class[slot];
    u32 data_slot = x86->block_cache_data_slot[slot];
    u32 slots = x86_block_cache_class_slots(size_class);
    if (data_slot < slots) {
        u32 *owner = x86_block_cache_owner(x86, size_class, data_slot);
        if (*owner == slot + 1u) *owner = 0;
    }
    x86->block_cache_valid[slot] = 0;
}

static int x86_block_cache_reserve(
        X86Workspace *x86, u32 slot, u32 bytes)
{
    u32 size_class = x86_block_cache_size_class(bytes);
    if (slot >= X86_BLOCK_CACHE_SLOTS
            || size_class >= X86_BLOCK_CACHE_CLASSES)
        return 0;
    if (x86->block_cache_valid[slot]
            && x86->block_cache_class[slot] == size_class) {
        x86->block_cache_valid[slot] = 0;
        return 1;
    }
    x86_block_cache_invalidate(x86, slot);
    u32 slots = x86_block_cache_class_slots(size_class);
    u32 data_slot;
    if (x86->block_cache_next[size_class] < slots) {
        data_slot = x86->block_cache_next[size_class]++;
    } else {
        data_slot = x86->block_cache_victim[size_class]++ & (slots - 1u);
        u32 prior = *x86_block_cache_owner(x86, size_class, data_slot);
        if (prior && prior - 1u < X86_BLOCK_CACHE_SLOTS)
            x86->block_cache_valid[prior - 1u] = 0;
    }
    *x86_block_cache_owner(x86, size_class, data_slot) = slot + 1u;
    x86->block_cache_class[slot] = size_class;
    x86->block_cache_data_slot[slot] = data_slot;
    return 1;
}

static void x86_block_cache_capture_step(
        X86Workspace *x86, u32 slot, const StepWorkspace *step)
{
    X86CachedStep *cached = &x86->block_cache_step[slot];
    cached->page_bytes = step->page_bytes;
    cached->function = step->function;
    cached->start = step->start;
    cached->end = step->end;
    cached->instructions = step->instructions;
    cached->span = step->span;
    cached->work = step->work;
    cached->operands = step->operands;
    cached->stack_inputs = step->stack_inputs;
    cached->stack_count = step->stack_count;
    cached->local_extent = step->local_extent;
    cached->local_updates = step->local_updates;
    cached->template_rank = step->template_rank;
    for (u32 column = 0; column < STEP_COLUMN_COUNT; ++column) {
        cached->column_offset[column] = step->column_offset[column];
        cached->column_count[column] = step->column_count[column];
    }
}

static int x86_block_cache_restore_step(
        X86Workspace *x86, u32 slot, StepWorkspace *step, u32 bytes)
{
    if (slot >= X86_BLOCK_CACHE_SLOTS) return 0;
    const X86CachedStep *cached = &x86->block_cache_step[slot];
    if (cached->page_bytes != bytes) return 0;
    step->error = 0;
    step->profile_step_restores += 1u;
    step->page_bytes = cached->page_bytes;
    step->function = cached->function;
    step->start = cached->start;
    step->end = cached->end;
    step->instructions = cached->instructions;
    step->span = cached->span;
    step->work = cached->work;
    step->operands = cached->operands;
    step->stack_inputs = cached->stack_inputs;
    step->stack_count = cached->stack_count;
    step->local_extent = cached->local_extent;
    step->local_updates = cached->local_updates;
    step->template_rank = cached->template_rank;
    step->execution_active = 0;
    for (u32 column = 0; column < STEP_COLUMN_COUNT; ++column) {
        step->column_offset[column] = cached->column_offset[column];
        step->column_count[column] = cached->column_count[column];
    }
    return 1;
}

static void x86_block_cache_touch(X86Workspace *x86, u32 slot)
{
    x86->block_cache_clock += 1u;
    if (!x86->block_cache_clock) {
        x86->block_cache_clock = 1u;
        for (u32 index = 0; index < X86_BLOCK_CACHE_SLOTS; ++index)
            x86->block_cache_age[index] =
                x86->block_cache_valid[index] ? 1u : 0u;
    }
    x86->block_cache_age[slot] = x86->block_cache_clock;
}

static u32 x86_physical_lookup_set(u64 page)
{
    u64 mixed = page ^ (page >> 33u);
    mixed *= 0xff51afd7ed558ccdull;
    mixed ^= mixed >> 33u;
    return (u32)mixed & (X86_PHYSICAL_LOOKUP_SLOTS - 1u);
}

static u32 x86_physical_lookup(X86Workspace *x86, u64 page)
{
    if (page < X86_PHYSICAL_DIRECT_PAGES) {
        ++x86->physical_lookup_probes;
        u32 tagged = x86->physical_direct[(u32)page];
        if (!tagged) return X86_PHYSICAL_PAGES;
        u32 slot = tagged - 1u;
        if (slot < X86_PHYSICAL_PAGES && x86->physical_valid[slot]
                && x86->physical_page[slot] == page)
            return slot;
        x86->physical_direct[(u32)page] = 0u;
        return X86_PHYSICAL_PAGES;
    }
    u32 first = x86_physical_lookup_set(page);
    for (u32 probe = 0u; probe < X86_PHYSICAL_LOOKUP_SLOTS; ++probe) {
        ++x86->physical_lookup_probes;
        u32 locator = (first + probe) & (X86_PHYSICAL_LOOKUP_SLOTS - 1u);
        u32 state = x86->physical_lookup_valid[locator];
        if (!state) return X86_PHYSICAL_PAGES;
        if (state != 1u || x86->physical_lookup_page[locator] != page)
            continue;
        u32 slot = x86->physical_lookup_slot[locator];
        if (slot < X86_PHYSICAL_PAGES && x86->physical_valid[slot]
                && x86->physical_page[slot] == page)
            return slot;
        x86->physical_lookup_valid[locator] = 2u;
        ++x86->physical_lookup_tombstones;
        return X86_PHYSICAL_PAGES;
    }
    return X86_PHYSICAL_PAGES;
}

static void x86_physical_insert_lookup(
    X86Workspace *x86, u64 page, u32 slot)
{
    u32 first = x86_physical_lookup_set(page);
    u32 selected = X86_PHYSICAL_LOOKUP_SLOTS;
    for (u32 probe = 0u; probe < X86_PHYSICAL_LOOKUP_SLOTS; ++probe) {
        u32 locator = (first + probe) & (X86_PHYSICAL_LOOKUP_SLOTS - 1u);
        u32 state = x86->physical_lookup_valid[locator];
        if (state == 1u && x86->physical_lookup_page[locator] == page) {
            selected = locator;
            break;
        }
        if (state == 2u && selected == X86_PHYSICAL_LOOKUP_SLOTS)
            selected = locator;
        if (!state) {
            if (selected == X86_PHYSICAL_LOOKUP_SLOTS) selected = locator;
            break;
        }
    }
    if (selected == X86_PHYSICAL_LOOKUP_SLOTS) return;
    if (x86->physical_lookup_valid[selected] == 2u)
        --x86->physical_lookup_tombstones;
    x86->physical_lookup_valid[selected] = 0u;
    x86->physical_lookup_page[selected] = page;
    x86->physical_lookup_slot[selected] = slot;
    x86->physical_lookup_valid[selected] = 1u;
}

static void x86_physical_rebuild_lookup(X86Workspace *x86)
{
    for (u32 locator = 0u; locator < X86_PHYSICAL_LOOKUP_SLOTS;
         ++locator)
        x86->physical_lookup_valid[locator] = 0u;
    x86->physical_lookup_tombstones = 0u;
    for (u32 slot = 0u; slot < X86_PHYSICAL_PAGES; ++slot)
        if (x86->physical_valid[slot]
                && x86->physical_page[slot] >= X86_PHYSICAL_DIRECT_PAGES)
            x86_physical_insert_lookup(
                x86, x86->physical_page[slot], slot);
}

static void x86_physical_remove_lookup(
    X86Workspace *x86, u64 page, u32 slot)
{
    if (page < X86_PHYSICAL_DIRECT_PAGES) {
        if (x86->physical_direct[(u32)page] == slot + 1u)
            x86->physical_direct[(u32)page] = 0u;
        return;
    }
    u32 first = x86_physical_lookup_set(page);
    for (u32 probe = 0u; probe < X86_PHYSICAL_LOOKUP_SLOTS; ++probe) {
        u32 locator = (first + probe) & (X86_PHYSICAL_LOOKUP_SLOTS - 1u);
        u32 state = x86->physical_lookup_valid[locator];
        if (!state) return;
        if (state == 1u && x86->physical_lookup_page[locator] == page
                && x86->physical_lookup_slot[locator] == slot) {
            x86->physical_lookup_valid[locator] = 2u;
            ++x86->physical_lookup_tombstones;
            return;
        }
    }
}

static void x86_physical_publish_lookup(
    X86Workspace *x86, u64 page, u32 slot)
{
    if (page < X86_PHYSICAL_DIRECT_PAGES) {
        x86->physical_direct[(u32)page] = slot + 1u;
        return;
    }
    if (x86->physical_lookup_tombstones
            >= X86_PHYSICAL_LOOKUP_SLOTS / 4u)
        x86_physical_rebuild_lookup(x86);
    x86_physical_insert_lookup(x86, page, slot);
}

static int x86_physical_step_bound(
    const X86Workspace *x86, u32 candidate)
{
    StepWorkspace *step = step_machine();
    for (u32 slot = 0u; slot < STEP_MEMORY_PAGES; ++slot) {
        if (!x86->step_physical_valid[slot]
                || x86->step_physical_slot[slot] != candidate)
            continue;
        u32 kind = step_slot_kind(step_slot_load(step, slot));
        if (kind == STEP_SLOT_CLEAN || kind == STEP_SLOT_DIRTY
                || kind == STEP_SLOT_FLUSHING)
            return 1;
    }
    return 0;
}

static u32 x86_physical_slot(u64 page)
{
    X86Workspace *x86 = x86_machine();
    u32 resident = x86_physical_lookup(x86, page);
    if (resident < X86_PHYSICAL_PAGES) return resident;

    /* Slots only become invalid at machine reset.  This monotone cursor makes
     * filling an empty cache linear in the number of pages instead of
     * rescanning the growing resident prefix for every cold page. */
    while (x86->physical_free_cursor < X86_PHYSICAL_PAGES
            && x86->physical_valid[x86->physical_free_cursor]) {
        ++x86->physical_lookup_probes;
        ++x86->physical_free_cursor;
    }
    if (x86->physical_free_cursor < X86_PHYSICAL_PAGES)
        return x86->physical_free_cursor;

    /* CLOCK turns a full-cache victim search into amortized constant work:
     * one sweep clears each resident reference bit at most once. */
    for (u32 probe = 0u; probe < X86_PHYSICAL_PAGES * 2u; ++probe) {
        u32 candidate = x86->physical_victim_cursor;
        x86->physical_victim_cursor =
            (candidate + 1u) & (X86_PHYSICAL_PAGES - 1u);
        ++x86->physical_victim_probes;
        if (x86_physical_step_bound(x86, candidate)) continue;
        if (x86->physical_referenced[candidate]) {
            x86->physical_referenced[candidate] = 0u;
            continue;
        }
        return candidate;
    }
    return x86->physical_victim_cursor;
}

static void x86_physical_touch(u32 slot)
{
    X86Workspace *x86 = x86_machine();
    x86->physical_referenced[slot] = 1u;
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

static int x86_virtual_read_access(u64 address, u8 *target, u32 bytes,
                                   int user_access)
{
    X86Workspace *x86 = x86_machine();
    while (bytes) {
        u64 physical_page;
        int translated = x86_translate_page(
            address >> 12u, 0, 0, user_access, &physical_page);
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

static int x86_virtual_read(u64 address, u8 *target, u32 bytes)
{
    return x86_virtual_read_access(address, target, bytes, 0);
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

static int x86_virtual_write(u64 address, const u8 *bytes, u32 count,
                             int user_access)
{
    X86Workspace *x86 = x86_machine();
    u32 written = 0;
    while (written < count) {
        u64 at = address + written;
        u64 physical_page;
        int translated = x86_translate_page(
            at >> 12u, 1, 0, user_access, &physical_page);
        if (translated <= 0) return translated;
        if (!x86_physical_present(physical_page)) return 0;
        u32 offset = (u32)at & (X86_PHYSICAL_PAGE_BYTES - 1u);
        u32 part = X86_PHYSICAL_PAGE_BYTES - offset;
        if (part > count - written) part = count - written;
        u32 slot = x86_physical_slot(physical_page);
        for (u32 index = 0; index < part; ++index)
            x86->physical[slot][offset + index] = bytes[written + index];
        x86->physical_dirty[slot] = 1u;
        x86_physical_touch(slot);
        written += part;
    }
    return 1;
}


static int x86_virtual_write_u64(u64 address, u64 value, int user_access)
{
    u8 bytes[8];
    store_u64(bytes, value);
    return x86_virtual_write(address, bytes, sizeof bytes, user_access);
}

static int x86_direct_memory_shape(u32 opcode, u64 shape,
                                   u32 *width, int *store,
                                   int *signed_load, u32 *result_bits)
{
    if (opcode == PL_OPCODE_MEMORY_PRE_STORE) {
        *width = (u32)shape & 0xffu;
        *store = 1;
        *signed_load = 0;
        *result_bits = 64u;
        return (*width == 1u || *width == 2u
                || *width == 4u || *width == 8u);
    }
    *store = opcode >= 152u;
    *signed_load = 0;
    *result_bits = opcode <= 144u || (opcode >= 152u && opcode <= 154u)
                 ? 32u : 64u;
    if (opcode == 140u || opcode == 152u) *width = 4u;
    else if (opcode == 141u || opcode == 142u || opcode == 146u
            || opcode == 147u || opcode == 153u || opcode == 156u)
        *width = 1u;
    else if (opcode == 143u || opcode == 144u || opcode == 148u
            || opcode == 149u || opcode == 154u || opcode == 157u)
        *width = 2u;
    else if (opcode == 145u || opcode == 155u) *width = 8u;
    else if (opcode == 150u || opcode == 151u || opcode == 158u)
        *width = 4u;
    else return 0;
    *signed_load = opcode == 141u || opcode == 143u
                || opcode == 146u || opcode == 148u || opcode == 150u;
    return 1;
}

enum X86DirectMemoryAdmission {
    X86_DIRECT_MEMORY_REJECT = 0,
    X86_DIRECT_MEMORY_EXECUTE = 1,
    X86_DIRECT_MEMORY_REPLAY = 2,
};

static void x86_direct_memory_abort(X86Workspace *x86, u64 payload)
{
    x86->direct_transaction_active = 0u;
    x86->direct_repeat_active = 0u;
    x86->direct_copy_active = 0u;
    x86->direct_find_active = 0u;
    x86->direct_frame_active = 0u;
    x86->direct_memory_result = pl_vm_result_make(PL_VM_FAULT, payload);
}

static void x86_direct_exception(X86Workspace *x86, u32 vector,
                                 u32 has_error, u32 error)
{
    x86_direct_memory_abort(x86, vector);
    x86->exception_vector = vector;
    x86->exception_has_error = has_error;
    x86->exception_error = error;
    x86->exception_pending = 1u;
    x86->block_loaded = 0u;
}

/* Publish a direct-memory #PF into the same canonical exception state used by
 * interrupt delivery.  A compiler-emitted block returns before publishing
 * its speculative locals, while CR2 and the error code survive as the exact
 * residual cut consumed by the total RIP dispatcher.  This is deliberately
 * not a host error and does not acquire the legacy STEP interpreter. */
static void x86_direct_page_fault(X86Workspace *x86, u64 address,
                                  int write, int execute, int present)
{
    x86_direct_exception(x86, 14u, 1u, 0u);
    x86->system[X86_SYS_CR2] = address;
    x86->exception_error = present ? 1u : 0u;
    if (write) x86->exception_error |= 2u;
    if (x86->system[X86_SYS_CS] & 3u) x86->exception_error |= 4u;
    if (execute) x86->exception_error |= 16u;
}

/* A direct block may stop at a cold page after earlier memory effects have
 * completed.  Its Wasm locals deliberately disappear at that cut.  This
 * fixed result vector is the residual state: on retry earlier operations
 * replay their value without touching memory, and only the first unfinished
 * physical operation resumes. */
static int x86_direct_memory_enter(X86Workspace *x86, u32 block, u32 slot,
                                   u64 *value)
{
    if (slot >= X86_DIRECT_MEMORY_CAP) {
        x86_direct_memory_abort(x86, 0xffu);
        return X86_DIRECT_MEMORY_REJECT;
    }
    if (!x86->direct_transaction_active) {
        x86->direct_transaction_active = 1u;
        x86->direct_transaction_block = block;
        x86->direct_transaction_completed = 0u;
    }
    if (x86->direct_transaction_block != block
            || slot > x86->direct_transaction_completed) {
        x86_direct_memory_abort(x86, 0xffu);
        return X86_DIRECT_MEMORY_REJECT;
    }
    if (slot < x86->direct_transaction_completed) {
        *value = x86->direct_memory_value[slot];
        return X86_DIRECT_MEMORY_REPLAY;
    }
    return X86_DIRECT_MEMORY_EXECUTE;
}

static u64 x86_direct_memory_finish(X86Workspace *x86, u32 slot, u64 value)
{
    x86->direct_memory_value[slot] = value;
    x86->direct_transaction_completed = slot + 1u;
    return value;
}

/* Direct block modules import these exports from vm.wasm once at module
 * instantiation.  Calls remain Wasm-to-Wasm; JavaScript never observes an
 * individual load/store.  A missing physical page produces a restartable
 * delivery barrier before the emitter publishes architectural locals. */
EXPORT u64 vm_x86_direct_memory(u32 machine, u64 address, u64 value,
                                u64 offset, u64 shape, u32 opcode,
                                u32 block, u32 slot)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_memory_result = 0u;
    u32 width = 0u, result_bits = 0u;
    int store = 0, signed_load = 0;
    if (!x86_direct_memory_shape(
            opcode, shape, &width, &store, &signed_load, &result_bits)
            || (shape & ~(u64)PL_MEMORY_SHAPE_MASK)
            || (u32)(shape & 0xffu) != width) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u32 scale = (u32)(shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
              & PL_MEMORY_SHAPE_SCALE_MASK;
    int pre_store = opcode == PL_OPCODE_MEMORY_PRE_STORE;
    if (pre_store && (scale || !(shape & PL_MEMORY_SHAPE_VIRTUAL64))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u64 replay = 0u;
    int admitted = x86_direct_memory_enter(x86, block, slot, &replay);
    if (admitted != X86_DIRECT_MEMORY_EXECUTE)
        return admitted == X86_DIRECT_MEMORY_REPLAY ? replay : 0u;
    u64 base = shape & PL_MEMORY_SHAPE_VIRTUAL64
             ? address << scale : (u32)((u32)address << scale);
    u64 effective = pre_store ? address - offset : base + offset;
    if (effective > ~0ull - (width - 1u)) {
        x86_direct_page_fault(x86, effective, store, 0, 0);
        return 0u;
    }
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    u8 bytes[8];
    int status;
    if (store) {
        for (u32 index = 0u; index < width; ++index)
            bytes[index] = (u8)(value >> (index * 8u));
        status = x86_virtual_write(effective, bytes, width, user);
    } else {
        status = x86_virtual_read_access(effective, bytes, width, user);
    }
    if (!status) {
        x86->direct_memory_result = pl_vm_result_make(
            PL_VM_BARRIER, x86->physical_status);
        return 0u;
    }
    if (status < 0) {
        /* Exception delivery needs the total page dispatcher before it can
         * re-enter a compiled handler.  Preserve the architectural fault as
         * an explicit terminal token; never acquire an interpreter fallback. */
        x86_direct_page_fault(x86, effective, store, 0, status == -2);
        return 0u;
    }
    if (store)
        return x86_direct_memory_finish(
            x86, slot, pre_store ? effective : 0u);
    value = 0u;
    for (u32 index = 0u; index < width; ++index)
        value |= (u64)bytes[index] << (index * 8u);
    if (signed_load && (bytes[width - 1u] & 0x80u))
        value |= ~0ull << (width * 8u);
    value = result_bits == 32u ? (u32)value : value;
    return x86_direct_memory_finish(x86, slot, value);
}

EXPORT pl_vm_result vm_x86_direct_memory_result(u32 machine)
{
    X86Workspace *x86 = x86_machine();
    return machine == (u32)(uptr)&x86->architectural
         ? x86->direct_memory_result
         : pl_vm_result_make(PL_VM_FAULT, 0xffu);
}

/* Count-zero x86 shifts perform their source read but suppress the write.
 * Keep that fact as one memory-version predicate; writing an unchanged value
 * would incorrectly dirty COW state and touch MMIO. */
EXPORT u64 vm_x86_direct_memory_store_if(
        u32 machine, u64 address, u64 value, u64 offset, u64 shape,
        u32 predicate, u32 block, u32 slot)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_memory_result = 0u;
    u32 width = (u32)shape & 0xffu;
    u32 scale = (u32)(shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
              & PL_MEMORY_SHAPE_SCALE_MASK;
    if ((width != 1u && width != 2u && width != 4u && width != 8u)
            || scale || !(shape & PL_MEMORY_SHAPE_VIRTUAL64)
            || (shape & ~(u64)PL_MEMORY_SHAPE_MASK)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u64 replay = 0u;
    int admitted = x86_direct_memory_enter(x86, block, slot, &replay);
    if (admitted != X86_DIRECT_MEMORY_EXECUTE)
        return admitted == X86_DIRECT_MEMORY_REPLAY ? replay : 0u;
    if (!predicate) return x86_direct_memory_finish(x86, slot, 0u);
    if (offset > ~0ull - address
            || address + offset > ~0ull - (width - 1u)) {
        x86_direct_page_fault(x86, address, 1, 0, 0);
        return 0u;
    }
    u64 effective = address + offset;
    u8 bytes[8];
    for (u32 index = 0u; index < width; ++index)
        bytes[index] = (u8)(value >> (index * 8u));
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    int status = x86_virtual_write(effective, bytes, width, user);
    if (!status) {
        x86->direct_memory_result = pl_vm_result_make(
            PL_VM_BARRIER, x86->physical_status);
        return 0u;
    }
    if (status < 0) {
        x86_direct_page_fault(x86, effective, 1, 0, status == -2);
        return 0u;
    }
    return x86_direct_memory_finish(x86, slot, 0u);
}

/* FS/GS bases are architectural inputs to ordinary long-mode addressing.
 * They remain in the canonical MSR bank; emitted blocks read the coordinate
 * directly instead of materializing a scalar setup STEP for every access. */
EXPORT u64 vm_x86_direct_segment_base(u32 machine, u32 segment)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural || segment > 1u
            || !x86->active || !x86->executable_published)
        return 0u;
    return x86_msr_read(0xc0000100u + segment);
}

/* WRMSR is a typed architectural cut imported by compiler-emitted Wasm.  It
 * mutates only the canonical MSR bank; the block function owns RIP, counters
 * and its static successor, so this is not an instruction dispatcher. */
EXPORT int vm_x86_direct_write_msr(u32 machine, u64 key, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || key > 0xffffffffu || (x86->system[X86_SYS_CS] & 3u))
        return 0;
    return x86_msr_write(key, value);
}

EXPORT int vm_x86_direct_read_msr(u32 machine, u64 key, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || reserved || key > 0xffffffffu
            || (x86->system[X86_SYS_CS] & 3u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u64 value = x86_msr_read(key);
    x86->registers[X86_RAX] = (u32)value;
    x86->registers[X86_RDX] = (u32)(value >> 32u);
    return 1;
}

EXPORT int vm_x86_direct_cpuid(u32 machine, u64 reserved0, u64 reserved1)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || reserved0 || reserved1) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    u32 eax, ebx, ecx, edx;
    x86_cpuid_model((u32)x86->registers[X86_RAX],
                    (u32)x86->registers[X86_RCX],
                    &eax, &ebx, &ecx, &edx);
    x86->registers[X86_RAX] = eax;
    x86->registers[X86_RBX] = ebx;
    x86->registers[X86_RCX] = ecx;
    x86->registers[X86_RDX] = edx;
    return 1;
}

EXPORT int vm_x86_direct_interrupt_flag(
        u32 machine, u64 enable, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || reserved || enable > 1u) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    u32 iopl = (u32)(x86->rflags >> 12u) & 3u;
    if (cpl > iopl) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if (enable) {
        x86->rflags |= 1u << 9u;
        /* The runner consumes one count for STI itself and one for its
         * compiler-proved singleton successor. */
        x86->interrupt_shadow = 2u;
    } else {
        x86->rflags &= ~(1u << 9u);
        x86->interrupt_shadow = 0u;
    }
    x86->rflags |= 2u;
    return 1;
}

EXPORT int vm_x86_direct_time(u32 machine, u64 descriptor, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || descriptor > 2u || reserved) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (descriptor == 2u) {
        if (!(x86->cr4 & (1u << 8u))
                && (x86->system[X86_SYS_CS] & 3u)) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        /* This immutable CPU contract publishes no CPUID.0AH counters.
         * Therefore every ECX counter coordinate is out of range and has
         * the one architectural #GP residual instead of a host PMU path. */
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if ((x86->cr4 & (1u << 2u)) && (x86->system[X86_SYS_CS] & 3u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u64 value = x86_msr_read(0x10u);
    x86->registers[X86_RAX] = (u32)value;
    x86->registers[X86_RDX] = (u32)(value >> 32u);
    if (descriptor) x86->registers[X86_RCX] =
        (u32)x86_msr_read(0xc0000103u);
    return 1;
}

EXPORT int vm_x86_direct_entropy(
        u32 machine, u64 wide_descriptor, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    u32 descriptor = (u32)wide_descriptor;
    u32 reg = descriptor & 0xffu;
    u32 bits = (descriptor >> 8u) & 0xffu;
    u32 source = (descriptor >> 16u) & 1u;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || reserved
            || wide_descriptor != descriptor
            || reg >= X86_REGISTER_COUNT
            || (bits != 16u && bits != 32u && bits != 64u)
            || descriptor != (reg | (bits << 8u) | (source << 16u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (x86->entropy_direct_ready) {
        if (x86->entropy_direct_descriptor != descriptor) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        x86->entropy_direct_ready = 0u;
        x86->entropy_direct_descriptor = 0u;
        return 1;
    }
    if (x86->entropy_status || x86->entropy_direct_request) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    x86->entropy_lease = step_new_capability();
    if (!x86->entropy_lease) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    x86->control_argument[1] = descriptor;
    x86->entropy_direct_descriptor = descriptor;
    x86->entropy_direct_request = 1u;
    x86->entropy_status = X86_ENTROPY;
    x86->direct_memory_result = pl_vm_result_make(
        PL_VM_BARRIER, X86_ENTROPY);
    return 0;
}

static u64 x86_descriptor_base(const u8 descriptor[8]);
static int x86_direct_descriptor_probe(X86Workspace *x86, u32 selector,
                                       u8 descriptor[8]);
static int x86_direct_descriptor(X86Workspace *x86, u32 selector,
                                 u8 descriptor[8]);
static int x86_direct_read(X86Workspace *x86, u64 address, u8 *target,
                           u32 bytes, int user);
static int x86_tss_stack(u32 selector, u32 ist, u64 *pointer);

static int x86_direct_access_ready(X86Workspace *x86, u64 address,
                                   u32 bytes, int write, int user)
{
    while (bytes) {
        u64 physical_page = 0u;
        int translated = x86_translate_page(
            address >> 12u, write, 0, user, &physical_page);
        if (!translated || (translated > 0
                && !x86_physical_present(physical_page))) {
            x86->direct_memory_result = pl_vm_result_make(
                PL_VM_BARRIER, x86->physical_status);
            return 0;
        }
        if (translated < 0) {
            x86_direct_page_fault(x86, address, write, 0, translated == -2);
            return 0;
        }
        u32 part = X86_PHYSICAL_PAGE_BYTES
                 - ((u32)address & (X86_PHYSICAL_PAGE_BYTES - 1u));
        if (part > bytes) part = bytes;
        address += part;
        bytes -= part;
    }
    return 1;
}

static int x86_direct_string_segment_base(X86Workspace *x86, u32 segment,
                                          u64 *base)
{
    if (segment > 5u) return 0;
    if (x86->efer & (1u << 10u)) {
        *base = segment == 4u ? x86_msr_read(0xc0000100u)
              : segment == 5u ? x86_msr_read(0xc0000101u) : 0u;
        return 1;
    }
    u32 selector = (u32)x86->system[X86_SYS_ES + segment] & 0xffffu;
    if (!(x86->cr0 & 1u)) {
        *base = (u64)selector << 4u;
        return 1;
    }
    if (!(selector & 0xfff8u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u8 descriptor[8];
    if (!x86_direct_descriptor(x86, selector, descriptor)) return 0;
    if (!(descriptor[5] & 0x10u) || !(descriptor[5] & 0x80u)) {
        x86_direct_exception(
            x86, descriptor[5] & 0x10u ? 11u : 13u,
            1u, selector & 0xfffcu);
        return 0;
    }
    *base = x86_descriptor_base(descriptor);
    return 1;
}

/* A repeated string instruction is one restartable architectural
 * transaction.  Registers name the residual cut: after every completed
 * element its indices and RCX are published, so a cold page or precise fault
 * resumes only the untouched suffix. */
EXPORT int vm_x86_direct_string(
        u32 machine, u64 descriptor, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    u32 width = (u32)descriptor & 0xffu;
    u32 address_bits = (u32)(descriptor >> 8u) & 0xffu;
    u32 source_segment = (u32)(descriptor >> 16u) & 0xffu;
    u32 kind = (u32)(descriptor >> 24u) & 7u;
    u32 not_equal = (u32)(descriptor >> 27u) & 1u;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || reserved
            || (width != 1u && width != 2u && width != 4u && width != 8u)
            || (address_bits != 32u && address_bits != 64u)
            || source_segment > 5u
            || (kind != 0u && kind != 2u && kind != 3u && kind != 4u)
            || (kind == 4u && source_segment)
            || (not_equal && kind != 3u && kind != 4u)
            || descriptor != (width | ((u64)address_bits << 8u)
                | ((u64)source_segment << 16u) | ((u64)kind << 24u)
                | ((u64)not_equal << 27u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u64 source_base = 0u, target_base = 0u;
    int uses_source = kind != 4u;
    int uses_target = kind != 2u;
    if ((uses_source && !x86_direct_string_segment_base(
                x86, source_segment, &source_base))
            || (uses_target && !x86_direct_string_segment_base(
                x86, 0u, &target_base)))
        return 0;
    u64 mask = address_bits == 32u ? 0xffffffffu : ~0ull;
    u64 lane_mask = width == 8u ? ~0ull
                  : (1ull << (width * 8u)) - 1u;
    u64 count = x86->registers[X86_RCX] & mask;
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    int descending = (x86->rflags & (1u << 10u)) != 0u;
    while (count) {
        u64 source_pointer = x86->registers[X86_RSI] & mask;
        u64 target_pointer = x86->registers[X86_RDI] & mask;
        u64 source = source_base + source_pointer;
        u64 target = target_base + target_pointer;
        if ((uses_source && source < source_base)
                || (uses_target && target < target_base)) {
            int target_fault = uses_target && target < target_base;
            x86_direct_page_fault(
                x86, target_fault ? target : source, target_fault, 0, 0);
            return 0;
        }
        if ((uses_source
                && !x86_direct_access_ready(x86, source, width, 0, user))
                || (uses_target && !x86_direct_access_ready(
                    x86, target, width, kind == 0u, user)))
            return 0;
        u8 source_bytes[8], target_bytes[8];
        if ((uses_source && x86_virtual_read_access(
                    source, source_bytes, width, user) != 1)
                || (uses_target && kind != 0u
                    && x86_virtual_read_access(
                        target, target_bytes, width, user) != 1)
                || (kind == 0u && x86_virtual_write(
                    target, source_bytes, width, user) != 1)) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        u64 left = 0u, right = 0u;
        for (u32 byte = 0u; byte < width; ++byte) {
            if (uses_source) left |= (u64)source_bytes[byte] << (byte * 8u);
            if (uses_target && kind != 0u)
                right |= (u64)target_bytes[byte] << (byte * 8u);
        }
        if (kind == 2u) {
            if (width == 4u) x86->registers[X86_RAX] = (u32)left;
            else if (width == 8u) x86->registers[X86_RAX] = left;
            else x86->registers[X86_RAX] =
                (x86->registers[X86_RAX] & ~lane_mask) | left;
        } else if (kind == 3u || kind == 4u) {
            if (kind == 4u) {
                left = x86->registers[X86_RAX] & lane_mask;
            }
            u64 difference = (left - right) & lane_mask;
            if (!step_x86_flags_value(
                    x86->rflags, left, right, difference,
                    width * 8u | (3u << 8u), &x86->rflags)) {
                x86_direct_memory_abort(x86, 0xffu);
                return 0;
            }
        }
        u64 next_source = descending ? source_pointer - width
                                     : source_pointer + width;
        u64 next_target = descending ? target_pointer - width
                                     : target_pointer + width;
        --count;
        if (address_bits == 32u) {
            if (uses_source) x86->registers[X86_RSI] = (u32)next_source;
            if (uses_target) x86->registers[X86_RDI] = (u32)next_target;
            x86->registers[X86_RCX] = (u32)count;
        } else {
            if (uses_source) x86->registers[X86_RSI] = next_source;
            if (uses_target) x86->registers[X86_RDI] = next_target;
            x86->registers[X86_RCX] = count;
        }
        if ((kind == 3u || kind == 4u)
                && (((x86->rflags >> 6u) & 1u) == not_equal))
            break;
    }
    return 1;
}

/* WebAssembly executes these calls in program order.  The virtual CPU has no
 * incoherent host data cache to flush, so fence/cache instructions publish a
 * typed ordering cut after reproducing their architectural privilege and
 * address-translation checks. */
EXPORT int vm_x86_direct_memory_order(
        u32 machine, u64 address, u64 descriptor)
{
    X86Workspace *x86 = x86_machine();
    u32 kind = (u32)descriptor;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || descriptor != kind || kind > 7u
            || ((kind != 4u && kind != 7u) && address)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if ((kind == 2u || kind == 3u)
            && (x86->system[X86_SYS_CS] & 3u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if (kind == 4u || kind == 7u) {
        u8 observed;
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        if (!x86_direct_read(x86, address, &observed, 1u, user)) return 0;
    }
    return 1;
}

EXPORT int vm_x86_direct_port_io(u32 machine, u64 descriptor, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    u32 width = (u32)descriptor & 0xffu;
    u32 write = (u32)(descriptor >> 8u) & 1u;
    u32 dynamic = (u32)(descriptor >> 9u) & 1u;
    u32 string = (u32)(descriptor >> 10u) & 1u;
    u32 repeat = (u32)(descriptor >> 11u) & 1u;
    u32 encoded_port = (u32)(descriptor >> 16u) & 0xffffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || reserved
            || (width != 1u && width != 2u && width != 4u)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    u32 address_width = 0u;
    u32 segment = 0u;
    if (string) {
        address_width = encoded_port & 0xffu;
        segment = encoded_port >> 8u;
        if (!dynamic || (address_width != 16u && address_width != 32u
                    && address_width != 64u) || segment > 5u
                || descriptor != (width | ((u64)write << 8u)
                    | (1ull << 9u) | (1ull << 10u)
                    | ((u64)repeat << 11u)
                    | ((u64)address_width << 16u)
                    | ((u64)segment << 24u))) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
    } else if (repeat || descriptor != (width | ((u64)write << 8u)
            | ((u64)dynamic << 9u) | ((u64)encoded_port << 16u))
            || (dynamic && encoded_port)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    u32 iopl = (u32)(x86->rflags >> 12u) & 3u;
    if (cpl > iopl) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u32 port = dynamic ? (u32)x86->registers[X86_RDX] & 0xffffu
                       : encoded_port;
    u64 mask = width == 1u ? 0xffu
             : width == 2u ? 0xffffu : 0xffffffffu;
    if (string) {
        u64 address_mask = address_width == 16u ? 0xffffu
                         : address_width == 32u ? 0xffffffffu : ~0ull;
        u64 count = repeat ? x86->registers[X86_RCX] & address_mask : 1u;
        if (!count) return 1;
        u32 index = write ? X86_RSI : X86_RDI;
        u64 segment_base = 0u;
        if (!x86_direct_string_segment_base(x86, segment, &segment_base))
            return 0;
        int user = cpl != 0u;
        while (count) {
            u64 pointer = x86->registers[index] & address_mask;
            u64 address = segment_base + pointer;
            if (address < segment_base) {
                x86_direct_page_fault(x86, address, !write, 0, 0);
                return 0;
            }
            if (!x86_direct_access_ready(
                    x86, address, width, !write, user)) return 0;
            u8 bytes[4] = { 0u, 0u, 0u, 0u };
            if (write) {
                int loaded = x86_virtual_read_access(
                    address, bytes, width, user);
                if (loaded != 1) {
                    x86_direct_memory_abort(x86, 0xffu);
                    return 0;
                }
                u64 value = (u64)bytes[0]
                          | ((u64)bytes[1] << 8u)
                          | ((u64)bytes[2] << 16u)
                          | ((u64)bytes[3] << 24u);
                if (!x86_port_write(port, width, value & mask)) {
                    if (x86->console_status)
                        x86->direct_memory_result = pl_vm_result_make(
                            PL_VM_BARRIER, x86->console_status);
                    else
                        x86_direct_memory_abort(x86, 0xffu);
                    return 0;
                }
            } else {
                u64 value = x86_port_read(port, width) & mask;
                for (u32 byte = 0u; byte < width; ++byte)
                    bytes[byte] = (u8)(value >> (byte * 8u));
                int stored = x86_virtual_write(address, bytes, width, user);
                if (stored != 1) {
                    x86_direct_memory_abort(x86, 0xffu);
                    return 0;
                }
            }
            u64 next = x86->rflags & (1u << 10u)
                     ? pointer - width : pointer + width;
            if (address_width == 16u)
                x86->registers[index] = (x86->registers[index] & ~0xffffull)
                                      | (next & 0xffffu);
            else if (address_width == 32u)
                x86->registers[index] = (u32)next;
            else
                x86->registers[index] = next;
            count -= 1u;
            if (repeat) {
                if (address_width == 16u)
                    x86->registers[X86_RCX] =
                        (x86->registers[X86_RCX] & ~0xffffull)
                        | (count & 0xffffu);
                else if (address_width == 32u)
                    x86->registers[X86_RCX] = (u32)count;
                else
                    x86->registers[X86_RCX] = count;
            }
            if (x86->console_status && count && repeat) {
                x86->direct_memory_result = pl_vm_result_make(
                    PL_VM_BARRIER, x86->console_status);
                return 0;
            }
        }
        return 1;
    }
    if (!write) {
        u64 value = x86_port_read(port, width) & mask;
        x86->registers[X86_RAX] = width == 4u ? value
            : (x86->registers[X86_RAX] & ~mask) | value;
        return 1;
    }
    if (!x86_port_write(port, width, x86->registers[X86_RAX] & mask)) {
        if (x86->console_status)
            x86->direct_memory_result = pl_vm_result_make(
                PL_VM_BARRIER, x86->console_status);
        else
            x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    return 1;
}

static u64 x86_direct_gpr_lane(X86Workspace *x86, u32 reg,
                               u32 width, u32 high8)
{
    u32 shift = high8 ? 8u : 0u;
    u64 mask = width == 8u ? ~0ull : (1ull << (width * 8u)) - 1u;
    return (x86->registers[reg] >> shift) & mask;
}

static void x86_direct_set_gpr_lane(X86Workspace *x86, u32 reg,
                                    u32 width, u32 high8, u64 value)
{
    u32 shift = high8 ? 8u : 0u;
    u64 mask = width == 8u ? ~0ull : (1ull << (width * 8u)) - 1u;
    value &= mask;
    if (width == 4u && !high8) x86->registers[reg] = (u32)value;
    else if (width == 8u) x86->registers[reg] = value;
    else x86->registers[reg] = (x86->registers[reg] & ~(mask << shift))
                              | (value << shift);
}

/* Every admitted atomic instruction is one physical memory transaction.  The
 * worker owns the guest machine, so preflighting every touched page followed
 * by one synchronous C publication is the indivisible machine cut; no JS lock
 * or scalar instruction replay exists outside vm.wasm. */
EXPORT int vm_x86_direct_atomic(u32 machine, u64 address, u64 descriptor)
{
    X86Workspace *x86 = x86_machine();
    u32 kind = (u32)descriptor & 0xffu;
    u32 width = (u32)(descriptor >> 8u) & 0xffu;
    u32 reg = (u32)(descriptor >> 16u) & 0xffu;
    u32 high8 = (u32)(descriptor >> 24u) & 1u;
    u32 immediate = (u32)(descriptor >> 25u) & 1u;
    u32 literal = (u32)(descriptor >> 32u);
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || kind > 16u
            || (width != 1u && width != 2u && width != 4u
                && width != 8u && width != 16u)
            || (kind >= 14u
                ? ((width != 2u && width != 4u && width != 8u)
                   || reg >= X86_REGISTER_COUNT || high8 || immediate
                   || literal)
              : kind == 3u
                ? (width != 16u || reg || high8 || immediate || literal)
                : kind == 13u
                  ? (width != 8u || reg || high8 || immediate || literal)
                : kind >= 11u
                  ? (width == 16u || reg || high8 || immediate || literal)
                  : immediate
                    ? (kind < 4u || kind > 10u || width == 16u
                       || reg || high8)
                    : (width == 16u || reg >= X86_REGISTER_COUNT
                       || literal
                       || (high8 && (width != 1u || reg > 3u))))
            || descriptor != (kind | ((u64)width << 8u)
                | ((u64)reg << 16u) | ((u64)high8 << 24u)
                | ((u64)immediate << 25u) | ((u64)literal << 32u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u32 bit = 0u;
    if (kind >= 14u) {
        u32 bit_width = width * 8u;
        i64 index = width == 8u ? (i64)x86->registers[reg]
                  : width == 4u ? (i64)(i32)x86->registers[reg]
                                : (i64)(signed short)x86->registers[reg];
        i64 element = index >= 0 ? index / (i64)bit_width
                    : -((-index + (i64)bit_width - 1) / (i64)bit_width);
        address += (u64)(element * (i64)width);
        bit = (u32)index & (bit_width - 1u);
    }
    if (kind == 3u && (address & 15u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    if (!x86_direct_access_ready(x86, address, width, 1, user)) return 0;
    u8 bytes[16];
    int loaded = x86_virtual_read_access(address, bytes, width, user);
    if (loaded != 1) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (kind == 3u) {
        u64 low = load_u64(bytes);
        u64 high = load_u64(bytes + 8u);
        int equal = low == x86->registers[X86_RAX]
                 && high == x86->registers[X86_RDX];
        x86->rflags = (x86->rflags & ~(1u << 6u))
                    | ((u64)equal << 6u) | 2u;
        if (equal) {
            store_u64(bytes, x86->registers[X86_RBX]);
            store_u64(bytes + 8u, x86->registers[X86_RCX]);
        } else {
            x86->registers[X86_RAX] = low;
            x86->registers[X86_RDX] = high;
        }
        if (x86_virtual_write(address, bytes, width, user) != 1) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        return 1;
    }

    if (kind == 13u) {
        u64 old = load_u64(bytes);
        u64 expected = (u32)x86->registers[X86_RAX]
                     | ((u64)(u32)x86->registers[X86_RDX] << 32u);
        int equal = old == expected;
        x86->rflags = (x86->rflags & ~(1u << 6u))
                    | ((u64)equal << 6u) | 2u;
        if (equal) {
            u64 replacement = (u32)x86->registers[X86_RBX]
                            | ((u64)(u32)x86->registers[X86_RCX] << 32u);
            store_u64(bytes, replacement);
        } else {
            x86->registers[X86_RAX] = (u32)old;
            x86->registers[X86_RDX] = (u32)(old >> 32u);
        }
        if (x86_virtual_write(address, bytes, width, user) != 1) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        return 1;
    }

    u64 old = 0u;
    for (u32 byte = 0u; byte < width; ++byte)
        old |= (u64)bytes[byte] << (byte * 8u);
    u64 source = kind >= 11u && kind <= 12u ? 1u
               : immediate ? (width == 8u
                              ? (u64)(i64)(i32)literal : (u64)literal)
               : x86_direct_gpr_lane(x86, reg, width, high8);
    u64 mask = width == 8u ? ~0ull : (1ull << (width * 8u)) - 1u;
    u64 stored = source;
    if (kind >= 14u) {
        u64 bit_mask = 1ull << bit;
        u64 prior = (old >> bit) & 1u;
        stored = kind == 14u ? old | bit_mask
               : kind == 15u ? old & ~bit_mask : old ^ bit_mask;
        x86->rflags = (x86->rflags & ~1ull) | prior | 2u;
    } else if (kind == 0u) {
        x86_direct_set_gpr_lane(x86, reg, width, high8, old);
    } else if (kind == 1u) {
        stored = (old + source) & mask;
        x86_direct_set_gpr_lane(x86, reg, width, high8, old);
        if (!step_x86_flags_value(
                x86->rflags, old, source, stored,
                width * 8u | (1u << 8u), &x86->rflags)) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
    } else if (kind == 2u) {
        u64 accumulator = x86_direct_gpr_lane(x86, X86_RAX, width, 0u);
        u64 difference = (accumulator - old) & mask;
        if (!step_x86_flags_value(
                x86->rflags, accumulator, old, difference,
                width * 8u | (3u << 8u), &x86->rflags)) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        if (accumulator == old) stored = source;
        else {
            stored = old; /* failed CMPXCHG still owns write permission */
            x86_direct_set_gpr_lane(x86, X86_RAX, width, 0u, old);
        }
    } else {
        u32 mode = 0u;
        u64 right = source;
        u64 prior_carry = x86->rflags & 1u;
        if (kind == 4u || kind == 6u || kind == 11u) {
            mode = kind == 4u ? 1u : 2u;
            if (kind == 11u) mode = 1u;
            stored = (old + source + (kind == 6u ? prior_carry : 0u))
                   & mask;
        } else if (kind == 9u || kind == 7u || kind == 12u) {
            mode = kind == 9u ? 3u : 4u;
            if (kind == 12u) mode = 3u;
            stored = (old - source - (kind == 7u ? prior_carry : 0u))
                   & mask;
        } else if (kind == 5u) {
            stored = old | source;
        } else if (kind == 8u) {
            stored = old & source;
        } else {
            stored = old ^ source;
        }
        if (!step_x86_flags_value(
                x86->rflags, old, right, stored,
                width * 8u | (mode << 8u), &x86->rflags)) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        if (kind >= 11u)
            x86->rflags = (x86->rflags & ~1ull) | prior_carry;
    }
    for (u32 byte = 0u; byte < width; ++byte)
        bytes[byte] = (u8)(stored >> (byte * 8u));
    if (x86_virtual_write(address, bytes, width, user) != 1) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    return 1;
}

static u32 x86_vector_lane32(u64 low, u64 high, u32 lane)
{
    return lane < 2u ? (u32)(low >> (lane * 32u))
                     : (u32)(high >> ((lane - 2u) * 32u));
}

static u64 x86_packed_interleave_bytes4(
        u64 left, u64 right, u32 first)
{
    u64 result = 0u;
    for (u32 lane = 0u; lane < 4u; ++lane) {
        u32 shift = (first + lane) * 8u;
        result |= ((left >> shift) & 0xffu) << (lane * 16u);
        result |= ((right >> shift) & 0xffu) << (lane * 16u + 8u);
    }
    return result;
}

static u64 x86_packed_interleave_words2(
        u64 left, u64 right, u32 first)
{
    u64 result = 0u;
    for (u32 lane = 0u; lane < 2u; ++lane) {
        u32 shift = (first + lane) * 16u;
        result |= ((left >> shift) & 0xffffu) << (lane * 32u);
        result |= ((right >> shift) & 0xffffu) << (lane * 32u + 16u);
    }
    return result;
}

/* Operations 9..49 are one shared 64-bit packed-lane quotient.  MMX uses it
 * once; XMM uses it independently for both physical u64 lanes except for the
 * unpack shapes that explicitly cross those two lanes. */
static u64 x86_packed_extended64(u64 left, u64 right, u32 operation)
{
    if (operation == 9u) {
        u32 sum = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 l = (u32)(left >> (lane * 8u)) & 0xffu;
            u32 r = (u32)(right >> (lane * 8u)) & 0xffu;
            sum += l > r ? l - r : r - l;
        }
        return sum;
    }
    if (operation == 10u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            u32 value = ((u32)(left >> shift)
                       - (u32)(right >> shift)) & 0xffu;
            result |= (u64)value << shift;
        }
        return result;
    }
    if (operation == 11u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 l = (u32)(left >> shift) & 0xffffu;
            u32 r = (u32)(right >> shift) & 0xffffu;
            i32 signed_l = (l & 0x8000u) ? (i32)l - 0x10000 : (i32)l;
            i32 signed_r = (r & 0x8000u) ? (i32)r - 0x10000 : (i32)r;
            if (signed_l > signed_r) result |= 0xffffull << shift;
        }
        return result;
    }
    if (operation == 12u) return ~left & right;
    if (operation == 13u)
        return x86_packed_interleave_bytes4(left, right, 4u);
    if (operation == 14u) {
        u64 result = 0u;
        for (u32 pair = 0u; pair < 2u; ++pair) {
            i64 sum = 0;
            for (u32 lane = 0u; lane < 2u; ++lane) {
                u32 shift = (pair * 2u + lane) * 16u;
                u32 l = (u32)(left >> shift) & 0xffffu;
                u32 r = (u32)(right >> shift) & 0xffffu;
                i32 signed_l = (l & 0x8000u)
                             ? (i32)l - 0x10000 : (i32)l;
                i32 signed_r = (r & 0x8000u)
                             ? (i32)r - 0x10000 : (i32)r;
                sum += (i64)signed_l * signed_r;
            }
            result |= (u64)(u32)sum << (pair * 32u);
        }
        return result;
    }
    if (operation == 15u) return left + right;
    if (operation == 16u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 l = (u32)(left >> shift) & 0xffffu;
            u32 r = (u32)(right >> shift) & 0xffffu;
            result |= (u64)((l * r) >> 16u) << shift;
        }
        return result;
    }
    if (operation == 17u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 l = (u32)(left >> shift) & 0xffffu;
            u32 r = (u32)(right >> shift) & 0xffffu;
            i32 signed_l = (l & 0x8000u) ? (i32)l - 0x10000 : (i32)l;
            i32 signed_r = (r & 0x8000u) ? (i32)r - 0x10000 : (i32)r;
            result |= (u64)(signed_l < signed_r ? l : r) << shift;
        }
        return result;
    }
    if (operation == 20u)
        return x86_packed_interleave_words2(left, right, 2u);
    if (operation == 21u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 value = ((u32)(left >> shift)
                       - (u32)(right >> shift)) & 0xffffu;
            result |= (u64)value << shift;
        }
        return result;
    }
    if (operation == 23u)
        return (u64)(u32)left * (u32)right;
    if (operation == 24u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            u32 l = (u32)(left >> shift) & 0xffu;
            u32 r = (u32)(right >> shift) & 0xffu;
            i32 signed_l = (l & 0x80u) ? (i32)l - 0x100 : (i32)l;
            i32 signed_r = (r & 0x80u) ? (i32)r - 0x100 : (i32)r;
            if (signed_l > signed_r) result |= 0xffull << shift;
        }
        return result;
    }
    if (operation == 25u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            i32 l = (i32)((u32)(left >> shift) & 0xffffu);
            i32 r = (i32)((u32)(right >> shift) & 0xffffu);
            if (l & 0x8000) l -= 0x10000;
            if (r & 0x8000) r -= 0x10000;
            u32 product = (u32)(l * r);
            result |= (u64)((product >> 16u) & 0xffffu) << shift;
        }
        return result;
    }
    if (operation == 26u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u64 source = lane < 4u ? left : right;
            u32 shift = (lane & 3u) * 16u;
            i32 value = (i32)((u32)(source >> shift) & 0xffffu);
            if (value & 0x8000) value -= 0x10000;
            u32 saturated = value < 0 ? 0u : value > 255 ? 255u : (u32)value;
            result |= (u64)saturated << (lane * 8u);
        }
        return result;
    }
    if (operation == 27u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            i32 l = (i32)((u32)(left >> shift) & 0xffffu);
            i32 r = (i32)((u32)(right >> shift) & 0xffffu);
            if (l & 0x8000) l -= 0x10000;
            if (r & 0x8000) r -= 0x10000;
            i32 sum = l + r;
            u32 saturated = sum < -0x8000 ? 0x8000u
                          : sum > 0x7fff ? 0x7fffu
                          : (u32)sum & 0xffffu;
            result |= (u64)saturated << shift;
        }
        return result;
    }
    if (operation == 28u) {
        if (right > 15u) return 0u;
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 value = ((u32)(left >> shift) << (u32)right) & 0xffffu;
            result |= (u64)value << shift;
        }
        return result;
    }
    if (operation == 29u)
        return x86_packed_interleave_words2(left, right, 0u);
    if (operation == 30u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            i32 l = (i32)((u32)(left >> shift) & 0xffffu);
            i32 r = (i32)((u32)(right >> shift) & 0xffffu);
            if (l & 0x8000) l -= 0x10000;
            if (r & 0x8000) r -= 0x10000;
            result |= ((u64)(u32)(l > r ? l : r) & 0xffffu) << shift;
        }
        return result;
    }
    if (operation == 31u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            u32 l = (u32)(left >> shift) & 0xffu;
            u32 r = (u32)(right >> shift) & 0xffu;
            result |= (u64)(l > r ? l - r : 0u) << shift;
        }
        return result;
    }
    if (operation == 32u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            u32 sum = ((u32)(left >> shift) & 0xffu)
                    + ((u32)(right >> shift) & 0xffu);
            result |= (u64)(sum > 0xffu ? 0xffu : sum) << shift;
        }
        return result;
    }
    if (operation == 33u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            u32 average = (((u32)(left >> shift) & 0xffu)
                         + ((u32)(right >> shift) & 0xffu) + 1u) >> 1u;
            result |= (u64)average << shift;
        }
        return result;
    }
    if (operation == 34u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 average = (((u32)(left >> shift) & 0xffffu)
                         + ((u32)(right >> shift) & 0xffffu) + 1u) >> 1u;
            result |= (u64)average << shift;
        }
        return result;
    }
    if (operation == 35u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            u32 l = (u32)(left >> shift) & 0xffu;
            u32 r = (u32)(right >> shift) & 0xffu;
            result |= (u64)(l > r ? l : r) << shift;
        }
        return result;
    }
    if (operation == 36u) {
        u32 count = right > 31u ? 31u : (u32)right;
        u32 low = (u32)((i32)(u32)left >> count);
        u32 high = (u32)((i32)(u32)(left >> 32u) >> count);
        return low | ((u64)high << 32u);
    }
    if (operation == 38u)
        return (left >> 32u) | (right & 0xffffffff00000000ull);
    if (operation == 39u)
        return x86_packed_interleave_bytes4(left, right, 0u);
    if (operation == 40u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u64 source = lane < 2u ? left : right;
            u32 shift = (lane & 1u) * 32u;
            i32 value = (i32)(u32)(source >> shift);
            u32 saturated = value < -0x8000 ? 0x8000u
                          : value > 0x7fff ? 0x7fffu
                          : (u32)value & 0xffffu;
            result |= (u64)saturated << (lane * 16u);
        }
        return result;
    }
    if (operation == 41u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            i32 l = (i32)((u32)(left >> shift) & 0xffu);
            i32 r = (i32)((u32)(right >> shift) & 0xffu);
            if (l & 0x80) l -= 0x100;
            if (r & 0x80) r -= 0x100;
            i32 sum = l + r;
            u32 saturated = sum < -0x80 ? 0x80u
                          : sum > 0x7f ? 0x7fu
                          : (u32)sum & 0xffu;
            result |= (u64)saturated << shift;
        }
        return result;
    }
    if (operation == 42u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 sum = ((u32)(left >> shift) & 0xffffu)
                    + ((u32)(right >> shift) & 0xffffu);
            result |= (u64)(sum > 0xffffu ? 0xffffu : sum) << shift;
        }
        return result;
    }
    if (operation == 43u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u32 shift = lane * 8u;
            u32 l = (u32)(left >> shift) & 0xffu;
            u32 r = (u32)(right >> shift) & 0xffu;
            result |= (u64)(l < r ? l : r) << shift;
        }
        return result;
    }
    if (operation == 44u) {
        u32 count = right > 15u ? 15u : (u32)right;
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            i32 value = (i32)((u32)(left >> shift) & 0xffffu);
            if (value & 0x8000) value -= 0x10000;
            result |= ((u64)(u32)(value >> count) & 0xffffu) << shift;
        }
        return result;
    }
    if (operation == 45u) {
        if (right > 15u) return 0u;
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 value = ((u32)(left >> shift) & 0xffffu) >> (u32)right;
            result |= (u64)value << shift;
        }
        return result;
    }
    if (operation == 46u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane) {
            u64 source = lane < 4u ? left : right;
            u32 shift = (lane & 3u) * 16u;
            i32 value = (i32)((u32)(source >> shift) & 0xffffu);
            if (value & 0x8000) value -= 0x10000;
            u32 saturated = value < -0x80 ? 0x80u
                          : value > 0x7f ? 0x7fu
                          : (u32)value & 0xffu;
            result |= (u64)saturated << (lane * 8u);
        }
        return result;
    }
    if (operation == 47u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 l = (u32)(left >> shift) & 0xffffu;
            u32 r = (u32)(right >> shift) & 0xffffu;
            result |= (u64)(l > r ? l - r : 0u) << shift;
        }
        return result;
    }
    if (operation == 48u) {
        u64 differences = left ^ right;
        u64 zero_high = ~(differences
            | ((differences & 0x7f7f7f7f7f7f7f7full)
               + 0x7f7f7f7f7f7f7f7full))
            & 0x8080808080808080ull;
        return (zero_high >> 7u) * 0xffu;
    }
    if (operation == 49u) {
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 shift = lane * 16u;
            u32 product = ((u32)(left >> shift) & 0xffffu)
                        * ((u32)(right >> shift) & 0xffffu);
            result |= (u64)(product & 0xffffu) << shift;
        }
        return result;
    }
    return (left & 0xffffffffull) | ((right & 0xffffffffull) << 32u);
}

static u32 x86_signed32_to_float32(i32 value, u32 rounding, u32 *exceptions)
{
    u32 raw = (u32)value;
    u32 sign = raw >> 31u;
    u32 magnitude = sign ? 0u - raw : raw;
    if (!magnitude) return 0u;
    u32 most = 31u - (u32)__builtin_clz(magnitude);
    u32 exponent = most + 127u;
    u32 retained;
    if (most <= 23u) {
        retained = magnitude << (23u - most);
    } else {
        u32 shift = most - 23u;
        u32 mask = (1u << shift) - 1u;
        u32 remainder = magnitude & mask;
        retained = magnitude >> shift;
        if (remainder) {
            *exceptions |= 1u << 5u;
            int increment = 0;
            if (!rounding) {
                u32 half = 1u << (shift - 1u);
                increment = remainder > half
                         || (remainder == half && (retained & 1u));
            } else if (rounding == 1u) increment = sign != 0u;
            else if (rounding == 2u) increment = sign == 0u;
            if (increment && ++retained == (1u << 24u)) {
                retained >>= 1u;
                ++exponent;
            }
        }
    }
    return (sign << 31u) | (exponent << 23u)
         | (retained & 0x7fffffu);
}

static u64 x86_float32_to_float64(
        u32 raw, int denormals_are_zero, u32 *exceptions)
{
    u64 sign = (u64)(raw >> 31u) << 63u;
    u32 exponent = (raw >> 23u) & 0xffu;
    u32 fraction = raw & 0x7fffffu;
    if (exponent == 0xffu) {
        if (!fraction) return sign | (0x7ffull << 52u);
        if (!(fraction & (1u << 22u))) *exceptions |= 1u;
        return sign | (0x7ffull << 52u)
             | ((u64)fraction << 29u) | (1ull << 51u);
    }
    if (!exponent) {
        if (!fraction || denormals_are_zero) return sign;
        *exceptions |= 1u << 1u;
        u32 most = 31u - (u32)__builtin_clz(fraction);
        u64 result_exponent = (u64)(most + 874u) << 52u;
        u64 result_fraction = (u64)(fraction ^ (1u << most))
                            << (52u - most);
        return sign | result_exponent | result_fraction;
    }
    return sign | ((u64)(exponent + 896u) << 52u)
         | ((u64)fraction << 29u);
}

static u32 x86_float32_to_signed32(
        u32 raw, u32 rounding, int denormals_are_zero, u32 *exceptions)
{
    u32 sign = raw >> 31u;
    u32 exponent = (raw >> 23u) & 0xffu;
    u32 fraction = raw & 0x7fffffu;
    if (exponent == 0xffu) {
        *exceptions |= 1u;
        return 0x80000000u;
    }
    if (!exponent) {
        if (!fraction || denormals_are_zero) return 0u;
        *exceptions |= (1u << 1u) | (1u << 5u);
        u32 magnitude = rounding == 1u ? sign
                      : rounding == 2u ? !sign : 0u;
        return sign ? 0u - magnitude : magnitude;
    }
    i32 unbiased = (i32)exponent - 127;
    if (unbiased < 0) {
        *exceptions |= 1u << 5u;
        u32 magnitude = rounding == 0u
                      ? (unbiased == -1 && fraction != 0u)
                      : rounding == 1u ? sign
                      : rounding == 2u ? !sign : 0u;
        return sign ? 0u - magnitude : magnitude;
    }
    u32 significand = (1u << 23u) | fraction;
    if (unbiased > 31
            || (unbiased == 31
                && (!sign || significand != (1u << 23u)))) {
        *exceptions |= 1u;
        return 0x80000000u;
    }
    u32 magnitude;
    if (unbiased >= 23) {
        magnitude = significand << ((u32)unbiased - 23u);
    } else {
        u32 shift = 23u - (u32)unbiased;
        u32 mask = (1u << shift) - 1u;
        u32 remainder = significand & mask;
        magnitude = significand >> shift;
        if (remainder) {
            *exceptions |= 1u << 5u;
            int increment = rounding == 0u
                          ? (remainder > (1u << (shift - 1u))
                             || (remainder == (1u << (shift - 1u))
                                 && (magnitude & 1u)))
                          : rounding == 1u ? sign != 0u
                          : rounding == 2u ? sign == 0u : 0;
            magnitude += (u32)increment;
        }
    }
    return sign ? 0u - magnitude : magnitude;
}

static u32 x86_float64_to_signed32_truncate(
        u64 raw, int denormals_are_zero, u32 *exceptions)
{
    u32 sign = (u32)(raw >> 63u);
    u32 exponent = (u32)(raw >> 52u) & 0x7ffu;
    u64 fraction = raw & 0xfffffffffffffull;
    if (exponent == 0x7ffu) {
        *exceptions |= 1u;
        return 0x80000000u;
    }
    if (!exponent) {
        if (!fraction || denormals_are_zero) return 0u;
        *exceptions |= (1u << 1u) | (1u << 5u);
        return 0u;
    }
    i32 unbiased = (i32)exponent - 1023;
    if (unbiased < 0) {
        *exceptions |= 1u << 5u;
        return 0u;
    }
    u64 significand = (1ull << 52u) | fraction;
    if (unbiased > 31
            || (unbiased == 31
                && (!sign || significand != (1ull << 52u)))) {
        *exceptions |= 1u;
        return 0x80000000u;
    }
    u32 shift = 52u - (u32)unbiased;
    u64 discarded = significand & ((1ull << shift) - 1u);
    u32 magnitude = (u32)(significand >> shift);
    if (discarded) *exceptions |= 1u << 5u;
    return sign ? 0u - magnitude : magnitude;
}

static u32 x86_float32_sqrt(u32 raw, u32 mxcsr, u32 *exceptions)
{
    u32 sign = raw >> 31u;
    u32 exponent = (raw >> 23u) & 0xffu;
    u32 fraction = raw & 0x7fffffu;
    if (exponent == 0xffu) {
        if (fraction) {
            if (!(fraction & (1u << 22u))) *exceptions |= 1u;
            return raw | (1u << 22u);
        }
        if (!sign) return raw;
        *exceptions |= 1u;
        return 0xffc00000u;
    }
    if (!exponent) {
        if (!fraction) return raw;
        if (mxcsr & (1u << 6u)) return sign << 31u;
        if (sign) {
            *exceptions |= 1u;
            return 0xffc00000u;
        }
        *exceptions |= 1u << 1u;
    } else if (sign) {
        *exceptions |= 1u;
        return 0xffc00000u;
    }

    u32 significand;
    i32 unbiased;
    if (exponent) {
        significand = (1u << 23u) | fraction;
        unbiased = (i32)exponent - 127;
    } else {
        u32 most = 31u - (u32)__builtin_clz(fraction);
        u32 normalize = 23u - most;
        significand = fraction << normalize;
        unbiased = -126 - (i32)normalize;
    }
    u32 exponent_odd = (u32)unbiased & 1u;
    i32 result_unbiased = (unbiased - (i32)exponent_odd) / 2;
    u64 radicand = (u64)significand << (23u + exponent_odd);
    u32 root = (u32)__builtin_sqrt((double)radicand);
    if ((u64)root * root > radicand) --root;
    if ((u64)(root + 1u) * (root + 1u) <= radicand) ++root;
    u64 root_square = (u64)root * root;
    int inexact = root_square != radicand;
    int increment = 0;
    if (inexact) {
        u32 rounding = (mxcsr >> 13u) & 3u;
        if (!rounding) increment = radicand - root_square > root;
        else if (rounding == 2u) increment = 1;
        *exceptions |= 1u << 5u;
    }
    if (increment && ++root == (1u << 24u)) {
        root >>= 1u;
        ++result_unbiased;
    }
    return ((u32)(result_unbiased + 127) << 23u)
         | (root & 0x7fffffu);
}

static u32 x86_float32_relation(
        u32 left, u32 right, int signaling, u32 mxcsr, u32 *exceptions)
{
    u32 left_exponent = (left >> 23u) & 0xffu;
    u32 left_fraction = left & 0x7fffffu;
    u32 right_exponent = (right >> 23u) & 0xffu;
    u32 right_fraction = right & 0x7fffffu;
    if (!left_exponent && left_fraction) {
        if (mxcsr & (1u << 6u)) left &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    if (!right_exponent && right_fraction) {
        if (mxcsr & (1u << 6u)) right &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    left_exponent = (left >> 23u) & 0xffu;
    left_fraction = left & 0x7fffffu;
    right_exponent = (right >> 23u) & 0xffu;
    right_fraction = right & 0x7fffffu;
    int left_nan = left_exponent == 0xffu && left_fraction;
    int right_nan = right_exponent == 0xffu && right_fraction;
    int unordered = left_nan || right_nan;
    int signaling_nan = (left_nan && !(left_fraction & (1u << 22u)))
                      || (right_nan && !(right_fraction & (1u << 22u)));
    if (signaling_nan || (unordered && signaling))
        *exceptions |= 1u;

    int equal = 0;
    int less = 0;
    if (!unordered) {
        if (!((left | right) << 1u) || left == right) {
            equal = 1;
        } else {
            u32 left_sign = left >> 31u;
            u32 right_sign = right >> 31u;
            less = left_sign != right_sign
                 ? left_sign != 0u
                 : left_sign ? left > right : left < right;
        }
    }
    return unordered ? 3u : equal ? 2u : less ? 1u : 0u;
}

static u32 x86_float32_compare(
        u32 left, u32 right, u32 predicate, u32 mxcsr, u32 *exceptions)
{
    u32 relation = x86_float32_relation(
        left, right, ((0x66u >> predicate) & 1u) != 0u,
        mxcsr, exceptions);
    int unordered = relation == 3u;
    int equal = relation == 2u;
    int less = relation == 1u;
    int selected = predicate == 0u ? !unordered && equal
                 : predicate == 1u ? !unordered && less
                 : predicate == 2u ? !unordered && (less || equal)
                 : predicate == 3u ? unordered
                 : predicate == 4u ? unordered || !equal
                 : predicate == 5u ? unordered || !less
                 : predicate == 6u ? unordered || !(less || equal)
                 : !unordered;
    return 0u - (u32)selected;
}

static u32 x86_float32_minmax(
        u32 left, u32 right, int maximum, u32 mxcsr, u32 *exceptions)
{
    u32 relation = x86_float32_relation(
        left, right, 1, mxcsr, exceptions);
    return maximum ? (relation == 0u ? left : right)
                   : (relation == 1u ? left : right);
}

static u64 x86_shift_right_jam64(u64 value, u32 distance)
{
    if (!distance) return value;
    if (distance < 64u)
        return (value >> distance)
             | (u64)((value << (64u - distance)) != 0u);
    return value != 0u;
}

static u32 x86_float32_add(
        u32 left, u32 right, u32 mxcsr, u32 *exceptions)
{
    u32 left_exponent = (left >> 23u) & 0xffu;
    u32 left_fraction = left & 0x7fffffu;
    u32 right_exponent = (right >> 23u) & 0xffu;
    u32 right_fraction = right & 0x7fffffu;
    int left_nan = left_exponent == 0xffu && left_fraction;
    int right_nan = right_exponent == 0xffu && right_fraction;
    if (left_nan || right_nan) {
        if ((left_nan && !(left_fraction & 0x400000u))
                || (right_nan && !(right_fraction & 0x400000u)))
            *exceptions |= 1u;
        return (left_nan ? left : right) | 0x400000u;
    }

    if (!left_exponent && left_fraction) {
        if (mxcsr & (1u << 6u)) left &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    if (!right_exponent && right_fraction) {
        if (mxcsr & (1u << 6u)) right &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    left_exponent = (left >> 23u) & 0xffu;
    left_fraction = left & 0x7fffffu;
    right_exponent = (right >> 23u) & 0xffu;
    right_fraction = right & 0x7fffffu;

    u32 left_sign = left >> 31u;
    u32 right_sign = right >> 31u;
    u32 left_magnitude = left & 0x7fffffffu;
    u32 right_magnitude = right & 0x7fffffffu;
    if (left_exponent == 0xffu || right_exponent == 0xffu) {
        if (left_exponent == 0xffu && right_exponent == 0xffu
                && left_sign != right_sign) {
            *exceptions |= 1u;
            return 0xffc00000u;
        }
        return left_exponent == 0xffu ? left : right;
    }

    u32 rounding = (mxcsr >> 13u) & 3u;
    if (!left_magnitude && !right_magnitude) {
        u32 sign = left_sign == right_sign ? left_sign : rounding == 1u;
        return sign << 31u;
    }
    if (!left_magnitude) return right;
    if (!right_magnitude) return left;

    if (left_magnitude < right_magnitude) {
        u32 temporary = left;
        left = right;
        right = temporary;
        temporary = left_exponent;
        left_exponent = right_exponent;
        right_exponent = temporary;
        temporary = left_fraction;
        left_fraction = right_fraction;
        right_fraction = temporary;
        left_sign = left >> 31u;
        right_sign = right >> 31u;
    }

    u32 exponent = left_exponent ? left_exponent : 1u;
    u32 smaller_exponent = right_exponent ? right_exponent : 1u;
    u32 left_significand = left_fraction
                         | (left_exponent ? 0x800000u : 0u);
    u32 right_significand = right_fraction
                          | (right_exponent ? 0x800000u : 0u);
    u64 left_extended = (u64)left_significand << 3u;
    u64 right_extended = x86_shift_right_jam64(
        (u64)right_significand << 3u, exponent - smaller_exponent);
    u64 extended;
    u32 sign = left_sign;
    if (left_sign == right_sign) {
        extended = left_extended + right_extended;
        if (extended & (1ull << 27u)) {
            extended = x86_shift_right_jam64(extended, 1u);
            ++exponent;
        }
    } else {
        extended = left_extended - right_extended;
        if (!extended) return (rounding == 1u) << 31u;
        if (extended < (1ull << 26u) && exponent > 1u) {
            u32 shift = (u32)__builtin_clzll(extended) - 37u;
            if (shift > exponent - 1u) shift = exponent - 1u;
            extended <<= shift;
            exponent -= shift;
        }
    }

    if (exponent >= 255u) {
        *exceptions |= (1u << 3u) | (1u << 5u);
        int infinity = rounding == 0u
                    || (rounding == 1u && sign)
                    || (rounding == 2u && !sign);
        return (sign << 31u) | (infinity ? 0x7f800000u : 0x7f7fffffu);
    }

    u32 retained = (u32)(extended >> 3u);
    u32 remainder = (u32)extended & 7u;
    if (remainder) {
        *exceptions |= 1u << 5u;
        int increment = rounding == 0u
                      ? (remainder > 4u
                         || (remainder == 4u && (retained & 1u)))
                      : rounding == 1u ? sign != 0u
                      : rounding == 2u ? sign == 0u : 0;
        if (increment && ++retained == 0x1000000u) {
            retained >>= 1u;
            if (++exponent >= 255u) {
                *exceptions |= 1u << 3u;
                int infinity = rounding == 0u
                            || (rounding == 1u && sign)
                            || (rounding == 2u && !sign);
                return (sign << 31u)
                     | (infinity ? 0x7f800000u : 0x7f7fffffu);
            }
        }
    }

    int subnormal = exponent == 1u && retained < 0x800000u;
    if (subnormal && retained && (mxcsr & (1u << 15u))) {
        *exceptions |= (1u << 4u) | (1u << 5u);
        return sign << 31u;
    }
    if (subnormal && remainder) *exceptions |= 1u << 4u;
    u32 result_exponent = subnormal ? 0u : exponent;
    return (sign << 31u) | (result_exponent << 23u)
         | (retained & 0x7fffffu);
}

static u32 x86_float32_nan(
        u32 left, u32 right, u32 *exceptions, int *handled)
{
    u32 left_exponent = (left >> 23u) & 0xffu;
    u32 right_exponent = (right >> 23u) & 0xffu;
    u32 left_fraction = left & 0x7fffffu;
    u32 right_fraction = right & 0x7fffffu;
    int left_nan = left_exponent == 0xffu && left_fraction;
    int right_nan = right_exponent == 0xffu && right_fraction;
    *handled = left_nan || right_nan;
    if (!*handled) return 0u;
    if ((left_nan && !(left_fraction & 0x400000u))
            || (right_nan && !(right_fraction & 0x400000u)))
        *exceptions |= 1u;
    return (left_nan ? left : right) | 0x400000u;
}

static void x86_float32_normalize(u32 raw, u32 *significand, i32 *exponent)
{
    u32 encoded_exponent = (raw >> 23u) & 0xffu;
    u32 fraction = raw & 0x7fffffu;
    if (encoded_exponent) {
        *significand = 0x800000u | fraction;
        *exponent = (i32)encoded_exponent - 127;
        return;
    }
    u32 most = 31u - (u32)__builtin_clz(fraction);
    *significand = fraction << (23u - most);
    *exponent = (i32)most - 149;
}

static u32 x86_float32_overflow(
        u32 sign, u32 rounding, u32 *exceptions)
{
    *exceptions |= (1u << 3u) | (1u << 5u);
    int infinity = rounding == 0u
                || (rounding == 1u && sign)
                || (rounding == 2u && !sign);
    return (sign << 31u) | (infinity ? 0x7f800000u : 0x7f7fffffu);
}

static u32 x86_float32_pack_product(
        u32 sign, i32 exponent, u64 exact, u32 top,
        u32 mxcsr, u32 *exceptions)
{
    u32 rounding = (mxcsr >> 13u) & 3u;
    if (exponent > 127)
        return x86_float32_overflow(sign, rounding, exceptions);
    u32 shift = top - 23u;
    if (exponent < -126) shift += (u32)(-126 - exponent);
    u64 retained = shift < 64u ? exact >> shift : 0u;
    u64 remainder = shift >= 64u ? exact
                  : shift ? exact & ((1ull << shift) - 1u) : 0u;
    int increment = 0;
    if (remainder) {
        *exceptions |= 1u << 5u;
        if (!rounding && shift && shift <= 64u) {
            u64 half = 1ull << (shift - 1u);
            increment = remainder > half
                     || (remainder == half && (retained & 1u));
        } else if (rounding == 1u) increment = sign != 0u;
        else if (rounding == 2u) increment = sign == 0u;
    }
    retained += (u32)increment;
    int subnormal = exponent < -126;
    if (!subnormal && retained == 0x1000000u) {
        retained >>= 1u;
        if (++exponent > 127)
            return x86_float32_overflow(sign, rounding, exceptions);
    }
    if (subnormal && retained >= 0x800000u) subnormal = 0;
    if (subnormal && remainder) *exceptions |= 1u << 4u;
    if (subnormal && retained && (mxcsr & (1u << 15u))) {
        *exceptions |= (1u << 4u) | (1u << 5u);
        return sign << 31u;
    }
    u32 encoded_exponent = subnormal ? 0u : (u32)(exponent + 127);
    if (!subnormal && exponent < -126) encoded_exponent = 1u;
    return (sign << 31u) | (encoded_exponent << 23u)
         | ((u32)retained & 0x7fffffu);
}

static u32 x86_float32_multiply(
        u32 left, u32 right, u32 mxcsr, u32 *exceptions)
{
    int handled;
    u32 nan = x86_float32_nan(left, right, exceptions, &handled);
    if (handled) return nan;
    u32 sign = (left ^ right) >> 31u;
    u32 left_exponent = (left >> 23u) & 0xffu;
    u32 right_exponent = (right >> 23u) & 0xffu;
    u32 left_fraction = left & 0x7fffffu;
    u32 right_fraction = right & 0x7fffffu;
    if (!left_exponent && left_fraction) {
        if (mxcsr & (1u << 6u)) left &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    if (!right_exponent && right_fraction) {
        if (mxcsr & (1u << 6u)) right &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    left_exponent = (left >> 23u) & 0xffu;
    right_exponent = (right >> 23u) & 0xffu;
    int left_zero = !(left & 0x7fffffffu);
    int right_zero = !(right & 0x7fffffffu);
    int left_infinity = left_exponent == 0xffu;
    int right_infinity = right_exponent == 0xffu;
    if ((left_zero && right_infinity) || (right_zero && left_infinity)) {
        *exceptions |= 1u;
        return 0xffc00000u;
    }
    if (left_infinity || right_infinity)
        return (sign << 31u) | 0x7f800000u;
    if (left_zero || right_zero) return sign << 31u;
    u32 left_significand, right_significand;
    i32 left_unbiased, right_unbiased;
    x86_float32_normalize(left, &left_significand, &left_unbiased);
    x86_float32_normalize(right, &right_significand, &right_unbiased);
    u64 product = (u64)left_significand * right_significand;
    u32 top = product & (1ull << 47u) ? 47u : 46u;
    i32 exponent = left_unbiased + right_unbiased + (top == 47u);
    return x86_float32_pack_product(
        sign, exponent, product, top, mxcsr, exceptions);
}

static u32 x86_float32_divide_finite(
        u32 sign, u32 left_significand, i32 left_exponent,
        u32 right_significand, i32 right_exponent,
        u32 mxcsr, u32 *exceptions)
{
    i32 exponent = left_exponent - right_exponent;
    if (left_significand < right_significand) {
        left_significand <<= 1u;
        --exponent;
    }
    u32 rounding = (mxcsr >> 13u) & 3u;
    if (exponent > 127)
        return x86_float32_overflow(sign, rounding, exceptions);
    u64 numerator;
    u64 denominator;
    int quotient_too_small = 0;
    if (exponent >= -126) {
        numerator = (u64)left_significand << 23u;
        denominator = right_significand;
    } else {
        i32 scale = exponent + 149;
        if (scale >= 0) {
            numerator = (u64)left_significand << (u32)scale;
            denominator = right_significand;
        } else if (-scale <= 40) {
            numerator = left_significand;
            denominator = (u64)right_significand << (u32)-scale;
        } else {
            numerator = left_significand;
            denominator = 0u;
            quotient_too_small = 1;
        }
    }
    u32 retained = 0u;
    int inexact = 1;
    int above_half = 0;
    int exactly_half = 0;
    if (!quotient_too_small) {
        retained = (u32)(numerator / denominator);
        u64 remainder = numerator % denominator;
        inexact = remainder != 0u;
        if (inexact) {
            u64 complement = denominator - remainder;
            above_half = remainder > complement;
            exactly_half = remainder == complement;
        }
    }
    int increment = inexact
        && (rounding == 0u ? (above_half || (exactly_half && (retained & 1u)))
          : rounding == 1u ? sign != 0u
          : rounding == 2u ? sign == 0u : 0);
    if (inexact) *exceptions |= 1u << 5u;
    retained += (u32)increment;
    int subnormal = exponent < -126;
    if (!subnormal && retained == 0x1000000u) {
        retained >>= 1u;
        if (++exponent > 127)
            return x86_float32_overflow(sign, rounding, exceptions);
    }
    if (subnormal && retained >= 0x800000u) subnormal = 0;
    if (subnormal && inexact) *exceptions |= 1u << 4u;
    if (subnormal && retained && (mxcsr & (1u << 15u))) {
        *exceptions |= (1u << 4u) | (1u << 5u);
        return sign << 31u;
    }
    u32 encoded_exponent = subnormal ? 0u : (u32)(exponent + 127);
    if (!subnormal && exponent < -126) encoded_exponent = 1u;
    return (sign << 31u) | (encoded_exponent << 23u)
         | (retained & 0x7fffffu);
}

static u32 x86_float32_divide(
        u32 left, u32 right, u32 mxcsr, u32 *exceptions)
{
    int handled;
    u32 nan = x86_float32_nan(left, right, exceptions, &handled);
    if (handled) return nan;
    u32 sign = (left ^ right) >> 31u;
    u32 left_exponent = (left >> 23u) & 0xffu;
    u32 right_exponent = (right >> 23u) & 0xffu;
    u32 left_fraction = left & 0x7fffffu;
    u32 right_fraction = right & 0x7fffffu;
    if (!left_exponent && left_fraction) {
        if (mxcsr & (1u << 6u)) left &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    if (!right_exponent && right_fraction) {
        if (mxcsr & (1u << 6u)) right &= 0x80000000u;
        else *exceptions |= 1u << 1u;
    }
    left_exponent = (left >> 23u) & 0xffu;
    right_exponent = (right >> 23u) & 0xffu;
    int left_zero = !(left & 0x7fffffffu);
    int right_zero = !(right & 0x7fffffffu);
    int left_infinity = left_exponent == 0xffu;
    int right_infinity = right_exponent == 0xffu;
    if ((left_zero && right_zero) || (left_infinity && right_infinity)) {
        *exceptions |= 1u;
        return 0xffc00000u;
    }
    if (left_infinity) return (sign << 31u) | 0x7f800000u;
    if (right_infinity || left_zero) return sign << 31u;
    if (right_zero) {
        *exceptions |= 1u << 2u;
        return (sign << 31u) | 0x7f800000u;
    }
    u32 left_significand, right_significand;
    i32 left_unbiased, right_unbiased;
    x86_float32_normalize(left, &left_significand, &left_unbiased);
    x86_float32_normalize(right, &right_significand, &right_unbiased);
    return x86_float32_divide_finite(
        sign, left_significand, left_unbiased,
        right_significand, right_unbiased, mxcsr, exceptions);
}

static u32 x86_float32_subtract(
        u32 left, u32 right, u32 mxcsr, u32 *exceptions)
{
    int handled;
    u32 nan = x86_float32_nan(left, right, exceptions, &handled);
    return handled ? nan
         : x86_float32_add(left, right ^ 0x80000000u, mxcsr, exceptions);
}

EXPORT int vm_x86_direct_vector(u32 machine, u64 descriptor, u64 address)
{
    X86Workspace *x86 = x86_machine();
    u32 kind = (u32)descriptor & 0xffu;
    u32 target = (u32)(descriptor >> 8u) & 0xffu;
    u32 source = (u32)(descriptor >> 16u) & 0xffu;
    u32 shape = (u32)(descriptor >> 24u) & 7u;
    u32 immediate = (u32)(descriptor >> 32u) & 0xffu;
    u32 source_memory = shape & 1u;
    u32 target_memory = (shape >> 1u) & 1u;
    u32 aligned = (shape >> 2u) & 1u;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || kind > 38u
            || (source_memory && target_memory)
            || (target_memory
                ? ((kind && kind != 9u && kind != 13u && kind != 14u
                    && kind != 28u)
                   || target || source >= 16u)
                : source_memory
                ? (target >= 16u || source)
                : (target >= 16u || source >= 16u
                    || (kind != 33u && address)))
            || (aligned && !source_memory && !target_memory)
            || ((kind == 5u || kind == 6u)
                && (shape || address || target != source))
            || ((kind == 7u || kind == 8u)
                && (target_memory || aligned != source_memory))
            || (kind == 9u
                && (aligned || immediate > 31u
                    || ((immediate & 1u)
                        ? (source_memory || target
                           || (target_memory && (immediate >> 1u)))
                        : (target_memory || source
                           || (source_memory && (immediate >> 1u))))))
            || (kind == 10u
                && (target_memory || aligned != source_memory
                    || immediate < 9u || immediate > 49u))
            || ((kind == 11u || kind == 12u)
                && (shape || address || target != source))
            || (kind == 13u
                && (aligned || immediate > 31u
                    || ((immediate & 1u)
                        ? (source_memory || target
                           || (target_memory && (immediate >> 1u)))
                        : (target_memory || source
                           || (source_memory && (immediate >> 1u))))))
            || (kind == 14u
                && (source_memory == target_memory || aligned
                    || immediate > 1u))
            || (kind == 15u
                && (target_memory || aligned || immediate > 7u))
            || (kind == 16u
                && (target_memory || aligned || immediate))
            || ((kind == 17u || kind == 21u)
                && (target >= 8u || target_memory || aligned || immediate))
            || ((kind == 18u || kind == 37u || kind == 38u)
                && (target_memory || aligned || immediate))
            || (kind == 19u
                && (target_memory || aligned || immediate > 7u))
            || (kind == 20u
                && (target_memory || aligned || immediate))
            || (kind == 22u
                && (shape || address
                    || immediate != ((immediate & 7u)
                        | (((immediate >> 3u) & 1u) << 3u))
                    || (((immediate >> 3u) & 1u)
                        ? (source >= 8u || (immediate & 7u) > 3u)
                        : source >= 16u)))
            || (kind == 23u
                && (shape || address || target != source
                    || (immediate & 31u) > 16u
                    || (immediate >> 5u) > 1u
                    || immediate != ((immediate & 31u)
                        | ((immediate >> 5u) << 5u))))
            || (kind == 24u
                && (target_memory || aligned != source_memory || immediate))
            || (kind == 25u
                && (target_memory || aligned || immediate > 1u))
            || (kind == 26u
                && (target_memory || aligned || immediate > 1u))
            || (kind == 27u
                && (target_memory || aligned != source_memory))
            || (kind == 28u
                && (source_memory == target_memory || aligned
                    || target || source || immediate))
            || (kind == 29u
                && (shape || address || immediate))
            || (kind == 30u
                && (target_memory || aligned || immediate
                    || (!source_memory && source >= 8u)))
            || (kind == 31u
                && (target_memory || aligned || immediate))
            || (kind == 32u
                && (target >= 8u || target_memory || aligned || immediate))
            || (kind == 33u
                && (target >= 8u || source >= 8u || shape
                    || (immediate & ~0x0fu) || (immediate & 7u) > 5u))
            || ((kind >= 34u && kind <= 36u)
                && (target_memory || aligned || immediate))
            || (kind < 5u && immediate)
            || descriptor != (kind | ((u64)target << 8u)
                | ((u64)source << 16u) | ((u64)shape << 24u)
                | ((u64)immediate << 32u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    /* A 128-bit register is two independent physical u64 lanes.  Both source
     * lanes are observed before either target lane is published, including
     * target==source, so the transfer has work=2 and span=1 without a scalar
     * vector materialization. */
    if (aligned && (address & 15u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if (kind == 9u || kind == 13u) {
        u32 direction = immediate & 1u;
        u32 general = immediate >> 1u;
        u32 transfer_width = kind == 9u ? 4u : 8u;
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        if (direction) {
            u64 value = kind == 9u
                      ? (u32)x86->xmm[source * 2u]
                      : x86->xmm[source * 2u];
            if (target_memory) {
                u8 bytes[8];
                if (kind == 9u) store_u32(bytes, (u32)value);
                else store_u64(bytes, value);
                if (!x86_direct_access_ready(
                        x86, address, transfer_width, 1, user))
                    return 0;
                if (x86_virtual_write(
                        address, bytes, transfer_width, user) != 1) {
                    x86_direct_memory_abort(x86, 0xffu);
                    return 0;
                }
            } else {
                x86->registers[general] = kind == 9u ? (u32)value : value;
            }
        } else {
            u64 value;
            if (source_memory) {
                u8 bytes[8];
                if (!x86_direct_read(
                        x86, address, bytes, transfer_width, user)) return 0;
                value = kind == 9u ? read_u32(bytes) : load_u64(bytes);
            } else {
                value = kind == 9u
                      ? (u32)x86->registers[general]
                      : x86->registers[general];
            }
            x86->xmm[target * 2u] = value;
            x86->xmm[target * 2u + 1u] = 0u;
        }
        return 1;
    }
    if (kind == 14u) {
        u32 lane = immediate;
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        if (target_memory) {
            u8 bytes[8];
            store_u64(bytes, x86->xmm[source * 2u + lane]);
            if (!x86_direct_access_ready(x86, address, 8u, 1, user))
                return 0;
            if (x86_virtual_write(address, bytes, 8u, user) != 1) {
                x86_direct_memory_abort(x86, 0xffu);
                return 0;
            }
        } else {
            u8 bytes[8];
            if (!x86_direct_read(x86, address, bytes, 8u, user)) return 0;
            x86->xmm[target * 2u + lane] = load_u64(bytes);
        }
        return 1;
    }
    if (kind == 15u) {
        u32 value;
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        if (source_memory) {
            u8 bytes[2];
            if (!x86_direct_read(x86, address, bytes, 2u, user)) return 0;
            value = read_u16(bytes);
        } else {
            value = (u32)x86->registers[source] & 0xffffu;
        }
        u32 word = immediate;
        u32 lane = target * 2u + word / 4u;
        u32 shift = (word & 3u) * 16u;
        u64 mask = 0xffffull << shift;
        x86->xmm[lane] = (x86->xmm[lane] & ~mask) | ((u64)value << shift);
        return 1;
    }
    if (kind == 22u) {
        u32 word = immediate & 7u;
        int mmx = (immediate & 8u) != 0u;
        u64 lane = mmx ? x86->x87_significand[source]
                 : x86->xmm[source * 2u + word / 4u];
        x86->registers[target] = (lane >> ((word & 3u) * 16u)) & 0xffffu;
        if (mmx) {
            x86->x87_tag = 0u;
            x86->x87_status &= ~(7u << 11u);
        }
        return 1;
    }
    if (kind == 23u) {
        u32 count = immediate & 31u;
        int left = (immediate & 32u) != 0u;
        u64 low = x86->xmm[target * 2u];
        u64 high = x86->xmm[target * 2u + 1u];
        u64 result_low;
        u64 result_high;
        if (!count) {
            result_low = low;
            result_high = high;
        } else if (count >= 16u) {
            result_low = 0u;
            result_high = 0u;
        } else if (left && count < 8u) {
            u32 shift = count * 8u;
            result_low = low << shift;
            result_high = (high << shift) | (low >> (64u - shift));
        } else if (left) {
            result_low = 0u;
            result_high = low << ((count - 8u) * 8u);
        } else if (count < 8u) {
            u32 shift = count * 8u;
            result_low = (low >> shift) | (high << (64u - shift));
            result_high = high >> shift;
        } else {
            result_low = high >> ((count - 8u) * 8u);
            result_high = 0u;
        }
        x86->xmm[target * 2u] = result_low;
        x86->xmm[target * 2u + 1u] = result_high;
        return 1;
    }
    if (kind == 28u) {
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        if (source_memory) {
            u8 bytes[4];
            if (!x86_direct_read(x86, address, bytes, sizeof bytes, user))
                return 0;
            u32 value = read_u32(bytes);
            if (value & ~0xffffu) {
                x86_direct_exception(x86, 13u, 1u, 0u);
                return 0;
            }
            x86->mxcsr = value;
        } else {
            u8 bytes[4];
            store_u32(bytes, x86->mxcsr);
            if (!x86_direct_access_ready(
                    x86, address, sizeof bytes, 1, user))
                return 0;
            if (x86_virtual_write(address, bytes, sizeof bytes, user) != 1) {
                x86_direct_memory_abort(x86, 0xffu);
                return 0;
            }
        }
        return 1;
    }
    if (kind == 29u) {
        x86->xmm[target * 2u] = x86->xmm[source * 2u + 1u];
        return 1;
    }
    if (kind == 30u) {
        u64 packed;
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        if (source_memory) {
            u8 bytes[8];
            if (!x86_direct_read(x86, address, bytes, sizeof bytes, user))
                return 0;
            packed = load_u64(bytes);
        } else {
            packed = x86->x87_significand[source];
            x86->x87_tag = 0u;
            x86->x87_status &= ~(7u << 11u);
        }
        u32 exceptions = 0u;
        u32 rounding = (x86->mxcsr >> 13u) & 3u;
        u32 result0 = x86_signed32_to_float32(
            (i32)(u32)packed, rounding, &exceptions);
        u32 result1 = x86_signed32_to_float32(
            (i32)(u32)(packed >> 32u), rounding, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        x86->xmm[target * 2u] = result0 | ((u64)result1 << 32u);
        return 1;
    }
    if (kind == 31u) {
        u64 packed;
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        if (source_memory) {
            u8 bytes[8];
            if (!x86_direct_read(x86, address, bytes, sizeof bytes, user))
                return 0;
            packed = load_u64(bytes);
        } else {
            packed = x86->xmm[source * 2u];
        }
        u32 exceptions = 0u;
        int denormals_are_zero = (x86->mxcsr & (1u << 6u)) != 0u;
        u64 result0 = x86_float32_to_float64(
            (u32)packed, denormals_are_zero, &exceptions);
        u64 result1 = x86_float32_to_float64(
            (u32)(packed >> 32u), denormals_are_zero, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        x86->xmm[target * 2u] = result0;
        x86->xmm[target * 2u + 1u] = result1;
        return 1;
    }
    if (kind == 33u) {
        u32 segment = immediate & 7u;
        u32 address_bits = immediate & 8u ? 64u : 32u;
        u64 segment_base = 0u;
        /* QEMU's fixed oracle enters MMX state before forming the implicit
         * address.  Preserve that ordering even when segment validation or a
         * selected byte store faults. */
        x86->x87_tag = 0u;
        x86->x87_status &= ~(7u << 11u);
        if (!x86_direct_string_segment_base(x86, segment, &segment_base))
            return 0;
        u64 pointer = address_bits == 32u ? (u32)address : address;
        u64 base = segment_base + pointer;
        u64 data = x86->x87_significand[target];
        u64 mask = x86->x87_significand[source];
        int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
        for (u32 byte = 0u; byte < 8u; ++byte) {
            if (!((mask >> (byte * 8u)) & 0x80u)) continue;
            u64 at = base + byte;
            u8 value = (u8)(data >> (byte * 8u));
            if (!x86_direct_access_ready(x86, at, 1u, 1, user)) return 0;
            int written = x86_virtual_write(at, &value, 1u, user);
            if (!written) {
                x86->direct_memory_result = pl_vm_result_make(
                    PL_VM_BARRIER, x86->physical_status);
                return 0;
            }
            if (written < 0) {
                x86_direct_page_fault(x86, at, 1, 0, written == -2);
                return 0;
            }
        }
        return 1;
    }
    u64 low;
    u64 high;
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    if (source_memory) {
        u8 bytes[16] = {0};
        u32 source_bytes = kind == 25u ? 4u
                         : (kind == 10u && immediate == 29u)
                        || kind == 17u || kind == 21u ? 8u : 16u;
        if (!x86_direct_read(x86, address, bytes, source_bytes, user))
            return 0;
        low = load_u64(bytes);
        high = load_u64(bytes + 8u);
    } else {
        low = x86->xmm[source * 2u];
        high = x86->xmm[source * 2u + 1u];
    }
    if (target_memory) {
        u8 bytes[16];
        store_u64(bytes, low);
        store_u64(bytes + 8u, high);
        if (!x86_direct_access_ready(x86, address, sizeof bytes, 1, user))
            return 0;
        if (x86_virtual_write(address, bytes, sizeof bytes, user) != 1) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        return 1;
    }
    if (kind == 25u) {
        u32 exceptions = 0u;
        u32 relation = x86_float32_relation(
            (u32)x86->xmm[target * 2u], (u32)low,
            immediate != 0u, x86->mxcsr, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        static const u64 flags[4] = { 0u, 1u, 0x40u, 0x45u };
        x86->rflags = (x86->rflags & ~0x8d5ull) | flags[relation];
        return 1;
    }
    if (kind == 1u) {
        low ^= x86->xmm[target * 2u];
        high ^= x86->xmm[target * 2u + 1u];
    } else if (kind == 2u) {
        low &= x86->xmm[target * 2u];
        high &= x86->xmm[target * 2u + 1u];
    } else if (kind == 3u) {
        low |= x86->xmm[target * 2u];
        high |= x86->xmm[target * 2u + 1u];
    } else if (kind == 24u) {
        low &= ~x86->xmm[target * 2u];
        high &= ~x86->xmm[target * 2u + 1u];
    } else if (kind == 4u) {
        u64 left_low = x86->xmm[target * 2u];
        u64 left_high = x86->xmm[target * 2u + 1u];
        low = (u64)((u32)left_low + (u32)low)
            | ((u64)((u32)(left_low >> 32u) + (u32)(low >> 32u)) << 32u);
        high = (u64)((u32)left_high + (u32)high)
             | ((u64)((u32)(left_high >> 32u)
                         + (u32)(high >> 32u)) << 32u);
    } else if (kind == 5u || kind == 6u) {
        u32 shift = immediate & 31u;
        u32 valid = 0u - (immediate < 32u);
        u32 low0 = (u32)low;
        u32 low1 = (u32)(low >> 32u);
        u32 high0 = (u32)high;
        u32 high1 = (u32)(high >> 32u);
        if (kind == 5u) {
            low0 = (low0 >> shift) & valid;
            low1 = (low1 >> shift) & valid;
            high0 = (high0 >> shift) & valid;
            high1 = (high1 >> shift) & valid;
        } else {
            low0 = (low0 << shift) & valid;
            low1 = (low1 << shift) & valid;
            high0 = (high0 << shift) & valid;
            high1 = (high1 << shift) & valid;
        }
        low = (u64)low0 | ((u64)low1 << 32u);
        high = (u64)high0 | ((u64)high1 << 32u);
    } else if (kind == 7u) {
        u64 result_low = 0u;
        u64 result_high = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 selected = (immediate >> (lane * 2u)) & 3u;
            u64 value = x86_vector_lane32(low, high, selected);
            if (lane < 2u) result_low |= value << (lane * 32u);
            else result_high |= value << ((lane - 2u) * 32u);
        }
        low = result_low;
        high = result_high;
    } else if (kind == 8u) {
        u64 left_low = x86->xmm[target * 2u];
        u64 left_high = x86->xmm[target * 2u + 1u];
        u32 lane0 = x86_vector_lane32(
            left_low, left_high, immediate & 3u);
        u32 lane1 = x86_vector_lane32(
            left_low, left_high, (immediate >> 2u) & 3u);
        u32 lane2 = x86_vector_lane32(
            low, high, (immediate >> 4u) & 3u);
        u32 lane3 = x86_vector_lane32(
            low, high, (immediate >> 6u) & 3u);
        low = (u64)lane0 | ((u64)lane1 << 32u);
        high = (u64)lane2 | ((u64)lane3 << 32u);
    } else if (kind == 10u) {
        u64 left_low = x86->xmm[target * 2u];
        u64 left_high = x86->xmm[target * 2u + 1u];
        if (immediate == 13u) {
            u64 result_low = x86_packed_interleave_bytes4(
                left_high, high, 0u);
            u64 result_high = x86_packed_interleave_bytes4(
                left_high, high, 4u);
            low = result_low;
            high = result_high;
        } else if (immediate == 18u) {
            u64 result_low = (left_low & 0xffffffffull)
                           | ((low & 0xffffffffull) << 32u);
            u64 result_high = ((left_low >> 32u) & 0xffffffffull)
                            | (((low >> 32u) & 0xffffffffull) << 32u);
            low = result_low;
            high = result_high;
        } else if (immediate == 19u) {
            low = left_high;
        } else if (immediate == 20u) {
            u64 result_low = x86_packed_interleave_words2(
                left_high, high, 0u);
            u64 result_high = x86_packed_interleave_words2(
                left_high, high, 2u);
            low = result_low;
            high = result_high;
        } else if (immediate == 22u) {
            high = low;
            low = left_low;
        } else if (immediate == 26u || immediate == 46u) {
            u64 result_low = x86_packed_extended64(
                left_low, left_high, immediate);
            u64 result_high = x86_packed_extended64(
                low, high, immediate);
            low = result_low;
            high = result_high;
        } else if (immediate == 28u || immediate == 36u
                || immediate == 44u || immediate == 45u) {
            u64 count = low;
            low = x86_packed_extended64(left_low, count, immediate);
            high = x86_packed_extended64(left_high, count, immediate);
        } else if (immediate == 29u) {
            u64 right_low = low;
            low = x86_packed_interleave_words2(
                left_low, right_low, 0u);
            high = x86_packed_interleave_words2(
                left_low, right_low, 2u);
        } else if (immediate == 37u || immediate == 38u) {
            u64 result_low = (left_high & 0xffffffffull)
                           | ((high & 0xffffffffull) << 32u);
            u64 result_high = ((left_high >> 32u) & 0xffffffffull)
                            | (((high >> 32u) & 0xffffffffull) << 32u);
            low = result_low;
            high = result_high;
        } else if (immediate == 39u) {
            u64 right_low = low;
            low = x86_packed_interleave_bytes4(
                left_low, right_low, 0u);
            high = x86_packed_interleave_bytes4(
                left_low, right_low, 4u);
        } else if (immediate == 40u) {
            u64 result_low = x86_packed_extended64(
                left_low, left_high, immediate);
            u64 result_high = x86_packed_extended64(
                low, high, immediate);
            low = result_low;
            high = result_high;
        } else {
            low = x86_packed_extended64(left_low, low, immediate);
            high = x86_packed_extended64(left_high, high, immediate);
        }
    } else if (kind == 27u) {
        u64 shuffled = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 selected = (immediate >> (lane * 2u)) & 3u;
            shuffled |= ((high >> (selected * 16u)) & 0xffffu)
                      << (lane * 16u);
        }
        high = shuffled;
    } else if (kind == 11u || kind == 12u) {
        u32 shift = immediate & 63u;
        u64 valid = 0ull - (u64)(immediate < 64u);
        if (kind == 11u) {
            low = (low >> shift) & valid;
            high = (high >> shift) & valid;
        } else {
            low = (low << shift) & valid;
            high = (high << shift) & valid;
        }
    } else if (kind == 16u) {
        u32 exceptions = 0u;
        u32 rounding = (x86->mxcsr >> 13u) & 3u;
        u32 result[4];
        result[0] = x86_signed32_to_float32((i32)(u32)low, rounding, &exceptions);
        result[1] = x86_signed32_to_float32(
            (i32)(u32)(low >> 32u), rounding, &exceptions);
        result[2] = x86_signed32_to_float32((i32)(u32)high, rounding, &exceptions);
        result[3] = x86_signed32_to_float32(
            (i32)(u32)(high >> 32u), rounding, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        low = result[0] | ((u64)result[1] << 32u);
        high = result[2] | ((u64)result[3] << 32u);
    } else if (kind == 17u || kind == 21u) {
        u32 exceptions = 0u;
        int denormals_are_zero = (x86->mxcsr & (1u << 6u)) != 0u;
        u32 rounding = kind == 17u ? 3u : (x86->mxcsr >> 13u) & 3u;
        u32 result0 = x86_float32_to_signed32(
            (u32)low, rounding, denormals_are_zero, &exceptions);
        u32 result1 = x86_float32_to_signed32(
            (u32)(low >> 32u), rounding, denormals_are_zero, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        x86->x87_significand[target] = result0 | ((u64)result1 << 32u);
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_status &= ~(7u << 11u);
        return 1;
    } else if (kind == 32u) {
        u32 exceptions = 0u;
        int denormals_are_zero = (x86->mxcsr & (1u << 6u)) != 0u;
        u32 result0 = x86_float64_to_signed32_truncate(
            low, denormals_are_zero, &exceptions);
        u32 result1 = x86_float64_to_signed32_truncate(
            high, denormals_are_zero, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        x86->x87_significand[target] = result0 | ((u64)result1 << 32u);
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_status &= ~(7u << 11u);
        return 1;
    } else if (kind == 18u || kind == 37u || kind == 38u) {
        u32 exceptions = 0u;
        u32 result[4];
        u32 source_lane[4] = {
            (u32)low, (u32)(low >> 32u),
            (u32)high, (u32)(high >> 32u),
        };
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 value = source_lane[lane];
            if (kind == 18u) {
                result[lane] = x86_float32_sqrt(
                    value, x86->mxcsr, &exceptions);
            } else {
                if (kind == 38u)
                    value = x86_float32_sqrt(
                        value, x86->mxcsr, &exceptions);
                result[lane] = x86_float32_divide(
                    0x3f800000u, value, x86->mxcsr, &exceptions);
            }
        }
        /* The fixed QEMU-compatible CPU contract computes these estimates
         * with binary32 operations but suppresses every arithmetic status
         * bit.  Memory admission and #NM remain outside this numeric wave. */
        if (kind != 18u) exceptions = 0u;
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        low = result[0] | ((u64)result[1] << 32u);
        high = result[2] | ((u64)result[3] << 32u);
    } else if (kind == 19u) {
        u64 left_low = x86->xmm[target * 2u];
        u64 left_high = x86->xmm[target * 2u + 1u];
        u32 exceptions = 0u;
        u32 result[4];
        result[0] = x86_float32_compare(
            (u32)left_low, (u32)low, immediate, x86->mxcsr, &exceptions);
        result[1] = x86_float32_compare(
            (u32)(left_low >> 32u), (u32)(low >> 32u),
            immediate, x86->mxcsr, &exceptions);
        result[2] = x86_float32_compare(
            (u32)left_high, (u32)high, immediate, x86->mxcsr, &exceptions);
        result[3] = x86_float32_compare(
            (u32)(left_high >> 32u), (u32)(high >> 32u),
            immediate, x86->mxcsr, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        low = result[0] | ((u64)result[1] << 32u);
        high = result[2] | ((u64)result[3] << 32u);
    } else if (kind == 20u || (kind >= 34u && kind <= 36u)) {
        u64 left_low = x86->xmm[target * 2u];
        u64 left_high = x86->xmm[target * 2u + 1u];
        u32 exceptions = 0u;
        u32 result0, result1, result2, result3;
        if (kind == 20u) {
            result0 = x86_float32_add(
                (u32)left_low, (u32)low, x86->mxcsr, &exceptions);
            result1 = x86_float32_add(
                (u32)(left_low >> 32u), (u32)(low >> 32u),
                x86->mxcsr, &exceptions);
            result2 = x86_float32_add(
                (u32)left_high, (u32)high, x86->mxcsr, &exceptions);
            result3 = x86_float32_add(
                (u32)(left_high >> 32u), (u32)(high >> 32u),
                x86->mxcsr, &exceptions);
        } else if (kind == 34u) {
            result0 = x86_float32_multiply(
                (u32)left_low, (u32)low, x86->mxcsr, &exceptions);
            result1 = x86_float32_multiply(
                (u32)(left_low >> 32u), (u32)(low >> 32u),
                x86->mxcsr, &exceptions);
            result2 = x86_float32_multiply(
                (u32)left_high, (u32)high, x86->mxcsr, &exceptions);
            result3 = x86_float32_multiply(
                (u32)(left_high >> 32u), (u32)(high >> 32u),
                x86->mxcsr, &exceptions);
        } else if (kind == 35u) {
            result0 = x86_float32_subtract(
                (u32)left_low, (u32)low, x86->mxcsr, &exceptions);
            result1 = x86_float32_subtract(
                (u32)(left_low >> 32u), (u32)(low >> 32u),
                x86->mxcsr, &exceptions);
            result2 = x86_float32_subtract(
                (u32)left_high, (u32)high, x86->mxcsr, &exceptions);
            result3 = x86_float32_subtract(
                (u32)(left_high >> 32u), (u32)(high >> 32u),
                x86->mxcsr, &exceptions);
        } else {
            result0 = x86_float32_divide(
                (u32)left_low, (u32)low, x86->mxcsr, &exceptions);
            result1 = x86_float32_divide(
                (u32)(left_low >> 32u), (u32)(low >> 32u),
                x86->mxcsr, &exceptions);
            result2 = x86_float32_divide(
                (u32)left_high, (u32)high, x86->mxcsr, &exceptions);
            result3 = x86_float32_divide(
                (u32)(left_high >> 32u), (u32)(high >> 32u),
                x86->mxcsr, &exceptions);
        }
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        low = result0 | ((u64)result1 << 32u);
        high = result2 | ((u64)result3 << 32u);
    } else if (kind == 26u) {
        u64 left_low = x86->xmm[target * 2u];
        u64 left_high = x86->xmm[target * 2u + 1u];
        u32 exceptions = 0u;
        u32 result0 = x86_float32_minmax(
            (u32)left_low, (u32)low, immediate,
            x86->mxcsr, &exceptions);
        u32 result1 = x86_float32_minmax(
            (u32)(left_low >> 32u), (u32)(low >> 32u), immediate,
            x86->mxcsr, &exceptions);
        u32 result2 = x86_float32_minmax(
            (u32)left_high, (u32)high, immediate,
            x86->mxcsr, &exceptions);
        u32 result3 = x86_float32_minmax(
            (u32)(left_high >> 32u), (u32)(high >> 32u), immediate,
            x86->mxcsr, &exceptions);
        x86->mxcsr |= exceptions;
        u32 unmasked = exceptions & ~(x86->mxcsr >> 7u) & 0x3fu;
        if (unmasked) {
            x86_direct_exception(
                x86, x86->cr4 & (1u << 10u) ? 19u : 6u, 0u, 0u);
            return 0;
        }
        low = result0 | ((u64)result1 << 32u);
        high = result2 | ((u64)result3 << 32u);
    }
    x86->xmm[target * 2u] = low;
    x86->xmm[target * 2u + 1u] = high;
    return 1;
}

static u32 x86_x87_top(const X86Workspace *x86)
{
    return ((u32)x86->x87_status >> 11u) & 7u;
}

static void x86_x87_set_top(X86Workspace *x86, u32 top)
{
    x86->x87_status = (pl_u16)((x86->x87_status & ~(7u << 11u))
                    | ((top & 7u) << 11u));
}

static u32 x86_x87_tag(const X86Workspace *x86, u32 physical)
{
    return ((u32)x86->x87_tag >> ((physical & 7u) * 2u)) & 3u;
}

static void x86_x87_set_tag(X86Workspace *x86, u32 physical, u32 tag)
{
    u32 shift = (physical & 7u) * 2u;
    x86->x87_tag = (pl_u16)((x86->x87_tag & ~(3u << shift))
                 | ((tag & 3u) << shift));
}

static int x86_x87_exception(X86Workspace *x86, u32 exceptions)
{
    exceptions &= 0x3fu;
    x86->x87_status |= (pl_u16)exceptions;
    u32 unmasked = exceptions & ~(u32)x86->x87_control & 0x3fu;
    if (unmasked) x86->x87_status |= 0x8080u;
    return unmasked != 0u;
}

static int x86_x87_ready(X86Workspace *x86, int wait_mode)
{
    if (wait_mode > 0) {
        if ((x86->cr0 & ((1u << 1u) | (1u << 3u)))
                == ((1u << 1u) | (1u << 3u))) {
            x86_direct_exception(x86, 7u, 0u, 0u);
            return 0;
        }
    } else if (x86->cr0 & ((1u << 2u) | (1u << 3u))) {
        x86_direct_exception(x86, 7u, 0u, 0u);
        return 0;
    }
    /* FN-prefixed state operations still observe #NM, but deliberately do
     * not synchronize a previously pending x87 exception. */
    if (wait_mode < 0 || !(x86->x87_status & 0x80u)) return 1;
    if (x86->cr0 & (1u << 5u)) {
        x86_direct_exception(x86, 16u, 0u, 0u);
        return 0;
    }
    x86->ferr_pending = 1u;
    return 1;
}

static void x86_x87_from_integer(
        i64 value, u64 *significand, pl_u16 *sign_exponent, u32 *tag)
{
    u64 bits = (u64)value;
    u32 sign = (u32)(bits >> 63u);
    u64 magnitude = sign ? (~bits + 1u) : bits;
    if (!magnitude) {
        *significand = 0u;
        *sign_exponent = 0u;
        *tag = 1u;
        return;
    }
    u32 most = 63u - (u32)__builtin_clzll(magnitude);
    *significand = magnitude << (63u - most);
    *sign_exponent = (pl_u16)((sign << 15u) | (0x3fffu + most));
    *tag = 0u;
}

static void x86_x87_from_binary(
        u64 raw, u32 width, u64 *significand,
        pl_u16 *sign_exponent, u32 *tag)
{
    u32 fraction_bits = width == 4u ? 23u : 52u;
    u32 exponent_bits = width == 4u ? 8u : 11u;
    u32 exponent_bias = width == 4u ? 127u : 1023u;
    u32 sign_at = fraction_bits + exponent_bits;
    u64 fraction_mask = (1ull << fraction_bits) - 1u;
    u64 fraction = raw & fraction_mask;
    u32 exponent = (u32)(raw >> fraction_bits)
                 & ((1u << exponent_bits) - 1u);
    u32 sign = (u32)(raw >> sign_at) & 1u;
    if (!exponent) {
        if (!fraction) {
            *significand = 0u;
            *sign_exponent = (pl_u16)(sign << 15u);
            *tag = 1u;
            return;
        }
        u32 most = 63u - (u32)__builtin_clzll(fraction);
        i64 unbiased = 1 - (i64)exponent_bias
                     - (i64)fraction_bits + (i64)most;
        *significand = fraction << (63u - most);
        *sign_exponent = (pl_u16)((sign << 15u)
                       | (u32)(unbiased + 0x3fffu));
        *tag = 0u;
        return;
    }
    if (exponent == (1u << exponent_bits) - 1u) {
        *significand = (1ull << 63u)
                     | (fraction << (63u - fraction_bits));
        *sign_exponent = (pl_u16)((sign << 15u) | 0x7fffu);
        *tag = 2u;
        return;
    }
    *significand = ((1ull << fraction_bits) | fraction)
                 << (63u - fraction_bits);
    *sign_exponent = (pl_u16)((sign << 15u)
                   | (exponent - exponent_bias + 0x3fffu));
    *tag = 0u;
}

static u32 x86_x87_classify(u64 significand, pl_u16 sign_exponent)
{
    u32 exponent = sign_exponent & 0x7fffu;
    if (!exponent && !significand) return 1u;
    if (exponent && exponent != 0x7fffu
            && (significand & (1ull << 63u))) return 0u;
    return 2u;
}

static int x86_x87_to_integer(
        const X86Workspace *x86, u32 physical, u32 bits, u32 truncate,
        u64 *encoded, u32 *exceptions, u32 *rounded_up)
{
    *exceptions = 0u;
    *rounded_up = 0u;
    pl_u16 sign_exponent = x86->x87_sign_exponent[physical];
    u32 exponent = sign_exponent & 0x7fffu;
    u32 sign = sign_exponent >> 15u;
    u64 significand = x86->x87_significand[physical];
    if (x86_x87_tag(x86, physical) == 3u || exponent == 0x7fffu
            || (exponent && !(significand & (1ull << 63u)))) {
        *exceptions = 1u;
        *encoded = 1ull << (bits - 1u);
        return 1;
    }

    i64 scale = exponent ? (i64)exponent - 0x3fffu : -0x3ffe;
    u64 magnitude = 0u;
    u64 remainder = 0u;
    u32 shift = 0u;
    if (scale > 63) {
        *exceptions = 1u;
        *encoded = 1ull << (bits - 1u);
        return 1;
    }
    if (scale < 0) {
        remainder = significand;
        shift = scale == -1 ? 64u : 65u;
    } else {
        shift = 63u - (u32)scale;
        magnitude = shift ? significand >> shift : significand;
        remainder = shift ? significand & ((1ull << shift) - 1u) : 0u;
    }
    if (remainder) {
        *exceptions |= 1u << 5u;
        u32 mode = truncate ? 3u : ((u32)x86->x87_control >> 10u) & 3u;
        int increment = 0;
        if (mode == 0u) {
            if (scale == -1) {
                u64 half = 1ull << 63u;
                increment = remainder > half
                         || (remainder == half && (magnitude & 1u));
            } else if (scale >= 0 && shift) {
                u64 half = 1ull << (shift - 1u);
                increment = remainder > half
                         || (remainder == half && (magnitude & 1u));
            }
        } else if (mode == 1u) increment = sign != 0u;
        else if (mode == 2u) increment = sign == 0u;
        if (increment) {
            ++magnitude;
            *rounded_up = 1u;
        }
    }
    u64 negative_limit = 1ull << (bits - 1u);
    u64 positive_limit = negative_limit - 1u;
    if ((!sign && magnitude > positive_limit)
            || (sign && magnitude > negative_limit)) {
        *exceptions = 1u;
        *encoded = negative_limit;
        return 1;
    }
    u64 mask = bits == 64u ? ~0ull : (1ull << bits) - 1u;
    *encoded = (sign ? 0u - magnitude : magnitude) & mask;
    return 0;
}

static u64 x86_x87_to_binary(
        const X86Workspace *x86, u32 physical, u32 width,
        u32 *exceptions, u32 *rounded_up)
{
    *exceptions = 0u;
    *rounded_up = 0u;
    pl_u16 sign_exponent = x86->x87_sign_exponent[physical];
    u32 exponent = sign_exponent & 0x7fffu;
    u32 sign = sign_exponent >> 15u;
    u64 significand = x86->x87_significand[physical];
    u64 fraction = significand & 0x7fffffffffffffffull;
    u32 fraction_bits = width == 4u ? 23u : 52u;
    u32 exponent_bits = width == 4u ? 8u : 11u;
    u32 exponent_bias = width == 4u ? 127u : 1023u;
    u32 exponent_max = (1u << exponent_bits) - 1u;
    u32 sign_at = fraction_bits + exponent_bits;
    int invalid = exponent && !(significand >> 63u);
    int nan = exponent == 0x7fffu && fraction;
    int snan = nan && !(significand & (1ull << 62u));
    if (invalid) {
        *exceptions |= 1u;
        return ((u64)sign << sign_at)
             | ((u64)exponent_max << fraction_bits)
             | (1ull << (fraction_bits - 1u));
    }
    if (nan) {
        if (snan) *exceptions |= 1u;
        u64 payload = fraction >> (63u - fraction_bits);
        payload |= 1ull << (fraction_bits - 1u);
        return ((u64)sign << sign_at)
             | ((u64)exponent_max << fraction_bits) | payload;
    }
    if (exponent == 0x7fffu)
        return ((u64)sign << sign_at)
             | ((u64)exponent_max << fraction_bits);
    if (!exponent) {
        significand = fraction;
        if (significand) *exceptions |= 1u << 1u;
    }
    if (!significand) return (u64)sign << sign_at;

    i64 unbiased;
    if (exponent) unbiased = (i64)exponent - 0x3fffu;
    else {
        u32 normalize = (u32)__builtin_clzll(significand);
        significand <<= normalize;
        unbiased = 1 - 0x3fff - (i64)normalize;
    }
    i64 biased = unbiased + exponent_bias;
    u32 precision = fraction_bits + 1u;
    i64 discard_signed = 64 - (i64)precision
                       + (biased <= 0 ? 1 - biased : 0);
    u32 discard = discard_signed > 64 ? 65u : (u32)discard_signed;
    u64 retained = discard >= 64u ? 0u : significand >> discard;
    u64 remainder = discard >= 64u
                  ? significand
                  : significand & ((1ull << discard) - 1u);
    int increment = 0;
    if (remainder) {
        *exceptions |= 1u << 5u;
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        if (mode == 0u && discard <= 64u) {
            u64 half = 1ull << (discard - 1u);
            increment = remainder > half
                     || (remainder == half && (retained & 1u));
        } else if (mode == 1u) increment = sign != 0u;
        else if (mode == 2u) increment = sign == 0u;
    }
    if (increment) {
        ++retained;
        *rounded_up = 1u;
    }
    u64 precision_limit = 1ull << precision;
    if (retained >= precision_limit) {
        retained >>= 1u;
        ++biased;
    }
    if (biased >= exponent_max) {
        *exceptions |= (1u << 3u) | (1u << 5u);
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        int infinity = mode == 0u
                    || (mode == 1u && sign)
                    || (mode == 2u && !sign);
        u64 encoded_exponent = infinity ? exponent_max : exponent_max - 1u;
        u64 encoded_fraction = infinity ? 0u : (1ull << fraction_bits) - 1u;
        return ((u64)sign << sign_at)
             | (encoded_exponent << fraction_bits) | encoded_fraction;
    }
    u32 result_exp = biased > 0 ? (u32)biased : 0u;
    if (!result_exp && (retained & (1ull << fraction_bits))) result_exp = 1u;
    if (!result_exp && remainder) *exceptions |= 1u << 4u;
    u64 encoded_fraction = retained & ((1ull << fraction_bits) - 1u);
    return ((u64)sign << sign_at)
         | ((u64)result_exp << fraction_bits) | encoded_fraction;
}

static int x86_x87_write_raw_prepared(
        X86Workspace *x86, u64 address, const u8 *bytes,
        u32 width, int user)
{
    int written = x86_virtual_write(address, bytes, width, user);
    if (!written) {
        x86->direct_memory_result = pl_vm_result_make(
            PL_VM_BARRIER, x86->physical_status);
        return 0;
    }
    if (written < 0) {
        x86_direct_page_fault(x86, address, 1, 0, written == -2);
        return 0;
    }
    return 1;
}

static int x86_x87_write_raw(
        X86Workspace *x86, u64 address, const u8 *bytes,
        u32 width, int user)
{
    return x86_direct_access_ready(x86, address, width, 1, user)
        && x86_x87_write_raw_prepared(x86, address, bytes, width, user);
}

static int x86_x87_write_integer(
        X86Workspace *x86, u64 address, u64 value, u32 width, int user)
{
    u8 bytes[8];
    for (u32 index = 0u; index < width; ++index)
        bytes[index] = (u8)(value >> (index * 8u));
    return x86_x87_write_raw(x86, address, bytes, width, user);
}

/* Return greater, less, equal, unordered as 0..3.  Pseudo-denormals use
 * Intel's input rule: exponent zero is accepted and its explicit integer bit
 * is ignored.  Every other unsupported encoding is unordered with #IA. */
static u32 x86_x87_compare_values(
        u64 left_sig, pl_u16 left_se, u64 right_sig, pl_u16 right_se,
        int quiet, u32 *exceptions)
{
    u32 left_exp = left_se & 0x7fffu;
    u32 right_exp = right_se & 0x7fffu;
    u64 left_fraction = left_sig & 0x7fffffffffffffffull;
    u64 right_fraction = right_sig & 0x7fffffffffffffffull;
    int left_invalid = left_exp && !(left_sig >> 63u);
    int right_invalid = right_exp && !(right_sig >> 63u);
    int left_nan = left_exp == 0x7fffu && left_fraction;
    int right_nan = right_exp == 0x7fffu && right_fraction;
    int left_snan = left_nan && !(left_sig & (1ull << 62u));
    int right_snan = right_nan && !(right_sig & (1ull << 62u));
    if (left_invalid || right_invalid || left_nan || right_nan) {
        if (left_invalid || right_invalid || !quiet
                || left_snan || right_snan)
            *exceptions |= 1u;
        return 3u;
    }
    if (!left_exp && left_fraction) *exceptions |= 1u << 1u;
    if (!right_exp && right_fraction) *exceptions |= 1u << 1u;
    if (!left_exp) left_sig = left_fraction;
    if (!right_exp) right_sig = right_fraction;
    if (!left_sig && !right_sig) return 2u;
    u32 left_sign = left_se >> 15u;
    u32 right_sign = right_se >> 15u;
    if (left_sign != right_sign) return left_sign ? 1u : 0u;
    u32 relation;
    if (left_exp != right_exp) relation = left_exp > right_exp ? 0u : 1u;
    else if (left_sig != right_sig) relation = left_sig > right_sig ? 0u : 1u;
    else return 2u;
    return left_sign ? relation ^ 1u : relation;
}

static u128 x86_x87_low_mask(u32 bits)
{
    return bits >= 128u ? ~(u128)0 : ((u128)1u << bits) - 1u;
}

static u128 x86_x87_shift_right_jam(u128 value, u32 shift)
{
    if (!shift) return value;
    if (shift >= 128u) return value ? 1u : 0u;
    u128 discarded = value & x86_x87_low_mask(shift);
    return (value >> shift) | (discarded != 0u);
}

static u32 x86_x87_high_bit(u128 value)
{
    U128Words words = { .value = value };
    return words.words.high
         ? 127u - (u32)__builtin_clzll(words.words.high)
         : 63u - (u32)__builtin_clzll(words.words.low);
}

static void x86_x87_default_nan(X86Workspace *x86, u32 physical)
{
    x86->x87_significand[physical] = 0xc000000000000000ull;
    x86->x87_sign_exponent[physical] = 0xffffu;
    x86_x87_set_tag(x86, physical, 2u);
}

static void x86_x87_add_value(
        X86Workspace *x86, u32 physical, u64 right_sig,
        pl_u16 right_se, u32 right_tag, u32 *exceptions)
{
    pl_u16 left_se = x86->x87_sign_exponent[physical];
    u32 left_exp = left_se & 0x7fffu;
    u32 right_exp = right_se & 0x7fffu;
    u64 left_sig = x86->x87_significand[physical];
    u64 left_fraction = left_sig & 0x7fffffffffffffffull;
    u64 right_fraction = right_sig & 0x7fffffffffffffffull;
    int left_invalid = left_exp && !(left_sig >> 63u);
    int right_invalid = right_exp && !(right_sig >> 63u);
    int left_nan = left_exp == 0x7fffu && left_fraction;
    int right_nan = right_exp == 0x7fffu && right_fraction;
    int left_snan = left_nan && !(left_sig & (1ull << 62u));
    int right_snan = right_nan && !(right_sig & (1ull << 62u));
    if (left_invalid || right_invalid) {
        *exceptions |= 1u;
        x86_x87_default_nan(x86, physical);
        return;
    }
    if (left_nan || right_nan) {
        if (left_snan || right_snan) *exceptions |= 1u;
        u64 chosen_sig = left_nan ? left_sig : right_sig;
        pl_u16 chosen_se = left_nan ? left_se : right_se;
        if (left_nan && right_nan
                && (right_sig > left_sig
                    || (right_sig == left_sig && !(right_se >> 15u)))) {
            chosen_sig = right_sig;
            chosen_se = right_se;
        }
        x86->x87_significand[physical] = chosen_sig | (1ull << 62u);
        x86->x87_sign_exponent[physical] = chosen_se;
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    u32 left_sign = left_se >> 15u;
    u32 right_sign = right_se >> 15u;
    int left_inf = left_exp == 0x7fffu;
    int right_inf = right_exp == 0x7fffu;
    if (left_inf || right_inf) {
        if (left_inf && right_inf && left_sign != right_sign) {
            *exceptions |= 1u;
            x86_x87_default_nan(x86, physical);
            return;
        }
        u32 sign = left_inf ? left_sign : right_sign;
        x86->x87_significand[physical] = 1ull << 63u;
        x86->x87_sign_exponent[physical] =
            (pl_u16)((sign << 15u) | 0x7fffu);
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    if (!left_exp) {
        left_sig = left_fraction;
        if (left_sig) *exceptions |= 1u << 1u;
    }
    if (!right_exp) {
        right_sig = right_fraction;
        if (right_sig) *exceptions |= 1u << 1u;
    }
    if (!left_sig && !right_sig) {
        u32 sign = left_sign == right_sign ? left_sign
                 : (((u32)x86->x87_control >> 10u) & 3u) == 1u;
        x86->x87_significand[physical] = 0u;
        x86->x87_sign_exponent[physical] = (pl_u16)(sign << 15u);
        x86_x87_set_tag(x86, physical, 1u);
        return;
    }
    if (!left_sig || !right_sig) {
        if (!left_sig) {
            x86->x87_significand[physical] = right_sig;
            x86->x87_sign_exponent[physical] = right_se;
            x86_x87_set_tag(x86, physical, right_tag);
        }
        return;
    }

    i64 left_unbiased;
    i64 right_unbiased;
    if (left_exp) left_unbiased = (i64)left_exp - 0x3fffu;
    else {
        u32 shift = (u32)__builtin_clzll(left_sig);
        left_sig <<= shift;
        left_unbiased = 1 - 0x3fff - (i64)shift;
    }
    if (right_exp) right_unbiased = (i64)right_exp - 0x3fffu;
    else {
        u32 shift = (u32)__builtin_clzll(right_sig);
        right_sig <<= shift;
        right_unbiased = 1 - 0x3fff - (i64)shift;
    }
    u128 left = (u128)left_sig << 63u;
    u128 right = (u128)right_sig << 63u;
    i64 exponent = left_unbiased;
    if (left_unbiased > right_unbiased)
        right = x86_x87_shift_right_jam(
            right, (u32)(left_unbiased - right_unbiased > 128
                       ? 128 : left_unbiased - right_unbiased));
    else if (right_unbiased > left_unbiased) {
        left = x86_x87_shift_right_jam(
            left, (u32)(right_unbiased - left_unbiased > 128
                      ? 128 : right_unbiased - left_unbiased));
        exponent = right_unbiased;
    }
    u32 sign = left_sign;
    u128 result;
    if (left_sign == right_sign) result = left + right;
    else if (left > right) result = left - right;
    else if (right > left) {
        result = right - left;
        sign = right_sign;
    } else {
        sign = (((u32)x86->x87_control >> 10u) & 3u) == 1u;
        x86->x87_significand[physical] = 0u;
        x86->x87_sign_exponent[physical] = (pl_u16)(sign << 15u);
        x86_x87_set_tag(x86, physical, 1u);
        return;
    }
    u32 high = x86_x87_high_bit(result);
    i64 biased = exponent + (i64)high - 126 + 0x3fff;
    u32 precision_code = ((u32)x86->x87_control >> 8u) & 3u;
    u32 precision = precision_code == 0u ? 24u
                  : precision_code == 2u ? 53u : 64u;
    i64 discard_signed = (i64)high + 1 - (i64)precision
                       + (biased <= 0 ? 1 - biased : 0);
    u128 retained;
    u128 remainder = 0u;
    u32 discard = 0u;
    if (discard_signed <= 0) {
        retained = result << (u32)-discard_signed;
    } else {
        discard = discard_signed > 128 ? 129u : (u32)discard_signed;
        retained = discard >= 128u ? 0u : result >> discard;
        remainder = result & x86_x87_low_mask(discard);
    }
    int increment = 0;
    if (remainder) {
        *exceptions |= 1u << 5u;
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        if (mode == 0u && discard <= 128u) {
            u128 half = (u128)1u << (discard - 1u);
            increment = remainder > half
                     || (remainder == half && (retained & 1u));
        } else if (mode == 1u) increment = sign != 0u;
        else if (mode == 2u) increment = sign == 0u;
    }
    if (increment) ++retained;
    u128 precision_limit = (u128)1u << precision;
    if (retained >= precision_limit) {
        retained >>= 1u;
        ++biased;
    }
    if (biased >= 0x7fff) {
        *exceptions |= (1u << 3u) | (1u << 5u);
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        int infinity = mode == 0u
                    || (mode == 1u && sign)
                    || (mode == 2u && !sign);
        x86->x87_significand[physical] = infinity
            ? 1ull << 63u
            : (u64)(precision_limit - 1u) << (64u - precision);
        x86->x87_sign_exponent[physical] = (pl_u16)((sign << 15u)
            | (infinity ? 0x7fffu : 0x7ffeu));
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    u64 encoded = (u64)retained << (64u - precision);
    u32 result_exp = biased > 0 ? (u32)biased : 0u;
    if (!result_exp && (encoded & (1ull << 63u))) result_exp = 1u;
    if (!result_exp && remainder) *exceptions |= 1u << 4u;
    x86->x87_significand[physical] = encoded;
    x86->x87_sign_exponent[physical] =
        (pl_u16)((sign << 15u) | result_exp);
    x86_x87_set_tag(
        x86, physical, !encoded ? 1u : !result_exp ? 2u : 0u);
    x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                    | ((pl_u16)increment << 9u));
}

/* Multiply ST(0) by an exact signed integer in the canonical 80-bit bank.
 * The product stays in a 128-bit physical lane until one control-word
 * rounding projection publishes significand/exponent. */
static void x86_x87_multiply_value(
        X86Workspace *x86, u32 physical, u64 right_sig,
        pl_u16 right_se, u32 right_tag, u32 *exceptions)
{
    pl_u16 left_se = x86->x87_sign_exponent[physical];
    u32 left_exp = left_se & 0x7fffu;
    u32 sign = left_se >> 15u;
    u64 left_sig = x86->x87_significand[physical];
    u64 fraction = left_sig & 0x7fffffffffffffffull;
    u32 right_exp = right_se & 0x7fffu;
    u64 right_fraction = right_sig & 0x7fffffffffffffffull;
    sign ^= right_se >> 15u;

    int left_invalid = left_exp && !(left_sig >> 63u);
    int right_invalid = right_exp && !(right_sig >> 63u);
    int left_nan = left_exp == 0x7fffu && fraction;
    int right_nan = right_exp == 0x7fffu && right_fraction;
    int left_snan = left_nan && !(left_sig & (1ull << 62u));
    int right_snan = right_nan && !(right_sig & (1ull << 62u));
    if (left_invalid || right_invalid
            || (left_exp == 0x7fffu && !fraction && right_tag == 1u)
            || (right_exp == 0x7fffu && !right_fraction
                && x86_x87_tag(x86, physical) == 1u)) {
        *exceptions |= 1u;
        x86_x87_default_nan(x86, physical);
        return;
    }
    if (left_nan || right_nan) {
        if (left_snan || right_snan) *exceptions |= 1u;
        u64 chosen_sig = left_nan ? left_sig : right_sig;
        pl_u16 chosen_se = left_nan ? left_se : right_se;
        if (left_nan && right_nan
                && (right_sig > left_sig
                    || (right_sig == left_sig && !(right_se >> 15u)))) {
            chosen_sig = right_sig;
            chosen_se = right_se;
        }
        x86->x87_significand[physical] = chosen_sig | (1ull << 62u);
        x86->x87_sign_exponent[physical] = chosen_se;
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    if (left_exp == 0x7fffu || right_exp == 0x7fffu) {
        x86->x87_significand[physical] = 1ull << 63u;
        x86->x87_sign_exponent[physical] =
            (pl_u16)((sign << 15u) | 0x7fffu);
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    if (!left_exp) {
        left_sig = fraction;
        if (left_sig) *exceptions |= 1u << 1u;
    }
    if (!right_exp) {
        right_sig = right_fraction;
        if (right_sig) *exceptions |= 1u << 1u;
    }
    if (!left_sig || right_tag == 1u) {
        x86->x87_significand[physical] = 0u;
        x86->x87_sign_exponent[physical] = (pl_u16)(sign << 15u);
        x86_x87_set_tag(x86, physical, 1u);
        return;
    }

    i64 left_unbiased;
    if (left_exp) left_unbiased = (i64)left_exp - 0x3fffu;
    else {
        u32 normalize = (u32)__builtin_clzll(left_sig);
        left_sig <<= normalize;
        left_unbiased = 1 - 0x3fff - (i64)normalize;
    }
    i64 right_unbiased;
    if (right_exp) right_unbiased = (i64)right_exp - 0x3fffu;
    else {
        u32 normalize = (u32)__builtin_clzll(right_sig);
        right_sig <<= normalize;
        right_unbiased = 1 - 0x3fff - (i64)normalize;
    }
    u128 product = (u128)left_sig * right_sig;
    u32 carry = (u32)(product >> 127u);
    u32 base_shift = carry ? 64u : 63u;
    i64 exponent = left_unbiased + right_unbiased + carry;
    i64 biased = exponent + 0x3fffu;
    u32 precision_code = ((u32)x86->x87_control >> 8u) & 3u;
    u32 precision = precision_code == 0u ? 24u
                  : precision_code == 2u ? 53u : 64u;
    i64 subnormal_shift = biased <= 0 ? 1 - biased : 0;
    i64 discard_signed = (i64)base_shift + (64 - (i64)precision)
                       + subnormal_shift;
    u32 discard = discard_signed > 128 ? 129u : (u32)discard_signed;
    u128 retained = discard >= 128u ? 0u : product >> discard;
    u128 remainder = product & x86_x87_low_mask(discard);
    int increment = 0;
    if (remainder) {
        *exceptions |= 1u << 5u;
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        if (mode == 0u && discard <= 128u) {
            u128 half = (u128)1u << (discard - 1u);
            increment = remainder > half
                     || (remainder == half && (retained & 1u));
        } else if (mode == 1u) increment = sign != 0u;
        else if (mode == 2u) increment = sign == 0u;
    }
    if (increment) ++retained;
    u128 precision_limit = (u128)1u << precision;
    if (retained >= precision_limit) {
        retained >>= 1u;
        ++biased;
    }

    if (biased >= 0x7fff) {
        *exceptions |= (1u << 3u) | (1u << 5u);
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        int infinity = mode == 0u
                    || (mode == 1u && sign)
                    || (mode == 2u && !sign);
        x86->x87_significand[physical] = infinity
            ? 1ull << 63u
            : (u64)(precision_limit - 1u) << (64u - precision);
        x86->x87_sign_exponent[physical] = (pl_u16)((sign << 15u)
            | (infinity ? 0x7fffu : 0x7ffeu));
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }

    u64 result = (u64)retained << (64u - precision);
    u32 result_exp = biased > 0 ? (u32)biased : 0u;
    if (!result_exp && (result & (1ull << 63u))) result_exp = 1u;
    if (!result_exp && remainder) *exceptions |= 1u << 4u;
    x86->x87_significand[physical] = result;
    x86->x87_sign_exponent[physical] =
        (pl_u16)((sign << 15u) | result_exp);
    x86_x87_set_tag(
        x86, physical, !result ? 1u : !result_exp ? 2u : 0u);
    x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                    | ((pl_u16)increment << 9u));
}

/* Divide a 128-bit numerator by a normalized 64-bit denominator when the
 * quotient is known to fit in one u64.  Knuth's two base-2^32 digits keep
 * span bounded; no 64-step bit loop or compiler-rt division is introduced. */
static u64 x86_divide_128_64(
        u64 high, u64 low, u64 denominator, u64 *remainder)
{
    const u64 base = 1ull << 32u;
    u32 shift = (u32)__builtin_clzll(denominator);
    u64 normalized = denominator << shift;
    u64 high_digit = normalized >> 32u;
    u64 low_digit = (u32)normalized;
    u64 upper = shift
              ? (high << shift) | (low >> (64u - shift)) : high;
    u64 lower = low << shift;
    u64 middle = lower >> 32u;
    u64 bottom = (u32)lower;

    u64 quotient_high = upper / high_digit;
    u64 estimate = upper - quotient_high * high_digit;
    for (u32 correction = 0u; correction < 2u; ++correction) {
        if (quotient_high < base
                && quotient_high * low_digit
                   <= base * estimate + middle) break;
        --quotient_high;
        estimate += high_digit;
        if (estimate >= base) break;
    }
    u64 partial = upper * base + middle
                - quotient_high * normalized;
    u64 quotient_low = partial / high_digit;
    estimate = partial - quotient_low * high_digit;
    for (u32 correction = 0u; correction < 2u; ++correction) {
        if (quotient_low < base
                && quotient_low * low_digit
                   <= base * estimate + bottom) break;
        --quotient_low;
        estimate += high_digit;
        if (estimate >= base) break;
    }
    u64 normalized_remainder = partial * base + bottom
                             - quotient_low * normalized;
    *remainder = shift ? normalized_remainder >> shift
                       : normalized_remainder;
    return quotient_high * base + quotient_low;
}

/* The binary64 square root supplies only a bounded initial estimate.  One
 * exact Newton quotient and integer-square comparisons recover the complete
 * 64-bit root, so x87 precision and exception state never depend on binary64
 * rounding. */
static u64 x86_x87_sqrt_floor(
        u64 significand, u32 exponent_odd, u128 *radicand_out)
{
    u128 radicand = (u128)significand << (63u + exponent_odd);
    union { double value; u64 bits; } seed = {
        .value = __builtin_sqrt(
            (double)significand
            * (exponent_odd ? 0x1p-62 : 0x1p-63))
    };
    u32 seed_exponent = (u32)(seed.bits >> 52u) & 0x7ffu;
    u64 estimate = seed_exponent >= 0x400u
                 ? ~0ull
                 : ((1ull << 52u)
                    | (seed.bits & 0x000fffffffffffffull)) << 11u;
    U128Words words = { .value = radicand };
    u64 remainder;
    u64 quotient = words.words.high >= estimate
                 ? ~0ull
                 : x86_divide_128_64(
                    words.words.high, words.words.low,
                    estimate, &remainder);
    u64 candidate = (estimate & quotient)
                  + ((estimate ^ quotient) >> 1u);

    /* A correctly rounded binary64 seed is within 2^12 at this scale; the
     * exact Newton step leaves at most two integer corrections.  Keeping the
     * bound explicit prevents a data-dependent digit-at-a-time loop. */
    for (u32 correction = 0u; correction < 2u; ++correction) {
        if ((u128)candidate * candidate <= radicand) break;
        --candidate;
    }
    for (u32 correction = 0u; correction < 2u; ++correction) {
        if (candidate == ~0ull
                || (u128)(candidate + 1u) * (candidate + 1u) > radicand)
            break;
        ++candidate;
    }
    *radicand_out = radicand;
    return candidate;
}

static int x86_x87_sqrt(X86Workspace *x86, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 exceptions = 0u;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;
    if (x86_x87_tag(x86, top) == 3u) {
        x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                        & ~(1u << 9u));
        if (!x86_x87_exception(x86, 1u))
            x86_x87_default_nan(x86, top);
        return 1;
    }

    u64 significand = x86->x87_significand[top];
    pl_u16 sign_exponent = x86->x87_sign_exponent[top];
    u32 exponent = sign_exponent & 0x7fffu;
    u32 sign = sign_exponent >> 15u;
    u64 fraction = significand & 0x7fffffffffffffffull;
    if (sign) {
        x86->x87_status &= ~0x4700u;
        x86->x87_status |= 0x0400u;
    }
    if (exponent && !(significand >> 63u)) {
        if (!x86_x87_exception(x86, 1u))
            x86_x87_default_nan(x86, top);
        return 1;
    }
    if (exponent == 0x7fffu && fraction) {
        if (!(significand & (1ull << 62u))) exceptions = 1u;
        if (!x86_x87_exception(x86, exceptions)) {
            x86->x87_significand[top] = significand | (1ull << 62u);
            x86_x87_set_tag(x86, top, 2u);
        }
        return 1;
    }
    if (sign && significand) {
        if (!x86_x87_exception(x86, 1u))
            x86_x87_default_nan(x86, top);
        return 1;
    }
    if (exponent == 0x7fffu || !significand) return 1;

    i64 unbiased;
    if (!exponent) {
        exceptions |= 1u << 1u;
        u32 normalize = (u32)__builtin_clzll(significand);
        significand <<= normalize;
        unbiased = 1 - 0x3fff - (i64)normalize;
    } else {
        unbiased = (i64)exponent - 0x3fffu;
    }
    u32 exponent_odd = (u32)unbiased & 1u;
    i64 result_unbiased = (unbiased - (i64)exponent_odd) / 2;
    u128 radicand;
    u64 root = x86_x87_sqrt_floor(
        significand, exponent_odd, &radicand);
    u32 precision_code = ((u32)x86->x87_control >> 8u) & 3u;
    u32 precision = precision_code == 0u ? 24u
                  : precision_code == 2u ? 53u : 64u;
    u32 discard = 64u - precision;
    u64 unit = discard ? 1ull << discard : 1u;
    u64 result = discard ? root & ~(unit - 1u) : root;
    u128 result_square = (u128)result * result;
    int inexact = result_square != radicand;
    int increment = 0;
    if (inexact) {
        u32 rounding = ((u32)x86->x87_control >> 10u) & 3u;
        if (!rounding) {
            if (!discard) {
                increment = radicand - result_square > result;
            } else {
                u64 midpoint = result + (unit >> 1u);
                u128 midpoint_square = (u128)midpoint * midpoint;
                increment = radicand > midpoint_square
                         || (radicand == midpoint_square
                             && ((result >> discard) & 1u));
            }
        } else if (rounding == 2u) {
            increment = 1;
        }
        exceptions |= 1u << 5u;
    }
    if (increment) {
        u64 rounded = result + unit;
        if (rounded < result) {
            result = 1ull << 63u;
            ++result_unbiased;
        } else {
            result = rounded;
        }
    }
    if (!x86_x87_exception(x86, exceptions)) {
        x86->x87_significand[top] = result;
        x86->x87_sign_exponent[top] =
            (pl_u16)(result_unbiased + 0x3fffu);
        x86_x87_set_tag(x86, top, 0u);
    }
    return 1;
}

static void x86_x87_set_scaled_remainder(
        X86Workspace *x86, u32 physical, u64 magnitude,
        i64 base_unbiased, u32 sign)
{
    if (!magnitude) {
        x86->x87_significand[physical] = 0u;
        x86->x87_sign_exponent[physical] = (pl_u16)(sign << 15u);
        x86_x87_set_tag(x86, physical, 1u);
        return;
    }
    u32 normalize = (u32)__builtin_clzll(magnitude);
    u64 significand = magnitude << normalize;
    i64 unbiased = base_unbiased - (i64)normalize;
    if (unbiased >= -16382) {
        x86->x87_significand[physical] = significand;
        x86->x87_sign_exponent[physical] =
            (pl_u16)((sign << 15u) | (u32)(unbiased + 0x3fffu));
        x86_x87_set_tag(x86, physical, 0u);
        return;
    }
    i64 shift_signed = -16382 - unbiased;
    u32 shift = shift_signed >= 64 ? 64u : (u32)shift_signed;
    u64 subnormal = shift == 64u ? 0u : significand >> shift;
    x86->x87_significand[physical] = subnormal;
    x86->x87_sign_exponent[physical] = (pl_u16)(sign << 15u);
    x86_x87_set_tag(x86, physical, subnormal ? 2u : 1u);
}

static int x86_x87_remainder(X86Workspace *x86, u32 nearest, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 other = (top + 1u) & 7u;
    u64 original_sig = x86->x87_significand[top];
    pl_u16 original_se = x86->x87_sign_exponent[top];
    u32 original_tag = x86_x87_tag(x86, top);
    u32 exceptions = 0u;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;
    x86->x87_status &= ~0x4700u;
    if (original_tag == 3u || x86_x87_tag(x86, other) == 3u) {
        x86->x87_status |= 1u << 6u;
        if (!x86_x87_exception(x86, 1u))
            x86_x87_default_nan(x86, top);
        return 1;
    }

    u64 left_sig = original_sig;
    pl_u16 left_se = original_se;
    u32 left_exp = left_se & 0x7fffu;
    u32 left_sign = left_se >> 15u;
    u64 left_fraction = left_sig & 0x7fffffffffffffffull;
    u64 right_sig = x86->x87_significand[other];
    pl_u16 right_se = x86->x87_sign_exponent[other];
    u32 right_exp = right_se & 0x7fffu;
    u32 right_sign = right_se >> 15u;
    u64 right_fraction = right_sig & 0x7fffffffffffffffull;
    int left_invalid = left_exp && !(left_sig >> 63u);
    int right_invalid = right_exp && !(right_sig >> 63u);
    int left_nan = left_exp == 0x7fffu && left_fraction;
    int right_nan = right_exp == 0x7fffu && right_fraction;
    int left_snan = left_nan && !(left_sig & (1ull << 62u));
    int right_snan = right_nan && !(right_sig & (1ull << 62u));
    if (left_invalid || right_invalid) {
        x86_x87_default_nan(x86, top);
        exceptions = 1u;
    } else if (left_nan || right_nan) {
        if (left_snan || right_snan) exceptions = 1u;
        u64 chosen_sig = left_nan ? left_sig : right_sig;
        pl_u16 chosen_se = left_nan ? left_se : right_se;
        if (left_nan && right_nan
                && (right_sig > left_sig
                    || (right_sig == left_sig && !(right_se >> 15u)))) {
            chosen_sig = right_sig;
            chosen_se = right_se;
        }
        x86->x87_significand[top] = chosen_sig | (1ull << 62u);
        x86->x87_sign_exponent[top] = chosen_se;
        x86_x87_set_tag(x86, top, 2u);
    } else if ((left_exp == 0x7fffu && !left_fraction) || !right_sig) {
        x86_x87_default_nan(x86, top);
        exceptions = 1u;
    } else if ((right_exp == 0x7fffu && !right_fraction) || !left_sig) {
        /* Finite modulo infinity and signed zero modulo finite are already
         * the exact result; all quotient condition bits remain clear. */
    } else {
        i64 left_unbiased;
        i64 right_unbiased;
        if (!left_exp) {
            exceptions |= 1u << 1u;
            u32 normalize = (u32)__builtin_clzll(left_sig);
            left_sig <<= normalize;
            left_unbiased = 1 - 0x3fff - (i64)normalize;
        } else {
            left_unbiased = (i64)left_exp - 0x3fffu;
        }
        if (!right_exp) {
            exceptions |= 1u << 1u;
            u32 normalize = (u32)__builtin_clzll(right_sig);
            right_sig <<= normalize;
            right_unbiased = 1 - 0x3fff - (i64)normalize;
        } else {
            right_unbiased = (i64)right_exp - 0x3fffu;
        }
        i64 exponent_difference = left_unbiased - right_unbiased;
        u64 quotient = 0u;
        u64 remainder = left_sig;
        i64 remainder_base = left_unbiased;
        u32 result_sign = left_sign;
        int partial = exponent_difference >= 64;
        if (exponent_difference >= 0) {
            u32 quotient_bits = partial
                ? 32u + ((u32)exponent_difference & 31u)
                : (u32)exponent_difference;
            u128 numerator = (u128)left_sig << quotient_bits;
            U128Words words = { .value = numerator };
            quotient = x86_divide_128_64(
                words.words.high, words.words.low, right_sig, &remainder);
            remainder_base = left_unbiased - (i64)quotient_bits;
            if (nearest && !partial && remainder) {
                int increment = remainder > right_sig - remainder
                             || (remainder == right_sig - remainder
                                 && (quotient & 1u));
                if (increment) {
                    ++quotient;
                    remainder = right_sig - remainder;
                    result_sign ^= 1u;
                }
            }
            x86_x87_set_scaled_remainder(
                x86, top, remainder, remainder_base, result_sign);
        } else if (nearest && exponent_difference == -1
                   && left_sig > right_sig) {
            quotient = 1u;
            remainder = right_sig - (left_sig - right_sig);
            result_sign ^= 1u;
            x86_x87_set_scaled_remainder(
                x86, top, remainder, left_unbiased, result_sign);
        }
        if (partial) {
            x86->x87_status |= 1u << 10u;
        } else {
            u64 encoded_quotient = left_sign == right_sign
                                  ? quotient : 0u - quotient;
            x86->x87_status |= (pl_u16)(((encoded_quotient >> 2u) & 1u) << 8u);
            x86->x87_status |= (pl_u16)(((encoded_quotient >> 1u) & 1u) << 14u);
            x86->x87_status |= (pl_u16)((encoded_quotient & 1u) << 9u);
        }
    }
    if (x86_x87_exception(x86, exceptions)) {
        x86->x87_significand[top] = original_sig;
        x86->x87_sign_exponent[top] = original_se;
        x86_x87_set_tag(x86, top, original_tag);
    }
    return 1;
}

static int x86_x87_sign(X86Workspace *x86, u32 absolute, u32 fop)
{
    u32 top = x86_x87_top(x86);
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;
    x86->x87_status &= (pl_u16)~(1u << 9u);
    if (x86_x87_tag(x86, top) == 3u) {
        x86->x87_status |= 1u << 6u;
        if (!x86_x87_exception(x86, 1u))
            x86_x87_default_nan(x86, top);
        return 1;
    }
    if (absolute) x86->x87_sign_exponent[top] &= 0x7fffu;
    else x86->x87_sign_exponent[top] ^= 0x8000u;
    return 1;
}

static void x86_x87_divide_value(
        X86Workspace *x86, u32 physical, u64 right_sig,
        pl_u16 right_se, u32 right_tag, u32 *exceptions)
{
    pl_u16 left_se = x86->x87_sign_exponent[physical];
    u32 left_exp = left_se & 0x7fffu;
    u32 right_exp = right_se & 0x7fffu;
    u32 sign = (left_se ^ right_se) >> 15u;
    u64 left_sig = x86->x87_significand[physical];
    u64 left_fraction = left_sig & 0x7fffffffffffffffull;
    u64 right_fraction = right_sig & 0x7fffffffffffffffull;
    int left_invalid = left_exp && !(left_sig >> 63u);
    int right_invalid = right_exp && !(right_sig >> 63u);
    int left_nan = left_exp == 0x7fffu && left_fraction;
    int right_nan = right_exp == 0x7fffu && right_fraction;
    int left_snan = left_nan && !(left_sig & (1ull << 62u));
    int right_snan = right_nan && !(right_sig & (1ull << 62u));
    if (left_invalid || right_invalid) {
        *exceptions |= 1u;
        x86_x87_default_nan(x86, physical);
        return;
    }
    if (left_nan || right_nan) {
        if (left_snan || right_snan) *exceptions |= 1u;
        u64 chosen_sig = left_nan ? left_sig : right_sig;
        pl_u16 chosen_se = left_nan ? left_se : right_se;
        if (left_nan && right_nan
                && (right_sig > left_sig
                    || (right_sig == left_sig && !(right_se >> 15u)))) {
            chosen_sig = right_sig;
            chosen_se = right_se;
        }
        x86->x87_significand[physical] = chosen_sig | (1ull << 62u);
        x86->x87_sign_exponent[physical] = chosen_se;
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    int left_inf = left_exp == 0x7fffu;
    int right_inf = right_exp == 0x7fffu;
    int left_zero = x86_x87_tag(x86, physical) == 1u;
    int right_zero = right_tag == 1u;
    if ((left_inf && right_inf) || (left_zero && right_zero)) {
        *exceptions |= 1u;
        x86_x87_default_nan(x86, physical);
        return;
    }
    if (left_inf || right_zero) {
        if (right_zero && !left_inf) *exceptions |= 1u << 2u;
        x86->x87_significand[physical] = 1ull << 63u;
        x86->x87_sign_exponent[physical] =
            (pl_u16)((sign << 15u) | 0x7fffu);
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    if (left_zero || right_inf) {
        x86->x87_significand[physical] = 0u;
        x86->x87_sign_exponent[physical] = (pl_u16)(sign << 15u);
        x86_x87_set_tag(x86, physical, 1u);
        return;
    }
    if (!left_exp) {
        left_sig = left_fraction;
        *exceptions |= 1u << 1u;
    }
    if (!right_exp) {
        right_sig = right_fraction;
        *exceptions |= 1u << 1u;
    }
    i64 left_unbiased;
    i64 right_unbiased;
    if (left_exp) left_unbiased = (i64)left_exp - 0x3fffu;
    else {
        u32 normalize = (u32)__builtin_clzll(left_sig);
        left_sig <<= normalize;
        left_unbiased = 1 - 0x3fff - (i64)normalize;
    }
    if (right_exp) right_unbiased = (i64)right_exp - 0x3fffu;
    else {
        u32 normalize = (u32)__builtin_clzll(right_sig);
        right_sig <<= normalize;
        right_unbiased = 1 - 0x3fff - (i64)normalize;
    }
    int below_one = left_sig < right_sig;
    u64 high = below_one ? left_sig : left_sig >> 1u;
    u64 low = below_one ? 0u : left_sig << 63u;
    u64 division_remainder;
    u64 quotient = x86_divide_128_64(
        high, low, right_sig, &division_remainder);
    i64 biased = left_unbiased - right_unbiased
               - below_one + 0x3fffu;
    u32 precision_code = ((u32)x86->x87_control >> 8u) & 3u;
    u32 precision = precision_code == 0u ? 24u
                  : precision_code == 2u ? 53u : 64u;
    i64 discard_signed = 64 - (i64)precision
                       + (biased <= 0 ? 1 - biased : 0);
    u32 discard = discard_signed > 64 ? 65u : (u32)discard_signed;
    u128 retained = discard >= 64u ? 0u : quotient >> discard;
    u64 quotient_remainder = discard >= 64u
                           ? quotient
                           : quotient & ((1ull << discard) - 1u);
    int discarded = quotient_remainder || division_remainder;
    int increment = 0;
    if (discarded) {
        *exceptions |= 1u << 5u;
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        if (mode == 0u) {
            if (!discard) {
                increment = division_remainder
                         > right_sig - division_remainder
                         || (division_remainder
                             == right_sig - division_remainder
                             && (retained & 1u));
            } else if (discard <= 64u) {
                u64 half = 1ull << (discard - 1u);
                increment = quotient_remainder > half
                         || (quotient_remainder == half
                             && (division_remainder || (retained & 1u)));
            }
        } else if (mode == 1u) increment = sign != 0u;
        else if (mode == 2u) increment = sign == 0u;
    }
    if (increment) ++retained;
    u128 precision_limit = (u128)1u << precision;
    if (retained >= precision_limit) {
        retained >>= 1u;
        ++biased;
    }
    if (biased >= 0x7fff) {
        *exceptions |= (1u << 3u) | (1u << 5u);
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        int infinity = mode == 0u
                    || (mode == 1u && sign)
                    || (mode == 2u && !sign);
        x86->x87_significand[physical] = infinity
            ? 1ull << 63u
            : (u64)(precision_limit - 1u) << (64u - precision);
        x86->x87_sign_exponent[physical] = (pl_u16)((sign << 15u)
            | (infinity ? 0x7fffu : 0x7ffeu));
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    u64 result = (u64)retained << (64u - precision);
    u32 result_exp = biased > 0 ? (u32)biased : 0u;
    if (!result_exp && (result & (1ull << 63u))) result_exp = 1u;
    if (!result_exp && discarded) *exceptions |= 1u << 4u;
    x86->x87_significand[physical] = result;
    x86->x87_sign_exponent[physical] =
        (pl_u16)((sign << 15u) | result_exp);
    x86_x87_set_tag(
        x86, physical, !result ? 1u : !result_exp ? 2u : 0u);
    x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                    | ((pl_u16)increment << 9u));
}

static void x86_x87_store_environment(
        const X86Workspace *x86, u8 *bytes, u32 width)
{
    for (u32 index = 0u; index < width; ++index) bytes[index] = 0u;
    u32 code = (u32)x86->system[X86_SYS_CS] & 0xffffu;
    u32 data = (u32)x86->system[X86_SYS_DS] & 0xffffu;
    if (width == 14u) {
        bytes[0] = (u8)x86->x87_control;
        bytes[1] = (u8)(x86->x87_control >> 8u);
        bytes[2] = (u8)x86->x87_status;
        bytes[3] = (u8)(x86->x87_status >> 8u);
        bytes[4] = (u8)x86->x87_tag;
        bytes[5] = (u8)(x86->x87_tag >> 8u);
        bytes[6] = (u8)x86->x87_ip;
        bytes[7] = (u8)(x86->x87_ip >> 8u);
        bytes[8] = (u8)code;
        bytes[9] = (u8)(code >> 8u);
        bytes[10] = (u8)x86->x87_dp;
        bytes[11] = (u8)(x86->x87_dp >> 8u);
        bytes[12] = (u8)data;
        bytes[13] = (u8)(data >> 8u);
        return;
    }
    store_u32(bytes, x86->x87_control);
    store_u32(bytes + 4u, x86->x87_status);
    store_u32(bytes + 8u, x86->x87_tag);
    store_u32(bytes + 12u, (u32)x86->x87_ip);
    store_u32(bytes + 16u,
              code | ((u32)(x86->x87_opcode & 0x7ffu) << 16u));
    store_u32(bytes + 20u, (u32)x86->x87_dp);
    store_u32(bytes + 24u, data);
}

static void x86_x87_load_environment(
        X86Workspace *x86, const u8 *bytes, u32 width)
{
    pl_u16 status = read_u16(bytes + (width == 14u ? 2u : 4u));
    x86->x87_control = read_u16(bytes);
    x86->x87_status = (pl_u16)((status & ~0x8000u)
                    | ((status & 0x80u) ? 0x8000u : 0u));
    x86->x87_tag = read_u16(bytes + (width == 14u ? 4u : 8u));
    if (width == 14u) {
        x86->x87_ip = read_u16(bytes + 6u);
        x86->x87_dp = read_u16(bytes + 10u);
        x86->x87_opcode = 0u;
    } else {
        x86->x87_ip = read_u32(bytes + 12u);
        x86->x87_opcode = (pl_u16)((read_u32(bytes + 16u) >> 16u)
                         & 0x7ffu);
        x86->x87_dp = read_u32(bytes + 20u);
    }
    if (!(x86->x87_status & 0x80u)) x86->ferr_pending = 0u;
}

static u32 x86_x87_fx_tag(u64 significand, pl_u16 sign_exponent)
{
    u32 exponent = sign_exponent & 0x7fffu;
    if (!exponent && !significand) return 1u;
    if (!exponent || exponent == 0x7fffu || !(significand >> 63u)) return 2u;
    return 0u;
}

static int x86_x87_fxstate(
        X86Workspace *x86, u64 address, int user, int restore, int wide)
{
    if (address & 15u) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u8 bytes[512] = {0};
    if (restore) {
        if (!x86_direct_read(x86, address, bytes, sizeof bytes, user)) return 0;
        if ((x86->cr4 & (1u << 9u))
                && (read_u32(bytes + 24u) & ~0xffffu)) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        x86->x87_control = read_u16(bytes);
        pl_u16 status = read_u16(bytes + 2u);
        x86->x87_status = (pl_u16)((status & ~0x8000u)
                        | ((status & 0x80u) ? 0x8000u : 0u));
        x86->x87_opcode = (pl_u16)(read_u16(bytes + 6u) & 0x7ffu);
        x86->x87_ip = wide ? load_u64(bytes + 8u) : read_u32(bytes + 8u);
        x86->x87_dp = wide ? load_u64(bytes + 16u) : read_u32(bytes + 16u);
        u32 top = x86_x87_top(x86);
        u32 abridged = bytes[4];
        x86->x87_tag = 0xffffu;
        for (u32 logical = 0u; logical < 8u; ++logical) {
            u32 physical = (top + logical) & 7u;
            u32 at = 32u + logical * 16u;
            u64 significand = load_u64(bytes + at);
            pl_u16 sign_exponent = read_u16(bytes + at + 8u);
            x86->x87_significand[physical] = significand;
            x86->x87_sign_exponent[physical] = sign_exponent;
            if ((abridged >> physical) & 1u)
                x86_x87_set_tag(
                    x86, physical, x86_x87_fx_tag(significand, sign_exponent));
        }
        if (x86->cr4 & (1u << 9u)) {
            x86->mxcsr = read_u32(bytes + 24u);
            u32 vectors = x86->efer & (1u << 10u) ? 16u : 8u;
            for (u32 vector = 0u; vector < vectors; ++vector) {
                u32 at = 160u + vector * 16u;
                x86->xmm[vector * 2u] = load_u64(bytes + at);
                x86->xmm[vector * 2u + 1u] = load_u64(bytes + at + 8u);
            }
        }
        if (!(x86->x87_status & 0x80u)) x86->ferr_pending = 0u;
        return 1;
    }

    if (!x86_direct_access_ready(x86, address, sizeof bytes, 1, user)) return 0;
    bytes[0] = (u8)x86->x87_control;
    bytes[1] = (u8)(x86->x87_control >> 8u);
    bytes[2] = (u8)x86->x87_status;
    bytes[3] = (u8)(x86->x87_status >> 8u);
    for (u32 physical = 0u; physical < 8u; ++physical)
        if (x86_x87_tag(x86, physical) != 3u) bytes[4] |= (u8)(1u << physical);
    bytes[6] = (u8)x86->x87_opcode;
    bytes[7] = (u8)(x86->x87_opcode >> 8u);
    if (wide) {
        store_u64(bytes + 8u, x86->x87_ip);
        store_u64(bytes + 16u, x86->x87_dp);
    } else {
        store_u32(bytes + 8u, (u32)x86->x87_ip);
        store_u32(bytes + 16u, (u32)x86->x87_dp);
    }
    u32 top = x86_x87_top(x86);
    for (u32 logical = 0u; logical < 8u; ++logical) {
        u32 physical = (top + logical) & 7u;
        u32 at = 32u + logical * 16u;
        store_u64(bytes + at, x86->x87_significand[physical]);
        bytes[at + 8u] = (u8)x86->x87_sign_exponent[physical];
        bytes[at + 9u] = (u8)(x86->x87_sign_exponent[physical] >> 8u);
    }
    if (x86->cr4 & (1u << 9u)) {
        store_u32(bytes + 24u, x86->mxcsr);
        store_u32(bytes + 28u, 0xffffu);
        u32 vectors = x86->efer & (1u << 10u) ? 16u : 8u;
        for (u32 vector = 0u; vector < vectors; ++vector) {
            u32 at = 160u + vector * 16u;
            store_u64(bytes + at, x86->xmm[vector * 2u]);
            store_u64(bytes + at + 8u, x86->xmm[vector * 2u + 1u]);
        }
    }
    return x86_x87_write_raw_prepared(
        x86, address, bytes, sizeof bytes, user);
}

static void x86_x87_reset(X86Workspace *x86)
{
    x86->x87_control = 0x037fu;
    x86->x87_status = 0u;
    x86->x87_tag = 0xffffu;
    x86->x87_opcode = 0u;
    x86->x87_ip = 0u;
    x86->x87_dp = 0u;
    x86->ferr_pending = 0u;
}

static int x86_x87_trig(X86Workspace *x86, u32 variant, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 exceptions = 0u;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;
    if (x86_x87_tag(x86, top) == 3u) {
        x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                        & ~(1u << 9u));
        exceptions = 1u;
        if (!x86_x87_exception(x86, exceptions))
            x86_x87_default_nan(x86, top);
        return 1;
    }
    int pushes = variant >= 2u;
    u32 pushed = (top - 1u) & 7u;
    if (pushes && x86_x87_tag(x86, pushed) != 3u) {
        x86->x87_status |= (1u << 6u) | (1u << 9u);
        exceptions = 1u;
        if (!x86_x87_exception(x86, exceptions)) {
            x86_x87_default_nan(x86, pushed);
            x86_x87_set_top(x86, pushed);
        }
        return 1;
    }
    u32 rounded_up;
    u64 raw = x86_x87_to_binary(
        x86, top, 8u, &exceptions, &rounded_up);
    if (x86_x87_exception(x86, exceptions)) return 1;
    u64 magnitude = raw & 0x7fffffffffffffffull;
    int nan = magnitude > 0x7ff0000000000000ull;
    if (!nan && magnitude > 0x43e0000000000000ull) {
        x86->x87_status |= 1u << 10u;
        return 1;
    }
    union { u64 bits; double value; } input = { .bits = raw };
    union { u64 bits; double value; } sine, cosine, tangent;
    u32 result_tag;
    if (variant == 3u) {
        tangent.value = pl_vm_math_tan(input.value);
        x86_x87_from_binary(
            tangent.bits, 8u, &x86->x87_significand[top],
            &x86->x87_sign_exponent[top], &result_tag);
        x86_x87_set_tag(x86, top, result_tag);
        x86->x87_significand[pushed] = 1ull << 63u;
        x86->x87_sign_exponent[pushed] = 0x3fffu;
        x86_x87_set_tag(x86, pushed, 0u);
        x86_x87_set_top(x86, pushed);
    } else {
        pl_vm_math_sincos(input.value, &sine.value, &cosine.value);
        u64 selected = variant == 0u ? cosine.bits : sine.bits;
        x86_x87_from_binary(
            selected, 8u, &x86->x87_significand[top],
            &x86->x87_sign_exponent[top], &result_tag);
        x86_x87_set_tag(x86, top, result_tag);
        if (variant == 2u) {
            x86_x87_from_binary(
                cosine.bits, 8u, &x86->x87_significand[pushed],
                &x86->x87_sign_exponent[pushed], &result_tag);
            x86_x87_set_tag(x86, pushed, result_tag);
            x86_x87_set_top(x86, pushed);
        }
    }
    x86->x87_status &= ~(1u << 10u);
    return 1;
}

static int x86_x87_exp2m1(X86Workspace *x86, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u64 original_sig = x86->x87_significand[top];
    pl_u16 original_se = x86->x87_sign_exponent[top];
    u32 original_tag = x86_x87_tag(x86, top);
    u32 exceptions = 0u;
    u64 result_sig = original_sig;
    pl_u16 result_se = original_se;
    u32 result_tag = original_tag;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;

    if (original_tag == 3u) {
        x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                        & ~(1u << 9u));
        exceptions = 1u;
        result_sig = 0xc000000000000000ull;
        result_se = 0xffffu;
        result_tag = 2u;
    } else {
        u32 exponent = original_se & 0x7fffu;
        u64 fraction = original_sig & 0x7fffffffffffffffull;
        int invalid_encoding = exponent && !(original_sig >> 63u);
        int nan = exponent == 0x7fffu && fraction;
        int signaling = nan && !(original_sig & (1ull << 62u));
        int outside = exponent > 0x3fffu
                   || (exponent == 0x3fffu
                       && original_sig != 0x8000000000000000ull);
        if (invalid_encoding) {
            exceptions = 1u;
            result_sig = 0xc000000000000000ull;
            result_se = 0xffffu;
            result_tag = 2u;
        } else if (nan) {
            if (signaling) exceptions = 1u;
            result_sig |= 1ull << 62u;
            result_tag = 2u;
        } else if (outside) {
            exceptions = 1u;
            result_sig = 0xc000000000000000ull;
            result_se = 0xffffu;
            result_tag = 2u;
        } else if (exponent == 0x3fffu) {
            if (original_se >> 15u) {
                result_sig = 0x8000000000000000ull;
                result_se = 0xbffeu;
            }
            result_tag = 0u;
        } else if (original_sig) {
            u32 conversion_exceptions = 0u;
            u32 rounded_up = 0u;
            u64 raw = x86_x87_to_binary(
                x86, top, 8u, &conversion_exceptions, &rounded_up);
            union { u64 bits; double value; } value = { .bits = raw };
            value.value = pl_vm_math_exp2m1(value.value);
            x86_x87_from_binary(
                value.bits, 8u, &result_sig, &result_se, &result_tag);
            exceptions |= conversion_exceptions | (1u << 5u);
        }
    }
    if (!x86_x87_exception(x86, exceptions)) {
        x86->x87_significand[top] = result_sig;
        x86->x87_sign_exponent[top] = result_se;
        x86_x87_set_tag(x86, top, result_tag);
    }
    return 1;
}

static double x86_x87_finite_mantissa(
        u64 significand, u32 exponent, i32 *unbiased)
{
    if (exponent) {
        *unbiased = (i32)exponent - 0x3fff;
    } else {
        u32 shift = (u32)__builtin_clzll(significand);
        significand <<= shift;
        *unbiased = 1 - 0x3fff - (i32)shift;
    }
    union { u64 bits; double value; } encoded = {
        .bits = 0x3ff0000000000000ull
              | ((significand >> 11u) & 0x000fffffffffffffull),
    };
    return encoded.value;
}

static void x86_x87_set_binary64(
        X86Workspace *x86, u32 physical, double value)
{
    union { u64 bits; double value; } encoded = { .value = value };
    u32 tag;
    x86_x87_from_binary(
        encoded.bits, 8u, &x86->x87_significand[physical],
        &x86->x87_sign_exponent[physical], &tag);
    x86_x87_set_tag(x86, physical, tag);
}

static void x86_x87_set_infinity(
        X86Workspace *x86, u32 physical, u32 sign)
{
    x86->x87_significand[physical] = 1ull << 63u;
    x86->x87_sign_exponent[physical] =
        (pl_u16)((sign << 15u) | 0x7fffu);
    x86_x87_set_tag(x86, physical, 2u);
}

static int x86_x87_log_product(
        X86Workspace *x86, u32 plus_one, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 target = (top + 1u) & 7u;
    u64 saved_sig = x86->x87_significand[target];
    pl_u16 saved_se = x86->x87_sign_exponent[target];
    u32 saved_tag = x86_x87_tag(x86, target);
    u32 exceptions = 0u;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;

    u32 source_tag = x86_x87_tag(x86, top);
    if (source_tag == 3u || saved_tag == 3u) {
        x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                        & ~(1u << 9u));
        exceptions = 1u;
        x86_x87_default_nan(x86, target);
    } else {
        u64 source_sig = x86->x87_significand[top];
        pl_u16 source_se = x86->x87_sign_exponent[top];
        u32 source_exp = source_se & 0x7fffu;
        u32 source_sign = source_se >> 15u;
        u64 source_fraction = source_sig & 0x7fffffffffffffffull;
        u32 target_exp = saved_se & 0x7fffu;
        u32 target_sign = saved_se >> 15u;
        u64 target_fraction = saved_sig & 0x7fffffffffffffffull;
        int source_invalid = source_exp && !(source_sig >> 63u);
        int target_invalid = target_exp && !(saved_sig >> 63u);
        int source_nan = source_exp == 0x7fffu && source_fraction;
        int target_nan = target_exp == 0x7fffu && target_fraction;
        int source_snan = source_nan && !(source_sig & (1ull << 62u));
        int target_snan = target_nan && !(saved_sig & (1ull << 62u));
        int source_inf = source_exp == 0x7fffu && !source_fraction;
        int target_inf = target_exp == 0x7fffu && !target_fraction;
        int source_zero = !source_sig;
        int target_zero = !saved_sig;
        if (source_invalid || target_invalid) {
            exceptions = 1u;
            x86_x87_default_nan(x86, target);
        } else if (source_nan || target_nan) {
            if (source_snan || target_snan) exceptions = 1u;
            if (source_nan) {
                x86->x87_significand[target] = source_sig | (1ull << 62u);
                x86->x87_sign_exponent[target] = source_se;
                x86_x87_set_tag(x86, target, 2u);
            } else {
                x86->x87_significand[target] |= 1ull << 62u;
                x86_x87_set_tag(x86, target, 2u);
            }
        } else if (plus_one) {
            u64 range = source_sign ? 0x95f619980c4336f7ull
                                    : 0xd413cccfe7799211ull;
            int outside = source_exp > 0x3ffdu
                       || (source_exp == 0x3ffdu && source_sig > range);
            if (outside || source_inf) {
                exceptions = 1u;
                x86_x87_default_nan(x86, target);
            } else if (source_zero || target_zero || target_inf) {
                x86_x87_multiply_value(
                    x86, target, source_sig, source_se,
                    source_tag, &exceptions);
            } else {
                u32 conversion_exceptions = 0u;
                u32 rounded_up = 0u;
                u64 raw = x86_x87_to_binary(
                    x86, top, 8u, &conversion_exceptions, &rounded_up);
                union { u64 bits; double value; } source = { .bits = raw };
                double logarithm = pl_vm_math_log2_positive(
                    1.0 + source.value);
                union { u64 bits; double value; } encoded = {
                    .value = logarithm,
                };
                u64 log_sig;
                pl_u16 log_se;
                u32 log_tag;
                x86_x87_from_binary(
                    encoded.bits, 8u, &log_sig, &log_se, &log_tag);
                exceptions |= conversion_exceptions | (1u << 5u);
                x86_x87_multiply_value(
                    x86, target, log_sig, log_se, log_tag, &exceptions);
            }
        } else if (source_sign && !source_zero) {
            exceptions = 1u;
            x86_x87_default_nan(x86, target);
        } else if (target_inf) {
            int less = source_exp < 0x3fffu
                    || (source_exp == 0x3fffu
                        && source_sig < 0x8000000000000000ull);
            int equal = source_exp == 0x3fffu
                     && source_sig == 0x8000000000000000ull;
            if (equal) {
                exceptions = 1u;
                x86_x87_default_nan(x86, target);
            } else {
                x86_x87_set_infinity(
                    x86, target, target_sign ^ (u32)less);
            }
        } else if (source_inf) {
            if (target_zero) {
                exceptions = 1u;
                x86_x87_default_nan(x86, target);
            } else {
                x86_x87_set_infinity(x86, target, target_sign);
            }
        } else if (source_zero) {
            if (target_zero) {
                exceptions = 1u;
                x86_x87_default_nan(x86, target);
            } else {
                exceptions = 1u << 2u;
                x86_x87_set_infinity(x86, target, target_sign ^ 1u);
            }
        } else if (target_zero) {
            int less = source_exp < 0x3fffu
                    || (source_exp == 0x3fffu
                        && source_sig < 0x8000000000000000ull);
            if (less) x86->x87_sign_exponent[target] ^= 1u << 15u;
        } else {
            i32 unbiased;
            double mantissa = x86_x87_finite_mantissa(
                source_sig, source_exp, &unbiased);
            double logarithm = (double)unbiased
                             + pl_vm_math_log2_positive(mantissa);
            union { u64 bits; double value; } encoded = {
                .value = logarithm,
            };
            u64 log_sig;
            pl_u16 log_se;
            u32 log_tag;
            x86_x87_from_binary(
                encoded.bits, 8u, &log_sig, &log_se, &log_tag);
            if (!source_exp) exceptions |= 1u << 1u;
            if (source_sig != 0x8000000000000000ull)
                exceptions |= 1u << 5u;
            x86_x87_multiply_value(
                x86, target, log_sig, log_se, log_tag, &exceptions);
        }
    }
    int unmasked = x86_x87_exception(x86, exceptions);
    if (unmasked) {
        x86->x87_significand[target] = saved_sig;
        x86->x87_sign_exponent[target] = saved_se;
        x86_x87_set_tag(x86, target, saved_tag);
    } else {
        x86_x87_set_tag(x86, top, 3u);
        x86_x87_set_top(x86, target);
    }
    return 1;
}

static int x86_x87_atan2(X86Workspace *x86, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 target = (top + 1u) & 7u;
    u64 saved_sig = x86->x87_significand[target];
    pl_u16 saved_se = x86->x87_sign_exponent[target];
    u32 saved_tag = x86_x87_tag(x86, target);
    u32 exceptions = 0u;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;
    u32 source_tag = x86_x87_tag(x86, top);
    if (source_tag == 3u || saved_tag == 3u) {
        x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                        & ~(1u << 9u));
        exceptions = 1u;
        x86_x87_default_nan(x86, target);
    } else {
        u64 x_sig = x86->x87_significand[top];
        pl_u16 x_se = x86->x87_sign_exponent[top];
        u32 x_exp = x_se & 0x7fffu;
        u32 x_sign = x_se >> 15u;
        u64 x_fraction = x_sig & 0x7fffffffffffffffull;
        u64 y_sig = saved_sig;
        u32 y_exp = saved_se & 0x7fffu;
        u32 y_sign = saved_se >> 15u;
        u64 y_fraction = y_sig & 0x7fffffffffffffffull;
        int x_invalid = x_exp && !(x_sig >> 63u);
        int y_invalid = y_exp && !(y_sig >> 63u);
        int x_nan = x_exp == 0x7fffu && x_fraction;
        int y_nan = y_exp == 0x7fffu && y_fraction;
        int x_snan = x_nan && !(x_sig & (1ull << 62u));
        int y_snan = y_nan && !(y_sig & (1ull << 62u));
        int x_inf = x_exp == 0x7fffu && !x_fraction;
        int y_inf = y_exp == 0x7fffu && !y_fraction;
        if (x_invalid || y_invalid) {
            exceptions = 1u;
            x86_x87_default_nan(x86, target);
        } else if (x_nan || y_nan) {
            if (x_snan || y_snan) exceptions = 1u;
            if (x_nan) {
                x86->x87_significand[target] = x_sig | (1ull << 62u);
                x86->x87_sign_exponent[target] = x_se;
                x86_x87_set_tag(x86, target, 2u);
            } else {
                x86->x87_significand[target] |= 1ull << 62u;
                x86_x87_set_tag(x86, target, 2u);
            }
        } else if (!y_sig && !x_sign) {
            /* atan2(+-0,+x) preserves the numerator zero exactly. */
        } else {
            double angle;
            if (!y_sig) {
                angle = 3.14159265358979311600;
            } else if (!x_sig) {
                angle = 1.57079632679489655800;
            } else if (x_inf && y_inf) {
                angle = x_sign ? 2.35619449019234483699
                               : 0.785398163397448278999;
            } else if (x_inf) {
                angle = x_sign ? 3.14159265358979311600 : 0.0;
            } else if (y_inf) {
                angle = 1.57079632679489655800;
            } else {
                i32 x_unbiased, y_unbiased;
                double x_mantissa = x86_x87_finite_mantissa(
                    x_sig, x_exp, &x_unbiased);
                double y_mantissa = x86_x87_finite_mantissa(
                    y_sig, y_exp, &y_unbiased);
                i32 difference = y_unbiased - x_unbiased;
                if (difference > 64) {
                    angle = 1.57079632679489655800;
                } else if (difference < -64) {
                    angle = 0.0;
                } else {
                    union { u64 bits; double value; } scale = {
                        .bits = (u64)(difference + 1023) << 52u,
                    };
                    double ratio = (y_mantissa / x_mantissa) * scale.value;
                    angle = pl_vm_math_atan_positive(ratio);
                }
                if (x_sign) angle = 3.14159265358979311600 - angle;
            }
            if (y_sign) angle = -angle;
            x86_x87_set_binary64(x86, target, angle);
            exceptions |= 1u << 5u;
            if (!x_exp || !y_exp) exceptions |= 1u << 1u;
        }
    }
    int unmasked = x86_x87_exception(x86, exceptions);
    if (unmasked) {
        x86->x87_significand[target] = saved_sig;
        x86->x87_sign_exponent[target] = saved_se;
        x86_x87_set_tag(x86, target, saved_tag);
    } else {
        x86_x87_set_tag(x86, top, 3u);
        x86_x87_set_top(x86, target);
    }
    return 1;
}

static int x86_x87_round_integer(X86Workspace *x86, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 exceptions = 0u;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;
    if (x86_x87_tag(x86, top) == 3u) {
        x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                        & ~(1u << 9u));
        if (!x86_x87_exception(x86, 1u))
            x86_x87_default_nan(x86, top);
        return 1;
    }

    u64 significand = x86->x87_significand[top];
    pl_u16 sign_exponent = x86->x87_sign_exponent[top];
    u32 exponent = sign_exponent & 0x7fffu;
    u32 sign = sign_exponent >> 15u;
    u32 tag = x86_x87_tag(x86, top);
    if (exponent && !(significand >> 63u)) {
        exceptions = 1u;
        significand = 0xc000000000000000ull;
        sign_exponent = 0xffffu;
        tag = 2u;
    } else if (exponent == 0x7fffu) {
        u64 fraction = significand & 0x7fffffffffffffffull;
        if (fraction) {
            if (!(significand & (1ull << 62u))) exceptions = 1u;
            significand |= 1ull << 62u;
            tag = 2u;
        }
    } else if (significand) {
        if (!exponent) exceptions |= 1u << 1u;
        i32 unbiased = exponent ? (i32)exponent - 0x3fff : -0x3ffe;
        if (unbiased < 63) {
            u32 rounding = ((u32)x86->x87_control >> 10u) & 3u;
            int increment = 0;
            exceptions |= 1u << 5u;
            if (unbiased < 0) {
                if (!rounding && unbiased == -1)
                    increment = significand > 0x8000000000000000ull;
                else if (rounding == 1u) increment = sign != 0u;
                else if (rounding == 2u) increment = sign == 0u;
                if (increment) {
                    significand = 1ull << 63u;
                    sign_exponent = (pl_u16)((sign << 15u) | 0x3fffu);
                    tag = 0u;
                } else {
                    significand = 0u;
                    sign_exponent = (pl_u16)(sign << 15u);
                    tag = 1u;
                }
            } else {
                u32 shift = 63u - (u32)unbiased;
                u64 unit = 1ull << shift;
                u64 mask = unit - 1u;
                u64 remainder = significand & mask;
                if (!remainder) exceptions &= ~(1u << 5u);
                if (!rounding) {
                    u64 half = unit >> 1u;
                    increment = remainder > half
                             || (remainder == half
                                 && ((significand >> shift) & 1u));
                } else if (rounding == 1u) increment = sign && remainder;
                else if (rounding == 2u) increment = !sign && remainder;
                significand &= ~mask;
                if (increment) {
                    significand += unit;
                    if (!significand) {
                        significand = 1ull << 63u;
                        sign_exponent = (pl_u16)(sign_exponent + 1u);
                    }
                }
                tag = 0u;
            }
        }
    }
    x86->x87_significand[top] = significand;
    x86->x87_sign_exponent[top] = sign_exponent;
    x86_x87_set_tag(x86, top, tag);
    x86_x87_exception(x86, exceptions);
    return 1;
}

static i32 x86_x87_scale_exponent(u64 significand, pl_u16 sign_exponent)
{
    u32 exponent = sign_exponent & 0x7fffu;
    u32 sign = sign_exponent >> 15u;
    if (!exponent) return 0;
    i32 unbiased = (i32)exponent - 0x3fff;
    if (unbiased < 0) return 0;
    if (unbiased > 31) return sign ? (-2147483647 - 1) : 2147483647;
    u64 magnitude = significand >> (63u - (u32)unbiased);
    if (sign) {
        if (magnitude >= 0x80000000ull) return -2147483647 - 1;
        return -(i32)magnitude;
    }
    return magnitude > 0x7fffffffull ? 2147483647 : (i32)magnitude;
}

static void x86_x87_scale_value(
        X86Workspace *x86, u32 physical, i32 scale, u32 *exceptions)
{
    u64 significand = x86->x87_significand[physical];
    pl_u16 sign_exponent = x86->x87_sign_exponent[physical];
    u32 exponent = sign_exponent & 0x7fffu;
    u32 sign = sign_exponent >> 15u;
    u64 fraction = significand & 0x7fffffffffffffffull;
    int invalid = exponent && !(significand >> 63u);
    int nan = exponent == 0x7fffu && fraction;
    if (invalid) {
        *exceptions |= 1u;
        x86_x87_default_nan(x86, physical);
        return;
    }
    if (nan) {
        if (!(significand & (1ull << 62u))) *exceptions |= 1u;
        x86->x87_significand[physical] = significand | (1ull << 62u);
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    if (exponent == 0x7fffu || !significand) return;

    i64 biased;
    if (!exponent) {
        significand = fraction;
        if (!significand) return;
        *exceptions |= 1u << 1u;
        u32 normalize = (u32)__builtin_clzll(significand);
        significand <<= normalize;
        biased = 1 - (i64)normalize + scale;
    } else {
        biased = (i64)exponent + scale;
    }
    if (biased >= 0x7fff) {
        *exceptions |= (1u << 3u) | (1u << 5u);
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        int infinity = mode == 0u
                    || (mode == 1u && sign)
                    || (mode == 2u && !sign);
        x86->x87_significand[physical] = infinity
            ? 1ull << 63u : 0xffffffffffffffffull;
        x86->x87_sign_exponent[physical] = (pl_u16)((sign << 15u)
            | (infinity ? 0x7fffu : 0x7ffeu));
        x86_x87_set_tag(x86, physical, 2u);
        return;
    }
    if (biased > 0) {
        x86->x87_significand[physical] = significand;
        x86->x87_sign_exponent[physical] =
            (pl_u16)((sign << 15u) | (u32)biased);
        x86_x87_set_tag(x86, physical, 0u);
        return;
    }

    i64 shift_signed = 1 - biased;
    u32 shift = shift_signed > 64 ? 65u : (u32)shift_signed;
    u64 retained = shift >= 64u ? 0u : significand >> shift;
    u64 remainder = shift >= 64u
                  ? significand
                  : significand & ((1ull << shift) - 1u);
    int increment = 0;
    if (remainder) {
        *exceptions |= 1u << 5u;
        u32 mode = ((u32)x86->x87_control >> 10u) & 3u;
        if (!mode && shift <= 64u) {
            u64 half = 1ull << (shift - 1u);
            increment = remainder > half
                     || (remainder == half && (retained & 1u));
        } else if (mode == 1u) increment = sign != 0u;
        else if (mode == 2u) increment = sign == 0u;
    }
    if (increment) ++retained;
    u32 result_exponent = retained & (1ull << 63u) ? 1u : 0u;
    if (!result_exponent && remainder) *exceptions |= 1u << 4u;
    x86->x87_significand[physical] = retained;
    x86->x87_sign_exponent[physical] =
        (pl_u16)((sign << 15u) | result_exponent);
    x86_x87_set_tag(x86, physical, retained ? (result_exponent ? 0u : 2u) : 1u);
    x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                    | ((pl_u16)increment << 9u));
}

static int x86_x87_scale(X86Workspace *x86, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 scale_source = (top + 1u) & 7u;
    u32 exceptions = 0u;
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;
    if (x86_x87_tag(x86, top) == 3u
            || x86_x87_tag(x86, scale_source) == 3u) {
        x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                        & ~(1u << 9u));
        if (!x86_x87_exception(x86, 1u))
            x86_x87_default_nan(x86, top);
        return 1;
    }

    u64 value_sig = x86->x87_significand[top];
    pl_u16 value_se = x86->x87_sign_exponent[top];
    u32 value_exp = value_se & 0x7fffu;
    u64 value_fraction = value_sig & 0x7fffffffffffffffull;
    u64 scale_sig = x86->x87_significand[scale_source];
    pl_u16 scale_se = x86->x87_sign_exponent[scale_source];
    u32 scale_exp = scale_se & 0x7fffu;
    u64 scale_fraction = scale_sig & 0x7fffffffffffffffull;
    int value_invalid = value_exp && !(value_sig >> 63u);
    int scale_invalid = scale_exp && !(scale_sig >> 63u);
    int value_nan = value_exp == 0x7fffu && value_fraction;
    int scale_nan = scale_exp == 0x7fffu && scale_fraction;
    if (value_invalid || scale_invalid) {
        exceptions = 1u;
        x86_x87_default_nan(x86, top);
    } else if (scale_nan) {
        if ((value_nan && !(value_sig & (1ull << 62u)))
                || !(scale_sig & (1ull << 62u)))
            exceptions |= 1u;
        x86->x87_significand[top] = scale_sig | (1ull << 62u);
        x86->x87_sign_exponent[top] = scale_se;
        x86_x87_set_tag(x86, top, 2u);
    } else if (value_nan) {
        if (!(value_sig & (1ull << 62u))) exceptions |= 1u;
        x86->x87_significand[top] = value_sig | (1ull << 62u);
        x86_x87_set_tag(x86, top, 2u);
    } else if (scale_exp == 0x7fffu) {
        if (scale_se >> 15u) {
            if (value_exp == 0x7fffu && !value_fraction) {
                exceptions = 1u;
                x86_x87_default_nan(x86, top);
            } else {
                x86->x87_significand[top] = 0u;
                x86->x87_sign_exponent[top] = (pl_u16)(value_se & 0x8000u);
                x86_x87_set_tag(x86, top, 1u);
            }
        } else if (!value_sig) {
            exceptions = 1u;
            x86_x87_default_nan(x86, top);
        } else {
            x86->x87_significand[top] = 1ull << 63u;
            x86->x87_sign_exponent[top] =
                (pl_u16)((value_se & 0x8000u) | 0x7fffu);
            x86_x87_set_tag(x86, top, 2u);
        }
    } else {
        i32 scale = x86_x87_scale_exponent(scale_sig, scale_se);
        x86_x87_scale_value(x86, top, scale, &exceptions);
    }
    x86_x87_exception(x86, exceptions);
    return 1;
}

static int x86_x87_extract(X86Workspace *x86, u32 fop)
{
    u32 top = x86_x87_top(x86);
    u32 pushed = (top - 1u) & 7u;
    u32 source_tag = x86_x87_tag(x86, top);
    x86->x87_ip = x86->rip;
    x86->x87_dp = 0u;
    x86->x87_opcode = (pl_u16)fop;

    if (source_tag == 3u || x86_x87_tag(x86, pushed) != 3u) {
        int overflow = source_tag != 3u;
        x86->x87_status = (pl_u16)(x86->x87_status | (1u << 6u));
        x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                        | ((pl_u16)overflow << 9u));
        if (x86_x87_exception(x86, 1u)) return 1;
        x86_x87_default_nan(x86, top);
        x86_x87_default_nan(x86, pushed);
        x86_x87_set_top(x86, pushed);
        return 1;
    }

    u64 significand = x86->x87_significand[top];
    pl_u16 sign_exponent = x86->x87_sign_exponent[top];
    u32 exponent = sign_exponent & 0x7fffu;
    u32 sign = sign_exponent >> 15u;
    u64 fraction = significand & 0x7fffffffffffffffull;
    int invalid_encoding = exponent && !(significand >> 63u);
    int nan = exponent == 0x7fffu && fraction;
    int signaling_nan = nan && !(significand & (1ull << 62u));
    u32 exceptions = invalid_encoding || signaling_nan ? 1u : 0u;
    if (!exponent && significand) exceptions |= 1u << 1u;
    if (!significand) exceptions |= 1u << 2u;
    if (x86_x87_exception(x86, exceptions)) return 1;

    if (invalid_encoding) {
        x86_x87_default_nan(x86, top);
        x86_x87_default_nan(x86, pushed);
    } else if (nan) {
        u64 quiet = significand | (1ull << 62u);
        x86->x87_significand[top] = quiet;
        x86->x87_sign_exponent[top] = sign_exponent;
        x86_x87_set_tag(x86, top, 2u);
        x86->x87_significand[pushed] = quiet;
        x86->x87_sign_exponent[pushed] = sign_exponent;
        x86_x87_set_tag(x86, pushed, 2u);
    } else if (exponent == 0x7fffu) {
        x86->x87_significand[top] = 1ull << 63u;
        x86->x87_sign_exponent[top] = 0x7fffu;
        x86_x87_set_tag(x86, top, 2u);
        x86->x87_significand[pushed] = significand;
        x86->x87_sign_exponent[pushed] = sign_exponent;
        x86_x87_set_tag(x86, pushed, 2u);
    } else if (!significand) {
        x86->x87_significand[top] = 1ull << 63u;
        x86->x87_sign_exponent[top] = 0xffffu;
        x86_x87_set_tag(x86, top, 2u);
        x86->x87_significand[pushed] = 0u;
        x86->x87_sign_exponent[pushed] = (pl_u16)(sign << 15u);
        x86_x87_set_tag(x86, pushed, 1u);
    } else {
        i64 unbiased;
        if (!exponent) {
            u32 normalize = (u32)__builtin_clzll(significand);
            significand <<= normalize;
            unbiased = 1 - 0x3fff - (i64)normalize;
        } else {
            unbiased = (i64)exponent - 0x3fff;
        }
        u32 exponent_tag;
        x86_x87_from_integer(
            unbiased, &x86->x87_significand[top],
            &x86->x87_sign_exponent[top], &exponent_tag);
        x86_x87_set_tag(x86, top, exponent_tag);
        x86->x87_significand[pushed] = significand;
        x86->x87_sign_exponent[pushed] =
            (pl_u16)((sign << 15u) | 0x3fffu);
        x86_x87_set_tag(x86, pushed, 0u);
    }
    x86_x87_set_top(x86, pushed);
    return 1;
}

/* The first x87 quotient family owns WAIT plus exact integer load/store.
 * 80-bit registers stay as explicit significand/sign-exponent lanes; no host
 * floating type or scalar instruction record participates. */
EXPORT int vm_x86_direct_x87(u32 machine, u64 address, u64 descriptor)
{
    X86Workspace *x86 = x86_machine();
    u32 kind = (u32)descriptor & 0xffu;
    u32 width = (u32)(descriptor >> 8u) & 0xffu;
    u32 fop = (u32)(descriptor >> 16u) & 0x7ffu;
    u32 source = (u32)(descriptor >> 32u) & 7u;
    u32 target = (u32)(descriptor >> 36u) & 7u;
    u32 options = (u32)(descriptor >> 40u) & 3u;
    u32 variant = (u32)(descriptor >> 44u) & 15u;
    u32 immediate = (u32)(descriptor >> 48u) & 0xffu;
    u64 canonical = kind | ((u64)width << 8u) | ((u64)fop << 16u)
                  | ((u64)source << 32u) | ((u64)target << 36u)
                  | ((u64)options << 40u) | ((u64)variant << 44u)
                  | ((u64)immediate << 48u);
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || kind > 58u || descriptor != canonical
            || (kind != 38u && kind != 46u && immediate)
            || (kind != 36u && kind != 37u
                && kind != 39u && kind != 40u
                && kind != 45u && kind != 46u
                && kind != 48u
                && kind != 51u
                && kind != 53u
                && kind != 54u
                && kind != 55u
                && kind != 58u
                && kind != 11u
                && !(kind == 26u && (options & 2u))
                && variant)
            || (kind <= 12u && kind != 8u && kind != 9u
                && kind != 11u && options)
            || (!kind && (address || width || fop || source || target))
            || (kind >= 1u && kind <= 4u
                && ((width != 2u && width != 4u && width != 8u)
                    || source || target))
            || (kind >= 5u && kind <= 6u && (address || width || target))
            || (kind == 7u
                && ((width != 2u && width != 4u) || source || target))
            || (kind == 8u
                && (width ? ((width != 4u && width != 8u)
                              || source || target || options)
                          : address))
            || (kind == 9u
                && (width ? ((width != 4u && width != 8u)
                              || source || target || options)
                          : address))
            || (kind == 10u
                && (width ? ((width != 4u && width != 8u && width != 10u)
                              || source || target)
                          : (address || target)))
            || (kind == 11u
                && (variant > 1u
                    || (variant
                        ? (address || width || source || target || options)
                        : ((width ? ((target & 4u)
                                       ? ((width != 2u && width != 4u)
                                          || source)
                                       : ((width != 4u && width != 8u)
                                          || source))
                                  : (address || (target & 4u)))
                           || options > 1u))))
            || (kind == 12u
                && ((width != 2u && width != 4u) || source
                    || (target & 4u)))
            || (kind == 13u
                && (width ? ((width != 4u && width != 8u)
                              || source || target || (options & 2u))
                          : address))
            || (kind == 14u
                && ((options & 2u)
                    || (width ? ((width != 4u && width != 8u && width != 10u)
                                  || source || target)
                              : (address || source))))
            || (kind == 15u
                && (width ? ((width != 4u && width != 8u)
                              || source || target || (options & 2u))
                          : address))
            || (kind == 16u
                && ((width != 2u && width != 4u) || source
                    || (target & 6u) || options))
            || (kind == 17u
                && (width ? (width != 8u
                              || (options ? target : source))
                          : (address || options)))
            || (kind == 18u
                && ((width != 0u && width != 8u)
                    || (width && source) || options))
            || ((kind == 19u || kind == 20u)
                && (address || width || target || options))
            || (kind == 21u && (address || width || target || options))
            || (kind == 22u
                && (address || width || target || (options & 2u)))
            || (kind == 23u
                && ((width != 0u && width != 8u)
                    || (width && source) || options > 2u))
            || ((kind == 24u || kind == 25u)
                && ((width != 0u && width != 8u)
                    || (width && source) || options))
            || (kind == 26u
                && ((options & 2u)
                    ? (address || width
                       || (source | (variant << 3u)) > 32u)
                    : ((width != 0u && width != 8u)
                       || (width && source) || variant)))
            || ((kind == 27u || kind == 28u)
                && (width != 10u || source || target || options))
            || ((kind == 29u || kind == 30u)
                && (width != 2u || fop || source || target || options))
            || (kind == 31u
                && ((width != 0u && width != 2u)
                    || fop || source || target || options))
            || ((kind == 32u || kind == 33u)
                && ((width != 14u && width != 28u)
                    || fop || source || target || options))
            || ((kind == 34u || kind == 35u)
                && ((width != 94u && width != 108u)
                    || fop || source || target || options))
            || (kind == 36u
                && (address || width || target || options
                    || (variant != 2u && variant != 3u
                        && variant != 4u && variant != 5u
                        && variant != 6u && variant != 7u
                        && variant != 10u && variant != 11u)))
            || (kind == 37u
                && ((width != 0u && width != 4u && width != 8u)
                    || (width == 4u
                        && (options | (variant << 2u)) != 18u
                        && (options | (variant << 2u)) != 29u
                        && (options | (variant << 2u)) != 39u)
                    || (width && source)
                    || (options | (variant << 2u)) > 47u))
            || (kind == 38u
                && ((width != 0u && width != 8u)
                    || (width && source) || options || variant))
            || (kind == 39u
                && ((width != 0u && width != 8u)
                    || (width && source)
                    || ((options & 2u)
                        ? (address || width
                           || (source | (variant << 3u)) > 64u)
                        : (variant || (!width && address)))))
            || (kind == 40u
                && ((width != 0u && width != 4u)
                    || (!width && address) || (width && variant)
                    || options > 1u || (options ? target : source)))
            || (kind == 41u
                && (address || width || fop || source || target
                    || options || variant))
            || (kind == 42u
                && (address || width || source > 6u || target
                    || options || variant))
            || (kind == 43u
                && (address || width || source > 1u || target
                    || options || variant))
            || (kind == 44u
                && (address || width || fop || source || target
                    || options || variant))
            || (kind == 45u
                && (address || width || options > 1u
                    || (options ? target : source)))
            || (kind == 46u
                && ((width != 0u && width != 2u)
                    || (width ? (source || variant) : address)
                    || options || immediate > 3u))
            || (kind == 47u
                && (address || width || fop || source || target
                    || options || variant))
            || (kind == 48u
                && (address || width || source || target
                    || options || variant > 3u))
            || (kind == 49u
                && (address || width || source || target
                    || options || variant))
            || (kind == 50u
                && (address || width || source || target
                    || options || variant))
            || (kind == 51u
                && (width || fop || source || target
                    || options > 1u || variant > 1u))
            || (kind == 52u
                && (address || width || source || target
                    || options || variant))
            || (kind == 53u
                && (address || width || source || target
                    || options || variant > 1u))
            || (kind == 54u
                && (address || width || source || target
                    || options || variant > 1u))
            || (kind == 55u
                && (address || width || target || options || immediate))
            || (kind == 56u
                && (address || width || source || target || options
                    || variant || immediate))
            || (kind == 57u
                && (address || width || source || target || options
                    || variant || immediate))
            || (kind == 58u
                && (address || width || source || target || options
                    || variant > 3u || immediate))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    int non_waiting = kind == 17u || kind == 18u || kind == 22u
                   || (kind >= 23u && kind <= 26u)
                   || (kind >= 37u && kind <= 41u)
                   || (kind >= 44u && kind <= 47u)
                   || kind == 29u || kind == 31u || kind == 32u
                   || kind == 34u || kind == 55u;
    if (!x86_x87_ready(x86, non_waiting ? -1 : kind == 0u)) return 0;
    if (!kind) return 1;
    if (kind == 44u) {
        x86_x87_reset(x86);
        return 1;
    }
    if (kind == 47u) {
        x86->x87_status &= 0x7f00u;
        x86->ferr_pending = 0u;
        return 1;
    }
    if (kind == 55u) {
        u64 packed = x86->x87_significand[source];
        u32 mask = 0u;
        for (u32 lane = 0u; lane < 8u; ++lane)
            mask |= (u32)((packed >> (lane * 8u + 7u)) & 1u) << lane;
        x86->registers[variant] = mask;
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }
    if (kind == 56u) {
        u32 top = x86_x87_top(x86);
        u64 significand = x86->x87_significand[top];
        u32 exponent = x86->x87_sign_exponent[top] & 0x7fffu;
        x86->x87_status &= (pl_u16)~0x4700u;
        x86->x87_status |= (pl_u16)
            ((x86->x87_sign_exponent[top] >> 15u) << 9u);
        if (x86_x87_tag(x86, top) == 3u) {
            x86->x87_status |= 0x4100u;
        } else if (exponent == 0x7fffu) {
            if (significand == 0x8000000000000000ull)
                x86->x87_status |= 0x0500u;
            else if (significand & (1ull << 63u))
                x86->x87_status |= 0x0100u;
        } else if (!exponent) {
            x86->x87_status |= significand ? 0x4400u : 0x4000u;
        } else if (significand & (1ull << 63u)) {
            x86->x87_status |= 0x0400u;
        }
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }
    if (kind == 57u)
        return x86_x87_extract(x86, fop);
    if (kind == 58u)
        return !variant ? x86_x87_exp2m1(x86, fop)
             : variant == 1u ? x86_x87_log_product(x86, 0u, fop)
             : variant == 2u ? x86_x87_log_product(x86, 1u, fop)
             : x86_x87_atan2(x86, fop);
    if (kind == 48u)
        return x86_x87_trig(x86, variant, fop);
    if (kind == 49u)
        return x86_x87_round_integer(x86, fop);
    if (kind == 50u)
        return x86_x87_scale(x86, fop);
    if (kind == 52u)
        return x86_x87_sqrt(x86, fop);
    if (kind == 53u)
        return x86_x87_remainder(x86, variant, fop);
    if (kind == 54u)
        return x86_x87_sign(x86, variant, fop);
    if (kind == 41u) {
        x86->x87_tag = 0xffffu;
        return 1;
    }
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;

    if (kind == 51u)
        return x86_x87_fxstate(x86, address, user, options, variant);

    if (kind == 45u) {
        if (options) {
            x86->registers[variant] = x86->x87_significand[source];
        } else {
            x86->x87_significand[target] = x86->registers[variant];
            x86->x87_sign_exponent[target] = 0xffffu;
        }
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 46u) {
        u32 value;
        if (width) {
            u8 bytes[2];
            if (!x86_direct_read(x86, address, bytes, 2u, user)) return 0;
            value = read_u16(bytes);
        } else {
            value = (u32)x86->registers[variant] & 0xffffu;
        }
        u32 shift = immediate * 16u;
        u64 mask = 0xffffull << shift;
        x86->x87_significand[target] =
            (x86->x87_significand[target] & ~mask) | ((u64)value << shift);
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 42u) {
        static const u64 significand[7] = {
            0x8000000000000000ull, 0xd49a784bcd1b8afeull,
            0xb8aa3b295c17f0bcull, 0xc90fdaa22168c235ull,
            0x9a209a84fbcff799ull, 0xb17217f7d1cf79acull, 0u,
        };
        static const pl_u16 sign_exponent[7] = {
            0x3fffu, 0x4000u, 0x3fffu, 0x4000u,
            0x3ffdu, 0x3ffeu, 0u,
        };
        u64 value = significand[source];
        u32 rounding = ((u32)x86->x87_control >> 10u) & 3u;
        if (source == 1u && rounding == 2u) ++value;
        if ((source == 2u || source == 3u
                || source == 4u || source == 5u)
                && (rounding == 1u || rounding == 3u))
            --value;
        u32 top = (x86_x87_top(x86) - 1u) & 7u;
        if (x86_x87_tag(x86, top) != 3u) {
            x86->x87_status |= (1u << 6u) | (1u << 9u);
            int unmasked = x86_x87_exception(x86, 1u);
            x86->x87_ip = x86->rip;
            x86->x87_opcode = (pl_u16)fop;
            if (unmasked) return 1;
            x86_x87_default_nan(x86, top);
        } else {
            x86->x87_status &= (pl_u16)~(1u << 9u);
            x86->x87_significand[top] = value;
            x86->x87_sign_exponent[top] = sign_exponent[source];
            x86_x87_set_tag(x86, top, source == 6u ? 1u : 0u);
        }
        x86_x87_set_top(x86, top);
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 43u) {
        u32 top = (x86_x87_top(x86) + (source ? 1u : 7u)) & 7u;
        x86_x87_set_top(x86, top);
        x86->x87_status &= (pl_u16)~0x4700u;
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if ((kind >= 5u && kind <= 6u) || kind == 19u || kind == 20u) {
        u32 top = x86_x87_top(x86);
        u32 other = (top + source) & 7u;
        u32 exceptions = 0u;
        u32 relation = 3u;
        if (x86_x87_tag(x86, top) == 3u
                || x86_x87_tag(x86, other) == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
        } else {
            relation = x86_x87_compare_values(
                x86->x87_significand[top], x86->x87_sign_exponent[top],
                x86->x87_significand[other], x86->x87_sign_exponent[other],
                kind <= 6u, &exceptions);
            x86->x87_status &= (pl_u16)~(1u << 9u);
        }
        int unmasked = x86_x87_exception(x86, exceptions);
        static const pl_u16 flags[4] = { 0u, 1u, 0x40u, 0x45u };
        x86->rflags = (x86->rflags & ~0x8d5ull) | flags[relation];
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        if ((kind == 5u || kind == 19u) && !unmasked) {
            x86_x87_set_tag(x86, top, 3u);
            x86_x87_set_top(x86, (top + 1u) & 7u);
        }
        return 1;
    }

    if (kind == 36u) {
        u64 predicate;
        step_x86_condition_value(x86->rflags, variant, &predicate);
        if (predicate) {
            u32 top = x86_x87_top(x86);
            u32 other = (top + source) & 7u;
            if (x86_x87_tag(x86, top) == 3u
                    || x86_x87_tag(x86, other) == 3u) {
                x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                                & ~(1u << 9u));
                if (!x86_x87_exception(x86, 1u))
                    x86_x87_default_nan(x86, top);
            } else {
                x86->x87_significand[top] = x86->x87_significand[other];
                x86->x87_sign_exponent[top] = x86->x87_sign_exponent[other];
                x86_x87_set_tag(x86, top, x86_x87_tag(x86, other));
            }
        }
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 7u) {
        u8 bytes[4] = {0};
        if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
        u64 raw = 0u;
        for (u32 index = 0u; index < width; ++index)
            raw |= (u64)bytes[index] << (index * 8u);
        u32 source_bits = width * 8u;
        if (raw & (1ull << (source_bits - 1u)))
            raw |= ~0ull << source_bits;
        u32 top = x86_x87_top(x86);
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, top) == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
            x86->x87_significand[top] = 0xc000000000000000ull;
            x86->x87_sign_exponent[top] = 0xffffu;
            x86_x87_set_tag(x86, top, 2u);
        } else {
            u64 right_sig;
            pl_u16 right_se;
            u32 right_tag;
            x86_x87_from_integer(
                (i64)raw, &right_sig, &right_se, &right_tag);
            x86_x87_multiply_value(
                x86, top, right_sig, right_se, right_tag, &exceptions);
        }
        x86_x87_exception(x86, exceptions);
        x86->x87_ip = x86->rip;
        x86->x87_dp = address;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 9u) {
        u32 top = x86_x87_top(x86);
        u32 destination = (top + target) & 7u;
        u64 right_sig;
        pl_u16 right_se;
        u32 right_tag;
        if (width) {
            u8 bytes[8] = {0};
            if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
            u64 raw = 0u;
            for (u32 index = 0u; index < width; ++index)
                raw |= (u64)bytes[index] << (index * 8u);
            x86_x87_from_binary(
                raw, width, &right_sig, &right_se, &right_tag);
        } else {
            u32 other = (top + source) & 7u;
            right_sig = x86->x87_significand[other];
            right_se = x86->x87_sign_exponent[other];
            right_tag = x86_x87_tag(x86, other);
        }
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, destination) == 3u || right_tag == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
            x86_x87_default_nan(x86, destination);
        } else {
            x86_x87_multiply_value(
                x86, destination, right_sig, right_se,
                right_tag, &exceptions);
        }
        int unmasked = x86_x87_exception(x86, exceptions);
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        if ((options & 1u) && !unmasked) {
            x86_x87_set_tag(x86, top, 3u);
            x86_x87_set_top(x86, (top + 1u) & 7u);
        }
        return 1;
    }

    if (kind == 10u) {
        u64 loaded_sig;
        pl_u16 loaded_se;
        u32 loaded_tag;
        if (width) {
            u8 bytes[10] = {0};
            if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
            if (width == 10u) {
                loaded_sig = load_u64(bytes);
                loaded_se = read_u16(bytes + 8u);
                loaded_tag = x86_x87_classify(loaded_sig, loaded_se);
            } else {
                u64 raw = 0u;
                for (u32 index = 0u; index < width; ++index)
                    raw |= (u64)bytes[index] << (index * 8u);
                x86_x87_from_binary(
                    raw, width, &loaded_sig, &loaded_se, &loaded_tag);
            }
        } else {
            u32 physical = (x86_x87_top(x86) + source) & 7u;
            loaded_sig = x86->x87_significand[physical];
            loaded_se = x86->x87_sign_exponent[physical];
            loaded_tag = x86_x87_tag(x86, physical);
        }
        u32 top = (x86_x87_top(x86) - 1u) & 7u;
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, top) != 3u || loaded_tag == 3u) {
            int overflow = x86_x87_tag(x86, top) != 3u;
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            x86->x87_status |= (pl_u16)(overflow << 9u);
            exceptions = 1u;
            if (!x86_x87_exception(x86, exceptions)) {
                x86_x87_default_nan(x86, top);
                x86_x87_set_top(x86, top);
            }
        } else {
            x86->x87_significand[top] = loaded_sig;
            x86->x87_sign_exponent[top] = loaded_se;
            x86_x87_set_tag(x86, top, loaded_tag);
            x86_x87_set_top(x86, top);
        }
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 11u) {
        u32 top = x86_x87_top(x86);
        u64 right_sig;
        pl_u16 right_se;
        u32 right_tag;
        if (variant) {
            right_sig = 0u;
            right_se = 0u;
            right_tag = 1u;
        } else if (width) {
            u8 bytes[8] = {0};
            if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
            u64 raw = 0u;
            for (u32 index = 0u; index < width; ++index)
                raw |= (u64)bytes[index] << (index * 8u);
            if (target & 4u) {
                u32 source_bits = width * 8u;
                if (raw & (1ull << (source_bits - 1u)))
                    raw |= ~0ull << source_bits;
                x86_x87_from_integer(
                    (i64)raw, &right_sig, &right_se, &right_tag);
            } else {
                x86_x87_from_binary(
                    raw, width, &right_sig, &right_se, &right_tag);
            }
        } else {
            u32 other = (top + source) & 7u;
            right_sig = x86->x87_significand[other];
            right_se = x86->x87_sign_exponent[other];
            right_tag = x86_x87_tag(x86, other);
        }
        u32 relation = 3u;
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, top) == 3u || right_tag == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
        } else {
            relation = x86_x87_compare_values(
                x86->x87_significand[top], x86->x87_sign_exponent[top],
                right_sig, right_se, (target & 2u) != 0u, &exceptions);
            x86->x87_status &= (pl_u16)~(1u << 9u);
        }
        static const pl_u16 condition[4] = {
            0u, 1u << 8u, 1u << 14u,
            (1u << 14u) | (1u << 10u) | (1u << 8u),
        };
        x86->x87_status = (pl_u16)((x86->x87_status & ~0x4500u)
                        | condition[relation]);
        int unmasked = x86_x87_exception(x86, exceptions);
        if ((target & 1u) && !unmasked) {
            x86_x87_set_tag(x86, top, 3u);
            u32 next = (top + 1u) & 7u;
            if (options & 1u) {
                x86_x87_set_tag(x86, next, 3u);
                next = (next + 1u) & 7u;
            }
            x86_x87_set_top(x86, next);
        }
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 12u) {
        u8 bytes[4] = {0};
        if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
        u64 raw = 0u;
        for (u32 index = 0u; index < width; ++index)
            raw |= (u64)bytes[index] << (index * 8u);
        u32 source_bits = width * 8u;
        if (raw & (1ull << (source_bits - 1u)))
            raw |= ~0ull << source_bits;
        u64 integer_sig;
        pl_u16 integer_se;
        u32 integer_tag;
        x86_x87_from_integer(
            (i64)raw, &integer_sig, &integer_se, &integer_tag);
        u32 top = x86_x87_top(x86);
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, top) == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
            x86_x87_default_nan(x86, top);
        } else {
            u64 right_sig = integer_sig;
            pl_u16 right_se = integer_se;
            u32 right_tag = integer_tag;
            if (target & 1u) {
                right_sig = x86->x87_significand[top];
                right_se = x86->x87_sign_exponent[top];
                right_tag = x86_x87_tag(x86, top);
                x86->x87_significand[top] = integer_sig;
                x86->x87_sign_exponent[top] = integer_se;
                x86_x87_set_tag(x86, top, integer_tag);
            }
            if (target & 2u) right_se ^= 1u << 15u;
            x86_x87_add_value(
                x86, top, right_sig, right_se, right_tag, &exceptions);
        }
        x86_x87_exception(x86, exceptions);
        x86->x87_ip = x86->rip;
        x86->x87_dp = address;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 13u) {
        u32 top = x86_x87_top(x86);
        u32 destination = (top + target) & 7u;
        u64 right_sig;
        pl_u16 right_se;
        u32 right_tag;
        if (width) {
            u8 bytes[8] = {0};
            if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
            u64 raw = 0u;
            for (u32 index = 0u; index < width; ++index)
                raw |= (u64)bytes[index] << (index * 8u);
            x86_x87_from_binary(
                raw, width, &right_sig, &right_se, &right_tag);
        } else {
            u32 other = (top + source) & 7u;
            right_sig = x86->x87_significand[other];
            right_se = x86->x87_sign_exponent[other];
            right_tag = x86_x87_tag(x86, other);
        }
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, destination) == 3u || right_tag == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
            x86_x87_default_nan(x86, destination);
        } else {
            if (options & 1u) {
                u64 left_sig = x86->x87_significand[destination];
                pl_u16 left_se = x86->x87_sign_exponent[destination];
                u32 left_tag = x86_x87_tag(x86, destination);
                x86->x87_significand[destination] = right_sig;
                x86->x87_sign_exponent[destination] = right_se;
                x86_x87_set_tag(x86, destination, right_tag);
                right_sig = left_sig;
                right_se = left_se;
                right_tag = left_tag;
            }
            right_se ^= 1u << 15u;
            x86_x87_add_value(
                x86, destination, right_sig, right_se,
                right_tag, &exceptions);
        }
        int unmasked = x86_x87_exception(x86, exceptions);
        if ((options & 2u) && !unmasked) {
            x86_x87_set_tag(x86, top, 3u);
            x86_x87_set_top(x86, (top + 1u) & 7u);
        }
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 14u) {
        u32 top = x86_x87_top(x86);
        u32 exceptions = 0u;
        u32 rounded_up = 0u;
        int empty = x86_x87_tag(x86, top) == 3u;
        if (width
                && !x86_direct_access_ready(
                    x86, address, width, 1, user)) return 0;
        if (empty) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
        }
        u64 encoded = 0u;
        u8 bytes[10] = {0};
        if (width == 4u || width == 8u) {
            encoded = empty
                ? (width == 4u ? 0xffc00000u : 0xfff8000000000000ull)
                : x86_x87_to_binary(
                    x86, top, width, &exceptions, &rounded_up);
            for (u32 index = 0u; index < width; ++index)
                bytes[index] = (u8)(encoded >> (index * 8u));
        } else if (width == 10u) {
            u64 significand = empty ? 0xc000000000000000ull
                                    : x86->x87_significand[top];
            pl_u16 sign_exponent = empty ? 0xffffu
                                         : x86->x87_sign_exponent[top];
            for (u32 index = 0u; index < 8u; ++index)
                bytes[index] = (u8)(significand >> (index * 8u));
            bytes[8] = (u8)sign_exponent;
            bytes[9] = (u8)(sign_exponent >> 8u);
        }
        x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                        | ((pl_u16)rounded_up << 9u));
        int unmasked = x86_x87_exception(x86, exceptions);
        if (unmasked) return 1;
        if (width) {
            if (!x86_x87_write_raw_prepared(
                    x86, address, bytes, width, user)) return 0;
        } else {
            u32 destination = (top + target) & 7u;
            if (empty) x86_x87_default_nan(x86, destination);
            else {
                x86->x87_significand[destination] =
                    x86->x87_significand[top];
                x86->x87_sign_exponent[destination] =
                    x86->x87_sign_exponent[top];
                x86_x87_set_tag(
                    x86, destination, x86_x87_tag(x86, top));
            }
        }
        if (options & 1u) {
            x86_x87_set_tag(x86, top, 3u);
            x86_x87_set_top(x86, (top + 1u) & 7u);
        }
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 15u) {
        u32 top = x86_x87_top(x86);
        u32 destination = (top + target) & 7u;
        u64 right_sig;
        pl_u16 right_se;
        u32 right_tag;
        if (width) {
            u8 bytes[8] = {0};
            if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
            u64 raw = 0u;
            for (u32 index = 0u; index < width; ++index)
                raw |= (u64)bytes[index] << (index * 8u);
            x86_x87_from_binary(
                raw, width, &right_sig, &right_se, &right_tag);
        } else {
            u32 other = (top + source) & 7u;
            right_sig = x86->x87_significand[other];
            right_se = x86->x87_sign_exponent[other];
            right_tag = x86_x87_tag(x86, other);
        }
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, destination) == 3u || right_tag == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
            x86_x87_default_nan(x86, destination);
        } else {
            if (options & 1u) {
                u64 left_sig = x86->x87_significand[destination];
                pl_u16 left_se = x86->x87_sign_exponent[destination];
                u32 left_tag = x86_x87_tag(x86, destination);
                x86->x87_significand[destination] = right_sig;
                x86->x87_sign_exponent[destination] = right_se;
                x86_x87_set_tag(x86, destination, right_tag);
                right_sig = left_sig;
                right_se = left_se;
                right_tag = left_tag;
            }
            x86_x87_divide_value(
                x86, destination, right_sig, right_se,
                right_tag, &exceptions);
        }
        int unmasked = x86_x87_exception(x86, exceptions);
        if ((options & 2u) && !unmasked) {
            x86_x87_set_tag(x86, top, 3u);
            x86_x87_set_top(x86, (top + 1u) & 7u);
        }
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 16u) {
        u8 bytes[4] = {0};
        if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
        u64 raw = 0u;
        for (u32 index = 0u; index < width; ++index)
            raw |= (u64)bytes[index] << (index * 8u);
        u32 source_bits = width * 8u;
        if (raw & (1ull << (source_bits - 1u)))
            raw |= ~0ull << source_bits;
        u64 integer_sig;
        pl_u16 integer_se;
        u32 integer_tag;
        x86_x87_from_integer(
            (i64)raw, &integer_sig, &integer_se, &integer_tag);
        u32 top = x86_x87_top(x86);
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, top) == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
            x86_x87_default_nan(x86, top);
        } else {
            u64 right_sig = integer_sig;
            pl_u16 right_se = integer_se;
            u32 right_tag = integer_tag;
            if (target & 1u) {
                right_sig = x86->x87_significand[top];
                right_se = x86->x87_sign_exponent[top];
                right_tag = x86_x87_tag(x86, top);
                x86->x87_significand[top] = integer_sig;
                x86->x87_sign_exponent[top] = integer_se;
                x86_x87_set_tag(x86, top, integer_tag);
            }
            x86_x87_divide_value(
                x86, top, right_sig, right_se, right_tag, &exceptions);
        }
        x86_x87_exception(x86, exceptions);
        x86->x87_ip = x86->rip;
        x86->x87_dp = address;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 17u) {
        if (width && (options & 1u)) {
            if (!x86_x87_write_integer(
                    x86, address, x86->x87_significand[source], 8u, user))
                return 0;
        } else {
            u64 value;
            if (width) {
                u8 bytes[8];
                if (!x86_direct_read(x86, address, bytes, 8u, user)) return 0;
                value = load_u64(bytes);
            } else {
                value = x86->x87_significand[source];
            }
            x86->x87_significand[target] = value;
            x86->x87_sign_exponent[target] = 0xffffu;
        }
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 18u) {
        u64 right;
        if (width) {
            u8 bytes[8];
            if (!x86_direct_read(x86, address, bytes, 8u, user)) return 0;
            right = load_u64(bytes);
        } else {
            right = x86->x87_significand[source];
        }
        u64 left = x86->x87_significand[target];
        x86->x87_significand[target] =
            (u64)((u32)left + (u32)right)
            | ((u64)((u32)(left >> 32u) + (u32)(right >> 32u)) << 32u);
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 21u) {
        u32 top = x86_x87_top(x86);
        u32 other = (top + source) & 7u;
        u64 significand = x86->x87_significand[top];
        pl_u16 sign_exponent = x86->x87_sign_exponent[top];
        u32 tag = x86_x87_tag(x86, top);
        x86->x87_significand[top] = x86->x87_significand[other];
        x86->x87_sign_exponent[top] = x86->x87_sign_exponent[other];
        x86_x87_set_tag(x86, top, x86_x87_tag(x86, other));
        x86->x87_significand[other] = significand;
        x86->x87_sign_exponent[other] = sign_exponent;
        x86_x87_set_tag(x86, other, tag);
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 22u) {
        u32 top = x86_x87_top(x86);
        x86_x87_set_tag(x86, (top + source) & 7u, 3u);
        if (options & 1u) x86_x87_set_top(x86, (top + 1u) & 7u);
        x86->x87_ip = x86->rip;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind >= 23u && kind <= 26u) {
        u64 right;
        if (kind == 26u && (options & 2u)) {
            right = source | ((u64)variant << 3u);
        } else if (width) {
            u8 bytes[8];
            if (!x86_direct_read(x86, address, bytes, 8u, user)) return 0;
            right = load_u64(bytes);
        } else {
            right = x86->x87_significand[source];
        }
        u64 left = x86->x87_significand[target];
        u64 result;
        if (kind == 23u) {
            result = options == 0u ? left ^ right
                   : options == 1u ? left & right : left | right;
        } else if (kind == 24u) {
            u64 unequal = left ^ right;
            u64 zero_high = ~(unequal
                | ((unequal & 0x7f7f7f7f7f7f7f7full)
                   + 0x7f7f7f7f7f7f7f7full))
                & 0x8080808080808080ull;
            result = (zero_high >> 7u) * 0xffu;
        } else if (kind == 25u) {
            result = (u64)-(i64)((i32)left > (i32)right)
                   & 0x00000000ffffffffull;
            result |= ((u64)-(i64)((i32)(left >> 32u)
                                   > (i32)(right >> 32u)))
                   & 0xffffffff00000000ull;
        } else {
            u32 shift = (u32)right & 31u;
            u32 valid = (u32)-(right < 32u);
            u32 low = (options & 1u) ? (u32)left << shift
                                    : (u32)left >> shift;
            u32 high = (options & 1u) ? (u32)(left >> 32u) << shift
                               : (u32)(left >> 32u) >> shift;
            result = (u64)(low & valid) | ((u64)(high & valid) << 32u);
        }
        x86->x87_significand[target] = result;
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 37u) {
        u64 right;
        if (width) {
            u8 bytes[8] = {0};
            if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
            right = load_u64(bytes);
        } else {
            right = x86->x87_significand[source];
        }
        u64 left = x86->x87_significand[target];
        u32 operation = options | (variant << 2u);
        u64 result = 0u;
        if (operation >= 9u) {
            result = x86_packed_extended64(left, right, operation);
        } else if (operation == 0u) {
            result = (u64)((u32)left - (u32)right)
                   | ((u64)((u32)(left >> 32u)
                            - (u32)(right >> 32u)) << 32u);
        } else if (operation == 8u) {
            result = left - right;
        } else if (operation == 1u || operation == 3u
                || operation == 4u || operation == 7u) {
            for (u32 lane = 0u; lane < 4u; ++lane) {
                u32 shift = lane * 16u;
                u32 l = (u32)(left >> shift) & 0xffffu;
                u32 r = (u32)(right >> shift) & 0xffffu;
                u32 value;
                if (operation == 1u) value = l == r ? 0xffffu : 0u;
                else if (operation == 3u) value = (l * r) & 0xffffu;
                else if (operation == 7u) value = (l + r) & 0xffffu;
                else {
                    i32 signed_l = (l & 0x8000u)
                                 ? (i32)l - 0x10000 : (i32)l;
                    i32 signed_r = (r & 0x8000u)
                                 ? (i32)r - 0x10000 : (i32)r;
                    i32 difference = signed_l - signed_r;
                    if (difference > 32767) difference = 32767;
                    if (difference < -32768) difference = -32768;
                    value = (u32)difference & 0xffffu;
                }
                result |= (u64)value << shift;
            }
        } else if (operation == 2u) {
            result = (u64)-(i64)((u32)left == (u32)right)
                   & 0x00000000ffffffffull;
            result |= ((u64)-(i64)((u32)(left >> 32u)
                                   == (u32)(right >> 32u)))
                   & 0xffffffff00000000ull;
        } else {
            for (u32 lane = 0u; lane < 8u; ++lane) {
                u32 shift = lane * 8u;
                u32 l = (u32)(left >> shift) & 0xffu;
                u32 r = (u32)(right >> shift) & 0xffu;
                u32 value;
                if (operation == 5u) {
                    i32 signed_l = (l & 0x80u)
                                 ? (i32)l - 0x100 : (i32)l;
                    i32 signed_r = (r & 0x80u)
                                 ? (i32)r - 0x100 : (i32)r;
                    i32 difference = signed_l - signed_r;
                    if (difference > 127) difference = 127;
                    if (difference < -128) difference = -128;
                    value = (u32)difference & 0xffu;
                } else {
                    value = (l + r) & 0xffu;
                }
                result |= (u64)value << shift;
            }
        }
        x86->x87_significand[target] = result;
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 38u) {
        u64 input;
        if (width) {
            u8 bytes[8];
            if (!x86_direct_read(x86, address, bytes, 8u, user)) return 0;
            input = load_u64(bytes);
        } else {
            input = x86->x87_significand[source];
        }
        u64 result = 0u;
        for (u32 lane = 0u; lane < 4u; ++lane) {
            u32 selected = (immediate >> (lane * 2u)) & 3u;
            result |= ((input >> (selected * 16u)) & 0xffffu)
                   << (lane * 16u);
        }
        x86->x87_significand[target] = result;
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 39u) {
        u64 count;
        if (options & 2u) {
            count = source | ((u64)variant << 3u);
        } else if (width) {
            u8 bytes[8];
            if (!x86_direct_read(x86, address, bytes, 8u, user)) return 0;
            count = load_u64(bytes);
        } else {
            count = x86->x87_significand[source];
        }
        u64 input = x86->x87_significand[target];
        u32 shift = (u32)count & 63u;
        u64 valid = 0ull - (u64)(count < 64u);
        u64 result = (options & 1u) ? input << shift : input >> shift;
        x86->x87_significand[target] = result & valid;
        x86->x87_sign_exponent[target] = 0xffffu;
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 40u) {
        if (options) {
            u32 value = (u32)x86->x87_significand[source];
            if (width) {
                u8 bytes[4];
                store_u32(bytes, value);
                if (!x86_direct_access_ready(x86, address, 4u, 1, user))
                    return 0;
                if (x86_virtual_write(address, bytes, 4u, user) != 1) {
                    x86_direct_memory_abort(x86, 0xffu);
                    return 0;
                }
            } else {
                x86->registers[variant] = value;
            }
        } else {
            u32 value;
            if (width) {
                u8 bytes[4];
                if (!x86_direct_read(x86, address, bytes, 4u, user)) return 0;
                value = read_u32(bytes);
            } else {
                value = (u32)x86->registers[variant];
            }
            x86->x87_significand[target] = value;
            x86->x87_sign_exponent[target] = 0xffffu;
        }
        x86->x87_tag = 0u;
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 27u) {
        u8 bytes[10];
        if (!x86_direct_read(x86, address, bytes, 10u, user)) return 0;
        u64 magnitude = 0u;
        u32 exceptions = 0u;
        for (u32 index = 9u; index; --index) {
            u32 packed = bytes[index - 1u];
            u32 low = packed & 15u;
            u32 high = packed >> 4u;
            if (low > 9u || high > 9u) exceptions = 1u;
            magnitude = magnitude * 100u + high * 10u + low;
        }
        u32 top = (x86_x87_top(x86) - 1u) & 7u;
        if (x86_x87_tag(x86, top) != 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u)
                                                    | (1u << 9u)));
            exceptions = 1u;
        }
        int unmasked = x86_x87_exception(x86, exceptions);
        if (!unmasked) {
            if (exceptions) {
                x86_x87_default_nan(x86, top);
            } else {
                i64 integer = (bytes[9] & 0x80u)
                            ? -(i64)magnitude : (i64)magnitude;
                u32 tag;
                x86_x87_from_integer(
                    integer, &x86->x87_significand[top],
                    &x86->x87_sign_exponent[top], &tag);
                x86_x87_set_tag(x86, top, tag);
            }
            x86_x87_set_top(x86, top);
        }
        x86->x87_ip = x86->rip;
        x86->x87_dp = address;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind == 28u) {
        if (!x86_direct_access_ready(x86, address, 10u, 1, user)) return 0;
        u32 top = x86_x87_top(x86);
        u32 exceptions = 0u;
        u32 rounded_up = 0u;
        u64 encoded = 0x8000000000000000ull;
        int empty = x86_x87_tag(x86, top) == 3u;
        if (empty) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
        } else {
            x86_x87_to_integer(
                x86, top, 64u, 0, &encoded, &exceptions, &rounded_up);
        }
        i64 integer = (i64)encoded;
        if (!(exceptions & 1u)
                && (integer >= 1000000000000000000ll
                    || integer <= -1000000000000000000ll))
            exceptions |= 1u;
        u8 bytes[10] = {0};
        if (exceptions & 1u) {
            bytes[7] = 0xc0u;
            bytes[8] = 0xffu;
            bytes[9] = 0xffu;
        } else {
            bytes[9] = (u8)((x86->x87_sign_exponent[top] >> 8u) & 0x80u);
            u64 magnitude = integer < 0 ? (u64)-integer : (u64)integer;
            for (u32 index = 0u; index < 9u; ++index) {
                u32 pair = (u32)(magnitude % 100u);
                magnitude /= 100u;
                bytes[index] = (u8)(((pair / 10u) << 4u) | (pair % 10u));
            }
        }
        x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                        | ((pl_u16)rounded_up << 9u));
        int unmasked = x86_x87_exception(x86, exceptions);
        if (!unmasked) {
            if (!x86_x87_write_raw_prepared(
                    x86, address, bytes, 10u, user)) return 0;
            x86_x87_set_tag(x86, top, 3u);
            x86_x87_set_top(x86, (top + 1u) & 7u);
        }
        x86->x87_ip = x86->rip;
        x86->x87_dp = address;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    if (kind >= 29u && kind <= 35u) {
        if (kind == 29u)
            return x86_x87_write_integer(
                x86, address, x86->x87_control, 2u, user);
        if (kind == 30u) {
            u8 bytes[2];
            if (!x86_direct_read(x86, address, bytes, 2u, user)) return 0;
            x86->x87_control = read_u16(bytes);
            return 1;
        }
        if (kind == 31u) {
            if (width)
                return x86_x87_write_integer(
                    x86, address, x86->x87_status, 2u, user);
            x86->registers[0] = (x86->registers[0] & ~0xffffull)
                              | x86->x87_status;
            return 1;
        }
        u32 environment = width >= 94u ? width - 80u : width;
        u8 bytes[108];
        if (kind == 32u || kind == 34u) {
            if (!x86_direct_access_ready(
                    x86, address, width, 1, user)) return 0;
            x86_x87_store_environment(x86, bytes, environment);
            if (kind == 34u) {
                u32 top = x86_x87_top(x86);
                for (u32 logical = 0u; logical < 8u; ++logical) {
                    u32 physical = (top + logical) & 7u;
                    u32 at = environment + logical * 10u;
                    store_u64(bytes + at, x86->x87_significand[physical]);
                    bytes[at + 8u] = (u8)x86->x87_sign_exponent[physical];
                    bytes[at + 9u] =
                        (u8)(x86->x87_sign_exponent[physical] >> 8u);
                }
            }
            if (!x86_x87_write_raw_prepared(
                    x86, address, bytes, width, user)) return 0;
            if (kind == 32u) x86->x87_control |= 0x3fu;
            else x86_x87_reset(x86);
            return 1;
        }
        if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
        x86_x87_load_environment(x86, bytes, environment);
        if (kind == 35u) {
            u32 top = x86_x87_top(x86);
            for (u32 logical = 0u; logical < 8u; ++logical) {
                u32 physical = (top + logical) & 7u;
                u32 at = environment + logical * 10u;
                x86->x87_significand[physical] = load_u64(bytes + at);
                x86->x87_sign_exponent[physical] = read_u16(bytes + at + 8u);
            }
        }
        return 1;
    }

    if (kind == 8u) {
        u32 top = x86_x87_top(x86);
        u32 destination = (top + target) & 7u;
        u64 right_sig;
        pl_u16 right_se;
        u32 right_tag;
        if (width) {
            u8 bytes[8] = {0};
            if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
            u64 raw = 0u;
            for (u32 index = 0u; index < width; ++index)
                raw |= (u64)bytes[index] << (index * 8u);
            x86_x87_from_binary(
                raw, width, &right_sig, &right_se, &right_tag);
        } else {
            u32 other = (top + source) & 7u;
            right_sig = x86->x87_significand[other];
            right_se = x86->x87_sign_exponent[other];
            right_tag = x86_x87_tag(x86, other);
        }
        u32 exceptions = 0u;
        if (x86_x87_tag(x86, destination) == 3u || right_tag == 3u) {
            x86->x87_status = (pl_u16)((x86->x87_status | (1u << 6u))
                            & ~(1u << 9u));
            exceptions = 1u;
            x86_x87_default_nan(x86, destination);
        } else {
            x86_x87_add_value(
                x86, destination, right_sig, right_se,
                right_tag, &exceptions);
        }
        int unmasked = x86_x87_exception(x86, exceptions);
        x86->x87_ip = x86->rip;
        x86->x87_dp = width ? address : 0u;
        x86->x87_opcode = (pl_u16)fop;
        if ((options & 1u) && !unmasked) {
            x86_x87_set_tag(x86, top, 3u);
            x86_x87_set_top(x86, (top + 1u) & 7u);
        }
        return 1;
    }

    if (kind == 1u) {
        u8 bytes[8] = {0};
        if (!x86_direct_read(x86, address, bytes, width, user)) return 0;
        u64 raw = 0u;
        for (u32 index = 0u; index < width; ++index)
            raw |= (u64)bytes[index] << (index * 8u);
        u32 source_bits = width * 8u;
        if (source_bits < 64u && (raw & (1ull << (source_bits - 1u))))
            raw |= ~0ull << source_bits;
        u32 top = (x86_x87_top(x86) - 1u) & 7u;
        if (x86_x87_tag(x86, top) != 3u) {
            x86->x87_status |= (1u << 6u) | (1u << 9u);
            int unmasked = x86_x87_exception(x86, 1u);
            x86->x87_ip = x86->rip;
            x86->x87_dp = address;
            x86->x87_opcode = (pl_u16)fop;
            if (unmasked) return 1;
            x86->x87_significand[top] = 0xc000000000000000ull;
            x86->x87_sign_exponent[top] = 0xffffu;
            x86_x87_set_tag(x86, top, 2u);
        } else {
            u32 tag;
            x86_x87_from_integer(
                (i64)raw, &x86->x87_significand[top],
                &x86->x87_sign_exponent[top], &tag);
            x86_x87_set_tag(x86, top, tag);
        }
        x86_x87_set_top(x86, top);
        x86->x87_ip = x86->rip;
        x86->x87_dp = address;
        x86->x87_opcode = (pl_u16)fop;
        return 1;
    }

    u32 top = x86_x87_top(x86);
    u64 value = 1ull << (width * 8u - 1u);
    u32 exceptions = 1u;
    u32 rounded_up = 0u;
    int stack_empty = x86_x87_tag(x86, top) == 3u;
    if (!stack_empty)
        x86_x87_to_integer(
            x86, top, width * 8u, kind == 2u,
            &value, &exceptions, &rounded_up);
    else
        x86->x87_status |= 1u << 6u;
    x86->x87_status = (pl_u16)((x86->x87_status & ~(1u << 9u))
                    | ((pl_u16)rounded_up << 9u));
    int unmasked = x86_x87_exception(x86, exceptions);
    x86->x87_ip = x86->rip;
    x86->x87_dp = address;
    x86->x87_opcode = (pl_u16)fop;
    if (unmasked) return 1;
    if (!x86_x87_write_integer(x86, address, value, width, user)) return 0;
    if (kind == 2u || kind == 3u) {
        x86_x87_set_tag(x86, top, 3u);
        x86_x87_set_top(x86, (top + 1u) & 7u);
    }
    return 1;
}

EXPORT int vm_x86_direct_read_selector(
        u32 machine, u64 address, u64 descriptor)
{
    X86Workspace *x86 = x86_machine();
    u32 segment = (u32)descriptor & 0xffu;
    u32 memory = (u32)(descriptor >> 8u) & 1u;
    u32 target = (u32)(descriptor >> 16u) & 0xffu;
    u32 bits = (u32)(descriptor >> 24u) & 0xffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || segment > 7u
            || (memory ? (target || bits != 16u)
                       : (target >= X86_REGISTER_COUNT
                          || (bits != 16u && bits != 32u && bits != 64u)))
            || descriptor != (segment | ((u64)memory << 8u)
                | ((u64)target << 16u) | ((u64)bits << 24u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (segment >= 6u && (x86->system[X86_SYS_CS] & 3u)
            && (x86->cr4 & (1u << 11u))) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u64 selector = segment < 6u
                 ? x86->system[X86_SYS_ES + segment] & 0xffffu
                 : x86->system[X86_SYS_LDTR + segment - 6u] & 0xffffu;
    if (!memory) {
        x86_direct_set_gpr_lane(x86, target, bits / 8u, 0u, selector);
        return 1;
    }
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    if (!x86_direct_access_ready(x86, address, 2u, 1, user)) return 0;
    u8 bytes[2] = { (u8)selector, (u8)(selector >> 8u) };
    if (x86_virtual_write(address, bytes, sizeof bytes, user) != 1) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    return 1;
}

EXPORT int vm_x86_direct_software_interrupt(
        u32 machine, u64 vector_word, u64 fallthrough)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || vector_word > 0xffu) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    u32 vector = (u32)vector_word;
    u32 error = vector * 8u + 2u;
    u64 offset = (u64)vector * 16u;
    if (offset + 15u > x86->system[X86_SYS_IDTR_LIMIT]) {
        x86_direct_exception(x86, 13u, 1u, error);
        return 0;
    }
    u8 gate[16];
    if (!x86_direct_read(
            x86, x86->system[X86_SYS_IDTR_BASE] + offset,
            gate, sizeof gate, 0))
        return 0;
    u32 type = gate[5] & 0x1fu;
    if (type != 0x0eu && type != 0x0fu) {
        x86_direct_exception(x86, 13u, 1u, error);
        return 0;
    }
    if (((u32)gate[5] >> 5u & 3u)
            < ((u32)x86->system[X86_SYS_CS] & 3u)) {
        x86_direct_exception(x86, 13u, 1u, error);
        return 0;
    }
    if (!(gate[5] & 0x80u)) {
        x86_direct_exception(x86, 11u, 1u, error);
        return 0;
    }
    /* INT is a trap: its frame observes the following RIP.  The common direct
     * fault return then performs the already-typed IDT transfer in C. */
    x86_direct_exception(x86, vector, 0u, 0u);
    x86->rip = fallthrough;
    x86->retired += 1u;
    return 0;
}

EXPORT int vm_x86_direct_swap_gs(
        u32 machine, u64 reserved0, u64 reserved1)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || reserved0 || reserved1) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (x86->system[X86_SYS_CS] & 3u) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if (!x86_swap_gs_bases()) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    return 1;
}

EXPORT int vm_x86_direct_invalidate_page(
        u32 machine, u64 address, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || reserved) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (x86->system[X86_SYS_CS] & 3u) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    /* Direct memory walks canonical guest page tables for every access; it
     * has no second virtual TLB to flush.  Retire any legacy clean alias if
     * one survived migration, while an absent alias is already the exact
     * invalidated state. */
    if (!x86_invalidate_virtual(address)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    return 1;
}

/* Control-register writes remain a named CPU/MMU action.  In particular CR3
 * always retires every resident virtual tag, even when the numeric root is
 * unchanged; compiled blocks can therefore never observe a page belonging to
 * the preceding address-space generation. */
EXPORT int vm_x86_direct_write_control(u32 machine, u64 coordinate, u64 value)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || coordinate > 0xffffffffu
            || (x86->system[X86_SYS_CS] & 3u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if (!x86_control_register_write((u32)coordinate, value)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    return 1;
}

EXPORT int vm_x86_direct_read_control(u32 machine, u64 coordinate, u64 target)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || target >= X86_REGISTER_COUNT
            || (coordinate != 0u && coordinate != 2u
                && coordinate != 3u && coordinate != 4u
                && coordinate != 8u)
            || (x86->system[X86_SYS_CS] & 3u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    x86->registers[(u32)target] =
        x86_control_register_read((u32)coordinate);
    return 1;
}

EXPORT int vm_x86_direct_debug_register(
        u32 machine, u64 descriptor, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    u32 write = (u32)descriptor & 1u;
    u32 debug = (u32)(descriptor >> 8u) & 0xffu;
    u32 reg = (u32)(descriptor >> 16u) & 0xffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || reserved
            || debug >= 8u || reg >= X86_REGISTER_COUNT
            || descriptor != (write | ((u64)debug << 8u)
                | ((u64)reg << 16u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (x86->system[X86_SYS_CS] & 3u) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if (debug == 4u || debug == 5u) {
        if (x86->cr4 & (1u << 3u)) {
            x86_direct_exception(x86, 6u, 0u, 0u);
            return 0;
        }
        debug += 2u;
    }
    u64 *debug_state = &x86->system[X86_SYS_DEBUG];
    if (debug_state[7] & (1u << 13u)) {
        debug_state[7] &= ~(1u << 13u);
        debug_state[6] |= 1u << 13u;
        x86_direct_exception(x86, 1u, 0u, 0u);
        return 0;
    }
    if (!write) {
        x86->registers[reg] = debug_state[debug];
        return 1;
    }
    u64 value = x86->registers[reg];
    if (debug >= 6u && (value >> 32u)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if (debug == 6u) value |= 0xffff0ff0u;
    if (debug == 7u) value |= 0x00000400u;
    debug_state[debug] = value;
    return 1;
}

static int x86_direct_read(X86Workspace *x86, u64 address, u8 *target,
                           u32 bytes, int user)
{
    int status = x86_virtual_read_access(address, target, bytes, user);
    if (!status) {
        x86->direct_memory_result = pl_vm_result_make(
            PL_VM_BARRIER, x86->physical_status);
        return 0;
    }
    if (status < 0) {
        x86_direct_page_fault(x86, address, 0, 0, status == -2);
        return 0;
    }
    return 1;
}

EXPORT int vm_x86_direct_cr0_status(
        u32 machine, u64 value, u64 descriptor_word)
{
    X86Workspace *x86 = x86_machine();
    u32 kind = (u32)descriptor_word & 0xffu;
    u32 memory = (u32)(descriptor_word >> 8u) & 1u;
    u32 source = (u32)(descriptor_word >> 16u) & 0xffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || kind > 1u
            || (kind ? (memory || source)
                     : (memory ? source != 0u
                               : source >= X86_REGISTER_COUNT))
            || descriptor_word != (kind | ((u64)memory << 8u)
                | ((u64)source << 16u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (x86->system[X86_SYS_CS] & 3u) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u64 next;
    if (kind) {
        next = x86->cr0 & ~(1ull << 3u);
    } else {
        u32 status = (u32)value & 0xffffu;
        if (memory) {
            u8 encoded[2];
            if (!x86_direct_read(x86, value, encoded, sizeof encoded, 0))
                return 0;
            status = read_u16(encoded);
        }
        /* Low four bits are replaced, except that an established PE bit is
         * monotone.  This is the closed form of LMSW's two assignments. */
        next = (x86->cr0 & ~0xeull) | ((u64)status & 0xfull);
    }
    if (!x86_control_register_write(0u, next)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    return 1;
}

static u64 x86_descriptor_base(const u8 descriptor[8])
{
    return (u64)read_u16(descriptor + 2u)
         | ((u64)descriptor[4] << 16u)
         | ((u64)descriptor[7] << 24u);
}

static u64 x86_descriptor_limit(const u8 descriptor[8])
{
    u64 limit = (u64)read_u16(descriptor)
              | ((u64)(descriptor[6] & 0x0fu) << 16u);
    return descriptor[6] & 0x80u ? (limit << 12u) | 0xfffu : limit;
}

/* Resolve a selector without materializing a host-side descriptor cache.
 * GDT/LDT bytes stay guest-owned and are fetched through the same physical
 * page lease as ordinary direct memory.  Invalid table geometry becomes the
 * architecturally named #GP cut; a cold page remains restartable. */
static int x86_direct_descriptor_probe(X86Workspace *x86, u32 selector,
                                       u8 descriptor[8])
{
    u64 base = x86->system[X86_SYS_GDTR_BASE];
    u64 limit = x86->system[X86_SYS_GDTR_LIMIT];
    if (selector & 4u) {
        u32 ldtr = (u32)x86->system[X86_SYS_LDTR] & 0xffffu;
        u64 offset = (u64)(ldtr & 0xfff8u);
        u32 bytes = (x86->efer & (1u << 10u)) ? 16u : 8u;
        u8 ldt[16];
        if (!(ldtr & 0xfff8u) || (ldtr & 4u)
                || offset > limit || limit - offset < bytes - 1u) {
            return -1;
        }
        if (!x86_direct_read(x86, base + offset, ldt, bytes, 0))
            return 0;
        if ((ldt[5] & 0x10u) || (ldt[5] & 0x0fu) != 2u
                || !(ldt[5] & 0x80u)) {
            return -1;
        }
        base = x86_descriptor_base(ldt);
        if (bytes == 16u) base |= (u64)read_u32(ldt + 8u) << 32u;
        limit = x86_descriptor_limit(ldt);
    }
    u64 offset = (u64)(selector & 0xfff8u);
    if (offset > limit || limit - offset < 7u) return -1;
    return x86_direct_read(x86, base + offset, descriptor, 8u, 0);
}

static int x86_direct_descriptor(X86Workspace *x86, u32 selector,
                                 u8 descriptor[8])
{
    int status = x86_direct_descriptor_probe(x86, selector, descriptor);
    if (status < 0)
        x86_direct_exception(x86, 13u, 1u, selector & 0xfffcu);
    return status > 0;
}

EXPORT int vm_x86_direct_validate_selector(
        u32 machine, u64 value, u64 descriptor_word)
{
    X86Workspace *x86 = x86_machine();
    u32 write = (u32)descriptor_word & 1u;
    u32 memory = (u32)(descriptor_word >> 1u) & 1u;
    u32 source = (u32)(descriptor_word >> 8u) & 0xffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || descriptor_word != (write | ((u64)memory << 1u)
                | ((u64)source << 8u))
            || (memory ? source != 0u : source >= X86_REGISTER_COUNT)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (!(x86->cr0 & 1u) || (x86->rflags & (1u << 17u))) {
        x86_direct_exception(x86, 6u, 0u, 0u);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u32 selector;
    if (memory) {
        u8 encoded[2];
        if (!x86_direct_read(
                x86, value, encoded, sizeof encoded,
                (x86->system[X86_SYS_CS] & 3u) != 0u))
            return 0;
        selector = read_u16(encoded);
    } else {
        selector = (u32)value & 0xffffu;
    }

    int valid = 0;
    if (selector & 0xfffcu) {
        u8 encoded[8];
        int status = x86_direct_descriptor_probe(x86, selector, encoded);
        if (!status) return 0;
        if (status > 0) {
            u32 access = encoded[5];
            u32 type = access & 0x0fu;
            u32 dpl = (access >> 5u) & 3u;
            u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
            u32 rpl = selector & 3u;
            u32 privilege = cpl > rpl ? cpl : rpl;
            int code = (type & 8u) != 0u;
            if (access & 0x10u) {
                if (write)
                    valid = !code && (type & 2u) && privilege <= dpl;
                else if (code)
                    valid = (type & 2u)
                         && ((type & 4u) || privilege <= dpl);
                else
                    valid = privilege <= dpl;
            }
        }
    }
    x86->rflags = (x86->rflags & ~(1ull << 6u)) | ((u64)valid << 6u);
    return 1;
}

EXPORT int vm_x86_direct_system_selector(
        u32 machine, u64 value, u64 descriptor_word)
{
    X86Workspace *x86 = x86_machine();
    u32 kind = (u32)descriptor_word & 0xffu;
    u32 memory = (u32)(descriptor_word >> 8u) & 1u;
    u32 source = (u32)(descriptor_word >> 16u) & 0xffu;
    u32 target = (u32)(descriptor_word >> 24u) & 0xffu;
    u32 width = (u32)(descriptor_word >> 32u) & 0xffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || kind > 3u
            || (memory ? source : source >= X86_REGISTER_COUNT)
            || (kind < 2u
                ? (target >= X86_REGISTER_COUNT
                   || (width != 32u && width != 64u))
                : (target || width))
            || descriptor_word != (kind | ((u64)memory << 8u)
                | ((u64)source << 16u) | ((u64)target << 24u)
                | ((u64)width << 32u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (!(x86->cr0 & 1u) || (x86->rflags & (1u << 17u))) {
        x86_direct_exception(x86, 6u, 0u, 0u);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u32 selector;
    if (memory) {
        u8 encoded[2];
        if (!x86_direct_read(
                x86, value, encoded, sizeof encoded,
                (x86->system[X86_SYS_CS] & 3u) != 0u))
            return 0;
        selector = read_u16(encoded);
    } else {
        selector = (u32)value & 0xffffu;
    }

    if (kind == 3u) {
        if (x86->system[X86_SYS_CS] & 3u) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        if (!(selector & 0xfffcu)) {
            x86->system[X86_SYS_TR] = 0u;
            return 1;
        }
        u32 error = selector & 0xfffcu;
        if (selector & 4u) {
            x86_direct_exception(x86, 13u, 1u, error);
            return 0;
        }
        u64 offset = selector & 0xfff8u;
        u64 limit = x86->system[X86_SYS_GDTR_LIMIT];
        u32 bytes = (x86->efer & (1u << 10u)) ? 16u : 8u;
        if (offset > limit || limit - offset < bytes - 1u) {
            x86_direct_exception(x86, 13u, 1u, error);
            return 0;
        }
        u64 descriptor_address = x86->system[X86_SYS_GDTR_BASE] + offset;
        u8 encoded[16];
        if (!x86_direct_read(
                x86, descriptor_address, encoded, bytes, 0))
            return 0;
        u32 type = encoded[5] & 0x0fu;
        if ((encoded[5] & 0x10u) || (type != 1u && type != 9u)
                || (bytes == 16u && (encoded[13] & 0x0fu))) {
            x86_direct_exception(x86, 13u, 1u, error);
            return 0;
        }
        if (!(encoded[5] & 0x80u)) {
            x86_direct_exception(x86, 11u, 1u, error);
            return 0;
        }
        if (!x86_direct_access_ready(
                x86, descriptor_address + 5u, 1u, 1, 0))
            return 0;
        u8 busy = encoded[5] | 2u;
        if (x86_virtual_write(
                descriptor_address + 5u, &busy, 1u, 0) != 1) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        x86->system[X86_SYS_TR] = selector;
        return 1;
    }

    if (kind == 2u) {
        if (x86->system[X86_SYS_CS] & 3u) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        if (!(selector & 0xfffcu)) {
            x86->system[X86_SYS_LDTR] = 0u;
            return 1;
        }
        if (selector & 4u) {
            x86_direct_exception(x86, 13u, 1u, selector & 0xfffcu);
            return 0;
        }
        u64 offset = selector & 0xfff8u;
        u64 limit = x86->system[X86_SYS_GDTR_LIMIT];
        u32 bytes = (x86->efer & (1u << 10u)) ? 16u : 8u;
        if (offset > limit || limit - offset < bytes - 1u) {
            x86_direct_exception(x86, 13u, 1u, selector & 0xfffcu);
            return 0;
        }
        u8 encoded[16];
        if (!x86_direct_read(
                x86, x86->system[X86_SYS_GDTR_BASE] + offset,
                encoded, bytes, 0))
            return 0;
        if ((encoded[5] & 0x10u) || (encoded[5] & 0x0fu) != 2u) {
            x86_direct_exception(x86, 13u, 1u, selector & 0xfffcu);
            return 0;
        }
        if (!(encoded[5] & 0x80u)) {
            x86_direct_exception(x86, 11u, 1u, selector & 0xfffcu);
            return 0;
        }
        x86->system[X86_SYS_LDTR] = selector;
        return 1;
    }

    int valid = 0;
    u64 result = 0u;
    if (selector & 0xfffcu) {
        u8 encoded[8];
        int status = x86_direct_descriptor_probe(x86, selector, encoded);
        if (!status) return 0;
        if (status > 0) {
            u32 access = encoded[5];
            u32 type = access & 0x0fu;
            u32 dpl = (access >> 5u) & 3u;
            u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
            u32 rpl = selector & 3u;
            u32 privilege = cpl > rpl ? cpl : rpl;
            int conforming = (access & 0x10u)
                          && (type & 8u) && (type & 4u);
            valid = conforming || privilege <= dpl;
            if (!(access & 0x10u)) {
                valid = valid && (kind == 0u
                    ? (type == 1u || type == 2u || type == 3u
                       || type == 4u || type == 5u || type == 9u
                       || type == 11u || type == 12u)
                    : (type == 1u || type == 2u || type == 3u
                       || type == 9u || type == 11u));
            }
            if (valid) result = kind == 0u
                              ? read_u32(encoded + 4u) & 0x00f0ff00u
                              : x86_descriptor_limit(encoded);
        }
    }
    x86->rflags = (x86->rflags & ~(1ull << 6u)) | ((u64)valid << 6u);
    if (valid) x86->registers[target] = result;
    return 1;
}

EXPORT int vm_x86_direct_descriptor_table(
        u32 machine, u64 address, u64 descriptor)
{
    X86Workspace *x86 = x86_machine();
    u32 table = (u32)descriptor & 1u;
    u32 store = (u32)(descriptor >> 1u) & 1u;
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || descriptor != (table | ((u64)store << 1u))) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    if ((!store && cpl) || (store && cpl && (x86->cr4 & (1u << 11u)))) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u8 encoded[10];
    u32 coordinate = table ? X86_SYS_IDTR_BASE : X86_SYS_GDTR_BASE;
    if (store) {
        if (!x86_direct_access_ready(
                x86, address, sizeof encoded, 1, cpl != 0u))
            return 0;
        u64 limit = x86->system[coordinate + 1u];
        encoded[0] = (u8)limit;
        encoded[1] = (u8)(limit >> 8u);
        store_u64(encoded + 2u, x86->system[coordinate]);
        if (x86_virtual_write(
                address, encoded, sizeof encoded, cpl != 0u) != 1) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        return 1;
    }
    if (!x86_direct_read(x86, address, encoded, sizeof encoded, 0))
        return 0;
    x86->system[coordinate + 1u] = read_u16(encoded);
    x86->system[coordinate] = load_u64(encoded + 2u);
    return 1;
}

EXPORT int vm_x86_direct_write_segment(
        u32 machine, u64 descriptor_word, u64 value)
{
    X86Workspace *x86 = x86_machine();
    u32 segment = (u32)descriptor_word & 0xffu;
    u32 source = (u32)(descriptor_word >> 8u) & 0xffu;
    u32 memory = (u32)(descriptor_word >> 16u) & 1u;
    u32 far_load = (u32)(descriptor_word >> 17u) & 1u;
    u32 target = (u32)(descriptor_word >> 24u) & 0xffu;
    u32 target_width = (u32)(descriptor_word >> 32u) & 0xffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || segment >= 6u || segment == 1u
            || (memory ? source != 0u : source >= X86_REGISTER_COUNT)
            || (far_load && (!memory || target >= X86_REGISTER_COUNT
                || (target_width != 32u && target_width != 64u)))
            || (!far_load && (target || target_width))
            || descriptor_word != (segment | ((u64)source << 8u)
                | ((u64)memory << 16u) | ((u64)far_load << 17u)
                | ((u64)target << 24u) | ((u64)target_width << 32u))) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u32 selector;
    u64 loaded_offset = 0u;
    if (memory) {
        u8 encoded[10];
        u32 offset_bytes = far_load ? target_width >> 3u : 0u;
        u32 bytes = offset_bytes + 2u;
        if (!x86_direct_read(
                x86, value, encoded, bytes,
                (x86->system[X86_SYS_CS] & 3u) != 0u))
            return 0;
        loaded_offset = target_width == 64u ? load_u64(encoded)
                      : far_load ? read_u32(encoded) : 0u;
        selector = read_u16(encoded + offset_bytes);
    } else {
        selector = (u32)value & 0xffffu;
    }
    u32 error = selector & 0xfffcu;
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    int stack = segment == 2u;
    if (!error) {
        if (stack) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        x86->system[X86_SYS_ES + (u32)segment] = 0u;
        if (far_load) x86->registers[target] = target_width == 32u
                                               ? (u32)loaded_offset
                                               : loaded_offset;
        return 1;
    }
    u8 descriptor[8];
    if (!x86_direct_descriptor(x86, selector, descriptor)) return 0;
    u32 access = descriptor[5];
    u32 type = access & 0x0fu;
    u32 dpl = (access >> 5u) & 3u;
    u32 rpl = selector & 3u;
    int code = (type & 8u) != 0u;
    int readable = !code || (type & 2u);
    int conforming = code && (type & 4u);
    int valid = (access & 0x10u) && readable;
    if (stack) {
        valid = valid && !code && (type & 2u)
             && rpl == cpl && dpl == cpl;
    } else if (!conforming) {
        u32 privilege = cpl > rpl ? cpl : rpl;
        valid = valid && privilege <= dpl;
    }
    if (!valid) {
        x86_direct_exception(x86, 13u, 1u, error);
        return 0;
    }
    if (!(access & 0x80u)) {
        x86_direct_exception(x86, stack ? 12u : 11u, 1u, error);
        return 0;
    }
    x86->system[X86_SYS_ES + (u32)segment] = selector;
    if (far_load) x86->registers[target] = target_width == 32u
                                           ? (u32)loaded_offset
                                           : loaded_offset;
    return 1;
}

static int x86_canonical(u64 value)
{
    u64 upper = value >> 48u;
    return (upper == 0u && !(value & (1ull << 47u)))
        || (upper == 0xffffu && (value & (1ull << 47u)));
}

EXPORT int vm_x86_direct_segment_stack(
        u32 machine, u64 descriptor_word, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    u32 pop = (u32)descriptor_word & 1u;
    u32 segment = (u32)(descriptor_word >> 8u) & 0xffu;
    u32 width = (u32)(descriptor_word >> 16u) & 0xffu;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published || reserved
            || (segment != 4u && segment != 5u)
            || (width != 16u && width != 64u)
            || descriptor_word != (pop | ((u64)segment << 8u)
                | ((u64)width << 16u))) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u32 bytes = width / 8u;
    u64 old_rsp = x86->registers[X86_RSP];
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    if (!pop) {
        if (old_rsp < bytes) {
            x86_direct_exception(x86, 12u, 1u, 0u);
            return 0;
        }
        u64 next_rsp = old_rsp - bytes;
        if (!x86_canonical(next_rsp)
                || !x86_canonical(next_rsp + bytes - 1u)) {
            x86_direct_exception(x86, 12u, 1u, 0u);
            return 0;
        }
        if (!x86_direct_access_ready(
                x86, next_rsp, bytes, 1, cpl != 0u))
            return 0;
        u8 encoded[8] = {0};
        u32 selector = (u32)x86->system[X86_SYS_ES + segment] & 0xffffu;
        encoded[0] = (u8)selector;
        encoded[1] = (u8)(selector >> 8u);
        if (x86_virtual_write(
                next_rsp, encoded, bytes, cpl != 0u) != 1) {
            x86_direct_memory_abort(x86, 0xffu);
            return 0;
        }
        x86->registers[X86_RSP] = next_rsp;
        return 1;
    }

    if (old_rsp > ~0ull - (bytes - 1u)
            || !x86_canonical(old_rsp)
            || !x86_canonical(old_rsp + bytes - 1u)) {
        x86_direct_exception(x86, 12u, 1u, 0u);
        return 0;
    }
    u8 encoded[8] = {0};
    if (!x86_direct_read(x86, old_rsp, encoded, bytes, cpl != 0u))
        return 0;
    u32 selector = read_u16(encoded);
    /* Segment validation precedes the stack publication.  A #GP/#NP keeps
     * RSP at the faulting POP, matching the two-stage architectural cut. */
    if (!vm_x86_direct_write_segment(machine, segment, selector)) return 0;
    x86->registers[X86_RSP] = old_rsp + bytes;
    return 1;
}

/* POPF is a restartable stack transfer followed by one privilege-dependent
 * flag mask.  QEMU's architectural oracle always updates arithmetic flags
 * and DF, admits IF only at CPL <= IOPL, and admits IOPL only at CPL0.  The
 * helper owns RSP and RFLAGS together so a cold stack page cannot publish a
 * half-retired instruction. */
EXPORT int vm_x86_direct_pop_flags(u32 machine, u64 width, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || reserved || (width != 16u && width != 64u)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u32 bytes = (u32)width / 8u;
    u64 old_rsp = x86->registers[X86_RSP];
    if (old_rsp > ~0ull - (bytes - 1u)
            || !x86_canonical(old_rsp)
            || !x86_canonical(old_rsp + bytes - 1u)) {
        x86_direct_exception(x86, 12u, 1u, 0u);
        return 0;
    }
    u8 encoded[8] = {0};
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    if (!x86_direct_read(x86, old_rsp, encoded, bytes, cpl != 0u))
        return 0;
    u64 candidate = width == 16u ? read_u16(encoded) : load_u64(encoded);
    u64 mask = 0x8d5u                 /* OF,SF,ZF,AF,PF,CF */
             | (1u << 10u)            /* DF */
             | (1u << 8u)             /* TF */
             | (1u << 14u)            /* NT */
             | (1u << 18u)            /* AC */
             | (1u << 21u);           /* ID */
    u32 iopl = (u32)(x86->rflags >> 12u) & 3u;
    if (cpl == 0u) mask |= (1u << 9u) | (3u << 12u);
    else if (cpl <= iopl) mask |= 1u << 9u;
    if (width == 16u) mask &= 0xffffu;
    x86->rflags = ((x86->rflags & ~mask) | (candidate & mask) | 2u);
    x86->registers[X86_RSP] = old_rsp + bytes;
    return 1;
}

/* Long-mode far return is one typed machine transfer, not a disguised RET
 * plan.  All stack and descriptor reads complete before CS/RSP/RIP publish,
 * so a delivery barrier or fault can re-enter the same emitted function with
 * no record reconstruction.  The validation order follows QEMU's protected
 * return oracle: CS shape/RPL/DPL/present, then an optional outer SS frame. */
EXPORT int vm_x86_direct_far_return(u32 machine, u64 addend, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || reserved || addend > 0xffffu)
        return 0;
    x86->direct_memory_result = 0u;
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    u64 old_rsp = x86->registers[X86_RSP];
    if (old_rsp > ~0ull - 15u) {
        x86_direct_exception(x86, 12u, 1u, 0u);
        return 0;
    }
    u8 frame[16];
    if (!x86_direct_read(x86, old_rsp, frame, sizeof frame, cpl != 0u))
        return 0;
    u64 target = load_u64(frame);
    u32 new_cs = (u32)load_u64(frame + 8u) & 0xffffu;
    u32 cs_error = new_cs & 0xfffcu;
    if (!cs_error) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u8 cs[8];
    if (!x86_direct_descriptor(x86, new_cs, cs)) return 0;
    u32 access = cs[5];
    u32 rpl = new_cs & 3u;
    u32 dpl = (access >> 5u) & 3u;
    int code = (access & 0x10u) && (access & 8u);
    int conforming = (access & 4u) != 0u;
    if (!code || rpl < cpl
            || (conforming ? dpl > rpl : dpl != rpl)) {
        x86_direct_exception(x86, 13u, 1u, cs_error);
        return 0;
    }
    if (!(access & 0x80u)) {
        x86_direct_exception(x86, 11u, 1u, cs_error);
        return 0;
    }
    if (!x86_canonical(target)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }

    u64 next_rsp;
    u32 new_ss = (u32)x86->system[X86_SYS_SS] & 0xffffu;
    if (rpl == cpl) {
        if (old_rsp > ~0ull - 16u - addend) {
            x86_direct_exception(x86, 12u, 1u, 0u);
            return 0;
        }
        next_rsp = old_rsp + 16u + addend;
    } else {
        if (old_rsp > ~0ull - 31u - addend) {
            x86_direct_exception(x86, 12u, 1u, 0u);
            return 0;
        }
        u8 outer[16];
        if (!x86_direct_read(
                x86, old_rsp + 16u + addend, outer, sizeof outer,
                cpl != 0u))
            return 0;
        next_rsp = load_u64(outer);
        new_ss = (u32)load_u64(outer + 8u) & 0xffffu;
        u32 ss_error = new_ss & 0xfffcu;
        if (!ss_error) {
            /* A null SS is valid only for a non-ring-3 long-mode target. */
            if (!(x86->efer & (1ull << 10u)) || rpl == 3u) {
                x86_direct_exception(x86, 13u, 1u, 0u);
                return 0;
            }
        } else {
            u8 ss[8];
            if ((new_ss & 3u) != rpl) {
                x86_direct_exception(x86, 13u, 1u, ss_error);
                return 0;
            }
            if (!x86_direct_descriptor(x86, new_ss, ss)) return 0;
            u32 ss_access = ss[5];
            u32 ss_dpl = (ss_access >> 5u) & 3u;
            if (!(ss_access & 0x10u) || (ss_access & 8u)
                    || !(ss_access & 2u) || ss_dpl != rpl) {
                x86_direct_exception(x86, 13u, 1u, ss_error);
                return 0;
            }
            if (!(ss_access & 0x80u)) {
                x86_direct_exception(x86, 11u, 1u, ss_error);
                return 0;
            }
        }
        if (next_rsp > ~0ull - addend
                || !x86_canonical(next_rsp + addend)) {
            x86_direct_exception(x86, 12u, 1u, 0u);
            return 0;
        }
        next_rsp += addend;
    }
    x86->system[X86_SYS_CS] = new_cs;
    x86->system[X86_SYS_SS] = new_ss;
    x86->registers[X86_RSP] = next_rsp;
    x86->rip = target;
    x86->halted = 0u;
    return 1;
}

static int x86_direct_far_stack(
        X86Workspace *x86, u64 top, const u8 *frame, u32 bytes,
        u32 privilege, u64 *next)
{
    if (!bytes || bytes > 32u || top < bytes) {
        x86_direct_exception(x86, 12u, 1u, 0u);
        return 0;
    }
    u64 address = top - bytes;
    if (!x86_canonical(address) || !x86_canonical(top - 1u)) {
        x86_direct_exception(x86, 12u, 1u, 0u);
        return 0;
    }
    if (!x86_direct_access_ready(
            x86, address, bytes, 1, privilege != 0u))
        return 0;
    int written = x86_virtual_write(
        address, frame, bytes, privilege != 0u);
    if (!written) {
        x86->direct_memory_result = pl_vm_result_make(
            PL_VM_BARRIER, x86->physical_status);
        return 0;
    }
    if (written < 0) {
        x86_direct_page_fault(x86, address, 1, 0, written == -2);
        return 0;
    }
    *next = address;
    return 1;
}

/* A linked LONG_64 block owns far CALL/JMP as one descriptor transition.
 * The source pointer, descriptors, optional TSS stack and every destination
 * page are admitted before CS/RSP/RIP publish.  Thus a cold physical page
 * retries this same function and never exposes a partially pushed frame. */
EXPORT int vm_x86_direct_far_transfer(
        u32 machine, u64 pointer, u64 descriptor_word, u64 fallthrough)
{
    X86Workspace *x86 = x86_machine();
    u32 call_transfer = (u32)descriptor_word & 1u;
    u32 direct = (u32)(descriptor_word >> 1u) & 1u;
    u32 bits = (u32)(descriptor_word >> 8u) & 0xffu;
    u32 encoded_selector = (u32)(descriptor_word >> 16u) & 0xffffu;
    u64 canonical_descriptor = call_transfer
        | ((u64)direct << 1u) | ((u64)bits << 8u)
        | ((u64)encoded_selector << 16u);
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || (bits != 32u && bits != 48u && bits != 80u)
            || (!direct && encoded_selector)
            || descriptor_word != canonical_descriptor) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    /* This postlink module is decoded as LONG_64.  Reaching it under another
     * decode mode is a dispatcher identity failure, not an x86 fallback. */
    if (!(x86->efer & (1ull << 10u))) {
        x86_direct_memory_abort(x86, 0xfeu);
        return 0;
    }
    x86->direct_memory_result = 0u;
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    u64 target;
    u32 selector;
    if (direct) {
        target = bits == 32u ? pointer & 0xffffu
               : bits == 48u ? (u32)pointer : pointer;
        selector = encoded_selector;
    } else {
        u8 encoded[10];
        u32 bytes = bits / 8u;
        if (!x86_direct_read(
                x86, pointer, encoded, bytes, cpl != 0u))
            return 0;
        target = bits == 32u ? read_u16(encoded)
               : bits == 48u ? read_u32(encoded) : load_u64(encoded);
        selector = read_u16(encoded + bytes - 2u);
    }
    u32 selector_error = selector & 0xfffcu;
    if (!selector_error) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u8 descriptor[8];
    if (!x86_direct_descriptor(x86, selector, descriptor)) return 0;
    u32 access = descriptor[5];
    u32 type = access & 0x0fu;
    u32 dpl = (access >> 5u) & 3u;
    u32 rpl = selector & 3u;
    int code = (access & 0x10u) && (type & 8u);
    int conforming = code && (type & 4u);

    if (access & 0x10u) {
        if (!code || (conforming ? dpl > cpl
                : (rpl > cpl || dpl != cpl))) {
            x86_direct_exception(x86, 13u, 1u, selector_error);
            return 0;
        }
        if (!(access & 0x80u)) {
            x86_direct_exception(x86, 11u, 1u, selector_error);
            return 0;
        }
        int long_code = (descriptor[6] & 0x20u) != 0u;
        if ((long_code && (descriptor[6] & 0x40u))
                || (long_code ? !x86_canonical(target)
                              : target > x86_descriptor_limit(descriptor))) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        u64 next_rsp = x86->registers[X86_RSP];
        if (call_transfer) {
            u32 width = bits == 32u ? 2u : bits == 48u ? 4u : 8u;
            u8 frame[16] = {0};
            if (width == 8u) {
                store_u64(frame, fallthrough);
                store_u64(frame + 8u, x86->system[X86_SYS_CS] & 0xffffu);
            } else if (width == 4u) {
                store_u32(frame, (u32)fallthrough);
                store_u32(frame + 4u,
                          (u32)x86->system[X86_SYS_CS] & 0xffffu);
            } else {
                frame[0] = (u8)fallthrough;
                frame[1] = (u8)(fallthrough >> 8u);
                frame[2] = (u8)x86->system[X86_SYS_CS];
                frame[3] = (u8)(x86->system[X86_SYS_CS] >> 8u);
            }
            if (!x86_direct_far_stack(
                    x86, next_rsp, frame, width * 2u, cpl, &next_rsp))
                return 0;
        }
        x86->registers[X86_RSP] = next_rsp;
        x86->system[X86_SYS_CS] = (selector & 0xfffcu) | cpl;
        x86->rip = target;
        x86->halted = 0u;
        return 1;
    }

    /* IA-32e admits only a 64-bit call gate at this boundary.  Task gates
     * belong to a different decode-mode compiler identity. */
    if (type != 12u || dpl < cpl || dpl < rpl) {
        x86_direct_exception(x86, 13u, 1u, selector_error);
        return 0;
    }
    if (!(access & 0x80u)) {
        x86_direct_exception(x86, 11u, 1u, selector_error);
        return 0;
    }
    u8 upper[8];
    if (!x86_direct_descriptor(x86, selector + 8u, upper)) return 0;
    if ((upper[5] & 0x1fu) != 0u) {
        x86_direct_exception(x86, 13u, 1u, selector_error);
        return 0;
    }
    u32 target_selector = read_u16(descriptor + 2u);
    u32 target_error = target_selector & 0xfffcu;
    target = (u64)read_u16(descriptor)
           | ((u64)read_u16(descriptor + 6u) << 16u)
           | ((u64)read_u32(upper) << 32u);
    if (!target_error) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u8 target_descriptor[8];
    if (!x86_direct_descriptor(
            x86, target_selector, target_descriptor))
        return 0;
    u32 target_access = target_descriptor[5];
    u32 target_type = target_access & 0x0fu;
    u32 target_dpl = (target_access >> 5u) & 3u;
    int target_code = (target_access & 0x10u) && (target_type & 8u);
    int target_conforming = target_code && (target_type & 4u);
    if (!target_code || target_dpl > cpl
            || !(target_descriptor[6] & 0x20u)
            || (target_descriptor[6] & 0x40u)
            || !x86_canonical(target)) {
        x86_direct_exception(x86, 13u, 1u, target_error);
        return 0;
    }
    if (!(target_access & 0x80u)) {
        x86_direct_exception(x86, 11u, 1u, target_error);
        return 0;
    }
    if (!call_transfer) {
        if ((target_conforming && target_dpl > cpl)
                || (!target_conforming && target_dpl != cpl)) {
            x86_direct_exception(x86, 13u, 1u, target_error);
            return 0;
        }
        x86->system[X86_SYS_CS] = (target_selector & 0xfffcu) | cpl;
        x86->rip = target;
        x86->halted = 0u;
        return 1;
    }

    u32 new_cpl = !target_conforming && target_dpl < cpl
                ? target_dpl : cpl;
    u64 stack_top = x86->registers[X86_RSP];
    u64 next_rsp;
    if (new_cpl < cpl) {
        int loaded = x86_tss_stack(new_cpl, 0u, &stack_top);
        if (!loaded) {
            x86->direct_memory_result = pl_vm_result_make(
                PL_VM_BARRIER, x86->physical_status);
            return 0;
        }
        if (loaded < 0) {
            x86_direct_exception(
                x86, 10u, 1u,
                (u32)x86->system[X86_SYS_TR] & 0xfffcu);
            return 0;
        }
        u8 frame[32];
        store_u64(frame, fallthrough);
        store_u64(frame + 8u, x86->system[X86_SYS_CS] & 0xffffu);
        store_u64(frame + 16u, x86->registers[X86_RSP]);
        store_u64(frame + 24u, x86->system[X86_SYS_SS] & 0xffffu);
        if (!x86_direct_far_stack(
                x86, stack_top, frame, sizeof frame, new_cpl, &next_rsp))
            return 0;
        x86->system[X86_SYS_SS] = new_cpl;
    } else {
        u8 frame[16];
        store_u64(frame, fallthrough);
        store_u64(frame + 8u, x86->system[X86_SYS_CS] & 0xffffu);
        if (!x86_direct_far_stack(
                x86, stack_top, frame, sizeof frame, cpl, &next_rsp))
            return 0;
    }
    x86->registers[X86_RSP] = next_rsp;
    x86->system[X86_SYS_CS] = (target_selector & 0xfffcu) | new_cpl;
    x86->rip = target;
    x86->halted = 0u;
    return 1;
}

/* System entry/return replaces the complete privilege and instruction cut,
 * then re-enters total page dispatch.  The compiler supplies only the
 * decoded variant and SYSCALL's fallthrough. */
EXPORT int vm_x86_direct_system_transfer(
        u32 machine, u64 operation, u64 fallthrough)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || operation > 4u) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    if (operation <= 1u && !(x86->efer & 1u)) {
        x86_direct_exception(x86, 6u, 0u, 0u);
        return 0;
    }
    if (operation == 2u) {
        u32 selector = (u32)x86_msr_read(0x174u) & 0xffffu;
        if (!selector) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        x86->rflags &= ~((1ull << 9u) | (1ull << 16u)
                       | (1ull << 17u));
        x86->system[X86_SYS_CS] = selector & 0xfffcu;
        x86->system[X86_SYS_SS] = (selector + 8u) & 0xfffcu;
        x86->registers[X86_RSP] = x86_msr_read(0x175u);
        x86->rip = x86_msr_read(0x176u);
        x86->halted = 0u;
        return 1;
    }
    if (operation >= 3u) {
        u32 selector = (u32)x86_msr_read(0x174u) & 0xffffu;
        u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
        int wide = operation == 4u;
        if (!selector || cpl != 0u
                || (wide && (!x86_canonical(x86->registers[X86_RCX])
                             || !x86_canonical(
                                 x86->registers[X86_RDX])))) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        x86->registers[X86_RSP] = wide
            ? x86->registers[X86_RCX] : (u32)x86->registers[X86_RCX];
        x86->rip = wide
            ? x86->registers[X86_RDX] : (u32)x86->registers[X86_RDX];
        u32 offset = wide ? 32u : 16u;
        x86->system[X86_SYS_CS] = ((selector + offset) & 0xfffcu) | 3u;
        x86->system[X86_SYS_SS] = ((selector + offset + 8u) & 0xfffcu) | 3u;
        x86->halted = 0u;
        return 1;
    }
    u64 star = x86_msr_read(0xc0000081u);
    if (operation == 0u) {
        u64 selector = (star >> 32u) & 0xffffu;
        if (x86->efer & (1ull << 10u)) {
            x86->registers[X86_RCX] = fallthrough;
            x86->registers[X86_R11] = x86->rflags & ~(1ull << 16u);
            x86->rflags &= ~(x86_msr_read(0xc0000084u)
                           | (1ull << 16u));
            x86->rip = x86_msr_read(0xc0000082u);
        } else {
            x86->registers[X86_RCX] = (u32)fallthrough;
            x86->rflags &= ~((1ull << 9u) | (1ull << 16u)
                           | (1ull << 17u));
            x86->rip = (u32)star;
        }
        x86->system[X86_SYS_CS] = selector & 0xfffcu;
        x86->system[X86_SYS_SS] = (selector + 8u) & 0xfffcu;
    } else {
        u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
        if (!(x86->cr0 & 1u) || cpl != 0u) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
        u64 selector = (star >> 48u) & 0xffffu;
        if (x86->efer & (1ull << 10u)) {
            if (!x86_canonical(x86->registers[X86_RCX])) {
                x86_direct_exception(x86, 13u, 1u, 0u);
                return 0;
            }
            x86->rip = x86->registers[X86_RCX];
            x86->system[X86_SYS_CS] = (selector + 16u) | 3u;
        } else {
            x86->rip = (u32)x86->registers[X86_RCX];
            x86->system[X86_SYS_CS] = selector | 3u;
        }
        x86->system[X86_SYS_SS] = (selector + 8u) | 3u;
        const u64 flag_mask = (1ull << 8u) | (1ull << 9u)
                            | (3ull << 12u) | (1ull << 14u)
                            | (1ull << 16u) | (1ull << 17u)
                            | (1ull << 18u) | (1ull << 21u);
        x86->rflags = (x86->rflags & ~flag_mask)
                    | (x86->registers[X86_R11] & flag_mask) | 2u;
    }
    x86->halted = 0u;
    return 1;
}

/* IRET consumes its complete width-specific hardware frame as one restartable
 * transaction.  Nothing is published until stack, CS and SS have all been
 * read and validated, so a cold page or descriptor fault cannot expose a
 * half-returned privilege state. */
EXPORT int vm_x86_direct_interrupt_return(
        u32 machine, u64 width, u64 reserved)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || (width != 16u && width != 32u && width != 64u)
            || reserved) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0;
    }
    x86->direct_memory_result = 0u;
    if (!(x86->efer & (1ull << 10u)) || (x86->rflags & (1ull << 14u))) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u32 cpl = (u32)x86->system[X86_SYS_CS] & 3u;
    u64 old_rsp = x86->registers[X86_RSP];
    u32 slot = (u32)(width >> 3u);
    u32 frame_bytes = slot * 5u;
    if (old_rsp > ~0ull - (frame_bytes - 1u)) {
        x86_direct_exception(x86, 12u, 1u, 0u);
        return 0;
    }
    u8 frame[40];
    if (!x86_direct_read(x86, old_rsp, frame, frame_bytes, cpl != 0u))
        return 0;
    u64 target = width == 64u ? load_u64(frame)
               : width == 32u ? read_u32(frame) : read_u16(frame);
    u32 new_cs = (width == 64u ? (u32)load_u64(frame + slot)
                : width == 32u ? read_u32(frame + slot)
                               : read_u16(frame + slot)) & 0xffffu;
    u64 restored_flags = width == 64u ? load_u64(frame + slot * 2u)
                       : width == 32u ? read_u32(frame + slot * 2u)
                                      : read_u16(frame + slot * 2u);
    u64 new_rsp = width == 64u ? load_u64(frame + slot * 3u)
                : width == 32u ? read_u32(frame + slot * 3u)
                               : read_u16(frame + slot * 3u);
    u32 new_ss = (width == 64u ? (u32)load_u64(frame + slot * 4u)
                : width == 32u ? read_u32(frame + slot * 4u)
                               : read_u16(frame + slot * 4u)) & 0xffffu;
    u32 cs_error = new_cs & 0xfffcu;
    if (!cs_error) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u8 cs[8];
    if (!x86_direct_descriptor(x86, new_cs, cs)) return 0;
    u32 access = cs[5];
    u32 rpl = new_cs & 3u;
    u32 dpl = (access >> 5u) & 3u;
    int code = (access & 0x10u) && (access & 8u);
    int conforming = (access & 4u) != 0u;
    if (!code || rpl < cpl
            || (conforming ? dpl > rpl : dpl != rpl)) {
        x86_direct_exception(x86, 13u, 1u, cs_error);
        return 0;
    }
    if (!(access & 0x80u)) {
        x86_direct_exception(x86, 11u, 1u, cs_error);
        return 0;
    }
    if (width == 64u && !x86_canonical(target)) {
        x86_direct_exception(x86, 13u, 1u, 0u);
        return 0;
    }
    u32 ss_error = new_ss & 0xfffcu;
    if (!ss_error) {
        if (rpl == 3u) {
            x86_direct_exception(x86, 13u, 1u, 0u);
            return 0;
        }
    } else {
        u8 ss[8];
        if ((new_ss & 3u) != rpl) {
            x86_direct_exception(x86, 13u, 1u, ss_error);
            return 0;
        }
        if (!x86_direct_descriptor(x86, new_ss, ss)) return 0;
        u32 ss_access = ss[5];
        u32 ss_dpl = (ss_access >> 5u) & 3u;
        if (!(ss_access & 0x10u) || (ss_access & 8u)
                || !(ss_access & 2u) || ss_dpl != rpl) {
            x86_direct_exception(x86, 13u, 1u, ss_error);
            return 0;
        }
        if (!(ss_access & 0x80u)) {
            x86_direct_exception(x86, 11u, 1u, ss_error);
            return 0;
        }
    }
    if (width == 64u && !x86_canonical(new_rsp)) {
        x86_direct_exception(x86, 12u, 1u, 0u);
        return 0;
    }
    u64 mask = 0x8d5u                 /* OF,SF,ZF,AF,PF,CF */
             | (1ull << 8u)           /* TF */
             | (1ull << 10u)          /* DF */
             | (1ull << 14u)          /* NT */
             | (1ull << 16u)          /* RF */
             | (1ull << 18u)          /* AC */
             | (1ull << 21u);         /* ID */
    u32 iopl = (u32)(x86->rflags >> 12u) & 3u;
    if (cpl == 0u) mask |= 3ull << 12u;
    if (cpl <= iopl) mask |= 1ull << 9u;
    if (width == 16u) mask &= 0xffffu;
    x86->system[X86_SYS_CS] = new_cs;
    x86->system[X86_SYS_SS] = new_ss;
    x86->registers[X86_RSP] = new_rsp;
    x86->rip = target;
    x86->rflags = (x86->rflags & ~mask) | (restored_flags & mask) | 2u;
    x86->halted = 0u;
    return 1;
}

/* One load_region is deliberately not lowered to N scalar memory imports.
 * Translate and fetch the contiguous extent once, then retain its physical
 * publications in a fixed slot selected by the C emitter.  Projection reads
 * below are plain Wasm-to-Wasm calls over that array. */
EXPORT u64 vm_x86_direct_memory_region(
        u32 machine, u64 address, u64 offset, u64 descriptor, u64 shape,
        u32 block, u32 memory_slot, u32 region_slot)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || region_slot >= X86_DIRECT_REGION_CAP) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_memory_result = 0u;
    u32 count = (u32)descriptor & 0xffu;
    u32 bits = descriptor & 0x200u ? 32u : 64u;
    int signed_load = (descriptor & 0x100u) != 0u;
    u32 width = (u32)shape & 0xffu;
    u32 scale = (u32)(shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
              & PL_MEMORY_SHAPE_SCALE_MASK;
    if (!count || count > 8u || (descriptor & ~0x3ffull)
            || (width != 1u && width != 2u
                && width != 4u && width != 8u)
            || scale || (shape & ~(u64)PL_MEMORY_SHAPE_MASK)
            || width * 8u > bits
            || (signed_load && width * 8u >= bits)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u64 replay = 0u;
    int admitted = x86_direct_memory_enter(
        x86, block, memory_slot, &replay);
    if (admitted != X86_DIRECT_MEMORY_EXECUTE)
        return admitted == X86_DIRECT_MEMORY_REPLAY ? replay : 0u;
    x86->direct_region_width[region_slot] = 0u;
    u32 extent = count * width;
    u64 base = shape & PL_MEMORY_SHAPE_VIRTUAL64
             ? address : (u32)address;
    if (offset > ~0ull - base
            || base + offset > ~0ull - (extent - 1u)) {
        x86_direct_page_fault(x86, base, 0, 0, 0);
        return 0u;
    }
    u64 effective = base + offset;
    u8 bytes[8u * 8u];
    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    int status = x86_virtual_read_access(effective, bytes, extent, user);
    if (!status) {
        x86->direct_memory_result = pl_vm_result_make(
            PL_VM_BARRIER, x86->physical_status);
        return 0u;
    }
    if (status < 0) {
        x86_direct_page_fault(x86, effective, 0, 0, status == -2);
        return 0u;
    }
    for (u32 element = 0u; element < count; ++element) {
        u64 value = 0u;
        u32 begin = element * width;
        for (u32 index = 0u; index < width; ++index)
            value |= (u64)bytes[begin + index] << (index * 8u);
        if (signed_load && (bytes[begin + width - 1u] & 0x80u))
            value |= ~0ull << (width * 8u);
        x86->direct_region_results[region_slot][element] =
            bits == 32u ? (u32)value : value;
    }
    x86->direct_region_results[region_slot][count] = effective + extent;
    x86->direct_region_width[region_slot] = count + 1u;
    return x86_direct_memory_finish(
        x86, memory_slot, x86->direct_region_results[region_slot][0]);
}

EXPORT u64 vm_x86_direct_memory_region_value(
        u32 machine, u32 slot, u32 selector)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || slot >= X86_DIRECT_REGION_CAP
            || selector >= x86->direct_region_width[slot]) {
        x86->direct_memory_result = pl_vm_result_make(PL_VM_FAULT, 0xffu);
        return 0u;
    }
    return x86->direct_region_results[slot][selector];
}

/* Counted store recurrences stay one restartable physical operation.  The
 * cursor survives a cold-page or dirty-eviction barrier, so retrying the
 * direct block resumes at the first untouched byte rather than replaying N
 * scalar stores or rebuilding an interpreter frame. */
EXPORT u64 vm_x86_direct_memory_repeat(
        u32 machine, u64 address, u64 pattern, u64 size, u64 shape,
        u32 block, u32 slot)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_memory_result = 0u;
    u32 width = (u32)shape & 0xffu;
    u32 scale = (u32)(shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
              & PL_MEMORY_SHAPE_SCALE_MASK;
    if ((width != 1u && width != 2u && width != 4u && width != 8u)
            || (shape & ~(u64)PL_MEMORY_SHAPE_MASK)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u64 base = shape & PL_MEMORY_SHAPE_VIRTUAL64
             ? address : (u32)address;
    base <<= scale;
    if (!(shape & PL_MEMORY_SHAPE_VIRTUAL64)) base = (u32)base;
    if (size && base > ~0ull - (size - 1u)) {
        x86_direct_page_fault(x86, base, 1, 0, 0);
        return 0u;
    }
    u64 replay = 0u;
    int admitted = x86_direct_memory_enter(x86, block, slot, &replay);
    if (admitted != X86_DIRECT_MEMORY_EXECUTE)
        return admitted == X86_DIRECT_MEMORY_REPLAY ? replay : 0u;
    if (!x86->direct_repeat_active) {
        x86->direct_repeat_active = 1u;
        x86->direct_repeat_width = width;
        x86->direct_repeat_phase = 0u;
        x86->direct_repeat_key_address = address;
        x86->direct_repeat_key_pattern = pattern;
        x86->direct_repeat_key_size = size;
        x86->direct_repeat_key_shape = shape;
        x86->direct_repeat_address = base;
        x86->direct_repeat_remaining = size;
    } else if (x86->direct_repeat_key_address != address
            || x86->direct_repeat_key_pattern != pattern
            || x86->direct_repeat_key_size != size
            || x86->direct_repeat_key_shape != shape) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }

    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    while (x86->direct_repeat_remaining) {
        u64 virtual_address = x86->direct_repeat_address;
        u64 physical_page = 0u;
        int translated = x86_translate_page(
            virtual_address >> 12u, 1, 0, user, &physical_page);
        if (!translated || (translated > 0
                && !x86_physical_present(physical_page))) {
            x86->direct_memory_result = pl_vm_result_make(
                PL_VM_BARRIER, x86->physical_status);
            return 0u;
        }
        if (translated < 0) {
            x86_direct_page_fault(
                x86, virtual_address, 1, 0, translated == -2);
            return 0u;
        }
        u32 offset = (u32)virtual_address
                   & (X86_PHYSICAL_PAGE_BYTES - 1u);
        u64 available = X86_PHYSICAL_PAGE_BYTES - offset;
        u32 count = (u32)(x86->direct_repeat_remaining < available
                        ? x86->direct_repeat_remaining : available);
        u32 physical_slot = x86_physical_slot(physical_page);
        for (u32 index = 0u; index < count; ++index) {
            u32 phase = x86->direct_repeat_phase;
            x86->physical[physical_slot][offset + index] =
                (u8)(pattern >> (phase * 8u));
            x86->direct_repeat_phase = phase + 1u == width
                                     ? 0u : phase + 1u;
        }
        x86->physical_dirty[physical_slot] = 1u;
        x86_physical_touch(physical_slot);
        x86->direct_repeat_address += count;
        x86->direct_repeat_remaining -= count;
    }
    x86->direct_repeat_active = 0u;
    return x86_direct_memory_finish(x86, slot, 0u);
}

/* memmove is one restartable physical transaction.  One source page is
 * retained while its destination page is admitted, so a cold destination
 * cannot force the source read to replay and overlapping ranges keep their
 * architectural direction. */
EXPORT u64 vm_x86_direct_memory_copy(
        u32 machine, u64 source, u64 target, u64 size, u64 shape,
        u32 block, u32 slot)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_memory_result = 0u;
    u32 width = (u32)shape & 0xffu;
    u32 scale = (u32)(shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
              & PL_MEMORY_SHAPE_SCALE_MASK;
    if (width != 1u || (shape & ~(u64)PL_MEMORY_SHAPE_MASK)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u64 source_base = shape & PL_MEMORY_SHAPE_VIRTUAL64
                    ? source : (u32)source;
    u64 target_base = shape & PL_MEMORY_SHAPE_VIRTUAL64
                    ? target : (u32)target;
    source_base <<= scale;
    target_base <<= scale;
    if (!(shape & PL_MEMORY_SHAPE_VIRTUAL64)) {
        source_base = (u32)source_base;
        target_base = (u32)target_base;
    }
    if (size && (source_base > ~0ull - (size - 1u)
            || target_base > ~0ull - (size - 1u))) {
        int target_fault = target_base > ~0ull - (size - 1u);
        x86_direct_page_fault(
            x86, target_fault ? target_base : source_base,
            target_fault, 0, 0);
        return 0u;
    }
    u64 replay = 0u;
    int admitted = x86_direct_memory_enter(x86, block, slot, &replay);
    if (admitted != X86_DIRECT_MEMORY_EXECUTE)
        return admitted == X86_DIRECT_MEMORY_REPLAY ? replay : 0u;
    if (!size || source_base == target_base)
        return x86_direct_memory_finish(x86, slot, 0u);

    if (!x86->direct_copy_active) {
        x86->direct_copy_active = 1u;
        x86->direct_copy_phase = 0u;
        x86->direct_copy_backward = source_base < target_base
                                 && target_base - source_base < size;
        x86->direct_copy_pending = 0u;
        x86->direct_copy_pending_at = 0u;
        x86->direct_copy_key_source = source;
        x86->direct_copy_key_target = target;
        x86->direct_copy_key_size = size;
        x86->direct_copy_key_shape = shape;
        x86->direct_copy_source = source_base;
        x86->direct_copy_target = target_base;
        x86->direct_copy_index = 0u;
        x86->direct_copy_limit = size;
    } else if (x86->direct_copy_key_source != source
            || x86->direct_copy_key_target != target
            || x86->direct_copy_key_size != size
            || x86->direct_copy_key_shape != shape) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }

    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    for (;;) {
        if (x86->direct_copy_phase == 1u) {
            u64 at = x86->direct_copy_backward
                   ? x86->direct_copy_limit - x86->direct_copy_index
                     - x86->direct_copy_pending
                   : x86->direct_copy_index;
            while (x86->direct_copy_pending_at < x86->direct_copy_pending) {
                u64 address = x86->direct_copy_target + at
                            + x86->direct_copy_pending_at;
                u64 physical_page = 0u;
                int translated = x86_translate_page(
                    address >> 12u, 1, 0, user, &physical_page);
                if (!translated || (translated > 0
                        && !x86_physical_present(physical_page))) {
                    x86->direct_memory_result = pl_vm_result_make(
                        PL_VM_BARRIER, x86->physical_status);
                    return 0u;
                }
                if (translated < 0) {
                    x86_direct_page_fault(
                        x86, address, 1, 0, translated == -2);
                    return 0u;
                }
                u32 offset = (u32)address
                           & (X86_PHYSICAL_PAGE_BYTES - 1u);
                u32 count = x86->direct_copy_pending
                          - x86->direct_copy_pending_at;
                if (count > X86_PHYSICAL_PAGE_BYTES - offset)
                    count = X86_PHYSICAL_PAGE_BYTES - offset;
                u32 physical_slot = x86_physical_slot(physical_page);
                for (u32 index = 0u; index < count; ++index)
                    x86->physical[physical_slot][offset + index]
                        = x86->direct_copy_buffer[
                            x86->direct_copy_pending_at + index];
                x86->physical_dirty[physical_slot] = 1u;
                x86_physical_touch(physical_slot);
                x86->direct_copy_pending_at += count;
            }
            x86->direct_copy_index += x86->direct_copy_pending;
            x86->direct_copy_phase = 0u;
            if (x86->direct_copy_index == x86->direct_copy_limit) {
                x86->direct_copy_active = 0u;
                return x86_direct_memory_finish(x86, slot, 0u);
            }
        }

        u64 remaining = x86->direct_copy_limit - x86->direct_copy_index;
        u64 at = x86->direct_copy_index;
        u32 count;
        if (x86->direct_copy_backward) {
            u64 end = x86->direct_copy_source + remaining;
            u32 tail = (u32)end & (X86_PHYSICAL_PAGE_BYTES - 1u);
            count = tail ? tail : X86_PHYSICAL_PAGE_BYTES;
            if (count > remaining) count = (u32)remaining;
            at = remaining - count;
        } else {
            u64 address = x86->direct_copy_source + at;
            u32 offset = (u32)address
                       & (X86_PHYSICAL_PAGE_BYTES - 1u);
            u64 available = X86_PHYSICAL_PAGE_BYTES - offset;
            count = (u32)(remaining < available ? remaining : available);
        }
        u64 address = x86->direct_copy_source + at;
        u64 physical_page = 0u;
        int translated = x86_translate_page(
            address >> 12u, 0, 0, user, &physical_page);
        if (!translated || (translated > 0
                && !x86_physical_present(physical_page))) {
            x86->direct_memory_result = pl_vm_result_make(
                PL_VM_BARRIER, x86->physical_status);
            return 0u;
        }
        if (translated < 0) {
            x86_direct_page_fault(
                x86, address, 0, 0, translated == -2);
            return 0u;
        }
        u32 offset = (u32)address & (X86_PHYSICAL_PAGE_BYTES - 1u);
        u32 physical_slot = x86_physical_slot(physical_page);
        for (u32 index = 0u; index < count; ++index)
            x86->direct_copy_buffer[index] =
                x86->physical[physical_slot][offset + index];
        x86_physical_touch(physical_slot);
        x86->direct_copy_pending = count;
        x86->direct_copy_pending_at = 0u;
        x86->direct_copy_phase = 1u;
    }
}

EXPORT u64 vm_x86_direct_memory_find2(
        u32 machine, u64 address, u64 first, u64 second, u64 shape,
        u32 block, u32 slot)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_memory_result = 0u;
    u32 width = (u32)shape & 0xffu;
    u32 scale = (u32)(shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
              & PL_MEMORY_SHAPE_SCALE_MASK;
    if (width != 1u || (shape & ~(u64)PL_MEMORY_SHAPE_MASK)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u64 base = shape & PL_MEMORY_SHAPE_VIRTUAL64 ? address : (u32)address;
    base <<= scale;
    if (!(shape & PL_MEMORY_SHAPE_VIRTUAL64)) base = (u32)base;
    u64 replay = 0u;
    int admitted = x86_direct_memory_enter(x86, block, slot, &replay);
    if (admitted != X86_DIRECT_MEMORY_EXECUTE)
        return admitted == X86_DIRECT_MEMORY_REPLAY ? replay : 0u;
    if (!x86->direct_find_active) {
        x86->direct_find_active = 1u;
        x86->direct_find_first = (u32)first & 0xffu;
        x86->direct_find_second = (u32)second & 0xffu;
        x86->direct_find_key_address = address;
        x86->direct_find_key_first = first;
        x86->direct_find_key_second = second;
        x86->direct_find_key_shape = shape;
        x86->direct_find_address = base;
        x86->direct_find_offset = 0u;
    } else if (x86->direct_find_key_address != address
            || x86->direct_find_key_first != first
            || x86->direct_find_key_second != second
            || x86->direct_find_key_shape != shape) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }

    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    for (;;) {
        if (x86->direct_find_offset >= (1ull << 56u)
                || x86->direct_find_address
                   > ~0ull - x86->direct_find_offset) {
            x86_direct_page_fault(
                x86, x86->direct_find_address, 0, 0, 0);
            return 0u;
        }
        u64 coordinate = x86->direct_find_address + x86->direct_find_offset;
        u64 physical_page = 0u;
        int translated = x86_translate_page(
            coordinate >> 12u, 0, 0, user, &physical_page);
        if (!translated || (translated > 0
                && !x86_physical_present(physical_page))) {
            x86->direct_memory_result = pl_vm_result_make(
                PL_VM_BARRIER, x86->physical_status);
            return 0u;
        }
        if (translated < 0) {
            x86_direct_page_fault(
                x86, coordinate, 0, 0, translated == -2);
            return 0u;
        }
        u32 offset = (u32)coordinate & (X86_PHYSICAL_PAGE_BYTES - 1u);
        u32 count = X86_PHYSICAL_PAGE_BYTES - offset;
        u32 physical_slot = x86_physical_slot(physical_page);
        for (u32 index = 0u; index < count; ++index) {
            u32 value = x86->physical[physical_slot][offset + index];
            if (value == x86->direct_find_first
                    || value == x86->direct_find_second) {
                u64 result = ((x86->direct_find_offset + index) << 8u)
                           | value;
                x86_physical_touch(physical_slot);
                x86->direct_find_active = 0u;
                return x86_direct_memory_finish(x86, slot, result);
            }
        }
        x86_physical_touch(physical_slot);
        x86->direct_find_offset += count;
    }
}

/* ENTER's implicit frame copies form one bounded gather/store transaction.
 * The cursor and one pending word survive a delivery cut, so a nested frame
 * never expands into up to 32 scalar memory nodes or replays a completed
 * write when a later source or destination page is cold. */
EXPORT u64 vm_x86_direct_memory_frame(
        u32 machine, u64 frame, u64 base, u64 level, u64 shape,
        u32 block, u32 slot)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_memory_result = 0u;
    u32 width = (u32)shape & 0xffu;
    u32 scale = (u32)(shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
              & PL_MEMORY_SHAPE_SCALE_MASK;
    if ((width != 2u && width != 8u) || scale || level > 31u
            || (shape & ~(u64)PL_MEMORY_SHAPE_MASK)
            || !(shape & PL_MEMORY_SHAPE_VIRTUAL64)) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    u64 replay = 0u;
    int admitted = x86_direct_memory_enter(x86, block, slot, &replay);
    if (admitted != X86_DIRECT_MEMORY_EXECUTE)
        return admitted == X86_DIRECT_MEMORY_REPLAY ? replay : 0u;
    if (!x86->direct_frame_active) {
        x86->direct_frame_active = 1u;
        x86->direct_frame_index = 0u;
        x86->direct_frame_pending = 0u;
        x86->direct_frame_key_frame = frame;
        x86->direct_frame_key_base = base;
        x86->direct_frame_key_level = level;
        x86->direct_frame_key_shape = shape;
    } else if (x86->direct_frame_key_frame != frame
            || x86->direct_frame_key_base != base
            || x86->direct_frame_key_level != level
            || x86->direct_frame_key_shape != shape) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }

    int user = (x86->system[X86_SYS_CS] & 3u) != 0u;
    u32 count = level ? (u32)level + 1u : 1u;
    while (x86->direct_frame_index < count) {
        u32 index = x86->direct_frame_index;
        if (!x86->direct_frame_pending) {
            if (!index) {
                x86->direct_frame_value = base;
            } else if ((u64)index < level) {
                u8 bytes[8];
                int status = x86_virtual_read_access(
                    base - (u64)width * index, bytes, width, user);
                if (!status) {
                    x86->direct_memory_result = pl_vm_result_make(
                        PL_VM_BARRIER, x86->physical_status);
                    return 0u;
                }
                if (status < 0) {
                    x86_direct_page_fault(
                        x86, base - (u64)width * index,
                        0, 0, status == -2);
                    return 0u;
                }
                u64 value = 0u;
                for (u32 byte = 0u; byte < width; ++byte)
                    value |= (u64)bytes[byte] << (byte * 8u);
                x86->direct_frame_value = value;
            } else {
                x86->direct_frame_value = frame;
            }
            x86->direct_frame_pending = 1u;
        }
        u8 bytes[8];
        for (u32 byte = 0u; byte < width; ++byte)
            bytes[byte] = (u8)(x86->direct_frame_value >> (byte * 8u));
        int status = x86_virtual_write(
            frame - (u64)width * index, bytes, width, user);
        if (!status) {
            x86->direct_memory_result = pl_vm_result_make(
                PL_VM_BARRIER, x86->physical_status);
            return 0u;
        }
        if (status < 0) {
            x86_direct_page_fault(
                x86, frame - (u64)width * index,
                1, 0, status == -2);
            return 0u;
        }
        x86->direct_frame_pending = 0u;
        x86->direct_frame_index = index + 1u;
    }
    x86->direct_frame_active = 0u;
    return x86_direct_memory_finish(x86, slot, 0u);
}

EXPORT u64 vm_x86_direct_memory_commit(
        u32 machine, u32 block, u32 memory_count)
{
    X86Workspace *x86 = x86_machine();
    if (machine != (u32)(uptr)&x86->architectural
            || !memory_count || memory_count > X86_DIRECT_MEMORY_CAP
            || !x86->direct_transaction_active
            || x86->direct_transaction_block != block
            || x86->direct_transaction_completed != memory_count
            || x86->direct_repeat_active || x86->direct_copy_active
            || x86->direct_find_active || x86->direct_frame_active
            || x86->direct_memory_result) {
        x86_direct_memory_abort(x86, 0xffu);
        return 0u;
    }
    x86->direct_transaction_active = 0u;
    return 0u;
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
    /* The oracle charges the faulting source instruction even though its
     * state transaction is rolled back.  Keep the resident retirement/PIT
     * coordinate identical; otherwise every user fault advances the timer
     * one instruction less and eventually changes interrupt placement. */
    x86->retired += 1u;
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

static int x86_divide_value(u64 high, u64 low, u64 divisor, u32 width,
                            u32 signed_divide, u64 *quotient,
                            u64 *remainder)
{
    if (width == 64u)
        return x86_divide_wide(
            high, low, divisor, signed_divide, quotient, remainder);
    if (width != 8u && width != 16u && width != 32u) return 0;
    u64 mask = (1ull << width) - 1u;
    high &= mask;
    low &= mask;
    divisor &= mask;
    if (!divisor) return 0;
    u32 double_width = width * 2u;
    u64 double_mask = double_width == 64u
                    ? ~0ull : (1ull << double_width) - 1u;
    u64 dividend = (high << width) | low;
    if (!signed_divide) {
        u64 divided = dividend / divisor;
        if (divided > mask) return 0;
        *quotient = divided;
        *remainder = dividend % divisor;
        return 1;
    }

    u32 dividend_negative = (u32)(dividend >> (double_width - 1u));
    u32 divisor_negative = (u32)(divisor >> (width - 1u));
    u64 magnitude_dividend = dividend_negative
                           ? (~dividend + 1u) & double_mask : dividend;
    u64 magnitude_divisor = divisor_negative
                          ? (0u - divisor) & mask : divisor;
    u64 magnitude_quotient = magnitude_dividend / magnitude_divisor;
    u64 magnitude_remainder = magnitude_dividend % magnitude_divisor;
    u32 negative = dividend_negative ^ divisor_negative;
    u64 maximum = negative ? 1ull << (width - 1u)
                           : (1ull << (width - 1u)) - 1u;
    if (magnitude_quotient > maximum) return 0;
    *quotient = (negative ? 0u - magnitude_quotient
                          : magnitude_quotient) & mask;
    *remainder = (dividend_negative ? 0u - magnitude_remainder
                                    : magnitude_remainder) & mask;
    return 1;
}

/* Compiler-emitted x86 blocks keep #DE as data until the block's atomic
 * publication cut.  This helper is one physical arithmetic primitive, not an
 * instruction interpreter: one call produces the fault predicate and retains
 * the quotient/remainder projections in a bounded machine slot. */
EXPORT u64 vm_x86_direct_divide(u32 machine, u64 high, u64 low, u64 divisor,
                                u64 descriptor)
{
    X86Workspace *x86 = x86_machine();
    x86->direct_divide_result[0] = 0u;
    x86->direct_divide_result[1] = 0u;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published)
        return 1u;
    u32 width = (u32)descriptor & 0x7fu;
    u32 signed_divide = ((u32)descriptor >> 8u) & 1u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || descriptor != (u64)(width | (signed_divide << 8u)))
        return 1u;
    return x86_divide_value(
        high, low, divisor, width, signed_divide,
        &x86->direct_divide_result[0], &x86->direct_divide_result[1])
         ? 0u : 1u;
}

EXPORT u64 vm_x86_direct_divide_result(u32 machine, u32 selector)
{
    X86Workspace *x86 = x86_machine();
    return machine == (u32)(uptr)&x86->architectural && selector < 2u
         ? x86->direct_divide_result[selector] : 0u;
}

/* RCL/RCR are one quotient-minimized arithmetic lane.  The helper evaluates
 * the closed width+carry ring directly; it does not dispatch an x86 opcode or
 * reopen the physical node as scalar shifts. */
EXPORT u64 vm_x86_direct_rotate_carry(
        u32 machine, u64 prior, u64 source, u64 amount, u64 descriptor)
{
    X86Workspace *x86 = x86_machine();
    u64 flags = 0u;
    x86->direct_rotate_carry_result = 0u;
    if (machine != (u32)(uptr)&x86->architectural
            || !x86->active || !x86->executable_published
            || !x86_rotate_carry_value(
                prior, source, amount, descriptor,
                &flags, &x86->direct_rotate_carry_result))
        return 0u;
    return flags;
}

EXPORT u64 vm_x86_direct_rotate_carry_result(u32 machine)
{
    X86Workspace *x86 = x86_machine();
    return machine == (u32)(uptr)&x86->architectural
         ? x86->direct_rotate_carry_result : 0u;
}

/* One shared CRC32C lane keeps the post-link artifact from repeating the
 * polynomial reduction for every source coordinate.  It is a total pure
 * function: the authenticated direct block supplies the source width and the
 * result is always the architectural zero-extended 32-bit accumulator. */
EXPORT u64 vm_x86_direct_crc32(u64 accumulator, u64 source, u64 descriptor)
{
    u32 width = (u32)descriptor & 0x7fu;
    if ((width != 8u && width != 16u && width != 32u && width != 64u)
            || descriptor != width)
        return 0u;
    u32 crc = (u32)accumulator;
    for (u32 byte = 0u; byte < width / 8u; ++byte) {
        crc ^= (u32)(source >> (byte * 8u)) & 0xffu;
        for (u32 bit = 0u; bit < 8u; ++bit)
            crc = (crc >> 1u) ^ ((crc & 1u) ? 0x82f63b78u : 0u);
    }
    return crc;
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
    x86->registers = step_machine()->locals;
    for (u32 index = 0; index < X86_REGISTER_COUNT; ++index)
        x86->registers[index] = 0;
    x86->rip = rip;
    x86->rflags = rflags | 2u;
    step_machine()->locals[X86_REGISTER_COUNT] = x86->rflags;
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
    x86->mxcsr = 0x1f80u;
    x86->memory_bytes = memory_bytes;
    x86->retired = 0;
    x86->work = 0;
    x86->span = 0;
    for (u32 index = 0u; index < PL_VM_X86_X87_REGISTERS; ++index) {
        x86->x87_significand[index] = 0u;
        x86->x87_sign_exponent[index] = 0u;
    }
    x86->x87_control = 0x037fu;
    x86->x87_status = 0u;
    x86->x87_tag = 0xffffu;
    x86->x87_opcode = 0u;
    x86->x87_ip = 0u;
    x86->x87_dp = 0u;
    for (u32 index = 0; index < sizeof x86->executable / sizeof(u32); ++index)
        ((u32 *)&x86->executable)[index] = 0;
    x86->executable_published = 0;
    x86->direct_blocks = 0;
    x86->direct_function = 0u;
    x86->direct_residual = 0u;
    x86->direct_memory_result = 0u;
    x86->direct_transaction_active = 0u;
    x86->direct_repeat_active = 0u;
    x86->direct_copy_active = 0u;
    x86->direct_find_active = 0u;
    x86->direct_frame_active = 0u;
    x86->executable_root_loading = 0;
    x86->executable_page_loading = 0;
    x86->executable_code_loading = 0;
    x86->executable_map_loading = 0;
    x86->executable_map_tail = 0;
    x86->executable_map_rank = 0;
    x86->executable_residual_loading = 0u;
    x86->executable_residual_edge = 0u;
    x86->executable_residual_rank = 0u;
    x86->executable_kernel_loading = 0u;
    x86->executable_kernel_rank = 0u;
    x86->executable_instantiation_loading = 0u;
    x86->executable_instantiation_parameter = 0u;
    x86->executable_instantiation_rank = 0u;
    x86->executable_index_starts = 0u;
    x86->executable_index_nodes = 0u;
    x86->executable_index_cache_hits = 0u;
    x86->executable_index_cache_misses = 0u;
    x86->executable_resource_payloads = 0u;
    x86->executable_module_chunks = 0u;
    x86->executable_parameter_materializations = 0u;
    x86->executable_parameter_words = 0u;
    x86->executable_index_cache_clock = 0u;
    for (u32 slot = 0u; slot < X86_EXECUTABLE_INDEX_CACHE; ++slot) {
        x86->executable_index_cache_valid[slot] = 0u;
        x86->executable_index_cache_age[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_PAGE_CACHE; ++slot) {
        x86->executable_code_page[slot] = 0u;
        x86->executable_code_generation[slot] = 0u;
        x86->executable_code_function[slot] = 0u;
        x86->executable_code_argument[slot] = 0u;
        x86->executable_code_valid[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_MODULE_CACHE; ++slot) {
        x86->executable_module_first[slot] = 0u;
        x86->executable_module_count[slot] = 0u;
        x86->executable_module_valid[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_MODULE_PAGE_CACHE; ++slot) {
        x86->executable_module_page_tag[slot] = 0u;
        x86->executable_module_page_first[slot] = 0u;
        x86->executable_module_page_count[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_BINDING_CACHE; ++slot) {
        x86->executable_binding_tag[slot] = 0u;
        x86->executable_binding_generation[slot] = 0u;
        x86->executable_binding_argument[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_ENTRY_PAGE_CACHE; ++slot) {
        x86->executable_entry_page_tag[slot] = 0u;
        for (u32 row = 0u; row < PL_ENTRY_PAGE_ROWS; ++row)
            x86->executable_entry_page_rows[slot][row] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_ENTRY_TAIL_CACHE; ++slot) {
        x86->executable_entry_tail_tag[slot] = 0u;
        for (u32 value = 0u; value < PL_ENTRY_TAIL_VALUES; ++value)
            x86->executable_entry_tail_rows[slot][value] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_RESIDUAL_STATE_CACHE;
         ++slot) {
        x86->executable_residual_state_tag[slot] = 0u;
        x86->executable_residual_state_count[slot] = 0u;
        x86->executable_residual_state_first_edge[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_RESIDUAL_EDGE_CACHE;
         ++slot) {
        x86->executable_residual_edge_tag[slot] = 0u;
        x86->executable_residual_edge_count[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_INSTANTIATION_CACHE;
         ++slot) {
        x86->executable_instantiation_tag[slot] = 0u;
        x86->executable_instantiation_count[slot] = 0u;
    }
    for (u32 slot = 0u; slot < X86_EXECUTABLE_PARAMETER_CACHE; ++slot) {
        x86->executable_parameter_tag[slot] = 0u;
        x86->executable_parameter_count[slot] = 0u;
    }
    x86->executable_table_base = 0;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    x86->executable_module_offset = 0u;
    x86->control = X86_CONTROL_NEXT;
    x86->block_loaded = 0;
    for (u32 slot = 0; slot < X86_BLOCK_CACHE_SLOTS; ++slot) {
        x86->block_cache_rip[slot] = 0;
        x86->block_cache_bytes[slot] = 0;
        x86->block_cache_valid[slot] = 0;
        x86->block_cache_age[slot] = 0;
        x86->block_cache_class[slot] = 0;
        x86->block_cache_data_slot[slot] = 0;
    }
    for (u32 slot = 0; slot < X86_BLOCK_CACHE_SMALL_SLOTS; ++slot)
        x86->block_cache_small_owner[slot] = 0;
    for (u32 slot = 0; slot < X86_BLOCK_CACHE_MEDIUM_SLOTS; ++slot)
        x86->block_cache_medium_owner[slot] = 0;
    for (u32 slot = 0; slot < X86_BLOCK_CACHE_LARGE_SLOTS; ++slot)
        x86->block_cache_large_owner[slot] = 0;
    for (u32 size_class = 0; size_class < X86_BLOCK_CACHE_CLASSES;
         ++size_class) {
        x86->block_cache_next[size_class] = 0;
        x86->block_cache_victim[size_class] = 0;
    }
    x86->block_cache_clock = 0;
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
    x86->entropy_direct_request = 0u;
    x86->entropy_direct_ready = 0u;
    x86->entropy_direct_descriptor = 0u;
    x86->console_head = 0;
    x86->console_count = 0;
    x86->interrupt_shadow = 0u;
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
    x86->ferr_pending = 0u;
    x86->timer_source_instructions = 0;
    x86->uart_tx_pending = 0;
    x86->active = 1;
    x86->halted = 0;
    x86->error = 0;
    x86->physical_lease = 0;
    x86->physical_coordinate = X86_NO_PAGE;
    x86->physical_status = 0;
    x86->physical_lookup_probes = 0u;
    x86->physical_victim_probes = 0u;
    x86->physical_lookup_tombstones = 0u;
    x86->physical_free_cursor = 0u;
    x86->physical_victim_cursor = 0u;
    for (u32 page = 0; page < X86_PHYSICAL_DIRECT_PAGES; ++page)
        x86->physical_direct[page] = 0;
    for (u32 locator = 0u; locator < X86_PHYSICAL_LOOKUP_SLOTS;
         ++locator)
        x86->physical_lookup_valid[locator] = 0u;
    for (u32 slot = 0; slot < X86_PHYSICAL_PAGES; ++slot) {
        x86->physical_page[slot] = X86_NO_PAGE;
        x86->physical_valid[slot] = 0;
        x86->physical_dirty[slot] = 0;
        x86->physical_referenced[slot] = 0u;
    }
    for (u32 slot = 0; slot < STEP_MEMORY_PAGES; ++slot) {
        x86->step_physical_slot[slot] = 0;
        x86->step_physical_valid[slot] = 0;
        x86->step_physical_write[slot] = 0;
    }
    return vm_step_memory_open_virtual(session, 12u);
}

static int x86_supply_physical(u64 session, u64 lease,
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
    u64 prior = x86->physical_page[slot];
    if (x86->physical_valid[slot])
        x86_physical_remove_lookup(x86, prior, slot);
    for (u32 index = 0; index < X86_PHYSICAL_PAGE_BYTES; ++index)
        x86->physical[slot][index] = x86->physical_transfer[index];
    x86->physical_page[slot] = page;
    x86->physical_valid[slot] = 1u;
    x86->physical_dirty[slot] = 0;
    x86_physical_publish_lookup(x86, page, slot);
    x86_physical_touch(slot);
    x86->physical_lease = 0;
    x86->physical_coordinate = X86_NO_PAGE;
    x86->physical_status = 0;
    return 1;
}

static void x86_executable_admission_clear(X86Workspace *x86)
{
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    x86->executable_module_offset = 0u;
    x86->executable_page_loading = 0u;
    x86->executable_code_loading = 0u;
    x86->executable_map_loading = 0u;
    x86->executable_residual_loading = 0u;
    x86->executable_kernel_loading = 0u;
    x86->executable_instantiation_loading = 0u;
}

static int x86_executable_request_active(const X86Workspace *x86)
{
    return x86->executable_root_loading || x86->executable_page_loading
        || x86->executable_code_loading || x86->executable_map_loading
        || x86->executable_residual_loading
        || x86->executable_kernel_loading
        || x86->executable_instantiation_loading;
}

static u32 x86_executable_module_slot(u32 first, u32 count)
{
    return (first ^ (count * 0x9e3779b9u))
         & (X86_EXECUTABLE_MODULE_CACHE - 1u);
}

static int x86_executable_module_resident(
    const X86Workspace *x86, const pl_executable_module *module)
{
    u32 first = (u32)module->first_function;
    u32 slot = x86_executable_module_slot(first, module->function_count);
    return x86->executable_module_valid[slot]
        && x86->executable_module_first[slot] == first
        && x86->executable_module_count[slot] == module->function_count;
}

static void x86_executable_publish_module(
    X86Workspace *x86, const pl_executable_module *module)
{
    u32 first = (u32)module->first_function;
    u32 slot = x86_executable_module_slot(first, module->function_count);
    x86->executable_module_first[slot] = first;
    x86->executable_module_count[slot] = module->function_count;
    x86->executable_module_valid[slot] = 1u;
    u32 final = first + module->function_count - 1u;
    for (u32 page = first >> 10u; page <= (final >> 10u); ++page) {
        u32 page_slot = page & (X86_EXECUTABLE_MODULE_PAGE_CACHE - 1u);
        x86->executable_module_page_tag[page_slot] = 0u;
        x86->executable_module_page_first[page_slot] = first;
        x86->executable_module_page_count[page_slot] =
            module->function_count;
        x86->executable_module_page_tag[page_slot] = page + 1u;
    }
}

static int x86_executable_kernel_resident(
    const X86Workspace *x86, u32 function)
{
    u32 page = function >> 10u;
    u32 slot = page & (X86_EXECUTABLE_MODULE_PAGE_CACHE - 1u);
    if (x86->executable_module_page_tag[slot] != page + 1u)
        return 0;
    u32 first = x86->executable_module_page_first[slot];
    u32 count = x86->executable_module_page_count[slot];
    return function >= first && function - first < count;
}

static u32 x86_executable_page_slot(u64 page)
{
    return (u32)(page >> 12u) & (X86_EXECUTABLE_PAGE_CACHE - 1u);
}

static int x86_executable_page_resident(const X86Workspace *x86, u64 page,
                                        u64 generation, u32 *function,
                                        u32 *argument)
{
    u32 slot = x86_executable_page_slot(page);
    if (!x86->executable_code_valid[slot]
            || x86->executable_code_page[slot] != page
            || x86->executable_code_generation[slot] != generation)
        return 0;
    *function = x86->executable_code_function[slot];
    if (argument) *argument = x86->executable_code_argument[slot];
    return 1;
}

static void x86_executable_publish_page(
    X86Workspace *x86, const pl_executable_binding *binding)
{
    u32 slot = x86_executable_page_slot(binding->virtual_page);
    x86->executable_code_page[slot] = binding->virtual_page;
    x86->executable_code_generation[slot] = binding->generation;
    x86->executable_code_function[slot] = binding->dispatch_function;
    x86->executable_code_argument[slot] = binding->dispatch_argument;
    x86->executable_code_valid[slot] = 1u;
    u32 rank = binding->dispatch_argument;
    if (rank < x86->executable_root.entry_page_count) {
        u32 binding_slot = rank & (X86_EXECUTABLE_BINDING_CACHE - 1u);
        x86->executable_binding_generation[binding_slot] =
            (u32)binding->generation;
        x86->executable_binding_argument[binding_slot] = rank;
        /* Publish the tag after every value the generated dispatcher reads. */
        x86->executable_binding_tag[binding_slot] = rank + 1u;
    }
}

static void x86_executable_index_start(X86Workspace *x86, u32 kind,
                                       const pl_index_ref *root,
                                       pl_index_key key)
{
    ++x86->executable_index_starts;
    x86->executable_index_kind = kind;
    x86->executable_index_key = key;
    x86->executable_index_ref = *root;
    x86->executable_request = X86_EXECUTABLE_REQUEST_INDEX;
}

static int x86_same_digest(const u8 *left, const u8 *right)
{
    u32 different = 0u;
    for (u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        different |= (u32)(left[index] ^ right[index]);
    return different == 0u;
}

static u32 x86_executable_index_cache_set(const u8 *digest)
{
    u32 hash = (u32)digest[0]
             | (u32)digest[1] << 8u
             | (u32)digest[2] << 16u
             | (u32)digest[3] << 24u;
    return hash & (X86_EXECUTABLE_INDEX_CACHE_SETS - 1u);
}

static int x86_executable_index_cache_open(
    X86Workspace *x86, const pl_index_ref *ref, pl_index_node *node)
{
    u32 first = x86_executable_index_cache_set(ref->digest)
              * X86_EXECUTABLE_INDEX_CACHE_WAYS;
    for (u32 way = 0u; way < X86_EXECUTABLE_INDEX_CACHE_WAYS; ++way) {
        u32 slot = first + way;
        if (!x86->executable_index_cache_valid[slot]
                || x86->executable_index_cache_length[slot]
                   != ref->node_bytes
                || !x86_same_digest(
                    x86->executable_index_cache_digest[slot], ref->digest))
            continue;
        x86->executable_index_cache_age[slot] =
            ++x86->executable_index_cache_clock;
        *node = (pl_index_node){
            x86->executable_index_cache_bytes[slot],
            x86->executable_index_cache_length[slot],
            x86->executable_index_cache_level[slot],
            x86->executable_index_cache_leaf_row_bytes[slot],
            x86->executable_index_cache_row_bytes[slot],
            x86->executable_index_cache_row_count[slot],
            x86->executable_index_cache_first[slot],
            x86->executable_index_cache_last[slot],
        };
        return 1;
    }
    return 0;
}

static void x86_executable_index_cache_publish(
    X86Workspace *x86, const pl_index_ref *ref,
    const pl_index_node *node)
{
    u32 first = x86_executable_index_cache_set(ref->digest)
              * X86_EXECUTABLE_INDEX_CACHE_WAYS;
    u32 selected = first;
    u64 oldest = ~(u64)0;
    for (u32 way = 0u; way < X86_EXECUTABLE_INDEX_CACHE_WAYS; ++way) {
        u32 slot = first + way;
        if (!x86->executable_index_cache_valid[slot]) {
            selected = slot;
            break;
        }
        if (x86->executable_index_cache_age[slot] < oldest) {
            oldest = x86->executable_index_cache_age[slot];
            selected = slot;
        }
    }
    x86->executable_index_cache_valid[selected] = 0u;
    for (u32 index = 0u; index < node->length; ++index)
        x86->executable_index_cache_bytes[selected][index] =
            node->bytes[index];
    for (u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        x86->executable_index_cache_digest[selected][index] =
            ref->digest[index];
    x86->executable_index_cache_length[selected] = node->length;
    x86->executable_index_cache_level[selected] = node->level;
    x86->executable_index_cache_leaf_row_bytes[selected] =
        node->leaf_row_bytes;
    x86->executable_index_cache_row_bytes[selected] = node->row_bytes;
    x86->executable_index_cache_row_count[selected] = node->row_count;
    x86->executable_index_cache_first[selected] = node->first;
    x86->executable_index_cache_last[selected] = node->last;
    x86->executable_index_cache_age[selected] =
        ++x86->executable_index_cache_clock;
    x86->executable_index_cache_valid[selected] = 1u;
}

static int x86_executable_residual_state_resident(
    const X86Workspace *x86, u32 residual, u32 *kernel,
    u32 *degree, u32 *edge_base)
{
    if (residual >= x86->executable_root.residual_count)
        return 0;
    u32 page = residual / PL_RESIDUAL_STATE_PAGE_STATES;
    u32 local = residual % PL_RESIDUAL_STATE_PAGE_STATES;
    u32 slot = page & (X86_EXECUTABLE_RESIDUAL_STATE_CACHE - 1u);
    if (x86->executable_residual_state_tag[slot] != page + 1u
            || local >= x86->executable_residual_state_count[slot])
        return 0;
    u32 word = local >> 6u;
    u32 bit = local & 63u;
    u64 zero_word = x86->executable_residual_zero[slot][word];
    u64 two_word = x86->executable_residual_two[slot][word];
    u64 mask = bit ? (((u64)1u << bit) - 1u) : 0u;
    u32 zero = (u32)((zero_word >> bit) & 1u);
    u32 two = (u32)((two_word >> bit) & 1u);
    u32 zero_rank = x86->executable_residual_zero_prefix[slot][word]
                  + (u32)__builtin_popcountll(zero_word & mask);
    u32 two_rank = x86->executable_residual_two_prefix[slot][word]
                 + (u32)__builtin_popcountll(two_word & mask);
    if (zero && two) return 0;
    *kernel = x86->executable_residual_kernel[slot][local];
    *degree = 1u + two - zero;
    *edge_base = x86->executable_residual_state_first_edge[slot]
               + local + two_rank - zero_rank;
    return *kernel < x86->executable_root.instantiation_count
        && *edge_base <= x86->executable_root.residual_edge_count
        && *degree <= x86->executable_root.residual_edge_count - *edge_base;
}

static int x86_executable_residual_edge_page_resident(
    const X86Workspace *x86, u32 edge)
{
    if (edge >= x86->executable_root.residual_edge_count) return 0;
    u32 page = edge / PL_RESIDUAL_EDGE_PAGE_EDGES;
    u32 local = edge % PL_RESIDUAL_EDGE_PAGE_EDGES;
    u32 slot = page & (X86_EXECUTABLE_RESIDUAL_EDGE_CACHE - 1u);
    return x86->executable_residual_edge_tag[slot] == page + 1u
        && local < x86->executable_residual_edge_count[slot];
}

static int x86_executable_residual_edge_resident(
    const X86Workspace *x86, u32 edge, u32 *next, i32 *delta)
{
    if (!x86_executable_residual_edge_page_resident(x86, edge)) return 0;
    u32 page = edge / PL_RESIDUAL_EDGE_PAGE_EDGES;
    u32 local = edge % PL_RESIDUAL_EDGE_PAGE_EDGES;
    u32 slot = page & (X86_EXECUTABLE_RESIDUAL_EDGE_CACHE - 1u);
    *next = x86->executable_residual_next[slot][local];
    *delta = x86->executable_residual_delta[slot][local];
    return 1;
}

static int x86_executable_publish_residual_state(X86Workspace *x86)
{
    u32 page = x86->executable_residual_rank;
    if (pl_residual_state_page_open(
            x86->executable_stage, page,
            x86->executable_root.residual_count,
            x86->executable_root.residual_edge_count,
            x86->executable_root.instantiation_count))
        return 0;
    u32 slot = page & (X86_EXECUTABLE_RESIDUAL_STATE_CACHE - 1u);
    u32 count = pl_read_u32(x86->executable_stage + 12u);
    u32 words = (count + 63u) >> 6u;
    x86->executable_residual_state_tag[slot] = 0u;
    x86->executable_residual_state_count[slot] = count;
    x86->executable_residual_state_first_edge[slot] =
        pl_read_u32(x86->executable_stage + 16u);
    for (u32 local = 0u; local < count; ++local)
        if (pl_residual_state_page_kernel(
                x86->executable_stage, local,
                &x86->executable_residual_kernel[slot][local]))
            return 0;
    x86->executable_residual_zero_prefix[slot][0] = 0u;
    x86->executable_residual_two_prefix[slot][0] = 0u;
    for (u32 word = 0u; word < words; ++word) {
        u64 zero = pl_read_u64(
            x86->executable_stage
            + PL_RESIDUAL_STATE_PAGE_ZERO_BITS + word * 8u);
        u64 two = pl_read_u64(
            x86->executable_stage
            + PL_RESIDUAL_STATE_PAGE_TWO_BITS + word * 8u);
        x86->executable_residual_zero[slot][word] = zero;
        x86->executable_residual_two[slot][word] = two;
        x86->executable_residual_zero_prefix[slot][word + 1u] =
            x86->executable_residual_zero_prefix[slot][word]
            + (u32)__builtin_popcountll(zero);
        x86->executable_residual_two_prefix[slot][word + 1u] =
            x86->executable_residual_two_prefix[slot][word]
            + (u32)__builtin_popcountll(two);
    }
    /* Publish after every hot column and prefix has been materialized. */
    x86->executable_residual_state_tag[slot] = page + 1u;
    return 1;
}

static int x86_executable_publish_residual_edge(X86Workspace *x86)
{
    u32 page = x86->executable_residual_rank;
    if (pl_residual_edge_page_open(
            x86->executable_stage, page,
            x86->executable_root.residual_count,
            x86->executable_root.residual_edge_count))
        return 0;
    u32 slot = page & (X86_EXECUTABLE_RESIDUAL_EDGE_CACHE - 1u);
    u32 count = pl_read_u32(x86->executable_stage + 12u);
    x86->executable_residual_edge_tag[slot] = 0u;
    x86->executable_residual_edge_count[slot] = count;
    for (u32 local = 0u; local < count; ++local)
        if (pl_residual_edge_page_get(
                x86->executable_stage, local,
                &x86->executable_residual_next[slot][local],
                &x86->executable_residual_delta[slot][local]))
            return 0;
    x86->executable_residual_edge_tag[slot] = page + 1u;
    return 1;
}

static int x86_executable_instantiation_resident(
    const X86Workspace *x86, u32 instantiation, u32 *topology,
    u32 *first_parameter, u32 *parameter_count)
{
    if (instantiation >= x86->executable_root.instantiation_count)
        return 0;
    u32 page = instantiation / PL_INSTANTIATION_PAGE_ROWS;
    u32 local = instantiation % PL_INSTANTIATION_PAGE_ROWS;
    u32 slot = page & (X86_EXECUTABLE_INSTANTIATION_CACHE - 1u);
    if (x86->executable_instantiation_tag[slot] != page + 1u
            || local >= x86->executable_instantiation_count[slot])
        return 0;
    *topology = x86->executable_instantiation_topology[slot][local];
    *first_parameter = x86->executable_instantiation_first[slot][local];
    *parameter_count = x86->executable_instantiation_words[slot][local];
    return *topology < x86->executable_root.function_count
        && *first_parameter <= x86->executable_root.parameter_word_count
        && *parameter_count
           <= x86->executable_root.parameter_word_count - *first_parameter;
}

static int x86_executable_parameter_page_resident(
    const X86Workspace *x86, u32 page)
{
    u32 slot = page & (X86_EXECUTABLE_PARAMETER_CACHE - 1u);
    return x86->executable_parameter_tag[slot] == page + 1u;
}

static int x86_executable_materialize_parameters(
    X86Workspace *x86, u32 first, u32 count)
{
    if (count > X86_EXECUTABLE_PARAMETER_VALUES
            || first > x86->executable_root.parameter_word_count
            || count > x86->executable_root.parameter_word_count - first)
        return 0;
    for (u32 index = 0u; index < count; ++index) {
        u32 rank = first + index;
        u32 page = rank / PL_PARAMETER_PAGE_WORDS;
        u32 local = rank % PL_PARAMETER_PAGE_WORDS;
        u32 slot = page & (X86_EXECUTABLE_PARAMETER_CACHE - 1u);
        if (x86->executable_parameter_tag[slot] != page + 1u
                || local >= x86->executable_parameter_count[slot])
            return 0;
        x86->executable_parameter_values[index] =
            x86->executable_parameter_page[slot][local];
    }
    x86->executable.parameter_count = count;
    ++x86->executable_parameter_materializations;
    x86->executable_parameter_words += count;
    return 1;
}

static int x86_executable_publish_instantiation(X86Workspace *x86)
{
    u32 page = x86->executable_instantiation_rank;
    u32 expected_first = x86->executable_page_resource.projection_argument;
    if (pl_instantiation_page_open(
            x86->executable_stage, page,
            x86->executable_root.instantiation_count,
            x86->executable_root.function_count,
            x86->executable_root.parameter_word_count, expected_first))
        return 0;
    u32 slot = page & (X86_EXECUTABLE_INSTANTIATION_CACHE - 1u);
    u32 count = pl_read_u32(x86->executable_stage + 12u);
    x86->executable_instantiation_tag[slot] = 0u;
    x86->executable_instantiation_count[slot] = count;
    for (u32 local = 0u; local < count; ++local) {
        u32 topology = 0u, first = 0u, words = 0u;
        if (pl_instantiation_page_get(
                x86->executable_stage, local,
                &topology, &first, &words))
            return 0;
        x86->executable_instantiation_topology[slot][local] = topology;
        x86->executable_instantiation_first[slot][local] = first;
        x86->executable_instantiation_words[slot][local] = (u8)words;
    }
    x86->executable_instantiation_tag[slot] = page + 1u;
    return 1;
}

static int x86_executable_publish_parameter(X86Workspace *x86)
{
    u32 page = x86->executable_instantiation_rank;
    if (pl_parameter_page_open(
            x86->executable_stage, page,
            x86->executable_root.parameter_word_count))
        return 0;
    u32 slot = page & (X86_EXECUTABLE_PARAMETER_CACHE - 1u);
    u32 count = pl_read_u32(x86->executable_stage + 12u);
    x86->executable_parameter_tag[slot] = 0u;
    x86->executable_parameter_count[slot] = count;
    for (u32 local = 0u; local < count; ++local)
        if (pl_parameter_page_get(
                x86->executable_stage, local,
                &x86->executable_parameter_page[slot][local]))
            return 0;
    x86->executable_parameter_tag[slot] = page + 1u;
    return 1;
}

static int x86_executable_accept_index_row(X86Workspace *x86,
                                           const u8 *row)
{
    if (x86->executable_index_kind == X86_EXECUTABLE_INDEX_CODE_BINDING) {
        pl_executable_binding binding;
        if (pl_executable_binding_read(row, &binding)
                || pl_executable_binding_validate(
                    &binding, x86->executable_root.source_bytes,
                    x86->executable_root.function_count)
                || binding.dispatch_argument
                   >= x86->executable_root.entry_page_count
                || binding.virtual_page != x86->executable_index_key.major
                || binding.generation != x86->executable_index_key.minor)
            return 0;
        x86->executable_entry_binding = binding;
        if (x86->executable_root.residual_flags
                & PL_EXECUTABLE_RESIDUAL_GRAPH) {
            x86->executable_index_kind = 0u;
            x86->executable_request = X86_EXECUTABLE_REQUEST_CODE_READY;
            return 1;
        }
        x86_executable_index_start(
            x86, X86_EXECUTABLE_INDEX_CODE_MODULE,
            &x86->executable_root.modules,
            (pl_index_key){ binding.dispatch_function, 0u });
        return 1;
    }
    if (x86->executable_index_kind == X86_EXECUTABLE_INDEX_BINDING) {
        pl_executable_binding binding;
        if (pl_executable_binding_read(row, &binding)
                || pl_executable_binding_validate(
                    &binding, x86->executable_root.source_bytes,
                    x86->executable_root.function_count)
                || binding.dispatch_argument
                   >= x86->executable_root.entry_page_count
                || binding.virtual_page != x86->executable_index_key.major
                || binding.generation != x86->executable_index_key.minor)
            return 0;
        x86->executable_entry_binding = binding;
        x86_executable_index_start(
            x86, X86_EXECUTABLE_INDEX_MODULE,
            &x86->executable_root.modules,
            (pl_index_key){ x86->executable_root.entry_function, 0u });
        return 1;
    }
    if (x86->executable_index_kind == X86_EXECUTABLE_INDEX_MODULE
            || x86->executable_index_kind
               == X86_EXECUTABLE_INDEX_CODE_MODULE
            || x86->executable_index_kind
               == X86_EXECUTABLE_INDEX_KERNEL_MODULE) {
        pl_executable_module module;
        int code = x86->executable_index_kind
                == X86_EXECUTABLE_INDEX_CODE_MODULE;
        int kernel = x86->executable_index_kind
                  == X86_EXECUTABLE_INDEX_KERNEL_MODULE;
        u64 entry = kernel ? x86->executable_kernel_rank
                  : code ? x86->executable_entry_binding.dispatch_function
                         : x86->executable_root.entry_function;
        if (pl_executable_module_read(row, &module)
                || pl_executable_module_validate(
                    &module, x86->executable_root.function_count)
                || module.first_function > entry
                || entry - module.first_function >= module.function_count)
            return 0;
        x86->executable_entry_module = module;
        x86->executable_index_kind = 0u;
        if ((code || kernel)
                && x86_executable_module_resident(x86, &module)) {
            x86->executable_request = kernel
                ? X86_EXECUTABLE_REQUEST_KERNEL_READY
                : X86_EXECUTABLE_REQUEST_CODE_READY;
            return 1;
        }
        x86->executable_module_offset = 0u;
        pl_sha256_open(&x86->executable_module_hash);
        x86->executable_request = X86_EXECUTABLE_REQUEST_MODULE;
        return 1;
    }
    if (x86->executable_index_kind == X86_EXECUTABLE_INDEX_RESOURCE_BASE) {
        pl_executable_resource resource;
        if (pl_executable_resource_read(row, &resource)
                || pl_executable_resource_validate(
                    &resource, x86->executable_root.memory_bytes)
                || resource.physical_address
                || resource.kind != PL_EXECUTABLE_RESOURCE_MEMORY_BASE)
            return 0;
        x86->executable_base_resource = resource;
        x86->executable_index_kind = 0u;
        x86->executable_request = X86_EXECUTABLE_REQUEST_READY;
        return 1;
    }
    if (x86->executable_index_kind == X86_EXECUTABLE_INDEX_RESOURCE_PAGE) {
        pl_executable_resource resource;
        u64 address = x86->physical_coordinate
                    * (u64)X86_PHYSICAL_PAGE_BYTES;
        if (pl_executable_resource_read(row, &resource)
                || pl_executable_resource_validate(
                    &resource, x86->executable_root.memory_bytes))
            return 0;
        x86->executable_page_resource = resource;
        x86->executable_index_kind = 0u;
        if (resource.kind == PL_EXECUTABLE_RESOURCE_MEMORY_EXTENT
                && resource.physical_address == address) {
            x86->executable_request = X86_EXECUTABLE_REQUEST_RESOURCE;
            return 1;
        }
        /* The selected predecessor is either the zero-default base or an
         * earlier one-page overlay.  In both cases this coordinate is an
         * authenticated sparse hole; no payload exists to ask the host for. */
        for (u32 index = 0u; index < X86_PHYSICAL_PAGE_BYTES; ++index)
            x86->physical_transfer[index] = 0u;
        x86->executable_request = X86_EXECUTABLE_REQUEST_PAGE_READY;
        return 1;
    }
    if (x86->executable_index_kind
            == X86_EXECUTABLE_INDEX_ENTRY_PAGE_ROWS
            || x86->executable_index_kind
               == X86_EXECUTABLE_INDEX_ENTRY_TAIL_ROW) {
        int tail = x86->executable_index_kind
                == X86_EXECUTABLE_INDEX_ENTRY_TAIL_ROW;
        pl_executable_resource resource;
        u64 expected = tail
            ? pl_executable_entry_tail_key(x86->executable_map_rank)
            : pl_executable_entry_page_key(x86->executable_map_rank);
        u32 expected_kind = tail
            ? PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW
            : PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS;
        if (pl_executable_resource_read(row, &resource)
                || pl_executable_resource_validate(
                    &resource, x86->executable_root.memory_bytes)
                || resource.physical_address != expected
                || resource.kind != expected_kind)
            return 0;
        x86->executable_page_resource = resource;
        x86->executable_index_kind = 0u;
        x86->executable_request = X86_EXECUTABLE_REQUEST_RESOURCE;
        return 1;
    }
    if (x86->executable_index_kind
            == X86_EXECUTABLE_INDEX_RESIDUAL_STATE
            || x86->executable_index_kind
               == X86_EXECUTABLE_INDEX_RESIDUAL_EDGE) {
        int edge = x86->executable_index_kind
                == X86_EXECUTABLE_INDEX_RESIDUAL_EDGE;
        pl_executable_resource resource;
        u64 expected = edge
            ? pl_executable_residual_edge_key(
                x86->executable_residual_rank)
            : pl_executable_residual_state_key(
                x86->executable_residual_rank);
        u32 expected_kind = edge
            ? PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE
            : PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE;
        if (pl_executable_resource_read(row, &resource)
                || pl_executable_resource_validate(
                    &resource, x86->executable_root.memory_bytes)
                || resource.physical_address != expected
                || resource.kind != expected_kind)
            return 0;
        x86->executable_page_resource = resource;
        x86->executable_index_kind = 0u;
        x86->executable_request = X86_EXECUTABLE_REQUEST_RESOURCE;
        return 1;
    }
    if (x86->executable_index_kind
            == X86_EXECUTABLE_INDEX_INSTANTIATION
            || x86->executable_index_kind
               == X86_EXECUTABLE_INDEX_PARAMETER) {
        int parameter = x86->executable_index_kind
                     == X86_EXECUTABLE_INDEX_PARAMETER;
        pl_executable_resource resource;
        u64 expected = parameter
            ? pl_executable_parameter_key(
                x86->executable_instantiation_rank)
            : pl_executable_instantiation_key(
                x86->executable_instantiation_rank);
        u32 expected_kind = parameter
            ? PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE
            : PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE;
        if (pl_executable_resource_read(row, &resource)
                || pl_executable_resource_validate(
                    &resource, x86->executable_root.memory_bytes)
                || resource.physical_address != expected
                || resource.kind != expected_kind)
            return 0;
        x86->executable_page_resource = resource;
        x86->executable_index_kind = 0u;
        x86->executable_request = X86_EXECUTABLE_REQUEST_RESOURCE;
        return 1;
    }
    return 0;
}

static int x86_executable_accept_index_node(
    X86Workspace *x86, const pl_index_node *node)
{
    int floor = x86->executable_index_kind
                    == X86_EXECUTABLE_INDEX_MODULE
             || x86->executable_index_kind
                    == X86_EXECUTABLE_INDEX_CODE_MODULE
             || x86->executable_index_kind
                    == X86_EXECUTABLE_INDEX_KERNEL_MODULE
             || x86->executable_index_kind
                    == X86_EXECUTABLE_INDEX_RESOURCE_PAGE;
    if (node->level) {
        int status = floor
            ? pl_index_select_floor_child(
                node, x86->executable_index_key,
                &x86->executable_index_ref)
            : pl_index_select_child(
                node, x86->executable_index_key,
                &x86->executable_index_ref);
        return status == 0;
    }
    const u8 *row = 0;
    int status = floor
        ? pl_index_find_floor(node, x86->executable_index_key, &row)
        : pl_index_find_row(node, x86->executable_index_key, &row);
    return !status && x86_executable_accept_index_row(x86, row);
}

static int x86_executable_advance_cached_index(X86Workspace *x86)
{
    while (x86->executable_request == X86_EXECUTABLE_REQUEST_INDEX) {
        pl_index_node node;
        if (!x86_executable_index_cache_open(
                x86, &x86->executable_index_ref, &node)) {
            ++x86->executable_index_cache_misses;
            return 1;
        }
        ++x86->executable_index_cache_hits;
        if (!x86_executable_accept_index_node(x86, &node)) return 0;
    }
    return 1;
}

/* Open one fixed authenticated compiler root in C-owned staging.  Publication
 * cannot skip its selected root-to-leaf proofs: C requests opaque objects by
 * digest, validates each index node, streams and hashes the entry module, and
 * finally admits the zero-default physical-memory resource. */
EXPORT u8 *vm_x86_executable_buffer(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session)
         && (!x86->active || !x86->executable_published)
         && !x86->executable_root_loading
         && !x86->executable_page_loading
         ? x86->executable_stage : (u8 *)0;
}

EXPORT u32 vm_x86_executable_buffer_bytes(void)
{
    return PL_EXECUTABLE_HEADER_BYTES;
}

EXPORT int vm_x86_executable_begin(u64 session, u64 root_bytes,
                                   u32 table_base)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || (x86->active && x86->executable_published)
            || x86->executable_root_loading
            || x86->executable_page_loading
            || !table_base)
        return 0;
    pl_executable root;
    int status = pl_executable_open(
        x86->executable_stage, root_bytes, &root);
    if (status
            || table_base > 0xffffffffu
                          - root.function_count)
        return 0;
    /* The fixed root is the machine's initial cut.  Re-open the resident
     * workspace from that C-parsed state even if an older browser supplied a
     * provisional zero state first; JavaScript is not an architectural-state
     * decoder in the direct path. */
    if (!vm_x86_open(
            session, root.state.rip, root.state.rflags,
            root.state.cr0, root.state.cr3, root.state.cr4,
            root.state.efer, root.memory_bytes))
        return 0;
    x86 = x86_machine();
    for (u32 index = 0u; index < X86_REGISTER_COUNT; ++index)
        x86->registers[index] = root.state.registers[index];
    for (u32 index = 0u; index < PL_VM_X86_XMM_WORDS; ++index)
        x86->xmm[index] = root.state.xmm[index];
    for (u32 index = 0u; index < X86_SYSTEM_COUNT; ++index)
        x86->system[index] = root.state.system[index];
    for (u32 index = 0u; index < X86_MSR_CAP; ++index) {
        x86->msr_keys[index] = root.state.msr_keys[index];
        x86->msr_values[index] = root.state.msr_values[index];
    }
    x86->msr_count = root.state.msr_count;
    x86->mxcsr = root.state.mxcsr;
    x86->retired = root.state.retired;
    x86->work = root.state.work;
    x86->span = root.state.span;
    for (u32 index = 0u; index < PL_VM_X86_X87_REGISTERS; ++index) {
        x86->x87_significand[index] = root.state.x87_significand[index];
        x86->x87_sign_exponent[index] =
            root.state.x87_sign_exponent[index];
    }
    x86->x87_control = root.state.x87_control;
    x86->x87_status = root.state.x87_status;
    x86->x87_tag = root.state.x87_tag;
    x86->x87_opcode = root.state.x87_opcode;
    x86->x87_ip = root.state.x87_ip;
    x86->x87_dp = root.state.x87_dp;
    x86->executable_root = root;
    x86->executable_table_base = table_base;
    x86->executable_root_loading = 1u;
    x86_executable_index_start(
        x86, X86_EXECUTABLE_INDEX_BINDING,
        &root.bindings,
        (pl_index_key){
            root.entry_rip
                & ~((u64)PL_EXECUTABLE_PAGE_BYTES - 1u),
            root.entry_generation,
        });
    return 1;
}

EXPORT u32 vm_x86_executable_request_kind(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (step_session_is(session) && x86_executable_request_active(x86)
            && x86->executable_request == X86_EXECUTABLE_REQUEST_INDEX
            && !x86_executable_advance_cached_index(x86)) {
        x86_fail(54u);
        return X86_EXECUTABLE_REQUEST_NONE;
    }
    return step_session_is(session) && x86_executable_request_active(x86)
         ? x86->executable_request : X86_EXECUTABLE_REQUEST_NONE;
}

EXPORT const u8 *vm_x86_executable_request_digest(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86_executable_request_active(x86))
        return (const u8 *)0;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_INDEX)
        return x86->executable_index_ref.digest;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_MODULE
            || x86->executable_request == X86_EXECUTABLE_REQUEST_INSTALL)
        return x86->executable_entry_module.digest;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_RESOURCE)
        return x86->executable_page_resource.digest;
    return (const u8 *)0;
}

EXPORT u64 vm_x86_executable_request_bytes(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86_executable_request_active(x86))
        return 0u;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_INDEX)
        return x86->executable_index_ref.node_bytes;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_MODULE
            || x86->executable_request == X86_EXECUTABLE_REQUEST_INSTALL)
        return x86->executable_entry_module.payload_bytes;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_RESOURCE)
        return x86->executable_page_resource.object_bytes;
    return 0u;
}

EXPORT u64 vm_x86_executable_request_offset(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session)
        && x86->executable_request == X86_EXECUTABLE_REQUEST_MODULE
         ? x86->executable_module_offset : 0u;
}

EXPORT u8 *vm_x86_executable_request_buffer(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86_executable_request_active(x86)
        && (x86->executable_request == X86_EXECUTABLE_REQUEST_INDEX
            || x86->executable_request == X86_EXECUTABLE_REQUEST_MODULE
            || x86->executable_request == X86_EXECUTABLE_REQUEST_RESOURCE)
         ? x86->executable_stage : (u8 *)0;
}

EXPORT u32 vm_x86_executable_request_buffer_bytes(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86_executable_request_active(x86))
        return 0u;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_INDEX)
        return x86->executable_index_ref.node_bytes;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_MODULE) {
        u64 left = x86->executable_entry_module.payload_bytes
                 - x86->executable_module_offset;
        return left < PL_INDEX_NODE_BYTES ? (u32)left : PL_INDEX_NODE_BYTES;
    }
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_RESOURCE)
        return (u32)x86->executable_page_resource.object_bytes;
    return 0u;
}

EXPORT int vm_x86_executable_supply(u64 session, u32 bytes)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86_executable_request_active(x86)
            || bytes != vm_x86_executable_request_buffer_bytes(session))
        return 0;
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_INDEX) {
        ++x86->executable_index_nodes;
        pl_index_node node;
        if (pl_index_node_open(&x86->executable_index_ref,
                               x86->executable_stage, bytes, &node))
            return 0;
        x86_executable_index_cache_publish(
            x86, &x86->executable_index_ref, &node);
        return x86_executable_accept_index_node(x86, &node);
    }
    if (x86->executable_request == X86_EXECUTABLE_REQUEST_RESOURCE) {
        ++x86->executable_resource_payloads;
        u8 digest[PL_SHA256_BYTES];
        pl_sha256_digest(x86->executable_stage, bytes, digest);
        if (!x86_same_digest(
                digest, x86->executable_page_resource.digest))
            return 0;
        if (x86->executable_instantiation_loading) {
            for (u32 index = bytes;
                 index < PL_INSTANTIATION_PAGE_BYTES; ++index)
                x86->executable_stage[index] = 0u;
            int published = x86->executable_instantiation_parameter
                ? x86_executable_publish_parameter(x86)
                : x86_executable_publish_instantiation(x86);
            if (!published) return 0;
            x86->executable_request =
                X86_EXECUTABLE_REQUEST_INSTANTIATION_READY;
        } else if (x86->executable_residual_loading) {
            for (u32 index = bytes; index < PL_RESIDUAL_PAGE_BYTES; ++index)
                x86->executable_stage[index] = 0u;
            int published = x86->executable_residual_edge
                ? x86_executable_publish_residual_edge(x86)
                : x86_executable_publish_residual_state(x86);
            if (!published) return 0;
            x86->executable_request =
                X86_EXECUTABLE_REQUEST_RESIDUAL_READY;
        } else if (x86->executable_map_loading) {
            if (x86->executable_map_tail) {
                if (bytes != PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES)
                    return 0;
                u32 slot = x86->executable_map_rank
                         & (X86_EXECUTABLE_ENTRY_TAIL_CACHE - 1u);
                for (u32 index = 0u; index < PL_ENTRY_TAIL_VALUES; ++index)
                    x86->executable_entry_tail_rows[slot][index] =
                        pl_read_u32(x86->executable_stage + index * 4u);
                x86->executable_entry_tail_tag[slot] =
                    x86->executable_map_rank + 1u;
            } else {
                if (bytes != PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES)
                    return 0;
                u32 slot = x86->executable_map_rank
                         & (X86_EXECUTABLE_ENTRY_PAGE_CACHE - 1u);
                for (u32 index = 0u; index < PL_ENTRY_PAGE_ROWS; ++index)
                    x86->executable_entry_page_rows[slot][index] =
                        pl_read_u32(x86->executable_stage + index * 4u);
                x86->executable_entry_page_tag[slot] =
                    x86->executable_map_rank + 1u;
            }
            x86->executable_request = X86_EXECUTABLE_REQUEST_MAP_READY;
        } else {
            for (u32 index = 0u; index < X86_PHYSICAL_PAGE_BYTES; ++index)
                x86->physical_transfer[index] = 0u;
            for (u32 index = 0u; index < bytes; ++index)
                x86->physical_transfer[index] = x86->executable_stage[index];
            x86->executable_request = X86_EXECUTABLE_REQUEST_PAGE_READY;
        }
        return 1;
    }
    if (x86->executable_request != X86_EXECUTABLE_REQUEST_MODULE)
        return 0;
    ++x86->executable_module_chunks;
    pl_sha256_write(&x86->executable_module_hash,
                    x86->executable_stage, bytes);
    x86->executable_module_offset += bytes;
    if (x86->executable_module_offset
            < x86->executable_entry_module.payload_bytes)
        return 1;
    u8 digest[PL_SHA256_BYTES];
    pl_sha256_close(&x86->executable_module_hash, digest);
    if (!x86_same_digest(digest, x86->executable_entry_module.digest)) {
        x86->executable_module_offset = 0u;
        pl_sha256_open(&x86->executable_module_hash);
        return 0;
    }
    x86->executable_request = X86_EXECUTABLE_REQUEST_INSTALL;
    return 1;
}

EXPORT u32 vm_x86_executable_module_table_base(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || x86->executable_request != X86_EXECUTABLE_REQUEST_INSTALL)
        return 0u;
    return x86->executable_table_base
         + (u32)x86->executable_entry_module.first_function;
}

EXPORT u32 vm_x86_executable_module_function_count(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session)
        && x86->executable_request == X86_EXECUTABLE_REQUEST_INSTALL
         ? x86->executable_entry_module.function_count : 0u;
}

EXPORT int vm_x86_executable_module_installed(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || (!x86->executable_root_loading
                && !x86->executable_code_loading
                && !x86->executable_kernel_loading)
            || x86->executable_request != X86_EXECUTABLE_REQUEST_INSTALL)
        return 0;
    x86_executable_publish_module(x86, &x86->executable_entry_module);
    if (x86->executable_code_loading) {
        x86->executable_request = X86_EXECUTABLE_REQUEST_CODE_READY;
        return 1;
    }
    if (x86->executable_kernel_loading) {
        x86->executable_request = X86_EXECUTABLE_REQUEST_KERNEL_READY;
        return 1;
    }
    x86_executable_index_start(
        x86, X86_EXECUTABLE_INDEX_RESOURCE_BASE,
        &x86->executable_root.resources, (pl_index_key){ 0u, 0u });
    return 1;
}

EXPORT int vm_x86_executable_commit(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_root_loading
            || x86->executable_request != X86_EXECUTABLE_REQUEST_READY
            || x86->executable_root.memory_bytes != x86->memory_bytes)
        return 0;
    for (u32 index = 0; index < sizeof x86->executable / sizeof(u32); ++index)
        ((u32 *)&x86->executable)[index] = 0;
    x86->executable.abi_version = PL_VM_ABI_VERSION;
    x86->executable.bytes = PL_VM_EXECUTABLE_CONTEXT_BYTES;
    x86->executable.table_base = x86->executable_table_base;
    x86->executable.function_count = x86->executable_root.function_count;
    x86->executable.entry_function = x86->executable_root.entry_function;
    x86->executable.page_count = x86->executable_root.entry_page_count;
    x86->executable.tail_row_count =
        x86->executable_root.entry_tail_row_count;
    x86->executable.binding_tags =
        (u32)(uptr)&x86->executable_binding_tag[0];
    x86->executable.binding_generations =
        (u32)(uptr)&x86->executable_binding_generation[0];
    x86->executable.binding_arguments =
        (u32)(uptr)&x86->executable_binding_argument[0];
    x86->executable.binding_slots = X86_EXECUTABLE_BINDING_CACHE;
    x86->executable.page_row_tags =
        (u32)(uptr)&x86->executable_entry_page_tag[0];
    x86->executable.page_row_values =
        (u32)(uptr)&x86->executable_entry_page_rows[0][0];
    x86->executable.page_row_slots = X86_EXECUTABLE_ENTRY_PAGE_CACHE;
    x86->executable.tail_row_tags =
        (u32)(uptr)&x86->executable_entry_tail_tag[0];
    x86->executable.tail_row_values =
        (u32)(uptr)&x86->executable_entry_tail_rows[0][0];
    x86->executable.tail_row_slots = X86_EXECUTABLE_ENTRY_TAIL_CACHE;
    x86->executable.parameter_values =
        (u32)(uptr)&x86->executable_parameter_values[0];
    x86->executable.parameter_count = 0u;
    x86->direct_blocks = 0;
    x86->direct_function = x86->executable.entry_function;
    x86->direct_residual = x86->executable_root.entry_residual;
    x86->direct_memory_result = 0u;
    x86->direct_transaction_active = 0u;
    x86->direct_repeat_active = 0u;
    x86->direct_copy_active = 0u;
    x86->direct_find_active = 0u;
    x86->direct_frame_active = 0u;
    x86->executable_root_loading = 0;
    x86->executable_published = 1u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86_executable_publish_module(x86, &x86->executable_entry_module);
    x86_executable_publish_page(x86, &x86->executable_entry_binding);
    return 1;
}

/* Resolve a dynamic or statically-outside RIP through the authenticated
 * binding/module indexes.  A direct-mapped page cache makes the steady-state
 * operation one tag check; a miss asks the host only for opaque authenticated
 * nodes/module bytes.  No x86 decode or block construction occurs here. */
EXPORT int vm_x86_executable_resolve_begin(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || x86_executable_request_active(x86)
            || x86->executable_request != X86_EXECUTABLE_REQUEST_NONE)
        return 0;
    u64 page = x86->rip & ~((u64)PL_EXECUTABLE_PAGE_BYTES - 1u);
    u64 generation = x86->executable_root.entry_generation;
    u32 function = 0u;
    if (x86_executable_page_resident(
            x86, page, generation, &function, 0)) {
        x86->direct_function = function;
        return 2;
    }
    x86->executable_code_loading = 1u;
    x86_executable_index_start(
        x86, X86_EXECUTABLE_INDEX_CODE_BINDING,
        &x86->executable_root.bindings,
        (pl_index_key){ page, generation });
    return 1;
}

EXPORT int vm_x86_executable_resolve_commit(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published || !x86->executable_code_loading
            || x86->executable_request
               != X86_EXECUTABLE_REQUEST_CODE_READY)
        return 0;
    x86_executable_publish_page(x86, &x86->executable_entry_binding);
    x86->direct_function = x86->executable_entry_binding.dispatch_function;
    x86->executable_code_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

/* Project the current dynamic RIP into the canonical residual partition.
 * The authenticated binding supplies only the entry-page rank.  Page and
 * tail rows stay independently evictable; their miss tokens reuse the same
 * opaque admission ABI as legacy generated dispatchers. */
EXPORT pl_vm_result vm_x86_executable_project_residual(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || !(x86->executable_root.residual_flags
                 & PL_EXECUTABLE_RESIDUAL_GRAPH))
        return pl_vm_result_make(PL_VM_FAULT, 0xffu);
    u64 page = x86->rip & ~((u64)PL_EXECUTABLE_PAGE_BYTES - 1u);
    u32 function = 0u, page_rank = 0u;
    if (!x86_executable_page_resident(
            x86, page, x86->executable_root.entry_generation,
            &function, &page_rank))
        return pl_vm_result_make(PL_VM_RESOLVE_RIP, 0u);
    (void)function;
    if (page_rank >= x86->executable_root.entry_page_count)
        return pl_vm_result_make(PL_VM_STALE_GENERATION, 0u);
    u32 page_slot = page_rank & (X86_EXECUTABLE_ENTRY_PAGE_CACHE - 1u);
    if (x86->executable_entry_page_tag[page_slot] != page_rank + 1u)
        return pl_vm_result_make(
            PL_VM_ENTRY_MAP, (u64)page_rank << 1u);
    u32 offset = (u32)(x86->rip - page);
    u32 tail_rank = x86->executable_entry_page_rows[page_slot]
        [offset >> PL_ENTRY_TAIL_BITS];
    if (tail_rank >= x86->executable_root.entry_tail_row_count)
        return pl_vm_result_make(PL_VM_STALE_GENERATION, 0u);
    u32 tail_slot = tail_rank & (X86_EXECUTABLE_ENTRY_TAIL_CACHE - 1u);
    if (x86->executable_entry_tail_tag[tail_slot] != tail_rank + 1u)
        return pl_vm_result_make(
            PL_VM_ENTRY_MAP, ((u64)tail_rank << 1u) | 1u);
    u32 residual = x86->executable_entry_tail_rows[tail_slot]
        [offset & (PL_ENTRY_TAIL_VALUES - 1u)];
    if (residual >= x86->executable_root.residual_count)
        return pl_vm_result_make(PL_VM_STALE_GENERATION, 0u);
    x86->direct_residual = residual;
    return pl_vm_direct(residual);
}

EXPORT int vm_x86_executable_resolve_abort(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->executable_code_loading)
        return 0;
    x86->executable_code_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    x86->executable_module_offset = 0u;
    return 1;
}

/* Admit one cold quotient row requested by a generated page dispatcher.  The
 * result token carries only (page-row/tail-row, rank); C derives the exact
 * authenticated resource key and publishes a cache tag only after digest and
 * extent verification. */
EXPORT int vm_x86_executable_map_begin(u64 session, pl_vm_result result)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || x86_executable_request_active(x86)
            || x86->executable_request != X86_EXECUTABLE_REQUEST_NONE
            || pl_vm_result_kind(result) != PL_VM_ENTRY_MAP)
        return 0;
    u64 coordinate = pl_vm_result_payload(result);
    int tail = (int)(coordinate & 1u);
    u64 wide_rank = coordinate >> 1u;
    u32 limit = tail ? x86->executable_root.entry_tail_row_count
                     : x86->executable_root.entry_page_count;
    if (wide_rank >= limit) return 0;
    u32 rank = (u32)wide_rank;
    if (tail) {
        u32 slot = rank & (X86_EXECUTABLE_ENTRY_TAIL_CACHE - 1u);
        if (x86->executable_entry_tail_tag[slot] == rank + 1u) return 2;
    } else {
        u32 slot = rank & (X86_EXECUTABLE_ENTRY_PAGE_CACHE - 1u);
        if (x86->executable_entry_page_tag[slot] == rank + 1u) return 2;
    }
    x86->executable_map_loading = 1u;
    x86->executable_map_tail = (u32)tail;
    x86->executable_map_rank = rank;
    x86_executable_index_start(
        x86,
        tail ? X86_EXECUTABLE_INDEX_ENTRY_TAIL_ROW
             : X86_EXECUTABLE_INDEX_ENTRY_PAGE_ROWS,
        &x86->executable_root.resources,
        (pl_index_key){
            tail ? pl_executable_entry_tail_key(rank)
                 : pl_executable_entry_page_key(rank),
            0u,
        });
    return 1;
}

EXPORT int vm_x86_executable_map_commit(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published || !x86->executable_map_loading
            || x86->executable_request != X86_EXECUTABLE_REQUEST_MAP_READY)
        return 0;
    x86->executable_map_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

EXPORT int vm_x86_executable_map_abort(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->executable_map_loading) return 0;
    x86->executable_map_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

/* Admit one canonical residual descriptor page.  A transition token escaping
 * the C runner is only an opaque (page-rank, column-kind) miss coordinate;
 * compiler-emitted arm results are always consumed inside the runner. */
EXPORT int vm_x86_executable_residual_begin(
    u64 session, pl_vm_result result)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || !(x86->executable_root.residual_flags
                 & PL_EXECUTABLE_RESIDUAL_GRAPH)
            || x86_executable_request_active(x86)
            || x86->executable_request != X86_EXECUTABLE_REQUEST_NONE
            || pl_vm_result_kind(result) != PL_VM_TRANSITION)
        return 0;
    u64 coordinate = pl_vm_result_payload(result);
    u32 column = (u32)(coordinate & 7u);
    if (column > 1u) return 0;
    int edge = column == 1u;
    u64 wide_page = coordinate >> 3u;
    u32 items = edge ? x86->executable_root.residual_edge_count
                     : x86->executable_root.residual_count;
    u32 per_page = edge ? PL_RESIDUAL_EDGE_PAGE_EDGES
                        : PL_RESIDUAL_STATE_PAGE_STATES;
    u32 pages = items / per_page + (items % per_page != 0u);
    if (wide_page >= pages) return 0;
    u32 page = (u32)wide_page;
    if (edge) {
        u32 slot = page & (X86_EXECUTABLE_RESIDUAL_EDGE_CACHE - 1u);
        if (x86->executable_residual_edge_tag[slot] == page + 1u)
            return 2;
    } else {
        u32 slot = page & (X86_EXECUTABLE_RESIDUAL_STATE_CACHE - 1u);
        if (x86->executable_residual_state_tag[slot] == page + 1u)
            return 2;
    }
    x86->executable_residual_loading = 1u;
    x86->executable_residual_edge = (u32)edge;
    x86->executable_residual_rank = page;
    x86_executable_index_start(
        x86,
        edge ? X86_EXECUTABLE_INDEX_RESIDUAL_EDGE
             : X86_EXECUTABLE_INDEX_RESIDUAL_STATE,
        &x86->executable_root.resources,
        (pl_index_key){
            edge ? pl_executable_residual_edge_key(page)
                 : pl_executable_residual_state_key(page),
            0u,
        });
    return 1;
}

EXPORT int vm_x86_executable_residual_commit(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || !x86->executable_residual_loading
            || x86->executable_request
               != X86_EXECUTABLE_REQUEST_RESIDUAL_READY)
        return 0;
    x86->executable_residual_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

EXPORT int vm_x86_executable_residual_abort(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->executable_residual_loading)
        return 0;
    x86->executable_residual_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

/* Admit the exact-identity row or one parameter page selected before a
 * topology function is entered.  A selected span is copied only after every
 * page it can touch is resident, so a miss cannot replay architectural work. */
EXPORT int vm_x86_executable_instantiation_begin(
    u64 session, pl_vm_result result)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || !(x86->executable_root.residual_flags
                 & PL_EXECUTABLE_RESIDUAL_GRAPH)
            || x86_executable_request_active(x86)
            || x86->executable_request != X86_EXECUTABLE_REQUEST_NONE
            || pl_vm_result_kind(result) != PL_VM_TRANSITION)
        return 0;
    u64 coordinate = pl_vm_result_payload(result);
    u32 column = (u32)(coordinate & 7u);
    if (column != 3u && column != 4u) return 0;
    int parameter = column == 4u;
    u64 wide_page = coordinate >> 3u;
    u32 items = parameter ? x86->executable_root.parameter_word_count
                          : x86->executable_root.instantiation_count;
    u32 per_page = parameter ? PL_PARAMETER_PAGE_WORDS
                             : PL_INSTANTIATION_PAGE_ROWS;
    u32 pages = items / per_page + (items % per_page != 0u);
    if (wide_page >= pages) return 0;
    u32 page = (u32)wide_page;
    if (parameter) {
        if (x86_executable_parameter_page_resident(x86, page)) return 2;
    } else {
        u32 slot = page & (X86_EXECUTABLE_INSTANTIATION_CACHE - 1u);
        if (x86->executable_instantiation_tag[slot] == page + 1u)
            return 2;
    }
    x86->executable_instantiation_loading = 1u;
    x86->executable_instantiation_parameter = (u32)parameter;
    x86->executable_instantiation_rank = page;
    x86_executable_index_start(
        x86,
        parameter ? X86_EXECUTABLE_INDEX_PARAMETER
                  : X86_EXECUTABLE_INDEX_INSTANTIATION,
        &x86->executable_root.resources,
        (pl_index_key){
            parameter ? pl_executable_parameter_key(page)
                      : pl_executable_instantiation_key(page),
            0u,
        });
    return 1;
}

EXPORT int vm_x86_executable_instantiation_commit(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || !x86->executable_instantiation_loading
            || x86->executable_request
               != X86_EXECUTABLE_REQUEST_INSTANTIATION_READY)
        return 0;
    x86->executable_instantiation_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

EXPORT int vm_x86_executable_instantiation_abort(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session)
            || !x86->executable_instantiation_loading)
        return 0;
    x86->executable_instantiation_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

/* Admit the bounded Wasm module containing one cold kernel rank.  Module
 * lookup is a floor selection over first_function; C verifies that the chosen
 * range contains the requested rank before any bytes reach WebAssembly. */
EXPORT int vm_x86_executable_kernel_begin(
    u64 session, pl_vm_result result)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || !(x86->executable_root.residual_flags
                 & PL_EXECUTABLE_RESIDUAL_GRAPH)
            || x86_executable_request_active(x86)
            || x86->executable_request != X86_EXECUTABLE_REQUEST_NONE
            || pl_vm_result_kind(result) != PL_VM_TRANSITION)
        return 0;
    u64 coordinate = pl_vm_result_payload(result);
    if ((coordinate & 7u) != 2u) return 0;
    u64 wide_rank = coordinate >> 3u;
    if (wide_rank >= x86->executable.function_count) return 0;
    u32 rank = (u32)wide_rank;
    if (x86_executable_kernel_resident(x86, rank)) return 2;
    x86->executable_kernel_loading = 1u;
    x86->executable_kernel_rank = rank;
    x86_executable_index_start(
        x86, X86_EXECUTABLE_INDEX_KERNEL_MODULE,
        &x86->executable_root.modules,
        (pl_index_key){ rank, 0u });
    return 1;
}

EXPORT int vm_x86_executable_kernel_commit(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published
            || !x86->executable_kernel_loading
            || x86->executable_request != X86_EXECUTABLE_REQUEST_KERNEL_READY
            || !x86_executable_kernel_resident(
                x86, x86->executable_kernel_rank))
        return 0;
    x86->executable_kernel_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

EXPORT int vm_x86_executable_kernel_abort(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->executable_kernel_loading)
        return 0;
    x86->executable_kernel_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    x86->executable_module_offset = 0u;
    return 1;
}

/* Resolve one cold physical coordinate through the authenticated resource
 * index.  The host is only an opaque digest/range courier.  C selects and
 * validates the row, verifies a complete one-page payload, supplies trailing
 * canonical zeros, and publishes the resident page under the existing lease. */
EXPORT int vm_x86_executable_physical_begin(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published || x86->executable_root_loading
            || x86->executable_page_loading
            || x86->physical_status != X86_NEED_PHYSICAL
            || !x86->physical_lease
            || x86->physical_coordinate == X86_NO_PAGE
            || x86->physical_coordinate
               > (~(u64)0 / X86_PHYSICAL_PAGE_BYTES))
        return 0;
    u64 address = x86->physical_coordinate
                * (u64)X86_PHYSICAL_PAGE_BYTES;
    x86->executable_page_loading = 1u;
    x86_executable_index_start(
        x86, X86_EXECUTABLE_INDEX_RESOURCE_PAGE,
        &x86->executable_root.resources,
        (pl_index_key){ address, 0u });
    return 1;
}

EXPORT int vm_x86_executable_physical_commit(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published || !x86->executable_page_loading
            || x86->executable_request
               != X86_EXECUTABLE_REQUEST_PAGE_READY)
        return 0;
    u64 lease = x86->physical_lease;
    u64 page = x86->physical_coordinate;
    if (!x86_supply_physical(
            session, lease, page, X86_PHYSICAL_PAGE_BYTES))
        return 0;
    x86->executable_page_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

EXPORT int vm_x86_executable_physical_abort(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->executable_published
            || !x86->executable_page_loading)
        return 0;
    x86->executable_page_loading = 0u;
    x86->executable_request = X86_EXECUTABLE_REQUEST_NONE;
    x86->executable_index_kind = 0u;
    return 1;
}

EXPORT int vm_x86_executable_abort(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active
            || x86->executable_published)
        return 0;
    x86->executable_root_loading = 0;
    x86->executable_table_base = 0;
    x86_executable_admission_clear(x86);
    return 1;
}

EXPORT int vm_x86_unpublish_executable(u64 session)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active) return 0;
    x86->executable_published = 0;
    x86->direct_blocks = 0;
    x86->direct_residual = 0u;
    x86->direct_transaction_active = 0u;
    x86->direct_repeat_active = 0u;
    x86->direct_copy_active = 0u;
    x86->direct_find_active = 0u;
    x86->direct_frame_active = 0u;
    x86->executable_root_loading = 0;
    x86->executable_table_base = 0;
    x86_executable_admission_clear(x86);
    return 1;
}

EXPORT u32 vm_x86_machine_state(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? (u32)(uptr)&x86_machine()->architectural : 0;
}

EXPORT u32 vm_x86_executable_context(u64 session)
{
    return step_session_is(session) && x86_machine()->executable_published
         ? (u32)(uptr)&x86_machine()->executable : 0;
}

EXPORT u32 vm_x86_executable_entry_function(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable.entry_function : 0xffffffffu;
}

EXPORT u32 vm_x86_executable_entry_residual(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
        && (x86->executable_root.residual_flags
            & PL_EXECUTABLE_RESIDUAL_GRAPH)
         ? x86->executable_root.entry_residual : 0xffffffffu;
}

EXPORT u64 vm_x86_executable_index_starts(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_index_starts : 0u;
}

EXPORT u64 vm_x86_executable_index_nodes(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_index_nodes : 0u;
}

EXPORT u64 vm_x86_executable_index_cache_hits(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_index_cache_hits : 0u;
}

EXPORT u64 vm_x86_executable_index_cache_misses(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_index_cache_misses : 0u;
}

EXPORT u64 vm_x86_executable_resource_payloads(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_resource_payloads : 0u;
}

EXPORT u64 vm_x86_executable_module_chunks(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_module_chunks : 0u;
}

EXPORT u64 vm_x86_executable_parameter_materializations(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_parameter_materializations : 0u;
}

EXPORT u64 vm_x86_executable_parameter_words(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->executable_parameter_words : 0u;
}

EXPORT u64 vm_x86_physical_lookup_probes(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->active
         ? x86->physical_lookup_probes : 0u;
}

EXPORT u64 vm_x86_physical_victim_probes(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->active
         ? x86->physical_victim_probes : 0u;
}

static pl_vm_result x86_residual_miss(u32 coordinate, u32 kind)
{
    return pl_vm_result_make(
        PL_VM_TRANSITION, ((u64)coordinate << 3u) | kind);
}

/* Architectural faults and traps never escape to JavaScript for semantic
 * handling.  Faulting blocks leave RIP at the instruction; trap blocks have
 * already published their fallthrough.  The common IDT transfer consumes that
 * canonical coordinate and either requests one physical page or returns the
 * new handler RIP to the total page dispatcher. */
static pl_vm_result x86_direct_deliver_fault(
        X86Workspace *x86, pl_vm_result result)
{
    /* A faulting shadow successor ends STI inhibition before its handler
     * frame is built; RFLAGS.IF itself remains the value published by STI. */
    x86->interrupt_shadow = 0u;
    if (!x86->exception_pending) {
        u64 payload = pl_vm_result_payload(result);
        if (payload >= 0xffu) {
            x86_fail(54u);
            return pl_vm_result_make(PL_VM_FAULT, 0xffu);
        }
        x86->exception_vector = (u32)payload;
        x86->exception_has_error = 0u;
        x86->exception_error = 0u;
        x86->exception_pending = 1u;
        x86->block_loaded = 0u;
    }
    int status = x86_deliver_exception();
    if (status == X86_NEED_BLOCK)
        return pl_vm_result_make(PL_VM_RESOLVE_RIP, 0u);
    if (x86->physical_status && status == (int)x86->physical_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->physical_status);
    x86_fail(54u);
    return pl_vm_result_make(PL_VM_FAULT, 0xffu);
}

static void x86_direct_complete_cut(X86Workspace *x86, u32 kind)
{
    if ((kind == PL_VM_DIRECT || kind == PL_VM_RESOLVE_RIP
            || kind == PL_VM_HALT || kind == PL_VM_TRANSITION)
            && x86->interrupt_shadow)
        x86->interrupt_shadow -= 1u;
}

/* Execute the Myhill-Nerode quotient directly.  A residual selects a
 * successor-free kernel; its returned arm selects one independently paged
 * edge.  Both possible edge pages are admitted before entering the kernel,
 * making every descriptor miss a precise pre-execution cut rather than a
 * replay of architectural effects.  Static edges never re-enter the RIP
 * entry map. */
EXPORT pl_vm_result vm_x86_execute_residual(
    u64 session, u32 residual, u32 max_blocks)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published || !max_blocks
            || !(x86->executable_root.residual_flags
                 & PL_EXECUTABLE_RESIDUAL_GRAPH)
            || residual >= x86->executable_root.residual_count) {
        x86_fail(48u);
        return pl_vm_result_make(PL_VM_FAULT, 0xffu);
    }
    x86->direct_blocks = 0u;
    x86->direct_residual = residual;
    if (x86->exception_pending)
        return x86_direct_deliver_fault(
            x86, pl_vm_result_make(
                PL_VM_FAULT, x86->exception_vector));
    if (x86->halted) return pl_vm_result_make(PL_VM_HALT, 0u);
    if (x86->physical_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->physical_status);
    if (x86->console_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->console_status);
    if (x86->clock_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->clock_status);
    if (x86->entropy_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->entropy_status);

    const u32 machine = (u32)(uptr)&x86->architectural;
    const u32 context = (u32)(uptr)&x86->executable;
    x86->direct_memory_result = 0u;
    while (x86->direct_blocks < max_blocks) {
        u32 instantiation = 0u, degree = 0u, edge_base = 0u;
        if (!x86_executable_residual_state_resident(
                x86, residual, &instantiation, &degree, &edge_base))
            return x86_residual_miss(
                residual / PL_RESIDUAL_STATE_PAGE_STATES, 0);
        /* An arm is not known until the kernel has executed.  Pin the at-most
         * two pages which could contain it before changing machine state. */
        if (degree
                && !x86_executable_residual_edge_page_resident(
                    x86, edge_base))
            return x86_residual_miss(
                edge_base / PL_RESIDUAL_EDGE_PAGE_EDGES, 1);
        if (degree > 1u
                && !x86_executable_residual_edge_page_resident(
                    x86, edge_base + degree - 1u))
            return x86_residual_miss(
                (edge_base + degree - 1u)
                    / PL_RESIDUAL_EDGE_PAGE_EDGES,
                1);
        u32 topology = 0u, first_parameter = 0u, parameter_count = 0u;
        if (!x86_executable_instantiation_resident(
                x86, instantiation, &topology,
                &first_parameter, &parameter_count))
            return x86_residual_miss(
                instantiation / PL_INSTANTIATION_PAGE_ROWS, 3u);
        if (parameter_count) {
            u32 first_page = first_parameter / PL_PARAMETER_PAGE_WORDS;
            u32 final_page = (first_parameter + parameter_count - 1u)
                           / PL_PARAMETER_PAGE_WORDS;
            if (!x86_executable_parameter_page_resident(x86, first_page))
                return x86_residual_miss(first_page, 4u);
            if (final_page != first_page
                    && !x86_executable_parameter_page_resident(
                        x86, final_page))
                return x86_residual_miss(final_page, 4u);
        }
        if (!x86_executable_materialize_parameters(
                x86, first_parameter, parameter_count)) {
            x86_fail(53u);
            return pl_vm_result_make(PL_VM_FAULT, 0xffu);
        }
        if (!x86_executable_kernel_resident(x86, topology))
            return x86_residual_miss(topology, 2u);

        x86->direct_function = topology;
        u32 table_slot = x86->executable.table_base + topology;
        pl_vm_block_function block = (pl_vm_block_function)(uptr)table_slot;
        pl_vm_result result = block(machine, context);
        x86->direct_blocks += 1u;
        u32 kind = pl_vm_result_kind(result);
        if (kind != PL_VM_TRANSITION) {
            if (kind > PL_VM_ENTRY_MAP) {
                x86_fail(49u);
                return pl_vm_result_make(PL_VM_FAULT, 0xffu);
            }
            if (kind == PL_VM_FAULT)
                return x86_direct_deliver_fault(x86, result);
            x86_direct_complete_cut(x86, kind);
            if (kind == PL_VM_HALT) x86->halted = 1u;
            return result;
        }
        x86_direct_complete_cut(x86, kind);
        u64 wide_arm = pl_vm_result_payload(result);
        if (wide_arm >= degree) {
            x86_fail(50u);
            return pl_vm_result_make(PL_VM_FAULT, 0xffu);
        }
        u32 next = 0u;
        i32 delta = 0;
        if (!x86_executable_residual_edge_resident(
                x86, edge_base + (u32)wide_arm, &next, &delta)) {
            x86_fail(51u);
            return pl_vm_result_make(PL_VM_FAULT, 0xffu);
        }
        x86->rip += (u64)(i64)delta;
        if (next == PL_RESIDUAL_RESOLVE)
            return pl_vm_result_make(PL_VM_RESOLVE_RIP, 0u);
        if (next >= x86->executable_root.residual_count) {
            x86_fail(52u);
            return pl_vm_result_make(PL_VM_FAULT, 0xffu);
        }
        residual = next;
        x86->direct_residual = residual;
        /* Port output is an architectural effect which has already retired.
         * Publish its host cut only after the successor is canonical, so an
         * acknowledgement can never replay the OUT instruction. */
        if (x86->console_status)
            return pl_vm_result_make(PL_VM_BARRIER, x86->console_status);
    }
    return pl_vm_direct(residual);
}

/* Chain compiler-emitted functions entirely inside vm.wasm.  Function ranks
 * in results are artifact-local; only this fixed runner adds the published
 * table base.  Returning PL_VM_DIRECT at the quantum cut preserves the next
 * rank without a RIP lookup or guest-instruction callback. */
EXPORT pl_vm_result vm_x86_execute_direct(u64 session, u32 function_rank,
                                          u32 max_blocks)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active || x86->error
            || !x86->executable_published || !max_blocks
            || function_rank >= x86->executable.function_count) {
        x86_fail(45u);
        return pl_vm_result_make(PL_VM_FAULT, 0xffu);
    }
    x86->direct_blocks = 0;
    x86->direct_function = function_rank;
    if (x86->exception_pending)
        return x86_direct_deliver_fault(
            x86, pl_vm_result_make(
                PL_VM_FAULT, x86->exception_vector));
    if (x86->halted) return pl_vm_result_make(PL_VM_HALT, 0u);
    if (x86->physical_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->physical_status);
    if (x86->console_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->console_status);
    if (x86->clock_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->clock_status);
    if (x86->entropy_status)
        return pl_vm_result_make(PL_VM_BARRIER, x86->entropy_status);

    const u32 machine = (u32)(uptr)&x86->architectural;
    const u32 context = (u32)(uptr)&x86->executable;
    x86->direct_memory_result = 0u;
    while (x86->direct_blocks < max_blocks) {
        u32 table_slot = x86->executable.table_base + function_rank;
        x86->direct_function = function_rank;
        pl_vm_block_function block = (pl_vm_block_function)(uptr)table_slot;
        pl_vm_result result = block(machine, context);
        x86->direct_blocks += 1u;
        u32 kind = pl_vm_result_kind(result);
        if (kind != PL_VM_DIRECT) {
            if (kind > PL_VM_ENTRY_MAP) {
                x86_fail(46u);
                return pl_vm_result_make(PL_VM_FAULT, 0xffu);
            }
            if (kind == PL_VM_FAULT)
                return x86_direct_deliver_fault(x86, result);
            x86_direct_complete_cut(x86, kind);
            if (kind == PL_VM_HALT) x86->halted = 1u;
            return result;
        }
        x86_direct_complete_cut(x86, kind);
        pl_u64 next = pl_vm_result_payload(result);
        if (next >= x86->executable.function_count) {
            x86_fail(47u);
            return pl_vm_result_make(PL_VM_FAULT, 0xffu);
        }
        function_rank = (u32)next;
        x86->direct_function = function_rank;
        if (x86->console_status)
            return pl_vm_result_make(PL_VM_BARRIER, x86->console_status);
    }
    return pl_vm_direct(function_rank);
}

EXPORT u32 vm_x86_direct_blocks(u64 session)
{
    return step_session_is(session) ? x86_machine()->direct_blocks : 0;
}

EXPORT u32 vm_x86_direct_function(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
         ? x86->direct_function : 0xffffffffu;
}

EXPORT u32 vm_x86_direct_residual(u64 session)
{
    X86Workspace *x86 = x86_machine();
    return step_session_is(session) && x86->executable_published
        && (x86->executable_root.residual_flags
            & PL_EXECUTABLE_RESIDUAL_GRAPH)
         ? x86->direct_residual : 0xffffffffu;
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
    return x86_supply_physical(session, lease, page, bytes);
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
    /* Legacy records historically resume on host input.  A direct executable
     * instead asks the C PIC for an enabled vector, so masked input cannot
     * wake HLT by merely crossing the JavaScript boundary. */
    if (!x86->executable_published) x86->halted = 0;
    return 1;
}

/* Admit one external scheduling event at a complete block cut.  The host
 * supplies only whether a timer edge occurred; IF, PIC masks, UART readiness,
 * vector choice and IDT delivery all remain canonical C machine state. */
EXPORT int vm_x86_interrupt_event(u64 session, u32 timer_ready)
{
    X86Workspace *x86 = x86_machine();
    if (!step_session_is(session) || !x86->active
            || !x86->executable_published || timer_ready > 1u
            || x86->interrupt_shadow || x86->exception_pending
            || x86->physical_status
            || x86->console_status || x86->clock_status
            || x86->entropy_status)
        return 0;
    u32 vector = x86_scheduling_interrupt(x86, timer_ready);
    if (!vector) return 0;
    if (vector == 0x3du) x86->ferr_pending = 0u;
    x86->halted = 0u;
    x86_direct_exception(x86, vector, 0u, 0u);
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
    if (reg >= X86_REGISTER_COUNT
            || (bits != 16u && bits != 32u && bits != 64u)
            || descriptor != (reg | (bits << 8u) | (source << 16u)))
        return 0;
    x86->registers[reg] = bits == 16u
        ? (x86->registers[reg] & ~0xffffull) | (value & 0xffffu)
        : bits == 32u ? (u32)value : value;
    x86->rflags = (x86->rflags & ~0x8d5ull) | 3u;
    if (x86->entropy_direct_request) {
        x86->entropy_direct_request = 0u;
        x86->entropy_direct_ready = 1u;
    } else {
        x86->rip = x86->control_argument[0];
    }
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

EXPORT u64 *vm_x86_x87_significand(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->x87_significand : (u64 *)0;
}

EXPORT pl_u16 *vm_x86_x87_sign_exponent(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->x87_sign_exponent : (pl_u16 *)0;
}

EXPORT pl_u16 *vm_x86_x87_environment(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? &x86_machine()->x87_control : (pl_u16 *)0;
}

EXPORT u64 *vm_x86_system(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->system : (u64 *)0;
}

EXPORT u32 vm_x86_exception_pending(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->exception_pending : 0u;
}

EXPORT u32 vm_x86_exception_vector(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->exception_vector : 0u;
}

EXPORT u32 vm_x86_exception_has_error(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->exception_has_error : 0u;
}

EXPORT u32 vm_x86_exception_error(u64 session)
{
    return step_session_is(session) && x86_machine()->active
         ? x86_machine()->exception_error : 0u;
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
 * by a typed parameter projection and a shared SSA template. Version four also
 * retains the template rank: the semantic class must not disappear between
 * post-link admission and execution. */
static int x86_load_block_record(
        u64 session, const u8 *record, u32 bytes, u32 from_cache)
{
    if (!step_session_is(session)) return STEP_TRAP;
    X86Workspace *x86 = x86_machine();
    StepWorkspace *step = step_machine();
    if (!x86->active || x86->halted || x86->error || x86->block_loaded
            || step->execution_active || step->memory_status
            || bytes > STEP_PAGE_BYTES
            || bytes < X86_BLOCK_HEADER_BYTES
            || record[0] != 'X' || record[1] != '8'
            || record[2] != '6' || record[3] != 'B'
            || load_u64(record + 8u) != x86->rip)
        return x86_fail(1u);
    u32 version = read_u16(record + 4u);
    u32 header_bytes = read_u16(record + 6u);
    if (version < 1u || version > 4u
            || header_bytes > bytes
            || (version == 4u
                ? header_bytes != X86_BLOCK_CLASS_HEADER_BYTES
                : version <= 2u
                  ? (header_bytes != X86_BLOCK_HEADER_BYTES
                     && header_bytes != X86_BLOCK_CLASS_HEADER_BYTES)
                  : header_bytes != X86_BLOCK_HEADER_BYTES))
        return x86_fail(1u);
    u64 boundary_rip = load_u64(record + 16u);
    u32 step_bytes = read_u32(record + 24u);
    u32 control = read_u32(record + 28u);
    u32 projected = version == 3u || version == 4u;
    u32 parameter_bytes = projected ? read_u32(record + 56u) : 0u;
    u32 template_bytes = projected ? read_u32(record + 60u) : step_bytes;
    u32 template_rank = header_bytes == X86_BLOCK_CLASS_HEADER_BYTES
                      ? read_u32(record + 64u) : 0u;
    if (!step_bytes || !template_bytes
            || (version == 4u && !template_rank)
            || template_bytes > bytes - header_bytes
            || parameter_bytes > bytes - header_bytes
                                  - template_bytes
            || control > X86_CONTROL_FPU_RESTORE)
        return x86_fail(2u);
    u32 guard_bytes = bytes - header_bytes
                    - parameter_bytes - template_bytes;
    u32 cached_slot = x86_block_cache_find(x86, x86->rip);
    if ((version == 1u && (guard_bytes || parameter_bytes))
            || (version == 2u && guard_bytes < 2u))
        return x86_fail(2u);
    if (version == 2u || (projected && guard_bytes)) {
        const u8 *guard = record + header_bytes;
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
                if (cached_slot < X86_BLOCK_CACHE_SLOTS)
                    x86_block_cache_invalidate(x86, cached_slot);
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
    u32 resident_bytes = header_bytes + guard_bytes + step_bytes;
    u32 resident_cached = from_cache
                       && cached_slot < X86_BLOCK_CACHE_SLOTS;
    u32 cacheable = x86_block_cache_size_class(resident_bytes)
                  < X86_BLOCK_CACHE_CLASSES;
    u32 cache_slot = cached_slot < X86_BLOCK_CACHE_SLOTS
                   ? cached_slot : x86_block_cache_choose(x86, x86->rip);
    u8 *cached_record = 0;
    if (cacheable && x86_block_cache_reserve(
            x86, cache_slot, resident_bytes)) {
        cached_record = x86_block_cache_data(x86, cache_slot);
        if (!resident_cached) {
            for (u32 index = 0;
                 index < header_bytes + guard_bytes; ++index)
                cached_record[index] = record[index];
            if (projected) {
                cached_record[4] = guard_bytes ? 2u : 1u;
                cached_record[5] = 0u;
                for (u32 index = 56u; index < X86_BLOCK_HEADER_BYTES;
                     ++index)
                    cached_record[index] = 0u;
            }
        }
    } else {
        cacheable = 0;
        if (cached_slot < X86_BLOCK_CACHE_SLOTS)
            x86_block_cache_invalidate(x86, cached_slot);
    }
    /* NEXT and TIMESLICE use the boundary coordinate without duplicating it
     * in the control argument columns. */
    if (control == X86_CONTROL_NEXT || control == X86_CONTROL_TIMESLICE)
        x86->control_argument[0] = boundary_rip;
    u32 step_offset = header_bytes + guard_bytes + parameter_bytes;
    if (projected) {
        u32 projection_bytes = parameter_bytes + template_bytes;
        u32 projection_source = header_bytes + guard_bytes;
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
        step->execution_page = step->page;
    } else if (resident_cached) {
        step->execution_page = record + step_offset;
    } else {
        for (u32 index = 0; index < step_bytes; ++index)
            step->page[index] = step->page[step_offset + index];
        step->execution_page = step->page;
    }
    int step_opened = resident_cached
                    ? x86_block_cache_restore_step(
                        x86, cache_slot, step, step_bytes)
                    : step_open_class(session, step_bytes, template_rank);
    if (!step_opened
            || step->local_extent < X86_REGISTER_COUNT + 1u)
        return x86_fail(3u);
    if (cacheable && !resident_cached) {
        /* step_open_class specializes generic projection tags in-place.  The
         * resident record must retain that concrete execution shape instead
         * of the pre-specialization delivery bytes. */
        for (u32 index = 0; index < step_bytes; ++index)
            cached_record[header_bytes + guard_bytes + index] =
                step->page[index];
        x86_block_cache_capture_step(x86, cache_slot, step);
    }
    for (u32 index = X86_REGISTER_COUNT + 1u;
         index < step->local_extent; ++index)
        step->locals[index] = 0;
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
        u32 single = (descriptor >> 16u) & 1u;
        if (vector >= 16u || low < X86_REGISTER_COUNT + 1u
                || low >= step->local_extent
                || (single && descriptor != (low | (1u << 16u)))
                || (!single && (high != low + 1u
                    || high >= step->local_extent
                    || descriptor != (low | (high << 8u)))))
            return x86_fail(44u);
        step->locals[low] = x86->xmm[vector * 2u];
        if (!single)
            step->locals[high] = x86->xmm[vector * 2u + 1u];
    }
    if (control == X86_CONTROL_FPU_SAVE) {
        u32 first = (u32)x86->control_argument[1];
        if (x86->control_argument[1] != first
                || x86->control_argument[2]
                || first < X86_REGISTER_COUNT + 1u
                || first + 32u > step->local_extent)
            return x86_fail(54u);
        for (u32 lane = 0; lane < 32u; ++lane)
            step->locals[first + lane] = x86->xmm[lane];
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
        x86_block_cache_touch(x86, cache_slot);
    }
    x86->block_loaded = 1;
    return STEP_OK;
}

EXPORT int vm_x86_load_block(u64 session, u32 bytes)
{
    return x86_load_block_record(
        session, step_machine()->page, bytes, 0u);
}

/* Exact-tagged set-associative cache. The full RIP proves identity; a set
 * collision can only replace an old entry and never alias guest code. */
EXPORT int vm_x86_load_cached_block(u64 session)
{
    if (!step_session_is(session)) return STEP_TRAP;
    X86Workspace *x86 = x86_machine();
    if (!x86->active || x86->halted || x86->error || x86->block_loaded)
        return STEP_TRAP;
    u32 slot = x86_block_cache_find(x86, x86->rip);
    if (slot >= X86_BLOCK_CACHE_SLOTS) return 0;
    x86_block_cache_touch(x86, slot);
    u32 bytes = x86->block_cache_bytes[slot];
    if (bytes < X86_BLOCK_HEADER_BYTES
            || x86_block_cache_size_class(bytes)
                    != x86->block_cache_class[slot])
        return x86_fail(36u);
    u8 *cached_record = x86_block_cache_data(x86, slot);
    int loaded = x86_load_block_record(
        session, cached_record, bytes, 1u);
    if (loaded == X86_CODE_MISMATCH)
        x86_block_cache_invalidate(x86, slot);
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
        u32 eax, ebx, ecx, edx;
        x86_cpuid_model(leaf, subleaf, &eax, &ebx, &ecx, &edx);
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
        if (reg >= X86_REGISTER_COUNT
                || (bits != 16u && bits != 32u && bits != 64u)
                || descriptor != (reg | (bits << 8u) | (source << 16u)))
            return x86_fail(41u);
        x86->entropy_direct_request = 0u;
        x86->entropy_direct_ready = 0u;
        x86->entropy_direct_descriptor = 0u;
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
        if (!x86_swap_gs_bases())
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
        u32 memory = (descriptor >> 16u) & 1u;
        if (vector >= 16u || source >= step->local_extent
                || (memory && source < X86_REGISTER_COUNT + 1u)
                || (!memory && source >= X86_REGISTER_COUNT)
                || descriptor != (vector | (source << 8u)
                                   | (memory << 16u)))
            return x86_fail(45u);
        x86->xmm[vector * 2u] = memory
            ? step->locals[source] : x86->registers[source];
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
        u32 vector_descriptor = (u32)x86->control_argument[1];
        u32 descriptor = (u32)x86->control_argument[2];
        u32 low = descriptor & 0xffu;
        u32 high = (descriptor >> 8u) & 0xffu;
        u32 single = (descriptor >> 16u) & 1u;
        u32 width32 = (descriptor >> 17u) & 1u;
        u32 vector = vector_descriptor & 0xffu;
        u32 lane = (vector_descriptor >> 8u) & 1u;
        if (vector >= 16u || low < X86_REGISTER_COUNT + 1u
                || low >= step->local_extent
                || (single && (descriptor != (low | (1u << 16u)
                    | (width32 << 17u))
                    || vector_descriptor != (vector | (lane << 8u))))
                || (!single && (lane || high != low + 1u
                    || high >= step->local_extent
                    || descriptor != (low | (high << 8u)))))
            return x86_fail(49u);
        if (single) {
            if (width32) {
                if (lane) return x86_fail(49u);
                x86->xmm[vector * 2u] = (u32)step->locals[low];
                x86->xmm[vector * 2u + 1u] = 0;
            } else {
                x86->xmm[vector * 2u + lane] = step->locals[low];
            }
        } else {
            x86->xmm[vector * 2u] = step->locals[low];
            x86->xmm[vector * 2u + 1u] = step->locals[high];
        }
    } else if (x86->control == X86_CONTROL_SIMD_REGISTER) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 opcode = descriptor & 0xffu;
        u32 target = (descriptor >> 8u) & 0xffu;
        u32 source = (descriptor >> 16u) & 0xffu;
        u32 immediate = (u32)x86->control_argument[2];
        u32 memory = (immediate >> 8u) & 1u;
        if (target >= 16u || source >= step->local_extent || opcode > 15u
                || (memory
                    && ((opcode != 11u && opcode != 12u && opcode != 13u
                         && opcode != 14u && opcode != 15u)
                        || source < X86_REGISTER_COUNT + 1u
                        || source + 1u >= step->local_extent
                        || ((opcode == 11u || opcode == 12u || opcode == 14u
                             || opcode == 15u)
                            && immediate != 256u)
                        || (opcode == 13u
                            && (immediate < 256u || immediate >= 512u))))
                || (!memory
                    && (source >= 16u
                        || ((opcode == 1u || opcode == 5u
                             || opcode == 10u || opcode == 13u)
                            ? immediate >= 256u : immediate)))
                || descriptor != (opcode | (target << 8u)
                                   | (source << 16u)))
            return x86_fail(50u);
        if (opcode == 0u) {
            x86->xmm[target * 2u] = x86->xmm[source * 2u];
            x86->xmm[target * 2u + 1u] = x86->xmm[source * 2u + 1u];
        } else if (opcode == 1u) {
            u32 bytes = immediate > 16u ? 16u : immediate;
            u32 bits = bytes * 8u;
            u64 low = x86->xmm[target * 2u];
            u64 high = x86->xmm[target * 2u + 1u];
            if (!bits) {
                /* Identity shift. */
            } else if (bits < 64u) {
                low = (low >> bits) | (high << (64u - bits));
                high >>= bits;
            } else if (bits == 64u) {
                low = high;
                high = 0;
            } else if (bits < 128u) {
                low = high >> (bits - 64u);
                high = 0;
            } else {
                low = 0;
                high = 0;
            }
            x86->xmm[target * 2u] = low;
            x86->xmm[target * 2u + 1u] = high;
        } else if (opcode == 2u) {
            x86->xmm[target * 2u] |= x86->xmm[source * 2u];
            x86->xmm[target * 2u + 1u] |= x86->xmm[source * 2u + 1u];
        } else if (opcode == 3u) {
            x86->registers[target] = x86->xmm[source * 2u];
        } else if (opcode == 4u) {
            x86->xmm[target * 2u] = (u32)x86->registers[source];
            x86->xmm[target * 2u + 1u] = 0;
        } else if (opcode == 5u) {
            u64 low = x86->xmm[source * 2u];
            u64 shuffled = 0;
            for (u32 lane = 0; lane < 4u; ++lane) {
                u32 selected = (immediate >> (lane * 2u)) & 3u;
                shuffled |= ((low >> (selected * 16u)) & 0xffffu)
                         << (lane * 16u);
            }
            x86->xmm[target * 2u] = shuffled;
            x86->xmm[target * 2u + 1u] = x86->xmm[source * 2u + 1u];
        } else if (opcode == 6u) {
            x86->registers[target] = (u32)x86->xmm[source * 2u];
        } else if (opcode == 7u || opcode == 8u) {
            u64 left[2] = {x86->xmm[target * 2u],
                           x86->xmm[target * 2u + 1u]};
            u64 right[2] = {x86->xmm[source * 2u],
                            x86->xmm[source * 2u + 1u]};
            u64 result[2] = {0, 0};
            for (u32 lane = 0; lane < 8u; ++lane) {
                u32 shift = (lane & 3u) * 16u;
                u32 a = (u32)(left[lane >> 2u] >> shift) & 0xffffu;
                u32 b = (u32)(right[lane >> 2u] >> shift) & 0xffffu;
                u32 word = opcode == 7u ? a - b : a + b;
                result[lane >> 2u] |= (u64)(word & 0xffffu) << shift;
            }
            x86->xmm[target * 2u] = result[0];
            x86->xmm[target * 2u + 1u] = result[1];
        } else if (opcode == 9u) {
            u64 left = x86->xmm[target * 2u];
            u64 right = x86->xmm[source * 2u];
            u64 result[2] = {0, 0};
            for (u32 lane = 0; lane < 4u; ++lane) {
                u32 shift = (lane & 1u) * 32u;
                result[lane >> 1u] |= ((left >> (lane * 16u)) & 0xffffu)
                                      << shift;
                result[lane >> 1u] |= ((right >> (lane * 16u)) & 0xffffu)
                                      << (shift + 16u);
            }
            x86->xmm[target * 2u] = result[0];
            x86->xmm[target * 2u + 1u] = result[1];
        } else if (opcode == 10u) {
            u32 shift = (immediate & 7u) * 16u;
            u64 word = shift < 64u
                ? x86->xmm[source * 2u] >> shift
                : x86->xmm[source * 2u + 1u] >> (shift - 64u);
            x86->registers[target] = (u32)word & 0xffffu;
        } else if (opcode == 11u) {
            u64 right[2] = {
                memory ? step->locals[source] : x86->xmm[source * 2u],
                memory ? step->locals[source + 1u]
                       : x86->xmm[source * 2u + 1u],
            };
            u64 result[2] = {0, 0};
            for (u32 lane = 0; lane < 4u; ++lane) {
                u32 shift = (lane & 1u) * 32u;
                u32 left = (u32)(x86->xmm[target * 2u + (lane >> 1u)]
                                 >> shift);
                u32 value = (u32)(right[lane >> 1u] >> shift);
                if (left == value)
                    result[lane >> 1u] |= (u64)0xffffffffu << shift;
            }
            x86->xmm[target * 2u] = result[0];
            x86->xmm[target * 2u + 1u] = result[1];
        } else if (opcode == 12u) {
            u64 left = x86->xmm[target * 2u];
            u64 right = memory
                ? step->locals[source]
                : x86->xmm[source * 2u];
            x86->xmm[target * 2u] = (left & 0xffffffffull)
                | ((right & 0xffffffffull) << 32u);
            x86->xmm[target * 2u + 1u] = ((left >> 32u) & 0xffffffffull)
                | (((right >> 32u) & 0xffffffffull) << 32u);
        } else if (opcode == 13u) {
            u64 input[2] = {
                memory ? step->locals[source] : x86->xmm[source * 2u],
                memory ? step->locals[source + 1u]
                       : x86->xmm[source * 2u + 1u],
            };
            u64 result[2] = {0, 0};
            for (u32 lane = 0; lane < 4u; ++lane) {
                u32 selected = (immediate >> (lane * 2u)) & 3u;
                u32 selected_shift = (selected & 1u) * 32u;
                u32 output_shift = (lane & 1u) * 32u;
                u32 value = (u32)(input[selected >> 1u] >> selected_shift);
                result[lane >> 1u] |= (u64)value << output_shift;
            }
            x86->xmm[target * 2u] = result[0];
            x86->xmm[target * 2u + 1u] = result[1];
        } else if (opcode == 14u) {
            u64 right_low = memory
                ? step->locals[source] : x86->xmm[source * 2u];
            u64 right_high = memory
                ? step->locals[source + 1u]
                : x86->xmm[source * 2u + 1u];
            x86->xmm[target * 2u] += right_low;
            x86->xmm[target * 2u + 1u] += right_high;
        } else {
            u64 right_low = memory
                ? step->locals[source] : x86->xmm[source * 2u];
            u64 right_high = memory
                ? step->locals[source + 1u]
                : x86->xmm[source * 2u + 1u];
            x86->xmm[target * 2u] &= right_low;
            x86->xmm[target * 2u + 1u] &= right_high;
        }
    } else if (x86->control == X86_CONTROL_SIMD_COMPARE) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 vector = descriptor & 0xffu;
        u32 source = (descriptor >> 8u) & 0xffu;
        u32 memory = (descriptor >> 16u) & 1u;
        if (vector >= 16u || source >= step->local_extent
                || (memory && source < X86_REGISTER_COUNT + 1u)
                || (!memory && source >= 16u)
                || descriptor != (vector | (source << 8u)
                                   | (memory << 16u)))
            return x86_fail(51u);
        union { u64 bits; double value; } left, right;
        left.bits = x86->xmm[vector * 2u];
        right.bits = memory
            ? step->locals[source] : x86->xmm[source * 2u];
        u64 flags = x86->rflags
                  & ~((1u << 0u) | (1u << 2u) | (1u << 4u)
                      | (1u << 6u) | (1u << 7u) | (1u << 11u));
        if (left.value != left.value || right.value != right.value)
            flags |= (1u << 0u) | (1u << 2u) | (1u << 6u);
        else if (left.value == right.value)
            flags |= 1u << 6u;
        else if (left.value < right.value)
            flags |= 1u << 0u;
        x86->rflags = flags | 2u;
    } else if (x86->control == X86_CONTROL_SIMD_CONVERT) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 vector = descriptor & 0xffu;
        u32 source = (descriptor >> 8u) & 0xffu;
        u32 memory = (descriptor >> 16u) & 1u;
        u32 wide = (descriptor >> 17u) & 1u;
        u32 truncate = (descriptor >> 18u) & 1u;
        if (vector >= 16u || source >= step->local_extent
                || (memory && source < X86_REGISTER_COUNT + 1u)
                || (!memory && source >= X86_REGISTER_COUNT)
                || descriptor != (vector | (source << 8u)
                                   | (memory << 16u) | (wide << 17u)
                                   | (truncate << 18u)))
            return x86_fail(52u);
        if (!truncate) {
            u64 value = memory
                ? step->locals[source] : x86->registers[source];
            union { u64 bits; double value; } converted;
            converted.value = wide ? (double)(i64)value
                                   : (double)(i32)(u32)value;
            x86->xmm[vector * 2u] = converted.bits;
        } else {
            union { u64 bits; double value; } converted;
            converted.bits = memory
                ? step->locals[source] : x86->xmm[source * 2u];
            u64 value;
            if (converted.value != converted.value
                    || (wide && (converted.value < -9223372036854775808.0
                                 || converted.value >= 9223372036854775808.0))
                    || (!wide && (converted.value < -2147483648.0
                                  || converted.value >= 2147483648.0))) {
                value = wide ? (1ull << 63u) : (1u << 31u);
            } else {
                value = wide ? (u64)(i64)converted.value
                             : (u32)(i32)converted.value;
            }
            x86->registers[vector] = wide ? value : (u32)value;
        }
    } else if (x86->control == X86_CONTROL_SIMD_SCALAR) {
        u32 descriptor = (u32)x86->control_argument[1];
        u32 operation = descriptor & 0xffu;
        u32 vector = (descriptor >> 8u) & 0xffu;
        u32 source = (descriptor >> 16u) & 0xffu;
        u32 memory = (descriptor >> 24u) & 1u;
        if (operation > 3u || vector >= 16u
                || source >= step->local_extent
                || (memory && source < X86_REGISTER_COUNT + 1u)
                || (!memory && source >= 16u)
                || descriptor != (operation | (vector << 8u)
                                   | (source << 16u) | (memory << 24u)))
            return x86_fail(53u);
        union { u64 bits; double value; } left, right;
        left.bits = x86->xmm[vector * 2u];
        right.bits = memory
            ? step->locals[source] : x86->xmm[source * 2u];
        if (operation == 0u) left.value += right.value;
        else if (operation == 1u) left.value *= right.value;
        else if (operation == 2u) left.value -= right.value;
        else left.value /= right.value;
        x86->xmm[vector * 2u] = left.bits;
    } else if (x86->control == X86_CONTROL_FPU_SAVE) {
        /* The resident XMM lanes were injected before the memory STEP. */
    } else if (x86->control == X86_CONTROL_FPU_RESTORE) {
        u32 first = (u32)x86->control_argument[1];
        if (x86->control_argument[1] != first
                || x86->control_argument[2]
                || first < X86_REGISTER_COUNT + 1u
                || first + 32u > step->local_extent)
            return x86_fail(54u);
        for (u32 lane = 0; lane < 32u; ++lane)
            x86->xmm[lane] = step->locals[first + lane];
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
        if (had_block && !x86->block_loaded) {
            /* Internal prefix/retry records are one architectural state-step.
             * Their source retirement still advances the PIT even though the
             * host-visible block count is published only at the final cut. */
            /* The PIT advances independently of IF.  IF only gates delivery;
             * otherwise fusing an interrupt-disabled prefix with IRET would
             * change time merely by changing the state-step quotient. */
            if (!(x86->pic_mask[0] & 1u)) {
                u64 source = x86->retired - retired_before;
                if (source > 4096u) source = 4096u;
                source += x86->timer_source_instructions;
                x86->timer_source_instructions = source >= 4096u
                                                ? 4096u : (u32)source;
            }
            if (status != X86_INTERNAL) x86->quantum_blocks += 1u;
        }
        /* A timer cut belongs to the persistent machine, not to a particular
         * decoded block.  Otherwise quotienting a polling loop into one
         * recurrence can accidentally remove the only point at which IRQ0
         * becomes observable. */
        u32 vector = x86_scheduling_interrupt(
            x86, x86->timer_source_instructions >= 4096u);
        if (status != X86_INTERNAL && vector
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
