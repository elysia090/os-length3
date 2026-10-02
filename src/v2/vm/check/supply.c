#include <vm/supply.h>
#include "../core/memory-internal.h"
#include <stdio.h>
#include <string.h>

static _Alignas(8) pl_u8 arena[16384], header[4096];
static vm_memory_page pages[3], saved[3];
static vm_memory_branch branches[2];
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"supply: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void pending(vm_page_supply *supply, vm_memory *memory, machine_state *state, pl_u64 address)
{
    vm_memory_store(arena,9u,8u); vm_memory_store(arena + 32u,address,8u);
    vm_memory_store(arena + 40u,8u,4u); vm_memory_store(arena + 44u,18u,4u);
    vm_supply_capture(supply,memory,state,0u,MACHINE_RESULT_BARRIER);
}
int main(void)
{
    vm_memory memory;
    vm_page_supply supply = {0};
    machine_state state = {.rip = 0x1000281u};
    vm_boot boot = {.header = header,.ram_bytes = 0x8000000u};
    vm_page_request request, sentinel;
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,0u,3u,branches,9u));
    memset(&request,0xa5,sizeof request); sentinel = request;
    EXPECT(vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request) == -1);
    EXPECT(!memcmp(&request,&sentinel,sizeof request));
    pending(&supply,&memory,&state,0x100000u);
    EXPECT(!vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request));
    EXPECT(request.ticket == 1u && request.target_offset == 4096u && !request.source_kind);
    arena[4096] = 0x5au;
    EXPECT(!vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request) && arena[4096] == 0x5au);
    EXPECT(vm_supply_commit(&supply,&memory,&state,0u,2u) == -1);
    ++state.rip; EXPECT(vm_supply_commit(&supply,&memory,&state,0u,1u) == -1); --state.rip;
    EXPECT(!vm_supply_commit(&supply,&memory,&state,0u,1u));
    EXPECT(vm_supply_commit(&supply,&memory,&state,0u,1u) == -1);
    pending(&supply,&memory,&state,0x100000u);
    EXPECT(vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request) == -1 && arena[4096] == 0x5au);
    pending(&supply,&memory,&state,0x200000u); memory.byte_count = 8192u;
    EXPECT(vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request) == -3);
    memory.byte_count = sizeof arena;
    EXPECT(!vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request) && request.ticket == 2u);
    vm_supply_reset(&supply); pending(&supply,&memory,&state,0x300000u);
    EXPECT(vm_supply_commit(&supply,&memory,&state,0u,2u) == -1);
    supply.sequence = ~0ull;
    EXPECT(vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request) == -1);
    EXPECT(supply.sequence == ~0ull); vm_supply_reset(&supply); EXPECT(supply.sequence == ~0ull);
    memcpy(saved,pages,sizeof pages);
    EXPECT(memory.page_count == 1u && !memcmp(saved,pages,sizeof pages) && arena[4096] == 0x5au);
    if (!failures) puts("page supply: green (retry, stale/context, replay, virgin slots, resident refusal, ticket wrap refusal)");
    return failures ? 1 : 0;
}
