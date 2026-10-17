#include "internal/x86-selection.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static pl_x86_native_candidates candidates;
static pl_x86_native_selection frontier[PL_X86_NATIVE_MAX_CANDIDATES];
static uint32_t random_state = 0xc001d00du;

static uint32_t random_word(void)
{
    random_state ^= random_state << 13u;
    random_state ^= random_state >> 17u;
    random_state ^= random_state << 5u;
    return random_state;
}

static int precedes(unsigned left, unsigned right)
{
    const pl_x86_native_selection *a = &candidates.candidate[left];
    const pl_x86_native_selection *b = &candidates.candidate[right];
    if (a->output_span != b->output_span) return a->output_span < b->output_span;
    if (a->output_work != b->output_work) return a->output_work < b->output_work;
    if (a->output_bytes != b->output_bytes) return a->output_bytes < b->output_bytes;
    if (a->output_instructions != b->output_instructions)
        return a->output_instructions < b->output_instructions;
    return left < right;
}

static int dominated(unsigned index)
{
    const pl_x86_native_selection *point = &candidates.candidate[index];
    for (unsigned other = 0; other < candidates.count; ++other) {
        if (other == index) continue;
        const pl_x86_native_selection *witness = &candidates.candidate[other];
        if (witness->output_span > point->output_span
                || witness->output_work > point->output_work) continue;
        if (witness->output_span < point->output_span
                || witness->output_work < point->output_work
                || precedes(other, index)) return 1;
    }
    return 0;
}

