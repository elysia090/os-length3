/* Reopening a cached read region.
 *
 * _reopen_load_regions in qm/stepnormalize.py.  A load_region stands for a run
 * of adjacent loads plus the pointer past the end; composing a larger cut needs
 * those back as ordinary loads so the surrounding graph can see them, and the
 * main sweep closes the region again afterwards if it still holds.
 *
 * Shape B: every argument resolves through a remap, nodes are re-emitted, and a
 * region maps to a tuple of results rather than to a single node -- which is
 * why the remap alone is not enough and a per-region result list is kept
 * beside it.
 *
 * Freestanding: no libc, no allocation.
 */

#include <postlink/sweep.h>

#define PL_PROJECTION_SELECTOR_BITS 8u
#define PL_PROJECTION_SELECTOR_MASK ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u)

/* A region publishes count loads and then the end pointer, so a projection of
 * it selects one of count + 1 results. */
#define PL_REGION_RESULTS 9u

typedef struct {
    pl_u32 *of;          /* node value -> first slot in `slots`, or 0 */
    pl_operand *slots;   /* PL_REGION_RESULTS per region, in order */
    pl_u32 count;
} pl_region_results;

static pl_operand resolve_region(const pl_remap *remap,
                                 const pl_region_results *results,
                                 pl_operand operand)
{
    if (operand.kind == PL_OPERAND_PROJECTION) {
        pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
        pl_u64 selector = operand.value & PL_PROJECTION_SELECTOR_MASK;
        if (source && source <= results->count && results->of[source]
                && selector < PL_REGION_RESULTS)
            return results->slots[results->of[source] - 1u + selector];
    }
    return pl_resolve(remap, operand);
}

