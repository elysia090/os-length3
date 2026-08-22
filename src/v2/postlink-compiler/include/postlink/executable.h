/* Direct executable output of the post-link compiler.
 *
 * A linked x86 image is the source identity.  The compiler emits Wasm block
 * functions and one total page-dispatch projection for every executable page.
 * The VM never decodes x86 or interprets an intermediate instruction record;
 * it binds an authenticated page generation to a function rank and calls it.
 *
 * The binary layout described here is a small manifest.  Ordinary Wasm
 * modules and immutable physical-memory objects are independent
 * content-addressed resources named by their rows; their bytes are never
 * concatenated into this root.  It is not a bytecode.  Module functions are
 * installed into the VM's shared function table and are called directly with
 * the ABI below.
 */

#ifndef POSTLINK_EXECUTABLE_H
#define POSTLINK_EXECUTABLE_H

#include <postlink/index.h>
#include <postlink/instantiation.h>

#define PL_EXECUTABLE_MAGIC "postlink-executable-v5\n"
#define PL_EXECUTABLE_MAGIC_BYTES 32u
#define PL_EXECUTABLE_VERSION 5u
#define PL_EXECUTABLE_HEADER_BYTES 1696u
#define PL_EXECUTABLE_BINDING_BYTES 72u
#define PL_EXECUTABLE_MODULE_BYTES 64u
#define PL_EXECUTABLE_RESOURCE_BYTES 80u

#define PL_VM_ABI_VERSION 1u
#define PL_EXECUTABLE_PAGE_BYTES 4096u
#define PL_EXECUTABLE_DIGEST_BYTES 32u
#define PL_EXECUTABLE_DIGEST_SHA256 1u

/* Every byte coordinate in an executable page has a defined result: a block
 * function or an architectural fault.  A generation is unpublished before
 * its bytes may change, so a direct chain never observes stale code. */
#define PL_EXECUTABLE_FLAG_TOTAL_COORDINATES 1u
#define PL_EXECUTABLE_FLAG_GENERATION_GUARDED 2u
#define PL_EXECUTABLE_REQUIRED_FLAGS                                   \
    (PL_EXECUTABLE_FLAG_TOTAL_COORDINATES                              \
     | PL_EXECUTABLE_FLAG_GENERATION_GUARDED)

#define PL_EXECUTABLE_MODULE_WASM32 1u
#define PL_EXECUTABLE_SOURCE_DERIVED (~(pl_u64)0)

/* Fixed header offsets. */
#define PL_EXECUTABLE_OFF_MAGIC 0u
#define PL_EXECUTABLE_OFF_VERSION 32u
#define PL_EXECUTABLE_OFF_HEADER_BYTES 36u
#define PL_EXECUTABLE_OFF_ABI_VERSION 40u
#define PL_EXECUTABLE_OFF_PAGE_BYTES 44u
#define PL_EXECUTABLE_OFF_DIGEST_ALGORITHM 48u
#define PL_EXECUTABLE_OFF_FLAGS 52u
#define PL_EXECUTABLE_OFF_ENTRY_RIP 56u
#define PL_EXECUTABLE_OFF_ENTRY_GENERATION 64u
#define PL_EXECUTABLE_OFF_ENTRY_FUNCTION 72u
#define PL_EXECUTABLE_OFF_FUNCTION_COUNT 76u
#define PL_EXECUTABLE_OFF_SOURCE_BYTES 80u
#define PL_EXECUTABLE_OFF_SOURCE_DIGEST 88u
#define PL_EXECUTABLE_OFF_MEMORY_BYTES 120u
#define PL_EXECUTABLE_OFF_EXTERNAL_BYTES 128u
#define PL_EXECUTABLE_OFF_BINDING_INDEX 136u
#define PL_EXECUTABLE_OFF_MODULE_INDEX 224u
#define PL_EXECUTABLE_OFF_RESOURCE_INDEX 312u
#define PL_EXECUTABLE_OFF_ENTRY_PAGE_COUNT 400u
#define PL_EXECUTABLE_OFF_ENTRY_TAIL_ROW_COUNT 404u
#define PL_EXECUTABLE_OFF_RESIDUAL_COUNT 408u
#define PL_EXECUTABLE_OFF_RESIDUAL_EDGE_COUNT 412u
#define PL_EXECUTABLE_OFF_STATE 416u
#define PL_EXECUTABLE_STATE_BYTES 1256u
#define PL_EXECUTABLE_OFF_FILE_BYTES 1672u
#define PL_EXECUTABLE_OFF_ENTRY_RESIDUAL 1680u
#define PL_EXECUTABLE_OFF_RESIDUAL_FLAGS 1684u
#define PL_EXECUTABLE_OFF_INSTANTIATION_COUNT 1688u
#define PL_EXECUTABLE_OFF_PARAMETER_WORD_COUNT 1692u

