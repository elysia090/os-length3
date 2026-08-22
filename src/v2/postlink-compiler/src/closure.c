/* Total executable-coordinate closure.  See include/postlink/closure.h. */

#include <postlink/closure.h>

#define PAGE_MASK (~((pl_u64)PL_ENTRY_PAGE_VALUES - 1u))

static pl_u64 page_of(pl_u64 address)
{
    return address & PAGE_MASK;
}

static pl_u64 map_last_page(const pl_x86_map *map)
{
    return page_of(map->address + map->memory_bytes - 1u);
}

int pl_closure_page_count(const pl_x86_image *image, pl_u32 *count)
{
    if (!count) return PL_ERROR_CLOSURE;
    int status = pl_x86_image_validate(image);
    if (status) return status;
    pl_u64 pages = 0u;
    pl_u64 last = 0u;
    int have_last = 0;
    for (pl_u32 map_index = 0u; map_index < image->map_count; ++map_index) {
        pl_u64 page = page_of(image->maps[map_index].address);
        pl_u64 final = map_last_page(&image->maps[map_index]);
        if (have_last && page <= last) {
            if (last == PAGE_MASK) continue;
            page = last + PL_ENTRY_PAGE_VALUES;
        }
        while (page <= final) {
            ++pages;
            if (pages > 0xffffffffu) return PL_ERROR_CLOSURE_CAPACITY;
            last = page;
            have_last = 1;
            if (page == final) break;
            page += PL_ENTRY_PAGE_VALUES;
        }
    }
    *count = (pl_u32)pages;
    return 0;
}

static int page_generation(const pl_x86_image *image, pl_u64 page,
                           pl_u32 *generation)
{
    int found = 0;
    pl_u32 value = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        if (page < page_of(map->address)
                || page > map_last_page(map))
            continue;
        if (!found) {
            value = map->generation;
            found = 1;
        } else if (value != map->generation) {
            return PL_ERROR_CLOSURE;
        }
    }
    if (!found) return PL_ERROR_CLOSURE;
    *generation = value;
    return 0;
}

static void count_instruction(const pl_x86_frontend *frontend,
                              const pl_x86_instruction *instruction,
                              int mapped, pl_closure_report *report)
{
    ++report->coordinates;
    if (mapped) ++report->mapped_coordinates;
    if (instruction->flow == PL_X86_FLOW_FAULT)
        ++report->fault_coordinates;
    if (instruction->flags & PL_X86_INSTRUCTION_PRECISE_CUT)
        ++report->precise_cuts;
    if (instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET) {
        ++report->direct_edges;
        if (pl_x86_frontend_contains(frontend, instruction->target))
            ++report->direct_edges_in_image;
        else
            ++report->direct_edges_outside_image;
    }
    if (instruction->flags & PL_X86_INSTRUCTION_INDIRECT)
        ++report->indirect_edges;
}

int pl_closure_build(const pl_x86_image *image, pl_closure_rank rank,
                     void *context, pl_entry_map_builder *entry_builder,
                     pl_closure_page *pages, pl_u32 page_capacity,
                     pl_closure_report *report)
{
    if (!rank || !entry_builder || !pages || !report)
        return PL_ERROR_CLOSURE;
    pl_x86_frontend frontend;
    int status = pl_x86_frontend_open(image, &frontend);
    if (status) return status;
    pl_u32 required = 0u;
    status = pl_closure_page_count(image, &required);
    if (status) return status;
    if (required > page_capacity
            || required > entry_builder->page_capacity)
        return PL_ERROR_CLOSURE_CAPACITY;

    pl_closure_report local = { 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u };
    pl_u32 functions[PL_ENTRY_PAGE_VALUES];
    pl_u64 last = 0u;
    int have_last = 0;
    pl_u32 page_index = 0u;
    for (pl_u32 map_index = 0u; map_index < image->map_count; ++map_index) {
        pl_u64 page = page_of(image->maps[map_index].address);
        pl_u64 final = map_last_page(&image->maps[map_index]);
        if (have_last && page <= last) {
            if (last == PAGE_MASK) continue;
            page = last + PL_ENTRY_PAGE_VALUES;
        }
        while (page <= final) {
            for (pl_u32 offset = 0u; offset < PL_ENTRY_PAGE_VALUES; ++offset) {
                pl_u64 coordinate = page + offset;
                int mapped = pl_x86_frontend_contains(&frontend, coordinate);
                pl_x86_instruction instruction;
                status = pl_x86_frontend_decode(
                    &frontend, coordinate, &instruction);
                if (status) return status;
                count_instruction(&frontend, &instruction, mapped, &local);
                status = rank(&instruction, context, &functions[offset]);
                if (status) return status;
            }
            pl_u32 entry_page_rank = 0u;
            status = pl_entry_map_add_page(
                entry_builder, functions, &entry_page_rank);
            if (status) return status;
            pl_u32 generation = 0u;
            status = page_generation(image, page, &generation);
            if (status) return status;
            pages[page_index].virtual_page = page;
            pages[page_index].generation = generation;
            pages[page_index].entry_page_rank = entry_page_rank;
            ++page_index;
            ++local.pages;
            last = page;
            have_last = 1;
            if (page == final) break;
            page += PL_ENTRY_PAGE_VALUES;
        }
    }
    if (page_index != required) return PL_ERROR_CLOSURE;
    *report = local;
    return 0;
}

