/* Canonical normalized-plan projection into a shared template and typed row. */

#include "internal/plan-codec.h"

typedef struct {
    pl_u8 *target;
    pl_u32 capacity;
    pl_u32 used;
    int status;
} projection_writer;

static void put_u8(projection_writer *out, pl_u32 value)
{
    if (out->status) return;
    if (out->used == 0xffffffffu
            || (out->target && out->used >= out->capacity)) {
        out->status = PL_ERROR_TEMPLATE;
        return;
    }
    if (out->target) out->target[out->used] = (pl_u8)value;
    out->used += 1u;
}

static void put_u16(projection_writer *out, pl_u32 value)
{
    put_u8(out, value);
    put_u8(out, value >> 8u);
}

static void put_u64(projection_writer *out, pl_u64 value)
{
    for (pl_u32 shift = 0u; shift < 64u; shift += 8u)
        put_u8(out, (pl_u32)(value >> shift));
}

static pl_u32 uleb_bytes(pl_u32 value)
{
    pl_u32 bytes = 1u;
    while (value >= 0x80u) { value >>= 7u; ++bytes; }
    return bytes;
}

static void put_uleb(projection_writer *out, pl_u32 value)
{
    do {
        pl_u32 byte = value & 0x7fu;
        value >>= 7u;
        put_u8(out, byte | (value ? 0x80u : 0u));
    } while (value);
}

static pl_u32 bit_width(pl_u64 value)
{
    pl_u32 width = 0u;
    while (value) { ++width; value >>= 1u; }
    return width;
}

static pl_u64 packed_bytes(pl_u32 count, pl_u32 width)
{
    return ((pl_u64)count * width + 7u) >> 3u;
}

static pl_u32 reserve_zeroes(projection_writer *out, pl_u64 bytes)
{
    pl_u32 at = out->used;
    if (out->status) return at;
    if (bytes > 0xffffffffull - out->used
            || (out->target && bytes > out->capacity - out->used)) {
        out->status = PL_ERROR_TEMPLATE;
        return at;
    }
    pl_u32 extent = (pl_u32)bytes;
    if (out->target)
        for (pl_u32 rank = 0u; rank < extent; ++rank)
            out->target[out->used + rank] = 0u;
    out->used += extent;
    return at;
}

static void packed_write(pl_u8 *target, pl_u32 ordinal,
                         pl_u32 width, pl_u64 value)
{
    if (!target || !width) return;
    pl_u64 bit_at = (pl_u64)ordinal * width;
    for (pl_u32 bit = 0u; bit < width; ++bit)
        if (value & (1ull << bit))
            target[(bit_at + bit) >> 3u] |=
                (pl_u8)(1u << ((bit_at + bit) & 7u));
}

static int operand_valid(pl_operand operand)
{
    if (operand.kind >= PL_OPERAND_KINDS) return 0;
    return (operand.kind != PL_OPERAND_STACK
            && operand.kind != PL_OPERAND_LOCAL)
        || operand.value <= 0xffffu;
}

static void put_parameter_value(projection_writer *row, pl_operand operand)
{
    if (operand.kind == PL_OPERAND_CONST) put_u64(row, operand.value);
    else if (operand.kind == PL_OPERAND_STACK
            || operand.kind == PL_OPERAND_LOCAL)
        put_u16(row, (pl_u32)operand.value);
}

static int local_changed(const pl_plan *plan, pl_u32 coordinate)
{
    pl_operand operand = plan->locals[coordinate];
    return operand.kind != PL_OPERAND_LOCAL || operand.value != coordinate;
}

