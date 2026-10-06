#include <vm/execution.h>

static int canonical(pl_u64 address)
{ return address >> 47u == 0u || address >> 47u == 0x1ffffu; }
static pl_u64 context_word(const machine_state *state, pl_u32 rank)
{
    switch (rank) {
    case 0u: return state->cr0;
    case 1u: return state->cr3;
    case 2u: return state->cr4;
    case 3u: return state->efer;
    default: return state->system[MACHINE_SYSTEM_CS];
    }
}
void vm_execution_close(vm_execution *execution)
{ if (execution) *execution = (vm_execution){ 0 }; }
int vm_execution_open(vm_execution *execution, const vm_execution_row *rows,
                       pl_u32 count, pl_u64 generation, const machine_state *state)
{
    if (!execution) return -1;
    vm_execution_close(execution);
    if (!rows || !count || count > VM_EXECUTION_MAX_ROWS || !generation || !state) return -1;
    for (pl_u32 i = 0u; i < count; ++i) {
        const vm_execution_row *row = rows + i;
        if (!canonical(row->entry) || !row->source_bytes || row->source_bytes > 4096u
                || !row->source_instructions || row->source_instructions > 1024u
                || row->source_instructions > row->source_bytes || !row->slot
                || row->slot > VM_EXECUTION_MAX_ROWS
                || row->entry > ~0ull - (row->source_bytes - 1u)
                || !canonical(row->entry + row->source_bytes - 1u)
                || (i && rows[i - 1u].entry >= row->entry)) return -1;
        if ((row->entry >> 12u) != ((row->entry + row->source_bytes - 1u) >> 12u)
                && (row->source_instructions != 1u || row->source_bytes > 15u)) return -1;
    }
    execution->rows = rows; execution->count = count; execution->generation = generation;
    for (pl_u32 i = 0u; i < 5u; ++i) execution->context[i] = context_word(state, i);
    return 0;
}
static const vm_execution_row *find(const vm_execution *execution, pl_u64 rip)
{
    pl_u32 low = 0u, high = execution->count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (execution->rows[middle].entry < rip) low = middle + 1u;
        else high = middle;
    }
    return low < execution->count && execution->rows[low].entry == rip
         ? execution->rows + low : 0;
}
machine_result vm_execution_run(vm_execution *execution, machine_state *state,
                                pl_u64 generation, pl_u32 maximum_cuts,
                                vm_execution_fetch fetch, vm_execution_call call,
                                void *owner)
{
    if (execution) { execution->completed = 0u; execution->retired = 0u; }
    if (!execution || !state || !fetch || !call || !maximum_cuts
            || maximum_cuts > VM_EXECUTION_MAX_QUANTUM)
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    for (pl_u32 i = 0u; i < maximum_cuts; ++i) {
        /* Address breakpoint faults/traps are not yet owned. Refuse before
         * a fetch or call, including after a previous cut enabled DR7. */
        if (state->system[MACHINE_SYSTEM_DR0+7u]&255u) return MACHINE_RESULT_ENTRY_MAP;
        int resuming = execution->continuation.slot != 0u;
        if (!generation || (resuming ? execution->continuation_generation : execution->generation) != generation)
            return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
        for (pl_u32 j = 0u; j < 5u; ++j)
            if (execution->context[j] != context_word(state, j)) {
                execution->generation = 0u;
                execution->continuation = (vm_execution_row){0};
                execution->continuation_generation = 0u;
                return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
            }
        if (execution->activity) {
            if (execution->activity->state > MACHINE_ACTIVITY_HALTED)
                return MACHINE_RESULT_ENTRY_MAP;
            if (execution->activity->state == MACHINE_ACTIVITY_HALTED)
                return MACHINE_RESULT_HALT;
        }
        const vm_execution_row *row;
        machine_result result;
        if (resuming) row = &execution->continuation;
        else if (execution->select) {
            row = 0;
            result = execution->select(owner,state->rip,&row);
            if (result) return result;
            if (execution->generation != generation) return MACHINE_RESULT_STALE_GENERATION;
            if (!row) return MACHINE_RESULT_RESOLVE_RIP;
        } else row = find(execution,state->rip);
        if (!row) return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
        if (state->rip != row->entry) {
            execution->generation = 0u; execution->continuation = (vm_execution_row){0};
            execution->continuation_generation = 0u;
            return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
        }
        pl_u32 shadow = execution->segments ? execution->segments->interrupt_shadow : 0u;
        if (execution->segments && (execution->segments->version != MACHINE_SEGMENTS_ABI_VERSION
                || shadow > MACHINE_SHADOW_STI || (shadow && row->source_instructions != 1u)))
            return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
        if (!resuming && !execution->select) {
            result = fetch(owner, row->entry);
            if (result) return result;
            if (execution->generation != generation)
                return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
            if ((row->entry >> 12u) != ((row->entry + row->source_bytes - 1u) >> 12u)) {
                result = fetch(owner, (row->entry & ~4095ull) + 4096u);
                if (result) return result;
                if (execution->generation != generation)
                    return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
            }
        }
        pl_u32 source_instructions = row->source_instructions;
        result = call(owner, row->slot, row->entry, row->operand_binding);
        if (machine_result_kind(result) == MACHINE_RESULT_BARRIER
                && machine_result_payload(result) <= MACHINE_BARRIER_CONSOLE
                && source_instructions == 1u && state->rip == row->entry) {
            execution->continuation = *row; execution->continuation_generation = generation;
            return result;
        }
        execution->continuation = (vm_execution_row){0}; execution->continuation_generation = 0u;
        int halted = result == MACHINE_RESULT_HALT;
        if (halted) {
            if (!execution->activity || source_instructions != 1u
                    || state->rip != row->entry + row->source_bytes)
                return MACHINE_RESULT_ENTRY_MAP;
            execution->activity->state = MACHINE_ACTIVITY_HALTED;
        } else if (result != machine_result_make(MACHINE_RESULT_RESOLVE_RIP, 0u)) return result;
        if (shadow) execution->segments->interrupt_shadow = 0u;
        ++execution->completed;
        execution->retired += source_instructions;
        /* A payload write may revoke inside the compiled function's access
         * call. Never invoke the next entry, even at the quantum boundary. */
        if (execution->generation != generation)
            return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
        if (halted) return MACHINE_RESULT_HALT;
    }
    return machine_result_make(MACHINE_RESULT_RESOLVE_RIP, 0u);
}