int main(void)
{
    candidates.count = 3u;
    for (unsigned i = 0; i < candidates.count; ++i) {
        candidates.candidate[i].supported = 1u;
        candidates.candidate[i].output_span = 2u;
        candidates.candidate[i].output_work = 3u;
        candidates.candidate[i].output_bytes = 4u;
        candidates.candidate[i].output_instructions = 3u;
        candidates.candidate[i].frame_alias_value = i;
    }
    pl_u32 count = 0;
    if (pl_x86_candidates_pareto_frontier(&candidates, 7u, 11u,
                                          frontier, 1u, &count)
            || count != 1u || frontier[0].frame_alias_value != 0u
            || frontier[0].output_span != 9u || frontier[0].output_work != 14u) {
        fputs("duplicate Pareto points were not quotiented\n", stderr);
        return 1;
    }
    for (unsigned trial = 0; trial < 20000u; ++trial) {
        candidates.count = 1u + random_word() % PL_X86_NATIVE_MAX_CANDIDATES;
        unsigned expected[PL_X86_NATIVE_MAX_CANDIDATES], expected_count = 0;
        pl_u32 serial_span = random_word() % 4u, serial_work = random_word() % 4u;
        for (unsigned i = 0; i < candidates.count; ++i) {
            pl_x86_native_selection *point = &candidates.candidate[i];
            point->supported = 1u;
            point->output_span = random_word() % 10u;
            point->output_work = random_word() % 10u;
            point->output_bytes = random_word() % 10u;
            point->output_instructions = random_word() % 10u;
            point->frame_alias_value = i;
        }
        for (unsigned i = 0; i < candidates.count; ++i) {
            if (dominated(i)) continue;
            unsigned at = expected_count++;
            while (at && precedes(i, expected[at - 1u])) {
                expected[at] = expected[at - 1u];
                --at;
            }
            expected[at] = i;
        }
        if (pl_x86_candidates_pareto_frontier(&candidates, serial_span, serial_work,
               frontier, PL_X86_NATIVE_MAX_CANDIDATES, &count)
                || count != expected_count) return 1;
        for (unsigned i = 0; i < count; ++i) {
            const pl_x86_native_selection *point = &candidates.candidate[expected[i]];
            if (frontier[i].frame_alias_value != expected[i]
                    || frontier[i].output_span != point->output_span + serial_span
                    || frontier[i].output_work != point->output_work + serial_work)
                return 1;
        }
        if (expected_count > 1u) {
            pl_x86_native_selection before = frontier[0];
            if (pl_x86_candidates_pareto_frontier(&candidates, serial_span, serial_work,
                       frontier, 1u, &count) != PL_ERROR_X86_SELECT
                    || count || memcmp(&before, &frontier[0], sizeof before))
                return 1;
        }
        pl_u32 minimum_span = UINT32_MAX, minimum_work = UINT32_MAX;
        for (unsigned i = 0; i < candidates.count; ++i) {
            if (candidates.candidate[i].output_span < minimum_span)
                minimum_span = candidates.candidate[i].output_span;
            if (candidates.candidate[i].output_work < minimum_work)
                minimum_work = candidates.candidate[i].output_work;
        }
        int joint = 0;
        for (unsigned i = 0; i < candidates.count; ++i)
            if (candidates.candidate[i].output_span == minimum_span
                    && candidates.candidate[i].output_work == minimum_work)
                joint = 1;
        pl_u32 actual_span = 0, actual_work = 0;
        pl_x86_native_selection chosen;
        int status = pl_x86_candidates_select_joint_minimum(&candidates,
            serial_span, serial_work, &chosen, &actual_span, &actual_work);
        if (status != (joint ? 0 : PL_ERROR_X86_PARETO)
                || actual_span != minimum_span + serial_span
                || actual_work != minimum_work + serial_work
                || (joint && (chosen.output_span != minimum_span
                              || chosen.output_work != minimum_work))) return 1;
        if (pl_x86_candidates_select_under(&candidates, serial_span, serial_work,
                                          UINT32_MAX, UINT32_MAX, &chosen)) return 1;
        unsigned best = 0;
        for (unsigned i = 1; i < candidates.count; ++i)
            if (candidates.candidate[i].output_bytes < candidates.candidate[best].output_bytes
                    || (candidates.candidate[i].output_bytes == candidates.candidate[best].output_bytes
                        && precedes(i, best))) best = i;
        if (chosen.frame_alias_value != best) return 1;
    }
    candidates.count = PL_X86_NATIVE_MAX_CANDIDATES + 1u;
    pl_u32 minimum = 0;
    if (pl_x86_candidates_minimum_span(&candidates, 0u, &minimum) != PL_ERROR_X86_SELECT
            || pl_x86_candidates_minimum_work(&candidates, 0u, 0u,
                     UINT32_MAX, &minimum) != PL_ERROR_X86_SELECT
            || pl_x86_candidates_select_under(&candidates, 0u, 0u,
                     UINT32_MAX, UINT32_MAX, frontier) != PL_ERROR_X86_SELECT
            || pl_x86_candidates_pareto_frontier(&candidates, 0u, 0u,
                     frontier, PL_X86_NATIVE_MAX_CANDIDATES, &count) != PL_ERROR_X86_SELECT)
        return 1;
    candidates.count = 1u;
    candidates.candidate[0].output_span = UINT32_MAX;
    candidates.candidate[0].output_work = UINT32_MAX;
    if (pl_x86_candidates_minimum_span(&candidates, 1u, &minimum) != PL_ERROR_X86_SELECT
            || pl_x86_candidates_pareto_frontier(&candidates, 1u, 1u,
                     frontier, 1u, &count) != PL_ERROR_X86_SELECT) return 1;
    /* Reject corrupted binding counts before indexing the fixed-size array. */
    frontier[0].fixup_count = PL_X86_NATIVE_MAX_FIXUPS + 1u;
    pl_u8 bytes[8] = { 0 };
    if (pl_x86_select_bind_fixup(bytes, sizeof bytes, frontier,
                  PL_X86_NATIVE_MAX_FIXUPS, 0u, 0u) != PL_ERROR_X86_SELECT)
        return 1;
    puts("selection policy: 20000 families, independent joint minima, duplicate quotient, atomic output, bounded counts and cost overflow green");
    return 0;
}
