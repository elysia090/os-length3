/* Host boot/memory admission. Generated cuts call access, not lifecycle APIs. */
#include <vm/mmu.h>
#include <vm/boot.h>
#include <vm/execution.h>
#include <vm/segments.h>
#include <vm/tables.h>
#include <vm/control.h>
#include <vm/registers.h>
#include <vm/msr.h>
#include <vm/system.h>
#include <vm/debug.h>
#include <vm/io.h>
#include <vm/supply.h>
#include <vm/exception.h>
#include <vm/interrupt.h>
#include <vm/source.h>
#include <vm/directory.h>
#include <vm/module.h>
#include <machine/state.h>
#include <support/checked.h>
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
static pl_u32 active_call_port;
static vm_io_admission io_admission;
static machine_activity activity;
static vm_directory artifact_directory;
static pl_u32 artifact_module_offset,artifact_module_bytes;
static pl_u64 artifact_module_ticket;
static vm_module artifact_module;
static vm_image_module artifact_image;
static pl_u8 artifact_image_source[32];
static pl_u32 artifact_image_source_bound;
static void artifact_witness_clear(void)
{
    artifact_module_offset=artifact_module_bytes=0u;artifact_module_ticket=0u;
    artifact_module=(vm_module){0};artifact_image=(vm_image_module){0};
}
static pl_u32 source_limit;
static pl_u64 source_demands;
static pl_u32 source_admissions, run_interrupted;
static vm_sources sources;
#ifdef VM_SOURCE_PROFILE
/* Construction-side observations, not CPU state, code identity or authority.
 * Every 4096th supervisor query samples only the bounded resident owner. */
static pl_u64 source_profile[11];
pl_u64 vm_source_profile(pl_u32 index)
{ return index<11u ? source_profile[index] : 0u; }
static void source_profile_write(void *owner, pl_u32 offset, pl_u32 bytes)
{
    vm_sources *owned=owner;
    pl_u64 before=owned->valid;pl_u32 pending=owned->pending;
    vm_sources_write(owner,offset,bytes);
    source_profile[9]+=(pl_u64)__builtin_popcountll(before&~owned->valid);
    source_profile[10]+=(pl_u64)(pending && !owned->pending);
}
#define SOURCE_WRITE_OBSERVER source_profile_write
static void source_profile_before(const vm_code_page *page, pl_u64 entry, pl_u32 limit)
{
    ++source_profile[0];
    if (source_profile[0]&4095u) return;
    ++source_profile[3];
    source_profile[8]+=(pl_u64)__builtin_popcountll(sources.valid);
    int same_entry=0,same_owner=0,admissible=0;
    pl_u64 valid=sources.valid;
    while(valid) {
        pl_u32 rank=(pl_u32)__builtin_ctzll(valid);
        const vm_source_row *row=sources.rows+rank;
        if(row->row.entry==entry) {
            same_entry=1;
            if(row->offset==page->offset) {
                same_owner=1;
                if(vm_source_budget_fits(row,limit))admissible=1;
            }
        }
        valid&=valid-1u;
    }
    ++source_profile[!same_entry?4u:!same_owner?5u:!admissible?6u:7u];
}
#endif
#ifndef VM_SOURCE_PROFILE
#define SOURCE_WRITE_OBSERVER vm_sources_write
#endif
static pl_u32 run_source_rank=VM_SOURCE_ROWS;
static vm_page_supply supply;
static vm_fault_delivery delivery;
static vm_table_frontier table_frontier;
static vm_clock clock_owner;
static vm_pit pit;
static vm_pic pic;
static vm_rtc rtc;
static vm_uart uart;
static vm_post post;
static vm_console console_owner;
static pl_u32 boot_header, boot_header_bytes, boot_command;
static pl_u32 boot_projected;
static machine_result fetch_entry(void *pointer, pl_u64 address);
static machine_result pending_boundary(pl_u32 port);
static machine_result call_entry(void *pointer, pl_u32 slot, pl_u64 binding, pl_u32 operand_binding);
static machine_result source_entry(void *pointer, pl_u64 address, const vm_execution_row **row);
static int clock_boundary_pending(void)
{ return clock_owner.stage && clock_owner.key==VM_CLOCK_BOUNDARY_KEY; }
pl_u32 vm_source_capacity(void) { return VM_SOURCE_ROWS; }
pl_u32 vm_entry_abi(void) { return MACHINE_ENTRY_ABI_VERSION; }
pl_u32 vm_halted(void) { return activity.state == MACHINE_ACTIVITY_HALTED; }
pl_u32 vm_source_metadata_bytes(void) { return sizeof(vm_sources); }

pl_u32 vm_slot_min(void)
{
    pl_u32 fetch = (pl_u32)(uintptr_t)fetch_entry, call = (pl_u32)(uintptr_t)call_entry;
    pl_u32 write = (pl_u32)(uintptr_t)SOURCE_WRITE_OBSERVER;
    pl_u32 last = fetch > call ? fetch : call;
    if (last < write) last = write;
    pl_u32 select = (pl_u32)(uintptr_t)source_entry;
    return (last > select ? last : select) + 1u;
}

pl_u32 vm_arena_min(void)
{
    return ((pl_u32)(uintptr_t)&__heap_base + 4095u) & ~4095u;
}