static int closure_page_index(const pl_closure_page *pages, pl_u32 count,
                              pl_u64 coordinate, pl_u32 *index)
{
    pl_u64 page = page_of(coordinate);
    pl_u32 low = 0u, high = count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (pages[middle].virtual_page < page) low = middle + 1u;
        else high = middle;
    }
    if (low >= count || pages[low].virtual_page != page)
        return PL_ERROR_CLOSURE;
    *index = low;
    return 0;
}

int pl_closure_lookup(const pl_closure_page *pages, pl_u32 page_count,
                      const pl_entry_map *map, pl_u64 coordinate,
                      pl_u32 *rank)
{
    if (!pages || !page_count || !map || !rank) return PL_ERROR_CLOSURE;
    pl_u32 page = 0u;
    int status = closure_page_index(pages, page_count, coordinate, &page);
    return status ? status : pl_entry_map_lookup(
        map, pages[page].entry_page_rank,
        (pl_u32)(coordinate & (PL_ENTRY_PAGE_VALUES - 1u)), rank);
}

static int coordinate_rank(const pl_closure_page *pages, pl_u32 page_count,
                           pl_u64 coordinate, pl_u32 *rank)
{
    pl_u32 page = 0u;
    int status = closure_page_index(pages, page_count, coordinate, &page);
    if (status || page > 0xffffffffu / PL_ENTRY_PAGE_VALUES)
        return status ? status : PL_ERROR_CLOSURE_CAPACITY;
    *rank = page * PL_ENTRY_PAGE_VALUES
          + (pl_u32)(coordinate & (PL_ENTRY_PAGE_VALUES - 1u));
    return 0;
}

static int workspace_valid(const pl_closure_partition_workspace *work)
{
    if (!work || !work->page_rows[0] || !work->page_rows[1]
            || !work->tail_rows[0] || !work->tail_rows[1]
            || !work->tail_hash[0] || !work->tail_hash[1]
            || !work->page_capacity || !work->tail_capacity
            || !work->tail_hash_slots || !work->pages
            || !work->transfer_edges || !work->transfer_edge_capacity
            || !work->representatives || !work->class_capacity
            || work->class_capacity > 0x3fffffffu
            || !work->coordinate_capacity
            || work->coordinate_capacity > 0x7fffffffu
            || !work->predecessor_capacity || !work->reverse_offsets
            || !work->predecessors || !work->classes || !work->order
            || !work->frontier || !work->positions
            || !work->class_starts || !work->class_sizes
            || !work->class_hits || !work->touched_classes
            || !work->split_queue || !work->queued_arms)
        return 0;
    return 1;
}

static int queue_add(const pl_closure_partition_workspace *work,
                     pl_u32 class_rank, pl_u32 arm,
                     pl_u32 *tail, pl_u32 *count)
{
    pl_u8 bit = (pl_u8)(1u << arm);
    if (work->queued_arms[class_rank] & bit) return 0;
    pl_u32 capacity = work->class_capacity * 2u;
    if (*count >= capacity) return PL_ERROR_CLOSURE_CAPACITY;
    work->split_queue[*tail] = (class_rank << 1u) | arm;
    *tail = *tail + 1u == capacity ? 0u : *tail + 1u;
    ++*count;
    work->queued_arms[class_rank] |= bit;
    return 0;
}

