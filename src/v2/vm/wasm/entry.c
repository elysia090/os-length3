/* Host boot/memory admission. Generated cuts call access, not lifecycle APIs. */
#include <vm/mmu.h>
#include <vm/boot.h>
#include <vm/execution.h>
#include <vm/segments.h>
#include <vm/tables.h>
#include <vm/control.h>
#include <vm/registers.h>
#include <vm/msr.h>
#include <vm/debug.h>
#include <vm/io.h>
#include <vm/supply.h>
#include <vm/exception.h>
#include <vm/interrupt.h>
#include <vm/source.h>
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
static vm_page_supply supply;
static vm_fault_delivery delivery;
static vm_table_frontier table_frontier;
static vm_sources sources;
static vm_clock clock_owner;
static vm_pit pit;
static vm_pic pic;
static vm_rtc rtc;
static vm_uart uart;
static vm_post post;
static vm_console console_owner;
static pl_u32 boot_header, boot_header_bytes, boot_command;
static machine_result fetch_entry(void *pointer, pl_u64 address);
static machine_result pending_boundary(pl_u32 port);
static machine_result call_entry(void *pointer, pl_u32 slot);
pl_u32 vm_source_capacity(void) { return VM_SOURCE_ROWS; }
pl_u32 vm_source_metadata_bytes(void) { return sizeof(vm_sources); }

pl_u32 vm_slot_min(void)
{
    pl_u32 fetch = (pl_u32)(uintptr_t)fetch_entry, call = (pl_u32)(uintptr_t)call_entry;
    pl_u32 write = (pl_u32)(uintptr_t)vm_sources_write;
    pl_u32 last = fetch > call ? fetch : call;
    return (last > write ? last : write) + 1u;
}

pl_u32 vm_arena_min(void)
{
    return ((pl_u32)(uintptr_t)&__heap_base + 4095u) & ~4095u;
}