void vm_close(void)
{
    io_admission=(vm_io_admission){0};
#ifdef VM_SOURCE_PROFILE
    for(pl_u32 i=0u;i<11u;++i)source_profile[i]=0u;
#endif
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
    boot_projected = 0u;
    vm_execution_close(&execution);
    activity = (machine_activity){ MACHINE_ACTIVITY_RUNNING };
    vm_directory_close(&artifact_directory);
    artifact_witness_clear();artifact_image_source_bound=0u;
    source_limit = 0u;
    source_demands=0u;source_admissions=run_interrupted=0u;
    run_source_rank=VM_SOURCE_ROWS;
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

int vm_boot_image(pl_u64 address, pl_u64 bytes)
{
    if (resident.generation || boot_projected) return -1;
    return vm_boot_attach_image(&boot,address,bytes);
}

int vm_boot_project(pl_u64 address, pl_u32 target, pl_u32 source)
{
    if ((target & 4095u) || (source & 7u) || !boot_output(target, 4096u)
            || !boot_output(source, sizeof(vm_boot_source))
            || !separate(target, 4096u, source, sizeof(vm_boot_source))) return -1;
    int result = vm_boot_page(&boot, address, (pl_u8 *)(uintptr_t)target,
                              (vm_boot_source *)(uintptr_t)source);
    if (result >= 0) boot_projected = 1u;
    return result;
}

int vm_boot_initial_state(pl_u32 state)
{
    if ((state & 7u) || !boot_output(state, sizeof(machine_state))) return -1;
    int result = vm_boot_state(&boot, (machine_state *)(uintptr_t)state);
    if (!result) boot_projected = 1u;
    return result;
}

int vm_boot_initial_segments(pl_u32 segments)
{
    if ((segments & 7u) || !boot_output(segments,sizeof(machine_segments))) return -1;
    int result = vm_boot_segments(&boot,(machine_segments *)(uintptr_t)segments);
    if (!result) boot_projected = 1u;
    return result;
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
    resident.before_write = SOURCE_WRITE_OBSERVER; resident.write_owner = &sources;
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
    run_source_rank=VM_SOURCE_ROWS;
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
    run_source_rank=VM_SOURCE_ROWS;
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

/* Supervisor-only Artifact transport. The bytes are a bounded projection of
 * an independently accepted root, not another executable authority. No guest
 * module imports these APIs, and no ISA/compiler is linked into this owner. */
static int directory_boundary(void)
{
    return state_offset && !delivery.stage && !table_frontier.stage
        && !clock_owner.stage && !execution.continuation.slot
        && !resident.reservation.parts && !vm_console_pending(&console_owner);
}
int vm_directory_bind(pl_u32 root_offset,pl_u64 generation,pl_u32 maximum_object_bytes)
{
    if (!directory_boundary() || !private_record(root_offset,PL_INDEX_REF_BYTES))
        return VM_DIRECTORY_ERROR_INPUT;
    if (generation!=resident.generation) return VM_DIRECTORY_ERROR_STALE;
    artifact_witness_clear();artifact_image_source_bound=0u;
    pl_index_ref root;
    if (pl_index_ref_read((const pl_u8 *)(uintptr_t)root_offset,&root)) {
        vm_directory_close(&artifact_directory);return VM_DIRECTORY_ERROR_INPUT;
    }
    return vm_directory_open(&artifact_directory,&root,generation,maximum_object_bytes);
}
int vm_directory_query(pl_u64 generation,pl_u64 major,pl_u64 minor,pl_u32 expected_kind)
{
    if (!directory_boundary()) return VM_DIRECTORY_ERROR_BUSY;
    if (generation!=resident.generation) return VM_DIRECTORY_ERROR_STALE;
    int status=vm_directory_begin(&artifact_directory,generation,(pl_index_key){major,minor},expected_kind);
    if(!status)artifact_witness_clear();
    return status;
}
/* Transport DTO: generation, ticket, opaque digest[32], bytes, resource kind.
 * DIRECTORY requests are existing index nodes; the selected resource follows.
 * C already parsed/authenticated all canonical structure and rank selection. */
int vm_directory_request(pl_u32 target,pl_u64 generation)
{
    if (!directory_boundary() || !private_record(target,56u)) return VM_DIRECTORY_ERROR_INPUT;
    if (generation!=resident.generation || generation!=artifact_directory.generation)
        return VM_DIRECTORY_ERROR_STALE;
    pl_u32 stage=artifact_directory.stage;
    if (stage!=VM_DIRECTORY_NODE && stage!=VM_DIRECTORY_OBJECT) return VM_DIRECTORY_ERROR_INPUT;
    pl_u8 *request=(pl_u8 *)(uintptr_t)target;
    const pl_u8 *digest=stage==VM_DIRECTORY_NODE ? artifact_directory.pending.digest
        : artifact_directory.resource.object.digest;
    vm_memory_store(request,generation,8u);vm_memory_store(request+8u,artifact_directory.ticket,8u);
    for(pl_u32 i=0u;i<PL_SHA256_BYTES;++i)request[16u+i]=digest[i];
    vm_memory_store(request+48u,stage==VM_DIRECTORY_NODE ? artifact_directory.pending.node_bytes
        : artifact_directory.resource.object.bytes,4u);
    vm_memory_store(request+52u,stage==VM_DIRECTORY_NODE ? ARTIFACT_RESOURCE_DIRECTORY
        : artifact_directory.resource.object.kind,4u);
    return (int)stage;
}
int vm_directory_node_commit(pl_u32 source,pl_u32 bytes,pl_u64 generation,pl_u64 ticket)
{
    if (!directory_boundary() || !private_record(source,bytes) || !bytes || bytes>PL_INDEX_NODE_BYTES)
        return VM_DIRECTORY_ERROR_INPUT;
    if (generation!=resident.generation) return VM_DIRECTORY_ERROR_STALE;
    return vm_directory_node(&artifact_directory,generation,ticket,(const pl_u8 *)(uintptr_t)source,bytes);
}
int vm_directory_object_commit(pl_u32 source,pl_u32 bytes,pl_u64 generation,pl_u64 ticket)
{
    if (!directory_boundary() || !private_record(source,bytes) || !bytes) return VM_DIRECTORY_ERROR_INPUT;
    if (generation!=resident.generation) return VM_DIRECTORY_ERROR_STALE;
    int status=vm_directory_object(&artifact_directory,generation,ticket,(const pl_u8 *)(uintptr_t)source,bytes);
    if(!status){artifact_witness_clear();artifact_module_offset=source;artifact_module_bytes=bytes;artifact_module_ticket=ticket;}
    return status;
}
void vm_directory_cancel_request(void) {
    vm_directory_cancel(&artifact_directory);
    artifact_witness_clear();
}
pl_u32 vm_directory_status(void) { return artifact_directory.stage; }

/* Trusted compiler-derived metadata is bound to this exact authenticated
 * immutable buffer and current C-admitted source lease. Never rehash/parse
 * guest instructions or accept source/span/binding from JavaScript. The host
 * must keep the object unchanged until prefix consumption and publication;
 * replacing/reusing its private buffer requires cancel/query/rebind first. */
static int source_witness_match(const pl_u8 *witness,pl_u32 bytes,pl_u64 generation)
{
    pl_u32 first=4096u-(pl_u32)(sources.pending_entry&4095u);if(first>bytes)first=bytes;
    const pl_u8 *source=resident.bytes+sources.pending_page.offset+(sources.pending_entry&4095u);
    for(pl_u32 i=0u;i<first;++i)if(source[i]!=witness[i])return VM_MODULE_ERROR_SOURCE;
    pl_u32 tail=bytes-first;
    if(tail){if(sources.pending_pages!=2u)return VM_MODULE_ERROR_TAIL;
        if(sources.pending_next.generation!=generation)return VM_MODULE_ERROR_SOURCE;
        source=resident.bytes+sources.pending_next.offset;
        for(pl_u32 i=0u;i<tail;++i)if(source[i]!=witness[first+i])return VM_MODULE_ERROR_SOURCE;}
    return 0;
}
static int directory_source_entry(pl_u64 generation,pl_u64 ticket,vm_module_entry *out)
{
    if(!directory_boundary() || !sources.pending || !artifact_module_offset || !artifact_module_bytes)
        return VM_MODULE_ERROR_INPUT;
    if(generation!=resident.generation || generation!=artifact_directory.generation
            || artifact_directory.stage!=VM_DIRECTORY_READY || ticket!=artifact_directory.ticket
            || ticket!=artifact_module_ticket)return VM_DIRECTORY_ERROR_STALE;
    if(artifact_directory.resource.object.kind!=ARTIFACT_RESOURCE_WASM_MODULE
            || !private_record(artifact_module_offset,artifact_module_bytes)
            || sources.pending_page.generation!=generation || sources.pending_entry!=((machine_state *)(uintptr_t)state_offset)->rip)
        return VM_MODULE_ERROR_INPUT;
    if(!artifact_module.code_bytes){
        int status=vm_module_open((const pl_u8 *)(uintptr_t)artifact_module_offset,artifact_module_bytes,&artifact_module);
        if(status)return status;
    }
    pl_u64 page=artifact_directory.resource.coordinate;
    if(page>=artifact_module.pages)return VM_MODULE_ERROR_INPUT;
    pl_u32 offset=(pl_u32)(page*4096u)+(pl_u32)(sources.pending_entry&4095u);
    vm_module_entry selected;
    int status=vm_module_find(&artifact_module,generation,offset,sources.pending_limit,&selected);
    if(status)return status;
    const pl_u8 *witness=artifact_module.source+offset;
    status=source_witness_match(witness,selected.source_bytes,generation);if(status)return status;
    *out=selected;return 0;
}
int vm_directory_module_plan(pl_u64 generation,pl_u64 ticket,pl_u32 target)
{
    if(!private_record(target,MACHINE_SOURCE_PLAN_BYTES)
            || !separate(target,MACHINE_SOURCE_PLAN_BYTES,artifact_module_offset,artifact_module_bytes))return VM_MODULE_ERROR_INPUT;
    vm_module_entry selected;int status=directory_source_entry(generation,ticket,&selected);
    if(status)return status;
    pl_u8 *plan=(pl_u8 *)(uintptr_t)target;
    vm_memory_store(plan,artifact_module_offset,4u);vm_memory_store(plan+4u,artifact_module.code_bytes,4u);
    vm_memory_store(plan+8u,selected.export_rank,4u);vm_memory_store(plan+12u,artifact_module.count,4u);
    return 0;
}
int vm_directory_source_publish(pl_u64 generation,pl_u64 ticket,pl_u32 row_target)
{
    if(!execution_record(row_target,sizeof(vm_execution_row))
            || !separate(row_target,sizeof(vm_execution_row),artifact_module_offset,artifact_module_bytes))return VM_MODULE_ERROR_INPUT;
    vm_module_entry selected;int status=directory_source_entry(generation,ticket,&selected);
    if(status)return status;
    /* Install the exact C-selected engine export in the reserved typed slot
     * first. As with ordinary trusted compilation, table identity/type and
     * immutable buffer pinning are supervisor obligations, not opcode checks. */
    return vm_sources_publish(&sources,selected.source_bytes,selected.source_instructions,selected.operand_binding,
        (vm_execution_row *)(uintptr_t)row_target);
}

/* Bind the source identity from an authenticated exact (0,0) source row.
 * The source object need not be copied/readAll to learn its identity. This is
 * selected-root authorization context, not an ELF/optimizer proof verifier. */
int vm_directory_image_source_bind(pl_u64 generation,pl_u64 ticket)
{
    if(!directory_boundary())return VM_DIRECTORY_ERROR_BUSY;
    if(generation!=resident.generation || generation!=artifact_directory.generation
        || ticket!=artifact_directory.ticket || !ticket)return VM_DIRECTORY_ERROR_STALE;
    if((artifact_directory.stage!=VM_DIRECTORY_OBJECT && artifact_directory.stage!=VM_DIRECTORY_READY)
        || artifact_directory.resource.object.kind!=ARTIFACT_RESOURCE_IMAGE_SOURCE
        || artifact_directory.resource.key.major || artifact_directory.resource.key.minor)return VM_MODULE_ERROR_INPUT;
    for(pl_u32 i=0u;i<32u;++i)artifact_image_source[i]=artifact_directory.resource.object.digest[i];
    artifact_image_source_bound=1u;return 0;
}
static int directory_image_entry(pl_u64 generation,pl_u64 ticket,vm_module_entry *out)
{
    if(!directory_boundary() || !sources.pending || !artifact_image_source_bound
        || !artifact_module_offset || !artifact_module_bytes)return VM_MODULE_ERROR_INPUT;
    if(generation!=resident.generation || generation!=artifact_directory.generation
        || artifact_directory.stage!=VM_DIRECTORY_READY || ticket!=artifact_directory.ticket
        || ticket!=artifact_module_ticket)return VM_DIRECTORY_ERROR_STALE;
    if(artifact_directory.resource.object.kind!=ARTIFACT_RESOURCE_IMAGE_MODULE
        || !private_record(artifact_module_offset,artifact_module_bytes)
        || sources.pending_page.generation!=generation || sources.pending_entry!=((machine_state *)(uintptr_t)state_offset)->rip)
        return VM_MODULE_ERROR_INPUT;
    if(!artifact_image.code_bytes){int status=vm_image_module_open((const pl_u8 *)(uintptr_t)artifact_module_offset,
        artifact_module_bytes,&artifact_image);if(status)return status;}
    for(pl_u32 i=0u;i<32u;++i)if(artifact_image.digest[i]!=artifact_image_source[i])return VM_MODULE_ERROR_SOURCE;
    const pl_u8 *last=artifact_image.ranges+(artifact_image.range_count-1u)*MACHINE_IMAGE_RANGE_BYTES;
    if(pl_read_u64(artifact_image.ranges)!=artifact_directory.resource.key.minor
        || pl_read_u64(last)+pl_read_u16(last+8u)!=artifact_directory.resource.coordinate)return VM_MODULE_ERROR_SOURCE;
    vm_module_entry selected;int status=vm_image_module_find(&artifact_image,artifact_directory.key.minor,sources.pending_limit,&selected);
    if(!status)status=source_witness_match(artifact_image.source+selected.source_offset,selected.source_bytes,generation);
    if(status)return status;
    *out=selected;return 0;
}
int vm_directory_image_plan(pl_u64 generation,pl_u64 ticket,pl_u32 target)
{
    if(!private_record(target,MACHINE_IMAGE_PLAN_BYTES)
        || !separate(target,MACHINE_IMAGE_PLAN_BYTES,artifact_module_offset,artifact_module_bytes))return VM_MODULE_ERROR_INPUT;
    vm_module_entry selected;int status=directory_image_entry(generation,ticket,&selected);if(status)return status;
    pl_u8 *plan=(pl_u8 *)(uintptr_t)target;
    vm_memory_store(plan,artifact_module_offset,4u);vm_memory_store(plan+4u,artifact_image.code_bytes,4u);
    vm_memory_store(plan+8u,sources.pending_entry-artifact_directory.key.minor,8u);
    vm_memory_store(plan+16u,artifact_image.count,4u);vm_memory_store(plan+20u,0u,4u);return 0;
}
/* Explicit reuse of the still-pinned immutable verified object. The caller
 * must cancel/query/rebind before overwriting its buffer. This changes only
 * the requested coordinate inside the already authenticated interval; the
 * payload ticket is not a new transport reply or source execution lease. */
int vm_directory_image_select(pl_u64 generation,pl_u64 coordinate)
{
    if(!directory_boundary() || !sources.pending || artifact_directory.stage!=VM_DIRECTORY_READY
        || artifact_directory.resource.object.kind!=ARTIFACT_RESOURCE_IMAGE_MODULE)return VM_MODULE_ERROR_INPUT;
    if(generation!=resident.generation || generation!=artifact_directory.generation)return VM_DIRECTORY_ERROR_STALE;
    if(coordinate<artifact_directory.resource.key.minor || coordinate>=artifact_directory.resource.coordinate)
        return VM_MODULE_ERROR_ABSENT;
    pl_index_key previous=artifact_directory.key;
    artifact_directory.key=(pl_index_key){artifact_directory.resource.key.major,coordinate};
    vm_module_entry selected;int status=directory_image_entry(generation,artifact_module_ticket,&selected);
    if(status)artifact_directory.key=previous;
    return status;
}
int vm_directory_image_publish(pl_u64 generation,pl_u64 ticket,pl_u32 row_target)
{
    if(!execution_record(row_target,sizeof(vm_execution_row))
        || !separate(row_target,sizeof(vm_execution_row),artifact_module_offset,artifact_module_bytes))return VM_MODULE_ERROR_INPUT;
    vm_module_entry selected;int status=directory_image_entry(generation,ticket,&selected);if(status)return status;
    return vm_sources_publish(&sources,selected.source_bytes,1u,0u,(vm_execution_row *)(uintptr_t)row_target);
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
static void after_guest_write(pl_u64 admitted)
{
    if (!resident.write_touched) return;
    /* Valid bits can only be removed during this serialized physical effect:
     * no guest import can publish a source. Equality therefore proves the
     * write is disjoint from ALL retained executable extents. The owned next
     * cut still rewalks the MMU and checks original context/physical identity.
     * Flat directories retain the coarse fence. A resumed source instruction
     * can use its exact still-owned row, not a fresh virtual lookup: the next
     * cut still rewalks the MMU after any data/page-table modification. */
    pl_u32 rank=run_source_rank;
    if(execution.continuation.slot){
        const vm_execution_row *latched=&execution.continuation;
        rank=latched->slot>=sources.first_slot?latched->slot-sources.first_slot:VM_SOURCE_ROWS;
        if(rank<VM_SOURCE_ROWS){const vm_execution_row *owned=&sources.rows[rank].row;
            if(owned->entry!=latched->entry||owned->source_bytes!=latched->source_bytes
                ||owned->source_instructions!=latched->source_instructions||owned->slot!=latched->slot
                ||owned->operand_binding!=latched->operand_binding)rank=VM_SOURCE_ROWS;
        }
    }
    if (execution.select==source_entry && execution.generation==resident.generation
            && sources.generation==resident.generation&&rank<VM_SOURCE_ROWS
            && (admitted&(1ull<<rank)) && sources.valid==admitted) return;
    execution.generation=0u;
}

static int linear_address(pl_u64 *address, pl_u32 *access)
{
    return vm_segment_address(segments_offset
        ? (const machine_segments *)(uintptr_t)segments_offset : NULL,address,access);
}
machine_result vm_access(pl_u32 port, pl_u64 address, pl_u32 bytes,
                          pl_u32 access, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !private_port(port) || linear_address(&address,&access))
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
    pl_u64 admitted=sources.valid;
    resident.write_touched = 0u;
    machine_result result = vm_mmu_access(&resident, port - arena_base, &context, address, bytes, access, value);
    after_guest_write(admitted);
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
    run_source_rank=VM_SOURCE_ROWS;
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    sources.pending = 0u;
    vm_supply_reset(&supply); vm_memory_abort(&resident);
    if (delivery.stage || execution.continuation.slot || clock_boundary_pending() || !segments_offset || !private_port(port)
            || !private_record(view_target,2u*sizeof(vm_code_page))
            || !separate(view_target,2u*sizeof(vm_code_page),port,sizeof(machine_memory_port))
            || !execution_record(row_target,sizeof(vm_execution_row))) return MACHINE_RESULT_ENTRY_MAP;
    if (activity.state == MACHINE_ACTIVITY_HALTED)
        return vm_memory_load((const pl_u8 *)(uintptr_t)port,8u) == resident.generation
            ? MACHINE_RESULT_HALT : MACHINE_RESULT_STALE_GENERATION;
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
#ifdef VM_SOURCE_PROFILE
    int was_full=sources.valid==~0ull;
    source_profile_before(&page,entry,limit);
#endif
    int status = vm_sources_probe(&sources,&page,entry,limit,&row);
#ifdef VM_SOURCE_PROFILE
    if(status==1){++source_profile[1];if(was_full)++source_profile[2];}
#endif
    if (status < 0) return MACHINE_RESULT_ENTRY_MAP;
    if (status == 2) return source_tail(port,view_target,row_target);
    page.offset += arena_base;
    vm_code_page *views = (vm_code_page *)(uintptr_t)view_target;
    views[0] = page; views[1] = (vm_code_page){0};
    *(vm_execution_row *)(uintptr_t)row_target = row;
    return status ? MACHINE_RESULT_RESOLVE_RIP : 0u;
}
/* A trusted cold FETCH or C-validated module TAIL descriptor authorizes this
 * extension. The host cannot guess an extent; C never decodes/executes x86. */
machine_result vm_source_extend(pl_u32 port, pl_u32 view_target, pl_u32 row_target)
{
    run_source_rank=VM_SOURCE_ROWS;
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply); vm_memory_abort(&resident);
    if (delivery.stage || execution.continuation.slot || !segments_offset || !private_port(port)
            || !private_record(view_target,2u*sizeof(vm_code_page))
            || !separate(view_target,2u*sizeof(vm_code_page),port,sizeof(machine_memory_port))
            || !execution_record(row_target,sizeof(vm_execution_row))) return MACHINE_RESULT_ENTRY_MAP;
    return source_tail(port,view_target,row_target);
}
int vm_source_publish(pl_u32 bytes, pl_u32 instructions, pl_u32 operand_binding, pl_u32 row_target)
{
    run_source_rank=VM_SOURCE_ROWS;
    if (delivery.stage || table_frontier.stage || execution.continuation.slot
            || !execution_record(row_target,sizeof(vm_execution_row))) {
        sources.pending = 0u; return -1;
    }
    return vm_sources_publish(&sources,bytes,instructions,operand_binding,
        (vm_execution_row *)(uintptr_t)row_target);
}
int vm_sources_reset(void)
{
    run_source_rank=VM_SOURCE_ROWS;
    if (delivery.stage || table_frontier.stage || execution.continuation.slot) return -1;
    vm_sources_open(&sources,resident.generation,vm_slot_min());
    vm_execution_close(&execution); return 0;
}
machine_result vm_reserve(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !private_port(port) || linear_address(&address,&access)) return MACHINE_RESULT_ENTRY_MAP;
    vm_mmu_context context = cpu_context();
    pl_u64 admitted=sources.valid;
    resident.write_touched = 0u;
    machine_result result = vm_mmu_reserve(&resident,port - arena_base,&context,address,bytes,access);
    after_guest_write(admitted);
    return memory_result(port,result);
}
machine_result vm_commit(pl_u32 port, pl_u64 value)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    if (delivery.stage || !private_port(port)) { vm_memory_abort(&resident); return MACHINE_RESULT_ENTRY_MAP; }
    pl_u64 admitted=sources.valid;
    resident.write_touched = 0u;
    machine_result result = vm_memory_commit(&resident,port - arena_base,value);
    after_guest_write(admitted);
    return result;
}
machine_result vm_write_begin(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply); vm_memory_abort(&resident);
    if (delivery.stage || !private_port(port) || linear_address(&address,&access)) return MACHINE_RESULT_ENTRY_MAP;
    pl_u64 admitted=sources.valid;
    vm_mmu_context context=cpu_context(); resident.write_touched=0u;
    machine_result result=vm_mmu_write_begin(&resident,port-arena_base,&context,address,bytes,access);
    after_guest_write(admitted);
    return memory_result(port,result);
}
machine_result vm_write_word(pl_u32 port, pl_u32 offset, pl_u32 bytes, pl_u64 value)
{
    if (table_frontier.stage || delivery.stage || !private_port(port)) {
        vm_memory_abort(&resident); return MACHINE_RESULT_ENTRY_MAP;
    }
    pl_u64 admitted=sources.valid;
    resident.write_touched=0u;
    machine_result result=vm_memory_write_word(&resident,port-arena_base,offset,bytes,value);
    after_guest_write(admitted);
    return result;
}
machine_result vm_write_end(pl_u32 port)
{
    if (table_frontier.stage || delivery.stage || !private_port(port)) {
        vm_memory_abort(&resident); return MACHINE_RESULT_ENTRY_MAP;
    }
    return vm_memory_write_end(&resident,port-arena_base);
}
machine_result vm_read_pair(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);vm_memory_abort(&resident);
    if (delivery.stage || !private_record(port,sizeof(machine_memory_pair_port))
            || linear_address(&address,&access)
            || !bytes || bytes>16u || (access & ~39u) || (access & 3u)!=MACHINE_MEMORY_READ)
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u64 admitted=sources.valid;
    vm_mmu_context context=cpu_context();resident.write_touched=0u;
    machine_result result=vm_mmu_read_pair(&resident,port-arena_base,&context,address,bytes,access);
    after_guest_write(admitted);
    return memory_result(port,result);
}
machine_result vm_read_extent(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);vm_memory_abort(&resident);
    if (delivery.stage || !private_record(port,sizeof(machine_memory_extent_port))
            || linear_address(&address,&access))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u64 admitted=sources.valid;
    vm_mmu_context context=cpu_context();resident.write_touched=0u;
    machine_result result=vm_mmu_read_extent(&resident,port-arena_base,&context,address,bytes,access);
    after_guest_write(admitted);
    if (!result) {
        machine_memory_extent_port *view=(machine_memory_extent_port *)(uintptr_t)port;
        for(pl_u32 i=0u;i<2u;++i)if(view->lengths[i])view->offsets[i]+=arena_base;
    }
    return memory_result(port,result);
}

