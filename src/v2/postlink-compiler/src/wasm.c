#include <postlink/wasm.h>

typedef struct {
    pl_u8 *target;
    pl_u32 capacity;
    pl_u32 used;
    int status;
    pl_u64 *parameters;
    pl_u32 parameter_capacity;
    pl_u32 parameter_count;
    pl_u32 parameterized;
} wasm_writer;

#define PL_WASM_REGION_CAP 32u
#define PL_WASM_MEMORY_CAP 64u
#define PL_WASM_SCRATCH_LOCALS 5u
#define PL_PROJECTION_SELECTOR_BITS 8u
#define PL_PROJECTION_SELECTOR_MASK 0xffu

static int emit_projection(wasm_writer *out, const pl_plan *plan,
                           pl_operand operand, pl_u32 before_node);

static void byte(wasm_writer *out, pl_u32 value)
{
    if (out->status) return;
    if (out->used == 0xffffffffu
            || (out->target && out->used >= out->capacity)) {
        out->status = PL_ERROR_WASM_RANGE;
        return;
    }
    if (out->target) out->target[out->used] = (pl_u8)value;
    out->used += 1u;
}

static void raw(wasm_writer *out, const pl_u8 *bytes, pl_u32 count)
{
    for (pl_u32 index = 0; index < count; ++index) byte(out, bytes[index]);
}

static void uleb(wasm_writer *out, pl_u32 value)
{
    do {
        pl_u32 next = value >> 7u;
        byte(out, (value & 0x7fu) | (next ? 0x80u : 0u));
        value = next;
    } while (value);
}

static void sleb64(wasm_writer *out, pl_u64 value)
{
    for (;;) {
        pl_u32 part = (pl_u32)value & 0x7fu;
        pl_u64 next = value >> 7u;
        if (value & (1ull << 63u)) next |= ~0ull << 57u;
        int done = (next == 0u && !(part & 0x40u))
                || (next == ~0ull && (part & 0x40u));
        byte(out, part | (done ? 0u : 0x80u));
        if (done) return;
        value = next;
    }
}

static void string(wasm_writer *out, const char *text, pl_u32 length)
{
    uleb(out, length);
    raw(out, (const pl_u8 *)text, length);
}

static void local_get(wasm_writer *out, pl_u32 local)
{
    byte(out, 0x20u);
    uleb(out, local);
}

static void local_set(wasm_writer *out, pl_u32 local)
{
    byte(out, 0x21u);
    uleb(out, local);
}

static void local_tee(wasm_writer *out, pl_u32 local)
{
    byte(out, 0x22u);
    uleb(out, local);
}

static void i64_const(wasm_writer *out, pl_u64 value)
{
    byte(out, 0x42u);
    sleb64(out, value);
}

static void i32_const(wasm_writer *out, pl_u32 value)
{
    byte(out, 0x41u);
    /* WebAssembly i32.const uses a signed LEB.  Sign-extend the source word
     * before handing it to the shared 64-bit encoder; spelling 0xffffffff as
     * positive 4294967295 is not a canonical i32 immediate. */
    sleb64(out, (value & 0x80000000u)
                    ? (pl_u64)value | 0xffffffff00000000ull
                    : (pl_u64)value);
}

static void i32_load(wasm_writer *out, pl_u32 alignment, pl_u32 offset)
{
    byte(out, 0x28u);
    uleb(out, alignment);
    uleb(out, offset);
}

static void return_if(wasm_writer *out, pl_vm_result result)
{
    byte(out, 0x04u); byte(out, 0x40u); /* if, empty block type */
    i64_const(out, result);
    byte(out, 0x0fu);                   /* return */
    byte(out, 0x0bu);                   /* end if */
}

static void call(wasm_writer *out, pl_u32 function)
{
    byte(out, 0x10u);
    uleb(out, function);
}

static void block_coordinate(wasm_writer *out, pl_u32 block)
{
    byte(out, 0x23u); uleb(out, 0u);   /* global.get table_base */
    i32_const(out, block);
    byte(out, 0x6au);                  /* i32.add */
}

static void i64_load(wasm_writer *out, pl_u32 offset)
{
    byte(out, 0x29u);
    uleb(out, 3u);
    uleb(out, offset);
}

static void i64_store(wasm_writer *out, pl_u32 offset)
{
    byte(out, 0x37u);
    uleb(out, 3u);
    uleb(out, offset);
}

static void state_address(wasm_writer *out)
{
    local_get(out, 0u);
}

static void operand_constant(wasm_writer *out, pl_u64 value)
{
    if (!out->parameterized) {
        i64_const(out, value);
        return;
    }
    if (out->parameter_count == 0xffffffffu
            || (out->parameters
                && out->parameter_count >= out->parameter_capacity)) {
        out->status = PL_ERROR_WASM_RANGE;
        return;
    }
    if (out->parameters)
        out->parameters[out->parameter_count] = value;
    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_PARAMETER_VALUES);
    i64_load(out, out->parameter_count * 8u);
    out->parameter_count += 1u;
}

static int operand_i64(wasm_writer *out, const pl_plan *plan,
                       pl_operand operand, pl_u32 before_node)
{
    if (operand.kind == PL_OPERAND_CONST) {
        operand_constant(out, operand.value);
        return out->status;
    }
    if (operand.kind == PL_OPERAND_NODE) {
        if (!operand.value || operand.value >= before_node) {
            out->status = PL_ERROR_WASM_ABI;
            return out->status;
        }
        local_get(out, 2u + (pl_u32)operand.value - 1u);
        return out->status;
    }
    if (operand.kind == PL_OPERAND_PROJECTION)
        return emit_projection(out, plan, operand, before_node);
    if (operand.kind != PL_OPERAND_LOCAL
            || operand.value >= plan->local_count) {
        out->status = PL_ERROR_WASM_UNSUPPORTED;
        return out->status;
    }
    if (operand.value < PL_VM_X86_REGISTER_COUNT) {
        state_address(out);
        i32_load(out, 2u, PL_VM_X86_WASM32_OFF_REGISTERS);
        i64_load(out, (pl_u32)operand.value * 8u);
    } else if (operand.value == PL_VM_X86_RFLAGS_LOCAL) {
        state_address(out);
        i64_load(out, PL_VM_X86_WASM32_OFF_RFLAGS);
    } else if (operand.value == PL_VM_X86_FS_BASE_LOCAL
            || operand.value == PL_VM_X86_GS_BASE_LOCAL) {
        local_get(out, 0u);
        i32_const(out, (pl_u32)operand.value - PL_VM_X86_FS_BASE_LOCAL);
        call(out, 10u); /* env.direct_x86_segment_base */
    } else {
        /* x86 block scratch locals are freshly zeroed at every entry. */
        i64_const(out, 0u);
    }
    return out->status;
}

static void width_argument(wasm_writer *out, const pl_plan *plan,
                           pl_operand operand, pl_u32 node, pl_u32 bits)
{
    (void)operand_i64(out, plan, operand, node);
    if (bits == 32u) byte(out, 0xa7u); /* i32.wrap_i64 */
}

static void publish_width(wasm_writer *out, pl_u32 bits)
{
    if (bits == 32u) byte(out, 0xadu); /* i64.extend_i32_u */
}

static int argument_count(const pl_node *node, pl_u32 expected)
{
    return node->argument_count == expected;
}

static int direct_memory_opcode(pl_u32 opcode)
{
    return (opcode >= 140u && opcode <= 158u)
        || opcode == PL_OPCODE_MEMORY_REPEAT
        || opcode == PL_OPCODE_MEMORY_COPY
        || opcode == PL_OPCODE_MEMORY_FIND2
        || opcode == PL_OPCODE_MEMORY_PRE_STORE
        || opcode == PL_OPCODE_MEMORY_LOAD_REGION
        || opcode == PL_OPCODE_MEMORY_STORE_IF
        || opcode == PL_OPCODE_MEMORY_FRAME;
}

static int direct_memory_slot(const pl_plan *plan, pl_u32 source,
                              pl_u32 *slot)
{
    if (!source || source > plan->node_count) return PL_ERROR_WASM_ABI;
    pl_u32 found = 0u;
    for (pl_u32 index = 0u; index < source; ++index) {
        if (!direct_memory_opcode(plan->nodes[index].opcode)) continue;
        if (found >= PL_WASM_MEMORY_CAP) return PL_ERROR_WASM_RANGE;
        if (index + 1u == source) {
            *slot = found;
            return 0;
        }
        found += 1u;
    }
    return PL_ERROR_WASM_UNSUPPORTED;
}

static int direct_memory_count(const pl_plan *plan, pl_u32 *count)
{
    *count = 0u;
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        if (!direct_memory_opcode(plan->nodes[index].opcode)) continue;
        if (*count == PL_WASM_MEMORY_CAP) return PL_ERROR_WASM_RANGE;
        *count += 1u;
    }
    return 0;
}

static const pl_operand *arguments(const pl_plan *plan, const pl_node *node)
{
    return plan->arguments + node->argument_at;
}