static int plan_shape(const pl_plan *plan, pl_u32 *local_updates)
{
    if (!plan || !local_updates || plan->end < plan->start
            || plan->instructions != plan->end - plan->start
            || plan->node_count > 0xffffffffu - 1u
            || plan->local_count > 0x10000u
            || (plan->node_count && !plan->nodes)
            || (plan->span && (!plan->node_count || !plan->wave_offsets
                    || !plan->wave_values))
            || (!plan->span && plan->node_count)
            || (plan->argument_count && !plan->arguments)
            || (plan->stack_count && !plan->stack)
            || (plan->local_count && !plan->locals))
        return PL_ERROR_PLAN;
    if (plan->wave_offsets && (plan->wave_offsets[0] != 0u
            || plan->wave_offsets[plan->span] != plan->node_count))
        return PL_ERROR_PLAN;
    if (!plan->wave_offsets && (plan->span || plan->node_count))
        return PL_ERROR_PLAN;
    for (pl_u32 wave = 0u; wave < plan->span; ++wave)
        if (plan->wave_offsets[wave] > plan->wave_offsets[wave + 1u])
            return PL_ERROR_PLAN;
    pl_u32 next_argument = 0u;
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        const pl_node *node = &plan->nodes[index];
        if (node->opcode > 0xffu || node->argument_at != next_argument
                || next_argument > plan->argument_count
                || node->argument_count
                   > plan->argument_count - next_argument)
            return PL_ERROR_PLAN;
        next_argument += node->argument_count;
    }
    if (next_argument != plan->argument_count) return PL_ERROR_PLAN;
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        pl_u32 value = plan->wave_values[index];
        if (!value || value > plan->node_count) return PL_ERROR_PLAN;
    }
    for (pl_u32 index = 0u; index < plan->argument_count; ++index)
        if (!operand_valid(plan->arguments[index])) return PL_ERROR_PLAN;
    for (pl_u32 index = 0u; index < plan->stack_count; ++index)
        if (!operand_valid(plan->stack[index])) return PL_ERROR_PLAN;
    *local_updates = 0u;
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate) {
        pl_operand operand = plan->locals[coordinate];
        if (!operand_valid(operand)) return PL_ERROR_PLAN;
        if (operand.kind != PL_OPERAND_LOCAL
                || operand.value != coordinate)
            *local_updates += 1u;
    }
    return 0;
}

