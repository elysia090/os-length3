#include <vm/execution.h>
#include <stdio.h>
#include <string.h>
static vm_execution execution;
static machine_state state;
static machine_segments segments;
static vm_execution_row rows[2];
static pl_u32 calls, fetches, stop, revoke, revoke_fetch, load_ss, call_fault;
static pl_u32 yielding, called_slot;
static pl_u64 fetched[2];
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr, "execution: line %u\n", (unsigned)__LINE__); ++failures; } } while (0)
static machine_result fetch(void *owner, pl_u64 address)
{
    (void)owner;
    fetched[fetches++ % 2u] = address;
    if (revoke_fetch) execution.generation = 0u;
    return fetches == stop ? machine_result_make(MACHINE_RESULT_FAULT, 14u) : 0u;
}
static machine_result call(void *owner, pl_u32 slot)
{
    (void)owner; ++calls;
    called_slot = slot;
    if (call_fault) return 107u;
    if (yielding) {
        if (revoke) execution.generation = 0u;
        return machine_result_make(MACHINE_RESULT_BARRIER,
            yielding == 1u ? MACHINE_BARRIER_QUANTUM : yielding == 3u ? MACHINE_BARRIER_CLOCK : MACHINE_BARRIER_RESOURCE);
    }
    state.rip = slot == 1u ? rows[1].entry : rows[0].entry;
    ++state.retired;
    if (revoke) execution.generation = 0u;
    if (load_ss) segments.interrupt_shadow = 1u;
    return machine_result_make(MACHINE_RESULT_RESOLVE_RIP, 0u);
}
static machine_result run(pl_u64 generation, pl_u32 budget)
{ return vm_execution_run(&execution, &state, generation, budget, fetch, call, 0); }
static void reset(void)
{
    memset(&state, 0, sizeof state); calls = fetches = stop = revoke = revoke_fetch = 0u;
    load_ss = call_fault = yielding = called_slot = 0u; segments = (machine_segments){0};
    segments.version = MACHINE_SEGMENTS_ABI_VERSION;
    rows[0] = (vm_execution_row){ 0x400000u, 1u, 1u, 1u, 0u };
    rows[1] = (vm_execution_row){ 0x400001u, 1u, 1u, 2u, 0u };
    state.rip = rows[0].entry;
    EXPECT(!vm_execution_open(&execution, rows, 2u, 9u, &state));
}
int main(void)
{
    for (pl_u32 bit=0u;bit<8u;++bit) {
        reset(); state.system[MACHINE_SYSTEM_DR0+7u]=1ull<<bit;
        EXPECT(run(9u,1u)==6u && !calls && !fetches && !state.retired);
        yielding=1u; execution.continuation=rows[0]; execution.continuation_generation=9u;
        EXPECT(run(9u,1u)==6u && !calls && !fetches && !state.retired);
    }
    reset(); execution.segments = &segments; segments.interrupt_shadow = 1u;
    rows[0].source_bytes = rows[0].source_instructions = 2u;
    EXPECT(run(9u,1u) == 6u && !calls && !fetches && segments.interrupt_shadow == 1u);
    reset(); execution.segments = &segments; segments.interrupt_shadow = 1u;
    call_fault = 1u; EXPECT(run(9u,1u) == 107u && !state.retired && segments.interrupt_shadow == 1u);
    call_fault = 0u; load_ss = 1u;
    EXPECT(run(9u,1u) == 1u && state.retired == 1u && !segments.interrupt_shadow);
    reset(); execution.segments = &segments; load_ss = 1u;
    EXPECT(run(9u,1u) == 1u && segments.interrupt_shadow == 1u);
    load_ss = 0u; EXPECT(run(9u,1u) == 1u && !segments.interrupt_shadow);
    reset(); EXPECT(run(9u, 100000u) == 6u && !calls && !fetches);
    EXPECT(run(8u, 2u) == 5u && !calls && !fetches);
    EXPECT(run(9u, 2u) == 1u && calls == 2u && fetches == 2u);
    EXPECT(execution.completed == 2u && execution.retired == 2u && state.retired == 2u);
    reset(); stop = 2u; EXPECT(run(9u, 2u) == 115u && calls == 1u && state.retired == 1u);
    reset(); state.rip = 7u; EXPECT(run(9u, 2u) == 6u && !fetches && !calls);
    reset(); revoke = 1u; EXPECT(run(9u, 1u) == 5u && calls == 1u && state.retired == 1u);
    EXPECT(execution.completed == 1u && execution.retired == 1u);
    EXPECT(run(9u, 2u) == 5u && calls == 1u);
    reset(); yielding = revoke = 1u; execution.segments = &segments; segments.interrupt_shadow = 1u;
    EXPECT(run(9u,1u) == 10u && fetches == 1u && calls == 1u);
    EXPECT(!execution.completed && !execution.retired && !state.retired && segments.interrupt_shadow == 1u);
    /* Source bytes/borrowed rows may have changed by this instruction's own
     * stores. Its latched slot, not a fresh fetch/row lookup, must resume. */
    rows[0].slot = 2u;
    EXPECT(run(8u,1u) == 5u && calls == 1u);
    EXPECT(run(9u,1u) == 10u && fetches == 1u && calls == 2u && called_slot == 1u);
    yielding = 0u;
    EXPECT(run(9u,1u) == 5u && calls == 3u && fetches == 1u && state.retired == 1u);
    EXPECT(execution.completed == 1u && execution.retired == 1u && !segments.interrupt_shadow);
    EXPECT(run(9u,1u) == 5u && calls == 3u);
    reset(); yielding = 2u;
    EXPECT(run(9u,1u) == 2u && execution.continuation.slot == 1u);
    EXPECT(run(9u,1u) == 2u && calls == 2u && fetches == 1u);
    reset(); yielding = 3u;
    EXPECT(run(9u,1u) == 18u && calls == 1u && fetches == 1u && !state.retired);
    EXPECT(run(9u,1u) == 18u && calls == 2u && fetches == 1u && !state.retired);
    yielding = 0u;
    EXPECT(run(9u,1u) == 1u && calls == 3u && fetches == 1u && state.retired == 1u);
    reset(); yielding = 2u;
    EXPECT(run(9u,1u) == 2u);
    call_fault = 1u;
    EXPECT(run(9u,1u) == 107u && !execution.continuation.slot && !execution.continuation_generation);
    reset(); yielding = 1u;
    EXPECT(run(9u,1u) == 10u);
    state.rip++;
    EXPECT(run(9u,1u) == 6u && calls == 1u && !execution.continuation.slot);
    for (pl_u32 word = 0u; word < 5u; ++word) {
        reset(); yielding = 1u; EXPECT(run(9u,1u) == 10u);
        if (word == 0u) ++state.cr0;
        else if (word == 1u) ++state.cr3;
        else if (word == 2u) ++state.cr4;
        else if (word == 3u) ++state.efer;
        else ++state.system[MACHINE_SYSTEM_CS];
        EXPECT(run(9u,1u) == 5u && calls == 1u && !execution.continuation.slot);
    }
    reset(); yielding = 1u; EXPECT(run(9u,1u) == 10u);
    vm_execution_close(&execution);
    EXPECT(run(9u,1u) == 5u && calls == 1u && !execution.continuation.slot);
    EXPECT(!vm_execution_open(&execution,rows,2u,10u,&state));
    EXPECT(run(9u,1u) == 5u && calls == 1u);
    EXPECT(run(10u,1u) == 10u && calls == 2u && fetches == 2u);
    reset(); revoke_fetch = 1u;
    EXPECT(run(9u, 1u) == 5u && !calls && !state.retired);
    for (pl_u32 word = 0u; word < 5u; ++word) {
        reset();
        if (word == 0u) ++state.cr0;
        else if (word == 1u) ++state.cr3;
        else if (word == 2u) ++state.cr4;
        else if (word == 3u) ++state.efer;
        else ++state.system[MACHINE_SYSTEM_CS];
        EXPECT(run(9u, 1u) == 5u && !calls && !fetches);
    }
    reset(); rows[0] = (vm_execution_row){0x400ffeu, 4u, 1u, 1u, 0u};
    rows[1].entry = 0x401002u; state.rip = rows[0].entry;
    EXPECT(!vm_execution_open(&execution, rows, 2u, 9u, &state)); stop = 2u;
    EXPECT(run(9u, 1u) == 115u && !calls && !state.retired);
    EXPECT(fetched[0] == 0x400ffeu && fetched[1] == 0x401000u);
    rows[0].source_instructions = 2u;
    EXPECT(vm_execution_open(&execution, rows, 2u, 9u, &state) == -1);
    EXPECT(run(9u, 1u) == 5u && !calls);
    for (pl_u32 i = 0u; i < 100000u; ++i) {
        reset(); rows[i & 1u].reserved = 1u;
        EXPECT(vm_execution_open(&execution, rows, 2u, 9u, &state) == -1);
        EXPECT(!execution.generation && !execution.rows);
    }
    reset(); rows[1].entry = rows[0].entry;
    EXPECT(vm_execution_open(&execution, rows, 2u, 9u, &state) == -1);
    reset(); rows[0].entry = 0x800000000000ull;
    EXPECT(vm_execution_open(&execution, rows, 2u, 9u, &state) == -1);
    reset(); rows[1].entry = ~0ull; rows[1].source_bytes = 2u;
    EXPECT(vm_execution_open(&execution, rows, 2u, 9u, &state) == -1);
    if (!failures) puts("Compiled execution directory/budget/fetch/revoke: green (not Linux boot)");
    return failures ? 1 : 0;
}
