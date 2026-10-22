#include "internal/quotient.h"

enum weighted_field {
    WEIGHTED_OBSERVATION = 0,
    WEIGHTED_WORK = 1,
    WEIGHTED_FRONTIER = 2,
};

static pl_u8 weighted_byte(const pl_weighted_future_machine *machine,
                           pl_u32 state, pl_u32 arm,
                           pl_u32 field, pl_u32 shift)
{
    if (field == WEIGHTED_OBSERVATION)
        return (pl_u8)(machine->observation[state] >> shift);
    pl_u64 at = (pl_u64)state * machine->arms + arm;
    if (field == WEIGHTED_FRONTIER)
        return (pl_u8)(machine->frontier[at] >> shift);
    return (pl_u8)(machine->residual_work[at] >> shift);
}

static void weighted_radix_pass(const pl_weighted_future_machine *machine,
                                const pl_u32 *source, pl_u32 *target,
                                pl_u32 arm, pl_u32 field, pl_u32 shift)
{
    pl_u32 count[256] = { 0u };
    for (pl_u32 index = 0u; index < machine->states; ++index)
        ++count[weighted_byte(
            machine, source[index], arm, field, shift)];
    pl_u32 begin = 0u;
    for (pl_u32 byte = 0u; byte < 256u; ++byte) {
        pl_u32 size = count[byte];
        count[byte] = begin;
        begin += size;
    }
    for (pl_u32 index = 0u; index < machine->states; ++index) {
        pl_u32 state = source[index];
        pl_u8 byte = weighted_byte(machine, state, arm, field, shift);
        target[count[byte]++] = state;
    }
}

static void weighted_radix_field(
    const pl_weighted_future_machine *machine,
    pl_u32 **source, pl_u32 **target,
    pl_u32 arm, pl_u32 field, pl_u32 bytes)
{
    for (pl_u32 byte = 0u; byte < bytes; ++byte) {
        weighted_radix_pass(
            machine, *source, *target, arm, field, byte * 8u);
        pl_u32 *swap = *source;
        *source = *target;
        *target = swap;
    }
}

static int weighted_same(const pl_weighted_future_machine *machine,
                         pl_u32 left, pl_u32 right)
{
    if (machine->observation[left] != machine->observation[right])
        return 0;
    for (pl_u32 arm = 0u; arm < machine->arms; ++arm) {
        pl_u64 left_at = (pl_u64)left * machine->arms + arm;
        pl_u64 right_at = (pl_u64)right * machine->arms + arm;
        if (machine->residual_work[left_at]
                != machine->residual_work[right_at]
                || machine->frontier[left_at]
                   != machine->frontier[right_at])
            return 0;
    }
    return 1;
}

int pl_weighted_future_workspace_measure(pl_u32 states, pl_u32 arms,
                                         pl_u32 *bytes)
{
    return pl_finite_future_workspace_measure(states, arms, bytes);
}

int pl_weighted_future_project(
    const pl_weighted_future_machine *machine,
    const pl_weighted_future_workspace *workspace,
    pl_weighted_future_projection *out)
{
    if (out) *out = (pl_weighted_future_projection){ 0 };
    if (!machine || !workspace || !out || !machine->states
            || !machine->arms || !machine->observation_classes
            || !machine->frontier_classes || !machine->observation
            || !machine->successor || !machine->residual_work
            || !machine->frontier || !workspace->state_class
            || !workspace->order || !workspace->immediate_class
            || workspace->state_capacity < machine->states
            || machine->states > 0xffffffffu / machine->arms)
        return PL_ERROR_FUTURE_RANGE;

    for (pl_u32 state = 0u; state < machine->states; ++state) {
        if (machine->observation[state] >= machine->observation_classes)
            return PL_ERROR_FUTURE_RANGE;
        workspace->order[state] = state;
        for (pl_u32 arm = 0u; arm < machine->arms; ++arm) {
            pl_u64 at = (pl_u64)state * machine->arms + arm;
            if (machine->successor[at] >= machine->states
                    || machine->frontier[at]
                       >= machine->frontier_classes)
                return PL_ERROR_FUTURE_RANGE;
        }
    }

    pl_u32 *source = workspace->order;
    pl_u32 *target = workspace->state_class;
    for (pl_u32 arm = machine->arms; arm > 0u; --arm) {
        pl_u32 current = arm - 1u;
        weighted_radix_field(
            machine, &source, &target, current,
            WEIGHTED_FRONTIER, 4u);
        weighted_radix_field(
            machine, &source, &target, current,
            WEIGHTED_WORK, 8u);
    }
    weighted_radix_field(
        machine, &source, &target, 0u, WEIGHTED_OBSERVATION, 4u);
    if (source != workspace->order)
        for (pl_u32 index = 0u; index < machine->states; ++index)
            workspace->order[index] = source[index];

    pl_u32 classes = 0u;
    pl_u32 previous = 0u;
    for (pl_u32 index = 0u; index < machine->states; ++index) {
        pl_u32 state = workspace->order[index];
        if (!index || !weighted_same(machine, previous, state))
            ++classes;
        workspace->state_class[state] = classes - 1u;
        previous = state;
    }
    if (workspace->immediate_class != workspace->state_class)
        for (pl_u32 state = 0u; state < machine->states; ++state)
            workspace->immediate_class[state] =
                workspace->state_class[state];

    pl_finite_future_machine future_machine = {
        machine->states, classes, machine->arms,
        workspace->immediate_class, machine->successor,
    };
    pl_finite_future_workspace future_workspace = {
        workspace->state_class, workspace->state_capacity,
        workspace->scratch, workspace->scratch_bytes,
    };
    pl_finite_future_projection future = { 0 };
    int status = pl_finite_future_project(
        &future_machine, &future_workspace, &future);
    if (status) return status;
    *out = (pl_weighted_future_projection){ classes, future };
    return 0;
}