static int project(const pl_plan *plan,
                   pl_u8 *template_target, pl_u32 template_capacity,
                   pl_u32 *template_written,
                   pl_u8 *parameter_target, pl_u32 parameter_capacity,
                   pl_u32 *parameter_written)
{
    pl_u32 local_updates = 0u;
    int status = plan_shape(plan, &local_updates);
    if (status) return status;
    projection_writer tmpl = {
        template_target, template_capacity, 0u, 0,
    };
    projection_writer row = {
        parameter_target, parameter_capacity, 0u, 0,
    };

    pl_u32 wave_maximum = 0u;
    for (pl_u32 wave = 0u; wave < plan->span; ++wave) {
        pl_u32 size = plan->wave_offsets[wave + 1u]
                    - plan->wave_offsets[wave];
        if (size > wave_maximum) wave_maximum = size;
    }
    pl_u32 lane_maximum = 0u;
    pl_u32 argument_maximum = 0u;
    for (pl_u32 rank = 0u; rank < plan->node_count; ++rank) {
        if (plan->wave_values[rank] > lane_maximum)
            lane_maximum = plan->wave_values[rank];
        if (plan->nodes[rank].argument_count > argument_maximum)
            argument_maximum = plan->nodes[rank].argument_count;
    }
    pl_u64 tag_count_64 = (pl_u64)plan->argument_count + plan->stack_count
                        + local_updates;
    if (tag_count_64 > 0xffffffffu) return PL_ERROR_PLAN;
    pl_u32 tag_count = (pl_u32)tag_count_64;
    pl_u32 word_count = 0u;
    pl_u64 word_maximum = 0u;
    for (pl_u32 rank = 0u; rank < plan->argument_count; ++rank) {
        pl_operand operand = plan->arguments[rank];
        if (PL_OPERAND_STAYS(operand.kind)) {
            ++word_count;
            if (operand.value > word_maximum) word_maximum = operand.value;
        }
    }
    for (pl_u32 rank = 0u; rank < plan->stack_count; ++rank) {
        pl_operand operand = plan->stack[rank];
        if (PL_OPERAND_STAYS(operand.kind)) {
            ++word_count;
            if (operand.value > word_maximum) word_maximum = operand.value;
        }
    }
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate) {
        if (!local_changed(plan, coordinate)) continue;
        pl_operand operand = plan->locals[coordinate];
        if (PL_OPERAND_STAYS(operand.kind)) {
            ++word_count;
            if (operand.value > word_maximum) word_maximum = operand.value;
        }
    }

    pl_u32 scalars[PL_TEMPLATE_SCALARS] = {
        plan->function, plan->start, plan->instructions, plan->span,
        plan->node_count, plan->argument_count, plan->stack_inputs,
        plan->stack_count, plan->local_count, local_updates,
    };
    pl_u32 header_bytes = PL_TEMPLATE_PREFIX_BYTES;
    for (pl_u32 rank = 0u; rank < PL_TEMPLATE_SCALARS; ++rank)
        header_bytes += uleb_bytes(scalars[rank]);
    if (header_bytes > 0xffffu) return PL_ERROR_TEMPLATE;

    put_u8(&tmpl, 'S'); put_u8(&tmpl, 'T');
    put_u8(&tmpl, 'Q'); put_u8(&tmpl, 'T');
    put_u16(&tmpl, PL_TEMPLATE_VERSION);
    put_u16(&tmpl, header_bytes);
    for (pl_u32 rank = 0u; rank < PL_TEMPLATE_SCALARS; ++rank)
        put_uleb(&tmpl, scalars[rank]);

    pl_u32 width = bit_width(wave_maximum);
    if (plan->span) {
        put_u8(&tmpl, width);
        pl_u32 at = reserve_zeroes(
            &tmpl, packed_bytes(plan->span, width));
        for (pl_u32 wave = 0u; wave < plan->span; ++wave)
            packed_write(tmpl.target ? tmpl.target + at : 0, wave, width,
                         plan->wave_offsets[wave + 1u]
                         - plan->wave_offsets[wave]);
    }
    width = bit_width(lane_maximum);
    if (plan->node_count) {
        put_u8(&tmpl, width);
        pl_u32 at = reserve_zeroes(
            &tmpl, packed_bytes(plan->node_count, width));
        for (pl_u32 rank = 0u; rank < plan->node_count; ++rank)
            packed_write(tmpl.target ? tmpl.target + at : 0, rank, width,
                         plan->wave_values[rank]);
    }
    for (pl_u32 index = 0u; index < plan->node_count; ++index)
        put_u8(&tmpl, plan->nodes[index].opcode);
    width = bit_width(argument_maximum);
    if (plan->node_count) {
        put_u8(&tmpl, width);
        pl_u32 at = reserve_zeroes(
            &tmpl, packed_bytes(plan->node_count, width));
        for (pl_u32 rank = 0u; rank < plan->node_count; ++rank)
            packed_write(tmpl.target ? tmpl.target + at : 0, rank, width,
                         plan->nodes[rank].argument_count);
    }

    pl_u32 tag_at = reserve_zeroes(&tmpl, packed_bytes(tag_count, 3u));
    pl_u32 tag_rank = 0u;
    for (pl_u32 rank = 0u; rank < plan->argument_count; ++rank)
        packed_write(tmpl.target ? tmpl.target + tag_at : 0,
                     tag_rank++, 3u, plan->arguments[rank].kind);
    for (pl_u32 rank = 0u; rank < plan->stack_count; ++rank)
        packed_write(tmpl.target ? tmpl.target + tag_at : 0,
                     tag_rank++, 3u, plan->stack[rank].kind);
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate)
        if (local_changed(plan, coordinate))
            packed_write(tmpl.target ? tmpl.target + tag_at : 0,
                         tag_rank++, 3u, plan->locals[coordinate].kind);

    width = bit_width(word_maximum);
    if (word_count) {
        put_u8(&tmpl, width);
        pl_u32 at = reserve_zeroes(&tmpl, packed_bytes(word_count, width));
        pl_u32 word_rank = 0u;
        for (pl_u32 rank = 0u; rank < plan->argument_count; ++rank)
            if (PL_OPERAND_STAYS(plan->arguments[rank].kind))
                packed_write(tmpl.target ? tmpl.target + at : 0,
                    word_rank++, width, plan->arguments[rank].value);
        for (pl_u32 rank = 0u; rank < plan->stack_count; ++rank)
            if (PL_OPERAND_STAYS(plan->stack[rank].kind))
                packed_write(tmpl.target ? tmpl.target + at : 0,
                    word_rank++, width, plan->stack[rank].value);
        for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
                ++coordinate)
            if (local_changed(plan, coordinate)
                    && PL_OPERAND_STAYS(plan->locals[coordinate].kind))
                packed_write(tmpl.target ? tmpl.target + at : 0,
                    word_rank++, width, plan->locals[coordinate].value);
    }

    for (pl_u32 rank = 0u; rank < plan->argument_count; ++rank)
        put_parameter_value(&row, plan->arguments[rank]);
    for (pl_u32 rank = 0u; rank < plan->stack_count; ++rank)
        put_parameter_value(&row, plan->stack[rank]);
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate)
        if (local_changed(plan, coordinate))
            put_parameter_value(&row, plan->locals[coordinate]);
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate) {
        if (local_changed(plan, coordinate))
            put_u16(&row, coordinate);
    }
    if (tmpl.status) return tmpl.status;
    if (row.status) return row.status;
    *template_written = tmpl.used;
    *parameter_written = row.used;
    return 0;
}

int pl_plan_template_measure(const pl_plan *plan, pl_u32 *template_bytes,
                             pl_u32 *parameter_bytes)
{
    if (!template_bytes || !parameter_bytes) return PL_ERROR_PLAN;
    return project(plan, 0, 0xffffffffu, template_bytes,
                   0, 0xffffffffu, parameter_bytes);
}

