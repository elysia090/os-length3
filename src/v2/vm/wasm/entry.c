/* Host boot/memory admission. Generated cuts call access, not lifecycle APIs. */
#include <vm/mmu.h>
#include <vm/boot.h>
#include <vm/execution.h>
#include <vm/segments.h>
#include <vm/tables.h>
#include <vm/control.h>
#include <vm/registers.h>
#include <machine/state.h>
#include "../core/memory-internal.h"
#include <stdint.h>

extern unsigned char __heap_base;
_Static_assert(sizeof(vm_code_page) == 24u, "borrowed code view transport extent");
static vm_memory resident;
static pl_u32 arena_base;
static pl_u32 state_offset;
static pl_u32 segments_offset;
static vm_boot boot;
static vm_execution execution;
static pl_u32 boot_header, boot_header_bytes, boot_command;
static machine_result fetch_entry(void *pointer, pl_u64 address);
static machine_result call_entry(void *pointer, pl_u32 slot);

pl_u32 vm_slot_min(void)
{
    pl_u32 fetch = (pl_u32)(uintptr_t)fetch_entry, call = (pl_u32)(uintptr_t)call_entry;
    return (fetch > call ? fetch : call) + 1u;
}

pl_u32 vm_arena_min(void)
{
    return ((pl_u32)(uintptr_t)&__heap_base + 4095u) & ~4095u;
}

void vm_close(void)
{
    resident = (vm_memory){ 0 };
    arena_base = 0u;
    state_offset = 0u;
    segments_offset = 0u;
    boot = (vm_boot){ 0 };
    boot_header = boot_header_bytes = boot_command = 0u;
    vm_execution_close(&execution);
}

static int range(pl_u32 offset, pl_u32 bytes)
{
    return offset >= vm_arena_min()
        && (pl_u64)offset + bytes <= (pl_u64)__builtin_wasm_memory_size(0) * 65536u;
}
static int separate(pl_u32 a, pl_u32 bytes, pl_u32 b, pl_u32 extent)
{ return (pl_u64)a + bytes <= b || (pl_u64)b + extent <= a; }
static int boot_output(pl_u32 offset, pl_u32 bytes)
{
    return boot.header && !resident.generation && range(offset, bytes)
        && separate(offset, bytes, boot_header, boot_header_bytes)
        && separate(offset, bytes, boot_command, boot.command_bytes);
}

/* Privileged cold loader exports, never imports granted to generated code.
 * Preparing a new boot revokes all previous memory/state/boot admission. */
int vm_boot_prepare(pl_u32 header, pl_u32 header_bytes, pl_u64 image_bytes,
                     pl_u64 initramfs_bytes, pl_u64 ram_bytes,
                     pl_u32 command, pl_u32 command_bytes)
{
    vm_close();
    if (!range(header, header_bytes) || !range(command, command_bytes)) return -1;
    if (vm_boot_open(&boot, (const pl_u8 *)(uintptr_t)header, header_bytes,
                     image_bytes, initramfs_bytes, ram_bytes,
                     (const pl_u8 *)(uintptr_t)command, command_bytes)) return -1;
    boot_header = header; boot_header_bytes = header_bytes; boot_command = command;
    return 0;
}

int vm_boot_project(pl_u64 address, pl_u32 target, pl_u32 source)
{
    if ((target & 4095u) || (source & 7u) || !boot_output(target, 4096u)
            || !boot_output(source, sizeof(vm_boot_source))
            || !separate(target, 4096u, source, sizeof(vm_boot_source))) return -1;
    return vm_boot_page(&boot, address, (pl_u8 *)(uintptr_t)target,
                         (vm_boot_source *)(uintptr_t)source);
}

int vm_boot_initial_state(pl_u32 state)
{
    if ((state & 7u) || !boot_output(state, sizeof(machine_state))) return -1;
    return vm_boot_state(&boot, (machine_state *)(uintptr_t)state);
}

int vm_boot_initial_segments(pl_u32 segments)
{
    if ((segments & 7u) || !boot_output(segments,sizeof(machine_segments))) return -1;
    return vm_boot_segments(&boot,(machine_segments *)(uintptr_t)segments);
}

/* A borrowed directory occupies supervisor memory below the guest arena.
 * No descriptor, RAM or CPU-state copy is made. The serialized owner pins
 * directory, translations and CPU context until every admitted cut returns.
 * Reopening after growth/reconfiguration revokes the previous admission first.
 * This entry point is not an import granted to translated guest programs. */
int vm_open(pl_u32 base, pl_u32 bytes, pl_u32 reserved,
            pl_u32 directory, pl_u32 count, pl_u64 generation)
{
    vm_close();
    pl_u64 extent = (pl_u64)__builtin_wasm_memory_size(0) * 65536u;
    pl_u64 end = (pl_u64)base + bytes;
    pl_u64 directory_end = (pl_u64)directory + (pl_u64)count * sizeof(vm_memory_page);
    if ((base & 4095u) || base < vm_arena_min() || !bytes || end > extent
            || (directory & 7u) || directory < vm_arena_min()
            || directory_end > base) return -1;
    if (vm_memory_open(&resident, (pl_u8 *)(uintptr_t)base, bytes, reserved,
                       (const vm_memory_page *)(uintptr_t)directory,
                       count, generation)) return -1;
    arena_base = base;
    return 0;
}