machine_result vm_reserve_pair(pl_u32 port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply); vm_memory_abort(&resident);
    if (delivery.stage || !private_record(port,sizeof(machine_memory_pair_port))
            || linear_address(&address,&access)
            || bytes!=16u || (access & ~7u) || (access & 3u)!=3u) return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 record[16]; vm_mmu_context context=cpu_context();
    pl_u64 admitted=sources.valid;
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
    after_guest_write(admitted);
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
    pl_u64 admitted=sources.valid;
    resident.write_touched=0u;
    machine_result result=vm_memory_commit_record(&resident,port-arena_base,record,16u);
    after_guest_write(admitted);
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
    pl_u32 mode=transfer&(MACHINE_IO_CHECK|MACHINE_IO_CHECKED);transfer&=~(pl_u32)(MACHINE_IO_CHECK|MACHINE_IO_CHECKED);
    if(mode&&(!execution.in_call||active_call_port!=port||mode==(MACHINE_IO_CHECK|MACHINE_IO_CHECKED)))return MACHINE_RESULT_ENTRY_MAP;
    if(mode==MACHINE_IO_CHECK){machine_result checked=vm_io_check(&io_admission,&resident,port-arena_base,
        (const machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,coordinate,transfer);
        if(resident.write_touched)execution.generation=0u;
        return memory_result(port,checked);}
    machine_result result = mode==MACHINE_IO_CHECKED?vm_io_checked_transfer(&io_admission,&resident,port-arena_base,
        (const machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,
        &clock_owner,&pit,&pic,&rtc,&uart,&console_owner,&post,coordinate,transfer,value):vm_io_transfer(&resident,port - arena_base,
        (const machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,
        &clock_owner,&pit,&pic,&rtc,&uart,&console_owner,&post,coordinate,transfer,value);
    if (resident.write_touched) execution.generation = 0u;
    return result == machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_CLOCK)
        || result == machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_CONSOLE)
        ? result : memory_result(port,result);
}
/* PC deferred FERR wire only. Arithmetic/status publication belongs to the
 * emitted ordinary function, never an x87 operation decoded by this VM. */