int pl_plan_template_write(const pl_plan *plan,
                           pl_u8 *template_target, pl_u32 template_capacity,
                           pl_u32 *template_written,
                           pl_u8 *parameter_target, pl_u32 parameter_capacity,
                           pl_u32 *parameter_written)
{
    if (!template_target || !template_written || !parameter_written
            || (parameter_capacity && !parameter_target))
        return PL_ERROR_PLAN;
    return project(plan, template_target, template_capacity, template_written,
                   parameter_target, parameter_capacity, parameter_written);
}

static void put_topology_operand(projection_writer *out, pl_operand operand)
{
    put_u8(out, operand.kind);
    if (PL_OPERAND_STAYS(operand.kind)) put_u64(out, operand.value);
}

static int project_observation(const pl_plan *plan,
                               pl_u8 *topology_target,
                               pl_u32 topology_capacity,
                               pl_u32 *topology_written,
                               pl_u8 *parameter_target,
                               pl_u32 parameter_capacity,
                               pl_u32 *parameter_written)
{
    if (!topology_written || !parameter_written) return PL_ERROR_PLAN;
    pl_u32 local_updates = 0u;
    int status = plan_shape(plan, &local_updates);
    if (status) return status;
    projection_writer topology = {
        topology_target, topology_capacity, 0u, 0,
    };
    projection_writer parameter = {
        parameter_target, parameter_capacity, 0u, 0,
    };

    put_u8(&topology, 'S'); put_u8(&topology, 'S');
    put_u8(&topology, 'T'); put_u8(&topology, 'P');
    put_u8(&topology, 1u);
    put_uleb(&topology, plan->stack_inputs);
    put_uleb(&topology, plan->node_count);
    put_uleb(&topology, plan->argument_count);
    put_uleb(&topology, plan->stack_count);
    put_uleb(&topology, plan->local_count);
    put_uleb(&topology, local_updates);
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        put_u8(&topology, plan->nodes[index].opcode);
        put_uleb(&topology, plan->nodes[index].argument_count);
    }
    for (pl_u32 index = 0u; index < plan->argument_count; ++index)
        put_topology_operand(&topology, plan->arguments[index]);
    for (pl_u32 index = 0u; index < plan->stack_count; ++index)
        put_topology_operand(&topology, plan->stack[index]);
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate)
        if (local_changed(plan, coordinate))
            put_topology_operand(&topology, plan->locals[coordinate]);

    put_u8(&parameter, 'S'); put_u8(&parameter, 'S');
    put_u8(&parameter, 'P'); put_u8(&parameter, 'R');
    put_u8(&parameter, 1u);
    for (pl_u32 index = 0u; index < plan->argument_count; ++index)
        put_parameter_value(&parameter, plan->arguments[index]);
    for (pl_u32 index = 0u; index < plan->stack_count; ++index)
        put_parameter_value(&parameter, plan->stack[index]);
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate)
        if (local_changed(plan, coordinate))
            put_parameter_value(&parameter, plan->locals[coordinate]);
    for (pl_u32 coordinate = 0u; coordinate < plan->local_count;
            ++coordinate)
        if (local_changed(plan, coordinate)) put_u16(&parameter, coordinate);

    if (topology.status) return topology.status;
    if (parameter.status) return parameter.status;
    *topology_written = topology.used;
    *parameter_written = parameter.used;
    return 0;
}

int pl_plan_topology_measure(const pl_plan *plan, pl_u32 *bytes)
{
    pl_u32 parameter_bytes = 0u;
    return project_observation(
        plan, 0, 0xffffffffu, bytes,
        0, 0xffffffffu, &parameter_bytes);
}

int pl_plan_topology_write(const pl_plan *plan,
                           pl_u8 *target, pl_u32 capacity,
                           pl_u32 *written)
{
    if (!target) return PL_ERROR_PLAN;
    pl_u32 parameter_bytes = 0u;
    return project_observation(
        plan, target, capacity, written,
        0, 0xffffffffu, &parameter_bytes);
}

int pl_plan_parameters_measure(const pl_plan *plan, pl_u32 *bytes)
{
    pl_u32 topology_bytes = 0u;
    return project_observation(
        plan, 0, 0xffffffffu, &topology_bytes,
        0, 0xffffffffu, bytes);
}

int pl_plan_parameters_write(const pl_plan *plan,
                             pl_u8 *target, pl_u32 capacity,
                             pl_u32 *written)
{
    if (!target) return PL_ERROR_PLAN;
    pl_u32 topology_bytes = 0u;
    return project_observation(
        plan, 0, 0xffffffffu, &topology_bytes,
        target, capacity, written);
}