static int load_region_geometry(const pl_plan *plan, const pl_node *node,
                                pl_u32 *count, pl_u32 *width)
{
    if (node->opcode != PL_OPCODE_MEMORY_LOAD_REGION
            || node->argument_count < 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return PL_ERROR_WASM_ABI;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST
            || arg[3].kind != PL_OPERAND_CONST)
        return PL_ERROR_WASM_ABI;
    pl_u64 descriptor = arg[2].value;
    pl_u64 shape = arg[3].value;
    *count = (pl_u32)descriptor & 0xffu;
    *width = (pl_u32)shape & 0xffu;
    pl_u32 bits = descriptor & 0x200u ? 32u : 64u;
    int signed_load = (descriptor & 0x100u) != 0u;
    pl_u64 scale = (shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
                 & PL_MEMORY_SHAPE_SCALE_MASK;
    if (!*count || *count > 8u || (descriptor & ~0x3ffull)
            || (*width != 1u && *width != 2u
                && *width != 4u && *width != 8u)
            || scale || (shape & ~(pl_u64)PL_MEMORY_SHAPE_MASK)
            || *width * 8u > bits
            || (signed_load && *width * 8u >= bits))
        return PL_ERROR_WASM_ABI;
    return 0;
}

static int load_region_slot(const pl_plan *plan, pl_u32 source,
                            pl_u32 *slot, pl_u32 *count)
{
    if (!source || source > plan->node_count) return PL_ERROR_WASM_ABI;
    pl_u32 found = 0u;
    for (pl_u32 index = 0u; index < source; ++index) {
        const pl_node *node = &plan->nodes[index];
        if (node->opcode != PL_OPCODE_MEMORY_LOAD_REGION) continue;
        if (found >= PL_WASM_REGION_CAP) return PL_ERROR_WASM_RANGE;
        if (index + 1u == source) {
            pl_u32 width = 0u;
            int status = load_region_geometry(plan, node, count, &width);
            if (status) return status;
            *slot = found;
            return 0;
        }
        found += 1u;
    }
    return PL_ERROR_WASM_UNSUPPORTED;
}

static int direct_flag_opcode(pl_u32 opcode)
{
    return opcode == PL_OPCODE_X86_FLAGS
        || opcode == PL_OPCODE_X86_ALU
        || opcode == PL_OPCODE_X86_AFFINE_ALU
        || opcode == PL_OPCODE_X86_COMPARE
        || opcode == PL_OPCODE_X86_SHIFT_FLAGS
        || opcode == PL_OPCODE_X86_TEST
        || opcode == PL_OPCODE_X86_BIT_FLAGS
        || opcode == PL_OPCODE_X86_ROTATE_CARRY
        || opcode == PL_OPCODE_X86_BIT_SUMMARY
        || opcode == PL_OPCODE_X86_DOUBLE_SHIFT
        || opcode == PL_OPCODE_X86_BZHI;
}

static int direct_scratch_opcode(pl_u32 opcode)
{
    return direct_flag_opcode(opcode)
        || opcode == PL_OPCODE_X86_CONDITION
        || opcode == PL_OPCODE_X86_TEST_CONDITION
        || opcode == PL_OPCODE_MUL_HIGH
        || opcode == 14u || opcode == 84u  /* lane32/64.BSWAP */
        || (opcode >= 56u && opcode <= 59u)
        || (opcode >= 126u && opcode <= 129u);
}

static pl_u32 direct_alu_count(const pl_plan *plan)
{
    pl_u32 count = 0u;
    for (pl_u32 index = 0u; index < plan->node_count; ++index)
        count += plan->nodes[index].opcode == PL_OPCODE_X86_ALU
              || plan->nodes[index].opcode == PL_OPCODE_X86_AFFINE_ALU
              || plan->nodes[index].opcode == PL_OPCODE_X86_ROTATE_CARRY
              || plan->nodes[index].opcode == PL_OPCODE_X86_BIT_SUMMARY
              || plan->nodes[index].opcode == PL_OPCODE_X86_DOUBLE_SHIFT
              || plan->nodes[index].opcode == PL_OPCODE_X86_BZHI;
    return count;
}

static int direct_alu_result_local(const pl_plan *plan, pl_u32 source,
                                   pl_u32 *local)
{
    if (!source || source > plan->node_count
            || (plan->nodes[source - 1u].opcode != PL_OPCODE_X86_ALU
                && plan->nodes[source - 1u].opcode
                   != PL_OPCODE_X86_AFFINE_ALU
                && plan->nodes[source - 1u].opcode
                   != PL_OPCODE_X86_ROTATE_CARRY
                && plan->nodes[source - 1u].opcode
                   != PL_OPCODE_X86_BIT_SUMMARY
                && plan->nodes[source - 1u].opcode
                   != PL_OPCODE_X86_DOUBLE_SHIFT
                && plan->nodes[source - 1u].opcode
                   != PL_OPCODE_X86_BZHI))
        return PL_ERROR_WASM_UNSUPPORTED;
    pl_u32 slot = 0u;
    for (pl_u32 index = 0u; index + 1u < source; ++index)
        slot += plan->nodes[index].opcode == PL_OPCODE_X86_ALU
             || plan->nodes[index].opcode == PL_OPCODE_X86_AFFINE_ALU
             || plan->nodes[index].opcode == PL_OPCODE_X86_ROTATE_CARRY
             || plan->nodes[index].opcode == PL_OPCODE_X86_BIT_SUMMARY
             || plan->nodes[index].opcode == PL_OPCODE_X86_DOUBLE_SHIFT
             || plan->nodes[index].opcode == PL_OPCODE_X86_BZHI;
    *local = 2u + plan->node_count + slot;
    return 0;
}

static pl_u32 direct_scratch(const pl_plan *plan)
{
    return 2u + plan->node_count + direct_alu_count(plan);
}

static void emit_flag_bit(wasm_writer *out, pl_u32 local, pl_u32 bit)
{
    local_get(out, local);
    if (bit) {
        i64_const(out, bit);
        byte(out, 0x88u);              /* i64.shr_u */
    }
    i64_const(out, 1u);
    byte(out, 0x83u);                  /* i64.and */
}

static void emit_condition_local(wasm_writer *out, pl_u32 local, pl_u32 code)
{
    switch ((code >> 1u) & 7u) {
    case 0u: emit_flag_bit(out, local, 11u); break;          /* overflow */
    case 1u: emit_flag_bit(out, local, 0u); break;           /* carry */
    case 2u: emit_flag_bit(out, local, 6u); break;           /* zero */
    case 3u:                                                /* carry | zero */
        emit_flag_bit(out, local, 0u);
        emit_flag_bit(out, local, 6u);
        byte(out, 0x84u);                                   /* i64.or */
        break;
    case 4u: emit_flag_bit(out, local, 7u); break;           /* sign */
    case 5u: emit_flag_bit(out, local, 2u); break;           /* parity */
    case 6u:                                                /* sign ^ overflow */
        emit_flag_bit(out, local, 7u);
        emit_flag_bit(out, local, 11u);
        byte(out, 0x85u);                                   /* i64.xor */
        break;
    default:                                                /* zero | less */
        emit_flag_bit(out, local, 6u);
        emit_flag_bit(out, local, 7u);
        emit_flag_bit(out, local, 11u);
        byte(out, 0x85u);
        byte(out, 0x84u);
        break;
    }
    if (code & 1u) {
        i64_const(out, 1u);
        byte(out, 0x85u);                  /* i64.xor */
    }
}

static int emit_projection(wasm_writer *out, const pl_plan *plan,
                           pl_operand operand, pl_u32 before_node)
{
    pl_u32 source = (pl_u32)(operand.value >> PL_PROJECTION_SELECTOR_BITS);
    pl_u32 selector = (pl_u32)operand.value & PL_PROJECTION_SELECTOR_MASK;
    if (!source || source >= before_node) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 opcode = plan->nodes[source - 1u].opcode;
    if (opcode == PL_OPCODE_MEMORY_LOAD_REGION) {
        pl_u32 slot = 0u, count = 0u;
        int status = load_region_slot(plan, source, &slot, &count);
        if (status || selector > count) {
            out->status = status ? status : PL_ERROR_WASM_ABI;
            return out->status;
        }
        local_get(out, 0u);
        i32_const(out, slot);
        i32_const(out, selector);
        call(out, 3u); /* env.direct_memory_region_value */
        return out->status;
    }
    if (opcode == PL_OPCODE_X86_DIVIDE && selector < 2u) {
        local_get(out, 0u);
        i32_const(out, selector);
        call(out, 9u); /* env.direct_x86_divide_result */
        return out->status;
    }
    if ((opcode == PL_OPCODE_X86_ALU
            || opcode == PL_OPCODE_X86_AFFINE_ALU
            || opcode == PL_OPCODE_X86_ROTATE_CARRY
            || opcode == PL_OPCODE_X86_BIT_SUMMARY
            || opcode == PL_OPCODE_X86_DOUBLE_SHIFT
            || opcode == PL_OPCODE_X86_BZHI) && selector == 16u) {
        pl_u32 local = 0u;
        int status = direct_alu_result_local(plan, source, &local);
        if (status) out->status = status;
        else local_get(out, local);
        return out->status;
    }
    if ((opcode == PL_OPCODE_X86_ROTATE_CARRY
            || opcode == PL_OPCODE_X86_DOUBLE_SHIFT) && selector == 17u) {
        const pl_node *node = &plan->nodes[source - 1u];
        const pl_operand *arg = arguments(plan, node);
        pl_u32 count_at = opcode == PL_OPCODE_X86_ROTATE_CARRY ? 2u : 3u;
        pl_u32 descriptor_at = opcode == PL_OPCODE_X86_ROTATE_CARRY ? 3u : 4u;
        if (!argument_count(node, descriptor_at + 1u)
                || arg[descriptor_at].kind != PL_OPERAND_CONST) {
            out->status = PL_ERROR_WASM_ABI;
            return out->status;
        }
        pl_u32 width = (pl_u32)arg[descriptor_at].value & 0x7fu;
        if (width != 16u && width != 32u && width != 64u
                && !(opcode == PL_OPCODE_X86_ROTATE_CARRY && width == 8u)) {
            out->status = PL_ERROR_WASM_ABI;
            return out->status;
        }
        (void)operand_i64(out, plan, arg[count_at], before_node);
        i64_const(out, width == 64u ? 63u : 31u);
        byte(out, 0x83u);              /* mask the architectural count */
        if (opcode == PL_OPCODE_X86_ROTATE_CARRY && width < 32u) {
            i64_const(out, width + 1u);
            byte(out, 0x82u);          /* i64.rem_u by a nonzero constant */
        }
        i64_const(out, 0u); byte(out, 0x52u); /* normalized count != 0 */
        byte(out, 0xadu);
        return out->status;
    }
    if (direct_flag_opcode(opcode) && selector < 16u) {
        emit_condition_local(out, 2u + source - 1u, selector);
        return out->status;
    }
    out->status = PL_ERROR_WASM_UNSUPPORTED;
    return out->status;
}

static pl_u32 binary_opcode(pl_u32 bits, pl_u32 operation)
{
    static const pl_u8 i32[] = {
        0x00u, 0x71u, 0x72u, 0x73u, 0x6au, 0x6bu, 0x6cu,
        0x74u, 0x76u, 0x75u, 0x77u, 0x78u,
        0x6du, 0x6eu, 0x6fu, 0x70u,
    };
    static const pl_u8 i64[] = {
        0x00u, 0x83u, 0x84u, 0x85u, 0x7cu, 0x7du, 0x7eu,
        0x86u, 0x88u, 0x87u, 0x89u, 0x8au,
        0x7fu, 0x80u, 0x81u, 0x82u,
    };
    pl_u32 slot = operation == 6u || operation == 17u ? 1u
                : operation == 7u || operation == 18u ? 2u
                : operation == 8u || operation == 16u ? 3u
                : operation == 9u || operation == 19u ? 4u
                : operation == 10u || operation == 26u ? 5u
                : operation == 4u || operation == 50u ? 6u
                : operation == 12u || operation == 51u ? 7u
                : operation == 13u || operation == 53u ? 8u
                : operation == 24u || operation == 52u ? 9u
                : operation == 54u ? 10u
                : operation == 55u ? 11u
                : operation == 56u ? 12u
                : operation == 57u ? 13u
                : operation == 58u ? 14u
                : operation == 59u ? 15u : 0u;
    return bits == 32u ? i32[slot] : i64[slot];
}

static int operation_traps_in_wasm(pl_u32 operation)
{
    /* Wasm integer div/rem traps cannot escape this function: a direct block
     * must publish PL_VM_FAULT through the homogeneous result ABI instead.
     * Admit these operations only after the emitter has explicit fault
     * control rather than accidentally acquiring the host trap path. */
    return operation >= 56u && operation <= 59u;
}

static pl_u32 memory_opcode_width(pl_u32 opcode)
{
    if (opcode == 140u || opcode == 150u || opcode == 151u
            || opcode == 152u || opcode == 158u)
        return 4u;
    if (opcode == 141u || opcode == 142u || opcode == 146u
            || opcode == 147u || opcode == 153u || opcode == 156u)
        return 1u;
    if (opcode == 143u || opcode == 144u || opcode == 148u
            || opcode == 149u || opcode == 154u || opcode == 157u)
        return 2u;
    return opcode == 145u || opcode == 155u ? 8u : 0u;
}

static void direct_memory_guard(wasm_writer *out)
{
    /* Keep the produced memory value below the guard operands.  On failure
     * return the VM token before locals are published; after a page supply the
     * same direct function can be entered again transactionally. */
    local_get(out, 0u);
    call(out, 1u);                     /* env.direct_memory_result */
    i64_const(out, 0u);
    byte(out, 0x52u);                  /* i64.ne */
    byte(out, 0x04u); byte(out, 0x40u);/* if, empty block type */
    local_get(out, 0u);
    call(out, 1u);
    byte(out, 0x0fu);                  /* return */
    byte(out, 0x0bu);                  /* end if */
}

static int emit_memory_region(wasm_writer *out, const pl_plan *plan,
                              const pl_node *node, pl_u32 value,
                              pl_u32 block)
{
    pl_u32 count = 0u, width = 0u, region_slot = 0u, memory_slot = 0u;
    int status = load_region_geometry(plan, node, &count, &width);
    (void)width;
    if (!status)
        status = load_region_slot(plan, value, &region_slot, &count);
    if (!status) status = direct_memory_slot(plan, value, &memory_slot);
    if (status) {
        out->status = status;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    local_get(out, 0u);                /* machine */
    (void)operand_i64(out, plan, arg[0], value);
    (void)operand_i64(out, plan, arg[1], value);
    i64_const(out, arg[2].value);      /* canonical descriptor */
    i64_const(out, arg[3].value);      /* canonical memory shape */
    block_coordinate(out, block);
    i32_const(out, memory_slot);
    i32_const(out, region_slot);
    call(out, 2u);                     /* env.direct_memory_region */
    direct_memory_guard(out);
    return out->status;
}

static int emit_memory_repeat(wasm_writer *out, const pl_plan *plan,
                              const pl_node *node, pl_u32 value,
                              pl_u32 block)
{
    if (node->argument_count < 4u) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST
            || (arg[3].value & ~(pl_u64)PL_MEMORY_SHAPE_MASK)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 width = (pl_u32)arg[3].value & 0xffu;
    if (width != 1u && width != 2u && width != 4u && width != 8u) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 memory_slot = 0u;
    int status = direct_memory_slot(plan, value, &memory_slot);
    if (status) {
        out->status = status;
        return out->status;
    }
    local_get(out, 0u);
    (void)operand_i64(out, plan, arg[0], value);
    (void)operand_i64(out, plan, arg[1], value);
    (void)operand_i64(out, plan, arg[2], value);
    i64_const(out, arg[3].value);
    block_coordinate(out, block);
    i32_const(out, memory_slot);
    call(out, 4u);                     /* env.direct_memory_repeat */
    direct_memory_guard(out);
    return out->status;
}

static int emit_memory_copy(wasm_writer *out, const pl_plan *plan,
                            const pl_node *node, pl_u32 value,
                            pl_u32 block)
{
    if (node->argument_count < 4u) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST
            || (arg[3].value & ~(pl_u64)PL_MEMORY_SHAPE_MASK)
            || (arg[3].value & 0xffu) != 1u)
        goto malformed;
    pl_u32 memory_slot = 0u;
    int status = direct_memory_slot(plan, value, &memory_slot);
    if (status) {
        out->status = status;
        return out->status;
    }
    local_get(out, 0u);
    (void)operand_i64(out, plan, arg[0], value);
    (void)operand_i64(out, plan, arg[1], value);
    (void)operand_i64(out, plan, arg[2], value);
    i64_const(out, arg[3].value);
    block_coordinate(out, block);
    i32_const(out, memory_slot);
    call(out, 5u);                     /* env.direct_memory_copy */
    direct_memory_guard(out);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_memory_find2(wasm_writer *out, const pl_plan *plan,
                             const pl_node *node, pl_u32 value,
                             pl_u32 block)
{
    if (node->argument_count < 4u) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST
            || (arg[3].value & ~(pl_u64)PL_MEMORY_SHAPE_MASK)
            || (arg[3].value & 0xffu) != 1u)
        goto malformed;
    pl_u32 memory_slot = 0u;
    int status = direct_memory_slot(plan, value, &memory_slot);
    if (status) {
        out->status = status;
        return out->status;
    }
    local_get(out, 0u);
    (void)operand_i64(out, plan, arg[0], value);
    (void)operand_i64(out, plan, arg[1], value);
    (void)operand_i64(out, plan, arg[2], value);
    i64_const(out, arg[3].value);
    block_coordinate(out, block);
    i32_const(out, memory_slot);
    call(out, 6u);                     /* env.direct_memory_find2 */
    direct_memory_guard(out);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_memory_store_if(
        wasm_writer *out, const pl_plan *plan,
        const pl_node *node, pl_u32 value, pl_u32 block)
{
    if (node->argument_count < 5u) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST
            || arg[4].kind != PL_OPERAND_CONST
            || arg[3].value
            || (arg[4].value & ~(pl_u64)PL_MEMORY_SHAPE_MASK)
            || !(arg[4].value & PL_MEMORY_SHAPE_VIRTUAL64))
        goto malformed;
    pl_u32 width = (pl_u32)arg[4].value & 0xffu;
    pl_u32 scale = (pl_u32)(arg[4].value
                         >> PL_MEMORY_SHAPE_SCALE_SHIFT)
                 & PL_MEMORY_SHAPE_SCALE_MASK;
    if ((width != 1u && width != 2u && width != 4u && width != 8u)
            || scale)
        goto malformed;
    pl_u32 memory_slot = 0u;
    int status = direct_memory_slot(plan, value, &memory_slot);
    if (status) {
        out->status = status;
        return out->status;
    }
    local_get(out, 0u);
    (void)operand_i64(out, plan, arg[0], value);
    (void)operand_i64(out, plan, arg[1], value);
    i64_const(out, arg[3].value);
    i64_const(out, arg[4].value);
    (void)operand_i64(out, plan, arg[2], value);
    i64_const(out, 0u); byte(out, 0x52u); /* predicate -> canonical i32 */
    block_coordinate(out, block);
    i32_const(out, memory_slot);
    call(out, 13u);                    /* env.direct_memory_store_if */
    direct_memory_guard(out);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_memory_frame(wasm_writer *out, const pl_plan *plan,
                             const pl_node *node, pl_u32 value,
                             pl_u32 block)
{
    if (node->argument_count < 4u) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST
            || arg[3].kind != PL_OPERAND_CONST
            || arg[2].value > 31u
            || (arg[3].value & ~(pl_u64)PL_MEMORY_SHAPE_MASK)
            || !(arg[3].value & PL_MEMORY_SHAPE_VIRTUAL64))
        goto malformed;
    pl_u32 width = (pl_u32)arg[3].value & 0xffu;
    pl_u32 scale = (pl_u32)(arg[3].value
                         >> PL_MEMORY_SHAPE_SCALE_SHIFT)
                 & PL_MEMORY_SHAPE_SCALE_MASK;
    if ((width != 2u && width != 8u) || scale) goto malformed;
    pl_u32 memory_slot = 0u;
    int status = direct_memory_slot(plan, value, &memory_slot);
    if (status) {
        out->status = status;
        return out->status;
    }
    local_get(out, 0u);
    (void)operand_i64(out, plan, arg[0], value);
    (void)operand_i64(out, plan, arg[1], value);
    i64_const(out, arg[2].value);
    i64_const(out, arg[3].value);
    block_coordinate(out, block);
    i32_const(out, memory_slot);
    call(out, 14u);                    /* env.direct_memory_frame */
    direct_memory_guard(out);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_memory_lane(wasm_writer *out, const pl_plan *plan,
                            const pl_node *node, pl_u32 value,
                            pl_u32 block)
{
    int pre_store = node->opcode == PL_OPCODE_MEMORY_PRE_STORE;
    pl_u32 width = pre_store ? 0u : memory_opcode_width(node->opcode);
    if (!width && !pre_store) return PL_ERROR_WASM_UNSUPPORTED;
    int store = node->opcode >= 152u;
    pl_u32 expected = store ? 4u : 3u;
    /* Operands after the semantic prefix are SSA memory-order dependencies.
     * Dense direct functions already emit nodes in that order, so they carry
     * no runtime value and must not create a second memory ABI. */
    if (node->argument_count < expected) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    const pl_operand shape = arg[store ? 3u : 2u];
    if (pre_store) width = (pl_u32)shape.value & 0xffu;
    pl_u64 scale = (shape.value >> PL_MEMORY_SHAPE_SCALE_SHIFT)
                 & PL_MEMORY_SHAPE_SCALE_MASK;
    if (shape.kind != PL_OPERAND_CONST
            || (shape.value & ~(pl_u64)PL_MEMORY_SHAPE_MASK)
            || (pl_u32)(shape.value & 0xffu) != width
            || (pre_store
                && ((width != 1u && width != 2u
                     && width != 4u && width != 8u)
                    || scale != 0u
                    || !(shape.value & PL_MEMORY_SHAPE_VIRTUAL64)))) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 memory_slot = 0u;
    int status = direct_memory_slot(plan, value, &memory_slot);
    if (status) {
        out->status = status;
        return out->status;
    }
    local_get(out, 0u);                /* machine */
    (void)operand_i64(out, plan, arg[0], value);
    if (store) (void)operand_i64(out, plan, arg[1], value);
    else i64_const(out, 0u);
    (void)operand_i64(out, plan, arg[store ? 2u : 1u], value);
    i64_const(out, shape.value);
    i32_const(out, node->opcode);
    block_coordinate(out, block);
    i32_const(out, memory_slot);
    call(out, 0u);                     /* env.direct_memory */
    direct_memory_guard(out);
    return out->status;
}

static pl_u64 lane_mask(pl_u32 width)
{
    return width == 64u ? ~0ull : (1ull << width) - 1u;
}

static void stage_flag_operand(wasm_writer *out, const pl_plan *plan,
                               pl_operand operand, pl_u32 node,
                               pl_u32 local, pl_u64 mask)
{
    (void)operand_i64(out, plan, operand, node);
    if (mask != ~0ull) {
        i64_const(out, mask);
        byte(out, 0x83u);              /* i64.and */
    }
    local_set(out, local);
}

static void or_staged_flag(wasm_writer *out, pl_u32 flags_local)
{
    local_get(out, flags_local);
    byte(out, 0x84u);                  /* i64.or */
    local_set(out, flags_local);
}

static void emit_flags_staged(wasm_writer *out, const pl_plan *plan,
                              pl_operand prior, pl_u32 node,
                              pl_u64 descriptor, pl_u32 scratch)
{
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 mode = (pl_u32)(descriptor >> 8u) & 7u;
    int preserve_carry = (descriptor & (1ull << 11u)) != 0u;
    pl_u64 mask = lane_mask(width);
    pl_u32 left = scratch, right = scratch + 1u;
    pl_u32 value = scratch + 2u, flags = scratch + 3u;

    (void)operand_i64(out, plan, prior, node);
    i64_const(out, ~0x8c5ull);
    byte(out, 0x83u);                  /* i64.and */
    i64_const(out, 2u);
    byte(out, 0x84u);                  /* i64.or */
    local_set(out, flags);

    if (preserve_carry) {
        (void)operand_i64(out, plan, prior, node);
        i64_const(out, 1u);
        byte(out, 0x83u);
        or_staged_flag(out, flags);
    } else if (mode == 1u || mode == 2u) {
        local_get(out, left);
        i64_const(out, mask);
        local_get(out, right);
        byte(out, 0x7du);              /* i64.sub */
        byte(out, 0x56u);              /* i64.gt_u */
        if (mode == 2u) {
            (void)operand_i64(out, plan, prior, node);
            i64_const(out, 1u); byte(out, 0x83u);
            i64_const(out, 0u); byte(out, 0x52u); /* i64.ne */
            local_get(out, left); local_get(out, right);
            byte(out, 0x7cu);          /* i64.add */
            i64_const(out, mask); byte(out, 0x51u); /* i64.eq */
            byte(out, 0x71u);          /* i32.and */
            byte(out, 0x72u);          /* i32.or */
        }
        byte(out, 0xadu);              /* i64.extend_i32_u */
        or_staged_flag(out, flags);
    } else if (mode == 3u || mode == 4u) {
        local_get(out, left); local_get(out, right);
        byte(out, 0x54u);              /* i64.lt_u */
        if (mode == 4u) {
            (void)operand_i64(out, plan, prior, node);
            i64_const(out, 1u); byte(out, 0x83u);
            i64_const(out, 0u); byte(out, 0x52u);
            local_get(out, left); local_get(out, right);
            byte(out, 0x51u);          /* i64.eq */
            byte(out, 0x71u);          /* i32.and */
            byte(out, 0x72u);          /* i32.or */
        }
        byte(out, 0xadu);
        or_staged_flag(out, flags);
    }

    local_get(out, value);
    i64_const(out, 255u); byte(out, 0x83u);
    byte(out, 0x7bu);                  /* i64.popcnt */
    i64_const(out, 1u); byte(out, 0x83u);
    byte(out, 0x50u);                  /* i64.eqz */
    byte(out, 0xadu);
    i64_const(out, 2u); byte(out, 0x86u); /* i64.shl */
    or_staged_flag(out, flags);

    local_get(out, value); byte(out, 0x50u);
    byte(out, 0xadu);
    i64_const(out, 6u); byte(out, 0x86u);
    or_staged_flag(out, flags);

    local_get(out, value);
    i64_const(out, width - 8u); byte(out, 0x88u);
    i64_const(out, 0x80u); byte(out, 0x83u);
    or_staged_flag(out, flags);

    if (mode >= 1u && mode <= 4u) {
        local_get(out, left); local_get(out, right);
        byte(out, 0x85u);              /* i64.xor */
        if (mode <= 2u) {
            i64_const(out, ~0ull);
            byte(out, 0x85u);          /* complement */
        }
        local_get(out, left); local_get(out, value);
        byte(out, 0x85u);
        byte(out, 0x83u);
        i64_const(out, 1ull << (width - 1u));
        byte(out, 0x83u);
        i64_const(out, 0u); byte(out, 0x52u);
        byte(out, 0xadu);
        i64_const(out, 11u); byte(out, 0x86u);
        or_staged_flag(out, flags);
    }
    local_get(out, flags);
}

static int emit_x86_flag_lane(wasm_writer *out, const pl_plan *plan,
                              const pl_node *node, pl_u32 value)
{
    int affine = node->opcode == PL_OPCODE_X86_AFFINE_ALU;
    pl_u32 descriptor_at = node->opcode == PL_OPCODE_X86_FLAGS || affine
                         ? 4u : 3u;
    pl_u32 expected = descriptor_at + 1u;
    if (!argument_count(node, expected)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    if (arg[descriptor_at].kind != PL_OPERAND_CONST) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u64 descriptor = arg[descriptor_at].value;
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 mode = (pl_u32)(descriptor >> 8u) & 7u;
    if ((width != 8u && width != 16u && width != 32u && width != 64u)
            || (descriptor & ~0xfffull)
            || ((node->opcode == PL_OPCODE_X86_ALU || affine) && mode > 7u)
            || (node->opcode == PL_OPCODE_X86_TEST
                && descriptor != width)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 scratch = direct_scratch(plan);
    pl_u64 mask = lane_mask(width);
    if (affine) {
        (void)operand_i64(out, plan, arg[1], value);
        (void)operand_i64(out, plan, arg[2], value);
        byte(out, 0x7cu);              /* i64.add */
        if (mask != ~0ull) {
            i64_const(out, mask); byte(out, 0x83u);
        }
        local_set(out, scratch);
        stage_flag_operand(out, plan, arg[3], value, scratch + 1u, mask);
    } else {
        stage_flag_operand(out, plan, arg[1], value, scratch, mask);
        stage_flag_operand(out, plan, arg[2], value, scratch + 1u, mask);
    }

    if (node->opcode == PL_OPCODE_X86_ALU || affine) {
        pl_u32 result_local = 0u;
        int status = direct_alu_result_local(plan, value, &result_local);
        if (status) {
            out->status = status;
            return out->status;
        }
        local_get(out, scratch);
        if (mode == 7u) {
            i64_const(out, ~0ull); byte(out, 0x85u); /* complement left */
        }
        local_get(out, scratch + 1u);
        byte(out, mode == 0u ? 0x83u
                 : mode == 1u || mode == 2u ? 0x7cu
                 : mode == 3u || mode == 4u ? 0x7du
                 : mode == 5u ? 0x84u
                 : mode == 7u ? 0x83u : 0x85u);
        if (mode == 2u || mode == 4u) {
            (void)operand_i64(out, plan, arg[0], value);
            i64_const(out, 1u); byte(out, 0x83u);
            byte(out, mode == 2u ? 0x7cu : 0x7du);
        }
        if (mask != ~0ull) {
            i64_const(out, mask); byte(out, 0x83u);
        }
        local_tee(out, result_local);
        local_set(out, scratch + 2u);
    } else if (node->opcode == PL_OPCODE_X86_COMPARE) {
        local_get(out, scratch); local_get(out, scratch + 1u);
        byte(out, 0x7du);              /* i64.sub */
        if (mask != ~0ull) {
            i64_const(out, mask); byte(out, 0x83u);
        }
        local_set(out, scratch + 2u);
    } else if (node->opcode == PL_OPCODE_X86_TEST) {
        local_get(out, scratch); local_get(out, scratch + 1u);
        byte(out, 0x83u);              /* i64.and */
        local_set(out, scratch + 2u);
    } else {
        (void)operand_i64(out, plan, arg[3], value);
        if (mask != ~0ull) {
            i64_const(out, mask); byte(out, 0x83u);
        }
        local_set(out, scratch + 2u);
    }
    emit_flags_staged(out, plan, arg[0], value, descriptor, scratch);
    return out->status;
}

static int emit_x86_condition_lane(wasm_writer *out, const pl_plan *plan,
                                   const pl_node *node, pl_u32 value)
{
    if (!argument_count(node, 2u)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    if (arg[1].kind != PL_OPERAND_CONST) {
        out->status = PL_ERROR_WASM_UNSUPPORTED;
        return out->status;
    }
    pl_u32 scratch = direct_scratch(plan);
    (void)operand_i64(out, plan, arg[0], value);
    local_set(out, scratch);
    emit_condition_local(out, scratch, (pl_u32)arg[1].value & 15u);
    return out->status;
}

static void emit_logic_flags(wasm_writer *out, const pl_plan *plan,
                             pl_operand prior, pl_u32 node, pl_u32 width,
                             pl_u32 value, pl_u32 flags)
{
    (void)operand_i64(out, plan, prior, node);
    i64_const(out, ~0x8c5ull); byte(out, 0x83u);
    i64_const(out, 2u); byte(out, 0x84u);
    local_set(out, flags);

    local_get(out, value);
    i64_const(out, 255u); byte(out, 0x83u);
    byte(out, 0x7bu);                  /* i64.popcnt */
    i64_const(out, 1u); byte(out, 0x83u);
    byte(out, 0x50u); byte(out, 0xadu);
    i64_const(out, 2u); byte(out, 0x86u);
    or_staged_flag(out, flags);

    local_get(out, value); byte(out, 0x50u); byte(out, 0xadu);
    i64_const(out, 6u); byte(out, 0x86u);
    or_staged_flag(out, flags);

    local_get(out, value);
    i64_const(out, width - 8u); byte(out, 0x88u);
    i64_const(out, 0x80u); byte(out, 0x83u);
    or_staged_flag(out, flags);
}

static int emit_x86_test_condition_lane(wasm_writer *out,
                                        const pl_plan *plan,
                                        const pl_node *node,
                                        pl_u32 value_node)
{
    if (!argument_count(node, 3u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 width = (pl_u32)arg[2].value & 0x7fu;
    pl_u32 condition = (pl_u32)(arg[2].value >> 8u) & 15u;
    if ((width != 8u && width != 16u && width != 32u && width != 64u)
            || arg[2].value != (pl_u64)(width | (condition << 8u)))
        goto malformed;
    pl_u32 scratch = direct_scratch(plan);
    (void)operand_i64(out, plan, arg[0], value_node);
    (void)operand_i64(out, plan, arg[1], value_node);
    byte(out, 0x83u);                  /* i64.and */
    if (width < 64u) {
        i64_const(out, lane_mask(width)); byte(out, 0x83u);
    }
    local_set(out, scratch);
    pl_operand zero = { PL_OPERAND_CONST, 0u };
    emit_logic_flags(out, plan, zero, value_node, width,
                     scratch, scratch + 1u);
    emit_condition_local(out, scratch + 1u, condition);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static void emit_shift_carry(wasm_writer *out, pl_u32 group, pl_u32 width,
                             pl_u32 source, pl_u32 value, pl_u32 amount)
{
    if (group == 0u) {
        local_get(out, value);
    } else if (group == 1u) {
        local_get(out, value);
        i64_const(out, width - 1u); byte(out, 0x88u);
    } else if (group == 4u) {
        local_get(out, amount); i64_const(out, width); byte(out, 0x58u);
        byte(out, 0x04u); byte(out, 0x7eu);
        local_get(out, source);
        i64_const(out, width); local_get(out, amount); byte(out, 0x7du);
        byte(out, 0x88u);
        byte(out, 0x05u); i64_const(out, 0u); byte(out, 0x0bu);
    } else {
        local_get(out, amount); i64_const(out, width); byte(out, 0x58u);
        byte(out, 0x04u); byte(out, 0x7eu);
        local_get(out, source);
        local_get(out, amount); i64_const(out, 1u); byte(out, 0x7du);
        byte(out, 0x88u);
        byte(out, 0x05u); i64_const(out, 0u); byte(out, 0x0bu);
    }
    i64_const(out, 1u); byte(out, 0x83u);
}

static void emit_shift_overflow(wasm_writer *out, pl_u32 group, pl_u32 width,
                                pl_u32 source, pl_u32 value, pl_u32 carry)
{
    if (group == 0u || group == 4u) {
        local_get(out, value);
        i64_const(out, width - 1u); byte(out, 0x88u);
        i64_const(out, 1u); byte(out, 0x83u);
        local_get(out, carry); byte(out, 0x85u);
    } else if (group == 1u) {
        local_get(out, value);
        i64_const(out, width - 1u); byte(out, 0x88u);
        local_get(out, value);
        i64_const(out, width - 2u); byte(out, 0x88u);
        byte(out, 0x85u);
        i64_const(out, 1u); byte(out, 0x83u);
    } else if (group == 5u) {
        local_get(out, source);
        i64_const(out, width - 1u); byte(out, 0x88u);
        i64_const(out, 1u); byte(out, 0x83u);
    } else if (group == 6u) {
        local_get(out, source); local_get(out, value); byte(out, 0x85u);
        i64_const(out, width - 1u); byte(out, 0x88u);
        i64_const(out, 1u); byte(out, 0x83u);
    } else {
        i64_const(out, 0u);
    }
}

static int emit_x86_shift_flags_lane(wasm_writer *out, const pl_plan *plan,
                                     const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 5u)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    if (arg[4].kind != PL_OPERAND_CONST) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u64 descriptor = arg[4].value;
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 group = (pl_u32)(descriptor >> 8u) & 7u;
    if ((width != 8u && width != 16u && width != 32u && width != 64u)
            || (group != 0u && group != 1u && group != 4u
                && group != 5u && group != 6u && group != 7u)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 scratch = direct_scratch(plan);
    pl_u32 source = scratch, shifted = scratch + 1u;
    pl_u32 amount = scratch + 2u, flags = scratch + 3u;
    pl_u32 carry = scratch + 4u;
    pl_u64 mask = lane_mask(width);
    stage_flag_operand(out, plan, arg[1], value_node, source, mask);
    stage_flag_operand(out, plan, arg[2], value_node, shifted, mask);
    (void)operand_i64(out, plan, arg[3], value_node);
    pl_u32 count_mask = ((group == 0u || group == 1u) && width < 32u)
                      ? width - 1u : width == 64u ? 63u : 31u;
    i64_const(out, count_mask); byte(out, 0x83u);
    local_set(out, amount);

    local_get(out, amount); byte(out, 0x50u); /* i64.eqz */
    byte(out, 0x04u); byte(out, 0x7eu);       /* if (result i64) */
    (void)operand_i64(out, plan, arg[0], value_node);
    byte(out, 0x05u);                         /* else */

    emit_shift_carry(out, group, width, source, shifted, amount);
    local_set(out, carry);
    if (group == 0u || group == 1u) {
        (void)operand_i64(out, plan, arg[0], value_node);
        local_set(out, flags);
    } else {
        emit_logic_flags(out, plan, arg[0], value_node,
                         width, shifted, flags);
    }
    local_get(out, flags); i64_const(out, ~1ull); byte(out, 0x83u);
    local_get(out, carry); byte(out, 0x84u);
    local_set(out, flags);

    local_get(out, flags); i64_const(out, ~(1ull << 11u)); byte(out, 0x83u);
    local_get(out, amount); i64_const(out, 1u); byte(out, 0x51u);
    byte(out, 0xadu);
    emit_shift_overflow(out, group, width, source, shifted, carry);
    byte(out, 0x83u);                  /* amount==1 & overflow */
    i64_const(out, 11u); byte(out, 0x86u);
    byte(out, 0x84u);
    local_set(out, flags);
    local_get(out, flags);
    byte(out, 0x0bu);                  /* end if */
    return out->status;
}

static int emit_x86_bit_flags_lane(wasm_writer *out, const pl_plan *plan,
                                   const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 4u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 width = (pl_u32)arg[3].value & 0x7fu;
    if ((width != 16u && width != 32u && width != 64u)
            || arg[3].value != width)
        goto malformed;
    (void)operand_i64(out, plan, arg[0], value_node);
    i64_const(out, ~1ull); byte(out, 0x83u);
    (void)operand_i64(out, plan, arg[1], value_node);
    i64_const(out, lane_mask(width)); byte(out, 0x83u);
    (void)operand_i64(out, plan, arg[2], value_node);
    i64_const(out, width - 1u); byte(out, 0x83u);
    byte(out, 0x88u);                  /* i64.shr_u */
    i64_const(out, 1u); byte(out, 0x83u);
    byte(out, 0x84u);                  /* i64.or */
    i64_const(out, 2u); byte(out, 0x84u);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_insert_lane(wasm_writer *out, const pl_plan *plan,
                            const pl_node *node, pl_u32 value_node,
                            pl_u32 bits)
{
    if (!argument_count(node, 3u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 width = (pl_u32)arg[2].value & 0xffu;
    pl_u32 offset = (pl_u32)(arg[2].value >> 8u) & 0xffu;
    if (!width || width > bits || offset > bits - width
            || arg[2].value != (pl_u64)(width | (offset << 8u)))
        goto malformed;
    pl_u64 field = lane_mask(width);
    pl_u64 selected = field << offset;
    (void)operand_i64(out, plan, arg[0], value_node);
    i64_const(out, ~selected); byte(out, 0x83u);
    (void)operand_i64(out, plan, arg[1], value_node);
    i64_const(out, field); byte(out, 0x83u);
    if (offset) {
        i64_const(out, offset); byte(out, 0x86u);
    }
    byte(out, 0x84u);
    if (bits == 32u) {
        i64_const(out, 0xffffffffu); byte(out, 0x83u);
    }
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_select_u32_lane(wasm_writer *out, const pl_plan *plan,
                                const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 3u)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    (void)operand_i64(out, plan, arg[0], value_node);
    (void)operand_i64(out, plan, arg[1], value_node);
    (void)operand_i64(out, plan, arg[2], value_node);
    i64_const(out, 0u); byte(out, 0x52u); /* condition i64.ne -> i32 */
    byte(out, 0x1bu);                  /* select */
    i64_const(out, 0xffffffffu); byte(out, 0x83u);
    return out->status;
}

static void emit_multiply_operand(wasm_writer *out, const pl_plan *plan,
                                  pl_operand operand, pl_u32 value_node,
                                  pl_u32 width, int signed_product)
{
    (void)operand_i64(out, plan, operand, value_node);
    i64_const(out, lane_mask(width)); byte(out, 0x83u);
    if (signed_product && width < 64u) {
        i64_const(out, 64u - width); byte(out, 0x86u);
        i64_const(out, 64u - width); byte(out, 0x87u);
    }
}

static int emit_mul_high_lane(wasm_writer *out, const pl_plan *plan,
                              const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 3u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 width = (pl_u32)arg[2].value & 0x7fu;
    int signed_product = (int)((arg[2].value >> 8u) & 1u);
    if ((width != 8u && width != 16u && width != 32u && width != 64u)
            || arg[2].value
               != (pl_u64)(width | ((pl_u32)signed_product << 8u)))
        goto malformed;

    if (width < 64u) {
        emit_multiply_operand(
            out, plan, arg[0], value_node, width, signed_product);
        emit_multiply_operand(
            out, plan, arg[1], value_node, width, signed_product);
        byte(out, 0x7eu);              /* i64.mul */
        i64_const(out, width);
        byte(out, signed_product ? 0x87u : 0x88u);
        i64_const(out, lane_mask(width)); byte(out, 0x83u);
        return out->status;
    }

    pl_u32 scratch = direct_scratch(plan);
    pl_u32 left = scratch, right = scratch + 1u;
    pl_u32 low = scratch + 2u, middle = scratch + 3u;
    pl_u32 carry = scratch + 4u;
    (void)operand_i64(out, plan, arg[0], value_node); local_set(out, left);
    (void)operand_i64(out, plan, arg[1], value_node); local_set(out, right);

    local_get(out, left); i64_const(out, 0xffffffffu); byte(out, 0x83u);
    local_get(out, right); i64_const(out, 0xffffffffu); byte(out, 0x83u);
    byte(out, 0x7eu); local_set(out, low);

    local_get(out, left); i64_const(out, 32u); byte(out, 0x88u);
    local_get(out, right); i64_const(out, 0xffffffffu); byte(out, 0x83u);
    byte(out, 0x7eu);
    local_get(out, low); i64_const(out, 32u); byte(out, 0x88u);
    byte(out, 0x7cu); local_set(out, middle);
    local_get(out, middle); i64_const(out, 32u); byte(out, 0x88u);
    local_set(out, carry);

    local_get(out, middle); i64_const(out, 0xffffffffu); byte(out, 0x83u);
    local_get(out, left); i64_const(out, 0xffffffffu); byte(out, 0x83u);
    local_get(out, right); i64_const(out, 32u); byte(out, 0x88u);
    byte(out, 0x7eu); byte(out, 0x7cu); local_set(out, middle);

    local_get(out, left); i64_const(out, 32u); byte(out, 0x88u);
    local_get(out, right); i64_const(out, 32u); byte(out, 0x88u);
    byte(out, 0x7eu);
    local_get(out, carry); byte(out, 0x7cu);
    local_get(out, middle); i64_const(out, 32u); byte(out, 0x88u);
    byte(out, 0x7cu);
    if (signed_product) {
        local_get(out, left); i64_const(out, 63u); byte(out, 0x88u);
        local_get(out, right); byte(out, 0x7eu); byte(out, 0x7du);
        local_get(out, right); i64_const(out, 63u); byte(out, 0x88u);
        local_get(out, left); byte(out, 0x7eu); byte(out, 0x7du);
    }
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_x86_mul_flags_lane(wasm_writer *out, const pl_plan *plan,
                                   const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 4u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 width = (pl_u32)arg[3].value & 0x7fu;
    pl_u32 signed_product = (pl_u32)(arg[3].value >> 8u) & 1u;
    if ((width != 8u && width != 16u && width != 32u && width != 64u)
            || arg[3].value != (pl_u64)(width | (signed_product << 8u)))
        goto malformed;
    pl_u64 mask = lane_mask(width);
    (void)operand_i64(out, plan, arg[0], value_node);
    i64_const(out, ~0x801ull); byte(out, 0x83u);
    i64_const(out, 2u); byte(out, 0x84u);
    (void)operand_i64(out, plan, arg[2], value_node);
    i64_const(out, mask); byte(out, 0x83u);
    if (signed_product) {
        (void)operand_i64(out, plan, arg[1], value_node);
        i64_const(out, 1ull << (width - 1u)); byte(out, 0x83u);
        i64_const(out, 0u); byte(out, 0x52u);
        byte(out, 0x04u); byte(out, 0x7eu); /* if result i64 */
        i64_const(out, mask);
        byte(out, 0x05u);
        i64_const(out, 0u);
        byte(out, 0x0bu);
    } else {
        i64_const(out, 0u);
    }
    byte(out, 0x52u);                  /* high != expected */
    byte(out, 0xadu);
    i64_const(out, 0x801u); byte(out, 0x7eu);
    byte(out, 0x84u);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_bit_address_lane(wasm_writer *out, const pl_plan *plan,
                                 const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 3u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 word_bits = (pl_u32)arg[2].value & 0x7fu;
    pl_u32 index_bits = (pl_u32)(arg[2].value >> 8u) & 0x7fu;
    if ((word_bits != 16u && word_bits != 32u && word_bits != 64u)
            || (index_bits != 16u && index_bits != 32u && index_bits != 64u)
            || arg[2].value != (pl_u64)(word_bits | (index_bits << 8u)))
        goto malformed;
    pl_u32 word_shift = word_bits == 16u ? 4u
                      : word_bits == 32u ? 5u : 6u;
    (void)operand_i64(out, plan, arg[0], value_node);
    (void)operand_i64(out, plan, arg[1], value_node);
    if (index_bits == 16u) {
        i64_const(out, 48u); byte(out, 0x86u); /* sign-extend low i16 */
        i64_const(out, 48u); byte(out, 0x87u);
    } else if (index_bits == 32u) {
        byte(out, 0xa7u);              /* i32.wrap_i64 */
        byte(out, 0xacu);              /* i64.extend_i32_s */
    }
    i64_const(out, word_shift); byte(out, 0x87u); /* i64.shr_s */
    i64_const(out, 1u << (word_shift - 3u)); byte(out, 0x7eu);
    byte(out, 0x7cu);                  /* i64.add */
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static pl_u32 compare_opcode(pl_u32 bits, pl_u32 operation)
{
    static const pl_u8 i32[] = {
        0x45u, 0x46u, 0x47u, 0x48u, 0x49u, 0x4au,
        0x4bu, 0x4cu, 0x4du, 0x4eu, 0x4fu,
    };
    static const pl_u8 i64[] = {
        0x50u, 0x51u, 0x52u, 0x53u, 0x54u, 0x55u,
        0x56u, 0x57u, 0x58u, 0x59u, 0x5au,
    };
    pl_u32 slot = operation - 39u;
    return bits == 32u ? i32[slot] : i64[slot];
}

static int emit_bswap_lane(wasm_writer *out, const pl_plan *plan,
                           const pl_node *node, pl_u32 value_node,
                           pl_u32 bits)
{
    if (!argument_count(node, 1u)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 scratch = direct_scratch(plan);
    const pl_operand *arg = arguments(plan, node);
    (void)operand_i64(out, plan, arg[0], value_node);
    if (bits == 32u) {
        i64_const(out, 0xffffffffu); byte(out, 0x83u);
    }
    local_set(out, scratch);

    local_get(out, scratch); i64_const(out, 0x00ff00ff00ff00ffull);
    byte(out, 0x83u); i64_const(out, 8u); byte(out, 0x86u);
    local_get(out, scratch); i64_const(out, 8u); byte(out, 0x88u);
    i64_const(out, 0x00ff00ff00ff00ffull); byte(out, 0x83u);
    byte(out, 0x84u); local_set(out, scratch);

    local_get(out, scratch); i64_const(out, 0x0000ffff0000ffffull);
    byte(out, 0x83u); i64_const(out, 16u); byte(out, 0x86u);
    local_get(out, scratch); i64_const(out, 16u); byte(out, 0x88u);
    i64_const(out, 0x0000ffff0000ffffull); byte(out, 0x83u);
    byte(out, 0x84u); local_set(out, scratch);

    if (bits == 64u) {
        local_get(out, scratch); i64_const(out, 32u); byte(out, 0x86u);
        local_get(out, scratch); i64_const(out, 32u); byte(out, 0x88u);
        byte(out, 0x84u);
    } else {
        local_get(out, scratch);
        i64_const(out, 0xffffffffu); byte(out, 0x83u);
    }
    return out->status;
}

static int divide_memory_prefix(const pl_plan *plan, pl_u32 value,
                                pl_u32 *memory_count)
{
    int status = direct_memory_count(plan, memory_count);
    if (status) return status;
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        pl_u32 opcode = plan->nodes[index].opcode;
        if (!direct_memory_opcode(opcode)) continue;
        if (index + 1u >= value
                || !((opcode >= 140u && opcode <= 151u)
                     || opcode == PL_OPCODE_MEMORY_LOAD_REGION))
            return PL_ERROR_WASM_UNSUPPORTED;
    }
    return 0;
}

static void emit_divide_fault(wasm_writer *out, pl_u32 block,
                              pl_u32 memory_count)
{
    if (memory_count) {
        local_get(out, 0u);
        block_coordinate(out, block);
        i32_const(out, memory_count);
        call(out, 7u);                 /* env.direct_memory_commit */
        byte(out, 0x1au);
        direct_memory_guard(out);
    }
    i64_const(out, pl_vm_result_make(PL_VM_FAULT, 0u));
    byte(out, 0x0fu);                  /* return the architectural #DE cut */
}

static int emit_divrem_lane(wasm_writer *out, const pl_plan *plan,
                            const pl_node *node, pl_u32 value_node,
                            pl_u32 block, pl_u32 bits, pl_u32 operation)
{
    if (!argument_count(node, 2u) || plan->instructions != 1u) {
        out->status = PL_ERROR_WASM_UNSUPPORTED;
        return out->status;
    }
    pl_u32 memory_count = 0u;
    int status = divide_memory_prefix(plan, value_node, &memory_count);
    if (status) {
        out->status = status;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    pl_u32 scratch = direct_scratch(plan);
    pl_u64 mask = lane_mask(bits);
    stage_flag_operand(out, plan, arg[0], value_node, scratch, mask);
    stage_flag_operand(out, plan, arg[1], value_node, scratch + 1u, mask);

    local_get(out, scratch + 1u); byte(out, 0x50u); /* divisor == zero */
    if (operation == 56u) {
        local_get(out, scratch); i64_const(out, 1ull << (bits - 1u));
        byte(out, 0x51u);              /* dividend == signed minimum */
        local_get(out, scratch + 1u); i64_const(out, mask);
        byte(out, 0x51u);              /* divisor == -1 */
        byte(out, 0x71u);              /* overflow pair */
        byte(out, 0x72u);              /* zero or overflow */
    }
    byte(out, 0x04u); byte(out, 0x40u);/* if invalid divisor */
    emit_divide_fault(out, block, memory_count);
    byte(out, 0x0bu);

    if (bits == 32u) {
        local_get(out, scratch); byte(out, 0xa7u);
        local_get(out, scratch + 1u); byte(out, 0xa7u);
        byte(out, binary_opcode(bits, operation));
        byte(out, 0xadu);              /* publish the modulo-32-bit result */
    } else {
        local_get(out, scratch);
        local_get(out, scratch + 1u);
        byte(out, binary_opcode(bits, operation));
    }
    return out->status;
}

static int emit_x86_divide_lane(wasm_writer *out, const pl_plan *plan,
                                const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 4u)) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    pl_u32 width = (pl_u32)arg[3].value & 0x7fu;
    pl_u32 signed_divide = ((pl_u32)arg[3].value >> 8u) & 1u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || arg[3].value != (pl_u64)(width | (signed_divide << 8u))) {
        out->status = PL_ERROR_WASM_ABI;
        return out->status;
    }
    local_get(out, 0u);
    (void)operand_i64(out, plan, arg[0], value_node);
    (void)operand_i64(out, plan, arg[1], value_node);
    (void)operand_i64(out, plan, arg[2], value_node);
    i64_const(out, arg[3].value);
    call(out, 8u); /* env.direct_x86_divide: primary result is #DE predicate */
    return out->status;
}

static int emit_x86_rotate_carry_lane(
        wasm_writer *out, const pl_plan *plan,
        const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 4u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 width = (pl_u32)arg[3].value & 0x7fu;
    pl_u32 right = ((pl_u32)arg[3].value >> 8u) & 1u;
    if ((width != 8u && width != 16u
            && width != 32u && width != 64u)
            || arg[3].value != (pl_u64)(width | (right << 8u)))
        goto malformed;
    pl_u32 result_local = 0u;
    int status = direct_alu_result_local(plan, value_node, &result_local);
    if (status) {
        out->status = status;
        return out->status;
    }
    pl_u32 scratch = direct_scratch(plan);
    local_get(out, 0u);
    (void)operand_i64(out, plan, arg[0], value_node);
    (void)operand_i64(out, plan, arg[1], value_node);
    (void)operand_i64(out, plan, arg[2], value_node);
    i64_const(out, arg[3].value);
    call(out, 11u); /* one vm.wasm physical rotate-carry lane -> flags */
    local_set(out, scratch);
    local_get(out, 0u);
    call(out, 12u); /* matching value projection */
    local_set(out, result_local);
    local_get(out, scratch);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static void emit_local_eqz_flag(wasm_writer *out, pl_u32 local, pl_u32 bit)
{
    local_get(out, local);
    byte(out, 0x50u);                  /* i64.eqz */
    byte(out, 0xadu);                  /* i64.extend_i32_u */
    if (bit) {
        i64_const(out, bit);
        byte(out, 0x86u);              /* i64.shl */
    }
}

static int emit_x86_bit_summary_lane(
        wasm_writer *out, const pl_plan *plan,
        const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 3u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 descriptor = (pl_u32)arg[2].value;
    pl_u32 width = descriptor & 0x7fu;
    pl_u32 mode = (descriptor >> 8u) & 7u;
    if ((width != 16u && width != 32u && width != 64u)
            || mode > 4u || descriptor != (width | (mode << 8u)))
        goto malformed;
    pl_u32 result_local = 0u;
    int status = direct_alu_result_local(plan, value_node, &result_local);
    if (status) {
        out->status = status;
        return out->status;
    }
    pl_u32 source_local = direct_scratch(plan);
    (void)operand_i64(out, plan, arg[1], value_node);
    if (width < 64u) {
        i64_const(out, (1ull << width) - 1u);
        byte(out, 0x83u);              /* i64.and */
    }
    local_set(out, source_local);

    local_get(out, source_local);
    if (mode == 0u) {                  /* BSR = ~LZCNT & (width - 1) */
        byte(out, 0x79u);              /* i64.clz */
        if (width < 64u) {
            i64_const(out, 64u - width);
            byte(out, 0x7du);          /* i64.sub */
        }
        i64_const(out, ~0ull);
        byte(out, 0x85u);              /* i64.xor */
        i64_const(out, width - 1u);
        byte(out, 0x83u);              /* i64.and */
    } else if (mode == 1u || mode == 2u) {
        if (width < 64u) {
            i64_const(out, 1ull << width);
            byte(out, 0x84u);          /* sentinel makes ctz(0) == width */
        }
        byte(out, 0x7au);              /* i64.ctz */
    } else if (mode == 3u) {
        byte(out, 0x79u);              /* i64.clz */
        if (width < 64u) {
            i64_const(out, 64u - width);
            byte(out, 0x7du);          /* i64.sub */
        }
    } else {
        byte(out, 0x7bu);              /* i64.popcnt */
    }
    local_set(out, result_local);

    (void)operand_i64(out, plan, arg[0], value_node);
    i64_const(out, mode < 2u ? ~(1ull << 6u)
                  : mode < 4u ? ~0x41ull : ~0x8d5ull);
    byte(out, 0x83u);                  /* preserve non-defined RFLAGS */
    if (mode < 2u) {
        emit_local_eqz_flag(out, source_local, 6u);
        byte(out, 0x84u);
    } else if (mode < 4u) {
        emit_local_eqz_flag(out, source_local, 0u);
        byte(out, 0x84u);
        emit_local_eqz_flag(out, result_local, 6u);
        byte(out, 0x84u);
    } else {
        emit_local_eqz_flag(out, result_local, 6u);
        byte(out, 0x84u);
    }
    i64_const(out, 2u);
    byte(out, 0x84u);                  /* architectural reserved bit */
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_x86_double_shift_lane(
        wasm_writer *out, const pl_plan *plan,
        const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 5u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[4].kind != PL_OPERAND_CONST) goto malformed;
    pl_u32 descriptor = (pl_u32)arg[4].value;
    pl_u32 width = descriptor & 0x7fu;
    pl_u32 right = (descriptor >> 8u) & 1u;
    if ((width != 16u && width != 32u && width != 64u)
            || descriptor != (width | (right << 8u)))
        goto malformed;
    pl_u32 result_local = 0u;
    int status = direct_alu_result_local(plan, value_node, &result_local);
    if (status) {
        out->status = status;
        return out->status;
    }
    pl_u64 mask = width == 64u ? ~0ull : (1ull << width) - 1u;
    pl_u32 scratch = direct_scratch(plan);
    pl_u32 destination = scratch, source = scratch + 1u;
    pl_u32 amount = scratch + 2u, flags = scratch + 3u;
    pl_u32 effective = scratch + 4u;
    stage_flag_operand(out, plan, arg[1], value_node, destination, mask);
    stage_flag_operand(out, plan, arg[2], value_node, source, mask);
    (void)operand_i64(out, plan, arg[3], value_node);
    i64_const(out, width == 64u ? 63u : 31u);
    byte(out, 0x83u);                  /* architectural count mask */
    local_set(out, amount);
    local_get(out, amount);
    if (width == 16u) {
        i64_const(out, 1u); byte(out, 0x7du);
        i64_const(out, 15u); byte(out, 0x83u);
        i64_const(out, 1u); byte(out, 0x7cu);
    }
    local_set(out, effective);

    local_get(out, amount); i64_const(out, 0u); byte(out, 0x52u);
    byte(out, 0x04u); byte(out, 0x7eu);/* if amount != 0 -> i64 */
    if (right) {
        local_get(out, destination); local_get(out, effective);
        byte(out, 0x88u);              /* destination >> amount */
        local_get(out, source); i64_const(out, width);
        local_get(out, effective); byte(out, 0x7du);
        byte(out, 0x86u);              /* source << (width - amount) */
    } else {
        local_get(out, destination); local_get(out, effective);
        byte(out, 0x86u);              /* destination << amount */
        local_get(out, source); i64_const(out, width);
        local_get(out, effective); byte(out, 0x7du);
        byte(out, 0x88u);              /* source >> (width - amount) */
    }
    byte(out, 0x84u);                  /* join the two quotient limbs */
    if (mask != ~0ull) {
        i64_const(out, mask); byte(out, 0x83u);
    }
    byte(out, 0x05u);                  /* else: count zero is identity */
    local_get(out, destination);
    byte(out, 0x0bu);
    local_set(out, result_local);

    local_get(out, amount); i64_const(out, 0u); byte(out, 0x52u);
    byte(out, 0x04u); byte(out, 0x7eu);/* if amount != 0 -> flags */
    emit_logic_flags(
        out, plan, arg[0], value_node, width, result_local, flags);
    local_get(out, destination);
    if (right) {
        local_get(out, effective); i64_const(out, 1u); byte(out, 0x7du);
    } else {
        i64_const(out, width); local_get(out, effective); byte(out, 0x7du);
    }
    byte(out, 0x88u); i64_const(out, 1u); byte(out, 0x83u);
    or_staged_flag(out, flags);         /* carry */

    local_get(out, destination); local_get(out, result_local);
    byte(out, 0x85u); i64_const(out, width - 1u); byte(out, 0x88u);
    i64_const(out, 1u); byte(out, 0x83u);
    local_get(out, amount); i64_const(out, 1u); byte(out, 0x51u);
    byte(out, 0xadu); byte(out, 0x83u);
    i64_const(out, 11u); byte(out, 0x86u);
    or_staged_flag(out, flags);         /* sign change when count == 1 */
    local_get(out, flags);
    byte(out, 0x05u);
    (void)operand_i64(out, plan, arg[0], value_node);
    byte(out, 0x0bu);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_x86_crc32_lane(wasm_writer *out, const pl_plan *plan,
                               const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 3u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[2].kind != PL_OPERAND_CONST
            || (arg[2].value != 8u && arg[2].value != 16u
                && arg[2].value != 32u && arg[2].value != 64u))
        goto malformed;
    (void)operand_i64(out, plan, arg[0], value_node);
    (void)operand_i64(out, plan, arg[1], value_node);
    i64_const(out, arg[2].value);
    call(out, 15u);                    /* one shared vm.wasm CRC32C lane */
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_x86_bzhi_lane(wasm_writer *out, const pl_plan *plan,
                              const pl_node *node, pl_u32 value_node)
{
    if (!argument_count(node, 4u)) goto malformed;
    const pl_operand *arg = arguments(plan, node);
    if (arg[3].kind != PL_OPERAND_CONST
            || (arg[3].value != 32u && arg[3].value != 64u))
        goto malformed;
    pl_u32 width = (pl_u32)arg[3].value;
    pl_u32 result = 0u;
    int status = direct_alu_result_local(plan, value_node, &result);
    if (status) {
        out->status = status;
        return out->status;
    }
    pl_u32 index = direct_scratch(plan);
    pl_u32 flags = index + 1u;
    (void)operand_i64(out, plan, arg[2], value_node);
    i64_const(out, 0xffu); byte(out, 0x83u);
    local_set(out, index);

    local_get(out, index); i64_const(out, width); byte(out, 0x54u);
    byte(out, 0x04u); byte(out, 0x7eu);/* if index < width -> i64 */
    (void)operand_i64(out, plan, arg[1], value_node);
    i64_const(out, 1u); local_get(out, index); byte(out, 0x86u);
    i64_const(out, 1u); byte(out, 0x7du);
    byte(out, 0x83u);                  /* source & ((1 << index) - 1) */
    byte(out, 0x05u);
    (void)operand_i64(out, plan, arg[1], value_node);
    byte(out, 0x0bu);
    if (width == 32u) {
        i64_const(out, 0xffffffffu); byte(out, 0x83u);
    }
    local_set(out, result);

    emit_logic_flags(out, plan, arg[0], value_node, width, result, flags);
    local_get(out, flags);
    local_get(out, index); i64_const(out, width); byte(out, 0x5au);
    byte(out, 0xadu);                  /* CF := index >= operand width */
    byte(out, 0x84u);
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static int emit_lane(wasm_writer *out, const pl_plan *plan,
                     const pl_node *node, pl_u32 value, pl_u32 block)
{
    if (node->opcode == PL_OPCODE_MEMORY_LOAD_REGION)
        return emit_memory_region(out, plan, node, value, block);
    if (node->opcode == PL_OPCODE_MEMORY_REPEAT)
        return emit_memory_repeat(out, plan, node, value, block);
    if (node->opcode == PL_OPCODE_MEMORY_COPY)
        return emit_memory_copy(out, plan, node, value, block);
    if (node->opcode == PL_OPCODE_MEMORY_FIND2)
        return emit_memory_find2(out, plan, node, value, block);
    if (node->opcode == PL_OPCODE_MEMORY_STORE_IF)
        return emit_memory_store_if(out, plan, node, value, block);
    if (node->opcode == PL_OPCODE_MEMORY_FRAME)
        return emit_memory_frame(out, plan, node, value, block);
    if ((node->opcode >= 140u && node->opcode <= 158u)
            || node->opcode == PL_OPCODE_MEMORY_PRE_STORE)
        return emit_memory_lane(out, plan, node, value, block);
    if (node->opcode == PL_OPCODE_X86_BIT_FLAGS)
        return emit_x86_bit_flags_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_SHIFT_FLAGS)
        return emit_x86_shift_flags_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_ROTATE_CARRY)
        return emit_x86_rotate_carry_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_BIT_SUMMARY)
        return emit_x86_bit_summary_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_DOUBLE_SHIFT)
        return emit_x86_double_shift_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_CRC32)
        return emit_x86_crc32_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_BZHI)
        return emit_x86_bzhi_lane(out, plan, node, value);
    if (direct_flag_opcode(node->opcode))
        return emit_x86_flag_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_CONDITION)
        return emit_x86_condition_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_TEST_CONDITION)
        return emit_x86_test_condition_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_LANE64_INSERT)
        return emit_insert_lane(out, plan, node, value, 64u);
    if (node->opcode == PL_OPCODE_LANE32_INSERT)
        return emit_insert_lane(out, plan, node, value, 32u);
    if (node->opcode == PL_OPCODE_SELECT_U32)
        return emit_select_u32_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_MUL_HIGH)
        return emit_mul_high_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_MUL_FLAGS)
        return emit_x86_mul_flags_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_X86_DIVIDE)
        return emit_x86_divide_lane(out, plan, node, value);
    if (node->opcode == PL_OPCODE_BIT_ADDRESS)
        return emit_bit_address_lane(out, plan, node, value);
    if (node->opcode >= 140u) {
        out->status = PL_ERROR_WASM_UNSUPPORTED;
        return out->status;
    }
    pl_u32 bits = node->opcode < 70u ? 32u : 64u;
    pl_u32 operation = node->opcode % 70u;
    const pl_operand *arg = arguments(plan, node);
    pl_u32 opcode = binary_opcode(bits, operation);

    if (operation_traps_in_wasm(operation))
        return emit_divrem_lane(
            out, plan, node, value, block, bits, operation);
    if (operation == 14u)
        return emit_bswap_lane(out, plan, node, value, bits);
    if (opcode) {
        if (!argument_count(node, 2u)) goto malformed;
        width_argument(out, plan, arg[0], value, bits);
        width_argument(out, plan, arg[1], value, bits);
        byte(out, opcode);
        publish_width(out, bits);
        return out->status;
    }
    if (operation == 15u || operation == 27u || operation == 28u) {
        if (!argument_count(node, 1u)) goto malformed;
        width_argument(out, plan, arg[0], value, bits);
        byte(out, operation == 15u ? (bits == 32u ? 0x69u : 0x7bu)
                 : operation == 27u ? (bits == 32u ? 0x67u : 0x79u)
                                    : (bits == 32u ? 0x68u : 0x7au));
        publish_width(out, bits);
        return out->status;
    }
    if (operation >= 39u && operation <= 49u) {
        pl_u32 count = operation == 39u ? 1u : 2u;
        if (!argument_count(node, count)) goto malformed;
        width_argument(out, plan, arg[0], value, bits);
        if (count == 2u) width_argument(out, plan, arg[1], value, bits);
        byte(out, compare_opcode(bits, operation));
        byte(out, 0xadu); /* comparison i32 -> canonical u64 publication */
        return out->status;
    }
    if (operation == 11u || operation == 25u) {
        if (!argument_count(node, 1u)) goto malformed;
        if (operation == 25u) {
            if (bits == 32u) i32_const(out, 0u);
            else i64_const(out, 0u);
        }
        width_argument(out, plan, arg[0], value, bits);
        if (operation == 11u) {
            if (bits == 32u) i32_const(out, 0xffffffffu);
            else i64_const(out, ~0ull);
            byte(out, bits == 32u ? 0x73u : 0x85u);
        } else {
            byte(out, bits == 32u ? 0x6bu : 0x7du);
        }
        publish_width(out, bits);
        return out->status;
    }
    if (operation == 20u || operation == 23u) {
        if (!argument_count(node, 2u)) goto malformed;
        if (operation == 20u) {
            width_argument(out, plan, arg[0], value, bits);
            if (bits == 32u) i32_const(out, 0xffffffffu);
            else i64_const(out, ~0ull);
            byte(out, bits == 32u ? 0x73u : 0x85u);
            width_argument(out, plan, arg[1], value, bits);
            byte(out, bits == 32u ? 0x71u : 0x83u);
        } else {
            width_argument(out, plan, arg[0], value, bits);
            width_argument(out, plan, arg[0], value, bits);
            width_argument(out, plan, arg[1], value, bits);
            byte(out, bits == 32u ? 0x74u : 0x86u);
            byte(out, bits == 32u ? 0x73u : 0x85u);
        }
        publish_width(out, bits);
        return out->status;
    }
    if (operation == 32u) {
        if (!argument_count(node, 3u)) goto malformed;
        width_argument(out, plan, arg[0], value, bits);
        width_argument(out, plan, arg[1], value, bits);
        width_argument(out, plan, arg[2], value, 32u);
        byte(out, 0x1bu); /* select */
        publish_width(out, bits);
        return out->status;
    }
    if (operation == 60u || operation == 61u) {
        if (!argument_count(node, 2u)) goto malformed;
        width_argument(out, plan, arg[0], value, bits);
        width_argument(out, plan, arg[1], value, bits);
        byte(out, bits == 32u ? 0x76u : 0x88u); /* unsigned shift */
        if (bits == 32u) i32_const(out, 1u);
        else i64_const(out, 1u);
        byte(out, bits == 32u ? 0x71u : 0x83u);
        if (operation == 61u) {
            if (bits == 32u) i32_const(out, 1u);
            else i64_const(out, 1u);
            byte(out, bits == 32u ? 0x73u : 0x85u);
        }
        publish_width(out, bits);
        return out->status;
    }
    if (operation == 33u || operation == 34u || operation == 35u
            || operation == 36u || operation == 37u || operation == 38u) {
        if (!argument_count(node, 1u)) goto malformed;
        (void)operand_i64(out, plan, arg[0], value);
        if (operation == 33u) {
            byte(out, 0xa7u); byte(out, 0xadu);
        } else if (operation == 34u || operation == 35u) {
            if (bits != 64u) goto unsupported;
            byte(out, 0xa7u);
            byte(out, operation == 34u ? 0xacu : 0xadu);
        } else {
            if (bits == 32u) byte(out, 0xa7u);
            if (operation != 38u || bits == 64u)
                byte(out, operation == 36u ? (bits == 32u ? 0xc0u : 0xc2u)
                         : operation == 37u ? (bits == 32u ? 0xc1u : 0xc3u)
                                            : 0xc4u);
            if (bits == 32u) byte(out, 0xadu);
        }
        return out->status;
    }
    if (operation == 64u) {
        if (!argument_count(node, 3u)) goto malformed;
        width_argument(out, plan, arg[0], value, bits);
        width_argument(out, plan, arg[1], value, bits);
        byte(out, bits == 32u ? 0x6au : 0x7cu);
        width_argument(out, plan, arg[2], value, bits);
        byte(out, bits == 32u ? 0x6au : 0x7cu);
        publish_width(out, bits);
        return out->status;
    }

unsupported:
    out->status = PL_ERROR_WASM_UNSUPPORTED;
    return out->status;
malformed:
    out->status = PL_ERROR_WASM_ABI;
    return out->status;
}

static void output_value(wasm_writer *out, const pl_plan *plan,
                         pl_operand operand)
{
    (void)operand_i64(out, plan, operand, plan->node_count + 1u);
}

static void publish_local(wasm_writer *out, const pl_plan *plan,
                          pl_u32 coordinate, pl_operand operand)
{
    if (operand.kind == PL_OPERAND_LOCAL && operand.value == coordinate)
        return;
    if (coordinate >= PL_VM_X86_ARCH_LOCAL_COUNT) return;
    if (coordinate < PL_VM_X86_REGISTER_COUNT) {
        state_address(out);
        i32_load(out, 2u, PL_VM_X86_WASM32_OFF_REGISTERS);
        output_value(out, plan, operand);
        i64_store(out, coordinate * 8u);
    } else if (coordinate == PL_VM_X86_RFLAGS_LOCAL) {
        state_address(out);
        output_value(out, plan, operand);
        i64_store(out, PL_VM_X86_WASM32_OFF_RFLAGS);
    }
}

static void add_state_counter(wasm_writer *out, pl_u32 offset, pl_u64 amount)
{
    if (!amount) return;
    state_address(out);
    state_address(out);
    i64_load(out, offset);
    i64_const(out, amount);
    byte(out, 0x7cu); /* i64.add */
    i64_store(out, offset);
}

static void add_recurrence_retired(wasm_writer *out,
                                   const pl_wasm_block *block)
{
    const pl_plan *plan = block->plan;
    state_address(out);
    state_address(out);
    i64_load(out, PL_VM_X86_WASM32_OFF_RETIRED);
    output_value(out, plan, plan->locals[block->recurrence_local]);
    if (block->recurrence_bits == 32u) {
        byte(out, 0xa7u);              /* i32.wrap_i64 */
        byte(out, 0xadu);              /* i64.extend_i32_u */
    }
    i64_const(out, block->recurrence_source_instructions);
    byte(out, 0x7eu);                  /* i64.mul */
    byte(out, 0x7cu);                  /* i64.add */
    i64_store(out, PL_VM_X86_WASM32_OFF_RETIRED);
}

static pl_u32 direct_x86_divide_node(const pl_plan *plan)
{
    pl_u32 found = 0u;
    for (pl_u32 value = 1u; value <= plan->node_count; ++value) {
        if (plan->nodes[value - 1u].opcode != PL_OPCODE_X86_DIVIDE) continue;
        if (found) return 0xffffffffu;
        found = value;
    }
    return found;
}

static void emit_fault_guard(wasm_writer *out, const pl_plan *plan,
                             const pl_wasm_block *block)
{
    if (!block->has_fault_predicate) return;
    output_value(out, plan, block->fault_predicate);
    i64_const(out, 0u);
    byte(out, 0x52u);                  /* i64.ne */
    byte(out, 0x04u); byte(out, 0x40u);/* if, empty block type */
    i64_const(out, pl_vm_result_make(PL_VM_FAULT, block->fault_vector));
    byte(out, 0x0fu);                  /* return before state publication */
    byte(out, 0x0bu);                  /* end if */
}

static int emit_machine_operation(wasm_writer *out, const pl_plan *plan,
                                  const pl_wasm_block *block)
{
    if (block->machine_operation == PL_X86_MACHINE_NONE) return 0;
    if (block->machine_operation == PL_X86_MACHINE_FAR_RETURN) {
        /* FAR_RETURN owns RIP/RSP/CS as one restartable architectural cut.
         * No speculative SSA local is published around it.  Cold stack/GDT
         * pages return the same direct-memory barrier token; an admitted
         * transfer resumes through the total RIP projection. */
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);             /* reserved ABI word */
        call(out, 17u);                 /* env.direct_x86_far_return */
        byte(out, 0x45u);               /* i32.eqz */
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u);
        call(out, 1u);                  /* precise fault or delivery barrier */
        byte(out, 0x0fu);
        byte(out, 0x0bu);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_RETIRED,
                          plan->instructions);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_WORK, plan->node_count);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_SPAN, plan->span);
        i64_const(out, pl_vm_result_make(PL_VM_RESOLVE_RIP, 0u));
        byte(out, 0x0fu);
        return 1;
    }
    if (block->machine_operation == PL_X86_MACHINE_SYSTEM_TRANSFER) {
        if (block->machine_argument > 4u) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, block->next_rip); /* architectural fallthrough */
        call(out, 29u);                /* env.direct_x86_system_transfer */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_RETIRED,
                          plan->instructions);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_WORK, plan->node_count);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_SPAN, plan->span);
        i64_const(out, pl_vm_result_make(PL_VM_RESOLVE_RIP, 0u));
        byte(out, 0x0fu);
        return 1;
    }
    if (block->machine_operation == PL_X86_MACHINE_INTERRUPT_RETURN) {
        if (block->machine_argument != 16u
                && block->machine_argument != 32u
                && block->machine_argument != 64u) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);
        call(out, 30u);                /* env.direct_x86_interrupt_return */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_RETIRED,
                          plan->instructions);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_WORK, plan->node_count);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_SPAN, plan->span);
        i64_const(out, pl_vm_result_make(PL_VM_RESOLVE_RIP, 0u));
        byte(out, 0x0fu);
        return 1;
    }
    if (block->machine_operation == PL_X86_MACHINE_WRITE_CONTROL) {
        pl_u32 control = (pl_u32)block->machine_argument & 0xffu;
        pl_u32 source = (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        if (block->machine_argument != (control | ((pl_u64)source << 8u))
                || source >= PL_VM_X86_REGISTER_COUNT) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, control);
        output_value(out, plan, plan->locals[source]);
        call(out, 18u);                /* env.direct_x86_write_control */
        byte(out, 0x45u);              /* i32.eqz */
        return_if(out, pl_vm_result_make(PL_VM_FAULT, 13u));
        return 0;
    }
    if (block->machine_operation == PL_X86_MACHINE_READ_CONTROL) {
        pl_u32 control = (pl_u32)block->machine_argument & 0xffu;
        pl_u32 target = (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        if (block->machine_argument != (control | ((pl_u64)target << 8u))
                || target >= PL_VM_X86_REGISTER_COUNT) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, control);
        i64_const(out, target);
        call(out, 19u);                /* env.direct_x86_read_control */
        byte(out, 0x45u);
        return_if(out, pl_vm_result_make(PL_VM_FAULT, 13u));
        return 2;                      /* helper published the destination */
    }
    if (block->machine_operation == PL_X86_MACHINE_WRITE_SEGMENT) {
        pl_u32 segment = (pl_u32)block->machine_argument & 0xffu;
        pl_u32 source = (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        pl_u32 memory = (pl_u32)(block->machine_argument >> 16u) & 1u;
        pl_u32 far_load = (pl_u32)(block->machine_argument >> 17u) & 1u;
        pl_u32 target = (pl_u32)(block->machine_argument >> 24u) & 0xffu;
        pl_u32 width = (pl_u32)(block->machine_argument >> 32u) & 0xffu;
        if (block->machine_argument != (segment | ((pl_u64)source << 8u)
                    | ((pl_u64)memory << 16u)
                    | ((pl_u64)far_load << 17u)
                    | ((pl_u64)target << 24u)
                    | ((pl_u64)width << 32u))
                || (!memory && source >= PL_VM_X86_REGISTER_COUNT)
                || (memory && source)
                || (far_load && (!memory
                    || target >= PL_VM_X86_REGISTER_COUNT
                    || (width != 32u && width != 64u)))
                || (!far_load && (target || width))) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        if (memory) output_value(out, plan, block->machine_value);
        else output_value(out, plan, plan->locals[source]);
        call(out, 20u);                /* env.direct_x86_write_segment */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return far_load ? 2 : 0;       /* helper also published target GPR */
    }
    if (block->machine_operation == PL_X86_MACHINE_DESCRIPTOR_TABLE) {
        if (block->machine_argument > 3u) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        output_value(out, plan, block->machine_value);
        i64_const(out, block->machine_argument);
        call(out, 21u);                /* env.direct_x86_descriptor_table */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 0;
    }
    if (block->machine_operation == PL_X86_MACHINE_POP_FLAGS) {
        if (block->machine_argument != 16u
                && block->machine_argument != 64u) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);            /* reserved ABI word */
        call(out, 22u);                /* env.direct_x86_pop_flags */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* helper published RSP and RFLAGS */
    }
    if (block->machine_operation == PL_X86_MACHINE_READ_MSR) {
        local_get(out, 0u);
        output_value(out, plan, plan->locals[1u]);
        i64_const(out, 0u);            /* reserved ABI word */
        call(out, 23u);                /* env.direct_x86_read_msr */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* helper published EDX:EAX */
    }
    if (block->machine_operation == PL_X86_MACHINE_CPUID) {
        local_get(out, 0u);
        i64_const(out, 0u); i64_const(out, 0u);
        call(out, 24u);                /* env.direct_x86_cpuid */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* helper published EAX:EDX */
    }
    if (block->machine_operation == PL_X86_MACHINE_INTERRUPT_FLAG) {
        if (block->machine_argument > 1u) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument); i64_const(out, 0u);
        call(out, 25u);                /* env.direct_x86_interrupt_flag */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* helper published RFLAGS.IF */
    }
    if (block->machine_operation == PL_X86_MACHINE_PORT_IO) {
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);
        call(out, 26u);                /* env.direct_x86_port_io */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* helper published RAX for IN */
    }
    if (block->machine_operation == PL_X86_MACHINE_SWAP_GS) {
        if (block->machine_argument) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, 0u); i64_const(out, 0u);
        call(out, 27u);                /* env.direct_x86_swap_gs */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* helper exchanged canonical MSRs */
    }
    if (block->machine_operation == PL_X86_MACHINE_HALT) {
        if (block->machine_argument) out->status = PL_ERROR_WASM_ABI;
        /* The normal epilogue retires HLT and publishes its fallthrough RIP;
         * PL_VM_HALT then makes that complete cut dormant until a C event. */
        return 0;
    }
    if (block->machine_operation == PL_X86_MACHINE_INVALIDATE_PAGE) {
        local_get(out, 0u);
        output_value(out, plan, block->machine_value);
        i64_const(out, 0u);
        call(out, 28u);                /* env.direct_x86_invalidate_page */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* C invalidated the translation cut */
    }
    if (block->machine_operation == PL_X86_MACHINE_ATOMIC) {
        local_get(out, 0u);
        output_value(out, plan, block->machine_value);
        i64_const(out, block->machine_argument);
        call(out, 31u);                /* env.direct_x86_atomic */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* C published memory/register cut */
    }
    if (block->machine_operation == PL_X86_MACHINE_VECTOR) {
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        if (((block->machine_argument >> 24u) & 3u)
                || (block->machine_argument & 0xffu) == 33u)
            output_value(out, plan, block->machine_value);
        else i64_const(out, 0u);
        call(out, 32u);                /* env.direct_x86_vector */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* C published one physical XMM cut */
    }
    if (block->machine_operation == PL_X86_MACHINE_READ_SELECTOR) {
        local_get(out, 0u);
        output_value(out, plan, block->machine_value);
        i64_const(out, block->machine_argument);
        call(out, 33u);                /* env.direct_x86_read_selector */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;                      /* C published GPR or memory selector */
    }
    if (block->machine_operation == PL_X86_MACHINE_SOFTWARE_INTERRUPT) {
        if (block->machine_argument > 0xffu) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, block->next_rip);
        call(out, 34u);                /* env.direct_x86_software_interrupt */
        byte(out, 0x1au);              /* helper returns only through fault cut */
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu);
        return 1;
    }
    if (block->machine_operation == PL_X86_MACHINE_FAR_TRANSFER) {
        local_get(out, 0u);
        output_value(out, plan, block->machine_value);
        i64_const(out, block->machine_argument);
        i64_const(out, block->next_rip);
        call(out, 35u);                /* env.direct_x86_far_transfer */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_RETIRED,
                          plan->instructions);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_WORK, plan->node_count);
        add_state_counter(out, PL_VM_X86_WASM32_OFF_SPAN, plan->span);
        i64_const(out, pl_vm_result_make(PL_VM_RESOLVE_RIP, 0u));
        byte(out, 0x0fu);
        return 1;
    }
    if (block->machine_operation == PL_X86_MACHINE_X87) {
        local_get(out, 0u);
        output_value(out, plan, block->machine_value);
        i64_const(out, block->machine_argument);
        call(out, 36u);                /* env.direct_x86_x87 */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_TIME) {
        if (block->machine_argument > 2u) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);
        call(out, 37u);                /* env.direct_x86_time */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_VALIDATE_SELECTOR) {
        pl_u32 write = (pl_u32)block->machine_argument & 1u;
        pl_u32 memory = (pl_u32)(block->machine_argument >> 1u) & 1u;
        pl_u32 source = (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        if (block->machine_argument != (write | ((pl_u64)memory << 1u)
                    | ((pl_u64)source << 8u))
                || (memory ? source != 0u
                           : source >= PL_VM_X86_REGISTER_COUNT)) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        if (memory) output_value(out, plan, block->machine_value);
        else output_value(out, plan, plan->locals[source]);
        i64_const(out, block->machine_argument);
        call(out, 38u);                /* env.direct_x86_validate_selector */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_STRING) {
        pl_u32 width = (pl_u32)block->machine_argument & 0xffu;
        pl_u32 address_bits =
            (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        pl_u32 segment =
            (pl_u32)(block->machine_argument >> 16u) & 0xffu;
        pl_u32 kind =
            (pl_u32)(block->machine_argument >> 24u) & 7u;
        pl_u32 not_equal =
            (pl_u32)(block->machine_argument >> 27u) & 1u;
        if ((width != 1u && width != 2u && width != 4u && width != 8u)
                || (address_bits != 32u && address_bits != 64u)
                || segment > 5u
                || (kind != 0u && kind != 2u
                    && kind != 3u && kind != 4u)
                || (kind == 4u && segment)
                || (not_equal && kind != 3u && kind != 4u)
                || block->machine_argument != (width
                    | ((pl_u64)address_bits << 8u)
                    | ((pl_u64)segment << 16u)
                    | ((pl_u64)kind << 24u)
                    | ((pl_u64)not_equal << 27u))) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);
        call(out, 39u);                /* env.direct_x86_string */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_MEMORY_ORDER) {
        if (block->machine_argument > 7u) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        if (block->machine_argument == 4u
                || block->machine_argument == 7u)
            output_value(out, plan, block->machine_value);
        else i64_const(out, 0u);
        i64_const(out, block->machine_argument);
        call(out, 40u);                /* env.direct_x86_memory_order */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_DEBUG_REGISTER) {
        pl_u32 write = (pl_u32)block->machine_argument & 1u;
        pl_u32 debug = (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        pl_u32 reg = (pl_u32)(block->machine_argument >> 16u) & 0xffu;
        if (debug >= 8u || reg >= PL_VM_X86_REGISTER_COUNT
                || block->machine_argument != (write
                    | ((pl_u64)debug << 8u) | ((pl_u64)reg << 16u))) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);
        call(out, 41u);                /* env.direct_x86_debug_register */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_SYSTEM_SELECTOR) {
        pl_u32 kind = (pl_u32)block->machine_argument & 0xffu;
        pl_u32 memory = (pl_u32)(block->machine_argument >> 8u) & 1u;
        pl_u32 source = (pl_u32)(block->machine_argument >> 16u) & 0xffu;
        pl_u32 target = (pl_u32)(block->machine_argument >> 24u) & 0xffu;
        pl_u32 width = (pl_u32)(block->machine_argument >> 32u) & 0xffu;
        if (kind > 3u || (memory ? source : source >= PL_VM_X86_REGISTER_COUNT)
                || (kind < 2u
                    ? (target >= PL_VM_X86_REGISTER_COUNT
                       || (width != 32u && width != 64u))
                    : (target || width))
                || block->machine_argument != (kind
                    | ((pl_u64)memory << 8u)
                    | ((pl_u64)source << 16u)
                    | ((pl_u64)target << 24u)
                    | ((pl_u64)width << 32u))) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        if (memory) output_value(out, plan, block->machine_value);
        else output_value(out, plan, plan->locals[source]);
        i64_const(out, block->machine_argument);
        call(out, 42u);                /* env.direct_x86_system_selector */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_CR0_STATUS) {
        pl_u32 kind = (pl_u32)block->machine_argument & 0xffu;
        pl_u32 memory = (pl_u32)(block->machine_argument >> 8u) & 1u;
        pl_u32 source = (pl_u32)(block->machine_argument >> 16u) & 0xffu;
        if (kind > 1u || (kind ? (memory || source)
                                  : (memory ? source != 0u
                                            : source >= PL_VM_X86_REGISTER_COUNT))
                || block->machine_argument != (kind
                    | ((pl_u64)memory << 8u)
                    | ((pl_u64)source << 16u))) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        if (kind) i64_const(out, 0u);
        else if (memory) output_value(out, plan, block->machine_value);
        else output_value(out, plan, plan->locals[source]);
        i64_const(out, block->machine_argument);
        call(out, 43u);                /* env.direct_x86_cr0_status */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_SEGMENT_STACK) {
        pl_u32 pop = (pl_u32)block->machine_argument & 1u;
        pl_u32 segment = (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        pl_u32 width = (pl_u32)(block->machine_argument >> 16u) & 0xffu;
        if ((segment != 4u && segment != 5u)
                || (width != 16u && width != 64u)
                || block->machine_argument != (pop
                    | ((pl_u64)segment << 8u)
                    | ((pl_u64)width << 16u))) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);
        call(out, 44u);                /* env.direct_x86_segment_stack */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation == PL_X86_MACHINE_ENTROPY) {
        pl_u32 target = (pl_u32)block->machine_argument & 0xffu;
        pl_u32 bits = (pl_u32)(block->machine_argument >> 8u) & 0xffu;
        pl_u32 source = (pl_u32)(block->machine_argument >> 16u) & 1u;
        if (target >= PL_VM_X86_REGISTER_COUNT
                || (bits != 16u && bits != 32u && bits != 64u)
                || block->machine_argument
                   != (target | ((pl_u64)bits << 8u)
                      | ((pl_u64)source << 16u))) {
            out->status = PL_ERROR_WASM_ABI;
            return 0;
        }
        local_get(out, 0u);
        i64_const(out, block->machine_argument);
        i64_const(out, 0u);
        call(out, 45u);                /* env.direct_x86_entropy */
        byte(out, 0x45u);
        byte(out, 0x04u); byte(out, 0x40u);
        local_get(out, 0u); call(out, 1u);
        byte(out, 0x0fu); byte(out, 0x0bu);
        return 2;
    }
    if (block->machine_operation != PL_X86_MACHINE_WRITE_MSR) {
        out->status = PL_ERROR_WASM_UNSUPPORTED;
        return 0;
    }
    /* WRMSR consumes ECX and EDX:EAX from the input architectural cut. */
    local_get(out, 0u);
    output_value(out, plan, plan->locals[1u]);
    i64_const(out, 0xffffffffu);
    byte(out, 0x83u);                  /* i64.and */
    output_value(out, plan, plan->locals[2u]);
    i64_const(out, 0xffffffffu);
    byte(out, 0x83u);                  /* i64.and */
    i64_const(out, 32u);
    byte(out, 0x86u);                  /* i64.shl */
    output_value(out, plan, plan->locals[0u]);
    i64_const(out, 0xffffffffu);
    byte(out, 0x83u);                  /* i64.and */
    byte(out, 0x84u);                  /* i64.or */
    call(out, 16u);                    /* env.direct_x86_write_msr */
    byte(out, 0x45u);                  /* i32.eqz */
    return_if(out, pl_vm_result_make(PL_VM_FAULT, 13u));
    return 0;
}

