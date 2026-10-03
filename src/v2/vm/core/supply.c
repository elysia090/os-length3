#include <vm/supply.h>
#include <vm/mmu.h>
#include "memory-internal.h"

static pl_u64 context_word(const machine_state *state, pl_u32 rank)
{
    switch (rank) {
    case 0u: return state->cr0;
    case 1u: return state->cr3;
    case 2u: return state->cr4;
    case 3u: return state->efer;
    case 4u: return state->system[MACHINE_SYSTEM_CS];
    default: return state->rip;
    }
}
void vm_supply_reset(vm_page_supply *supply)
{
    if (supply) { pl_u64 sequence = supply->sequence;
        *supply = (vm_page_supply){.sequence = sequence}; }
}
void vm_supply_capture(vm_page_supply *supply, const vm_memory *memory,
                        const machine_state *state, pl_u32 port, machine_result result)
{
    vm_supply_reset(supply);
    if (!supply || !memory || !state || !memory->generation || result != MACHINE_RESULT_BARRIER
            || (pl_u64)port + sizeof(machine_memory_port) > memory->reserved_bytes) return;
    const pl_u8 *record = memory->bytes + port;
    pl_u32 access = (pl_u32)vm_memory_load(record + 44u,4u);
    if (!(access & VM_MMU_PHYSICAL_REQUEST) || vm_memory_load(record,8u) != memory->generation) return;
    supply->port = port; supply->generation = memory->generation;
    supply->address = vm_memory_load(record + 32u,8u);
    supply->bytes = (pl_u32)vm_memory_load(record + 40u,4u); supply->access = access;
    for (pl_u32 i = 0u; i < 6u; ++i) supply->context[i] = context_word(state,i);
}
static int current(const vm_page_supply *supply, const vm_memory *memory,
                    const machine_state *state, pl_u32 port)
{
    if (!supply || !memory || !state || !supply->generation || supply->port != port
            || supply->generation != memory->generation || memory->reservation.parts
            || (pl_u64)port + sizeof(machine_memory_port) > memory->reserved_bytes) return 0;
    const pl_u8 *record = memory->bytes + port;
    if (vm_memory_load(record,8u) != supply->generation
            || vm_memory_load(record + 32u,8u) != supply->address
            || vm_memory_load(record + 40u,4u) != supply->bytes
            || vm_memory_load(record + 44u,4u) != supply->access) return 0;
    for (pl_u32 i = 0u; i < 6u; ++i)
        if (supply->context[i] != context_word(state,i)) return 0;
    return 1;
}
int vm_supply_prepare(vm_page_supply *supply, vm_memory *memory, const vm_boot *boot,
                       const machine_state *state, pl_u32 port, vm_page_request *request)
{
    if (!request || !current(supply,memory,state,port)) return -1;
    if (supply->prepared.ticket) { *request = supply->prepared; return 0; }
    pl_u64 page = supply->address & ~4095ull;
    if (!boot || !boot->header || memory->next_offset > 0xfffff000u
            || vm_memory_find(memory,page) || supply->sequence == ~0ull) return -1;
    if (memory->page_count >= memory->page_capacity) return -2;
    if (memory->next_offset + 4096u > memory->byte_count) return -3;
    vm_boot_source source;
    int kind = vm_boot_page(boot,page,memory->bytes + memory->next_offset,&source);
    if (kind < 0) return VM_SUPPLY_SOURCE_UNMAPPED;
    supply->prepared = (vm_page_request){memory->generation,page,source.offset,
        (pl_u32)memory->next_offset,source.bytes,(pl_u32)kind,3u,++supply->sequence};
    *request = supply->prepared;
    return 0;
}
int vm_supply_commit(vm_page_supply *supply, vm_memory *memory,
                      const machine_state *state, pl_u32 port, pl_u64 ticket)
{
    if (!current(supply,memory,state,port) || !ticket || ticket != supply->prepared.ticket) return -1;
    const vm_page_request *request = &supply->prepared;
    int status = request->source_kind == VM_BOOT_ROM
        ? vm_memory_append_rom(memory,request->address,request->target_offset)
        : vm_memory_append(memory,request->address,request->target_offset,request->rights);
    if (status) return -1;
    vm_supply_reset(supply);
    return 0;
}