void vm_close(void)
{
    table_frontier=(vm_table_frontier){0};
    vm_clock_close(&clock_owner); vm_pit_reset(&pit); vm_pic_reset(&pic);
    vm_console_close(&console_owner);
    vm_rtc_reset(&rtc);
    vm_uart_reset(&uart);
    post=(vm_post){0};
    vm_sources_open(&sources,0u,vm_slot_min());
    vm_supply_reset(&supply);
    delivery = (vm_fault_delivery){0};
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
 * Reopening revokes admission. Growth and initial page append have separate
 * APIs which preserve the in-flight compiled instruction.
 * This entry point is not an import granted to translated guest programs. */
int vm_open(pl_u32 base, pl_u32 bytes, pl_u32 reserved,
            pl_u32 directory, pl_u32 count, pl_u32 capacity,
            pl_u32 branches, pl_u64 generation)
{
    vm_boot prepared_boot = boot;
    pl_u32 header = boot_header, header_bytes = boot_header_bytes, command = boot_command;
    vm_close();
    pl_u64 extent = (pl_u64)__builtin_wasm_memory_size(0) * 65536u;
    pl_u64 end = (pl_u64)base + bytes;
    pl_u64 directory_bytes = (pl_u64)capacity * sizeof(vm_memory_page);
    pl_u64 branch_bytes = (capacity ? (pl_u64)capacity - 1u : 0u) * sizeof(vm_memory_branch);
    if ((base & 4095u) || base < vm_arena_min() || !bytes || end > extent
            || (directory & 7u) || directory < vm_arena_min()
            || capacity > 0x100000u || (pl_u64)directory + directory_bytes > base
            || (branch_bytes && ((branches & 7u) || branches < vm_arena_min()
                || (pl_u64)branches + branch_bytes > base
                || !separate(directory,(pl_u32)directory_bytes,branches,(pl_u32)branch_bytes)))) return -1;
    if (prepared_boot.header && ((pl_u64)header + header_bytes > base
            || (pl_u64)command + prepared_boot.command_bytes > base
            || !separate(header,header_bytes,directory,(pl_u32)directory_bytes)
            || !separate(command,prepared_boot.command_bytes,directory,(pl_u32)directory_bytes)
            || (branch_bytes && (!separate(header,header_bytes,branches,(pl_u32)branch_bytes)
                || !separate(command,prepared_boot.command_bytes,branches,(pl_u32)branch_bytes))))) return -1;
    if (vm_memory_open(&resident, (pl_u8 *)(uintptr_t)base, bytes, reserved,
                       (vm_memory_page *)(uintptr_t)directory,
                       count, capacity, (vm_memory_branch *)(uintptr_t)branches, generation)) return -1;
    vm_sources_open(&sources,generation,vm_slot_min());
    resident.before_write = vm_sources_write; resident.write_owner = &sources;
    arena_base = base;
    boot = prepared_boot; boot_header = header; boot_header_bytes = header_bytes; boot_command = command;
    return 0;
}

/* memory.grow preserves numeric offsets and the C owner/latch. Refresh only
 * the payload extent, never reopen/rebuild an arena or a directory. */
int vm_grow(void)
{
    pl_u64 extent = (pl_u64)__builtin_wasm_memory_size(0) * 65536u;
    if (!resident.generation || extent < (pl_u64)arena_base + resident.byte_count) return -1;
    resident.byte_count = extent - arena_base;
    return 0;
}
pl_u32 vm_page_count(void) { return resident.page_count; }

int vm_bind_state(pl_u32 state)
{
    table_frontier=(vm_table_frontier){0};
    vm_clock_abort(&clock_owner);
    vm_console_abort(&console_owner);
    vm_sources_open(&sources,resident.generation,vm_slot_min());
    delivery = (vm_fault_delivery){0};
    vm_supply_reset(&supply);
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
    table_frontier=(vm_table_frontier){0};
    vm_clock_abort(&clock_owner);
    vm_console_abort(&console_owner);
    vm_sources_open(&sources,resident.generation,vm_slot_min());
    delivery = (vm_fault_delivery){0};
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    vm_execution_close(&execution); segments_offset = 0u;
    if (!state_offset || (segments & 7u) || segments < arena_base
            || (pl_u64)(segments - arena_base) + sizeof(machine_segments) > resident.reserved_bytes
            || !separate(segments,sizeof(machine_segments),state_offset,sizeof(machine_state))) return -1;
    const machine_segments *context = (const machine_segments *)(uintptr_t)segments;
    if (context->version != MACHINE_SEGMENTS_ABI_VERSION || context->interrupt_shadow > MACHINE_SHADOW_STI) return -1;
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

static int execution_record(pl_u32 rows, pl_u32 bytes)
{
    pl_u32 directory = (pl_u32)(uintptr_t)resident.pages;
    pl_u32 branches = (pl_u32)(uintptr_t)resident.branches;
    return state_offset && !(rows & 7u) && rows >= vm_arena_min()
        && (pl_u64)rows + bytes <= arena_base
        && separate(rows,bytes,directory,resident.page_capacity * (pl_u32)sizeof(vm_memory_page))
        && (resident.page_capacity <= 1u || separate(rows,bytes,branches,
            (resident.page_capacity - 1u) * (pl_u32)sizeof(vm_memory_branch)))
        && (!boot.header || (separate(rows,bytes,boot_header,boot_header_bytes)
            && separate(rows,bytes,boot_command,boot.command_bytes)));
}

int vm_page_prepare(pl_u32 port, pl_u32 record)
{
    if (!private_port(port) || !private_record(record,sizeof(vm_page_request))
            || !separate(record,sizeof(vm_page_request),port,sizeof(machine_memory_port))) return -1;
    vm_page_request request;
    int status = vm_supply_prepare(&supply,&resident,&boot,
            (const machine_state *)(uintptr_t)state_offset,port - arena_base,&request);
    if (status) return status;
    request.target_offset += arena_base;
    *(vm_page_request *)(uintptr_t)record = request;
    return 0;
}
int vm_page_commit(pl_u32 port, pl_u64 ticket)
{
    if (!private_port(port)) return -1;
    return vm_supply_commit(&supply,&resident,(const machine_state *)(uintptr_t)state_offset,
                            port - arena_base,ticket);
}
static machine_result memory_result(pl_u32 port, machine_result result)
{
    vm_supply_capture(&supply,&resident,(const machine_state *)(uintptr_t)state_offset,
                        port - arena_base,result);
    return result;
}

machine_result vm_access(pl_u32 port, pl_u64 address, pl_u32 bytes,
                          pl_u32 access, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !private_port(port))
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
    return memory_result(port,result);
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
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port) || !private_record(target,sizeof(vm_code_page))
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
    return memory_result(port,result);
}

/* Privileged compile admission only; no generated function imports this API.
 * 0 is an already compiled source row; RESOLVE_RIP/0 is a pinned compile miss.
 * C-MMU fetch permission and residency are always revalidated first.
 * view_target reserves TWO code-page records; the unused tail is zero. */