#define PL_EXECUTABLE_RESIDUAL_GRAPH 1u

#define PL_VM_X86_REGISTER_COUNT 16u
#define PL_VM_X86_XMM_WORDS 32u
#define PL_VM_X86_X87_REGISTERS 8u
#define PL_VM_X86_SYSTEM_WORDS 22u
#define PL_VM_X86_MSR_WORDS 32u
#define PL_VM_X86_RFLAGS_LOCAL 16u
#define PL_VM_X86_FS_BASE_LOCAL 17u
#define PL_VM_X86_GS_BASE_LOCAL 18u
#define PL_VM_X86_ARCH_LOCAL_COUNT 19u

/* Canonical initial architectural cut embedded in the fixed root.  It has no
 * native pointer and no host-dependent padding.  Unused MSR rows are zero,
 * making one byte string the only spelling of a machine state. */
#define PL_EXECUTABLE_STATE_OFF_REGISTERS 0u
#define PL_EXECUTABLE_STATE_OFF_XMM 128u
#define PL_EXECUTABLE_STATE_OFF_RIP 384u
#define PL_EXECUTABLE_STATE_OFF_RFLAGS 392u
#define PL_EXECUTABLE_STATE_OFF_CR0 400u
#define PL_EXECUTABLE_STATE_OFF_CR3 408u
#define PL_EXECUTABLE_STATE_OFF_CR4 416u
#define PL_EXECUTABLE_STATE_OFF_EFER 424u
#define PL_EXECUTABLE_STATE_OFF_SYSTEM 432u
#define PL_EXECUTABLE_STATE_OFF_MSR_COUNT 608u
#define PL_EXECUTABLE_STATE_OFF_MXCSR 612u
#define PL_EXECUTABLE_STATE_OFF_MSR_KEYS 616u
#define PL_EXECUTABLE_STATE_OFF_MSR_VALUES 872u
#define PL_EXECUTABLE_STATE_OFF_RETIRED 1128u
#define PL_EXECUTABLE_STATE_OFF_WORK 1136u
#define PL_EXECUTABLE_STATE_OFF_SPAN 1144u
#define PL_EXECUTABLE_STATE_OFF_X87_SIGNIFICAND 1152u
#define PL_EXECUTABLE_STATE_OFF_X87_SIGN_EXPONENT 1216u
#define PL_EXECUTABLE_STATE_OFF_X87_CONTROL 1232u
#define PL_EXECUTABLE_STATE_OFF_X87_STATUS 1234u
#define PL_EXECUTABLE_STATE_OFF_X87_TAG 1236u
#define PL_EXECUTABLE_STATE_OFF_X87_OPCODE 1238u
#define PL_EXECUTABLE_STATE_OFF_X87_IP 1240u
#define PL_EXECUTABLE_STATE_OFF_X87_DP 1248u

typedef struct {
    pl_u64 registers[PL_VM_X86_REGISTER_COUNT];
    pl_u64 xmm[PL_VM_X86_XMM_WORDS];
    pl_u64 rip;
    pl_u64 rflags;
    pl_u64 cr0;
    pl_u64 cr3;
    pl_u64 cr4;
    pl_u64 efer;
    pl_u64 system[PL_VM_X86_SYSTEM_WORDS];
    pl_u32 msr_count;
    pl_u32 mxcsr;
    pl_u64 msr_keys[PL_VM_X86_MSR_WORDS];
    pl_u64 msr_values[PL_VM_X86_MSR_WORDS];
    pl_u64 retired;
    pl_u64 work;
    pl_u64 span;
    pl_u64 x87_significand[PL_VM_X86_X87_REGISTERS];
    pl_u16 x87_sign_exponent[PL_VM_X86_X87_REGISTERS];
    pl_u16 x87_control;
    pl_u16 x87_status;
    pl_u16 x87_tag;
    pl_u16 x87_opcode;
    pl_u64 x87_ip;
    pl_u64 x87_dp;
} pl_executable_state;