int vm_bind_state(pl_u32 state)
{
    vm_memory_abort(&resident);
    vm_execution_close(&execution);
    state_offset = 0u;
    segments_offset = 0u;
    if (!resident.generation || state < arena_base || (state & 7u)
            || (pl_u64)(state - arena_base) + sizeof(machine_state) > resident.reserved_bytes)
        return -1;
    state_offset = state;
    return 0;
}

int vm_bind_segments(pl_u32 segments)
{
    vm_memory_abort(&resident);
    vm_execution_close(&execution); segments_offset = 0u;
    if (!state_offset || (segments & 7u) || segments < arena_base
            || (pl_u64)(segments - arena_base) + sizeof(machine_segments) > resident.reserved_bytes
            || !separate(segments,sizeof(machine_segments),state_offset,sizeof(machine_state))) return -1;
    const machine_segments *context = (const machine_segments *)(uintptr_t)segments;
    if (context->version != MACHINE_SEGMENTS_ABI_VERSION || context->mov_ss_shadow > 1u) return -1;
    segments_offset = segments;
    return 0;
}

static int private_record(pl_u32 port, pl_u32 bytes)
{
    return state_offset && !(port & 7u) && port >= arena_base
        && (pl_u64)(port - arena_base) + bytes <= resident.reserved_bytes
        && separate(port,bytes,state_offset,sizeof(machine_state))
        && (!segments_offset || separate(port,bytes,segments_offset,sizeof(machine_segments)));
}
static int private_port(pl_u32 port)
{ return private_record(port,sizeof(machine_memory_port)); }

machine_result vm_access(pl_u32 port, pl_u64 address, pl_u32 bytes,
                          pl_u32 access, pl_u64 value)
{
    vm_memory_abort(&resident);
    if (!private_port(port))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    const pl_u8 *state = resident.bytes + state_offset - arena_base;
    vm_mmu_context context = {
        vm_memory_load(state + offsetof(machine_state, cr0), 8u),
        vm_memory_load(state + offsetof(machine_state, cr3), 8u),
        vm_memory_load(state + offsetof(machine_state, cr4), 8u),
        vm_memory_load(state + offsetof(machine_state, efer), 8u),
        (pl_u32)vm_memory_load(state + offsetof(machine_state, system)
                              + MACHINE_SYSTEM_CS * 8u, 8u) & 3u,
    };
    resident.write_touched = 0u;
    machine_result result = vm_mmu_access(&resident, port - arena_base, &context, address, bytes, access, value);
    /* Guest code can physically alias a page table: even A/D writes may
     * change instruction bytes. Until disjoint write sets are proved, ANY
     * guest RAM mutation revokes code admission, including on a later fault.
     * A one-call bit avoids epoch wraparound/ABA; no async writer is admitted. */
    if (resident.write_touched) execution.generation = 0u;
    return result;
}

static vm_mmu_context cpu_context(void)
{
    const machine_state *state = (const machine_state *)(uintptr_t)state_offset;
    return (vm_mmu_context){state->cr0,state->cr3,state->cr4,state->efer,
        (pl_u32)state->system[MACHINE_SYSTEM_CS] & 3u};
}
/* Admission-only borrowing API. No source decoding, no RAM reconstruction,
 * and no export/import granted to the emitted machine function. */
