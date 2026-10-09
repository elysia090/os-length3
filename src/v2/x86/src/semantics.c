/* Lower one decoded x86 instruction to a precise physical SSA law. */

#include <x86/semantics.h>

#define SEMANTIC_NODE_CAPACITY      16u
#define SEMANTIC_ARGUMENT_CAPACITY 80u
#define PROJECTION_SELECTOR_BITS   8u
#define X86_ALU_RESULT_SELECTOR    16u

typedef struct {
    pl_plan *plan;
    pl_u32 node_capacity;
    pl_u32 argument_capacity;
    pl_u32 depth[SEMANTIC_NODE_CAPACITY + 1u];
    pl_operand last_memory;
} semantic_builder;

static pl_operand operand(pl_u8 kind, pl_u64 value)
{
    pl_operand out;
    out.kind = kind;
    out.value = value;
    return out;
}

static pl_u64 lane_mask(pl_u32 bits)
{
    return bits == 64u ? ~0ull : (1ull << bits) - 1ull;
}

static pl_u32 dependency(pl_operand value)
{
    if (value.kind == PL_OPERAND_NODE) return (pl_u32)value.value;
    if (value.kind == PL_OPERAND_PROJECTION)
        return (pl_u32)(value.value >> PROJECTION_SELECTOR_BITS);
    return 0u;
}

static pl_operand emit(semantic_builder *builder, pl_u32 opcode,
                       const pl_operand *arguments, pl_u32 count)
{
    pl_plan *plan = builder->plan;
    if (plan->node_count >= builder->node_capacity
            || count > builder->argument_capacity - plan->argument_count)
        return operand(PL_OPERAND_CONST, ~0ull);
    pl_u32 value = plan->node_count + 1u;
    pl_node *node = &plan->nodes[plan->node_count++];
    node->opcode = opcode;
    node->argument_at = plan->argument_count;
    node->argument_count = count;
    pl_u32 deepest = 0u;
    for (pl_u32 index = 0u; index < count; ++index) {
        plan->arguments[plan->argument_count++] = arguments[index];
        pl_u32 source = dependency(arguments[index]);
        if (source && builder->depth[source] > deepest)
            deepest = builder->depth[source];
    }
    builder->depth[value] = deepest + 1u;
    return operand(PL_OPERAND_NODE, value);
}

static int open_plan(pl_arena *arena, pl_plan *plan,
                     semantic_builder *builder)
{
    plan->function = 0u;
    plan->start = 0u;
    plan->end = 1u;
    plan->instructions = 1u;
    plan->stack_inputs = 0u;
    plan->span = 0u;
    plan->node_count = 0u;
    plan->argument_count = 0u;
    plan->stack_count = 0u;
    plan->local_count = PL_X86_LOCAL_COUNT;
    plan->nodes = pl_arena_take(
        arena, SEMANTIC_NODE_CAPACITY * (pl_u32)sizeof *plan->nodes);
    plan->arguments = pl_arena_take(
        arena, SEMANTIC_ARGUMENT_CAPACITY
             * (pl_u32)sizeof *plan->arguments);
    plan->locals = pl_arena_take(
        arena, PL_X86_LOCAL_COUNT * (pl_u32)sizeof *plan->locals);
    plan->wave_offsets = pl_arena_take(
        arena, (SEMANTIC_NODE_CAPACITY + 2u)
             * (pl_u32)sizeof *plan->wave_offsets);
    plan->wave_values = pl_arena_take(
        arena, SEMANTIC_NODE_CAPACITY * (pl_u32)sizeof *plan->wave_values);
    plan->stack = 0;
    if (!plan->nodes || !plan->arguments || !plan->locals
            || !plan->wave_offsets || !plan->wave_values)
        return PL_ERROR_ARENA;
    for (pl_u32 index = 0u; index < PL_X86_LOCAL_COUNT; ++index)
        plan->locals[index] = operand(PL_OPERAND_LOCAL, index);
    builder->plan = plan;
    builder->node_capacity = SEMANTIC_NODE_CAPACITY;
    builder->argument_capacity = SEMANTIC_ARGUMENT_CAPACITY;
    builder->last_memory = operand(PL_OPERAND_CONST, 0u);
    for (pl_u32 index = 0u; index <= SEMANTIC_NODE_CAPACITY; ++index)
        builder->depth[index] = 0u;
    return 0;
}

static int close_plan(semantic_builder *builder)
{
    pl_plan *plan = builder->plan;
    pl_u32 span = 0u;
    for (pl_u32 value = 1u; value <= plan->node_count; ++value)
        if (builder->depth[value] > span) span = builder->depth[value];
    plan->span = span;
    for (pl_u32 wave = 0u; wave <= span; ++wave)
        plan->wave_offsets[wave] = 0u;
    for (pl_u32 value = 1u; value <= plan->node_count; ++value)
        ++plan->wave_offsets[builder->depth[value]];
    for (pl_u32 wave = 1u; wave <= span; ++wave)
        plan->wave_offsets[wave] += plan->wave_offsets[wave - 1u];
    for (pl_u32 wave = span; wave > 1u; --wave)
        plan->wave_offsets[wave] = plan->wave_offsets[wave - 1u];
    if (span) plan->wave_offsets[1] = 0u;
    for (pl_u32 value = 1u; value <= plan->node_count; ++value) {
        pl_u32 wave = builder->depth[value];
        if (!wave || wave > span) return PL_ERROR_X86_SEMANTIC;
        plan->wave_values[plan->wave_offsets[wave]++] = value;
    }
    return plan->wave_offsets[0] == 0u
        && plan->wave_offsets[span] == plan->node_count
         ? 0 : PL_ERROR_X86_SEMANTIC;
}

static int gpr(const pl_x86_operand *source, pl_u32 *index,
               pl_u32 *bits, pl_u32 *offset)
{
    if (!source || source->kind != PL_X86_OPERAND_REGISTER
            || source->value.reg.class_id != PL_X86_REGISTER_GPR
            || source->value.reg.index >= PL_X86_GPR_COUNT)
        return PL_ERROR_X86_SEMANTIC;
    *index = source->value.reg.index;
    *bits = source->bits;
    *offset = (source->value.reg.flags & PL_X86_REGISTER_HIGH8) ? 8u : 0u;
    if ((*bits != 8u && *bits != 16u && *bits != 32u && *bits != 64u)
            || (*offset && *bits != 8u))
        return PL_ERROR_X86_SEMANTIC;
    return 0;
}

static int scalar_value(const pl_x86_operand *source, pl_operand *value,
                        int *constant)
{
    if (source->kind == PL_X86_OPERAND_IMMEDIATE) {
        *value = operand(PL_OPERAND_CONST, source->value.immediate);
        *constant = 1;
        return 0;
    }
    pl_u32 index, bits, offset;
    int status = gpr(source, &index, &bits, &offset);
    if (status || offset) return PL_ERROR_X86_SEMANTIC;
    *value = operand(PL_OPERAND_LOCAL, index);
    *constant = 0;
    return 0;
}