/* One executable physical page.  `dispatch_function` is artifact-local; the
 * loader adds the executable's table base.  The dispatch function is total on
 * the page offset and returns either a direct block rank or an x86 fault.
 *
 * Dispatch functions may be quotient-shared.  `dispatch_argument` names the
 * page's access-map rank, so the function resolves a page offset without a
 * per-coordinate block row.  `source_offset` identifies the corresponding
 * bytes in the linked image.  Runtime-generated text uses
 * PL_EXECUTABLE_SOURCE_DERIVED and is bound only by its full-page digest and
 * generation. */
typedef struct {
    pl_u64 virtual_page;
    pl_u64 generation;
    pl_u64 source_offset;
    pl_u32 source_bytes;
    pl_u32 dispatch_function;
    pl_u32 dispatch_argument;
    pl_u32 reserved;
    pl_u8 digest[PL_EXECUTABLE_DIGEST_BYTES];
} pl_executable_binding;

/* A directly instantiated Wasm module stored as an independent immutable
 * object.  Function ranks form one dense range over all modules.  The digest
 * and exact extent are its identity coordinates; no delivery offset enters
 * the executable root. */
typedef struct {
    pl_u64 first_function;
    pl_u64 key_minor;
    pl_u64 payload_bytes;
    pl_u32 function_count;
    pl_u32 flags;
    pl_u8 digest[PL_EXECUTABLE_DIGEST_BYTES];
} pl_executable_module;

/* An independently delivered immutable physical-memory object.  The one
 * MEMORY_BASE row is a zero-default sparse address space.  Each MEMORY_EXTENT
 * row overlays one physical page of a cold object such as the read-only
 * SquashFS image.  Consecutive pages remain separate identities, so touching
 * one page never authenticates or retains the rest of the filesystem.  The
 * root binds only canonical identity and guest coordinates: compression,
 * shard size, CDN locator and delivery offsets never enter this row.
 *
 * `object_bytes` is the canonical object's exact extent. `mapped_bytes` is
 * page-rounded and may add only implicit trailing zeros. */
#define PL_EXECUTABLE_RESOURCE_MEMORY_BASE   1u
#define PL_EXECUTABLE_RESOURCE_MEMORY_EXTENT 2u
#define PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS 3u
#define PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW  4u
#define PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE 5u
#define PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE  6u
#define PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE  7u
#define PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE      8u
#define PL_EXECUTABLE_RESOURCE_READ_ONLY     1u
#define PL_EXECUTABLE_RESOURCE_SPARSE        2u
#define PL_EXECUTABLE_RESOURCE_FLAGS                              \
    (PL_EXECUTABLE_RESOURCE_READ_ONLY | PL_EXECUTABLE_RESOURCE_SPARSE)

#define PL_EXECUTABLE_RESOURCE_PROJECTION_RANK_MASK 0x1fffffffffffffffull
#define PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_BASE 0x4000000000000000ull
#define PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_BASE  0x6000000000000000ull
#define PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_BASE 0x8000000000000000ull
#define PL_EXECUTABLE_RESOURCE_INSTANTIATION_BASE 0xa000000000000000ull
#define PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_BASE 0xc000000000000000ull
#define PL_EXECUTABLE_RESOURCE_PARAMETER_BASE 0x2000000000000000ull
#define PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES 64u
#define PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES 1024u

static inline pl_u64 pl_executable_entry_page_key(pl_u32 rank)
{
    return PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_BASE | (pl_u64)rank;
}

static inline pl_u64 pl_executable_residual_state_key(pl_u32 rank)
{
    return PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_BASE | (pl_u64)rank;
}

static inline pl_u64 pl_executable_residual_edge_key(pl_u32 rank)
{
    return PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_BASE | (pl_u64)rank;
}

static inline pl_u64 pl_executable_entry_tail_key(pl_u32 rank)
{
    return PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_BASE | (pl_u64)rank;
}

static inline pl_u64 pl_executable_instantiation_key(pl_u32 rank)
{
    return PL_EXECUTABLE_RESOURCE_INSTANTIATION_BASE | (pl_u64)rank;
}

static inline pl_u64 pl_executable_parameter_key(pl_u32 rank)
{
    return PL_EXECUTABLE_RESOURCE_PARAMETER_BASE | (pl_u64)rank;
}

