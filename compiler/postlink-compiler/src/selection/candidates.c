/* Bounded immutable cost queries and exact Pareto-point quotient. */
#include "../internal/x86-selection.h"
#include "limits.h"

static int selection_precedes(const pl_x86_native_selection *left,
                              const pl_x86_native_selection *right)
{
    if (left->output_span != right->output_span)
        return left->output_span < right->output_span;
    if (left->output_work != right->output_work)
        return left->output_work < right->output_work;
    if (left->output_bytes != right->output_bytes)
        return left->output_bytes < right->output_bytes;
    return left->output_instructions < right->output_instructions;
}

static int candidate_count_valid(const pl_x86_native_candidates *candidates)
{
    return candidates && candidates->count
        && candidates->count <= PL_X86_NATIVE_MAX_CANDIDATES;
}

int pl_x86_candidates_minimum_span(
    const pl_x86_native_candidates *candidates, pl_u32 serial_span,
    pl_u32 *out)
{
    if (!candidate_count_valid(candidates) || !out) return PL_ERROR_X86_SELECT;
    pl_u32 minimum = U32_MAX_VALUE;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate =
            &candidates->candidate[index];
        if (!candidate->supported
                || candidate->output_span > U32_MAX_VALUE - serial_span)
            return PL_ERROR_X86_SELECT;
        pl_u32 span = candidate->output_span + serial_span;
        if (span < minimum) minimum = span;
    }
    *out = minimum;
    return 0;
}

int pl_x86_candidates_minimum_work(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work, pl_u32 span_ceiling,
    pl_u32 *out)
{
    if (!candidate_count_valid(candidates) || !out) return PL_ERROR_X86_SELECT;
    pl_u32 minimum = U32_MAX_VALUE;
    int found = 0;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate =
            &candidates->candidate[index];
        if (!candidate->supported
                || candidate->output_span > U32_MAX_VALUE - serial_span
                || candidate->output_work > U32_MAX_VALUE - serial_work)
            return PL_ERROR_X86_SELECT;
        if (candidate->output_span + serial_span > span_ceiling) continue;
        pl_u32 work = candidate->output_work + serial_work;
        if (!found || work < minimum) minimum = work;
        found = 1;
    }
    if (!found) return PL_ERROR_X86_SELECT;
    *out = minimum;
    return 0;
}

int pl_x86_candidates_select_under(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_u32 span_ceiling, pl_u32 work_ceiling,
    pl_x86_native_selection *out)
{
    if (!candidate_count_valid(candidates) || !out) return PL_ERROR_X86_SELECT;
    const pl_x86_native_selection *best = 0;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate =
            &candidates->candidate[index];
        if (!candidate->supported
                || candidate->output_span > U32_MAX_VALUE - serial_span
                || candidate->output_work > U32_MAX_VALUE - serial_work)
            return PL_ERROR_X86_SELECT;
        if (candidate->output_span + serial_span > span_ceiling
                || candidate->output_work + serial_work > work_ceiling)
            continue;
        if (!best || candidate->output_bytes < best->output_bytes
                || (candidate->output_bytes == best->output_bytes
                    && selection_precedes(candidate, best)))
            best = candidate;
    }
    if (!best) return PL_ERROR_X86_SELECT;
    *out = *best;
    return 0;
}

int pl_x86_candidates_select_joint_minimum(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_x86_native_selection *out,
    pl_u32 *minimum_span, pl_u32 *minimum_work)
{
    if (!out || !minimum_span || !minimum_work)
        return PL_ERROR_X86_SELECT;
    int status = pl_x86_candidates_minimum_span(
        candidates, serial_span, minimum_span);
    if (!status)
        status = pl_x86_candidates_minimum_work(
            candidates, serial_span, serial_work,
            U32_MAX_VALUE, minimum_work);
    if (!status) {
        status = pl_x86_candidates_select_under(
            candidates, serial_span, serial_work,
            *minimum_span, *minimum_work, out);
        if (status == PL_ERROR_X86_SELECT)
            status = PL_ERROR_X86_PARETO;
    }
    return status;
}

static int same_physical_cost(const pl_x86_native_selection *left,
                              const pl_x86_native_selection *right)
{
    return left->output_span == right->output_span
        && left->output_work == right->output_work;
}

static int strictly_dominates(const pl_x86_native_selection *left,
                              const pl_x86_native_selection *right)
{
    return left->output_span <= right->output_span
        && left->output_work <= right->output_work
        && (left->output_span < right->output_span
            || left->output_work < right->output_work);
}

int pl_x86_candidates_pareto_frontier(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_x86_native_selection *out, pl_u32 capacity, pl_u32 *count)
{
    if (!candidate_count_valid(candidates) || !out || !capacity || !count)
        return PL_ERROR_X86_SELECT;
    *count = 0u;
    /* The same serial cost is added to every point. It cannot change
     * dominance or ordering; validate once and compare immutable body costs.
     * Only survivor ranks are sorted, never full encoding/fixup proposals. */
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate = &candidates->candidate[index];
        if (!candidate->supported
                || candidate->output_span > U32_MAX_VALUE - serial_span
                || candidate->output_work > U32_MAX_VALUE - serial_work)
            return PL_ERROR_X86_SELECT;
    }
    pl_u32 rank[PL_X86_NATIVE_MAX_CANDIDATES], ranks = 0u;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate = &candidates->candidate[index];
        int dominated = 0;
        for (pl_u32 other = 0u; other < candidates->count; ++other) {
            if (other == index) continue;
            const pl_x86_native_selection *witness = &candidates->candidate[other];
            if (strictly_dominates(witness, candidate)
                    || (same_physical_cost(witness, candidate)
                        && (selection_precedes(witness, candidate)
                            || (!selection_precedes(candidate, witness)
                                && other < index)))) {
                dominated = 1;
                break;
            }
        }
        if (dominated) continue;
        pl_u32 at = ranks;
        while (at && selection_precedes(candidate,
                                        &candidates->candidate[rank[at - 1u]])) {
            rank[at] = rank[at - 1u];
            --at;
        }
        rank[at] = index;
        ++ranks;
    }
    if (!ranks || ranks > capacity) return PL_ERROR_X86_SELECT;
    for (pl_u32 at = 0u; at < ranks; ++at) {
        out[at] = candidates->candidate[rank[at]];
        out[at].output_span += serial_span;
        out[at].output_work += serial_work;
    }
    *count = ranks;
    return 0;
}