machine_result vm_floating_wait(pl_u32 port)
{
    if(!private_port(port)||!segments_offset||delivery.stage||table_frontier.stage
        ||resident.reservation.parts||clock_boundary_pending())return MACHINE_RESULT_ENTRY_MAP;
    if(vm_memory_load((const pl_u8 *)(uintptr_t)port,8u)!=resident.generation)return MACHINE_RESULT_STALE_GENERATION;
    const machine_state *state=(const machine_state *)(uintptr_t)state_offset;
    /* Deferred FERR is valid for FWAIT with EM or TS/!MP too. The emitted
     * operation has already applied its own #NM guard; NE selects #MF. */
    if((state->cr0&32u)||(state->cr0&10u)==10u||!(state->x87_status&~(pl_u32)state->x87_control&63u))return MACHINE_RESULT_ENTRY_MAP;
    if(vm_pic_set_irq(&pic,13u,1u))return MACHINE_RESULT_ENTRY_MAP;
    return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_FLOATING);
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
/* Clock delivery is independent of guest IN/OUT/RDTSC. No emitted function
 * imports this supervisor API. A completed quantum frontier can sample time;
 * it cannot interrupt a pinned resource/I/O instruction,
 * fault/page/console/table frontier, reservation or cold source admission. */
machine_result vm_clock_poll(pl_u32 port, pl_u64 generation)
{
    if (!private_port(port) || delivery.stage || table_frontier.stage || supply.generation
            || sources.pending || (execution.continuation.slot && !execution.continuation_interruptible) || resident.reservation.parts
            || vm_console_pending(&console_owner)) return MACHINE_RESULT_ENTRY_MAP;
    if (generation!=resident.generation || vm_memory_load((const pl_u8 *)(uintptr_t)port,8u)!=generation)
        return MACHINE_RESULT_STALE_GENERATION;
    return vm_clock_boundary_sample(&clock_owner,&resident,port-arena_base,
        (const machine_state *)(uintptr_t)state_offset);
}
/* Host timer transport gets one least eligible deadline, not a device model
 * or per-tick polling stream. The ordinary clock ticket pins the halted RIP
 * until its timestamp reply is consumed; cancellation uses existing scope. */
