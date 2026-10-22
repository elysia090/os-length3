#include <support/future.h>

#include <support/arena.h>

static pl_u32 future_rank_bytes(pl_u32 states)
{
    return states <= 0x1000000u ? 3u : 4u;
}

static pl_u32 future_count_bytes(pl_u64 count)
{
    return count <= 0x1000000ull ? 3u : 4u;
}

static pl_u32 future_value_bytes(pl_u64 maximum)
{
    return maximum <= 0xffffffull ? 3u : 4u;
}

static void future_rank_write(pl_u8 *values, pl_u32 width,
                              pl_u32 index, pl_u32 value)
{
    pl_u8 *at = values + (pl_u64)index * width;
    at[0] = (pl_u8)value;
    at[1] = (pl_u8)(value >> 8u);
    at[2] = (pl_u8)(value >> 16u);
    if (width == 4u) at[3] = (pl_u8)(value >> 24u);
}

static pl_u32 future_rank_read(const pl_u8 *values, pl_u32 width,
                               pl_u32 index)
{
    const pl_u8 *at = values + (pl_u64)index * width;
    pl_u32 value = (pl_u32)at[0]
                 | (pl_u32)at[1] << 8u
                 | (pl_u32)at[2] << 16u;
    return width == 4u ? value | (pl_u32)at[3] << 24u : value;
}

static int future_workspace_add(pl_u64 *total, pl_u64 bytes)
{
    if (!total || *total > 0xfffffffffffffff8ull) return 0;
    pl_u64 aligned = (*total + 7u) & ~7ull;
    if (bytes > 0xffffffffull || aligned > 0xffffffffull - bytes)
        return 0;
    *total = aligned + bytes;
    return 1;
}

static int future_failure(pl_finite_future_projection *out, int status,
                          pl_u32 stage, pl_u64 value, pl_u64 limit)
{
    if (out) {
        out->failure_stage = stage;
        out->failure_value = value;
        out->failure_limit = limit;
    }
    return status;
}

int pl_finite_future_workspace_measure(pl_u32 states, pl_u32 arms,
                                       pl_u32 *bytes)
{
    if (!states || !arms || !bytes) return PL_ERROR_FUTURE_RANGE;
    pl_u64 pairs = (pl_u64)states * arms;
    pl_u64 offsets = (pl_u64)arms * (states + 1ull);
    pl_u64 total = 0u;
    /* Every transient state vector is a physical rank/value column.  Random
     * arithmetic does not make its stored representation a host u32: decode
     * one value, operate in a register, and write the minimum-width result. */
    for (pl_u32 array = 0u; array < 2u; ++array)
        if (!future_workspace_add(
                &total, (pl_u64)states * future_rank_bytes(states)))
            return PL_ERROR_FUTURE_RANGE;
    for (pl_u32 array = 0u; array < 4u; ++array)
        if (!future_workspace_add(
                &total, (pl_u64)states * future_value_bytes(states)))
            return PL_ERROR_FUTURE_RANGE;
    if (!future_workspace_add(
            &total, (pl_u64)states * future_rank_bytes(states)))
        return PL_ERROR_FUTURE_RANGE;
    pl_u64 membership = (pairs + 7u) >> 3u;
    if (!future_workspace_add(&total, offsets * sizeof(pl_u32))
            || !future_workspace_add(
                &total, pairs * future_rank_bytes(states))
            || !future_workspace_add(
                &total, pairs * future_count_bytes(pairs))
            || !future_workspace_add(&total, membership))
        return PL_ERROR_FUTURE_RANGE;
    *bytes = (pl_u32)total;
    return 0;
}