static void block_body(wasm_writer *out, const pl_wasm_block *block,
                       pl_u32 block_index)
{
    const pl_plan *plan = block->plan;
    if (!plan || plan->local_count < PL_VM_X86_REGISTER_COUNT + 1u
            || plan->stack_count
            || (block->result_kind != PL_VM_DIRECT
                && block->result_kind != PL_VM_RESOLVE_RIP
                && block->result_kind != PL_VM_BARRIER
                && block->result_kind != PL_VM_FAULT
                && block->result_kind != PL_VM_HALT
                && block->result_kind != PL_VM_TRANSITION)
            || block->result_payload > (~0ull >> PL_VM_RESULT_KIND_BITS)
            || block->alternate_result_payload
               > (~0ull >> PL_VM_RESULT_KIND_BITS)
            || (block->alternate_result_kind != PL_VM_DIRECT
                && block->alternate_result_kind != PL_VM_RESOLVE_RIP
                && block->alternate_result_kind != PL_VM_TRANSITION)
            || block->has_dynamic_rip > 1u
            || block->has_branch_predicate > 1u
            || block->next_rip_relative > 1u
            || block->alternate_rip_relative > 1u
            || (block->has_dynamic_rip && block->has_branch_predicate)
            || (block->has_dynamic_rip && block->next_rip_relative)
            || (block->has_dynamic_rip
                && block->result_kind != PL_VM_RESOLVE_RIP)
            || (block->has_branch_predicate
                && block->result_kind != PL_VM_DIRECT
                && block->result_kind != PL_VM_RESOLVE_RIP
                && block->result_kind != PL_VM_TRANSITION)
            || (block->result_kind == PL_VM_TRANSITION
                && (block->has_dynamic_rip || block->result_payload
                    || (block->has_branch_predicate
                        && (block->alternate_result_kind
                            != PL_VM_TRANSITION
                            || block->alternate_result_payload != 1u))))
            || block->machine_operation > PL_X86_MACHINE_ENTROPY) {
        out->status = PL_ERROR_WASM_ABI;
        return;
    }
    pl_u32 divide_node = direct_x86_divide_node(plan);
    if (divide_node == 0xffffffffu
            || block->has_fault_predicate > 1u
            || block->fault_vector > 255u
            || (block->has_fault_predicate
                && block->fault_predicate.kind != PL_OPERAND_NODE
                && block->fault_predicate.kind != PL_OPERAND_PROJECTION)
            || (divide_node
                && (!block->has_fault_predicate
                    || block->fault_predicate.kind != PL_OPERAND_NODE
                    || block->fault_predicate.value != divide_node
                    || block->fault_vector != 0u
                    || plan->instructions != 1u))) {
        out->status = PL_ERROR_WASM_ABI;
        return;
    }
    if ((plan->node_count && !plan->nodes)
            || (plan->argument_count && !plan->arguments)
            || (plan->local_count && !plan->locals)
            || plan->node_count > 0xfffffffdu) {
        out->status = PL_ERROR_WASM_ABI;
        return;
    }
    int recurrence = block->recurrence_local
                  || block->recurrence_bits
                  || block->recurrence_source_instructions;
    if (recurrence
            && (block->recurrence_local < PL_VM_X86_ARCH_LOCAL_COUNT
                || block->recurrence_local >= plan->local_count
                || (block->recurrence_bits != 32u
                    && block->recurrence_bits != 64u)
                || !block->recurrence_source_instructions
                || plan->instructions)) {
        out->status = PL_ERROR_WASM_ABI;
        return;
    }
    pl_u32 memory_count = 0u;
    int memory_status = direct_memory_count(plan, &memory_count);
    if (memory_status) {
        out->status = memory_status;
        return;
    }

    pl_u32 alu_count = direct_alu_count(plan);
    int has_scratch = 0;
    for (pl_u32 index = 0u; index < plan->node_count; ++index)
        if (direct_scratch_opcode(plan->nodes[index].opcode)) {
            has_scratch = 1;
            break;
        }
    pl_u32 emitted_locals = plan->node_count + alu_count
                          + (has_scratch ? PL_WASM_SCRATCH_LOCALS : 0u);
    if (emitted_locals < plan->node_count) {
        out->status = PL_ERROR_WASM_RANGE;
        return;
    }
    if (emitted_locals) {
        uleb(out, 1u);                 /* one local declaration group */
        uleb(out, emitted_locals);
        byte(out, 0x7eu);              /* every physical publication is u64 */
    } else {
        uleb(out, 0u);
    }
    for (pl_u32 value = 1u; value <= plan->node_count; ++value) {
        const pl_node *node = &plan->nodes[value - 1u];
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at) {
            out->status = PL_ERROR_WASM_ABI;
            return;
        }
        if (emit_lane(out, plan, node, value, block_index)) return;
        local_set(out, 2u + value - 1u);
    }
    if (memory_count) {
        local_get(out, 0u);
        block_coordinate(out, block_index);
        i32_const(out, memory_count);
        call(out, 7u);                 /* env.direct_memory_commit */
        byte(out, 0x1au);              /* drop zero publication */
        direct_memory_guard(out);
    }
    emit_fault_guard(out, plan, block);
    int machine_terminal = emit_machine_operation(out, plan, block);
    if (out->status) return;
    if (machine_terminal == 1) {
        byte(out, 0x0bu);              /* end after the terminal return */
        return;
    }
    if (machine_terminal != 2)
        for (pl_u32 coordinate = 0; coordinate < plan->local_count;
                ++coordinate)
            publish_local(out, plan, coordinate, plan->locals[coordinate]);

    if (block->result_kind != PL_VM_TRANSITION) {
        state_address(out);
        if (block->has_dynamic_rip) {
            output_value(out, plan, block->next_rip_operand);
        } else if (block->has_branch_predicate) {
            if (block->next_rip_relative
                    != block->alternate_rip_relative) {
                out->status = PL_ERROR_WASM_ABI;
                return;
            }
            if (block->next_rip_relative) {
                state_address(out);
                i64_load(out, PL_VM_X86_WASM32_OFF_RIP);
            }
            i64_const(out, block->next_rip);
            i64_const(out, block->alternate_rip);
            output_value(out, plan, block->branch_predicate);
            i64_const(out, 0u); byte(out, 0x52u); /* predicate != 0 */
            byte(out, 0x1bu);                    /* select true/false RIP */
            if (block->next_rip_relative)
                byte(out, 0x7cu);                /* i64.add */
        } else {
            if (block->next_rip_relative) {
                state_address(out);
                i64_load(out, PL_VM_X86_WASM32_OFF_RIP);
                i64_const(out, block->next_rip);
                byte(out, 0x7cu);                /* i64.add */
            } else {
                i64_const(out, block->next_rip);
            }
        }
        i64_store(out, PL_VM_X86_WASM32_OFF_RIP);
    }
    if (recurrence) add_recurrence_retired(out, block);
    else add_state_counter(out, PL_VM_X86_WASM32_OFF_RETIRED,
                           plan->instructions);
    add_state_counter(out, PL_VM_X86_WASM32_OFF_WORK, plan->node_count);
    add_state_counter(out, PL_VM_X86_WASM32_OFF_SPAN, plan->span);
    if (block->has_branch_predicate) {
        i64_const(out, pl_vm_result_make(
            block->result_kind, block->result_payload));
        i64_const(out, pl_vm_result_make(
            block->alternate_result_kind,
            block->alternate_result_payload));
        output_value(out, plan, block->branch_predicate);
        i64_const(out, 0u); byte(out, 0x52u); /* predicate != 0 */
        byte(out, 0x1bu);                    /* select successor token */
    } else {
        i64_const(out, pl_vm_result_make(
            block->result_kind, block->result_payload));
    }
    byte(out, 0x0bu);                  /* end */
}