machine_result vm_idle_clock(pl_u32 port,pl_u64 generation)
{
    if(!private_port(port) || delivery.stage || table_frontier.stage || supply.generation
            || sources.pending || execution.continuation.slot || resident.reservation.parts
            || vm_console_pending(&console_owner) || activity.state!=MACHINE_ACTIVITY_HALTED)
        return MACHINE_RESULT_ENTRY_MAP;
    if(generation!=resident.generation || vm_memory_load((const pl_u8 *)(uintptr_t)port,8u)!=generation)
        return MACHINE_RESULT_STALE_GENERATION;
    const machine_state *state=(const machine_state *)(uintptr_t)state_offset;
    if(clock_owner.stage)return vm_clock_boundary_sample(&clock_owner,&resident,port-arena_base,state);
    if(!(state->rflags&0x200u) || (segments_offset
            && ((const machine_segments *)(uintptr_t)segments_offset)->interrupt_shadow))return MACHINE_RESULT_HALT;
    if(vm_pic_pending(&pic))return MACHINE_RESULT_RESOLVE_RIP;
    pl_u64 next=0u,candidate;int found=0;
    if(vm_pic_can_irq(&pic,0u) && vm_pit_next_irq(&pit,&candidate)){next=candidate;found=1;}
    if(vm_pic_can_irq(&pic,8u) && vm_rtc_next_irq(&rtc,&candidate) && (!found || candidate<next)){next=candidate;found=1;}
    if(vm_pic_can_irq(&pic,4u) && vm_uart_next_irq(&uart,&candidate) && (!found || candidate<next)){next=candidate;found=1;}
    if(!found)return MACHINE_RESULT_HALT;
    if(next<=clock_owner.now)return MACHINE_RESULT_ENTRY_MAP;
    machine_result result=vm_clock_boundary_sample(&clock_owner,&resident,port-arena_base,state);
    if(result==machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_CLOCK))
        vm_memory_store((pl_u8 *)(uintptr_t)port+offsetof(machine_memory_port,value),next,8u);
    return result;
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
    if (delivery.stage || !segments_offset || !private_port(port)
            || linear_address(&address,&access)) return MACHINE_RESULT_ENTRY_MAP;
    const machine_segments *segments = (const machine_segments *)(uintptr_t)segments_offset;
    pl_u32 cs = segments->cache[MACHINE_SEGMENT_CS].attributes;
    if (!(cs & 0x2000u) || (cs & (0x4000u | MACHINE_SEGMENT_UNUSABLE))) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_table_transfer(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,&table_frontier,address,rank,access);
    if (resident.write_touched) execution.generation = 0u;
    return memory_result(port,result);
}