typedef struct {
    pl_u64 physical_address;
    pl_u64 key_minor;
    pl_u64 object_bytes;
    pl_u64 mapped_bytes;
    pl_u32 page_bytes;
    pl_u32 kind;
    pl_u32 flags;
    /* Authenticated page-local input to a projection codec.  Instantiation
     * pages bind their first parameter rank here; all other kinds use zero. */
    pl_u32 projection_argument;
    pl_u8 digest[PL_EXECUTABLE_DIGEST_BYTES];
} pl_executable_resource;

typedef struct {
    pl_u64 entry_rip;
    pl_u64 entry_generation;
    pl_u32 entry_function;
    pl_u32 function_count;
    pl_u64 source_bytes;
    pl_u8 source_digest[PL_EXECUTABLE_DIGEST_BYTES];
    pl_u64 memory_bytes;
    pl_u64 external_bytes;
    pl_u32 entry_page_count;
    pl_u32 entry_tail_row_count;
    pl_u32 residual_count;
    pl_u32 residual_edge_count;
    pl_u32 entry_residual;
    pl_u32 residual_flags;
    pl_u32 instantiation_count;
    pl_u32 parameter_word_count;
    pl_executable_state state;
    pl_index_ref bindings;
    pl_index_ref modules;
    pl_index_ref resources;
} pl_executable;

/* Caller-owned input to the fixed canonical writer.  The three index roots
 * authenticate all cold rows without embedding or traversing them here. */
typedef struct {
    pl_u64 entry_rip;
    pl_u64 entry_generation;
    pl_u32 entry_function;
    pl_u32 function_count;
    pl_u64 source_bytes;
    const pl_u8 *source_digest;
    pl_u64 memory_bytes;
    pl_u64 external_bytes;
    pl_u32 entry_page_count;
    pl_u32 entry_tail_row_count;
    pl_u32 residual_count;
    pl_u32 residual_edge_count;
    pl_u32 entry_residual;
    pl_u32 residual_flags;
    pl_u32 instantiation_count;
    pl_u32 parameter_word_count;
    const pl_executable_state *state;
    const pl_index_ref *bindings;
    const pl_index_ref *modules;
    const pl_index_ref *resources;
} pl_executable_spec;

#define PL_ERROR_EXECUTABLE         (-22)
#define PL_ERROR_EXECUTABLE_RANGE   (-23)
#define PL_ERROR_EXECUTABLE_BINDING (-24)
#define PL_ERROR_EXECUTABLE_MODULE  (-25)
#define PL_ERROR_EXECUTABLE_ABI     (-26)
#define PL_ERROR_EXECUTABLE_ABSENT  (-27)
#define PL_ERROR_EXECUTABLE_RESOURCE (-32)

/* Parse and structurally verify the fixed compiler root. */
int pl_executable_open(const pl_u8 *bytes, pl_u64 length,
                       pl_executable *out);

int pl_executable_state_read(
    const pl_u8 bytes[PL_EXECUTABLE_STATE_BYTES],
    pl_executable_state *out);
int pl_executable_state_write(
    const pl_executable_state *state,
    pl_u8 bytes[PL_EXECUTABLE_STATE_BYTES]);

/* Leaf row codecs keep key layout and validation in C. */
int pl_executable_binding_read(const pl_u8 row[PL_EXECUTABLE_BINDING_BYTES],
                               pl_executable_binding *out);
int pl_executable_binding_write(const pl_executable_binding *binding,
                                pl_u8 row[PL_EXECUTABLE_BINDING_BYTES]);
int pl_executable_module_read(const pl_u8 row[PL_EXECUTABLE_MODULE_BYTES],
                              pl_executable_module *out);
int pl_executable_module_write(const pl_executable_module *module,
                               pl_u8 row[PL_EXECUTABLE_MODULE_BYTES]);
int pl_executable_resource_read(
    const pl_u8 row[PL_EXECUTABLE_RESOURCE_BYTES],
    pl_executable_resource *out);
int pl_executable_resource_write(
    const pl_executable_resource *resource,
    pl_u8 row[PL_EXECUTABLE_RESOURCE_BYTES]);

int pl_executable_binding_validate(const pl_executable_binding *binding,
                                   pl_u64 source_bytes,
                                   pl_u32 function_count);
int pl_executable_module_validate(const pl_executable_module *module,
                                  pl_u32 function_count);