int pl_finite_future_project(const pl_finite_future_machine *machine,
                             const pl_finite_future_workspace *workspace,
                             pl_finite_future_projection *out)
{
    if (out) *out = (pl_finite_future_projection){ 0 };
    if (!machine || !workspace || !out || !machine->states
            || !machine->arms || !machine->observation_classes
            || machine->observation_classes > machine->states
            || !machine->observation || !machine->successor
            || !workspace->state_class
            || workspace->state_capacity < machine->states
            || !workspace->scratch)
        return future_failure(out, PL_ERROR_FUTURE_RANGE, 1u, 0u, 0u);
    pl_u32 required = 0u;
    int status = pl_finite_future_workspace_measure(
        machine->states, machine->arms, &required);
    if (status || workspace->scratch_bytes < required)
        return future_failure(
            out, PL_ERROR_FUTURE_RANGE, 2u,
            workspace->scratch_bytes, required);

    const pl_u32 states = machine->states;
    const pl_u32 arms = machine->arms;
    const pl_u32 pair_count = states * arms;
    const pl_u32 rank_width = future_rank_bytes(states);
    const pl_u32 value_width = future_value_bytes(states);
    const pl_u32 affected_width = rank_width;
    const pl_u32 inverse_width = rank_width;
    const pl_u32 work_width = future_count_bytes(pair_count);
    pl_arena arena = {
        workspace->scratch, workspace->scratch_bytes, 0u,
    };
    pl_u8 *members = pl_arena_take(&arena, states * rank_width);
    pl_u8 *position = pl_arena_take(&arena, states * rank_width);
    pl_u8 *class_begin = pl_arena_take(&arena, states * value_width);
    pl_u8 *class_size = pl_arena_take(&arena, states * value_width);
    pl_u8 *cursor = pl_arena_take(&arena, states * value_width);
    pl_u8 *marked_count = pl_arena_take(&arena, states * value_width);
    pl_u8 *affected = pl_arena_take(
        &arena, states * affected_width);
    pl_u32 *inverse_offset = pl_arena_take(
        &arena, arms * (states + 1u) * (pl_u32)sizeof(pl_u32));
    pl_u8 *inverse_state = pl_arena_take(
        &arena, pair_count * inverse_width);
    pl_u8 *work_queue = pl_arena_take(
        &arena, pair_count * work_width);
    pl_u32 membership_bytes = (pair_count + 7u) >> 3u;
    pl_u8 *work_present = pl_arena_take(&arena, membership_bytes);
    if (!members || !position || !class_begin || !class_size || !cursor
            || !marked_count || !affected || !inverse_offset
            || !inverse_state || !work_queue || !work_present) {
        pl_u64 missing = (!members ? 1u : 0u)
                       | (!position ? 2u : 0u)
                       | (!class_begin ? 4u : 0u)
                       | (!class_size ? 8u : 0u)
                       | (!cursor ? 16u : 0u)
                       | (!marked_count ? 32u : 0u)
                       | (!affected ? 64u : 0u)
                       | (!inverse_offset ? 128u : 0u)
                       | (!inverse_state ? 256u : 0u)
                       | (!work_queue ? 512u : 0u)
                       | (!work_present ? 1024u : 0u);
        return future_failure(
            out, PL_ERROR_FUTURE_RANGE, 3u, missing,
            ((pl_u64)arena.used << 32u) | arena.size);
    }

    for (pl_u32 index = 0u; index < states; ++index) {
        future_rank_write(class_begin, value_width, index, 0u);
        future_rank_write(class_size, value_width, index, 0u);
        future_rank_write(cursor, value_width, index, 0u);
        future_rank_write(marked_count, value_width, index, 0u);
    }
    for (pl_u32 index = 0u; index < membership_bytes; ++index)
        work_present[index] = 0u;

    for (pl_u32 state = 0u; state < states; ++state) {
        pl_u32 observation = machine->observation[state];
        if (observation >= machine->observation_classes)
            return future_failure(
                out, PL_ERROR_FUTURE_RANGE, 4u,
                ((pl_u64)state << 32u) | observation,
                machine->observation_classes);
        pl_u32 size = future_rank_read(
            class_size, value_width, observation);
        future_rank_write(
            class_size, value_width, observation, size + 1u);
        workspace->state_class[state] = observation;
    }
    pl_u32 begin = 0u;
    for (pl_u32 group = 0u;
            group < machine->observation_classes; ++group) {
        pl_u32 size = future_rank_read(class_size, value_width, group);
        if (!size)
            return future_failure(
                out, PL_ERROR_FUTURE_RANGE, 5u, group,
                machine->observation_classes);
        future_rank_write(class_begin, value_width, group, begin);
        future_rank_write(cursor, value_width, group, begin);
        begin += size;
    }
    if (begin != states) return PL_ERROR_FUTURE;
    for (pl_u32 state = 0u; state < states; ++state) {
        pl_u32 group = workspace->state_class[state];
        pl_u32 at = future_rank_read(cursor, value_width, group);
        future_rank_write(cursor, value_width, group, at + 1u);
        future_rank_write(members, rank_width, at, state);
        future_rank_write(position, rank_width, state, at);
    }

    for (pl_u32 arm = 0u; arm < arms; ++arm) {
        pl_u32 offset_base = arm * (states + 1u);
        for (pl_u32 index = 0u; index <= states; ++index)
            inverse_offset[offset_base + index] = 0u;
        for (pl_u32 state = 0u; state < states; ++state) {
            pl_u32 target = machine->successor[state * arms + arm];
            if (target >= states)
                return future_failure(
                    out, PL_ERROR_FUTURE_RANGE, 6u,
                    ((pl_u64)state << 32u) | target, states);
            ++inverse_offset[offset_base + target + 1u];
        }
        for (pl_u32 target = 0u; target < states; ++target)
            inverse_offset[offset_base + target + 1u] +=
                inverse_offset[offset_base + target];
        for (pl_u32 target = 0u; target < states; ++target)
            future_rank_write(
                cursor, value_width, target,
                inverse_offset[offset_base + target]);
        for (pl_u32 state = 0u; state < states; ++state) {
            pl_u32 target = machine->successor[state * arms + arm];
            pl_u32 at = future_rank_read(cursor, value_width, target);
            future_rank_write(
                inverse_state, inverse_width,
                arm * states + at, state);
            future_rank_write(cursor, value_width, target, at + 1u);
        }
    }

    pl_u32 work_head = 0u, work_tail = 0u, work_count = 0u;
    for (pl_u32 group = 0u;
            group < machine->observation_classes; ++group) {
        for (pl_u32 arm = 0u; arm < arms; ++arm) {
            pl_u32 item = group * arms + arm;
            future_rank_write(
                work_queue, work_width, work_tail, item);
            work_tail = (work_tail + 1u) % pair_count;
            ++work_count;
            work_present[item >> 3u] |= (pl_u8)(1u << (item & 7u));
        }
    }

    pl_u32 classes = machine->observation_classes;
    pl_u64 splitters = 0u, moved = 0u;
    while (work_count) {
        pl_u32 item = future_rank_read(
            work_queue, work_width, work_head);
        work_head = (work_head + 1u) % pair_count;
        --work_count;
        work_present[item >> 3u] &= (pl_u8)~(1u << (item & 7u));
        pl_u32 splitter = item / arms;
        pl_u32 arm = item % arms;
        pl_u32 splitter_size = splitter < classes
            ? future_rank_read(class_size, value_width, splitter) : 0u;
        if (splitter >= classes || !splitter_size)
            return PL_ERROR_FUTURE;
        ++splitters;

        pl_u32 affected_count = 0u;
        pl_u32 preimage_count = 0u;
        pl_u32 splitter_begin = future_rank_read(
            class_begin, value_width, splitter);
        pl_u32 splitter_end = splitter_begin + splitter_size;
        pl_u32 offset_base = arm * (states + 1u);
        for (pl_u32 at = splitter_begin; at < splitter_end; ++at) {
            pl_u32 target = future_rank_read(
                members, rank_width, at);
            pl_u32 predecessor_end =
                inverse_offset[offset_base + target + 1u];
            for (pl_u32 edge = inverse_offset[offset_base + target];
                    edge < predecessor_end; ++edge)
                future_rank_write(
                    cursor, value_width, preimage_count++,
                    future_rank_read(
                        inverse_state, inverse_width,
                        arm * states + edge));
        }
        /* The splitter can itself be affected.  Freeze its complete preimage
         * before moving any partition member, otherwise a cyclic machine can
         * replace an as-yet-unvisited target in the splitter range. */
        for (pl_u32 index = 0u; index < preimage_count; ++index) {
            pl_u32 state = future_rank_read(
                cursor, value_width, index);
            pl_u32 group = workspace->state_class[state];
            pl_u32 marked = future_rank_read(
                marked_count, value_width, group);
            if (!marked)
                future_rank_write(
                    affected, affected_width, affected_count++, group);
            future_rank_write(
                marked_count, value_width, group, marked + 1u);
            pl_u32 destination = future_rank_read(
                    class_begin, value_width, group)
                + future_rank_read(class_size, value_width, group)
                - 1u - marked;
            pl_u32 source = future_rank_read(
                position, rank_width, state);
            if (source != destination) {
                pl_u32 displaced = future_rank_read(
                    members, rank_width, destination);
                future_rank_write(
                    members, rank_width, source, displaced);
                future_rank_write(
                    position, rank_width, displaced, source);
                future_rank_write(
                    members, rank_width, destination, state);
                future_rank_write(
                    position, rank_width, state, destination);
            }
        }

        for (pl_u32 index = 0u; index < affected_count; ++index) {
            pl_u32 group = future_rank_read(
                affected, affected_width, index);
            pl_u32 marked = future_rank_read(
                marked_count, value_width, group);
            pl_u32 old_size = future_rank_read(
                class_size, value_width, group);
            future_rank_write(marked_count, value_width, group, 0u);
            if (!marked || marked == old_size) continue;
            if (classes >= states) return PL_ERROR_FUTURE;
            pl_u32 fresh = classes++;
            pl_u32 unmarked = old_size - marked;
            pl_u32 group_begin = future_rank_read(
                class_begin, value_width, group);
            pl_u32 split_at = group_begin + unmarked;
            if (marked <= unmarked) {
                future_rank_write(
                    class_begin, value_width, fresh, split_at);
                future_rank_write(class_size, value_width, fresh, marked);
                future_rank_write(class_size, value_width, group, unmarked);
                for (pl_u32 at = split_at;
                        at < split_at + marked; ++at)
                    workspace->state_class[future_rank_read(
                        members, rank_width, at)] = fresh;
                moved += marked;
            } else {
                future_rank_write(
                    class_begin, value_width, fresh, group_begin);
                future_rank_write(class_size, value_width, fresh, unmarked);
                future_rank_write(
                    class_begin, value_width, group, split_at);
                future_rank_write(class_size, value_width, group, marked);
                for (pl_u32 at = group_begin;
                        at < group_begin + unmarked; ++at)
                    workspace->state_class[future_rank_read(
                        members, rank_width, at)] = fresh;
                moved += unmarked;
            }
            for (pl_u32 next_arm = 0u; next_arm < arms; ++next_arm) {
                pl_u32 fresh_item = fresh * arms + next_arm;
                pl_u8 fresh_mask = (pl_u8)(1u << (fresh_item & 7u));
                if (work_present[fresh_item >> 3u] & fresh_mask)
                    return PL_ERROR_FUTURE;
                if (work_count >= pair_count) return PL_ERROR_FUTURE;
                future_rank_write(
                    work_queue, work_width, work_tail, fresh_item);
                work_tail = (work_tail + 1u) % pair_count;
                ++work_count;
                work_present[fresh_item >> 3u] |= fresh_mask;
            }
        }
    }

    *out = (pl_finite_future_projection){
        .classes = classes,
        .checked_transitions = (pl_u64)states * arms,
        .splitters = splitters,
        .moved_states = moved,
    };
    return 0;
}