machine_result vm_transfer(pl_u32 port,pl_u32 word,pl_u64 target,pl_u32 selector,pl_u64 next_rip)
{
    if(table_frontier.stage||!segments_offset||!private_port(port)||(delivery.stage&&delivery.kind!=VM_EVENT_TRANSFER))return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);vm_memory_abort(&resident);pl_u64 admitted=sources.valid;resident.write_touched=0u;
    machine_result result=vm_far_transfer(&resident,port-arena_base,(machine_state *)(uintptr_t)state_offset,
        (machine_segments *)(uintptr_t)segments_offset,&delivery,word,target,selector,next_rip);
    if(!result)execution.generation=0u;else after_guest_write(admitted);
    return memory_result(port,result);
}
machine_result vm_return(pl_u32 port, pl_u32 return_word)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_far_return(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,return_word);
    if (!result || resident.write_touched) execution.generation = 0u;
    return memory_result(port,result);
}

/* A pending architectural event is owned by C across physical page waits.
 * This export is not an import available to emitted guest functions. */
machine_result vm_fault(pl_u32 port)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (!segments_offset || !private_port(port)
            || (delivery.stage && delivery.kind!=VM_EVENT_FAULT)) return MACHINE_RESULT_ENTRY_MAP;
    vm_execution_close(&execution);
    resident.write_touched = 0u;
    machine_result result = vm_fault_enter(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,&delivery);
    if (!result) activity.state = MACHINE_ACTIVITY_RUNNING;
    return memory_result(port,result);
}
/* Generic software-exception boundary; no opcode or handler address enters
 * the VM. The emitted caller publishes retirement after successful delivery. */