static machine_result source_tail(pl_u32 port, pl_u32 view_target, pl_u32 row_target)
{
    if (!sources.pending || sources.pending_page.address > ~0ull-4096u)
        return MACHINE_RESULT_ENTRY_MAP;
    vm_code_page first = sources.pending_page, next; vm_execution_row row;
    vm_mmu_context context = cpu_context(); resident.write_touched = 0u;
    machine_result result = vm_mmu_code_page(&resident,port-arena_base,&context,
        first.address+4096u,&next);
    if (resident.write_touched) execution.generation = 0u;
    if (result) return memory_result(port,result);
    int status = vm_sources_extend(&sources,&next,&row);
    if (status < 0) return MACHINE_RESULT_STALE_GENERATION;
    first.offset += arena_base; next.offset += arena_base;
    vm_code_page *views = (vm_code_page *)(uintptr_t)view_target;
    views[0] = first; views[1] = next;
    *(vm_execution_row *)(uintptr_t)row_target = row;
    return status ? MACHINE_RESULT_RESOLVE_RIP : 0u;
}
machine_result vm_source_query(pl_u32 port, pl_u64 entry, pl_u32 limit,
                              pl_u32 view_target, pl_u32 row_target)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    sources.pending = 0u;
    vm_supply_reset(&supply); vm_memory_abort(&resident);
    if (delivery.stage || execution.continuation.slot || !segments_offset || !private_port(port)
            || !private_record(view_target,2u*sizeof(vm_code_page))
            || !separate(view_target,2u*sizeof(vm_code_page),port,sizeof(machine_memory_port))
            || !execution_record(row_target,sizeof(vm_execution_row))) return MACHINE_RESULT_ENTRY_MAP;
    const machine_segments *segments = (const machine_segments *)(uintptr_t)segments_offset;
    const machine_state *state=(const machine_state *)(uintptr_t)state_offset;
    /* The supervisor must drain an eligible event before treating a source
     * projection fault as a processor fault. Do not invert IRQ/fetch priority. */
    if ((state->rflags&0x200u) && vm_pic_pending(&pic) && !segments->interrupt_shadow)
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u32 cs = segments->cache[MACHINE_SEGMENT_CS].attributes;
    if (segments->version!=MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow>MACHINE_SHADOW_STI
            || !(cs & 0x2000u) || (cs & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || !limit || limit > 1024u) return MACHINE_RESULT_ENTRY_MAP;
    if (segments->interrupt_shadow) limit=1u;
    vm_code_page page; vm_execution_row row;
    vm_mmu_context context = cpu_context(); resident.write_touched = 0u;
    machine_result result = vm_mmu_code_page(&resident,port - arena_base,&context,entry,&page);
    if (resident.write_touched) execution.generation = 0u;
    if (result) return memory_result(port,result);
    int status = vm_sources_probe(&sources,&page,entry,limit,&row);
    if (status < 0) return MACHINE_RESULT_ENTRY_MAP;
    if (status == 2) return source_tail(port,view_target,row_target);
    page.offset += arena_base;
    vm_code_page *views = (vm_code_page *)(uintptr_t)view_target;
    views[0] = page; views[1] = (vm_code_page){0};
    *(vm_execution_row *)(uintptr_t)row_target = row;
    return status ? MACHINE_RESULT_RESOLVE_RIP : 0u;
}
/* A FETCH request from the trusted cold decoder is the only authority to
 * extend an uncompiled source. This API never decodes or executes x86. */