int pl_executable_resource_validate(const pl_executable_resource *resource,
                                    pl_u64 memory_bytes);

/* Verify the exact external object before instantiating it.  The storage layer
 * first authenticates bytes against `module->digest`; this check then rejects
 * a wrong extent or a non-Wasm32 object before table publication. */
int pl_executable_validate_module_payload(
    const pl_executable_module *module, const pl_u8 *payload, pl_u64 bytes);

/* Delivery authenticates the digest; this validates the exact canonical
 * extent before a resource is mapped into the VM. */
int pl_executable_validate_resource_extent(
    const pl_executable_resource *resource, pl_u64 bytes);

/* Measure and write one fixed root.  Payload and index nodes remain external
 * and can be fetched/released independently. */
int pl_executable_measure(const pl_executable_spec *spec, pl_u64 *bytes);
int pl_executable_write(const pl_executable_spec *spec, pl_u8 *target,
                        pl_u64 capacity, pl_u64 *written);

/* Architectural prefix shared by vm.wasm and compiler-emitted block modules.
 * `registers` is a wasm32 linear-memory pointer to sixteen u64 values.  The
 * compiler emits ordinary field accesses against this definition; no state is
 * copied into an instruction workspace at a block boundary.  VM-private page,
 * device and scheduling state follows this prefix and is never visible to a
 * block module. */
typedef struct {
    pl_u64 *registers;
    pl_u64 xmm[PL_VM_X86_XMM_WORDS];
    pl_u64 rip;
    pl_u64 rflags;
    pl_u64 cr0;
    pl_u64 cr3;
    pl_u64 cr4;
    pl_u64 efer;
    pl_u64 system[PL_VM_X86_SYSTEM_WORDS];
    pl_u64 msr_keys[PL_VM_X86_MSR_WORDS];
    pl_u64 msr_values[PL_VM_X86_MSR_WORDS];
    pl_u32 msr_count;
    pl_u32 mxcsr;
    pl_u64 memory_bytes;
    pl_u64 retired;
    pl_u64 work;
    pl_u64 span;
    pl_u64 x87_significand[PL_VM_X86_X87_REGISTERS];
    pl_u16 x87_sign_exponent[PL_VM_X86_X87_REGISTERS];
    pl_u16 x87_control;
    pl_u16 x87_status;
    pl_u16 x87_tag;
    pl_u16 x87_opcode;
    pl_u64 x87_ip;
    pl_u64 x87_dp;
} pl_vm_x86_state;

/* Stable wasm32 byte coordinates used by a native post-link compiler.  These
 * are part of the direct ABI rather than host-C `sizeof` values: the compiler
 * itself normally runs as x86-64 while its output addresses wasm32 memory. */
#define PL_VM_X86_WASM32_OFF_REGISTERS 0u
#define PL_VM_X86_WASM32_OFF_RIP 264u
#define PL_VM_X86_WASM32_OFF_RFLAGS 272u
#define PL_VM_X86_WASM32_OFF_RETIRED 1016u
#define PL_VM_X86_WASM32_OFF_WORK 1024u
#define PL_VM_X86_WASM32_OFF_SPAN 1032u
#define PL_VM_X86_WASM32_STATE_BYTES 1144u

/* VM-owned description of one atomically published executable.  Every value
 * is a wasm32 scalar or linear-memory offset, so compiler-emitted modules and
 * vm.wasm observe exactly the same bytes without a host-side object graph.
 * Version one reserves the directory coordinates needed by the total page
 * dispatcher; unused coordinates are zero until the loader publishes them. */
#define PL_VM_EXECUTABLE_CONTEXT_BYTES 96u