static pl_u32 lower_bound_u64(const pl_u64 *values, pl_u32 count,
                              pl_u64 value)
{
    pl_u32 low = 0u, high = count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (values[middle] < value) low = middle + 1u;
        else high = middle;
    }
    return low;
}

int pl_byte_future_project(const pl_byte_future_machine *machine,
                           const pl_byte_future_workspace *workspace,
                           pl_byte_future_projection *out)
{
    if (!machine || !workspace || !out || !machine->state_count
            || machine->initial >= machine->state_count
            || !machine->outputs || !machine->transitions
            || !workspace->state_class || !workspace->class_outputs
            || !workspace->byte_classes
            || workspace->state_capacity < machine->state_count)
        return PL_ERROR_FUTURE_RANGE;
    for (pl_u32 state = 0u; state < machine->state_count; ++state)
        workspace->state_class[state] = PL_FUTURE_ABSENT;

    const pl_u32 *row = machine->transitions
                      + (pl_u64)machine->initial
                        * PL_FUTURE_BYTE_ALPHABET;
    workspace->state_class[machine->initial] = 0u;
    for (pl_u32 byte = 0u; byte < PL_FUTURE_BYTE_ALPHABET; ++byte) {
        if (row[byte] >= machine->state_count)
            return PL_ERROR_FUTURE_RANGE;
        workspace->state_class[row[byte]] = 0u;
    }
    pl_u32 reachable = 0u;
    for (pl_u32 state = 0u; state < machine->state_count; ++state)
        if (workspace->state_class[state] != PL_FUTURE_ABSENT)
            ++reachable;
    if (!reachable || reachable > PL_FUTURE_BYTE_ALPHABET + 1u)
        return PL_ERROR_FUTURE;

    for (pl_u32 state = 0u; state < machine->state_count; ++state) {
        if (workspace->state_class[state] == PL_FUTURE_ABSENT) continue;
        const pl_u32 *candidate = machine->transitions
                                + (pl_u64)state
                                  * PL_FUTURE_BYTE_ALPHABET;
        for (pl_u32 byte = 0u; byte < PL_FUTURE_BYTE_ALPHABET; ++byte)
            if (candidate[byte] != row[byte])
                return PL_ERROR_FUTURE_LAW;
    }

    pl_u32 classes = 0u;
    for (pl_u32 state = 0u; state < machine->state_count; ++state) {
        if (workspace->state_class[state] == PL_FUTURE_ABSENT) continue;
        pl_u64 current = machine->outputs[state];
        pl_u32 at = lower_bound_u64(
            workspace->class_outputs, classes, current);
        if (at < classes && workspace->class_outputs[at] == current)
            continue;
        for (pl_u32 move = classes; move > at; --move)
            workspace->class_outputs[move] =
                workspace->class_outputs[move - 1u];
        workspace->class_outputs[at] = current;
        ++classes;
    }
    if (!classes || classes > reachable) return PL_ERROR_FUTURE;
    for (pl_u32 state = 0u; state < machine->state_count; ++state) {
        if (workspace->state_class[state] == PL_FUTURE_ABSENT) continue;
        pl_u32 rank = lower_bound_u64(
            workspace->class_outputs, classes, machine->outputs[state]);
        if (rank >= classes
                || workspace->class_outputs[rank]
                   != machine->outputs[state])
            return PL_ERROR_FUTURE;
        workspace->state_class[state] = rank;
    }
    for (pl_u32 byte = 0u; byte < PL_FUTURE_BYTE_ALPHABET; ++byte) {
        pl_u32 target = row[byte];
        pl_u32 rank = workspace->state_class[target];
        if (rank == PL_FUTURE_ABSENT || rank >= classes)
            return PL_ERROR_FUTURE;
        workspace->byte_classes[byte] = rank;
    }

    *out = (pl_byte_future_projection){
        .reachable_states = reachable,
        .classes = classes,
        .initial_class = workspace->state_class[machine->initial],
        .checked_transitions =
            (pl_u64)reachable * PL_FUTURE_BYTE_ALPHABET,
        .retained_transition_cells = 0u,
    };
    return 0;
}

int pl_byte_csr_project(const pl_byte_future_projection *future,
                        const pl_u64 *offsets,
                        pl_u64 records,
                        pl_u64 data_size,
                        pl_u32 reduce_kind,
                        pl_byte_csr_projection *out)
{
    if (!future || !offsets || !records || !data_size || !out)
        return PL_ERROR_FUTURE_RANGE;
    if (future->retained_transition_cells != 0u
            || !future->reachable_states || !future->classes)
        return PL_ERROR_FUTURE_LAW;
    if (reduce_kind > PL_FUTURE_REDUCE_OR_U64)
        return PL_ERROR_FUTURE_RANGE;
    if (offsets[0] != 0u || offsets[records] != data_size)
        return PL_ERROR_FUTURE_CSR;
    for (pl_u64 record = 0u; record < records; ++record) {
        pl_u64 begin = offsets[record];
        pl_u64 end = offsets[record + 1u];
        if (begin >= end || end > data_size)
            return PL_ERROR_FUTURE_CSR;
    }

    *out = (pl_byte_csr_projection){
        .records = records,
        .data_bytes = data_size,
        .checked_offsets = records + 1u,
        .address_bits = 8u,
        .value_slots = PL_FUTURE_BYTE_ALPHABET,
        .retained_transition_cells = 0u,
        .retained_root_slots = 0u,
        .retained_presence_planes =
            reduce_kind == PL_FUTURE_REDUCE_NONE ? 1u : 0u,
        .reduce_kind = reduce_kind,
    };
    return 0;
}