machine_result vm_source_extend(pl_u32 port, pl_u32 view_target, pl_u32 row_target)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply); vm_memory_abort(&resident);
    if (delivery.stage || execution.continuation.slot || !segments_offset || !private_port(port)
            || !private_record(view_target,2u*sizeof(vm_code_page))
            || !separate(view_target,2u*sizeof(vm_code_page),port,sizeof(machine_memory_port))
            || !execution_record(row_target,sizeof(vm_execution_row))) return MACHINE_RESULT_ENTRY_MAP;
    return source_tail(port,view_target,row_target);
}
int vm_source_publish(pl_u32 bytes, pl_u32 instructions, pl_u32 row_target)
{
    if (delivery.stage || table_frontier.stage || execution.continuation.slot
            || !execution_record(row_target,sizeof(vm_execution_row))) {
        sources.pending = 0u; return -1;
    }
    return vm_sources_publish(&sources,bytes,instructions,(vm_execution_row *)(uintptr_t)row_target);
}
int vm_sources_reset(void)
{
    if (delivery.stage || table_frontier.stage || execution.continuation.slot) return -1;
    vm_sources_open(&sources,resident.generation,vm_slot_min());
    vm_execution_close(&execution); return 0;
}
machine_result vm_reserve(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    vm_mmu_context context = cpu_context();
    resident.write_touched = 0u;
    machine_result result = vm_mmu_reserve(&resident,port - arena_base,&context,address,bytes,access);
    if (resident.write_touched) execution.generation = 0u;
    return memory_result(port,result);
}
machine_result vm_commit(pl_u32 port, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    if (delivery.stage || !private_port(port)) { vm_memory_abort(&resident); return MACHINE_RESULT_ENTRY_MAP; }
    resident.write_touched = 0u;
    machine_result result = vm_memory_commit(&resident,port - arena_base,value);
    if (resident.write_touched) execution.generation = 0u;
    return result;
}
machine_result vm_reserve_pair(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply); vm_memory_abort(&resident);
    if (delivery.stage || !private_record(port,sizeof(machine_memory_pair_port))
            || bytes!=16u || (access & ~7u) || (access & 3u)!=3u) return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 record[16]; vm_mmu_context context=cpu_context();
    resident.write_touched=0u;
    machine_result result=vm_mmu_reserve_record_access(&resident,port-arena_base,&context,
        address,16u,access | VM_MMU_ALIGNED16,record);
    if (!result) {
        pl_u8 *output=(pl_u8 *)(uintptr_t)port;
        for (pl_u32 i=0u;i<8u;++i) {
            output[offsetof(machine_memory_port,value)+i]=record[i];
            output[offsetof(machine_memory_pair_port,high)+i]=record[8u+i];
        }
    }
    if (resident.write_touched) execution.generation=0u;
    return memory_result(port,result);
}
machine_result vm_commit_pair(pl_u32 port, pl_u64 low, pl_u64 high)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    if (delivery.stage || !private_record(port,sizeof(machine_memory_pair_port))) {
        vm_memory_abort(&resident); return MACHINE_RESULT_ENTRY_MAP;
    }
    pl_u8 record[16];
    for (pl_u32 i=0u;i<8u;++i) { record[i]=(pl_u8)(low>>(i*8u)); record[8u+i]=(pl_u8)(high>>(i*8u)); }
    resident.write_touched=0u;
    machine_result result=vm_memory_commit_record(&resident,port-arena_base,record,16u);
    if (resident.write_touched) execution.generation=0u;
    return result;
}
void vm_abort(void)
{
    /* Ordinary RMW cancellation cannot undo a descriptor store or console
     * admission, nor cancel their pinned continuation. Close/rebind fences
     * pending transport; already published external output is not undone. */
    if (table_frontier.stage || vm_console_pending(&console_owner)) return;
    vm_memory_abort(&resident); vm_supply_reset(&supply); vm_clock_abort(&clock_owner);
    vm_console_abort(&console_owner);
}

machine_result vm_io(pl_u32 port, pl_u32 coordinate, pl_u32 transfer, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_io_transfer(&resident,port - arena_base,
        (const machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,
        &clock_owner,&pit,&pic,&rtc,&uart,&console_owner,&post,coordinate,transfer,value);
    if (resident.write_touched) execution.generation = 0u;
    return result == machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_CLOCK)
        || result == machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_CONSOLE)
        ? result : memory_result(port,result);
}
machine_result vm_time(pl_u32 port)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    return vm_time_read(&resident,port - arena_base,(const machine_state *)(uintptr_t)state_offset,
        (const machine_segments *)(uintptr_t)segments_offset,&clock_owner,&console_owner);
}
/* Supervisor diagnostic only, never an import of emitted guest functions. */
int vm_post_read(pl_u64 generation)
{
    return resident.bytes && generation==resident.generation && post.valid ? (int)post.byte : -1;
}
/* Supervisor-only output sink admission. An exact duplicate is not another
 * byte. The sink reserves capacity first and publishes only on return 1. */