/* Stable wasm32 offsets for compiler-emitted page dispatchers. */
#define PL_VM_EXECUTABLE_WASM32_OFF_ABI_VERSION 0u
#define PL_VM_EXECUTABLE_WASM32_OFF_BYTES 4u
#define PL_VM_EXECUTABLE_WASM32_OFF_TABLE_BASE 8u
#define PL_VM_EXECUTABLE_WASM32_OFF_FUNCTION_COUNT 12u
#define PL_VM_EXECUTABLE_WASM32_OFF_ENTRY_FUNCTION 16u
#define PL_VM_EXECUTABLE_WASM32_OFF_PAGE_COUNT 20u
#define PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_COUNT 24u
#define PL_VM_EXECUTABLE_WASM32_OFF_BINDING_TAGS 28u
#define PL_VM_EXECUTABLE_WASM32_OFF_BINDING_GENERATIONS 32u
#define PL_VM_EXECUTABLE_WASM32_OFF_BINDING_ARGUMENTS 36u
#define PL_VM_EXECUTABLE_WASM32_OFF_BINDING_SLOTS 40u
#define PL_VM_EXECUTABLE_WASM32_OFF_PAGE_ROW_TAGS 44u
#define PL_VM_EXECUTABLE_WASM32_OFF_PAGE_ROW_VALUES 48u
#define PL_VM_EXECUTABLE_WASM32_OFF_PAGE_ROW_SLOTS 52u
#define PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_TAGS 56u
#define PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_VALUES 60u
#define PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_SLOTS 64u
#define PL_VM_EXECUTABLE_WASM32_OFF_PARAMETER_VALUES 68u
#define PL_VM_EXECUTABLE_WASM32_OFF_PARAMETER_COUNT 72u

/* The cache geometry is part of the emitted-module ABI.  Keeping these
 * direct-mapped sets power-of-two lets a hot dispatcher reduce every lookup
 * to one mask, one tag load and one value load. */
#define PL_VM_EXECUTABLE_BINDING_CACHE_SLOTS 64u
#define PL_VM_EXECUTABLE_PAGE_ROW_CACHE_SLOTS 64u
#define PL_VM_EXECUTABLE_TAIL_ROW_CACHE_SLOTS 16u

typedef struct {
    pl_u32 abi_version;
    pl_u32 bytes;
    pl_u32 table_base;
    pl_u32 function_count;
    pl_u32 entry_function;
    pl_u32 page_count;
    pl_u32 tail_row_count;
    pl_u32 binding_tags;
    pl_u32 binding_generations;
    pl_u32 binding_arguments;
    pl_u32 binding_slots;
    pl_u32 page_row_tags;
    pl_u32 page_row_values;
    pl_u32 page_row_slots;
    pl_u32 tail_row_tags;
    pl_u32 tail_row_values;
    pl_u32 tail_row_slots;
    pl_u32 parameter_values;
    pl_u32 parameter_count;
    pl_u32 reserved[5];
} pl_vm_executable_context;

/* All compiled functions have Wasm type (i32, i32) -> i64.  The first i32 is
 * a linear-memory offset to VM-owned machine state; the second is the loaded
 * executable context.  A block writes architectural values, including a
 * dynamic target RIP, before returning this token.  A page dispatcher uses
 * the same two arguments and the binding's dispatch_argument in that context,
 * so every function occupies one homogeneous Wasm table. */
typedef pl_u64 pl_vm_result;
typedef pl_vm_result (*pl_vm_block_function)(pl_u32 machine, pl_u32 context);
typedef pl_vm_result (*pl_vm_page_dispatch_function)(pl_u32 machine,
                                                     pl_u32 context);

#define PL_VM_RESULT_KIND_BITS 3u
#define PL_VM_RESULT_KIND_MASK 7u

enum pl_vm_result_kind {
    PL_VM_DIRECT = 0,
    PL_VM_RESOLVE_RIP = 1,
    PL_VM_BARRIER = 2,
    PL_VM_FAULT = 3,
    PL_VM_HALT = 4,
    PL_VM_STALE_GENERATION = 5,
    PL_VM_ENTRY_MAP = 6,
    /* A successor-free kernel returns its selected ordered arm.  vm.wasm
     * applies the residual descriptor and never exposes this token to the
     * host as an x86 instruction or block to interpret. */
    PL_VM_TRANSITION = 7
};

static inline pl_vm_result pl_vm_result_make(pl_u32 kind, pl_u64 payload)
{
    return (payload << PL_VM_RESULT_KIND_BITS)
         | (pl_u64)(kind & PL_VM_RESULT_KIND_MASK);
}

static inline pl_u32 pl_vm_result_kind(pl_vm_result result)
{
    return (pl_u32)result & PL_VM_RESULT_KIND_MASK;
}

static inline pl_u64 pl_vm_result_payload(pl_vm_result result)
{
    return result >> PL_VM_RESULT_KIND_BITS;
}

static inline pl_vm_result pl_vm_direct(pl_u32 function_rank)
{
    return pl_vm_result_make(PL_VM_DIRECT, function_rank);
}

#endif /* POSTLINK_EXECUTABLE_H */