static void page_dispatch_body(wasm_writer *out,
                               const pl_wasm_page_dispatch *dispatch)
{
    if (!dispatch
            || (dispatch->virtual_page & (PL_EXECUTABLE_PAGE_BYTES - 1u))
            || dispatch->page_rank > 0x0fffffffu) {
        out->status = PL_ERROR_WASM_ABI;
        return;
    }
    uleb(out, 1u);                     /* one local declaration group */
    uleb(out, 2u);                     /* page offset, tail/function rank */
    byte(out, 0x7fu);                  /* i32 */

    /* The C loader owns the cache memory and publishes tags last.  The
     * emitted function checks the fixed ABI geometry and all ranks before
     * reading a value, so neither eviction nor a stale executable generation
     * can turn into an out-of-range linear-memory/table coordinate. */
    i32_const(out, dispatch->page_rank);
    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_PAGE_COUNT);
    byte(out, 0x4fu);                  /* i32.ge_u */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_BINDING_SLOTS);
    i32_const(out, PL_VM_EXECUTABLE_BINDING_CACHE_SLOTS);
    byte(out, 0x47u);                  /* i32.ne */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_PAGE_ROW_SLOTS);
    i32_const(out, PL_VM_EXECUTABLE_PAGE_ROW_CACHE_SLOTS);
    byte(out, 0x47u);                  /* i32.ne */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_SLOTS);
    i32_const(out, PL_VM_EXECUTABLE_TAIL_ROW_CACHE_SLOTS);
    byte(out, 0x47u);                  /* i32.ne */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    /* The binding cache is keyed by dispatch_argument, which is exactly this
     * emitted entry-page rank. */
    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_BINDING_TAGS);
    i32_const(out, (dispatch->page_rank
                    & (PL_VM_EXECUTABLE_BINDING_CACHE_SLOTS - 1u)) * 4u);
    byte(out, 0x6au);                  /* i32.add */
    i32_load(out, 2u, 0u);
    i32_const(out, dispatch->page_rank + 1u);
    byte(out, 0x47u);                  /* i32.ne */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_BINDING_GENERATIONS);
    i32_const(out, (dispatch->page_rank
                    & (PL_VM_EXECUTABLE_BINDING_CACHE_SLOTS - 1u)) * 4u);
    byte(out, 0x6au);                  /* i32.add */
    i32_load(out, 2u, 0u);
    i32_const(out, dispatch->generation);
    byte(out, 0x47u);                  /* i32.ne */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_BINDING_ARGUMENTS);
    i32_const(out, (dispatch->page_rank
                    & (PL_VM_EXECUTABLE_BINDING_CACHE_SLOTS - 1u)) * 4u);
    byte(out, 0x6au);                  /* i32.add */
    i32_load(out, 2u, 0u);
    i32_const(out, dispatch->page_rank);
    byte(out, 0x47u);                  /* i32.ne */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    state_address(out);
    i64_load(out, PL_VM_X86_WASM32_OFF_RIP);
    i64_const(out, ~((pl_u64)PL_EXECUTABLE_PAGE_BYTES - 1u));
    byte(out, 0x83u);                  /* i64.and */
    i64_const(out, dispatch->virtual_page);
    byte(out, 0x52u);                  /* i64.ne */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    state_address(out);
    i64_load(out, PL_VM_X86_WASM32_OFF_RIP);
    i64_const(out, dispatch->virtual_page);
    byte(out, 0x7du);                  /* i64.sub */
    byte(out, 0xa7u);                  /* i32.wrap_i64 */
    local_set(out, 2u);

    /* A missing entry-page row is a cold authenticated object request. */
    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_PAGE_ROW_TAGS);
    i32_const(out, (dispatch->page_rank
                    & (PL_VM_EXECUTABLE_PAGE_ROW_CACHE_SLOTS - 1u)) * 4u);
    byte(out, 0x6au);                  /* i32.add */
    i32_load(out, 2u, 0u);
    i32_const(out, dispatch->page_rank + 1u);
    byte(out, 0x47u);                  /* i32.ne */
    return_if(out, pl_vm_result_make(
        PL_VM_ENTRY_MAP, (pl_u64)dispatch->page_rank << 1u));

    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_PAGE_ROW_VALUES);
    i32_const(out, (dispatch->page_rank
                    & (PL_VM_EXECUTABLE_PAGE_ROW_CACHE_SLOTS - 1u))
                   * PL_ENTRY_PAGE_ROWS * 4u);
    byte(out, 0x6au);                  /* i32.add */
    local_get(out, 2u);
    i32_const(out, PL_ENTRY_TAIL_BITS);
    byte(out, 0x76u);                  /* i32.shr_u */
    i32_const(out, 2u);
    byte(out, 0x74u);                  /* i32.shl */
    byte(out, 0x6au);                  /* i32.add */
    i32_load(out, 2u, 0u);
    local_tee(out, 3u);                /* tail-row rank */
    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_COUNT);
    byte(out, 0x4fu);                  /* i32.ge_u */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    /* Tail rows are independently evictable 1 KiB objects.  Construct the
     * miss token from the dynamic row rank: ((rank << 1) | 1) << 3 | 6. */
    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_TAGS);
    local_get(out, 3u);
    i32_const(out, PL_VM_EXECUTABLE_TAIL_ROW_CACHE_SLOTS - 1u);
    byte(out, 0x71u);                  /* i32.and */
    i32_const(out, 2u); byte(out, 0x74u); /* i32.shl */
    byte(out, 0x6au);                  /* i32.add */
    i32_load(out, 2u, 0u);
    local_get(out, 3u); i32_const(out, 1u); byte(out, 0x6au);
    byte(out, 0x47u);                  /* i32.ne */
    byte(out, 0x04u); byte(out, 0x40u); /* if */
    local_get(out, 3u); byte(out, 0xadu); /* i64.extend_i32_u */
    i64_const(out, 4u); byte(out, 0x86u); /* rank << 4 */
    i64_const(out, 14u); byte(out, 0x84u); /* | ENTRY_MAP tail token */
    byte(out, 0x0fu);                  /* return */
    byte(out, 0x0bu);                  /* end if */

    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_TAIL_ROW_VALUES);
    local_get(out, 3u);
    i32_const(out, PL_VM_EXECUTABLE_TAIL_ROW_CACHE_SLOTS - 1u);
    byte(out, 0x71u);                  /* i32.and */
    i32_const(out, PL_ENTRY_TAIL_BITS);
    byte(out, 0x74u);                  /* i32.shl (cached row base) */
    local_get(out, 2u);
    i32_const(out, PL_ENTRY_TAIL_VALUES - 1u);
    byte(out, 0x71u);                  /* i32.and */
    byte(out, 0x6au);                  /* i32.add */
    i32_const(out, 2u);
    byte(out, 0x74u);                  /* i32.shl */
    byte(out, 0x6au);                  /* i32.add */
    i32_load(out, 2u, 0u);
    local_tee(out, 3u);
    local_get(out, 1u);
    i32_load(out, 2u, PL_VM_EXECUTABLE_WASM32_OFF_FUNCTION_COUNT);
    byte(out, 0x4fu);                  /* i32.ge_u */
    return_if(out, pl_vm_result_make(PL_VM_STALE_GENERATION, 0u));

    local_get(out, 3u);
    byte(out, 0xadu);                  /* i64.extend_i32_u */
    i64_const(out, PL_VM_RESULT_KIND_BITS);
    byte(out, 0x86u);                  /* i64.shl -> DIRECT token */
    byte(out, 0x0bu);                  /* end */
}