int vm_console_commit(pl_u32 port,pl_u64 generation,pl_u64 ticket,pl_u32 byte)
{
    if(!private_port(port) || delivery.stage || table_frontier.stage || clock_owner.stage
            || generation!=resident.generation || vm_memory_load((const pl_u8 *)(uintptr_t)port,8u)!=generation)
        return -1;
    return vm_console_reply(&console_owner,generation,port-arena_base,
        (const machine_state *)(uintptr_t)state_offset,ticket,byte);
}
int vm_clock_commit(pl_u32 port, pl_u64 generation, pl_u64 ticket, pl_u64 nanoseconds)
{
    if (!private_port(port) || delivery.stage || table_frontier.stage || vm_console_pending(&console_owner) || generation != resident.generation
            || vm_memory_load((const pl_u8 *)(uintptr_t)port,8u) != generation) return -1;
    if (rtc.seeded && !vm_rtc_can_advance(&rtc,nanoseconds)) return -1;
    if (!vm_pit_can_advance(&pit,nanoseconds)) return -1;
    int result=vm_clock_reply(&clock_owner,generation,port - arena_base,
        (const machine_state *)(uintptr_t)state_offset,ticket,nanoseconds);
    if (!result && rtc.seeded) {
        if (vm_rtc_advance(&rtc,nanoseconds)) return -1;
        vm_pic_set_irq(&pic,8u,(pl_u32)vm_rtc_irq(&rtc));
    }
    if(!result){
        if(vm_pit_advance(&pit,nanoseconds,&pic))return -1;
        vm_uart_advance(&uart,nanoseconds);vm_pic_set_irq(&pic,4u,(pl_u32)vm_uart_irq(&uart));
    }
    return result;
}
/* Supervisor-only UTC seed. Guest code receives only the IN/OUT import;
 * it cannot re-seed, alter event generations or access a host clock. */
int vm_rtc_start(pl_u32 port, pl_u64 generation, pl_u64 utc_seconds)
{
    if (!private_port(port) || !segments_offset || delivery.stage || table_frontier.stage
            || clock_owner.stage || clock_owner.now || generation!=resident.generation
            || vm_memory_load((const pl_u8 *)(uintptr_t)port,8u)!=generation) return -1;
    return vm_rtc_seed(&rtc,utc_seconds);
}

machine_result vm_table(pl_u32 port, pl_u64 address, pl_u32 rank, pl_u32 access)
{
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    const machine_segments *segments = (const machine_segments *)(uintptr_t)segments_offset;
    pl_u32 cs = segments->cache[MACHINE_SEGMENT_CS].attributes;
    if (!(cs & 0x2000u) || (cs & (0x4000u | MACHINE_SEGMENT_UNUSABLE))) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_table_transfer(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,&table_frontier,address,rank,access);
    if (resident.write_touched) execution.generation = 0u;
    return memory_result(port,result);
}

machine_result vm_return(pl_u32 port, pl_u32 discard_bytes)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_far_return(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,discard_bytes);
    if (resident.write_touched) execution.generation = 0u;
    return memory_result(port,result);
}

/* A pending architectural event is owned by C across physical page waits.
 * This export is not an import available to emitted guest functions. */
machine_result vm_fault(pl_u32 port)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (!segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    vm_execution_close(&execution);
    resident.write_touched = 0u;
    machine_result result = vm_fault_enter(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,&delivery);
    return memory_result(port,result);
}
machine_result vm_iret(pl_u32 port)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_interrupt_return(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset);
    if (!result || resident.write_touched) execution.generation = 0u;
    return memory_result(port,result);
}
machine_result vm_flag(pl_u32 port, pl_u32 enable)
{
    if (delivery.stage || table_frontier.stage || !segments_offset || !private_port(port))
        return MACHINE_RESULT_ENTRY_MAP;
    return vm_interrupt_flag(&resident,port-arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,enable);
}

machine_result vm_control(pl_u32 port, pl_u32 rank, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    machine_result result = vm_control_write(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,rank,value);
    /* Even equal-value CR3 writes invalidate paging caches. With no retained
     * TLB, revoking compiled fetch-context admission is sufficient; do not
     * silently continue under the previous proof after a successful write. */
    if (!result) execution.generation = 0u;
    return result;
}

machine_result vm_debug(pl_u32 port, pl_u32 write, pl_u32 rank, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    return vm_debug_transfer(&resident,port-arena_base,
        (machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,
        write,rank,value);
}

machine_result vm_msr(pl_u32 port, pl_u32 operation, pl_u32 key, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    machine_result result = vm_msr_transfer(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,
        operation,key,value);
    /* EFER/MISC_ENABLE change CPU interpretation; revoke current admission.
     * FS/GS only change data addresses read freshly by the C access boundary. */
    if (!result && operation == MACHINE_MSR_WRITE
            && (key == MACHINE_MSR_EFER || key == MACHINE_MSR_MISC_ENABLE))
        execution.generation = 0u;
    return result;
}

machine_result vm_segment(pl_u32 port, pl_u32 rank, pl_u32 selector)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return machine_result_make(MACHINE_RESULT_ENTRY_MAP,0u);
    resident.write_touched = 0u;
    machine_result result = vm_segment_load(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,rank,selector);
    if (resident.write_touched) execution.generation = 0u;
    return memory_result(port,result);
}