static int add_address(semantic_builder *builder, pl_operand left,
                       pl_operand right, pl_operand *result)
{
    if (left.kind == PL_OPERAND_CONST && left.value == 0u) {
        *result = right;
        return 0;
    }
    if (right.kind == PL_OPERAND_CONST && right.value == 0u) {
        *result = left;
        return 0;
    }
    if (left.kind == PL_OPERAND_CONST && right.kind == PL_OPERAND_CONST) {
        *result = operand(PL_OPERAND_CONST, left.value + right.value);
        return 0;
    }
    pl_u32 opcode;
    pl_operand arguments[2];
    if (left.kind == PL_OPERAND_CONST) {
        arguments[0] = right;
        arguments[1] = left;
        opcode = PL_OPCODE_ADD;
    } else if (right.kind == PL_OPERAND_CONST) {
        arguments[0] = left;
        arguments[1] = right;
        opcode = PL_OPCODE_ADD;
    } else {
        arguments[0] = left;
        arguments[1] = right;
        opcode = PL_OPCODE_ALU_REGISTER[1][1];
    }
    *result = emit(builder, opcode, arguments, 2u);
    return result->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static int effective_address_with_stack(
        semantic_builder *builder, const pl_x86_instruction *instruction,
        const pl_x86_operand *source, int apply_segment,
        const pl_operand *stack, pl_operand *result)
{
    if (!source || source->kind != PL_X86_OPERAND_MEMORY)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_memory *memory = &source->value.memory;
    if (apply_segment
            && memory->segment.class_id != PL_X86_REGISTER_NONE
            && (memory->segment.class_id != PL_X86_REGISTER_SEGMENT
                || memory->segment.index > 5u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand address = operand(
        PL_OPERAND_CONST,
        memory->has_displacement ? (pl_u64)memory->displacement : 0u);
    if (memory->base.class_id == PL_X86_REGISTER_GPR) {
        if (memory->base.index >= PL_X86_GPR_COUNT)
            return PL_ERROR_X86_SEMANTIC;
        pl_operand base = stack && memory->base.index == 4u
                        ? *stack
                        : operand(PL_OPERAND_LOCAL, memory->base.index);
        int status = add_address(builder, address, base, &address);
        if (status) return status;
    } else if (memory->base.class_id == PL_X86_REGISTER_IP) {
        int status = add_address(
            builder, address,
            operand(PL_OPERAND_CONST, instruction->fallthrough), &address);
        if (status) return status;
    } else if (memory->base.class_id != PL_X86_REGISTER_NONE) {
        return PL_ERROR_X86_SEMANTIC;
    }
    if (memory->index.class_id == PL_X86_REGISTER_GPR) {
        if (memory->index.index >= PL_X86_GPR_COUNT
                || (memory->scale != 1u && memory->scale != 2u
                    && memory->scale != 4u && memory->scale != 8u))
            return PL_ERROR_X86_SEMANTIC;
        pl_operand index = operand(
            PL_OPERAND_LOCAL, memory->index.index);
        if (memory->scale != 1u) {
            pl_u32 shift = memory->scale == 2u ? 1u
                         : memory->scale == 4u ? 2u : 3u;
            pl_operand arguments[2] = {
                index, operand(PL_OPERAND_CONST, shift),
            };
            index = emit(
                builder, PL_OPCODE_LANE64_SHL, arguments, 2u);
            if (index.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
        }
        int status = add_address(builder, address, index, &address);
        if (status) return status;
    } else if (memory->index.class_id != PL_X86_REGISTER_NONE) {
        return PL_ERROR_X86_SEMANTIC;
    }
    if (apply_segment
            && memory->segment.class_id == PL_X86_REGISTER_SEGMENT
            && memory->segment.index >= 4u) {
        pl_u32 local = memory->segment.index == 4u
                     ? PL_X86_FS_BASE_LOCAL : PL_X86_GS_BASE_LOCAL;
        int status = add_address(
            builder, address, operand(PL_OPERAND_LOCAL, local), &address);
        if (status) return status;
    }
    *result = address;
    return 0;
}

static int effective_address(semantic_builder *builder,
                             const pl_x86_instruction *instruction,
                             const pl_x86_operand *source,
                             int apply_segment,
                             pl_operand *result)
{
    return effective_address_with_stack(
        builder, instruction, source, apply_segment, 0, result);
}

static pl_u64 memory_shape(pl_u32 bits)
{
    return (pl_u64)(bits / 8u) | PL_MEMORY_SHAPE_VIRTUAL64;
}

static int memory_load(semantic_builder *builder, pl_operand address,
                       pl_u32 bits, pl_operand *result)
{
    pl_u32 width = bits / 8u;
    if ((bits != 8u && bits != 16u && bits != 32u && bits != 64u)
            || PL_OPCODE_REGION_LOAD[1][width][0] == 255u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand arguments[4];
    pl_u32 count = 3u;
    arguments[0] = address;
    arguments[1] = operand(PL_OPERAND_CONST, 0u);
    arguments[2] = operand(PL_OPERAND_CONST, memory_shape(bits));
    if (builder->last_memory.kind == PL_OPERAND_NODE)
        arguments[count++] = builder->last_memory;
    *result = emit(
        builder, PL_OPCODE_REGION_LOAD[1][width][0], arguments, count);
    if (result->kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->last_memory = *result;
    return 0;
}

static int memory_store(semantic_builder *builder, pl_operand address,
                        pl_operand value, pl_u32 bits)
{
    pl_u32 opcode = bits == 64u ? PL_OPCODE_MEMORY_STORE
                  : bits == 32u ? PL_OPCODE_MEMORY_STORE32
                  : bits == 16u ? PL_OPCODE_MEMORY_STORE16
                  : bits == 8u ? PL_OPCODE_MEMORY_STORE8 : 255u;
    if (opcode == 255u) return PL_ERROR_X86_SEMANTIC;
    pl_operand arguments[5];
    pl_u32 count = 4u;
    arguments[0] = address;
    arguments[1] = value;
    arguments[2] = operand(PL_OPERAND_CONST, 0u);
    arguments[3] = operand(PL_OPERAND_CONST, memory_shape(bits));
    if (builder->last_memory.kind == PL_OPERAND_NODE)
        arguments[count++] = builder->last_memory;
    pl_operand stored = emit(builder, opcode, arguments, count);
    if (stored.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->last_memory = stored;
    return 0;
}

static int memory_store_if(semantic_builder *builder, pl_operand address,
                           pl_operand value, pl_operand predicate,
                           pl_u32 bits)
{
    if (bits != 8u && bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand arguments[6];
    pl_u32 count = 5u;
    arguments[0] = address;
    arguments[1] = value;
    arguments[2] = predicate;
    arguments[3] = operand(PL_OPERAND_CONST, 0u);
    arguments[4] = operand(PL_OPERAND_CONST, memory_shape(bits));
    if (builder->last_memory.kind == PL_OPERAND_NODE)
        arguments[count++] = builder->last_memory;
    pl_operand stored = emit(
        builder, PL_OPCODE_MEMORY_STORE_IF, arguments, count);
    if (stored.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->last_memory = stored;
    return 0;
}

static int memory_frame(semantic_builder *builder, pl_operand frame,
                        pl_operand base, pl_u32 level, pl_u32 bits)
{
    if (level > 31u || (bits != 16u && bits != 64u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand arguments[5];
    pl_u32 count = 4u;
    arguments[0] = frame;
    arguments[1] = base;
    arguments[2] = operand(PL_OPERAND_CONST, level);
    arguments[3] = operand(PL_OPERAND_CONST, memory_shape(bits));
    if (builder->last_memory.kind == PL_OPERAND_NODE)
        arguments[count++] = builder->last_memory;
    pl_operand stored = emit(builder, PL_OPCODE_MEMORY_FRAME, arguments, count);
    if (stored.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->last_memory = stored;
    return 0;
}

static int read_value(semantic_builder *builder,
                      const pl_x86_instruction *instruction,
                      const pl_x86_operand *source, pl_operand *value,
                      int *constant, int *narrow)
{
    if (source->kind != PL_X86_OPERAND_MEMORY) {
        if (source->kind == PL_X86_OPERAND_REGISTER
                && (source->value.reg.flags & PL_X86_REGISTER_HIGH8)) {
            pl_u32 index, bits, offset;
            int status = gpr(source, &index, &bits, &offset);
            if (status || offset != 8u) return PL_ERROR_X86_SEMANTIC;
            pl_operand arguments[2] = {
                operand(PL_OPERAND_LOCAL, index),
                operand(PL_OPERAND_CONST, 8u),
            };
            *value = emit(
                builder, PL_OPCODE_LANE64_SHR, arguments, 2u);
            if (value->kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
            *constant = 0;
            *narrow = 0;
            return 0;
        }
        int status = scalar_value(source, value, constant);
        *narrow = *constant;
        return status;
    }
    pl_operand address;
    int status = effective_address(
        builder, instruction, source, 1, &address);
    if (status) return status;
    status = memory_load(builder, address, source->bits, value);
    *constant = 0;
    *narrow = 1;
    return status;
}

static int published_register(semantic_builder *builder,
                              const pl_x86_operand *destination,
                              pl_operand value, int value_is_narrow);

static int zero_extend(semantic_builder *builder, pl_operand source,
                       pl_u32 bits, pl_operand *result)
{
    pl_operand arguments[3] = {
        operand(PL_OPERAND_CONST, 0u), source,
        operand(PL_OPERAND_CONST, bits),
    };
    *result = emit(builder, PL_OPCODE_LANE64_INSERT, arguments, 3u);
    return result->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static int lower_extend(const pl_x86_instruction *instruction,
                        semantic_builder *builder, int sign)
{
    if (instruction->visible_operand_count < 2u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 destination_index, destination_bits, destination_offset;
    if (gpr(destination, &destination_index, &destination_bits,
            &destination_offset) || destination_offset
            || (source->bits != 8u && source->bits != 16u
                && source->bits != 32u))
        return PL_ERROR_X86_SEMANTIC;
    if (source->kind == PL_X86_OPERAND_REGISTER
            && source->value.reg.class_id == PL_X86_REGISTER_GPR
            && source->value.reg.index == destination_index
            && source->value.reg.flags == destination->value.reg.flags
            && source->bits == destination_bits
            && destination_bits != 32u)
        return 0;
    pl_operand value;
    int constant, narrow;
    int status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    if (status) return status;
    if (source->bits < destination_bits) {
        if (sign) {
            pl_u32 opcode = source->bits == 8u
                          ? PL_OPCODE_LANE64_EXTEND8_S
                          : source->bits == 16u
                              ? PL_OPCODE_LANE64_EXTEND16_S
                              : PL_OPCODE_EXTEND32_S;
            pl_operand arguments[1] = { value };
            value = emit(builder, opcode, arguments, 1u);
            if (value.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
            narrow = 0;
        } else if (!constant && !narrow) {
            status = zero_extend(builder, value, source->bits, &value);
            if (status) return status;
            narrow = 1;
        } else if (constant) {
            value.value &= lane_mask(source->bits);
            narrow = 1;
        }
    } else {
        /* Redundant operand-size prefixes can make MOVSX/MOVZX same-width,
         * and MOVSXD can name a 16-bit destination.  The source access keeps
         * its decoded width (and therefore its exact fault extent), while
         * publication truncates to the destination exactly like MOV. */
        if (constant) value.value &= lane_mask(destination_bits);
        narrow = constant
              || (narrow && source->bits <= destination_bits);
    }
    return published_register(
        builder, destination, value,
        destination_bits == 32u && narrow);
}

static int lower_load_address(const pl_x86_instruction *instruction,
                              semantic_builder *builder)
{
    if (instruction->visible_operand_count < 2u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 index, bits, offset;
    if (gpr(destination, &index, &bits, &offset) || offset
            || source->kind != PL_X86_OPERAND_MEMORY)
        return PL_ERROR_X86_SEMANTIC;
    (void)index;
    pl_operand address;
    int status = effective_address(
        builder, instruction, source, 0, &address);
    if (status) return status;
    if (address.kind == PL_OPERAND_CONST) address.value &= lane_mask(bits);
    return published_register(
        builder, destination, address,
        address.kind == PL_OPERAND_CONST);
}

static int published_register(semantic_builder *builder,
                              const pl_x86_operand *destination,
                              pl_operand value, int value_is_narrow)
{
    pl_u32 index, bits, offset;
    int status = gpr(destination, &index, &bits, &offset);
    if (status) return status;
    if (bits == 64u || (bits == 32u && value_is_narrow)) {
        builder->plan->locals[index] = value;
        return 0;
    }
    pl_operand arguments[3];
    arguments[0] = bits == 32u
                 ? operand(PL_OPERAND_CONST, 0u)
                 : operand(PL_OPERAND_LOCAL, index);
    arguments[1] = value;
    arguments[2] = operand(PL_OPERAND_CONST, bits | ((pl_u64)offset << 8u));
    pl_operand result = emit(
        builder, PL_OPCODE_LANE64_INSERT, arguments, 3u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[index] = result;
    return 0;
}

static int lower_move(const pl_x86_instruction *instruction,
                      semantic_builder *builder)
{
    if (instruction->visible_operand_count < 2u) return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 bits = destination->bits;
    if ((bits != 8u && bits != 16u && bits != 32u && bits != 64u)
            || (source->kind != PL_X86_OPERAND_IMMEDIATE
                && source->bits != bits))
        return PL_ERROR_X86_SEMANTIC;
    if (destination->kind == PL_X86_OPERAND_MEMORY) {
        if (source->kind == PL_X86_OPERAND_MEMORY)
            return PL_ERROR_X86_SEMANTIC;
        pl_operand value, address;
        int constant = 0, narrow = 0;
        int status = read_value(
            builder, instruction, source, &value, &constant, &narrow);
        (void)narrow;
        if (status) return status;
        if (constant) value.value &= lane_mask(bits);
        status = effective_address(
            builder, instruction, destination, 1, &address);
        return status ? status : memory_store(builder, address, value, bits);
    }
    pl_u32 destination_index, destination_bits, offset;
    int status = gpr(
        destination, &destination_index, &destination_bits, &offset);
    (void)destination_index;
    if (status) return status;
    pl_operand value;
    int constant = 0, narrow = 0;
    status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    if (status) return status;
    if (constant) value.value &= lane_mask(bits);
    return published_register(
        builder, destination, value, constant || narrow);
}

static int lower_exchange(const pl_x86_instruction *instruction,
                          semantic_builder *builder)
{
    if (instruction->visible_operand_count < 2u) return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *left = &instruction->operands[0];
    const pl_x86_operand *right = &instruction->operands[1];
    pl_u32 left_index, left_bits, left_offset;
    pl_u32 right_index, right_bits, right_offset;
    if (gpr(left, &left_index, &left_bits, &left_offset)
            || gpr(right, &right_index, &right_bits, &right_offset)
            || left_bits != right_bits)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand left_value, right_value;
    int left_constant, left_narrow, right_constant, right_narrow;
    int status = read_value(
        builder, instruction, left, &left_value,
        &left_constant, &left_narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, right, &right_value,
        &right_constant, &right_narrow);
    if (status) return status;
    (void)left_constant;
    (void)right_constant;

    if (left_index != right_index) {
        status = published_register(
            builder, left, right_value, right_narrow);
        return status ? status : published_register(
            builder, right, left_value, left_narrow);
    }

    /* ModRM can name overlapping byte registers from the same GPR.  Both
     * sources are architectural inputs, then the two publications compose
     * into one final word; this is a parallel exchange, not two scalar
     * assignments.  A same-register r32 exchange still performs the x86-64
     * zero-extension implied by a 32-bit destination write. */
    if (left_offset == right_offset) {
        if (left_bits != 32u) return 0;
        return published_register(builder, left, left_value, 0);
    }
    if (left_bits != 8u
            || (left_offset != 0u && left_offset != 8u)
            || (right_offset != 0u && right_offset != 8u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand first_arguments[3] = {
        operand(PL_OPERAND_LOCAL, left_index), right_value,
        operand(PL_OPERAND_CONST,
                left_bits | ((pl_u64)left_offset << 8u)),
    };
    pl_operand first = emit(
        builder, PL_OPCODE_LANE64_INSERT, first_arguments, 3u);
    if (first.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand second_arguments[3] = {
        first, left_value,
        operand(PL_OPERAND_CONST,
                right_bits | ((pl_u64)right_offset << 8u)),
    };
    pl_operand result = emit(
        builder, PL_OPCODE_LANE64_INSERT, second_arguments, 3u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[left_index] = result;
    return 0;
}

static int alu_mode(pl_u32 operation, pl_u32 *mode, int *writes,
                    int *preserves_carry)
{
    *writes = 1;
    *preserves_carry = 0;
    switch (operation) {
    case PL_X86_OPERATION_AND: *mode = 0u; return 0;
    case PL_X86_OPERATION_ADD: *mode = 1u; return 0;
    case PL_X86_OPERATION_ADD_CARRY: *mode = 2u; return 0;
    case PL_X86_OPERATION_SUBTRACT: *mode = 3u; return 0;
    case PL_X86_OPERATION_SUBTRACT_BORROW: *mode = 4u; return 0;
    case PL_X86_OPERATION_OR: *mode = 5u; return 0;
    case PL_X86_OPERATION_XOR: *mode = 6u; return 0;
    case PL_X86_OPERATION_COMPARE:
        *mode = 3u; *writes = 0; return 0;
    case PL_X86_OPERATION_INCREMENT:
        *mode = 1u; *preserves_carry = 1; return 0;
    case PL_X86_OPERATION_DECREMENT:
        *mode = 3u; *preserves_carry = 1; return 0;
    case PL_X86_OPERATION_NEGATE: *mode = 3u; return 0;
    default: return PL_ERROR_X86_SEMANTIC;
    }
}

static int lower_alu(const pl_x86_instruction *instruction,
                     semantic_builder *builder)
{
    if (!instruction->visible_operand_count) return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    pl_u32 bits = destination->bits;
    if (bits != 8u && bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand left, destination_address;
    int destination_memory = destination->kind == PL_X86_OPERAND_MEMORY;
    int left_constant = 0, left_narrow = 0;
    int status;
    if (destination_memory) {
        status = effective_address(
            builder, instruction, destination, 1, &destination_address);
        if (!status) status = memory_load(builder, destination_address, bits, &left);
    } else {
        status = read_value(
            builder, instruction, destination, &left,
            &left_constant, &left_narrow);
    }
    (void)left_constant;
    (void)left_narrow;
    if (status) return status;
    pl_operand right;
    int constant = 0;
    if (instruction->operation == PL_X86_OPERATION_INCREMENT
            || instruction->operation == PL_X86_OPERATION_DECREMENT) {
        right = operand(PL_OPERAND_CONST, 1u);
    } else if (instruction->operation == PL_X86_OPERATION_NEGATE) {
        right = left;
        left = operand(PL_OPERAND_CONST, 0u);
    } else {
        if (instruction->visible_operand_count < 2u)
            return PL_ERROR_X86_SEMANTIC;
        int narrow = 0;
        status = read_value(
            builder, instruction, &instruction->operands[1], &right,
            &constant, &narrow);
        (void)constant;
        (void)narrow;
        if (status) return status;
    }
    pl_u32 mode = 0u;
    int writes = 0, preserves_carry = 0;
    status = alu_mode(
        instruction->operation, &mode, &writes, &preserves_carry);
    if (status) return status;
    pl_operand arguments[4];
    arguments[0] = operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL);
    arguments[1] = left;
    arguments[2] = right;
    arguments[3] = operand(
        PL_OPERAND_CONST,
        bits | ((pl_u64)mode << 8u) | ((pl_u64)preserves_carry << 11u));
    pl_u32 opcode = writes ? PL_OPCODE_X86_ALU : PL_OPCODE_X86_COMPARE;
    pl_operand flags = emit(builder, opcode, arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    if (!writes) return 0;
    pl_operand result = operand(
        PL_OPERAND_PROJECTION,
        (flags.value << PROJECTION_SELECTOR_BITS)
        | X86_ALU_RESULT_SELECTOR);
    if (destination_memory)
        return memory_store(builder, destination_address, result, bits);
    return published_register(builder, destination, result, 1);
}

static int publish_two_slices(semantic_builder *builder,
                              const pl_x86_operand *first,
                              pl_operand first_value, int first_narrow,
                              const pl_x86_operand *second,
                              pl_operand second_value, int second_narrow)
{
    pl_u32 first_index, first_bits, first_offset;
    pl_u32 second_index, second_bits, second_offset;
    if (gpr(first, &first_index, &first_bits, &first_offset)
            || gpr(second, &second_index, &second_bits, &second_offset)
            || first_bits != second_bits)
        return PL_ERROR_X86_SEMANTIC;
    if (first_index != second_index) {
        int status = published_register(
            builder, first, first_value, first_narrow);
        return status ? status : published_register(
            builder, second, second_value, second_narrow);
    }
    if (first_offset == second_offset) return PL_ERROR_X86_SEMANTIC;
    if (first_bits != 8u
            || (first_offset != 0u && first_offset != 8u)
            || (second_offset != 0u && second_offset != 8u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand first_arguments[3] = {
        operand(PL_OPERAND_LOCAL, first_index), first_value,
        operand(PL_OPERAND_CONST,
                first_bits | ((pl_u64)first_offset << 8u)),
    };
    pl_operand merged = emit(
        builder, PL_OPCODE_LANE64_INSERT, first_arguments, 3u);
    if (merged.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand second_arguments[3] = {
        merged, second_value,
        operand(PL_OPERAND_CONST,
                second_bits | ((pl_u64)second_offset << 8u)),
    };
    merged = emit(builder, PL_OPCODE_LANE64_INSERT, second_arguments, 3u);
    if (merged.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[first_index] = merged;
    return 0;
}

static int lower_exchange_add(const pl_x86_instruction *instruction,
                              semantic_builder *builder)
{
    if (instruction->visible_operand_count != 2u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 source_index, source_bits, source_offset;
    if (gpr(source, &source_index, &source_bits, &source_offset)
            || (source_bits != 8u && source_bits != 16u
                && source_bits != 32u && source_bits != 64u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand left, address;
    int left_constant = 0, left_narrow = 0;
    int destination_memory = destination->kind == PL_X86_OPERAND_MEMORY;
    int status;
    if (destination_memory) {
        if (destination->bits != source_bits)
            return PL_ERROR_X86_SEMANTIC;
        status = effective_address(
            builder, instruction, destination, 1, &address);
        if (!status)
            status = memory_load(builder, address, source_bits, &left);
        left_narrow = 1;
    } else {
        pl_x86_register_update law;
        if(!pl_x86_register_update_lower(instruction,&law) || law.compare)return PL_ERROR_X86_SEMANTIC;
        pl_u32 destination_index, destination_bits, destination_offset;
        if (gpr(destination, &destination_index, &destination_bits,
                &destination_offset) || destination_bits != source_bits)
            return PL_ERROR_X86_SEMANTIC;
        status = read_value(
            builder, instruction, destination, &left,
            &left_constant, &left_narrow);
    }
    (void)left_constant;
    if (status) return status;
    pl_operand right;
    int right_constant = 0, right_narrow = 0;
    status = read_value(
        builder, instruction, source, &right,
        &right_constant, &right_narrow);
    (void)right_constant;
    (void)right_narrow;
    if (status) return status;
    pl_operand arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL), left, right,
        operand(PL_OPERAND_CONST, source_bits | (1u << 8u)),
    };
    pl_operand flags = emit(builder, PL_OPCODE_X86_ALU, arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    pl_operand result = operand(
        PL_OPERAND_PROJECTION,
        (flags.value << PROJECTION_SELECTOR_BITS) | X86_ALU_RESULT_SELECTOR);
    if (destination_memory) {
        status = memory_store(builder, address, result, source_bits);
        return status ? status : published_register(
            builder, source, left, left_narrow);
    }
    pl_u32 destination_index, destination_bits, destination_offset;
    if (gpr(destination, &destination_index, &destination_bits,
            &destination_offset))
        return PL_ERROR_X86_SEMANTIC;
    if (destination_index == source_index
            && destination_offset == source_offset)
        return published_register(builder, destination, result, 1);
    return publish_two_slices(
        builder, source, left, left_narrow,
        destination, result, 1);
}

static int lower_compare_exchange(const pl_x86_instruction *instruction,
                                  semantic_builder *builder)
{
    pl_x86_register_update law;
    if(!pl_x86_register_update_lower(instruction,&law) || !law.compare)return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 destination_index, bits, destination_offset;
    pl_u32 source_index, source_bits, source_offset;
    if (gpr(destination, &destination_index, &bits, &destination_offset)
            || gpr(source, &source_index, &source_bits, &source_offset)
            || bits != source_bits)
        return PL_ERROR_X86_SEMANTIC;
    pl_x86_operand accumulator = { 0 };
    accumulator.kind = PL_X86_OPERAND_REGISTER;
    accumulator.bits = (pl_u16)bits;
    accumulator.value.reg.class_id = PL_X86_REGISTER_GPR;
    accumulator.value.reg.index = 0u;
    accumulator.value.reg.bits = (pl_u16)bits;
    pl_operand destination_value, source_value, accumulator_value;
    int constant, destination_narrow, source_narrow, accumulator_narrow;
    int status = read_value(
        builder, instruction, destination, &destination_value,
        &constant, &destination_narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, source, &source_value,
        &constant, &source_narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, &accumulator, &accumulator_value,
        &constant, &accumulator_narrow);
    if (status) return status;
    (void)constant;
    (void)accumulator_narrow;
    pl_operand compare_arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        accumulator_value, destination_value,
        operand(PL_OPERAND_CONST, bits | (3u << 8u)),
    };
    pl_operand flags = emit(
        builder, PL_OPCODE_X86_COMPARE, compare_arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    pl_operand equal = operand(
        PL_OPERAND_PROJECTION,
        (flags.value << PROJECTION_SELECTOR_BITS) | 4u);
    /* Merge complete parent definitions, not selected narrow lane values.
     * A successful CMPXCHG r32 does not write EAX; a failed one does not write
     * the destination. Selecting lane32 first would erase an untouched upper
     * half in either arm. AL/AH share one parent but two different fields. */
    pl_operand before_destination=builder->plan->locals[destination_index];
    pl_operand before_accumulator=builder->plan->locals[0u];
    status=published_register(builder,destination,source_value,source_narrow);
    if(status)return status;
    pl_operand success=builder->plan->locals[destination_index];
    builder->plan->locals[destination_index]=before_destination;
    if(destination_index==0u && !destination_offset){
        builder->plan->locals[0u]=success;return 0; /* comparison is reflexive */
    }
    status=published_register(builder,&accumulator,destination_value,destination_narrow);
    if(status)return status;
    pl_operand failure=builder->plan->locals[0u];
    builder->plan->locals[0u]=before_accumulator;
    pl_operand destination_arguments[3]={success,destination_index?before_destination:failure,equal};
    pl_operand next=emit(builder,PL_OPCODE_LANE64_SELECT,destination_arguments,3u);
    if(next.kind!=PL_OPERAND_NODE)return PL_ERROR_ARENA;
    builder->plan->locals[destination_index]=next;
    if(!destination_index)return 0;
    pl_operand accumulator_arguments[3]={before_accumulator,failure,equal};
    next=emit(builder,PL_OPCODE_LANE64_SELECT,accumulator_arguments,3u);
    if(next.kind!=PL_OPERAND_NODE)return PL_ERROR_ARENA;
    builder->plan->locals[0u]=next;return 0;
}

static int lower_test(const pl_x86_instruction *instruction,
                      semantic_builder *builder)
{
    if (instruction->visible_operand_count < 2u) return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *left_source = &instruction->operands[0];
    pl_u32 bits = left_source->bits;
    if (bits != 8u && bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand left, right;
    int constant, narrow;
    int status = read_value(
        builder, instruction, left_source, &left, &constant, &narrow);
    (void)constant;
    (void)narrow;
    if (status) return status;
    status = read_value(
        builder, instruction, &instruction->operands[1], &right,
        &constant, &narrow);
    (void)constant;
    (void)narrow;
    if (status) return status;
    pl_operand arguments[4];
    arguments[0] = operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL);
    arguments[1] = left;
    arguments[2] = right;
    arguments[3] = operand(PL_OPERAND_CONST, bits);
    pl_operand flags = emit(builder, PL_OPCODE_X86_TEST, arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    return 0;
}

static int lower_complement(const pl_x86_instruction *instruction,
                            semantic_builder *builder)
{
    if (!instruction->visible_operand_count) return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    pl_u32 bits = destination->bits;
    if (bits != 8u && bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand source, destination_address;
    int destination_memory = destination->kind == PL_X86_OPERAND_MEMORY;
    int constant, narrow;
    int status;
    if (destination_memory) {
        status = effective_address(
            builder, instruction, destination, 1, &destination_address);
        if (!status) status = memory_load(
            builder, destination_address, bits, &source);
        constant = 0;
        narrow = 1;
    } else {
        status = read_value(
            builder, instruction, destination, &source, &constant, &narrow);
    }
    (void)constant;
    (void)narrow;
    if (status) return status;
    pl_operand arguments[2];
    arguments[0] = source;
    arguments[1] = operand(PL_OPERAND_CONST, lane_mask(bits));
    pl_u32 lane = bits == 32u ? 0u : 1u;
    pl_operand result = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[lane][4], arguments, 2u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    if (destination_memory)
        return memory_store(builder, destination_address, result, bits);
    return published_register(builder, destination, result, bits == 32u);
}

static int condition_value(semantic_builder *builder, pl_u32 condition,
                           pl_operand *result)
{
    if (condition > 15u) return PL_ERROR_X86_SEMANTIC;
    pl_operand arguments[2] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        operand(PL_OPERAND_CONST, condition),
    };
    *result = emit(builder, PL_OPCODE_X86_CONDITION, arguments, 2u);
    return result->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static int lower_branch(const pl_x86_instruction *instruction,
                        semantic_builder *builder, pl_x86_semantic *out)
{
    if (instruction->flow == PL_X86_FLOW_CONDITIONAL) {
        if (!(instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
                || instruction->condition > 15u)
            return PL_ERROR_X86_SEMANTIC;
        int status = condition_value(
            builder, instruction->condition, &out->predicate);
        if (status) return status;
        out->has_predicate = 1u;
        out->target = operand(PL_OPERAND_CONST, instruction->target);
        out->successor[0] = instruction->target;
        out->successor[1] = instruction->fallthrough;
        out->successor_count = 2u;
        return 0;
    }
    if (instruction->flow != PL_X86_FLOW_JUMP)
        return PL_ERROR_X86_SEMANTIC;
    if (instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET) {
        out->target = operand(PL_OPERAND_CONST, instruction->target);
        out->successor[0] = instruction->target;
        out->successor_count = 1u;
        return 0;
    }
    if (instruction->visible_operand_count < 1u)
        return PL_ERROR_X86_SEMANTIC;
    int constant, narrow;
    int status = read_value(
        builder, instruction, &instruction->operands[0], &out->target,
        &constant, &narrow);
    (void)constant;
    (void)narrow;
    if (status) return status;
    out->dynamic_target = 1u;
    out->successor_count = 0u;
    return 0;
}

static pl_u64 sign_extend_constant(pl_u64 value, pl_u32 bits)
{
    pl_u64 mask = lane_mask(bits);
    value &= mask;
    return value & (1ull << (bits - 1u)) ? value | ~mask : value;
}

static int stack_pointer(semantic_builder *builder, pl_i64 delta,
                         pl_operand *result)
{
    pl_operand arguments[2] = {
        operand(PL_OPERAND_LOCAL, 4u),
        operand(PL_OPERAND_CONST, (pl_u64)delta),
    };
    *result = emit(builder, PL_OPCODE_ADD, arguments, 2u);
    return result->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static int extend_stack_value(semantic_builder *builder, pl_operand *value,
                              int constant, pl_u32 source_bits,
                              pl_u32 stack_bits)
{
    if (source_bits == stack_bits) return 0;
    if (source_bits > stack_bits
            || (source_bits != 8u && source_bits != 16u
                && source_bits != 32u))
        return PL_ERROR_X86_SEMANTIC;
    if (constant) {
        value->value = sign_extend_constant(value->value, source_bits);
        return 0;
    }
    pl_u32 opcode = source_bits == 8u ? PL_OPCODE_LANE64_EXTEND8_S
                  : source_bits == 16u ? PL_OPCODE_LANE64_EXTEND16_S
                  : PL_OPCODE_EXTEND32_S;
    pl_operand arguments[1] = { *value };
    *value = emit(builder, opcode, arguments, 1u);
    return value->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static int lower_push(const pl_x86_instruction *instruction,
                      semantic_builder *builder)
{
    if (instruction->visible_operand_count < 1u)
        return PL_ERROR_X86_SEMANTIC;
    pl_u32 stack_bits = instruction->operand_width;
    if (stack_bits != 16u && stack_bits != 64u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *source = &instruction->operands[0];
    pl_operand value;
    int constant, narrow;
    int status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    (void)narrow;
    if (status) return status;
    status = extend_stack_value(
        builder, &value, constant, source->bits, stack_bits);
    if (status) return status;
    pl_operand next_rsp;
    status = stack_pointer(
        builder, -(pl_i64)(stack_bits / 8u), &next_rsp);
    if (status) return status;
    status = memory_store(builder, next_rsp, value, stack_bits);
    if (status) return status;
    builder->plan->locals[4] = next_rsp;
    return 0;
}

static int lower_pop(const pl_x86_instruction *instruction,
                     semantic_builder *builder)
{
    if (instruction->visible_operand_count < 1u)
        return PL_ERROR_X86_SEMANTIC;
    pl_u32 stack_bits = instruction->operand_width;
    const pl_x86_operand *destination = &instruction->operands[0];
    if ((stack_bits != 16u && stack_bits != 64u)
            || (destination->kind != PL_X86_OPERAND_REGISTER
                && destination->kind != PL_X86_OPERAND_MEMORY)
            || destination->bits != stack_bits)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand value;
    int status = memory_load(
        builder, operand(PL_OPERAND_LOCAL, 4u), stack_bits, &value);
    if (status) return status;
    pl_operand next_rsp;
    status = stack_pointer(
        builder, (pl_i64)(stack_bits / 8u), &next_rsp);
    if (status) return status;
    builder->plan->locals[4] = next_rsp;
    if (destination->kind == PL_X86_OPERAND_MEMORY) {
        pl_operand address;
        status = effective_address_with_stack(
            builder, instruction, destination, 1, &next_rsp, &address);
        if (status) return status;
        return memory_store(builder, address, value, stack_bits);
    }
    return published_register(builder, destination, value, 1);
}

static int lower_call(const pl_x86_instruction *instruction,
                      semantic_builder *builder, pl_x86_semantic *out)
{
    if (instruction->flow != PL_X86_FLOW_CALL)
        return PL_ERROR_X86_SEMANTIC;
    if (instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET) {
        out->target = operand(PL_OPERAND_CONST, instruction->target);
        out->successor[0] = instruction->target;
        out->successor_count = 1u;
    } else {
        if (instruction->visible_operand_count < 1u)
            return PL_ERROR_X86_SEMANTIC;
        int constant, narrow;
        int status = read_value(
            builder, instruction, &instruction->operands[0], &out->target,
            &constant, &narrow);
        (void)constant;
        (void)narrow;
        if (status) return status;
        out->dynamic_target = 1u;
        out->successor_count = 0u;
    }
    pl_operand next_rsp;
    int status = stack_pointer(builder, -8, &next_rsp);
    if (status) return status;
    status = memory_store(
        builder, next_rsp,
        operand(PL_OPERAND_CONST, instruction->fallthrough), 64u);
    if (status) return status;
    builder->plan->locals[4] = next_rsp;
    return 0;
}

static int lower_return(const pl_x86_instruction *instruction,
                        semantic_builder *builder, pl_x86_semantic *out)
{
    if (instruction->flow != PL_X86_FLOW_RETURN)
        return PL_ERROR_X86_SEMANTIC;
    pl_u64 extra = 0u;
    if (instruction->visible_operand_count) {
        const pl_x86_operand *immediate = &instruction->operands[0];
        if (instruction->visible_operand_count != 1u
                || immediate->kind != PL_X86_OPERAND_IMMEDIATE
                || immediate->bits != 16u)
            return PL_ERROR_X86_SEMANTIC;
        extra = immediate->value.immediate & 0xffffu;
    }
    int status = memory_load(
        builder, operand(PL_OPERAND_LOCAL, 4u), 64u, &out->target);
    if (status) return status;
    pl_operand next_rsp;
    status = stack_pointer(builder, (pl_i64)(8u + extra), &next_rsp);
    if (status) return status;
    builder->plan->locals[4] = next_rsp;
    out->dynamic_target = 1u;
    out->successor_count = 0u;
    return 0;
}

static pl_u32 shift_opcode(pl_u32 bits, pl_u32 group, int dynamic)
{
    pl_u32 wide = bits == 64u;
    if (group == 0u) return wide ? PL_OPCODE_LANE64_ROTL
                                 : PL_OPCODE_LANE32_ROTL;
    if (group == 1u) return wide ? PL_OPCODE_LANE64_ROTR
                                 : PL_OPCODE_LANE32_ROTR;
    if (group == 4u)
        return dynamic
             ? (wide ? PL_OPCODE_LANE64_SHLR : PL_OPCODE_LANE32_SHLR)
             : (wide ? PL_OPCODE_LANE64_SHL : PL_OPCODE_LANE32_SHL);
    if (group == 5u)
        return dynamic
             ? (wide ? PL_OPCODE_LANE64_SHRR : PL_OPCODE_LANE32_SHRR)
             : (wide ? PL_OPCODE_LANE64_SHR : PL_OPCODE_LANE32_SHR);
    if (group == 7u)
        return dynamic
             ? (wide ? PL_OPCODE_LANE64_SARR : PL_OPCODE_LANE32_SARR)
             : (wide ? PL_OPCODE_LANE64_SAR : PL_OPCODE_LANE32_SAR);
    return 255u;
}

static int lower_shift(const pl_x86_instruction *instruction,
                       semantic_builder *builder)
{
    if (instruction->visible_operand_count < 2u
            || instruction->condition > 7u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *count = &instruction->operands[1];
    pl_u32 bits = destination->bits;
    if (bits != 8u && bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand source, address;
    int destination_memory = destination->kind == PL_X86_OPERAND_MEMORY;
    int constant, narrow;
    int status;
    if (destination_memory) {
        status = effective_address(
            builder, instruction, destination, 1, &address);
        if (!status) status = memory_load(builder, address, bits, &source);
    } else {
        status = read_value(
            builder, instruction, destination, &source, &constant, &narrow);
    }
    if (status) return status;
    pl_operand amount;
    status = read_value(
        builder, instruction, count, &amount, &constant, &narrow);
    if (status) return status;
    if (instruction->condition == 2u || instruction->condition == 3u) {
        if (constant) {
            amount.value &= bits == 64u ? 63u : 31u;
            if (bits < 32u) amount.value %= bits + 1u;
            /* A zero count performs the read (and its possible fault), but it
             * neither writes memory nor changes any architectural output. */
            if (!amount.value) return 0;
        }
        pl_operand rotate_arguments[4] = {
            operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
            source, amount,
            operand(PL_OPERAND_CONST,
                    bits | ((pl_u64)(instruction->condition - 2u) << 8u)),
        };
        pl_operand flags = emit(
            builder, PL_OPCODE_X86_ROTATE_CARRY,
            rotate_arguments, 4u);
        if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
        builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
        pl_operand result = operand(
            PL_OPERAND_PROJECTION,
            (flags.value << PROJECTION_SELECTOR_BITS)
            | X86_ALU_RESULT_SELECTOR);
        if (destination_memory) {
            if (constant) return memory_store(
                builder, address, result, bits);
            pl_operand active = operand(
                PL_OPERAND_PROJECTION,
                (flags.value << PROJECTION_SELECTOR_BITS) | 17u);
            return memory_store_if(
                builder, address, result, active, bits);
        }
        return published_register(builder, destination, result, 1);
    }
    pl_u64 count_mask = (instruction->condition <= 1u && bits < 32u)
                      ? bits - 1u : bits == 64u ? 63u : 31u;
    if (constant) {
        amount.value &= count_mask;
        if (!amount.value) return 0;
    } else {
        pl_operand arguments[2] = {
            amount, operand(PL_OPERAND_CONST, count_mask),
        };
        amount = emit(
            builder, PL_OPCODE_ALU_IMMEDIATE[1][0], arguments, 2u);
        if (amount.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }
    pl_operand result;
    if (bits >= 32u) {
        pl_u32 opcode = shift_opcode(
            bits, instruction->condition, !constant);
        if (opcode == 255u) return PL_ERROR_X86_SEMANTIC;
        pl_operand shift_arguments[2] = { source, amount };
        result = emit(builder, opcode, shift_arguments, 2u);
    } else {
        pl_operand widened;
        if (instruction->condition == 7u) {
            pl_u32 extend = bits == 8u ? PL_OPCODE_LANE64_EXTEND8_S
                                       : PL_OPCODE_LANE64_EXTEND16_S;
            pl_operand extend_arguments[1] = { source };
            widened = emit(builder, extend, extend_arguments, 1u);
        } else {
            status = zero_extend(builder, source, bits, &widened);
            if (status) return status;
        }
        if (widened.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
        if (instruction->condition <= 1u) {
            pl_operand complement;
            if (amount.kind == PL_OPERAND_CONST) {
                complement = operand(
                    PL_OPERAND_CONST, bits - (pl_u32)amount.value);
            } else {
                pl_operand complement_arguments[2] = {
                    operand(PL_OPERAND_CONST, bits), amount,
                };
                complement = emit(
                    builder, PL_OPCODE_ALU_REGISTER[1][2],
                    complement_arguments, 2u);
                if (complement.kind != PL_OPERAND_NODE)
                    return PL_ERROR_ARENA;
            }
            pl_operand left_arguments[2] = { widened, amount };
            pl_operand right_arguments[2] = { widened, complement };
            pl_operand left = emit(
                builder,
                instruction->condition == 0u
                    ? PL_OPCODE_LANE64_SHLR : PL_OPCODE_LANE64_SHRR,
                left_arguments, 2u);
            pl_operand right = emit(
                builder,
                instruction->condition == 0u
                    ? PL_OPCODE_LANE64_SHRR : PL_OPCODE_LANE64_SHLR,
                right_arguments, 2u);
            if (left.kind != PL_OPERAND_NODE
                    || right.kind != PL_OPERAND_NODE)
                return PL_ERROR_ARENA;
            pl_operand or_arguments[2] = { left, right };
            result = emit(
                builder, PL_OPCODE_ALU_REGISTER[1][3], or_arguments, 2u);
        } else {
            pl_u32 opcode = shift_opcode(
                64u, instruction->condition, !constant);
            if (opcode == 255u) return PL_ERROR_X86_SEMANTIC;
            pl_operand shift_arguments[2] = { widened, amount };
            result = emit(builder, opcode, shift_arguments, 2u);
        }
    }
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand flag_arguments[5] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        source, result, amount,
        operand(PL_OPERAND_CONST,
                bits | ((pl_u64)instruction->condition << 8u)),
    };
    pl_operand flags = emit(
        builder, PL_OPCODE_X86_SHIFT_FLAGS, flag_arguments, 5u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    if (destination_memory)
        return constant
             ? memory_store(builder, address, result, bits)
             : memory_store_if(builder, address, result, amount, bits);
    return published_register(builder, destination, result, 1);
}

static int lower_shift_no_flags(const pl_x86_instruction *instruction,
                                semantic_builder *builder)
{
    if (instruction->visible_operand_count != 3u
            || instruction->condition > 3u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    const pl_x86_operand *count = &instruction->operands[2];
    pl_u32 destination_index, bits, destination_offset;
    if (gpr(destination, &destination_index, &bits, &destination_offset)
            || destination_offset || (bits != 32u && bits != 64u)
            || source->bits != bits)
        return PL_ERROR_X86_SEMANTIC;
    (void)destination_index;
    pl_operand value, amount;
    int constant, narrow;
    int status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, count, &amount, &constant, &narrow);
    if (status) return status;
    pl_u32 opcode;
    if (instruction->condition == 0u)
        opcode = bits == 32u
               ? PL_OPCODE_LANE32_ROTR : PL_OPCODE_LANE64_ROTR;
    else if (instruction->condition == 1u)
        opcode = bits == 32u
               ? PL_OPCODE_LANE32_SHLR : PL_OPCODE_LANE64_SHLR;
    else if (instruction->condition == 2u)
        opcode = bits == 32u
               ? PL_OPCODE_LANE32_SHRR : PL_OPCODE_LANE64_SHRR;
    else
        opcode = bits == 32u
               ? PL_OPCODE_LANE32_SARR : PL_OPCODE_LANE64_SARR;
    pl_operand arguments[2] = { value, amount };
    pl_operand result = emit(builder, opcode, arguments, 2u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    return published_register(builder, destination, result, 1);
}

static int lower_bit_summary(const pl_x86_instruction *instruction,
                             semantic_builder *builder)
{
    if (instruction->visible_operand_count != 2u
            || instruction->condition > 4u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 destination_index, bits, destination_offset;
    if (gpr(destination, &destination_index, &bits, &destination_offset)
            || destination_offset || (bits != 16u && bits != 32u
                                       && bits != 64u)
            || source->bits != bits)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand value;
    int constant, narrow;
    int status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    (void)constant;
    (void)narrow;
    if (status) return status;
    pl_operand arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL), value,
        operand(PL_OPERAND_CONST,
                bits | ((pl_u64)instruction->condition << 8u)),
        operand(PL_OPERAND_LOCAL, destination_index),
    };
    /* BSF/BSR on zero input retain the previous destination. Keep the whole
     * register generation: the upper half of a 32-bit zero-input scan differs
     * between CPUs, so a narrower invented pass-through is not equivalent. */
    pl_u32 argument_count = instruction->condition < 2u ? 4u : 3u;
    pl_operand flags = emit(
        builder, PL_OPCODE_X86_BIT_SUMMARY, arguments, argument_count);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    pl_operand result = operand(
        PL_OPERAND_PROJECTION,
        (flags.value << PROJECTION_SELECTOR_BITS) | X86_ALU_RESULT_SELECTOR);
    return published_register(builder, destination, result, bits == 32u);
}

static int lower_double_shift(const pl_x86_instruction *instruction,
                              semantic_builder *builder)
{
    if (instruction->visible_operand_count != 3u
            || instruction->condition > 1u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    const pl_x86_operand *count = &instruction->operands[2];
    pl_u32 bits = destination->bits;
    if ((bits != 16u && bits != 32u && bits != 64u)
            || source->bits != bits)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand destination_value, address;
    int destination_memory = destination->kind == PL_X86_OPERAND_MEMORY;
    int constant = 0, narrow = 0;
    int status;
    if (destination_memory) {
        status = effective_address(
            builder, instruction, destination, 1, &address);
        if (!status) status = memory_load(
            builder, address, bits, &destination_value);
    } else {
        status = read_value(
            builder, instruction, destination, &destination_value,
            &constant, &narrow);
    }
    if (status) return status;
    pl_operand source_value, amount;
    status = read_value(
        builder, instruction, source, &source_value, &constant, &narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, count, &amount, &constant, &narrow);
    if (status) return status;
    pl_u64 count_mask = bits == 64u ? 63u : 31u;
    if (constant) {
        amount.value &= count_mask;
        /* The memory read and its fault remain observable, but count zero has
         * no architectural write or register/flag publication. */
        if (!amount.value) return 0;
    }
    pl_operand arguments[5] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        destination_value, source_value, amount,
        operand(PL_OPERAND_CONST,
                bits | ((pl_u64)instruction->condition << 8u)),
    };
    pl_operand flags = emit(
        builder, PL_OPCODE_X86_DOUBLE_SHIFT, arguments, 5u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    pl_operand result = operand(
        PL_OPERAND_PROJECTION,
        (flags.value << PROJECTION_SELECTOR_BITS) | X86_ALU_RESULT_SELECTOR);
    if (destination_memory) {
        if (constant) return memory_store(builder, address, result, bits);
        pl_operand active = operand(
            PL_OPERAND_PROJECTION,
            (flags.value << PROJECTION_SELECTOR_BITS) | 17u);
        return memory_store_if(builder, address, result, active, bits);
    }
    return published_register(builder, destination, result, bits == 32u);
}

static int lower_and_not(const pl_x86_instruction *instruction,
                         semantic_builder *builder)
{
    if (instruction->visible_operand_count != 3u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    pl_u32 destination_index, bits, destination_offset;
    if (gpr(destination, &destination_index, &bits, &destination_offset)
            || destination_offset || (bits != 32u && bits != 64u)
            || instruction->operands[1].bits != bits
            || instruction->operands[2].bits != bits)
        return PL_ERROR_X86_SEMANTIC;
    (void)destination_index;
    pl_operand left, right;
    int constant, narrow;
    int status = read_value(
        builder, instruction, &instruction->operands[1],
        &left, &constant, &narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, &instruction->operands[2],
        &right, &constant, &narrow);
    if (status) return status;
    pl_operand arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL), left, right,
        operand(PL_OPERAND_CONST, bits | (7u << 8u)),
    };
    pl_operand flags = emit(builder, PL_OPCODE_X86_ALU, arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    pl_operand result = operand(
        PL_OPERAND_PROJECTION,
        (flags.value << PROJECTION_SELECTOR_BITS) | X86_ALU_RESULT_SELECTOR);
    return published_register(builder, destination, result, 1);
}

static int lower_move_byte_swap(const pl_x86_instruction *instruction,
                                semantic_builder *builder)
{
    if (instruction->visible_operand_count != 2u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 bits = destination->bits;
    if ((bits != 32u && bits != 64u) || source->bits != bits
            || (destination->kind == PL_X86_OPERAND_MEMORY)
             == (source->kind == PL_X86_OPERAND_MEMORY))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand value;
    int constant, narrow;
    int status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    if (status) return status;
    pl_operand arguments[1] = { value };
    pl_operand swapped = emit(
        builder, bits == 32u ? PL_OPCODE_LANE32_BSWAP
                             : PL_OPCODE_LANE64_BSWAP,
        arguments, 1u);
    if (swapped.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    if (destination->kind == PL_X86_OPERAND_MEMORY) {
        pl_operand address;
        status = effective_address(
            builder, instruction, destination, 1, &address);
        return status ? status : memory_store(builder, address, swapped, bits);
    }
    return published_register(builder, destination, swapped, bits == 32u);
}

static int lower_base_access(const pl_x86_instruction *instruction,
                             semantic_builder *builder)
{
    if (instruction->visible_operand_count != 1u
            || instruction->condition > 3u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *reg = &instruction->operands[0];
    pl_u32 index, bits, offset;
    if (gpr(reg, &index, &bits, &offset) || offset
            || (bits != 32u && bits != 64u))
        return PL_ERROR_X86_SEMANTIC;
    (void)index;
    pl_u32 base = (instruction->condition & 1u)
                ? PL_X86_GS_BASE_LOCAL : PL_X86_FS_BASE_LOCAL;
    if (instruction->condition < 2u)
        return published_register(
            builder, reg, operand(PL_OPERAND_LOCAL, base), bits == 64u);
    pl_operand value;
    int constant, narrow;
    int status = read_value(
        builder, instruction, reg, &value, &constant, &narrow);
    if (status) return status;
    if (bits == 32u) {
        status = zero_extend(builder, value, 32u, &value);
        if (status) return status;
    }
    builder->plan->locals[base] = value;
    return 0;
}

static int lower_crc32(const pl_x86_instruction *instruction,
                       semantic_builder *builder)
{
    if (instruction->visible_operand_count != 2u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    pl_u32 destination_index, destination_bits, destination_offset;
    if (gpr(destination, &destination_index, &destination_bits,
            &destination_offset) || destination_offset
            || (destination_bits != 32u && destination_bits != 64u)
            || (source->bits != 8u && source->bits != 16u
                && source->bits != 32u && source->bits != 64u))
        return PL_ERROR_X86_SEMANTIC;
    (void)destination_index;
    pl_operand accumulator, value;
    int constant, narrow;
    int status = read_value(
        builder, instruction, destination,
        &accumulator, &constant, &narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    if (status) return status;
    pl_operand arguments[3] = {
        accumulator, value, operand(PL_OPERAND_CONST, source->bits),
    };
    pl_operand result = emit(builder, PL_OPCODE_X86_CRC32, arguments, 3u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    return published_register(builder, destination, result, 1);
}

static int lower_bzhi(const pl_x86_instruction *instruction,
                      semantic_builder *builder)
{
    if (instruction->visible_operand_count != 3u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    const pl_x86_operand *index = &instruction->operands[2];
    pl_u32 destination_index, bits, destination_offset;
    if (gpr(destination, &destination_index, &bits, &destination_offset)
            || destination_offset || (bits != 32u && bits != 64u)
            || source->bits != bits || index->bits != bits)
        return PL_ERROR_X86_SEMANTIC;
    (void)destination_index;
    pl_operand value, amount;
    int constant, narrow;
    int status = read_value(
        builder, instruction, source, &value, &constant, &narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, index, &amount, &constant, &narrow);
    if (status) return status;
    pl_operand arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL), value, amount,
        operand(PL_OPERAND_CONST, bits),
    };
    pl_operand flags = emit(builder, PL_OPCODE_X86_BZHI, arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    pl_operand result = operand(
        PL_OPERAND_PROJECTION,
        (flags.value << PROJECTION_SELECTOR_BITS) | X86_ALU_RESULT_SELECTOR);
    return published_register(builder, destination, result, bits == 32u);
}

static int lower_flag_control(const pl_x86_instruction *instruction,
                              semantic_builder *builder)
{
    pl_u64 mask;
    pl_u32 semantic;
    switch (instruction->condition) {
    case 0u: mask = 1u; semantic = 0u; break;       /* CLC: AND */
    case 1u: mask = 1u; semantic = 3u; break;       /* STC: OR */
    case 2u: mask = 1u; semantic = 4u; break;       /* CMC: XOR */
    case 3u: mask = 1u << 10u; semantic = 0u; break;/* CLD */
    case 4u: mask = 1u << 10u; semantic = 3u; break;/* STD */
    case 5u: mask = 1u << 9u; semantic = 0u; break; /* CLI */
    case 6u: mask = 1u << 9u; semantic = 3u; break; /* STI */
    default: return PL_ERROR_X86_SEMANTIC;
    }
    if (semantic == 0u) mask = ~mask;
    pl_operand arguments[2] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        operand(PL_OPERAND_CONST, mask),
    };
    pl_operand flags = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[1][semantic], arguments, 2u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    return 0;
}

static pl_x86_operand high_accumulator_byte(void)
{
    pl_x86_operand ah = { 0 };
    ah.kind = PL_X86_OPERAND_REGISTER;
    ah.bits = 8u;
    ah.flags = PL_X86_OPERAND_READ | PL_X86_OPERAND_WRITE;
    ah.value.reg.class_id = PL_X86_REGISTER_GPR;
    ah.value.reg.index = 0u;
    ah.value.reg.bits = 8u;
    ah.value.reg.flags = PL_X86_REGISTER_HIGH8;
    return ah;
}

static int lower_load_flags_low(semantic_builder *builder)
{
    pl_operand masked_arguments[2] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        operand(PL_OPERAND_CONST, 0xd5u),
    };
    pl_operand masked = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[1][0], masked_arguments, 2u);
    if (masked.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand fixed_arguments[2] = {
        masked, operand(PL_OPERAND_CONST, 2u),
    };
    pl_operand value = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[1][3], fixed_arguments, 2u);
    if (value.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_x86_operand ah = high_accumulator_byte();
    return published_register(builder, &ah, value, 1);
}

static int lower_store_flags_low(const pl_x86_instruction *instruction,
                                 semantic_builder *builder)
{
    pl_x86_operand ah = high_accumulator_byte();
    pl_operand byte;
    int constant, narrow;
    int status = read_value(
        builder, instruction, &ah, &byte, &constant, &narrow);
    (void)constant;
    (void)narrow;
    if (status) return status;
    pl_operand byte_arguments[2] = {
        byte, operand(PL_OPERAND_CONST, 0xd5u),
    };
    pl_operand selected = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[1][0], byte_arguments, 2u);
    pl_operand prior_arguments[2] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        operand(PL_OPERAND_CONST, ~0xd5ull),
    };
    pl_operand prior = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[1][0], prior_arguments, 2u);
    if (selected.kind != PL_OPERAND_NODE
            || prior.kind != PL_OPERAND_NODE)
        return PL_ERROR_ARENA;
    pl_operand result_arguments[2] = { prior, selected };
    pl_operand result = emit(
        builder, PL_OPCODE_ALU_REGISTER[1][3], result_arguments, 2u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = result;
    return 0;
}

static int lower_push_flags(const pl_x86_instruction *instruction,
                            semantic_builder *builder)
{
    pl_u32 bits = instruction->operand_width;
    if (bits != 16u && bits != 64u) return PL_ERROR_X86_SEMANTIC;
    pl_operand value = operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL);
    if (bits == 64u) {
        pl_operand arguments[2] = {
            value, operand(PL_OPERAND_CONST, ~((1ull << 16u) | (1ull << 17u))),
        };
        value = emit(
            builder, PL_OPCODE_ALU_IMMEDIATE[1][0], arguments, 2u);
        if (value.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }
    pl_operand next_rsp;
    int status = stack_pointer(
        builder, -(pl_i64)(bits / 8u), &next_rsp);
    if (status) return status;
    status = memory_store(builder, next_rsp, value, bits);
    if (status) return status;
    builder->plan->locals[4] = next_rsp;
    return 0;
}

static int lower_bit_test(const pl_x86_instruction *instruction,
                          semantic_builder *builder)
{
    if (instruction->visible_operand_count < 2u
            || instruction->condition > 3u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *index_operand = &instruction->operands[1];
    pl_u32 bits = destination->bits;
    if (bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;

    pl_operand index;
    int index_constant, index_narrow;
    int status = read_value(
        builder, instruction, index_operand, &index,
        &index_constant, &index_narrow);
    (void)index_narrow;
    if (status) return status;

    int destination_memory = destination->kind == PL_X86_OPERAND_MEMORY;
    pl_operand address = operand(PL_OPERAND_CONST, 0u);
    pl_operand source;
    int source_constant = 0, source_narrow = 0;
    if (destination_memory) {
        status = effective_address(
            builder, instruction, destination, 1, &address);
        if (status) return status;
        if (!index_constant) {
            pl_u32 index_bits = index_operand->bits;
            if (index_bits != 16u && index_bits != 32u && index_bits != 64u)
                return PL_ERROR_X86_SEMANTIC;
            pl_operand address_arguments[3] = {
                address, index,
                operand(PL_OPERAND_CONST,
                        bits | ((pl_u64)index_bits << 8u)),
            };
            address = emit(
                builder, PL_OPCODE_BIT_ADDRESS, address_arguments, 3u);
            if (address.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
        }
        status = memory_load(builder, address, bits, &source);
    } else {
        status = read_value(
            builder, instruction, destination, &source,
            &source_constant, &source_narrow);
    }
    (void)source_constant;
    (void)source_narrow;
    if (status) return status;

    pl_operand flag_arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        source, index, operand(PL_OPERAND_CONST, bits),
    };
    pl_operand flags = emit(
        builder, PL_OPCODE_X86_BIT_FLAGS, flag_arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    if (!instruction->condition) return 0;

    pl_operand bit;
    if (index_constant) {
        bit = operand(
            PL_OPERAND_CONST, 1ull << ((pl_u32)index.value & (bits - 1u)));
    } else {
        pl_operand bounded_arguments[2] = {
            index, operand(PL_OPERAND_CONST, bits - 1u),
        };
        pl_operand bounded = emit(
            builder, PL_OPCODE_ALU_IMMEDIATE[1][0],
            bounded_arguments, 2u);
        if (bounded.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
        pl_operand shift_arguments[2] = {
            operand(PL_OPERAND_CONST, 1u), bounded,
        };
        bit = emit(
            builder, PL_OPCODE_LANE64_SHLR, shift_arguments, 2u);
        if (bit.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }

    pl_u32 operation = instruction->condition == 1u ? 3u
                     : instruction->condition == 2u ? 0u : 4u;
    if (instruction->condition == 2u) {
        if (bit.kind == PL_OPERAND_CONST) bit.value = ~bit.value;
        else {
            pl_operand complement_arguments[2] = {
                bit, operand(PL_OPERAND_CONST, ~0ull),
            };
            bit = emit(
                builder, PL_OPCODE_ALU_IMMEDIATE[1][4],
                complement_arguments, 2u);
            if (bit.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
        }
    }
    pl_operand result_arguments[2] = { source, bit };
    pl_operand result = emit(
        builder,
        bit.kind == PL_OPERAND_CONST
            ? PL_OPCODE_ALU_IMMEDIATE[1][operation]
            : PL_OPCODE_ALU_REGISTER[1][operation],
        result_arguments, 2u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    if (destination_memory)
        return memory_store(builder, address, result, bits);
    return published_register(builder, destination, result, 0);
}

static int lower_translate_byte(const pl_x86_instruction *instruction,
                                semantic_builder *builder)
{
    if (instruction->address_width != 32u
            && instruction->address_width != 64u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *memory = 0;
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index)
        if (instruction->operands[index].kind == PL_X86_OPERAND_MEMORY) {
            memory = &instruction->operands[index];
            break;
        }
    if (!memory || memory->value.memory.segment.class_id
                      != PL_X86_REGISTER_SEGMENT)
        return PL_ERROR_X86_SEMANTIC;

    pl_operand low_arguments[2] = {
        operand(PL_OPERAND_LOCAL, 0u),
        operand(PL_OPERAND_CONST, 0xffu),
    };
    pl_operand low = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[1][0], low_arguments, 2u);
    if (low.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand address_arguments[2] = {
        operand(PL_OPERAND_LOCAL, 3u), low,
    };
    pl_operand address = emit(
        builder,
        PL_OPCODE_ALU_REGISTER[
            instruction->address_width == 32u ? 0u : 1u][1],
        address_arguments, 2u);
    if (address.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_u32 segment = memory->value.memory.segment.index;
    if (segment >= 4u) {
        if (segment > 5u) return PL_ERROR_X86_SEMANTIC;
        pl_operand segment_arguments[2] = {
            address,
            operand(PL_OPERAND_LOCAL,
                    segment == 4u ? PL_X86_FS_BASE_LOCAL
                                  : PL_X86_GS_BASE_LOCAL),
        };
        address = emit(
            builder, PL_OPCODE_ALU_REGISTER[1][1], segment_arguments, 2u);
        if (address.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }
    pl_operand value;
    int status = memory_load(builder, address, 8u, &value);
    if (status) return status;
    pl_x86_operand al = { 0 };
    al.kind = PL_X86_OPERAND_REGISTER;
    al.bits = 8u;
    al.value.reg.class_id = PL_X86_REGISTER_GPR;
    al.value.reg.index = 0u;
    al.value.reg.bits = 8u;
    return published_register(builder, &al, value, 1);
}

static int lower_byte_swap(const pl_x86_instruction *instruction,
                           semantic_builder *builder)
{
    if (instruction->visible_operand_count != 1u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    pl_u32 index, bits, offset;
    if (gpr(destination, &index, &bits, &offset) || offset
            || (bits != 32u && bits != 64u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand arguments[1] = { operand(PL_OPERAND_LOCAL, index) };
    pl_operand result = emit(
        builder,
        bits == 32u ? PL_OPCODE_LANE32_BSWAP : PL_OPCODE_LANE64_BSWAP,
        arguments, 1u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    return published_register(builder, destination, result, bits == 32u);
}

static int lower_leave(const pl_x86_instruction *instruction,
                       semantic_builder *builder)
{
    pl_u32 bits = instruction->operand_width;
    if (bits != 16u && bits != 64u) return PL_ERROR_X86_SEMANTIC;
    pl_operand base = operand(PL_OPERAND_LOCAL, 5u);
    pl_operand restored;
    int status = memory_load(builder, base, bits, &restored);
    if (status) return status;
    pl_operand next_rsp;
    status = add_address(
        builder, base, operand(PL_OPERAND_CONST, bits / 8u), &next_rsp);
    if (status) return status;
    builder->plan->locals[4] = next_rsp;
    pl_x86_operand rbp = { 0 };
    rbp.kind = PL_X86_OPERAND_REGISTER;
    rbp.bits = (pl_u16)bits;
    rbp.value.reg.class_id = PL_X86_REGISTER_GPR;
    rbp.value.reg.index = 5u;
    rbp.value.reg.bits = (pl_u16)bits;
    return published_register(builder, &rbp, restored, 1);
}

static int lower_enter(const pl_x86_instruction *instruction,
                       semantic_builder *builder)
{
    pl_x86_enter law;if(!pl_x86_enter_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;
    pl_u32 bits = instruction->operand_width;
    pl_u32 width = law.bytes,level=law.level;
    pl_operand frame;
    int status = stack_pointer(builder, -(pl_i64)width, &frame);
    if (status) return status;
    status = memory_frame(
        builder, frame, operand(PL_OPERAND_LOCAL, 5u), level, bits);
    if (status) return status;
    pl_u64 consumed = law.allocation + (pl_u64)width * (level?level+1u:1u);
    pl_operand next_rsp;
    status = stack_pointer(builder, -(pl_i64)consumed, &next_rsp);
    if (status) return status;
    builder->plan->locals[4] = next_rsp;
    pl_x86_operand rbp = { 0 };
    rbp.kind = PL_X86_OPERAND_REGISTER;
    rbp.bits = (pl_u16)bits;
    rbp.value.reg.class_id = PL_X86_REGISTER_GPR;
    rbp.value.reg.index = 5u;
    rbp.value.reg.bits = (pl_u16)bits;
    return published_register(builder, &rbp, frame, 0);
}

static int lower_accumulator_extend(const pl_x86_instruction *instruction,
                                    semantic_builder *builder)
{
    if (instruction->condition > 2u) return PL_ERROR_X86_SEMANTIC;
    static const pl_u32 source_bits[3] = { 8u, 16u, 32u };
    static const pl_u32 destination_bits[3] = { 16u, 32u, 64u };
    pl_u32 source = source_bits[instruction->condition];
    pl_u32 destination = destination_bits[instruction->condition];
    pl_u32 opcode = source == 8u ? PL_OPCODE_LANE64_EXTEND8_S
                  : source == 16u ? PL_OPCODE_LANE64_EXTEND16_S
                  : PL_OPCODE_EXTEND32_S;
    pl_operand arguments[1] = { operand(PL_OPERAND_LOCAL, 0u) };
    pl_operand result = emit(builder, opcode, arguments, 1u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_x86_operand rax = { 0 };
    rax.kind = PL_X86_OPERAND_REGISTER;
    rax.bits = (pl_u16)destination;
    rax.value.reg.class_id = PL_X86_REGISTER_GPR;
    rax.value.reg.index = 0u;
    rax.value.reg.bits = (pl_u16)destination;
    return published_register(
        builder, &rax, result, destination == 64u);
}

static int lower_high_extend(const pl_x86_instruction *instruction,
                             semantic_builder *builder)
{
    if (instruction->condition > 2u) return PL_ERROR_X86_SEMANTIC;
    static const pl_u32 widths[3] = { 16u, 32u, 64u };
    pl_u32 bits = widths[instruction->condition];
    pl_operand source = operand(PL_OPERAND_LOCAL, 0u);
    if (bits != 64u) {
        pl_u32 opcode = bits == 16u ? PL_OPCODE_LANE64_EXTEND16_S
                                    : PL_OPCODE_EXTEND32_S;
        pl_operand arguments[1] = { source };
        source = emit(builder, opcode, arguments, 1u);
        if (source.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }
    pl_operand arguments[2] = {
        source, operand(PL_OPERAND_CONST, bits - 1u),
    };
    pl_operand result = emit(
        builder, PL_OPCODE_LANE64_SAR, arguments, 2u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_x86_operand rdx = { 0 };
    rdx.kind = PL_X86_OPERAND_REGISTER;
    rdx.bits = (pl_u16)bits;
    rdx.value.reg.class_id = PL_X86_REGISTER_GPR;
    rdx.value.reg.index = 2u;
    rdx.value.reg.bits = (pl_u16)bits;
    return published_register(builder, &rdx, result, bits == 64u);
}

static int lower_conditional_set(const pl_x86_instruction *instruction,
                                 semantic_builder *builder)
{
    if (instruction->visible_operand_count < 1u
            || instruction->operands[0].bits != 8u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand selected;
    int status = condition_value(
        builder, instruction->condition, &selected);
    if (status) return status;
    const pl_x86_operand *destination = &instruction->operands[0];
    if (destination->kind == PL_X86_OPERAND_MEMORY) {
        pl_operand address;
        status = effective_address(
            builder, instruction, destination, 1, &address);
        return status ? status : memory_store(builder, address, selected, 8u);
    }
    return published_register(builder, destination, selected, 1);
}

static int lower_conditional_move(const pl_x86_instruction *instruction,
                                  semantic_builder *builder)
{
    if (instruction->visible_operand_count < 2u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source_operand = &instruction->operands[1];
    pl_u32 index, bits, offset;
    if (gpr(destination, &index, &bits, &offset) || offset
            || source_operand->bits != bits
            || (bits != 16u && bits != 32u && bits != 64u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand source;
    int constant, narrow;
    int status = read_value(
        builder, instruction, source_operand, &source, &constant, &narrow);
    if (status) return status;
    pl_operand current = operand(PL_OPERAND_LOCAL, index);
    pl_operand candidate = source;
    if (bits == 32u) {
        /* CMOV r32 clears the high destination word on both outcomes,
         * including a false condition; only the low word is conditional. */
        status = zero_extend(builder, current, 32u, &current);
        if (status) return status;
    }
    if (bits == 32u && !constant && !narrow) {
        status = zero_extend(builder, source, 32u, &candidate);
        if (status) return status;
    } else if (bits == 16u) {
        pl_operand arguments[3] = {
            current, source, operand(PL_OPERAND_CONST, 16u),
        };
        candidate = emit(
            builder, PL_OPCODE_LANE64_INSERT, arguments, 3u);
        if (candidate.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }
    pl_operand predicate;
    status = condition_value(builder, instruction->condition, &predicate);
    if (status) return status;
    pl_operand arguments[3] = { candidate, current, predicate };
    pl_operand selected = emit(
        builder, PL_OPCODE_LANE64_SELECT, arguments, 3u);
    if (selected.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[index] = selected;
    return 0;
}

static int publish_conditional_edge(const pl_x86_instruction *instruction,
                                    pl_operand predicate,
                                    pl_x86_semantic *out)
{
    if (instruction->flow != PL_X86_FLOW_CONDITIONAL
            || !(instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET))
        return PL_ERROR_X86_SEMANTIC;
    out->predicate = predicate;
    out->has_predicate = 1u;
    out->target = operand(PL_OPERAND_CONST, instruction->target);
    out->successor[0] = instruction->target;
    out->successor[1] = instruction->fallthrough;
    out->successor_count = 2u;
    return 0;
}

static int count_condition(semantic_builder *builder, pl_operand count,
                           pl_u32 bits, pl_u32 condition,
                           pl_operand *predicate)
{
    pl_operand arguments[3] = {
        count, count,
        operand(PL_OPERAND_CONST, bits | ((pl_u64)condition << 8u)),
    };
    *predicate = emit(
        builder, PL_OPCODE_X86_TEST_CONDITION, arguments, 3u);
    return predicate->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static pl_x86_operand accumulator_operand(pl_u32 index, pl_u32 bits);

static int lower_loop(const pl_x86_instruction *instruction,
                      semantic_builder *builder, pl_x86_semantic *out)
{
    pl_x86_count_branch law;
    if(!pl_x86_count_branch_lower(instruction,&law) || !law.decrement)return PL_ERROR_X86_SEMANTIC;
    pl_u32 bits=law.bits;
    pl_u32 lane = bits == 32u ? 0u : 1u;
    pl_operand decrement_arguments[2] = {
        operand(PL_OPERAND_LOCAL, 1u), operand(PL_OPERAND_CONST, 1u),
    };
    pl_operand next_count = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[lane][2],
        decrement_arguments, 2u);
    if (next_count.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    if (bits == 16u) {
        pl_x86_operand cx = accumulator_operand(1u, 16u);
        int status = published_register(builder, &cx, next_count, 0);
        if (status) return status;
        next_count = builder->plan->locals[1];
    } else {
        builder->plan->locals[1] = next_count;
    }
    pl_operand predicate;
    int status = count_condition(builder, next_count, bits, 5u, &predicate);
    if (status) return status;
    if (law.zero_flag) {
        pl_operand zero;
        status = condition_value(
            builder, law.zero_flag == 1u ? 4u : 5u, &zero);
        if (status) return status;
        pl_operand arguments[2] = { predicate, zero };
        predicate = emit(
            builder, PL_OPCODE_ALU_REGISTER[1][0], arguments, 2u);
        if (predicate.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }
    return publish_conditional_edge(instruction, predicate, out);
}

static int lower_count_zero_branch(
    const pl_x86_instruction *instruction, semantic_builder *builder,
    pl_x86_semantic *out)
{
    pl_x86_count_branch law;
    if(!pl_x86_count_branch_lower(instruction,&law) || law.decrement)return PL_ERROR_X86_SEMANTIC;
    pl_u32 bits=law.bits;
    pl_operand predicate;
    int status = count_condition(
        builder, operand(PL_OPERAND_LOCAL, 1u), bits, 4u, &predicate);
    return status ? status
                  : publish_conditional_edge(instruction, predicate, out);
}

static int multiply_value(semantic_builder *builder, pl_operand left,
                          pl_operand right, pl_u32 bits, int sign,
                          pl_operand *low, pl_operand *high,
                          pl_operand *flags)
{
    if (bits != 8u && bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;
    pl_operand product_arguments[2] = { left, right };
    *low = emit(
        builder, PL_OPCODE_MULR, product_arguments, 2u);
    if (low->kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand descriptor = operand(
        PL_OPERAND_CONST, bits | ((pl_u64)(sign != 0) << 8u));
    pl_operand high_arguments[3] = { left, right, descriptor };
    *high = emit(builder, PL_OPCODE_MUL_HIGH, high_arguments, 3u);
    if (high->kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand flag_arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        *low, *high, descriptor,
    };
    *flags = emit(
        builder, PL_OPCODE_X86_MUL_FLAGS, flag_arguments, 4u);
    return flags->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static pl_x86_operand accumulator_operand(pl_u32 index, pl_u32 bits)
{
    pl_x86_operand out = { 0 };
    out.kind = PL_X86_OPERAND_REGISTER;
    out.bits = (pl_u16)bits;
    out.value.reg.class_id = PL_X86_REGISTER_GPR;
    out.value.reg.index = (pl_u8)index;
    out.value.reg.bits = (pl_u16)bits;
    return out;
}

static int lower_multiply(const pl_x86_instruction *instruction,
                          semantic_builder *builder, int sign)
{
    pl_u32 visible = instruction->visible_operand_count;
    if (!visible || visible > 3u) return PL_ERROR_X86_SEMANTIC;

    if (visible == 1u) {
        const pl_x86_operand *source_operand = &instruction->operands[0];
        pl_u32 bits = source_operand->bits;
        pl_operand source;
        int constant, narrow;
        int status = read_value(
            builder, instruction, source_operand, &source,
            &constant, &narrow);
        (void)constant;
        (void)narrow;
        if (status) return status;
        pl_operand low, high, flags;
        status = multiply_value(
            builder, operand(PL_OPERAND_LOCAL, 0u), source,
            bits, sign, &low, &high, &flags);
        if (status) return status;
        builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
        if (bits == 8u) {
            pl_x86_operand ax = accumulator_operand(0u, 16u);
            return published_register(builder, &ax, low, 0);
        }
        pl_x86_operand accumulator = accumulator_operand(0u, bits);
        pl_x86_operand high_half = accumulator_operand(2u, bits);
        status = published_register(
            builder, &accumulator, low, bits == 64u);
        return status ? status : published_register(
            builder, &high_half, high, 1);
    }

    if (!sign) return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *destination = &instruction->operands[0];
    pl_u32 destination_index, bits, destination_offset;
    if (gpr(destination, &destination_index, &bits, &destination_offset)
            || destination_offset
            || (bits != 16u && bits != 32u && bits != 64u))
        return PL_ERROR_X86_SEMANTIC;
    (void)destination_index;
    const pl_x86_operand *left_operand = visible == 2u
                                       ? destination
                                       : &instruction->operands[1];
    const pl_x86_operand *right_operand = &instruction->operands[visible - 1u];
    if ((left_operand->kind != PL_X86_OPERAND_IMMEDIATE
                && left_operand->bits != bits)
            || (right_operand->kind != PL_X86_OPERAND_IMMEDIATE
                && right_operand->bits != bits))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand left, right;
    int constant, narrow;
    int status = read_value(
        builder, instruction, left_operand, &left, &constant, &narrow);
    if (status) return status;
    status = read_value(
        builder, instruction, right_operand, &right, &constant, &narrow);
    if (status) return status;
    pl_operand low, high, flags;
    status = multiply_value(
        builder, left, right, bits, 1, &low, &high, &flags);
    if (status) return status;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    return published_register(builder, destination, low, bits == 64u);
}

static pl_operand divide_projection(pl_operand source, pl_u32 selector)
{
    return operand(
        PL_OPERAND_PROJECTION,
        (source.value << PROJECTION_SELECTOR_BITS) | selector);
}

static int lower_divide(const pl_x86_instruction *instruction,
                        semantic_builder *builder, pl_x86_semantic *out,
                        int sign)
{
    if (instruction->visible_operand_count != 1u)
        return PL_ERROR_X86_SEMANTIC;
    const pl_x86_operand *divisor_operand = &instruction->operands[0];
    pl_u32 bits = divisor_operand->bits;
    if (bits != 8u && bits != 16u && bits != 32u && bits != 64u)
        return PL_ERROR_X86_SEMANTIC;

    pl_operand divisor;
    int constant, narrow;
    int status = read_value(
        builder, instruction, divisor_operand,
        &divisor, &constant, &narrow);
    (void)constant;
    (void)narrow;
    if (status) return status;

    pl_operand low = operand(PL_OPERAND_LOCAL, 0u);
    pl_operand high = operand(PL_OPERAND_LOCAL, 2u);
    if (bits == 8u) {
        pl_operand high_arguments[2] = {
            operand(PL_OPERAND_LOCAL, 0u),
            operand(PL_OPERAND_CONST, 8u),
        };
        high = emit(
            builder, PL_OPCODE_LANE64_SHR, high_arguments, 2u);
        if (high.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }

    pl_operand descriptor = operand(
        PL_OPERAND_CONST, bits | ((pl_u64)(sign != 0) << 8u));
    pl_operand arguments[4] = { high, low, divisor, descriptor };
    pl_operand error = emit(
        builder, PL_OPCODE_X86_DIVIDE, arguments, 4u);
    if (error.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand quotient = divide_projection(error, 0u);
    pl_operand remainder = divide_projection(error, 1u);

    out->fault_predicate = error;
    out->has_fault_predicate = 1u;
    if (bits == 8u) {
        pl_operand packed_arguments[3] = {
            quotient, remainder,
            operand(PL_OPERAND_CONST, 8u | (8u << 8u)),
        };
        pl_operand packed = emit(
            builder, PL_OPCODE_LANE64_INSERT, packed_arguments, 3u);
        if (packed.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
        pl_x86_operand ax = accumulator_operand(0u, 16u);
        return published_register(builder, &ax, packed, 0);
    }
    pl_x86_operand accumulator = accumulator_operand(0u, bits);
    pl_x86_operand high_half = accumulator_operand(2u, bits);
    status = published_register(
        builder, &accumulator, quotient, bits >= 32u);
    return status ? status : published_register(
        builder, &high_half, remainder, bits >= 32u);
}

const pl_x86_operand *pl_x86_string_memory(
        const pl_x86_instruction *instruction, pl_u32 base)
{
    if(!instruction || instruction->operand_count>PL_X86_MAX_OPERANDS)return 0;
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index) {
        const pl_x86_operand *candidate = &instruction->operands[index];
        if (candidate->kind == PL_X86_OPERAND_MEMORY
                && candidate->value.memory.base.class_id
                   == PL_X86_REGISTER_GPR
                && candidate->value.memory.base.index == base)
            return candidate;
    }
    return 0;
}

static int string_address(semantic_builder *builder,
                          const pl_x86_instruction *instruction,
                          const pl_x86_operand *source, pl_u32 base,
                          pl_u32 bits, pl_operand *result)
{
    if (!source || source->kind != PL_X86_OPERAND_MEMORY
            || source->bits != bits
            || source->value.memory.base.class_id != PL_X86_REGISTER_GPR
            || source->value.memory.base.index != base
            || source->value.memory.index.class_id != PL_X86_REGISTER_NONE
            || source->value.memory.has_displacement
            || (source->value.memory.segment.class_id
                    != PL_X86_REGISTER_NONE
                && (source->value.memory.segment.class_id
                        != PL_X86_REGISTER_SEGMENT
                    || source->value.memory.segment.index > 5u))
            || (instruction->address_width != 32u
                && instruction->address_width != 64u))
        return PL_ERROR_X86_SEMANTIC;
    pl_operand address = operand(PL_OPERAND_LOCAL, base);
    if (instruction->address_width == 32u) {
        pl_operand arguments[2] = {
            address, operand(PL_OPERAND_CONST, 0u),
        };
        address = emit(
            builder, PL_OPCODE_ALU_IMMEDIATE[0][1], arguments, 2u);
        if (address.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }
    if (source->value.memory.segment.class_id == PL_X86_REGISTER_SEGMENT
            && source->value.memory.segment.index >= 4u) {
        pl_u32 local = source->value.memory.segment.index == 4u
                     ? PL_X86_FS_BASE_LOCAL : PL_X86_GS_BASE_LOCAL;
        int status = add_address(
            builder, address, operand(PL_OPERAND_LOCAL, local), &address);
        if (status) return status;
    }
    *result = address;
    return 0;
}

static int string_compare(semantic_builder *builder, pl_operand left,
                          pl_operand right, pl_u32 bits)
{
    pl_operand arguments[4] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL), left, right,
        operand(PL_OPERAND_CONST, bits | (3u << 8u)),
    };
    pl_operand flags = emit(
        builder, PL_OPCODE_X86_COMPARE, arguments, 4u);
    if (flags.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[PL_X86_RFLAGS_LOCAL] = flags;
    return 0;
}

static int string_delta(semantic_builder *builder, pl_u32 width,
                        pl_operand *result)
{
    pl_operand bit_arguments[2] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        operand(PL_OPERAND_CONST, 10u),
    };
    pl_operand direction = emit(
        builder, PL_OPCODE_BIT, bit_arguments, 2u);
    if (direction.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand select_arguments[3] = {
        operand(PL_OPERAND_CONST, (pl_u64)-(pl_i64)width),
        operand(PL_OPERAND_CONST, width), direction,
    };
    *result = emit(
        builder, PL_OPCODE_LANE64_SELECT, select_arguments, 3u);
    return result->kind == PL_OPERAND_NODE ? 0 : PL_ERROR_ARENA;
}

static int string_advance(semantic_builder *builder, pl_u32 local,
                          pl_operand delta, pl_u32 address_bits)
{
    pl_operand arguments[2] = {
        operand(PL_OPERAND_LOCAL, local), delta,
    };
    pl_u32 lane = address_bits == 32u ? 0u : 1u;
    pl_operand result = emit(
        builder, PL_OPCODE_ALU_REGISTER[lane][1], arguments, 2u);
    if (result.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[local] = result;
    return 0;
}

static int lower_repeated_store(semantic_builder *builder,
                                pl_operand target, pl_u32 bits,
                                pl_u32 address_bits)
{
    pl_u32 width = bits / 8u;
    pl_u32 shift = width == 8u ? 3u : width == 4u ? 2u
                 : width == 2u ? 1u : 0u;
    pl_operand count = operand(PL_OPERAND_LOCAL, 1u);
    if (address_bits == 32u) {
        pl_operand truncate[2] = {
            count, operand(PL_OPERAND_CONST, 0u),
        };
        count = emit(
            builder, PL_OPCODE_ALU_IMMEDIATE[0][1], truncate, 2u);
        if (count.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    } else if (address_bits != 64u) {
        return PL_ERROR_X86_SEMANTIC;
    }
    pl_operand extent = count;
    if (shift) {
        pl_operand scale[2] = {
            count, operand(PL_OPERAND_CONST, shift),
        };
        extent = emit(builder, PL_OPCODE_LANE64_SHL, scale, 2u);
        if (extent.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    }

    pl_operand direction_arguments[2] = {
        operand(PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL),
        operand(PL_OPERAND_CONST, 10u),
    };
    pl_operand direction = emit(
        builder, PL_OPCODE_BIT, direction_arguments, 2u);
    if (direction.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand back_arguments[2] = {
        extent, operand(PL_OPERAND_CONST, width),
    };
    pl_operand back = emit(
        builder, PL_OPCODE_ALU_IMMEDIATE[1][2], back_arguments, 2u);
    if (back.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand descending_arguments[2] = { target, back };
    pl_operand descending = emit(
        builder, PL_OPCODE_ALU_REGISTER[1][2], descending_arguments, 2u);
    if (descending.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand start_arguments[3] = { descending, target, direction };
    pl_operand start = emit(
        builder, PL_OPCODE_LANE64_SELECT, start_arguments, 3u);
    if (start.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;

    pl_operand repeat_arguments[5];
    pl_u32 repeat_count = 4u;
    repeat_arguments[0] = start;
    repeat_arguments[1] = operand(PL_OPERAND_LOCAL, 0u);
    repeat_arguments[2] = extent;
    repeat_arguments[3] = operand(PL_OPERAND_CONST, memory_shape(bits));
    if (builder->last_memory.kind == PL_OPERAND_NODE)
        repeat_arguments[repeat_count++] = builder->last_memory;
    pl_operand repeated = emit(
        builder, PL_OPCODE_MEMORY_REPEAT, repeat_arguments, repeat_count);
    if (repeated.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->last_memory = repeated;

    pl_operand negative_arguments[2] = {
        operand(PL_OPERAND_CONST, 0u), extent,
    };
    pl_operand negative = emit(
        builder, PL_OPCODE_ALU_REGISTER[1][2], negative_arguments, 2u);
    if (negative.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand delta_arguments[3] = { negative, extent, direction };
    pl_operand delta = emit(
        builder, PL_OPCODE_LANE64_SELECT, delta_arguments, 3u);
    if (delta.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    pl_operand final_arguments[2] = { target, delta };
    pl_u32 add = address_bits == 32u
               ? PL_OPCODE_ALU_REGISTER[0][1]
               : PL_OPCODE_ALU_REGISTER[1][1];
    pl_operand final = emit(builder, add, final_arguments, 2u);
    if (final.kind != PL_OPERAND_NODE) return PL_ERROR_ARENA;
    builder->plan->locals[7u] = final;
    builder->plan->locals[1u] = operand(PL_OPERAND_CONST, 0u);
    return 0;
}

static int lower_string(const pl_x86_instruction *instruction,
                        semantic_builder *builder)
{
    pl_x86_string law;
    if(!pl_x86_string_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;
    pl_u32 mode=law.kind,bits=law.bits;
    int reads_source=law.reads_source,reads_target=law.reads_target,writes_target=law.writes_target;
    const pl_x86_operand *source = reads_source
        ? pl_x86_string_memory(instruction, 6u) : 0;
    const pl_x86_operand *target = (reads_target || writes_target)
        ? pl_x86_string_memory(instruction, 7u) : 0;
    pl_operand source_address, target_address;
    int status = 0;
    if (source)
        status = string_address(
            builder, instruction, source, 6u, bits, &source_address);
    if (!status && target)
        status = string_address(
            builder, instruction, target, 7u, bits, &target_address);
    if (status || (reads_source && !source)
            || ((reads_target || writes_target) && !target))
        return status ? status : PL_ERROR_X86_SEMANTIC;

    if (instruction->flags & PL_X86_INSTRUCTION_REPEATED) {
        if (mode != 1u) return PL_ERROR_X86_SEMANTIC;
        return lower_repeated_store(
            builder, target_address, bits, instruction->address_width);
    }

    pl_operand source_value = operand(PL_OPERAND_CONST, 0u);
    pl_operand target_value = operand(PL_OPERAND_CONST, 0u);
    if (reads_source) {
        status = memory_load(builder, source_address, bits, &source_value);
        if (status) return status;
    }
    if (reads_target) {
        status = memory_load(builder, target_address, bits, &target_value);
        if (status) return status;
    }
    if (writes_target) {
        pl_operand value = mode == 0u
            ? source_value : operand(PL_OPERAND_LOCAL, 0u);
        status = memory_store(builder, target_address, value, bits);
        if (status) return status;
    } else if (mode == 2u) {
        pl_x86_operand accumulator = accumulator_operand(0u, bits);
        status = published_register(
            builder, &accumulator, source_value, 1);
        if (status) return status;
    } else if (mode == 3u) {
        status = string_compare(builder, source_value, target_value, bits);
        if (status) return status;
    } else if (mode == 4u) {
        status = string_compare(
            builder, operand(PL_OPERAND_LOCAL, 0u), target_value, bits);
        if (status) return status;
    }

    pl_operand delta;
    status = string_delta(builder, bits / 8u, &delta);
    if (status) return status;
    if (source) {
        status = string_advance(
            builder, 6u, delta, instruction->address_width);
        if (status) return status;
    }
    if (target)
        status = string_advance(
            builder, 7u, delta, instruction->address_width);
    return status;
}

static pl_u32 machine_register_input(pl_x86_register reg)
{
    if (reg.class_id == PL_X86_REGISTER_GPR && reg.index < PL_X86_GPR_COUNT)
        return 1u << reg.index;
    if (reg.class_id == PL_X86_REGISTER_FLAGS)
        return 1u << PL_X86_RFLAGS_LOCAL;
    return 0u;
}

pl_u32 pl_x86_machine_inputs(const pl_x86_instruction *instruction)
{
    if (!instruction || instruction->machine_operation == PL_X86_MACHINE_NONE)
        return 0u;
    pl_u32 reads = 0u;
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index) {
        const pl_x86_operand *input = &instruction->operands[index];
        if (input->kind == PL_X86_OPERAND_REGISTER
                && (input->flags & (PL_X86_OPERAND_READ
                                 | PL_X86_OPERAND_CONDITIONAL_READ))) {
            reads |= machine_register_input(input->value.reg);
        } else if (input->kind == PL_X86_OPERAND_MEMORY) {
            const pl_x86_memory *address = &input->value.memory;
            /* Even a write-only access reads its effective address. AGEN
             * operands use base/index but do not observe a segment base. */
            reads |= machine_register_input(address->base)
                   | machine_register_input(address->index);
            if (!(input->flags & PL_X86_OPERAND_ADDRESS_ONLY)
                    && address->segment.class_id == PL_X86_REGISTER_SEGMENT) {
                if (address->segment.index == 4u)
                    reads |= 1u << PL_X86_FS_BASE_LOCAL;
                if (address->segment.index == 5u)
                    reads |= 1u << PL_X86_GS_BASE_LOCAL;
            }
        }
    }
    return reads;
}

int pl_x86_software_trap_lower(const pl_x86_instruction *i,pl_x86_software_trap *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->family!=PL_X86_FAMILY_INTERRUPT||i->machine_operation!=PL_X86_MACHINE_SOFTWARE_INTERRUPT
        ||(i->flags&required)!=required||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED))
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes)return 0;
    pl_u32 vector;
    if(i->opcode==0xcdu){const pl_x86_operand *o=i->operands;
        if(i->flow!=PL_X86_FLOW_INTERRUPT||i->operation!=PL_X86_OPERATION_UNSUPPORTED||i->visible_operand_count!=1u
            ||o->kind!=PL_X86_OPERAND_IMMEDIATE||o->bits!=8u||o->value.immediate>255u
            ||i->machine_argument!=o->value.immediate||i->trap_vector||(i->flags&PL_X86_INSTRUCTION_TRAP_AFTER))return 0;
        vector=(pl_u32)o->value.immediate;
    }else{
        vector=i->opcode==0xf1u?1u:i->opcode==0xccu?3u:0u;
        if(!vector||i->operation!=PL_X86_OPERATION_FAULT||i->flow!=PL_X86_FLOW_FAULT||i->visible_operand_count
            ||!(i->flags&PL_X86_INSTRUCTION_TRAP_AFTER)||i->trap_vector!=vector||i->machine_argument!=vector)return 0;
    }
    *out=(pl_x86_software_trap){(pl_u8)vector,i->source_bytes,(pl_u8)(i->opcode==0xf1u)};return 1;
}
int pl_x86_fault_cut_lower(const pl_x86_instruction *instruction,pl_x86_fault_cut *out)
{
    if(!instruction || !out || instruction->flow!=PL_X86_FLOW_FAULT
            || instruction->operation!=PL_X86_OPERATION_FAULT
            || instruction->machine_operation!=PL_X86_MACHINE_NONE
            || (instruction->flags&PL_X86_INSTRUCTION_TRAP_AFTER)
            || (instruction->status!=PL_X86_DECODE_VALID && instruction->status!=PL_X86_DECODE_INVALID
                && instruction->status!=PL_X86_DECODE_TOO_LONG)
            || (instruction->trap_vector!=6u && instruction->trap_vector!=13u)
            || !instruction->length || instruction->length>PL_X86_MAX_INSTRUCTION_BYTES
            || instruction->source_bytes!=instruction->length)return 0;
    *out=(pl_x86_fault_cut){instruction->trap_vector,instruction->source_bytes};return 1;
}

int pl_x86_register_update_lower(const pl_x86_instruction *instruction,pl_x86_register_update *out)
{
    if(!instruction || !out || instruction->status!=PL_X86_DECODE_VALID
            || instruction->encoding!=PL_X86_ENCODING_LEGACY
            || instruction->flow!=PL_X86_FLOW_NEXT || instruction->machine_operation!=PL_X86_MACHINE_NONE
            || instruction->machine_argument || instruction->visible_operand_count!=2u
            || (instruction->operation!=PL_X86_OPERATION_EXCHANGE_ADD
                && instruction->operation!=PL_X86_OPERATION_COMPARE_EXCHANGE)
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY
                |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_BARRIER)))return 0;
    pl_u32 bits=instruction->operands[0].bits;
    for(pl_u32 i=0u;i<2u;++i){
        const pl_x86_operand *operand=&instruction->operands[i];const pl_x86_register *reg=&operand->value.reg;
        if(operand->kind!=PL_X86_OPERAND_REGISTER || operand->bits!=bits || reg->bits!=bits
                || reg->class_id!=PL_X86_REGISTER_GPR || reg->index>=16u
                || (bits!=8u && bits!=16u && bits!=32u && bits!=64u)
                || (reg->flags&~PL_X86_REGISTER_HIGH8)
                || ((reg->flags&PL_X86_REGISTER_HIGH8) && (bits!=8u || reg->index>=4u)))return 0;
    }
    *out=(pl_x86_register_update){(pl_u8)bits,(pl_u8)(instruction->operation==PL_X86_OPERATION_COMPARE_EXCHANGE)};return 1;
}

int pl_x86_string_lower(const pl_x86_instruction *instruction,pl_x86_string *out)
{
    if(!instruction || !out || instruction->status!=PL_X86_DECODE_VALID
            || instruction->encoding!=PL_X86_ENCODING_LEGACY || instruction->flow!=PL_X86_FLOW_NEXT
            || instruction->operation!=PL_X86_OPERATION_STRING || instruction->condition>4u
            || (instruction->operand_width!=8u && instruction->operand_width!=16u
                && instruction->operand_width!=32u && instruction->operand_width!=64u)
            || (instruction->address_width!=32u && instruction->address_width!=64u)
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    pl_u32 kind=instruction->condition,repeated=!!(instruction->flags&PL_X86_INSTRUCTION_REPEATED);
    pl_x86_string law={(pl_u8)kind,(pl_u8)instruction->operand_width,(pl_u8)instruction->address_width,
        (pl_u8)repeated,(pl_u8)(kind>=3u && !!(instruction->flags&PL_X86_INSTRUCTION_REPEAT_WHILE_NOT_EQUAL)),3u,
        (pl_u8)(kind==0u || kind==2u || kind==3u),(pl_u8)(kind>=3u),(pl_u8)(kind<2u),
        (pl_u8)(kind==1u || kind==4u),(pl_u8)(kind==2u)};
    for(pl_u32 index=6u;index<=7u;++index){
        int needed=index==6u?law.reads_source:law.reads_target || law.writes_target;
        if(!needed)continue;
        const pl_x86_operand *operand=pl_x86_string_memory(instruction,index);
        if(!operand || operand->bits!=law.bits)return 0;
        const pl_x86_memory *memory=&operand->value.memory;
        if(memory->base.bits!=law.address_bits || memory->base.flags
                || memory->index.class_id!=PL_X86_REGISTER_NONE || memory->has_displacement
                || (memory->scale!=0u && memory->scale!=1u)
                || (memory->segment.class_id!=PL_X86_REGISTER_NONE
                    && (memory->segment.class_id!=PL_X86_REGISTER_SEGMENT || memory->segment.index>5u)))return 0;
        if(index==6u && memory->segment.class_id==PL_X86_REGISTER_SEGMENT)law.source_segment=memory->segment.index;
        if(index==7u && memory->segment.class_id==PL_X86_REGISTER_SEGMENT && memory->segment.index!=0u)return 0;
    }
    pl_u32 machine=repeated && kind!=1u?PL_X86_MACHINE_STRING:PL_X86_MACHINE_NONE;
    pl_u64 argument=machine?law.bits/8u|((pl_u64)law.address_bits<<8u)
        |((pl_u64)(kind==4u?0u:law.source_segment)<<16u)|((pl_u64)kind<<24u)|((pl_u64)law.not_equal<<27u):0u;
    if(instruction->machine_operation!=machine || instruction->machine_argument!=argument)return 0;
    *out=law;return 1;
}

int pl_x86_count_branch_lower(const pl_x86_instruction *instruction,pl_x86_count_branch *out)
{
    if(!instruction || !out || instruction->status!=PL_X86_DECODE_VALID
            || instruction->encoding!=PL_X86_ENCODING_LEGACY
            || instruction->machine_operation!=PL_X86_MACHINE_NONE
            || instruction->flow!=PL_X86_FLOW_CONDITIONAL
            || !(instruction->flags&PL_X86_INSTRUCTION_DIRECT_TARGET)
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_READS_MEMORY
                |PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER))
            || instruction->visible_operand_count!=1u
            || instruction->operands[0].kind!=PL_X86_OPERAND_IMMEDIATE
            || (instruction->address_width!=16u && instruction->address_width!=32u && instruction->address_width!=64u))return 0;
    int loop=instruction->operation==PL_X86_OPERATION_LOOP;
    if(loop?instruction->condition>2u:instruction->operation!=PL_X86_OPERATION_COUNT_ZERO_BRANCH)return 0;
    *out=(pl_x86_count_branch){(pl_u8)instruction->address_width,(pl_u8)loop,loop?instruction->condition:0u};
    return 1;
}

int pl_x86_segment_move_supported(const pl_x86_instruction *instruction)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT
        |PL_X86_INSTRUCTION_BARRIER;
    if(!instruction || instruction->status!=PL_X86_DECODE_VALID
            || instruction->encoding!=PL_X86_ENCODING_LEGACY
            || instruction->operation!=PL_X86_OPERATION_MOVE
            || instruction->machine_operation!=PL_X86_MACHINE_WRITE_SEGMENT
            || instruction->flow!=PL_X86_FLOW_NEXT || instruction->visible_operand_count!=2u
            || (instruction->flags&required)!=required
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *target=instruction->operands, *source=target+1u;
    const pl_x86_register *reg=&target->value.reg;
    if(target->kind!=PL_X86_OPERAND_REGISTER || target->bits!=16u
            || reg->class_id!=PL_X86_REGISTER_SEGMENT || reg->bits!=16u
            || reg->index>=6u || reg->index==1u || reg->flags || source->bits!=16u)return 0;
    pl_u64 argument=reg->index;
    if(source->kind==PL_X86_OPERAND_REGISTER){
        const pl_x86_register *value=&source->value.reg;
        if(value->class_id!=PL_X86_REGISTER_GPR || value->index>=16u || value->bits!=16u
                || value->flags || (instruction->flags&PL_X86_INSTRUCTION_READS_MEMORY))return 0;
        argument|=(pl_u64)value->index<<8u;
    }else if(source->kind==PL_X86_OPERAND_MEMORY){
        const pl_x86_memory *memory=&source->value.memory;
        if(!(instruction->flags&PL_X86_INSTRUCTION_READS_MEMORY)
                || (instruction->address_width!=32u && instruction->address_width!=64u)
                || (memory->segment.class_id!=PL_X86_REGISTER_NONE
                    && (memory->segment.class_id!=PL_X86_REGISTER_SEGMENT || memory->segment.index>=6u))
                || (memory->base.class_id!=PL_X86_REGISTER_NONE && memory->base.class_id!=PL_X86_REGISTER_IP
                    && (memory->base.class_id!=PL_X86_REGISTER_GPR || memory->base.index>=16u))
                || (memory->index.class_id!=PL_X86_REGISTER_NONE
                    && (memory->index.class_id!=PL_X86_REGISTER_GPR || memory->index.index>=16u))
                || (memory->scale && memory->scale!=1u && memory->scale!=2u
                    && memory->scale!=4u && memory->scale!=8u))return 0;
        argument|=1ull<<16u;
    }else return 0;
    return instruction->machine_argument==argument;
}

int pl_x86_halt_supported(const pl_x86_instruction *instruction)
{
    const pl_u32 required = PL_X86_INSTRUCTION_PRECISE_CUT
        | PL_X86_INSTRUCTION_BARRIER | PL_X86_INSTRUCTION_PRIVILEGED
        | PL_X86_INSTRUCTION_MAY_TRAP;
    return instruction && instruction->status == PL_X86_DECODE_VALID
        && instruction->encoding == PL_X86_ENCODING_LEGACY
        && instruction->family == PL_X86_FAMILY_HALT
        && instruction->flow == PL_X86_FLOW_HALT
        && instruction->machine_operation == PL_X86_MACHINE_HALT
        && !instruction->machine_argument && !instruction->operand_count
        && !instruction->visible_operand_count
        && instruction->length && instruction->length <= 15u
        && instruction->fallthrough == instruction->rip + instruction->length
        && (instruction->flags & required) == required
        && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED
            | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_READS_MEMORY
            | PL_X86_INSTRUCTION_WRITES_MEMORY | PL_X86_INSTRUCTION_TRAP_AFTER));
}

int pl_x86_selector_read_lower(const pl_x86_instruction *instruction,pl_x86_selector_read *out)
{
    if(!instruction || !out || instruction->status!=PL_X86_DECODE_VALID
            || instruction->encoding!=PL_X86_ENCODING_LEGACY
            || instruction->machine_operation!=PL_X86_MACHINE_READ_SELECTOR
            || !instruction->length || instruction->length>15u
            || instruction->fallthrough!=instruction->rip+instruction->length
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_READS_MEMORY)))return 0;
    pl_u32 selector=(pl_u32)instruction->machine_argument&255u,system=selector>=6u;
    if(selector>=8u || (instruction->flow!=PL_X86_FLOW_NEXT && !(system && instruction->flow==PL_X86_FLOW_SYSTEM))
            || instruction->visible_operand_count!=(system?1u:2u))return 0;
    if(system){pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
        if((instruction->flags&required)!=required)return 0;
    }else{const pl_x86_operand *source=&instruction->operands[1];
        if(instruction->operation!=PL_X86_OPERATION_MOVE || source->kind!=PL_X86_OPERAND_REGISTER || source->bits!=16u
                || source->value.reg.class_id!=PL_X86_REGISTER_SEGMENT || source->value.reg.index!=selector
                || source->value.reg.bits!=16u || source->value.reg.flags)return 0;}
    const pl_x86_operand *destination=&instruction->operands[0];pl_u32 memory=destination->kind==PL_X86_OPERAND_MEMORY;
    pl_u32 target=0u;
    if(memory){if(destination->bits!=16u || !(instruction->flags&PL_X86_INSTRUCTION_WRITES_MEMORY))return 0;}
    else{if(destination->kind!=PL_X86_OPERAND_REGISTER || destination->value.reg.class_id!=PL_X86_REGISTER_GPR
            || destination->value.reg.index>=16u || destination->value.reg.flags
            || (destination->bits!=16u && destination->bits!=32u && destination->bits!=64u)
            || destination->bits!=destination->value.reg.bits || (instruction->flags&PL_X86_INSTRUCTION_WRITES_MEMORY))return 0;
        target=destination->value.reg.index;}
    if(instruction->machine_argument!=(selector|((pl_u64)memory<<8u)|((pl_u64)target<<16u)
            |((pl_u64)destination->bits<<24u)))return 0;
    *out=(pl_x86_selector_read){(pl_u8)selector,(pl_u8)memory,(pl_u8)target,(pl_u8)destination->bits,(pl_u8)system};return 1;
}

int pl_x86_x87_snapshot_lower(const pl_x86_instruction *instruction,pl_x86_x87_snapshot *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!instruction || !out || instruction->status!=PL_X86_DECODE_VALID
        || instruction->encoding!=PL_X86_ENCODING_LEGACY || instruction->machine_operation!=PL_X86_MACHINE_X87
        || (instruction->flow!=PL_X86_FLOW_NEXT && instruction->flow!=PL_X86_FLOW_SYSTEM)
        || instruction->visible_operand_count!=1u || (instruction->flags&required)!=required
        || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    pl_u32 kind=(pl_u32)instruction->machine_argument&255u;
    if(kind!=PL_X86_X87_STORE_CONTROL_WORD && kind!=PL_X86_X87_STORE_STATUS_WORD)return 0;
    const pl_x86_operand *destination=instruction->operands;
    pl_u32 memory=destination->kind==PL_X86_OPERAND_MEMORY;
    if(destination->bits!=16u || instruction->machine_argument!=(kind|((pl_u64)(memory?2u:0u)<<8u)))return 0;
    if(memory){if(!(instruction->flags&PL_X86_INSTRUCTION_WRITES_MEMORY))return 0;}
    else if(kind!=PL_X86_X87_STORE_STATUS_WORD || destination->kind!=PL_X86_OPERAND_REGISTER
        || destination->value.reg.class_id!=PL_X86_REGISTER_GPR || destination->value.reg.index
        || destination->value.reg.bits!=16u || destination->value.reg.flags
        || (instruction->flags&PL_X86_INSTRUCTION_WRITES_MEMORY))return 0;
    *out=(pl_x86_x87_snapshot){(pl_u8)(kind==PL_X86_X87_STORE_STATUS_WORD),(pl_u8)memory};return 1;
}

int pl_x86_x87_wait_supported(const pl_x86_instruction *i)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    return i && i->status==PL_X86_DECODE_VALID && i->encoding==PL_X86_ENCODING_LEGACY
        && i->machine_operation==PL_X86_MACHINE_X87 && !i->machine_argument && i->opcode==0x9bu
        && i->operation==PL_X86_OPERATION_UNSUPPORTED && i->flow==PL_X86_FLOW_NEXT && !i->visible_operand_count
        && (i->flags&required)==required && !(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER))
        && i->source_bytes && i->source_bytes<=15u && i->length==i->source_bytes && i->fallthrough-i->rip==i->source_bytes;
}
int pl_x86_lower(const pl_x86_instruction *instruction,
                 pl_arena *arena, pl_x86_semantic *out)
{
    if (!instruction || !arena || !out) return PL_ERROR_X86_SEMANTIC;
    if(instruction->machine_operation==PL_X86_MACHINE_SYSTEM_SELECTOR
        &&(instruction->opcode==2u||instruction->opcode==3u||instruction->visible_operand_count==2u)){
        pl_x86_selector_query law;if(!pl_x86_selector_query_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_VECTOR&&(instruction->machine_argument&255u)==PL_X86_VECTOR_SCALAR_FLOAT
        &&(((instruction->machine_argument>>32u)&255u)==PL_X86_SCALAR_FLOAT_COMPARE_ORDERED||((instruction->machine_argument>>32u)&255u)==PL_X86_SCALAR_FLOAT_COMPARE_UNORDERED)){
        pl_x86_float_compare law;if(!pl_x86_float_compare_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_VECTOR&&((instruction->machine_argument&255u)==17u
        ||(instruction->machine_argument&255u)==21u||(instruction->machine_argument&255u)==32u
        ||((instruction->machine_argument&255u)==PL_X86_VECTOR_SCALAR_FLOAT&&((instruction->machine_argument>>32u)&255u)==PL_X86_SCALAR_FLOAT_TO_INTEGER_TRUNCATE)
        ||((instruction->machine_argument&255u)==PL_X86_VECTOR_PACKED_CONVERT&&((instruction->machine_argument>>32u)&255u)==PL_X86_PACKED_CONVERT_FLOAT64_TO_SIGNED_DWORD_TRUNCATE))){
        pl_x86_vector_float_integer law;if(!pl_x86_vector_float_integer_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_VECTOR&&((instruction->machine_argument&255u)==30u
        ||((instruction->machine_argument&255u)==PL_X86_VECTOR_SCALAR_FLOAT&&((instruction->machine_argument>>32u)&255u)==PL_X86_SCALAR_FLOAT_INTEGER_TO_FLOAT))){
        pl_x86_vector_integer_float law;if(!pl_x86_vector_integer_float_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&(instruction->machine_argument&255u)==21u){
        pl_x86_x87_exchange law;if(!pl_x86_x87_exchange_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&(instruction->machine_argument&255u)==14u){
        pl_x86_x87_float_store law;if(!pl_x86_x87_float_store_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&((instruction->machine_argument&255u)==22u
        ||(instruction->machine_argument&255u)==43u)){
        pl_x86_x87_stack law;if(!pl_x86_x87_stack_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87 && !instruction->machine_argument
        && !pl_x86_x87_wait_supported(instruction))return PL_ERROR_X86_SEMANTIC;
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&((instruction->machine_argument&255u)==17u
        ||(instruction->machine_argument&255u)==40u||(instruction->machine_argument&255u)==45u)){
        pl_x86_mmx_transfer law;if(!pl_x86_mmx_transfer_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_FAR_RETURN||instruction->machine_operation==PL_X86_MACHINE_INTERRUPT_RETURN){
        pl_x86_return law;if(!pl_x86_return_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->operation==PL_X86_OPERATION_TRANSLATE_BYTE&&!pl_x86_translate_byte_memory(instruction))return PL_ERROR_X86_SEMANTIC;
    if(instruction->machine_operation==PL_X86_MACHINE_SOFTWARE_INTERRUPT){
        pl_x86_software_trap law;if(!pl_x86_software_trap_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_PORT_IO&&(instruction->machine_argument&(1ull<<10u))){
        pl_x86_string_io law;if(!pl_x86_string_io_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&(instruction->machine_argument&255u)==1u){
        pl_x86_x87_integer_load law;if(!pl_x86_x87_integer_load_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&(instruction->machine_argument&255u)==10u){
        pl_x86_x87_integer_load law;pl_x86_x87_raw_load raw;
        if(!pl_x86_x87_memory_load_lower(instruction,&law)&&!pl_x86_x87_raw_load_lower(instruction,&raw))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&(instruction->machine_argument&255u)>=2u&&(instruction->machine_argument&255u)<=4u){
        pl_x86_x87_integer_store law;if(!pl_x86_x87_integer_store_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87
        &&((instruction->machine_argument&255u)==12u||(instruction->machine_argument&255u)==16u||(instruction->machine_argument&255u)==7u)){
        pl_x86_x87_integer_arithmetic law;if(!pl_x86_x87_integer_arithmetic_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87
        &&(instruction->visible_operand_count!=1u||((instruction->machine_argument>>16u)&0xc0u)==0xc0u)
        &&((instruction->machine_argument&255u)==8u||(instruction->machine_argument&255u)==9u||(instruction->machine_argument&255u)==13u||(instruction->machine_argument&255u)==15u)){
        pl_x86_x87_register_arithmetic law;if(!pl_x86_x87_register_arithmetic_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&instruction->visible_operand_count==1u
        &&instruction->operands[0].kind==PL_X86_OPERAND_MEMORY
        &&((instruction->machine_argument&255u)==8u||(instruction->machine_argument&255u)==9u||(instruction->machine_argument&255u)==13u||(instruction->machine_argument&255u)==15u)){
        pl_x86_x87_integer_arithmetic law;if(!pl_x86_x87_memory_arithmetic_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87&&(instruction->machine_argument&255u)==11u){
        pl_x86_x87_status_compare law;if(!pl_x86_x87_status_compare_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87
        && ((instruction->machine_argument&255u)==5u||(instruction->machine_argument&255u)==6u
            ||(instruction->machine_argument&255u)==19u||(instruction->machine_argument&255u)==20u)){
        pl_x86_x87_compare law;if(!pl_x86_x87_compare_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_X87
        && ((instruction->machine_argument&255u)==PL_X86_X87_STORE_CONTROL_WORD
            || (instruction->machine_argument&255u)==PL_X86_X87_STORE_STATUS_WORD)){
        pl_x86_x87_snapshot law;if(!pl_x86_x87_snapshot_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if(instruction->machine_operation==PL_X86_MACHINE_READ_SELECTOR){pl_x86_selector_read law;
        if(!pl_x86_selector_read_lower(instruction,&law))return PL_ERROR_X86_SEMANTIC;}
    if (instruction->status != PL_X86_DECODE_VALID
            || (instruction->machine_operation == PL_X86_MACHINE_HALT
                && !pl_x86_halt_supported(instruction))
            || (instruction->machine_operation == PL_X86_MACHINE_WRITE_SEGMENT
                && instruction->operation == PL_X86_OPERATION_MOVE
                && !pl_x86_segment_move_supported(instruction))
            || ((instruction->flags & PL_X86_INSTRUCTION_LOCKED)
                && instruction->machine_operation == PL_X86_MACHINE_NONE)
            || ((instruction->flags & PL_X86_INSTRUCTION_BARRIER)
                && instruction->machine_operation == PL_X86_MACHINE_NONE))
        return PL_ERROR_X86_SEMANTIC;
    semantic_builder builder;
    int status = open_plan(arena, &out->plan, &builder);
    if (status) return status;
    out->successor[0] = instruction->fallthrough;
    out->successor[1] = 0u;
    out->successor_count = 1u;
    out->target = operand(PL_OPERAND_CONST, instruction->fallthrough);
    out->predicate = operand(PL_OPERAND_CONST, 1u);
    out->fault_predicate = operand(PL_OPERAND_CONST, 0u);
    out->machine_value = operand(PL_OPERAND_CONST, 0u);
    out->flow = instruction->flow;
    out->dynamic_target = 0u;
    out->has_predicate = 0u;
    out->has_fault_predicate = 0u;
    out->trap_vector = instruction->trap_vector;
    out->machine_operation = instruction->machine_operation;
    out->machine_argument = instruction->machine_argument;
    out->machine_inputs = pl_x86_machine_inputs(instruction);
    /* HLT is a machine barrier, not a permanent control terminator.  After
     * an accepted interrupt the architectural RIP is the following
     * instruction, so the barrier result must carry that exact continuation.
     * Losing it made native output fall into whichever block happened to be
     * laid out next and left the Wasm machine ABI unable to resume exactly. */
    if (out->machine_operation == PL_X86_MACHINE_FAR_RETURN) {
        out->target = operand(PL_OPERAND_CONST, 0u);
        out->successor_count = 0u;
        out->dynamic_target = 1u;
    }
    if (out->machine_operation == PL_X86_MACHINE_SYSTEM_TRANSFER
            || out->machine_operation == PL_X86_MACHINE_INTERRUPT_RETURN
            || out->machine_operation == PL_X86_MACHINE_FAR_TRANSFER) {
        out->target = operand(PL_OPERAND_CONST, 0u);
        out->successor_count = 0u;
        out->dynamic_target = 1u;
    }
    if (out->machine_operation == PL_X86_MACHINE_DESCRIPTOR_TABLE
            || out->machine_operation == PL_X86_MACHINE_INVALIDATE_PAGE
            || out->machine_operation == PL_X86_MACHINE_ATOMIC
            || (out->machine_operation == PL_X86_MACHINE_MEMORY_ORDER
                && (out->machine_argument == 4u
                    || out->machine_argument == 7u))
            || (out->machine_operation == PL_X86_MACHINE_SYSTEM_SELECTOR
                && ((out->machine_argument >> 8u) & 1u))
            || (out->machine_operation == PL_X86_MACHINE_CR0_STATUS
                && ((out->machine_argument & 0xffu)
                    == PL_X86_CR0_WRITE_MACHINE_STATUS
                    || (out->machine_argument & 0xffu)
                       == PL_X86_CR0_READ_MACHINE_STATUS)
                && (out->machine_argument & PL_X86_CR0_STATUS_MEMORY))
            || (out->machine_operation == PL_X86_MACHINE_VALIDATE_SELECTOR
                && ((out->machine_argument >> 1u) & 1u))
            || (out->machine_operation == PL_X86_MACHINE_VECTOR
                && ((out->machine_argument >> 24u) & 3u))
            || (out->machine_operation == PL_X86_MACHINE_WRITE_SEGMENT
                && ((out->machine_argument >> 16u) & 1u))
            || (out->machine_operation == PL_X86_MACHINE_READ_SELECTOR
                && ((out->machine_argument >> 8u) & 1u))
            || (out->machine_operation == PL_X86_MACHINE_FAR_TRANSFER
                && !((out->machine_argument >> 1u) & 1u))
            || (out->machine_operation == PL_X86_MACHINE_X87
                && (((out->machine_argument & 0xffu) >= 1u
                    && (out->machine_argument & 0xffu) <= 4u)
                    || (out->machine_argument & 0xffu) == 7u
                    || (((out->machine_argument & 0xffu) == 8u
                         || (out->machine_argument & 0xffu) == 9u)
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 10u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 11u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || (out->machine_argument & 0xffu) == 12u
                    || ((out->machine_argument & 0xffu) == 13u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 14u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 15u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || (out->machine_argument & 0xffu) == 16u
                    || (((out->machine_argument & 0xffu) >= 17u
                         && (out->machine_argument & 0xffu) <= 18u)
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || (((out->machine_argument & 0xffu) >= 23u
                         && (out->machine_argument & 0xffu) <= 26u)
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || (((out->machine_argument & 0xffu) >= 27u
                         && (out->machine_argument & 0xffu) <= 28u)
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || (((out->machine_argument & 0xffu) >= 29u
                         && (out->machine_argument & 0xffu) <= 35u)
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 37u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 38u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 39u
                        && ((out->machine_argument >> 8u) & 0xffu))
                    || ((out->machine_argument & 0xffu) == 40u
                        && ((out->machine_argument >> 8u) & 0xffu))
                     || (out->machine_argument & 0xffu) == 51u
                     || ((out->machine_argument & 0xffu)
                         == PL_X86_X87_BYTE_SHUFFLE
                         && ((out->machine_argument >> 8u) & 0xffu))
                     || ((out->machine_argument & 0xffu)
                         == PL_X86_X87_ALIGN_RIGHT
                         && ((out->machine_argument >> 8u) & 0xffu))))) {
        pl_u32 atomic_kind = (pl_u32)out->machine_argument & 0xffu;
        pl_u32 expected = out->machine_operation == PL_X86_MACHINE_ATOMIC
                        && atomic_kind != 3u
                        && (atomic_kind < 11u
                            || (atomic_kind >= 14u && atomic_kind <= 16u))
                        ? 2u
                        : out->machine_operation
                           == PL_X86_MACHINE_VALIDATE_SELECTOR ? 1u
                        : out->machine_operation == PL_X86_MACHINE_VECTOR
                        ? ((out->machine_argument & 0xffu) == 28u ? 1u
                         : ((out->machine_argument & 0xffu)
                            == PL_X86_VECTOR_EXTRACT_LANE ? 3u
                         : ((out->machine_argument & 0xffu)
                            == PL_X86_VECTOR_SCALAR_FLOAT
                            && ((out->machine_argument
                                 >> PL_X86_SCALAR_FLOAT_OPERATION_SHIFT)
                                & 0xffu)
                               == PL_X86_SCALAR_FLOAT_PREDICATE ? 3u
                         : (((out->machine_argument & 0xffu) == 7u
                             || (out->machine_argument & 0xffu) == 8u
                             || (out->machine_argument & 0xffu) == 15u
                             || (out->machine_argument & 0xffu)
                                == PL_X86_VECTOR_INSERT_LANE
                             || (out->machine_argument & 0xffu) == 19u
                             || (out->machine_argument & 0xffu) == 27u
                             || (out->machine_argument & 0xffu)
                                == PL_X86_VECTOR_MOVE_LANE
                             || (out->machine_argument & 0xffu) == 40u
                             || (out->machine_argument & 0xffu) == 44u
                             || (out->machine_argument & 0xffu)
                                == PL_X86_VECTOR_SHUFFLE_LOW_WORDS)
                            ? 3u : 2u))))
                        : out->machine_operation
                           == PL_X86_MACHINE_READ_SELECTOR
                        ? ((out->machine_argument & 0xffu) < 6u ? 2u : 1u)
                        : (out->machine_operation == PL_X86_MACHINE_X87
                           && (((out->machine_argument & 0xffu) >= 17u
                                && (out->machine_argument & 0xffu) <= 18u)
                               || ((out->machine_argument & 0xffu) >= 23u
                                   && (out->machine_argument & 0xffu) <= 26u)
                               || (out->machine_argument & 0xffu) == 37u
                               || (out->machine_argument & 0xffu) == 38u
                               || (out->machine_argument & 0xffu) == 39u
                               || (out->machine_argument & 0xffu) == 40u
                               || (out->machine_argument & 0xffu)
                                  == PL_X86_X87_BYTE_SHUFFLE
                               || (out->machine_argument & 0xffu)
                                  == PL_X86_X87_ALIGN_RIGHT))
                        ? ((out->machine_argument & 0xffu) == 38u
                           || (out->machine_argument & 0xffu)
                              == PL_X86_X87_ALIGN_RIGHT ? 3u : 2u)
                        : out->machine_operation
                           == PL_X86_MACHINE_WRITE_SEGMENT ? 2u : 1u;
        if (out->machine_operation == PL_X86_MACHINE_SYSTEM_SELECTOR)
            expected = (out->machine_argument & 0xffu) >= 2u ? 1u : 2u;
        pl_u32 memory_operand = out->machine_operation
                              == PL_X86_MACHINE_WRITE_SEGMENT ? 1u
                              : out->machine_operation
                                == PL_X86_MACHINE_VECTOR
                                && (out->machine_argument & 0xffu) != 28u
                                && !((out->machine_argument >> 25u) & 1u)
                              ? 1u : 0u;
        if (out->machine_operation == PL_X86_MACHINE_X87
                && (((out->machine_argument & 0xffu) >= 17u
                     && (out->machine_argument & 0xffu) <= 18u)
                    || ((out->machine_argument & 0xffu) >= 23u
                        && (out->machine_argument & 0xffu) <= 26u)
                    || (out->machine_argument & 0xffu) == 37u
                    || (out->machine_argument & 0xffu) == 38u
                    || (out->machine_argument & 0xffu) == 39u
                    || (out->machine_argument & 0xffu) == 40u
                    || (out->machine_argument & 0xffu)
                       == PL_X86_X87_BYTE_SHUFFLE
                    || (out->machine_argument & 0xffu)
                       == PL_X86_X87_ALIGN_RIGHT)) {
            memory_operand = ((out->machine_argument & 0xffu) == 17u
                              || (out->machine_argument & 0xffu) == 40u)
                           && ((out->machine_argument >> 40u) & 1u)
                           ? 0u : 1u;
        }
        if (out->machine_operation == PL_X86_MACHINE_SYSTEM_SELECTOR)
            memory_operand = (out->machine_argument & 0xffu) >= 2u ? 0u : 1u;
        if (instruction->visible_operand_count != expected
                || instruction->operands[memory_operand].kind
                   != PL_X86_OPERAND_MEMORY)
            return PL_ERROR_X86_SEMANTIC;
        status = effective_address(
            &builder, instruction, &instruction->operands[memory_operand], 0,
            &out->machine_value);
        if (status) return status;
    }
    if (out->machine_operation == PL_X86_MACHINE_FAR_TRANSFER
            && ((out->machine_argument >> 1u) & 1u)) {
        if (instruction->visible_operand_count != 1u
                || instruction->operands[0].kind
                   != PL_X86_OPERAND_POINTER)
            return PL_ERROR_X86_SEMANTIC;
        out->machine_value = operand(
            PL_OPERAND_CONST, instruction->operands[0].value.pointer.offset);
    }
    if (out->machine_operation == PL_X86_MACHINE_VECTOR
            && (out->machine_argument & 0xffu) == 33u) {
        /* MASKMOVQ's destination address is the architectural RDI lane.  Its
         * segment and address-size contract stay in the typed descriptor, so
         * the emitted block passes the live coordinate without reconstructing
         * a synthetic memory operand. */
        out->machine_value = operand(PL_OPERAND_LOCAL, 7u);
    }
    if (out->machine_operation != PL_X86_MACHINE_NONE)
    {
        if (out->machine_operation == PL_X86_MACHINE_VECTOR) {
            pl_u32 kind = (pl_u32)out->machine_argument & 255u;
            if (kind == 7u || kind == 8u || kind == 23u || kind == 27u
                    || kind == PL_X86_VECTOR_SHUFFLE_LOW_WORDS
                    || kind == PL_X86_VECTOR_FIXED_DWORD_SHUFFLE) {
                pl_x86_vector_projection projection;
                if (!pl_x86_vector_project(instruction, &projection))
                    return PL_ERROR_X86_SEMANTIC;
            }
            pl_u64 subtype = out->machine_argument >> 32u;
            if (kind == 1u || kind == 2u || kind == 3u || kind == 4u || kind == 24u
                    || (kind == 10u && (subtype == 12u || subtype == 15u
                        || subtype == 48u || subtype == 51u || subtype == 52u
                        || subtype == 56u || subtype == 57u))) {
                pl_x86_vector_binary law;
                if (!pl_x86_vector_binary_lower(instruction, &law))
                    return PL_ERROR_X86_SEMANTIC;
            }
        }
        return close_plan(&builder);
    }
    switch (instruction->operation) {
    case PL_X86_OPERATION_NOP:
        status = 0;
        break;
    case PL_X86_OPERATION_MOVE:
        status = lower_move(instruction, &builder);
        break;
    case PL_X86_OPERATION_MOVE_ZERO_EXTEND:
        status = lower_extend(instruction, &builder, 0);
        break;
    case PL_X86_OPERATION_MOVE_SIGN_EXTEND:
        status = lower_extend(instruction, &builder, 1);
        break;
    case PL_X86_OPERATION_LOAD_ADDRESS:
        status = lower_load_address(instruction, &builder);
        break;
    case PL_X86_OPERATION_EXCHANGE:
        status = lower_exchange(instruction, &builder);
        break;
    case PL_X86_OPERATION_ADD:
    case PL_X86_OPERATION_ADD_CARRY:
    case PL_X86_OPERATION_SUBTRACT:
    case PL_X86_OPERATION_SUBTRACT_BORROW:
    case PL_X86_OPERATION_AND:
    case PL_X86_OPERATION_OR:
    case PL_X86_OPERATION_XOR:
    case PL_X86_OPERATION_COMPARE:
    case PL_X86_OPERATION_INCREMENT:
    case PL_X86_OPERATION_DECREMENT:
    case PL_X86_OPERATION_NEGATE:
        status = lower_alu(instruction, &builder);
        break;
    case PL_X86_OPERATION_TEST:
        status = lower_test(instruction, &builder);
        break;
    case PL_X86_OPERATION_COMPLEMENT:
        status = lower_complement(instruction, &builder);
        break;
    case PL_X86_OPERATION_BRANCH:
        status = lower_branch(instruction, &builder, out);
        break;
    case PL_X86_OPERATION_CALL:
        status = lower_call(instruction, &builder, out);
        break;
    case PL_X86_OPERATION_RETURN:
        status = lower_return(instruction, &builder, out);
        break;
    case PL_X86_OPERATION_PUSH:
        status = lower_push(instruction, &builder);
        break;
    case PL_X86_OPERATION_POP:
        status = lower_pop(instruction, &builder);
        break;
    case PL_X86_OPERATION_SHIFT:
        status = lower_shift(instruction, &builder);
        break;
    case PL_X86_OPERATION_SHIFT_NO_FLAGS:
        status = lower_shift_no_flags(instruction, &builder);
        break;
    case PL_X86_OPERATION_BIT_SUMMARY:
        status = lower_bit_summary(instruction, &builder);
        break;
    case PL_X86_OPERATION_DOUBLE_SHIFT:
        status = lower_double_shift(instruction, &builder);
        break;
    case PL_X86_OPERATION_AND_NOT:
        status = lower_and_not(instruction, &builder);
        break;
    case PL_X86_OPERATION_MOVE_BYTE_SWAP:
        status = lower_move_byte_swap(instruction, &builder);
        break;
    case PL_X86_OPERATION_BASE_ACCESS:
        status = lower_base_access(instruction, &builder);
        break;
    case PL_X86_OPERATION_CRC32:
        status = lower_crc32(instruction, &builder);
        break;
    case PL_X86_OPERATION_BZHI:
        status = lower_bzhi(instruction, &builder);
        break;
    case PL_X86_OPERATION_FLAG_CONTROL:
        status = lower_flag_control(instruction, &builder);
        break;
    case PL_X86_OPERATION_LEAVE:
        status = lower_leave(instruction, &builder);
        break;
    case PL_X86_OPERATION_ACCUMULATOR_EXTEND:
        status = lower_accumulator_extend(instruction, &builder);
        break;
    case PL_X86_OPERATION_HIGH_EXTEND:
        status = lower_high_extend(instruction, &builder);
        break;
    case PL_X86_OPERATION_CONDITIONAL_SET:
        status = lower_conditional_set(instruction, &builder);
        break;
    case PL_X86_OPERATION_CONDITIONAL_MOVE:
        status = lower_conditional_move(instruction, &builder);
        break;
    case PL_X86_OPERATION_MULTIPLY_UNSIGNED:
        status = lower_multiply(instruction, &builder, 0);
        break;
    case PL_X86_OPERATION_MULTIPLY_SIGNED:
        status = lower_multiply(instruction, &builder, 1);
        break;
    case PL_X86_OPERATION_DIVIDE_UNSIGNED:
        status = lower_divide(instruction, &builder, out, 0);
        break;
    case PL_X86_OPERATION_DIVIDE_SIGNED:
        status = lower_divide(instruction, &builder, out, 1);
        break;
    case PL_X86_OPERATION_LOOP:
        status = lower_loop(instruction, &builder, out);
        break;
    case PL_X86_OPERATION_COUNT_ZERO_BRANCH:
        status = lower_count_zero_branch(instruction, &builder, out);
        break;
    case PL_X86_OPERATION_PUSH_FLAGS:
        status = lower_push_flags(instruction, &builder);
        break;
    case PL_X86_OPERATION_LOAD_FLAGS_LOW:
        status = lower_load_flags_low(&builder);
        break;
    case PL_X86_OPERATION_STORE_FLAGS_LOW:
        status = lower_store_flags_low(instruction, &builder);
        break;
    case PL_X86_OPERATION_BIT_TEST:
        status = lower_bit_test(instruction, &builder);
        break;
    case PL_X86_OPERATION_TRANSLATE_BYTE:
        status = lower_translate_byte(instruction, &builder);
        break;
    case PL_X86_OPERATION_BYTE_SWAP:
        status = lower_byte_swap(instruction, &builder);
        break;
    case PL_X86_OPERATION_ENTER:
        status = lower_enter(instruction, &builder);
        break;
    case PL_X86_OPERATION_STRING:
        status = lower_string(instruction, &builder);
        break;
    case PL_X86_OPERATION_EXCHANGE_ADD:
        status = lower_exchange_add(instruction, &builder);
        break;
    case PL_X86_OPERATION_COMPARE_EXCHANGE:
        status = lower_compare_exchange(instruction, &builder);
        break;
    default:
        status = PL_ERROR_X86_SEMANTIC;
        break;
    }
    if (status) return status;
    return close_plan(&builder);
}