machine_result vm_code(pl_u32 port, pl_u64 address, pl_u32 target)
{
    vm_memory_abort(&resident);
    if (!segments_offset || !private_port(port) || !private_record(target,sizeof(vm_code_page))
            || !separate(target,sizeof(vm_code_page),port,sizeof(machine_memory_port)))
        return MACHINE_RESULT_ENTRY_MAP;
    const machine_segments *segments = (const machine_segments *)(uintptr_t)segments_offset;
    pl_u32 cs = segments->cache[MACHINE_SEGMENT_CS].attributes;
    if (!(cs & 0x2000u) || (cs & (0x4000u | MACHINE_SEGMENT_UNUSABLE)))
        return MACHINE_RESULT_ENTRY_MAP; /* The cold backend accepts 64-bit code only. */
    vm_mmu_context context = cpu_context();
    vm_code_page page;
    resident.write_touched = 0u;
    machine_result result = vm_mmu_code_page(&resident,port - arena_base,&context,address,&page);
    if (resident.write_touched) execution.generation = 0u;
    if (!result) {
        page.offset += arena_base;
        *(vm_code_page *)(uintptr_t)target = page;
    }
    return result;
}
machine_result vm_reserve(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    vm_memory_abort(&resident);
    if (!private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    vm_mmu_context context = cpu_context();
    resident.write_touched = 0u;
    machine_result result = vm_mmu_reserve(&resident,port - arena_base,&context,address,bytes,access);
    if (resident.write_touched) execution.generation = 0u;
    return result;
}
machine_result vm_commit(pl_u32 port, pl_u64 value)
{
    if (!private_port(port)) { vm_memory_abort(&resident); return MACHINE_RESULT_ENTRY_MAP; }
    resident.write_touched = 0u;
    machine_result result = vm_memory_commit(&resident,port - arena_base,value);
    if (resident.write_touched) execution.generation = 0u;
    return result;
}
void vm_abort(void) { vm_memory_abort(&resident); }

machine_result vm_table(pl_u32 port, pl_u64 address, pl_u32 rank, pl_u32 access)
{
    vm_memory_abort(&resident);
    if (!segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    const machine_segments *segments = (const machine_segments *)(uintptr_t)segments_offset;
    pl_u32 cs = segments->cache[MACHINE_SEGMENT_CS].attributes;
    if (!(cs & 0x2000u) || (cs & (0x4000u | MACHINE_SEGMENT_UNUSABLE))) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_table_load(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,address,rank,access);
    if (resident.write_touched) execution.generation = 0u;
    return result;
}

machine_result vm_return(pl_u32 port, pl_u32 discard_bytes)
{
    vm_memory_abort(&resident);
    if (!segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_far_return(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,discard_bytes);
    if (resident.write_touched) execution.generation = 0u;
    return result;
}

machine_result vm_control(pl_u32 port, pl_u32 rank, pl_u64 value)
{
    vm_memory_abort(&resident);
    if (!segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    machine_result result = vm_control_write(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,rank,value);
    /* Even equal-value CR3 writes invalidate paging caches. With no retained
     * TLB, revoking compiled fetch-context admission is sufficient; do not
     * silently continue under the previous proof after a successful write. */
    if (!result) execution.generation = 0u;
    return result;
}

machine_result vm_segment(pl_u32 port, pl_u32 rank, pl_u32 selector)
{
    vm_memory_abort(&resident);
    if (!segments_offset || !private_port(port)) return machine_result_make(MACHINE_RESULT_ENTRY_MAP,0u);
    resident.write_touched = 0u;
    machine_result result = vm_segment_load(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,rank,selector);
    if (resident.write_touched) execution.generation = 0u;
    return result;
}

int vm_bind_execution(pl_u32 rows, pl_u32 count, pl_u64 generation)
{
    vm_memory_abort(&resident);
    vm_execution_close(&execution);
    pl_u64 bytes = (pl_u64)count * sizeof(vm_execution_row);
    pl_u32 directory = (pl_u32)(uintptr_t)resident.pages;
    if (!state_offset || !count || count > VM_EXECUTION_MAX_ROWS
            || !generation || generation != resident.generation || (rows & 7u)
            || rows < vm_arena_min() || (pl_u64)rows + bytes > arena_base
            || !separate(rows, (pl_u32)bytes, directory,
                          resident.page_count * (pl_u32)sizeof(vm_memory_page))) return -1;
    const vm_execution_row *directory_rows = (const vm_execution_row *)(uintptr_t)rows;
    for (pl_u32 i = 0u; i < count; ++i)
        if (directory_rows[i].slot < vm_slot_min()) return -1;
    int status = vm_execution_open(&execution, (const vm_execution_row *)(uintptr_t)rows,
                              count, generation, (const machine_state *)(uintptr_t)state_offset);
    if (!status && segments_offset) execution.segments = (machine_segments *)(uintptr_t)segments_offset;
    return status;
}
typedef struct { pl_u32 port; } execution_owner;
static machine_result fetch_entry(void *pointer, pl_u64 address)
{
    const execution_owner *owner = pointer;
    return vm_access(owner->port, address, 1u,
                       (pl_u32)MACHINE_MEMORY_READ | (pl_u32)VM_MMU_EXECUTE, 0u);
}
static machine_result call_entry(void *pointer, pl_u32 slot)
{
    const execution_owner *owner = pointer;
    /* Wasm C function pointers are table indices. All admitted functions have
     * machine_entry type; a wrong type/bounds is a host admission bug/trap,
     * never an x86 instruction fallback. Slots stay pinned during vm_run. */
    machine_entry entry = (machine_entry)(uintptr_t)slot;
    vm_memory_abort(&resident);
    machine_result result = entry(state_offset, owner->port);
    vm_memory_abort(&resident);
    return result;
}
machine_result vm_run(pl_u32 port, pl_u64 generation, pl_u32 maximum_cuts)
{
    vm_memory_abort(&resident);
    execution.completed = 0u; execution.retired = 0u;
    if (!private_port(port))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    execution_owner owner = { port };
    return vm_execution_run(&execution, (machine_state *)(uintptr_t)state_offset,
                             generation, maximum_cuts, fetch_entry, call_entry, &owner);
}
pl_u32 vm_completed(void) { return execution.completed; }
pl_u64 vm_source_retired(void) { return execution.retired; }