int vm_bind_execution(pl_u32 rows, pl_u32 count, pl_u64 generation)
{
    if (delivery.stage || table_frontier.stage || vm_console_pending(&console_owner)) return -1;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    vm_execution_close(&execution);
    pl_u64 bytes = (pl_u64)count * sizeof(vm_execution_row);
    if (!state_offset || !count || count > VM_EXECUTION_MAX_ROWS
            || !generation || generation != resident.generation
            || !execution_record(rows,(pl_u32)bytes)) return -1;
    const vm_execution_row *directory_rows = (const vm_execution_row *)(uintptr_t)rows;
    for (pl_u32 i = 0u; i < count; ++i)
        if (directory_rows[i].slot < vm_slot_min()) return -1;
    int status = vm_execution_open(&execution, (const vm_execution_row *)(uintptr_t)rows,
                              count, generation, (const machine_state *)(uintptr_t)state_offset);
    if (!status && segments_offset) execution.segments = (machine_segments *)(uintptr_t)segments_offset;
    return status;
}
typedef struct { pl_u32 port; } execution_owner;
static machine_result interrupt_boundary(pl_u32 port)
{
    vm_supply_reset(&supply);
    resident.write_touched=0u;
    machine_result result=vm_interrupt_enter(&resident,port-arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,&delivery,&pic);
    /* Hardware entry changes control without retiring the interrupted cut.
     * Its new RIP is admitted afresh, never executed through the old row. */
    execution.generation=0u;
    return memory_result(port,result ? result : MACHINE_RESULT_RESOLVE_RIP);
}
static machine_result pending_boundary(pl_u32 port)
{
    if (table_frontier.stage || !private_port(port)
            || (vm_console_pending(&console_owner) && !execution.continuation.slot)) return MACHINE_RESULT_ENTRY_MAP;
    if (delivery.stage) return delivery.external ? interrupt_boundary(port) : MACHINE_RESULT_ENTRY_MAP;
    const machine_state *state=(const machine_state *)(uintptr_t)state_offset;
    if (!execution.continuation.slot && (state->rflags&0x200u) && vm_pic_pending(&pic)
            && (!segments_offset || !((const machine_segments *)(uintptr_t)segments_offset)->interrupt_shadow))
        return segments_offset ? interrupt_boundary(port) : MACHINE_RESULT_ENTRY_MAP;
    return 0u;
}
/* Supervisor event admission precedes cold source projection. This is not
 * available to emitted guest functions and contains no source decoder. */
machine_result vm_boundary(pl_u32 port, pl_u64 generation)
{
    execution.completed=0u;execution.retired=0u;
    if (!private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    if (generation!=resident.generation || vm_memory_load((const pl_u8 *)(uintptr_t)port,8u)!=generation)
        return MACHINE_RESULT_STALE_GENERATION;
    return pending_boundary(port);
}
static machine_result fetch_entry(void *pointer, pl_u64 address)
{
    const execution_owner *owner = pointer;
    /* In-flight continuation is handled before this boundary. Events never
     * replay an admitted instruction or consume its inhibition on a wait. */
    machine_result boundary=pending_boundary(owner->port);
    if (boundary) return boundary;
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
    if (vm_memory_load((const pl_u8 *)(uintptr_t)port,8u) != resident.generation)
        return machine_result_make(MACHINE_RESULT_STALE_GENERATION,0u);
    if (generation!=resident.generation) return MACHINE_RESULT_STALE_GENERATION;
    if (!maximum_cuts || maximum_cuts>VM_EXECUTION_MAX_QUANTUM || table_frontier.stage)
        return MACHINE_RESULT_ENTRY_MAP;
    machine_result boundary=pending_boundary(port);
    if (boundary) return boundary;
    return vm_execution_run(&execution, (machine_state *)(uintptr_t)state_offset,
                             generation, maximum_cuts, fetch_entry, call_entry, &owner);
}
pl_u32 vm_completed(void) { return execution.completed; }
pl_u64 vm_source_retired(void) { return execution.retired; }