static int internal_successor(
    const pl_x86_block_builder *blocks,
    const pl_closure_page *pages, pl_u32 page_count,
    const pl_closure_transfer_edge *edge, pl_u64 coordinate, pl_u32 arm,
    pl_u32 *target)
{
    if (edge->dynamic_target || arm >= edge->successor_count) return 0;
    pl_u64 address = coordinate + edge->successor_delta[arm];
    if (!pl_x86_frontend_contains(&blocks->frontend, address)) return 0;
    int status = coordinate_rank(pages, page_count, address, target);
    return status ? status : 1;
}

int pl_closure_partition(
    const pl_x86_image *image, pl_x86_block_builder *blocks,
    const pl_closure_partition_workspace *work,
    pl_entry_map *entry_map, pl_closure_report *closure,
    pl_closure_partition_report *partition)
{
    if (!image || !blocks || !entry_map || !closure || !partition
            || !workspace_valid(work))
        return PL_ERROR_CLOSURE;
    pl_u32 page_count = 0u;
    int status = pl_closure_page_count(image, &page_count);
    if (status) return status;
    if (page_count > work->page_capacity
            || page_count > 0xffffffffu / PL_ENTRY_PAGE_VALUES
            || page_count > 0xffffffffu / PL_ENTRY_PAGE_ROWS)
        return PL_ERROR_CLOSURE_CAPACITY;
    pl_u32 coordinate_count = page_count * PL_ENTRY_PAGE_VALUES;
    pl_u32 tail_capacity = page_count * PL_ENTRY_PAGE_ROWS;
    if (coordinate_count > work->coordinate_capacity
            || tail_capacity > work->tail_capacity)
        return PL_ERROR_CLOSURE_CAPACITY;

    pl_entry_map_builder base_builder;
    status = pl_entry_map_builder_open(
        &base_builder, work->page_rows[0], work->page_capacity,
        work->tail_rows[0], work->tail_capacity, work->tail_hash[0],
        work->tail_hash_slots, work->class_capacity);
    if (!status)
        status = pl_closure_build(
            image, pl_x86_block_rank_instruction, blocks, &base_builder,
            work->pages, work->page_capacity, closure);
    if (status) return status;
    if (!blocks->identity_count
            || blocks->identity_count > work->transfer_edge_capacity
            || blocks->identity_count > work->class_capacity)
        return PL_ERROR_CLOSURE_CAPACITY;
    base_builder.function_count = blocks->identity_count;
    pl_entry_map base_map;
    pl_entry_map_finish(&base_builder, &base_map);

    for (pl_u32 rank = 0u; rank < blocks->identity_count; ++rank) {
        pl_x86_block block;
        status = pl_x86_block_lower(
            &blocks->frontend, blocks->identities[rank].representative,
            &blocks->formation, &block);
        if (status) return status;
        pl_closure_transfer_edge *edge = &work->transfer_edges[rank];
        edge->successor_count = block.successor_count;
        edge->dynamic_target = block.dynamic_target;
        edge->successor_delta[0] = edge->successor_delta[1] = 0u;
        for (pl_u32 arm = 0u; arm < block.successor_count; ++arm)
            edge->successor_delta[arm] =
                block.successor[arm] - block.start;
    }

    for (pl_u32 rank = 0u; rank <= coordinate_count; ++rank)
        work->reverse_offsets[rank] = 0u;
    for (pl_u32 rank = 0u; rank < blocks->identity_count; ++rank)
        work->class_sizes[rank] = 0u;
    pl_u64 edge_count = 0u;
    for (pl_u32 state = 0u; state < coordinate_count; ++state) {
        pl_u32 page = state / PL_ENTRY_PAGE_VALUES;
        pl_u32 offset = state & (PL_ENTRY_PAGE_VALUES - 1u);
        pl_u32 transfer = 0u;
        status = pl_entry_map_lookup(
            &base_map, work->pages[page].entry_page_rank,
            offset, &transfer);
        if (status || transfer >= blocks->identity_count)
            return status ? status : PL_ERROR_CLOSURE;
        work->classes[state] = transfer;
        ++work->class_sizes[transfer];
        pl_u64 coordinate = work->pages[page].virtual_page + offset;
        const pl_closure_transfer_edge *edge = &work->transfer_edges[transfer];
        for (pl_u32 arm = 0u; arm < edge->successor_count; ++arm) {
            pl_u32 target = 0u;
            int internal = internal_successor(
                blocks, work->pages, page_count, edge,
                coordinate, arm, &target);
            if (internal < 0) return internal;
            if (!internal) continue;
            if (target >= coordinate_count || edge_count == 0xffffffffu)
                return PL_ERROR_CLOSURE_CAPACITY;
            ++work->reverse_offsets[target + 1u];
            ++edge_count;
        }
    }
    if (edge_count > work->predecessor_capacity)
        return PL_ERROR_CLOSURE_CAPACITY;
    for (pl_u32 state = 0u; state < coordinate_count; ++state) {
        if (work->reverse_offsets[state + 1u]
                > 0xffffffffu - work->reverse_offsets[state])
            return PL_ERROR_CLOSURE_CAPACITY;
        work->reverse_offsets[state + 1u] += work->reverse_offsets[state];
        work->frontier[state] = work->reverse_offsets[state];
    }

    for (pl_u32 state = 0u; state < coordinate_count; ++state) {
        pl_u32 page = state / PL_ENTRY_PAGE_VALUES;
        pl_u32 offset = state & (PL_ENTRY_PAGE_VALUES - 1u);
        pl_u32 transfer = work->classes[state];
        pl_u64 coordinate = work->pages[page].virtual_page + offset;
        const pl_closure_transfer_edge *edge = &work->transfer_edges[transfer];
        for (pl_u32 arm = 0u; arm < edge->successor_count; ++arm) {
            pl_u32 target = 0u;
            int internal = internal_successor(
                blocks, work->pages, page_count, edge,
                coordinate, arm, &target);
            if (internal < 0) return internal;
            if (!internal) continue;
            pl_u32 at = work->frontier[target]++;
            if (at >= edge_count) return PL_ERROR_CLOSURE;
            work->predecessors[at] = (state << 1u) | arm;
        }
    }
    for (pl_u32 state = 0u; state < coordinate_count; ++state)
        if (work->frontier[state] != work->reverse_offsets[state + 1u])
            return PL_ERROR_CLOSURE;

    pl_u32 class_count = 0u;
    for (pl_u32 transfer = 0u;
         transfer < blocks->identity_count; ++transfer) {
        pl_u32 size = work->class_sizes[transfer];
        if (!size) {
            work->class_starts[transfer] = 0xffffffffu;
            continue;
        }
        work->class_starts[transfer] = class_count;
        work->class_hits[class_count] = size;
        ++class_count;
    }
    for (pl_u32 state = 0u; state < coordinate_count; ++state) {
        pl_u32 dense = work->class_starts[work->classes[state]];
        if (dense == 0xffffffffu) return PL_ERROR_CLOSURE;
        work->classes[state] = dense;
    }
    pl_u32 next = 0u;
    for (pl_u32 rank = 0u; rank < class_count; ++rank) {
        work->class_sizes[rank] = work->class_hits[rank];
        work->class_starts[rank] = next;
        work->class_hits[rank] = next;
        next += work->class_sizes[rank];
    }
    if (next != coordinate_count) return PL_ERROR_CLOSURE;
    for (pl_u32 state = 0u; state < coordinate_count; ++state) {
        pl_u32 rank = work->classes[state];
        pl_u32 at = work->class_hits[rank]++;
        work->order[at] = state;
        work->positions[state] = at;
    }
    for (pl_u32 rank = 0u; rank < class_count; ++rank) {
        if (work->class_hits[rank]
                != work->class_starts[rank] + work->class_sizes[rank])
            return PL_ERROR_CLOSURE;
        work->class_hits[rank] = 0u;
        work->queued_arms[rank] = 0u;
    }
    pl_u32 queue_head = 0u, queue_tail = 0u, queue_count = 0u;
    for (pl_u32 rank = 0u; rank < class_count; ++rank)
        for (pl_u32 arm = 0u; arm < 2u; ++arm) {
            status = queue_add(
                work, rank, arm, &queue_tail, &queue_count);
            if (status) return status;
        }

    pl_closure_partition_report local = {
        class_count, 0u, 0u, 0u, coordinate_count, edge_count, 0u, 0u,
    };
    const pl_u32 queue_capacity = work->class_capacity * 2u;
    while (queue_count) {
        pl_u32 encoded_splitter = work->split_queue[queue_head];
        queue_head = queue_head + 1u == queue_capacity ? 0u : queue_head + 1u;
        --queue_count;
        pl_u32 splitter = encoded_splitter >> 1u;
        pl_u32 arm = encoded_splitter & 1u;
        if (splitter >= class_count) return PL_ERROR_CLOSURE;
        work->queued_arms[splitter] &= (pl_u8)~(1u << arm);
        ++local.splitters;
        pl_u32 touched = 0u;
        pl_u32 frontier = 0u;
        pl_u32 first = work->class_starts[splitter];
        pl_u32 end = first + work->class_sizes[splitter];
        local.splitter_states += end - first;
        for (pl_u32 at = first; at < end; ++at) {
            pl_u32 target = work->order[at];
            for (pl_u32 edge = work->reverse_offsets[target];
                 edge < work->reverse_offsets[target + 1u]; ++edge) {
                pl_u32 predecessor = work->predecessors[edge];
                if ((predecessor & 1u) != arm) continue;
                pl_u32 source = predecessor >> 1u;
                if (frontier >= coordinate_count)
                    return PL_ERROR_CLOSURE_CAPACITY;
                work->frontier[frontier++] = source;
            }
        }
        local.frontier_states += frontier;
        if (frontier > local.maximum_frontier)
            local.maximum_frontier = frontier;

        /* A source has at most one successor per ordered arm, so it occurs at
         * most once in this frontier.  Move only those sources into the marked
         * prefix of their class; scanning the full source class here turns
         * repeated singleton splits into quadratic work. */
        for (pl_u32 index = 0u; index < frontier; ++index) {
            pl_u32 source = work->frontier[index];
            pl_u32 source_class = work->classes[source];
            if (!work->class_hits[source_class])
                work->touched_classes[touched++] = source_class;
            pl_u32 destination = work->class_starts[source_class]
                               + work->class_hits[source_class]++;
            pl_u32 position = work->positions[source];
            if (position != destination) {
                pl_u32 displaced = work->order[destination];
                work->order[position] = displaced;
                work->positions[displaced] = position;
                work->order[destination] = source;
                work->positions[source] = destination;
            }
        }

        for (pl_u32 index = 0u; index < touched; ++index) {
            pl_u32 source_class = work->touched_classes[index];
            pl_u32 hit = work->class_hits[source_class];
            work->class_hits[source_class] = 0u;
            pl_u32 source_size = work->class_sizes[source_class];
            if (hit == source_size) continue;
            if (class_count >= work->class_capacity) {
                local.classes = class_count;
                *partition = local;
                return PL_ERROR_CLOSURE_CAPACITY;
            }
            pl_u32 fresh = class_count++;
            pl_u32 source_start = work->class_starts[source_class];
            work->class_starts[fresh] = source_start;
            work->class_sizes[fresh] = hit;
            work->class_starts[source_class] = source_start + hit;
            work->class_sizes[source_class] = source_size - hit;
            work->class_hits[fresh] = 0u;
            work->queued_arms[fresh] = 0u;
            for (pl_u32 at = source_start; at < source_start + hit; ++at)
                work->classes[work->order[at]] = fresh;
            ++local.splits;

            for (pl_u32 symbol = 0u; symbol < 2u; ++symbol) {
                pl_u8 bit = (pl_u8)(1u << symbol);
                pl_u32 chosen;
                if (work->queued_arms[source_class] & bit) {
                    chosen = fresh;
                } else {
                    chosen = work->class_sizes[fresh]
                           <= work->class_sizes[source_class]
                           ? fresh : source_class;
                }
                status = queue_add(
                    work, chosen, symbol, &queue_tail, &queue_count);
                if (status) return status;
            }
        }
    }
    local.classes = class_count;

    pl_entry_map_builder final_builder;
    status = pl_entry_map_builder_open(
        &final_builder, work->page_rows[1], work->page_capacity,
        work->tail_rows[1], work->tail_capacity, work->tail_hash[1],
        work->tail_hash_slots, class_count);
    if (status) return status;
    for (pl_u32 page = 0u; page < page_count; ++page) {
        pl_u32 page_rank = 0u;
        status = pl_entry_map_add_page(
            &final_builder,
            work->classes + (pl_u64)page * PL_ENTRY_PAGE_VALUES,
            &page_rank);
        if (status || page_rank != page)
            return status ? status : PL_ERROR_CLOSURE;
        work->pages[page].entry_page_rank = page_rank;
    }
    final_builder.function_count = class_count;
    pl_entry_map_finish(&final_builder, entry_map);
    for (pl_u32 rank = 0u; rank < class_count; ++rank) {
        pl_u32 state = work->order[work->class_starts[rank]];
        pl_u32 page = state / PL_ENTRY_PAGE_VALUES;
        pl_u32 offset = state & (PL_ENTRY_PAGE_VALUES - 1u);
        work->representatives[rank] =
            work->pages[page].virtual_page + offset;
    }
    *partition = local;
    return 0;
}