machine_result vm_software_interrupt(pl_u32 port, pl_u32 event, pl_u64 next_rip)
{
    if (table_frontier.stage || !segments_offset || !private_port(port)
            || !machine_software_valid(event)
            || (delivery.stage && delivery.kind!=(event&MACHINE_SOFTWARE_DEBUG_TRAP?VM_EVENT_DEBUG_TRAP:VM_EVENT_SOFTWARE))) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply); vm_memory_abort(&resident); resident.write_touched=0u;
    machine_result result=vm_software_interrupt_enter(&resident,port-arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,
        &delivery,event,next_rip);
    if (!result || resident.write_touched) execution.generation=0u;
    return memory_result(port,result);
}
machine_result vm_iret(pl_u32 port,pl_u32 return_word)
{
    if (table_frontier.stage) return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    if (delivery.stage || !segments_offset || !private_port(port)) return MACHINE_RESULT_ENTRY_MAP;
    resident.write_touched = 0u;
    machine_result result = vm_interrupt_return(&resident,port - arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,return_word);
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
    /* A suspended one-instruction entry owns its address context. Do not
     * interpose a host MSR operation before its page/console wait resumes;
     * refusal must leave that entry's supply ticket and reservation intact.
     * RDMSR/WRMSR themselves never suspend on guest memory in this profile. */
    if (table_frontier.stage || execution.continuation.slot) return MACHINE_RESULT_ENTRY_MAP;
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

machine_result vm_system(pl_u32 port, pl_u32 operation, pl_u64 next_rip)
{
    vm_supply_reset(&supply);vm_memory_abort(&resident);
    if(table_frontier.stage || delivery.stage || !segments_offset || !private_port(port))
        return MACHINE_RESULT_ENTRY_MAP;
    machine_result result=vm_system_transfer(&resident,port-arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,operation,next_rip);
    if(!result)execution.generation=0u;
    return result;
}

machine_result vm_descriptor(pl_u32 port,pl_u32 selector)
{
    if(table_frontier.stage)return MACHINE_RESULT_ENTRY_MAP;
    vm_supply_reset(&supply);vm_memory_abort(&resident);
    if(delivery.stage||!segments_offset||!private_record(port,sizeof(machine_memory_pair_port)))return MACHINE_RESULT_ENTRY_MAP;
    pl_u64 admitted=sources.valid;
    resident.write_touched=0u;
    machine_result result=vm_descriptor_query(&resident,port-arena_base,
        (const machine_state *)(uintptr_t)state_offset,(const machine_segments *)(uintptr_t)segments_offset,selector);
    after_guest_write(admitted);
    return memory_result(port,result);
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
    run_source_rank=VM_SOURCE_ROWS;
    if (delivery.stage || table_frontier.stage || clock_boundary_pending() || vm_console_pending(&console_owner)) return -1;
    vm_supply_reset(&supply);
    vm_memory_abort(&resident);
    vm_execution_close(&execution);
    source_limit = 0u;
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
    if (!status) execution.activity = &activity;
    /* A published source rank is already the immutable metadata owner. Do
     * not copy/sort its cohort into another directory. Flat trusted test
     * directories use this same dispatcher; they are not ISA fallbacks. */
    if (!status && count==1u && sources.valid && directory_rows->slot>=sources.first_slot
            && directory_rows->slot-sources.first_slot<VM_SOURCE_ROWS) {
        pl_u32 rank=directory_rows->slot-sources.first_slot;
        const vm_source_row *owned=sources.rows+rank;
        if (sources.generation!=generation || !(sources.valid & (1ull<<rank))
                || directory_rows->entry!=owned->row.entry
                || directory_rows->source_bytes!=owned->row.source_bytes
                || directory_rows->source_instructions!=owned->row.source_instructions
                || directory_rows->operand_binding!=owned->row.operand_binding) {
            vm_execution_close(&execution); return -1;
        }
        /* Rebinding a retained owned row still rewalks permissions/context.
         * The newest successful demand supplies its current policy; an older
         * explicit row retains its own original admitted cap. Neither choice
         * admits different code or bypasses the execution fetch boundary. */
        source_limit=sources.newest==rank && sources.demand_limit>=owned->row.source_instructions
            && sources.demand_limit<=1024u ? sources.demand_limit : owned->limit;
        execution.rows=&owned->row;
        execution.select=source_entry;
    }
    return status;
}
typedef struct { pl_u32 port; } execution_owner;
/* This is a row/fetch owner for the existing dispatcher, not another engine.
 * The original execution context is never reopened between warm cuts. Each
 * lookup borrows current executable MMU pages and matches exact physical
 * offsets; a missing identity yields to the cold compiler without eviction.
 * Only a known crossing instruction admits a tail. The ordinary C write
 * observer, IRQ boundary and latched-instruction owner remain authoritative. */
static machine_result source_entry(void *pointer, pl_u64 address, const vm_execution_row **row)
{
    run_source_rank=VM_SOURCE_ROWS;
    const execution_owner *owner=pointer;
    machine_result result=pending_boundary(owner->port);
    if (result) return result;
    if (!segments_offset) return MACHINE_RESULT_ENTRY_MAP;
    const machine_segments *segments=(const machine_segments *)(uintptr_t)segments_offset;
    pl_u32 cs=segments->cache[MACHINE_SEGMENT_CS].attributes;
    if (segments->version!=MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow>MACHINE_SHADOW_STI
            || !(cs & 0x2000u) || (cs & (0x4000u | MACHINE_SEGMENT_UNUSABLE))) return MACHINE_RESULT_ENTRY_MAP;
    pl_u32 limit=segments->interrupt_shadow ? 1u : source_limit;
    vm_code_page first,next;
    vm_mmu_context context=cpu_context();
    vm_supply_reset(&supply); vm_memory_abort(&resident); resident.write_touched=0u;
    result=vm_mmu_code_page(&resident,owner->port-arena_base,&context,address,&first);
    if (resident.write_touched) execution.generation=0u;
    if (result) return memory_result(owner->port,result);
    if (execution.generation!=resident.generation) return MACHINE_RESULT_STALE_GENERATION;
    int status=vm_sources_reuse(&sources,&first,0,address,limit,row);
    if (status==2) {
        resident.write_touched=0u;
        result=vm_mmu_code_page(&resident,owner->port-arena_base,&context,first.address+4096u,&next);
        if (resident.write_touched) execution.generation=0u;
        if (result) return memory_result(owner->port,result);
        if (execution.generation!=resident.generation) return MACHINE_RESULT_STALE_GENERATION;
        status=vm_sources_reuse(&sources,&first,&next,address,limit,row);
    }
    if (status<0) return MACHINE_RESULT_ENTRY_MAP;
    if (status==1) *row=0; /* Exact prefix yield; no eviction or cold reservation. */
    else {
        run_source_rank=(*row)->slot-sources.first_slot;
        source_demands |= 1ull << run_source_rank;
        ++source_admissions;
    }
    return 0u;
}
static machine_result interrupt_boundary(pl_u32 port)
{
    vm_supply_reset(&supply);
    resident.write_touched=0u;
    machine_result result=vm_interrupt_enter(&resident,port-arena_base,
        (machine_state *)(uintptr_t)state_offset,(machine_segments *)(uintptr_t)segments_offset,&delivery,&pic);
    /* Hardware entry changes control without retiring the interrupted cut.
     * Its new RIP is admitted afresh, never executed through the old row. */
    vm_execution_cancel(&execution);
    if (!result) {
        activity.state = MACHINE_ACTIVITY_RUNNING;
        run_interrupted=1u;
    }
    return memory_result(port,result ? result : MACHINE_RESULT_RESOLVE_RIP);
}
static machine_result pending_boundary(pl_u32 port)
{
    /* A partial descriptor store may only resume its latched compiled entry.
     * Fresh source admission remains fenced; events cannot interpose here. */
    if ((table_frontier.stage && !execution.continuation.slot) || clock_boundary_pending() || !private_port(port)
            || (vm_console_pending(&console_owner) && !execution.continuation.slot)) return MACHINE_RESULT_ENTRY_MAP;
    if (delivery.stage) {
        if (delivery.kind==VM_EVENT_INTERRUPT) return interrupt_boundary(port);
        return (delivery.kind==VM_EVENT_SOFTWARE||delivery.kind==VM_EVENT_DEBUG_TRAP||delivery.kind==VM_EVENT_TRANSFER)
            && execution.continuation.slot ? 0u : MACHINE_RESULT_ENTRY_MAP;
    }
    const machine_state *state=(const machine_state *)(uintptr_t)state_offset;
    if ((!execution.continuation.slot || (execution.continuation_interruptible && !table_frontier.stage
            && !vm_console_pending(&console_owner))) && (state->rflags&0x200u) && vm_pic_pending(&pic)
            && (!segments_offset || !((const machine_segments *)(uintptr_t)segments_offset)->interrupt_shadow))
        return segments_offset ? interrupt_boundary(port) : MACHINE_RESULT_ENTRY_MAP;
    return activity.state == MACHINE_ACTIVITY_HALTED ? MACHINE_RESULT_HALT : 0u;
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
static machine_result call_entry(void *pointer, pl_u32 slot, pl_u64 binding, pl_u32 operand_binding)
{
    const execution_owner *owner = pointer;
    /* Wasm C function pointers are table indices. All admitted functions have
     * machine_entry type; a wrong type/bounds is a host admission bug/trap,
     * never an x86 instruction fallback. Slots stay pinned during vm_run. */
    machine_entry entry = (machine_entry)(uintptr_t)slot;
    vm_memory_abort(&resident);
    if(!execution.continuation.slot)io_admission=(vm_io_admission){0};
    active_call_port=owner->port;
    machine_result result = entry(state_offset, owner->port, binding, operand_binding);
    active_call_port=0u;
    const machine_state *state=(const machine_state *)(uintptr_t)state_offset;
    if(!(state->x87_status&~(pl_u32)state->x87_control&63u))vm_pic_set_irq(&pic,13u,0u);
    vm_memory_abort(&resident);
    return result;
}
machine_result vm_checkpoint(pl_u32 port,pl_u32 operation,pl_u64 cursor,pl_u64 frontier)
{
    if(port!=active_call_port||!execution.in_call||!private_port(port)
        ||!private_record(port,sizeof(machine_memory_checkpoint_port))
        ||!separate(port,sizeof(machine_memory_checkpoint_port),state_offset,sizeof(machine_state)))return MACHINE_RESULT_ENTRY_MAP;
    return vm_execution_checkpoint(&execution,(machine_memory_checkpoint_port *)(uintptr_t)port,operation,cursor,frontier);
}
machine_result vm_run(pl_u32 port, pl_u64 generation, pl_u32 maximum_cuts)
{
    vm_memory_abort(&resident);
    source_demands=0u;source_admissions=run_interrupted=0u;
    run_source_rank=VM_SOURCE_ROWS;
    execution.completed = 0u; execution.retired = 0u;
    if (!private_port(port))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    execution_owner owner = { port };
    if (vm_memory_load((const pl_u8 *)(uintptr_t)port,8u) != resident.generation)
        return machine_result_make(MACHINE_RESULT_STALE_GENERATION,0u);
    if (generation!=resident.generation) return MACHINE_RESULT_STALE_GENERATION;
    if (!maximum_cuts || maximum_cuts>VM_EXECUTION_MAX_QUANTUM)
        return MACHINE_RESULT_ENTRY_MAP;
    machine_result boundary=pending_boundary(port);
    if (boundary) return boundary;
    machine_result result=vm_execution_run(&execution, (machine_state *)(uintptr_t)state_offset,
                             generation, maximum_cuts, fetch_entry, call_entry, &owner);
    if (result==MACHINE_RESULT_RESOLVE_RIP || result==MACHINE_RESULT_STALE_GENERATION)
        run_source_rank=VM_SOURCE_ROWS;
    return result;
}
pl_u32 vm_completed(void) { return execution.completed; }
pl_u64 vm_source_retired(void) { return execution.retired; }
/* Read-only supervisor observations of the LAST run. They are demand hints,
 * not source, execution or table admission authority. No retained history. */
pl_u64 vm_source_demands(void) { return source_demands; }
pl_u32 vm_source_admissions(void) { return source_admissions; }
pl_u32 vm_run_interrupted(void) { return run_interrupted; }
/* Failed-cut observation only. Borrow the last still-owned physical source,
 * never rewalk the MMU, overwrite a fault request or refresh cache demand.
 * A completed/missing/revoked/latched row is deliberately unavailable. This
 * API is not an import of generated guest functions or execution authority. */
int vm_run_source(pl_u32 port, pl_u64 generation, pl_u32 target)
{
    if (!private_port(port) || generation!=resident.generation || sources.generation!=generation
            || vm_memory_load((const pl_u8 *)(uintptr_t)port,8u)!=generation
            || execution.continuation.slot || run_source_rank>=VM_SOURCE_ROWS || !(sources.valid&(1ull<<run_source_rank))
            || !private_record(target,2u*sizeof(vm_code_page))
            || !separate(target,2u*sizeof(vm_code_page),port,sizeof(machine_memory_port))) return -1;
    const vm_source_row *source=sources.rows+run_source_rank;
    const machine_state *state=(const machine_state *)(uintptr_t)state_offset;
    if (state->rip!=source->row.entry) return -1;
    vm_code_page *views=(vm_code_page *)(uintptr_t)target;
    pl_u64 address=source->row.entry&~4095ull;
    views[0]=(vm_code_page){address,generation,arena_base+source->offset,4096u};
    views[1]=(source->row.entry&4095u)+source->row.source_bytes>4096u
        ? (vm_code_page){address+4096u,generation,arena_base+source->next_offset,4096u}
        : (vm_code_page){0};
    return (int)source->row.source_bytes;
}