int pl_reopen_load_regions(const pl_plan *in, pl_arena *arena, pl_plan *out)
{
    int present = 0;
    for (pl_u32 index = 0; index < in->node_count; ++index)
        if (in->nodes[index].opcode == PL_OPCODE_MEMORY_LOAD_REGION) {
            present = 1;
            break;
        }
    if (!present) {
        *out = *in;
        return 0;
    }

    /* A region becomes at most eight loads plus one end pointer. */
    pl_u32 node_cap = in->node_count * PL_REGION_RESULTS;
    pl_u32 argument_cap = in->argument_count * PL_REGION_RESULTS
                        + node_cap * 4u;
    pl_remap remap;
    pl_builder builder;
    pl_region_results results;
    results.of = pl_arena_take(
        arena, (in->node_count + 1u) * (pl_u32)sizeof *results.of);
    results.slots = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u) * PL_REGION_RESULTS
               * (pl_u32)sizeof *results.slots);
    results.count = in->node_count;
    if (!results.of || !results.slots) return PL_ERROR_ARENA;
    for (pl_u32 index = 0; index <= in->node_count; ++index)
        results.of[index] = 0;
    if (pl_remap_open(&remap, in->node_count, arena)
            || pl_builder_open(&builder, out, arena, node_cap, argument_cap,
                               in->stack_count, in->local_count))
        return PL_ERROR_ARENA;

    pl_u32 published = 0;
    pl_operand staged[PL_STAGED_ARGUMENTS];
    for (pl_u32 index = 0; index < in->node_count; ++index) {
        const pl_node *node = &in->nodes[index];
        if (node->argument_count > PL_STAGED_ARGUMENTS) return PL_ERROR_PLAN;
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot)
            staged[slot] = resolve_region(
                &remap, &results, in->arguments[node->argument_at + slot]);

        if (node->opcode != PL_OPCODE_MEMORY_LOAD_REGION) {
            pl_u32 value = pl_emit(&builder, node->opcode, staged,
                                   node->argument_count);
            if (!value) return PL_ERROR_ARENA;
            remap.of[index + 1u].kind = PL_OPERAND_NODE;
            remap.of[index + 1u].value = value;
            continue;
        }

        if (node->argument_count < 4u) return PL_ERROR_PLAN;
        pl_operand base = staged[0];
        pl_operand offset = staged[1];
        pl_operand descriptor = staged[2];
        pl_operand shape = staged[3];
        if (offset.kind != PL_OPERAND_CONST
                || descriptor.kind != PL_OPERAND_CONST
                || shape.kind != PL_OPERAND_CONST)
            return PL_ERROR_PLAN;   /* the region lost its descriptor */

        /* decode_load_region_descriptor */
        pl_u64 word = descriptor.value;
        pl_u32 count = (pl_u32)(word & 0xffu);
        pl_u32 bits = (word & (1u << 9u)) ? 32u : 64u;
        pl_u32 signed_load = (word & (1u << 8u)) ? 1u : 0u;
        if (count < 1u || count > 8u || (word & ~(pl_u64)((1u << 10u) - 1u)))
            return PL_ERROR_PLAN;
        /* decode_memory_shape; a region may not carry an address scale */
        if (shape.value & ~(pl_u64)PL_MEMORY_SHAPE_MASK) return PL_ERROR_PLAN;
        pl_u32 width = (pl_u32)(shape.value & 0xffu);
        if ((shape.value >> PL_MEMORY_SHAPE_SCALE_SHIFT)
                & PL_MEMORY_SHAPE_SCALE_MASK)
            return PL_ERROR_PLAN;
        if (width > 8u) return PL_ERROR_PLAN;
        pl_u32 opcode = PL_OPCODE_REGION_LOAD[bits == 32u ? 0u : 1u][width]
                                             [signed_load];
        if (opcode == 255u) return PL_ERROR_PLAN;

        pl_u32 first = published + 1u;
        pl_operand load[PL_STAGED_ARGUMENTS];
        for (pl_u32 element = 0; element < count; ++element) {
            load[0] = base;
            load[1].kind = PL_OPERAND_CONST;
            load[1].value = offset.value + (pl_u64)element * width;
            load[2] = shape;
            pl_u32 extra = node->argument_count - 4u;
            if (3u + extra > PL_STAGED_ARGUMENTS) return PL_ERROR_PLAN;
            for (pl_u32 slot = 0; slot < extra; ++slot)
                load[3u + slot] = staged[4u + slot];
            pl_u32 value = pl_emit(&builder, opcode, load, 3u + extra);
            if (!value) return PL_ERROR_ARENA;
            results.slots[published].kind = PL_OPERAND_NODE;
            results.slots[published].value = value;
            published += 1u;
        }
        /* The pointer past the end is the region's last published result. */
        pl_operand end[2];
        end[0] = base;
        end[1].kind = PL_OPERAND_CONST;
        end[1].value = offset.value + (pl_u64)count * width;
        pl_u32 end_value = pl_emit(&builder, PL_OPCODE_ADD, end, 2u);
        if (!end_value) return PL_ERROR_ARENA;
        results.slots[published].kind = PL_OPERAND_NODE;
        results.slots[published].value = end_value;
        published += 1u;
        /* Pad so every region owns a fixed stride of the slot run. */
        while ((published - first + 1u) < PL_REGION_RESULTS) {
            results.slots[published] = results.slots[published - 1u];
            published += 1u;
        }

        results.of[index + 1u] = first;
        remap.of[index + 1u] = results.slots[first - 1u];
    }

    for (pl_u32 index = 0; index < in->stack_count; ++index)
        out->stack[index] = resolve_region(&remap, &results, in->stack[index]);
    for (pl_u32 index = 0; index < in->local_count; ++index)
        out->locals[index] = resolve_region(&remap, &results,
                                            in->locals[index]);

    out->function = in->function;
    out->start = in->start;
    out->end = in->end;
    out->instructions = in->instructions;
    out->stack_inputs = in->stack_inputs;
    out->span = in->span;
    return 0;
}
