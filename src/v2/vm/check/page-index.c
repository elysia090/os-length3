#include <vm/memory.h>
#include "../core/memory-internal.h"
#include <stdio.h>
#include <string.h>

enum { CAPACITY = 2048 };
static _Alignas(8) pl_u8 arena[(CAPACITY + 1u) * 4096u];
static vm_memory_page pages[CAPACITY], saved_pages[CAPACITY];
static vm_memory_branch branches[CAPACITY - 1], saved_branches[CAPACITY - 1];
static vm_memory memory;
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"page-index: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static pl_u64 address(pl_u32 rank)
{
    pl_u64 page = (pl_u64)((rank * 701u) & (CAPACITY - 1u)) * 4096u;
    return page | (rank & 1u ? 0xffff800000000000ull : 0x100000000ull);
}
int main(void)
{
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,0u,CAPACITY,branches,9u));
    EXPECT(!vm_memory_find(&memory,address(0u)));
    for (pl_u32 rank = 0u; rank < CAPACITY; ++rank) {
        pl_u32 offset = (rank + 1u) * 4096u;
        EXPECT(!vm_memory_append(&memory,address(rank),offset,3u));
        const vm_memory_page *found = vm_memory_find(&memory,address(rank) + 4095u);
        EXPECT(found == pages + rank && found->offset == offset);
        EXPECT(vm_memory_append(&memory,address(rank),offset + 4096u,3u) == -1);
    }
    for (pl_u32 i = 0u; i < 200000u; ++i) {
        pl_u32 rank = i & (CAPACITY - 1u);
        EXPECT(vm_memory_find(&memory,address(rank) + (i & 4095u)) == pages + rank);
        EXPECT(!vm_memory_find(&memory,address(rank) ^ 0x10000000u));
    }
    /* Every path loses a strictly positive coordinate bit at each branch:
     * depth <= 52 for 4 KiB-aligned u64 coordinates, independent of R. */
    for (pl_u32 i = 0u; i < CAPACITY - 1u; ++i) {
        EXPECT(branches[i].bit >= 4096u && !(branches[i].bit & (branches[i].bit - 1u)));
        for (pl_u32 side = 0u; side < 2u; ++side) {
            pl_u32 ref = branches[i].child[side];
            if (ref & 0x80000000u) EXPECT((ref & 0x7fffffffu) < CAPACITY);
            else EXPECT(ref && ref < CAPACITY && branches[ref - 1u].bit < branches[i].bit);
        }
    }
    memcpy(saved_pages,pages,sizeof pages); memcpy(saved_branches,branches,sizeof branches);
    EXPECT(vm_memory_append(&memory,0x44440000u,4096u,3u) == -1);
    EXPECT(!memcmp(saved_pages,pages,sizeof pages) && !memcmp(saved_branches,branches,sizeof branches));
    EXPECT(memory.page_count == CAPACITY && memory.next_offset == sizeof arena);
    EXPECT(vm_memory_open(&memory,arena,sizeof arena,4096u,pages,0u,2u,NULL,9u) == -1);
    EXPECT(!memory.generation && !vm_memory_find(&memory,address(0u)));
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,0u,2u,branches,10u));
    EXPECT(vm_memory_append(&memory,0x44440001u,4096u,3u) == -1);
    EXPECT(vm_memory_append(&memory,0x44440000u,8192u,3u) == -1);
    memory.reservation.parts = 1u;
    EXPECT(vm_memory_append(&memory,0x44440000u,4096u,3u) == -1);
    vm_memory_abort(&memory);
    EXPECT(!vm_memory_append(&memory,0x44440000u,4096u,3u));
    EXPECT(vm_memory_append(&memory,0x800000000000ull,8192u,3u) == -1);
    EXPECT(vm_memory_append(&memory,0x55550000u,8192u,4u) == -1);
    memory.byte_count = 8192u;
    EXPECT(vm_memory_append(&memory,0x55550000u,8192u,3u) == -1);
    memory.byte_count = sizeof arena;
    EXPECT(!vm_memory_append(&memory,0x55550000u,8192u,3u));
    EXPECT(vm_memory_find(&memory,0x44440000u) == pages && vm_memory_find(&memory,0x55550000u) == pages + 1u);
    if (!failures) puts("physical page index: green (2048 unsorted appends; 200000 exact/colliding/missing lookups; no sorting)");
    return failures ? 1 : 0;
}