static int module_function_count(const pl_wasm_module_spec *spec,
                                 pl_u32 *count)
{
    if (!spec || !count
            || (spec->block_count && !spec->blocks)
            || (spec->dispatcher_count && !spec->dispatchers)
            || (!spec->block_count && !spec->dispatcher_count)
            || spec->dispatcher_count > 0xffffffffu - spec->block_count)
        return PL_ERROR_WASM;
    *count = spec->block_count + spec->dispatcher_count;
    return 0;
}

static void type_section(wasm_writer *out, const pl_wasm_module_spec *spec)
{
    (void)spec;
    uleb(out, 11u);
    /* compiler-emitted block */
    byte(out, 0x60u);
    uleb(out, 2u); byte(out, 0x7fu); byte(out, 0x7fu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct memory: machine, address, value, offset, shape, op, block, slot */
    byte(out, 0x60u);
    uleb(out, 8u);
    byte(out, 0x7fu);
    byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu);
    byte(out, 0x7fu); byte(out, 0x7fu); byte(out, 0x7fu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct memory result: machine -> result token or zero */
    byte(out, 0x60u);
    uleb(out, 1u); byte(out, 0x7fu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct region: machine, address, offset, descriptor, shape,
     * block, memory slot, region slot */
    byte(out, 0x60u);
    uleb(out, 8u);
    byte(out, 0x7fu);
    byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu);
    byte(out, 0x7fu); byte(out, 0x7fu); byte(out, 0x7fu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct region projection: machine, slot, selector -> value */
    byte(out, 0x60u);
    uleb(out, 3u); byte(out, 0x7fu); byte(out, 0x7fu); byte(out, 0x7fu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct repeat: machine, address, pattern, bytes, shape, block, slot */
    byte(out, 0x60u);
    uleb(out, 7u); byte(out, 0x7fu);
    byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu);
    byte(out, 0x7fu); byte(out, 0x7fu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct x86 divide: machine, high, low, divisor, descriptor -> error */
    byte(out, 0x60u);
    uleb(out, 5u); byte(out, 0x7fu);
    byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct x86 divide projection: machine, selector -> value */
    byte(out, 0x60u);
    uleb(out, 2u); byte(out, 0x7fu); byte(out, 0x7fu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* shared CRC32C lane: accumulator, source, source width -> u32 value */
    byte(out, 0x60u);
    uleb(out, 3u); byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu);
    uleb(out, 1u); byte(out, 0x7eu);
    /* direct WRMSR: machine, ECX key, EDX:EAX value -> admitted */
    byte(out, 0x60u);
    uleb(out, 3u); byte(out, 0x7fu); byte(out, 0x7eu); byte(out, 0x7eu);
    uleb(out, 1u); byte(out, 0x7fu);
    /* far transfer: machine, pointer/address, descriptor, fallthrough */
    byte(out, 0x60u);
    uleb(out, 4u); byte(out, 0x7fu);
    byte(out, 0x7eu); byte(out, 0x7eu); byte(out, 0x7eu);
    uleb(out, 1u); byte(out, 0x7fu);
}

static void import_section(wasm_writer *out, const pl_wasm_module_spec *spec)
{
    (void)spec;
    uleb(out, 49u);
    string(out, "env", 3u);
    string(out, "memory", 6u);
    byte(out, 0x02u);                  /* memory import */
    byte(out, 0x00u);                  /* minimum only */
    uleb(out, 1u);

    string(out, "env", 3u);
    string(out, "table", 5u);
    byte(out, 0x01u);                  /* table import */
    byte(out, 0x70u);                  /* funcref */
    byte(out, 0x00u);                  /* minimum only */
    uleb(out, 0u);

    string(out, "env", 3u);
    string(out, "table_base", 10u);
    byte(out, 0x03u);                  /* immutable i32 global import */
    byte(out, 0x7fu);
    byte(out, 0x00u);

    string(out, "env", 3u);
    string(out, "direct_memory", 13u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 1u);

    string(out, "env", 3u);
    string(out, "direct_memory_result", 20u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 2u);

    string(out, "env", 3u);
    string(out, "direct_memory_region", 20u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 3u);

    string(out, "env", 3u);
    string(out, "direct_memory_region_value", 26u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 4u);

    string(out, "env", 3u);
    string(out, "direct_memory_repeat", 20u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 5u);

    string(out, "env", 3u);
    string(out, "direct_memory_copy", 18u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 5u);

    string(out, "env", 3u);
    string(out, "direct_memory_find2", 19u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 5u);

    string(out, "env", 3u);
    string(out, "direct_memory_commit", 20u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 4u);                     /* three i32 -> i64 */

    string(out, "env", 3u);
    string(out, "direct_x86_divide", 17u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 6u);

    string(out, "env", 3u);
    string(out, "direct_x86_divide_result", 24u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 7u);

    string(out, "env", 3u);
    string(out, "direct_x86_segment_base", 23u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 7u);                     /* machine, FS-or-GS -> i64 */

    string(out, "env", 3u);
    string(out, "direct_x86_rotate_carry", 23u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 6u);                     /* machine + four i64 -> flags */

    string(out, "env", 3u);
    string(out, "direct_x86_rotate_carry_result", 30u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 2u);                     /* machine -> value */

    string(out, "env", 3u);
    string(out, "direct_memory_store_if", 22u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 1u);                     /* predicate occupies the op i32 */

    string(out, "env", 3u);
    string(out, "direct_memory_frame", 19u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 5u);                     /* machine + four i64 + block/slot */

    string(out, "env", 3u);
    string(out, "direct_x86_crc32", 16u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 8u);                     /* three i64 -> i64 */

    string(out, "env", 3u);
    string(out, "direct_x86_write_msr", 20u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_far_return", 21u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);                     /* machine, addend, reserved -> admitted */

    string(out, "env", 3u);
    string(out, "direct_x86_write_control", 24u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);                     /* machine, CR coordinate, value */

    string(out, "env", 3u);
    string(out, "direct_x86_read_control", 23u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_write_segment", 24u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_descriptor_table", 27u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_pop_flags", 20u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_read_msr", 19u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_cpuid", 16u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_interrupt_flag", 25u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_port_io", 18u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_swap_gs", 18u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_invalidate_page", 26u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_system_transfer", 26u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_interrupt_return", 27u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_atomic", 17u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_vector", 17u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_read_selector", 24u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_software_interrupt", 29u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_far_transfer", 23u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 10u);

    string(out, "env", 3u);
    string(out, "direct_x86_x87", 14u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_time", 15u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_validate_selector", 28u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_string", 17u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_memory_order", 23u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_debug_register", 25u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_system_selector", 26u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_cr0_status", 21u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_segment_stack", 24u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);

    string(out, "env", 3u);
    string(out, "direct_x86_entropy", 18u);
    byte(out, 0x00u);                  /* function import */
    uleb(out, 9u);
}

static void function_section(wasm_writer *out,
                             const pl_wasm_module_spec *spec)
{
    pl_u32 count = 0u;
    if (module_function_count(spec, &count)) {
        out->status = PL_ERROR_WASM;
        return;
    }
    uleb(out, count);
    for (pl_u32 index = 0; index < count; ++index) uleb(out, 0u);
}

static void element_section(wasm_writer *out,
                            const pl_wasm_module_spec *spec)
{
    /* The authenticated module installs itself into the VM table.  The host
     * supplies only the C-validated base as an immutable import; it does not
     * enumerate exports or reconstruct a function directory in JavaScript. */
    uleb(out, 1u);                     /* one active element segment */
    byte(out, 0x00u);                  /* table zero, function indices */
    byte(out, 0x23u); uleb(out, 0u);   /* global.get table_base */
    byte(out, 0x0bu);                  /* end offset expression */
    pl_u32 count = 0u;
    if (module_function_count(spec, &count)) {
        out->status = PL_ERROR_WASM;
        return;
    }
    uleb(out, count);
    for (pl_u32 index = 0; index < count; ++index) {
        uleb(out, 46u + index);        /* forty-six imported VM functions */
    }
}

static void code_section(wasm_writer *out, const pl_wasm_module_spec *spec)
{
    pl_u32 count = 0u;
    if (module_function_count(spec, &count)) {
        out->status = PL_ERROR_WASM;
        return;
    }
    uleb(out, count);
    for (pl_u32 index = 0; index < spec->block_count; ++index) {
        wasm_writer measured = { 0, 0xffffffffu, 0u, 0, 0, 0u, 0u, 0u };
        block_body(&measured, &spec->blocks[index], index);
        if (measured.status) { out->status = measured.status; return; }
        uleb(out, measured.used);
        block_body(out, &spec->blocks[index], index);
        if (out->status) return;
    }
    for (pl_u32 index = 0; index < spec->dispatcher_count; ++index) {
        wasm_writer measured = { 0, 0xffffffffu, 0u, 0, 0, 0u, 0u, 0u };
        page_dispatch_body(&measured, &spec->dispatchers[index]);
        if (measured.status) { out->status = measured.status; return; }
        uleb(out, measured.used);
        page_dispatch_body(out, &spec->dispatchers[index]);
        if (out->status) return;
    }
}

typedef void (*section_writer)(wasm_writer *, const pl_wasm_module_spec *);

static void section(wasm_writer *out, pl_u32 id, section_writer emit,
                    const pl_wasm_module_spec *spec)
{
    wasm_writer measured = { 0, 0xffffffffu, 0u, 0, 0, 0u, 0u, 0u };
    emit(&measured, spec);
    if (measured.status) { out->status = measured.status; return; }
    byte(out, id);
    uleb(out, measured.used);
    emit(out, spec);
}

static int module(const pl_wasm_module_spec *spec, pl_u8 *target,
                  pl_u32 capacity, pl_u32 *written)
{
    static const pl_u8 magic[] = {
        0x00u, 0x61u, 0x73u, 0x6du, 0x01u, 0x00u, 0x00u, 0x00u,
    };
    pl_u32 function_count = 0u;
    if (module_function_count(spec, &function_count))
        return PL_ERROR_WASM;
    wasm_writer out = { target, capacity, 0u, 0, 0, 0u, 0u, 0u };
    raw(&out, magic, (pl_u32)sizeof magic);
    section(&out, 1u, type_section, spec);
    section(&out, 2u, import_section, spec);
    section(&out, 3u, function_section, spec);
    section(&out, 9u, element_section, spec);
    section(&out, 10u, code_section, spec);
    if (out.status) return out.status;
    if (written) *written = out.used;
    return 0;
}

int pl_wasm_module_measure(const pl_wasm_module_spec *spec, pl_u32 *bytes)
{
    if (!bytes) return PL_ERROR_WASM;
    return module(spec, 0, 0xffffffffu, bytes);
}

int pl_wasm_module_write(const pl_wasm_module_spec *spec, pl_u8 *target,
                         pl_u32 capacity, pl_u32 *written)
{
    if (!target) return PL_ERROR_WASM;
    return module(spec, target, capacity, written);
}

int pl_wasm_block_measure(const pl_wasm_block *block, pl_u32 block_index,
                          pl_u32 *bytes)
{
    if (!block || !bytes) return PL_ERROR_WASM;
    wasm_writer out = { 0, 0xffffffffu, 0u, 0, 0, 0u, 0u, 0u };
    block_body(&out, block, block_index);
    if (out.status) return out.status;
    *bytes = out.used;
    return 0;
}

int pl_wasm_block_write(const pl_wasm_block *block, pl_u32 block_index,
                        pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!block || !target || !written) return PL_ERROR_WASM;
    wasm_writer out = { target, capacity, 0u, 0, 0, 0u, 0u, 0u };
    block_body(&out, block, block_index);
    if (out.status) return out.status;
    *written = out.used;
    return 0;
}

int pl_wasm_block_parameterized_measure(
    const pl_wasm_block *block, pl_u32 block_index,
    pl_u32 *bytes, pl_u32 *parameter_count)
{
    if (!block || !bytes || !parameter_count) return PL_ERROR_WASM;
    wasm_writer out = {
        .target = 0,
        .capacity = 0xffffffffu,
        .parameterized = 1u,
    };
    block_body(&out, block, block_index);
    if (out.status) return out.status;
    *bytes = out.used;
    *parameter_count = out.parameter_count;
    return 0;
}

int pl_wasm_block_parameterized_write(
    const pl_wasm_block *block, pl_u32 block_index,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written,
    pl_u64 *parameters, pl_u32 parameter_capacity,
    pl_u32 *parameter_count)
{
    if (!block || !target || !written || !parameter_count
            || (parameter_capacity && !parameters))
        return PL_ERROR_WASM;
    wasm_writer out = {
        .target = target,
        .capacity = capacity,
        .parameters = parameters,
        .parameter_capacity = parameter_capacity,
        .parameterized = 1u,
    };
    block_body(&out, block, block_index);
    if (out.status) return out.status;
    *written = out.used;
    *parameter_count = out.parameter_count;
    return 0;
}

int pl_wasm_page_dispatch_measure(const pl_wasm_page_dispatch *dispatch,
                                  pl_u32 *bytes)
{
    if (!dispatch || !bytes) return PL_ERROR_WASM;
    wasm_writer out = { 0, 0xffffffffu, 0u, 0, 0, 0u, 0u, 0u };
    page_dispatch_body(&out, dispatch);
    if (out.status) return out.status;
    *bytes = out.used;
    return 0;
}

int pl_wasm_page_dispatch_write(const pl_wasm_page_dispatch *dispatch,
                                pl_u8 *target, pl_u32 capacity,
                                pl_u32 *written)
{
    if (!dispatch || !target || !written) return PL_ERROR_WASM;
    wasm_writer out = { target, capacity, 0u, 0, 0, 0u, 0u, 0u };
    page_dispatch_body(&out, dispatch);
    if (out.status) return out.status;
    *written = out.used;
    return 0;
}

typedef struct {
    const pl_wasm_function_body *bodies;
    pl_u32 count;
} body_module_spec;

static void body_function_section(wasm_writer *out,
                                  const body_module_spec *spec)
{
    uleb(out, spec->count);
    for (pl_u32 index = 0u; index < spec->count; ++index) uleb(out, 0u);
}

static void body_element_section(wasm_writer *out,
                                 const body_module_spec *spec)
{
    uleb(out, 1u);
    byte(out, 0x00u);
    byte(out, 0x23u); uleb(out, 0u);
    byte(out, 0x0bu);
    uleb(out, spec->count);
    for (pl_u32 index = 0u; index < spec->count; ++index)
        uleb(out, 46u + index);
}

static void body_code_section(wasm_writer *out,
                              const body_module_spec *spec)
{
    uleb(out, spec->count);
    for (pl_u32 index = 0u; index < spec->count; ++index) {
        const pl_wasm_function_body *body = &spec->bodies[index];
        if (!body->bytes || !body->length) {
            out->status = PL_ERROR_WASM;
            return;
        }
        uleb(out, body->length);
        raw(out, body->bytes, body->length);
    }
}

typedef void (*body_section_writer)(wasm_writer *, const body_module_spec *);

static void body_section(wasm_writer *out, pl_u32 id,
                         body_section_writer emit,
                         const body_module_spec *spec)
{
    wasm_writer measured = { 0, 0xffffffffu, 0u, 0, 0, 0u, 0u, 0u };
    emit(&measured, spec);
    if (measured.status) { out->status = measured.status; return; }
    byte(out, id);
    uleb(out, measured.used);
    emit(out, spec);
}

static int body_module(const pl_wasm_function_body *bodies,
                       pl_u32 body_count, pl_u8 *target,
                       pl_u32 capacity, pl_u32 *written)
{
    static const pl_u8 magic[] = {
        0x00u, 0x61u, 0x73u, 0x6du, 0x01u, 0x00u, 0x00u, 0x00u,
    };
    if (!bodies || !body_count) return PL_ERROR_WASM;
    for (pl_u32 index = 0u; index < body_count; ++index)
        if (!bodies[index].bytes || !bodies[index].length)
            return PL_ERROR_WASM;
    body_module_spec body_spec = { bodies, body_count };
    /* Type/import bytes do not inspect block graphs.  A count-only ordinary
     * spec lets both module routes share the exact public ABI spelling. */
    pl_wasm_module_spec abi_spec = {
        (const pl_wasm_block *)(const void *)bodies, body_count, 0, 0u,
    };
    wasm_writer out = { target, capacity, 0u, 0, 0, 0u, 0u, 0u };
    raw(&out, magic, (pl_u32)sizeof magic);
    section(&out, 1u, type_section, &abi_spec);
    section(&out, 2u, import_section, &abi_spec);
    body_section(&out, 3u, body_function_section, &body_spec);
    body_section(&out, 9u, body_element_section, &body_spec);
    body_section(&out, 10u, body_code_section, &body_spec);
    if (out.status) return out.status;
    if (written) *written = out.used;
    return 0;
}

int pl_wasm_body_module_measure(const pl_wasm_function_body *bodies,
                                pl_u32 body_count, pl_u32 *bytes)
{
    if (!bytes) return PL_ERROR_WASM;
    return body_module(bodies, body_count, 0, 0xffffffffu, bytes);
}

int pl_wasm_body_module_write(const pl_wasm_function_body *bodies,
                              pl_u32 body_count, pl_u8 *target,
                              pl_u32 capacity, pl_u32 *written)
{
    if (!target) return PL_ERROR_WASM;
    return body_module(bodies, body_count, target, capacity, written);
}

int pl_wasm_node_measure(const pl_plan *plan, pl_u32 value, pl_u32 *bytes)
{
    if (!plan || !bytes || !value || value > plan->node_count
            || !plan->nodes || (plan->argument_count && !plan->arguments))
        return PL_ERROR_WASM;
    const pl_node *node = &plan->nodes[value - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return PL_ERROR_WASM_ABI;
    wasm_writer out = { 0, 0xffffffffu, 0u, 0, 0, 0u, 0u, 0u };
    int status = emit_lane(&out, plan, node, value, 0u);
    if (status) return status;
    *bytes = out.used;
    return 0;
}
