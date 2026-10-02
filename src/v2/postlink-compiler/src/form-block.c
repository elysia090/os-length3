/* Straight-line block formation.  See include/postlink/block.h. */

#include "internal/form-block.h"

/* Compose instruction laws into one precise barrier-bounded block. */

#define TERMINAL_OBSERVATIONS 4u
#define PROJECTION_SELECTOR_BITS 8u
#define PROJECTION_SELECTOR_MASK 0xffu

static pl_operand constant(pl_u64 value)
{
    pl_operand out = { PL_OPERAND_CONST, value };
    return out;
}

static pl_arena arena_at(const pl_x86_block_workspace *workspace,
                         pl_u32 index)
{
    pl_arena arena = {
        index ? workspace->second : workspace->first,
        workspace->bytes_each, 0u,
    };
    return arena;
}

static int identity_plan(pl_arena *arena, pl_plan *plan)
{
    plan->function = 0u;
    plan->start = 0u;
    plan->end = 0u;
    plan->instructions = 0u;
    plan->stack_inputs = 0u;
    plan->span = 0u;
    plan->nodes = 0;
    plan->node_count = 0u;
    plan->arguments = 0;
    plan->argument_count = 0u;
    plan->stack = 0;
    plan->stack_count = 0u;
    plan->local_count = PL_X86_LOCAL_COUNT;
    plan->locals = pl_arena_take(
        arena, PL_X86_LOCAL_COUNT * (pl_u32)sizeof *plan->locals);
    plan->wave_offsets = 0;
    plan->wave_values = 0;
    if (!plan->locals) return PL_ERROR_ARENA;
    for (pl_u32 index = 0u; index < PL_X86_LOCAL_COUNT; ++index) {
        plan->locals[index].kind = PL_OPERAND_LOCAL;
        plan->locals[index].value = index;
    }
    return 0;
}

static void clear_block(pl_x86_block *out, pl_u64 start)
{
    out->start = start;
    out->end = start;
    out->successor[0] = 0u;
    out->successor[1] = 0u;
    out->target = constant(start);
    out->predicate = constant(1u);
    out->fault_predicate = constant(0u);
    out->machine_value = constant(0u);
    out->source_work = 0u;
    out->source_span = 0u;
    out->instruction_count = 0u;
    out->successor_count = 0u;
    out->live_output_mask = (1u << PL_X86_LOCAL_COUNT) - 1u;
    out->machine_inputs = 0u;
    out->kind = PL_X86_BLOCK_DIRECT;
    out->flow = PL_X86_FLOW_NEXT;
    out->dynamic_target = 0u;
    out->has_predicate = 0u;
    out->has_fault_predicate = 0u;
    out->trap_vector = 0u;
    out->machine_operation = PL_X86_MACHINE_NONE;
    out->construction_fields = 0u;
    out->source_identity = 0u;
    /* Widening a direct rel8 terminal is a layout choice, never part of the
     * block's semantic identity.  Default to no widening; the native layout
     * pass sets it explicitly and the canonical short spelling is the
     * standalone-block default. */
    out->relax_short_control = 0u;
    out->machine_argument = 0u;
}

static int observe_terminal(pl_arena *arena, pl_x86_semantic *semantic)
{
    pl_operand *observed = pl_arena_take(
        arena, TERMINAL_OBSERVATIONS * (pl_u32)sizeof *observed);
    if (!observed) return PL_ERROR_ARENA;
    observed[0] = semantic->target;
    observed[1] = semantic->predicate;
    observed[2] = semantic->fault_predicate;
    observed[3] = semantic->machine_value;
    semantic->plan.stack = observed;
    semantic->plan.stack_count = TERMINAL_OBSERVATIONS;
    return 0;
}

static int source_terminal(const pl_x86_instruction *instruction)
{
    return instruction->flow != PL_X86_FLOW_NEXT
        || !!(instruction->flags & (PL_X86_INSTRUCTION_MAY_TRAP
                                    | PL_X86_INSTRUCTION_PRECISE_CUT));
}

/* CMP(x,x) has one architectural flag result for every x.  Keep the compare
 * node because the successor observes RFLAGS, but substitute its projected
 * Jcc predicate immediately.  This removes an unreachable future arm without
 * inventing a second control representation or materializing the flag word.
 * Conditions use the architectural low-nibble Jcc encoding. */
static int equal_compare_predicate(const pl_plan *plan,
                                   pl_operand predicate, int *value)
{
    if (!plan || !value) return 0;
    if (predicate.kind == PL_OPERAND_CONST) {
        *value = predicate.value != 0u;
        return 1;
    }
    if (predicate.kind != PL_OPERAND_PROJECTION) return 0;
    pl_u32 source = (pl_u32)(predicate.value
                           >> PROJECTION_SELECTOR_BITS);
    pl_u32 condition = (pl_u32)predicate.value
                     & PROJECTION_SELECTOR_MASK;
    if (!source || source > plan->node_count || condition > 15u)
        return 0;
    const pl_node *node = &plan->nodes[source - 1u];
    if (node->opcode != PL_OPCODE_X86_COMPARE
            || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[1].kind != PL_OPERAND_CONST
            || argument[2].kind != PL_OPERAND_CONST
            || argument[1].value != argument[2].value
            || argument[3].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[3].value;
    pl_u32 bits = (pl_u32)descriptor & 0x7fu;
    pl_u32 mode = ((pl_u32)descriptor >> 8u) & 7u;
    if ((bits != 8u && bits != 16u && bits != 32u && bits != 64u)
            || mode != 3u || (descriptor >> 11u))
        return 0;
    /* OF=0, CF=0, ZF=1, SF=0, PF=1 for x-x. */
    static const pl_u16 true_conditions =
        (pl_u16)((1u << 1u) | (1u << 3u) | (1u << 4u)
               | (1u << 6u) | (1u << 9u) | (1u << 10u)
               | (1u << 13u) | (1u << 14u));
    *value = !!(true_conditions & (pl_u16)(1u << condition));
    return 1;
}

enum fixed_flag_bit {
    FIXED_CF = 1u << 0u,
    FIXED_PF = 1u << 1u,
    FIXED_ZF = 1u << 2u,
    FIXED_SF = 1u << 3u,
    FIXED_OF = 1u << 4u,
};

static int even_parity_byte(pl_u64 value)
{
    pl_u32 byte = (pl_u32)value & 0xffu;
    byte ^= byte >> 4u;
    byte &= 0x0fu;
    return !!((0x9669u >> byte) & 1u);
}

static int fixed_condition(pl_u32 condition, pl_u32 known,
                           pl_u32 flags, int *value)
{
    pl_u32 required = 0u;
    switch (condition) {
    case 0u: case 1u: required = FIXED_OF; break;
    case 2u: case 3u: required = FIXED_CF; break;
    case 4u: case 5u: required = FIXED_ZF; break;
    case 6u: case 7u: required = FIXED_CF | FIXED_ZF; break;
    case 8u: case 9u: required = FIXED_SF; break;
    case 10u: case 11u: required = FIXED_PF; break;
    case 12u: case 13u: required = FIXED_SF | FIXED_OF; break;
    case 14u: case 15u:
        required = FIXED_ZF | FIXED_SF | FIXED_OF;
        break;
    default: return 0;
    }
    if ((known & required) != required) return 0;
    int cf = !!(flags & FIXED_CF);
    int pf = !!(flags & FIXED_PF);
    int zf = !!(flags & FIXED_ZF);
    int sf = !!(flags & FIXED_SF);
    int of = !!(flags & FIXED_OF);
    switch (condition) {
    case 0u: *value = of; break;
    case 1u: *value = !of; break;
    case 2u: *value = cf; break;
    case 3u: *value = !cf; break;
    case 4u: *value = zf; break;
    case 5u: *value = !zf; break;
    case 6u: *value = cf || zf; break;
    case 7u: *value = !cf && !zf; break;
    case 8u: *value = sf; break;
    case 9u: *value = !sf; break;
    case 10u: *value = pf; break;
    case 11u: *value = !pf; break;
    case 12u: *value = sf != of; break;
    case 13u: *value = sf == of; break;
    case 14u: *value = zf || sf != of; break;
    default: *value = !zf && sf == of; break;
    }
    return 1;
}

/* Constant substitution may erase the value topology of a shift while its
 * architectural flag node remains live.  Derive only flags whose x86 value is
 * defined; a condition involving undefined OF stays on the Pareto frontier
 * instead of being guessed. */
static int fixed_shift_predicate(const pl_plan *plan,
                                 pl_operand predicate, int *value)
{
    if (!plan || !value || predicate.kind != PL_OPERAND_PROJECTION)
        return 0;
    pl_u32 source = (pl_u32)(predicate.value
                           >> PROJECTION_SELECTOR_BITS);
    pl_u32 condition = (pl_u32)predicate.value
                     & PROJECTION_SELECTOR_MASK;
    if (!source || source > plan->node_count || condition > 15u)
        return 0;
    const pl_node *node = &plan->nodes[source - 1u];
    if (node->opcode != PL_OPCODE_X86_SHIFT_FLAGS
            || node->argument_count != 5u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    for (pl_u32 index = 1u; index < 5u; ++index)
        if (argument[index].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 bits = (pl_u32)descriptor & 0x7fu;
    pl_u32 group = ((pl_u32)descriptor >> 8u) & 7u;
    pl_u32 amount = (pl_u32)argument[3].value;
    if ((bits != 32u && bits != 64u)
            || (group != 4u && group != 5u && group != 7u)
            || (descriptor >> 11u) || !amount || amount >= bits)
        return 0;
    pl_u64 mask = bits == 64u ? ~0ull : 0xffffffffull;
    pl_u64 input = argument[1].value & mask;
    pl_u64 result = argument[2].value & mask;
    pl_u64 sign = 1ull << (bits - 1u);
    pl_u32 known = FIXED_CF | FIXED_PF | FIXED_ZF | FIXED_SF;
    pl_u32 flags = 0u;
    pl_u64 carried = group == 4u
                   ? (input >> (bits - amount)) & 1u
                   : (input >> (amount - 1u)) & 1u;
    if (carried) flags |= FIXED_CF;
    if (even_parity_byte(result)) flags |= FIXED_PF;
    if (!result) flags |= FIXED_ZF;
    if (result & sign) flags |= FIXED_SF;
    if (amount == 1u) {
        known |= FIXED_OF;
        if ((group == 4u && (!!(result & sign) != !!carried))
                || (group == 5u && (input & sign)))
            flags |= FIXED_OF;
    }
    return fixed_condition(condition, known, flags, value);
}

static int fixed_terminal_predicate(const pl_plan *plan,
                                    pl_operand predicate, int *value)
{
    return equal_compare_predicate(plan, predicate, value)
        || fixed_shift_predicate(plan, predicate, value);
}

/* STI is a one-byte instruction.  Any block beginning immediately after an
 * executable FB byte is a possible interrupt-shadow successor, even when
 * that FB was itself reached through an unaligned x86 coordinate.  Keep only
 * that one source instruction in the representative; all other coordinates
 * retain maximal block formation and its smaller quotient. */
static int follows_sti(const pl_x86_frontend *frontend, pl_u64 start)
{
    if (!frontend || !frontend->image || !start) return 0;
    pl_u64 address = start - 1u;
    for (pl_u32 index = 0u; index < frontend->image->map_count; ++index) {
        const pl_x86_map *map = &frontend->image->maps[index];
        if (address < map->address) return 0;
        pl_u64 offset = address - map->address;
        if (offset >= map->memory_bytes) continue;
        return offset < map->file_bytes && map->bytes[offset] == 0xfbu;
    }
    return 0;
}

static int publish_identity(const pl_x86_block_workspace *workspace,
                            const pl_x86_instruction *instruction,
                            pl_u32 kind, pl_x86_block *out)
{
    pl_arena arena = arena_at(workspace, 0u);
    int status = identity_plan(&arena, &out->plan);
    if (status) return status;
    out->kind = (pl_u8)kind;
    out->flow = instruction->flow;
    out->trap_vector = instruction->trap_vector;
    out->source_work = 1u;
    out->source_span = 1u;
    out->instruction_count = 1u;
    if (instruction->flags & PL_X86_INSTRUCTION_TRAP_AFTER) {
        out->plan.instructions = 1u;
        out->plan.end = 1u;
    }
    out->end = instruction->fallthrough > instruction->rip
             ? instruction->fallthrough
             : instruction->rip + instruction->source_bytes;
    return 0;
}

static int block_lower_scope(const pl_x86_frontend *frontend, pl_u64 start,
                             pl_u64 exclusive_end, int bounded,
                             int established_boundary,
                             const pl_u8 *live_local,
                             const pl_x86_block_workspace *workspace,
                             pl_x86_block *out)
{
    if (!frontend || !workspace || !out || !workspace->first
            || !workspace->second || !workspace->bytes_each
            || !workspace->maximum_instructions
            || workspace->first == workspace->second
            || (bounded && start >= exclusive_end))
        return PL_ERROR_BLOCK;
    clear_block(out, start);

    pl_x86_instruction instruction;
    int status = pl_x86_frontend_decode(frontend, start, &instruction);
    if (status) return status;
    if (instruction.flow == PL_X86_FLOW_FAULT
            || instruction.status != PL_X86_DECODE_VALID)
        return publish_identity(
            workspace, &instruction, PL_X86_BLOCK_FAULT, out);
    if ((instruction.flags & PL_X86_INSTRUCTION_BARRIER)
            && instruction.machine_operation == PL_X86_MACHINE_NONE)
        return publish_identity(
            workspace, &instruction, PL_X86_BLOCK_MACHINE_BARRIER, out);

    pl_plan accumulated_plan;
    pl_plan *accumulated = 0;
    pl_x86_semantic terminal = { 0 };
    pl_u32 owner = 0u;
    pl_u64 rip = start;
    pl_u64 next = start;
    int have_terminal = 0;
    pl_u32 maximum_instructions = !established_boundary
                                && follows_sti(frontend, start)
                                ? 1u : workspace->maximum_instructions;
    for (pl_u32 count = 0u; count < maximum_instructions;
            ++count) {
        if (count) {
            status = pl_x86_frontend_decode(frontend, rip, &instruction);
            if (status) return status;
            if (instruction.flow == PL_X86_FLOW_FAULT
                    || instruction.status != PL_X86_DECODE_VALID
                    || (instruction.flags & PL_X86_INSTRUCTION_BARRIER)
                    || (instruction.flags & PL_X86_INSTRUCTION_MAY_TRAP)) {
                next = rip;
                break;
            }
        }

        pl_u32 destination = count ? owner ^ 1u : owner;
        pl_arena arena = arena_at(workspace, destination);
        pl_x86_semantic semantic;
        status = pl_x86_lower(&instruction, &arena, &semantic);
        if (status) return status;
        pl_u32 source_work = semantic.plan.node_count
                           ? semantic.plan.node_count : 1u;
        pl_u32 source_span = semantic.plan.span ? semantic.plan.span : 1u;
        if (out->source_work > 0xffffffffu - source_work
                || out->source_span > 0xffffffffu - source_span)
            return PL_ERROR_BLOCK_LIMIT;
        out->source_work += source_work;
        out->source_span += source_span;
        int terminal_source = source_terminal(&instruction);
        if (terminal_source) {
            status = observe_terminal(&arena, &semantic);
            if (status) return status;
        }

        if (!count) {
            accumulated_plan = semantic.plan;
        } else {
            pl_plan joined;
            status = pl_compose_raw(
                accumulated, &semantic.plan, &arena, &joined);
            if (status) return status;
            accumulated_plan = joined;
        }
        accumulated = &accumulated_plan;
        owner = destination;
        out->instruction_count = count + 1u;
        next = instruction.fallthrough;
        rip = next;
        if (terminal_source) {
            terminal = semantic;
            have_terminal = 1;
            break;
        }
        if (bounded && next >= exclusive_end) break;
        if (count + 1u == maximum_instructions) break;
    }
    if (!accumulated || !out->instruction_count) return PL_ERROR_BLOCK;

    /* Restore the complete implemented physical rewrite order before the
     * forward sweep.  These passes were previously exercised only by the
     * parity tool, which silently left the product block path with less
     * normalization than the reference executor. */
    pl_u32 rewrite_owner = owner ^ 1u;
    pl_arena rewrite_arena = arena_at(workspace, rewrite_owner);
    pl_plan prestored;
    status = pl_reopen_pre_store_chains(
        accumulated, &rewrite_arena, &prestored);
    if (status) return status;

    pl_plan regions;
    status = pl_reopen_load_regions(&prestored, &rewrite_arena, &regions);
    if (status) return status;

    /* A complete flag overwrite preserves only the architectural bits that
     * no ALU changes.  Rebase before reopening consumed ALU results: rebase
     * creates the exact projections which the backward ALU scan observes. */
    pl_plan rewritten;
    status = pl_rebase_overwritten_flags(
        &regions, &rewrite_arena, &rewritten);
    if (status) return status;

    pl_plan opened_alu;
    status = live_local
           ? pl_reopen_consumed_x86_alu_projected(
                &rewritten, live_local, &rewrite_arena, &opened_alu)
           : pl_reopen_consumed_x86_alu(
                &rewritten, &rewrite_arena, &opened_alu);
    if (status) return status;

    /* Close local quotient identities before liveness.  Each stage alternates
     * the two caller-owned arenas, so no tuple graph or intermediate frame is
     * retained. */
    pl_plan folded;
    status = pl_fold_local_physical(&opened_alu, &rewrite_arena, &folded);
    if (status) return status;

    /* Substitute a completely known terminal before liveness.  Keeping the
     * predicate in the transient observation stack until after compaction
     * made its otherwise-dead compare/shift node survive, so a constant arm
     * still paid the original control work.  The terminal stack is the one
     * authority at this point: rewrite its target and predicate, then let the
     * ordinary projected compactor remove every node no longer observed. */
    if (have_terminal && terminal.flow == PL_X86_FLOW_CONDITIONAL
            && terminal.has_predicate
            && folded.stack_count == TERMINAL_OBSERVATIONS) {
        int taken = 0;
        if (fixed_terminal_predicate(&folded, folded.stack[1], &taken)) {
            pl_u64 successor = terminal.successor[taken ? 0u : 1u];
            folded.stack[0] = constant(successor);
            folded.stack[1] = constant(1u);
            terminal.successor[0] = successor;
            terminal.successor[1] = 0u;
            terminal.successor_count = 1u;
            terminal.flow = successor == next
                          ? PL_X86_FLOW_NEXT : PL_X86_FLOW_JUMP;
            terminal.dynamic_target = 0u;
            terminal.has_predicate = 0u;
        }
    }

    pl_u32 compact_owner = owner;
    pl_arena compact_arena = arena_at(workspace, compact_owner);
    pl_plan compacted;
    /* Publication requires a dense fixed point, not merely one successful
     * sweep. pl_compact performs the same physical compaction and rejects the
     * block if a second sweep can still change its topology. */
    status = live_local
           ? pl_compact_projected(
                &folded, live_local, &compact_arena, &compacted)
           : pl_compact(&folded, &compact_arena, &compacted);
    if (status) return status;
    if (live_local) {
        /* Projection can make an ALU's flag result dead while its value
         * projection remains live. That fact exists only after the first
         * projected DCE, so expose the value once more and close newly
         * adjacent affine inverses before publication. The arenas alternate;
         * no intermediate graph is retained and the final projected compact
         * is again checked for a dense fixed point. */
        pl_arena projected_arena = arena_at(workspace, compact_owner ^ 1u);
        pl_plan projected_open;
        status = pl_reopen_consumed_x86_alu_projected(
            &compacted, live_local, &projected_arena, &projected_open);
        if (status) return status;
        pl_plan projected_folded;
        status = pl_fold_local_physical(
            &projected_open, &projected_arena, &projected_folded);
        if (status) return status;
        pl_arena final_arena = arena_at(workspace, compact_owner);
        status = pl_compact_projected(
            &projected_folded, live_local, &final_arena, &compacted);
        if (status) return status;
    }
    out->plan = compacted;
    out->plan.stack_count = 0u;
    out->end = next;
    if (have_terminal) {
        if (compacted.stack_count != TERMINAL_OBSERVATIONS)
            return PL_ERROR_BLOCK;
        out->target = compacted.stack[0];
        out->predicate = compacted.stack[1];
        out->fault_predicate = compacted.stack[2];
        out->machine_value = compacted.stack[3];
        out->successor[0] = terminal.successor[0];
        out->successor[1] = terminal.successor[1];
        out->successor_count = terminal.successor_count;
        out->flow = terminal.flow;
        out->dynamic_target = terminal.dynamic_target;
        out->has_predicate = terminal.has_predicate;
        out->has_fault_predicate = terminal.has_fault_predicate;
        out->trap_vector = terminal.trap_vector;
        out->machine_operation = terminal.machine_operation;
        out->machine_argument = terminal.machine_argument;
        out->machine_inputs = terminal.machine_inputs;
    } else {
        out->target = constant(next);
        out->predicate = constant(1u);
        out->successor[0] = next;
        out->successor_count = 1u;
    }
    return 0;
}

int pl_x86_block_lower(const pl_x86_frontend *frontend, pl_u64 start,
                       const pl_x86_block_workspace *workspace,
                       pl_x86_block *out)
{
    return block_lower_scope(frontend, start, 0u, 0, 0, 0, workspace, out);
}

int pl_x86_block_lower_until(const pl_x86_frontend *frontend, pl_u64 start,
                             pl_u64 exclusive_end,
                             const pl_x86_block_workspace *workspace,
                             pl_x86_block *out)
{
    return block_lower_scope(
        frontend, start, exclusive_end, 1, 0, 0, workspace, out);
}

int pl_x86_block_lower_projected_until(
    const pl_x86_frontend *frontend, pl_u64 start, pl_u64 exclusive_end,
    pl_u32 live_output_mask, const pl_x86_block_workspace *workspace,
    pl_x86_block *out)
{
    pl_u8 live[PL_X86_LOCAL_COUNT];
    if (live_output_mask >> PL_X86_LOCAL_COUNT)
        return PL_ERROR_BLOCK;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
        live[local] = (pl_u8)((live_output_mask >> local) & 1u);
    int status = block_lower_scope(
        frontend, start, exclusive_end, 1, 0, live, workspace, out);
    if (!status) out->live_output_mask = live_output_mask;
    return status;
}

int pl_x86_block_lower_projected_suffix_until(
    const pl_x86_frontend *frontend, pl_u64 start, pl_u64 exclusive_end,
    pl_u32 live_output_mask, const pl_x86_block_workspace *workspace,
    pl_x86_block *out)
{
    pl_u8 live[PL_X86_LOCAL_COUNT];
    if (live_output_mask >> PL_X86_LOCAL_COUNT)
        return PL_ERROR_BLOCK;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
        live[local] = (pl_u8)((live_output_mask >> local) & 1u);
    int status = block_lower_scope(
        frontend, start, exclusive_end, 1, 1, live, workspace, out);
    if (!status) out->live_output_mask = live_output_mask;
    return status;
}

static int operand_input_mask(const pl_plan *plan, pl_operand operand,
                              const pl_u32 *node_input,
                              pl_u32 nodes_ready, pl_u32 local_count,
                              pl_u32 *mask)
{
    if (!plan || !mask || local_count > 32u) return PL_ERROR_BLOCK;
    if (operand.kind == PL_OPERAND_CONST) {
        *mask = 0u;
        return 0;
    }
    if (operand.kind == PL_OPERAND_LOCAL) {
        if (operand.value >= local_count) return PL_ERROR_BLOCK;
        *mask = 1u << (pl_u32)operand.value;
        return 0;
    }
    if (operand.kind == PL_OPERAND_NODE
            || operand.kind == PL_OPERAND_PROJECTION) {
        pl_u64 source = operand.kind == PL_OPERAND_NODE
                      ? operand.value
                      : operand.value >> PROJECTION_SELECTOR_BITS;
        if (!source || source > nodes_ready || source > plan->node_count)
            return PL_ERROR_BLOCK;
        if (operand.kind == PL_OPERAND_PROJECTION) {
            pl_u32 selector = (pl_u32)operand.value
                            & PROJECTION_SELECTOR_MASK;
            const pl_node *node = &plan->nodes[source - 1u];
            pl_u32 descriptor_at = 0u;
            int skip_flags = selector <= 15u
                && (node->opcode == PL_OPCODE_X86_COMPARE
                    || node->opcode == PL_OPCODE_X86_TEST);
            if (node->opcode == PL_OPCODE_X86_ALU) descriptor_at = 3u;
            else if (node->opcode == PL_OPCODE_X86_FLAGS
                    || node->opcode == PL_OPCODE_X86_AFFINE_ALU)
                descriptor_at = 4u;
            if (descriptor_at && selector <= 16u
                    && node->argument_count > descriptor_at
                    && node->argument_at <= plan->argument_count
                    && node->argument_count
                       <= plan->argument_count - node->argument_at) {
                pl_operand descriptor =
                    plan->arguments[node->argument_at + descriptor_at];
                if (descriptor.kind == PL_OPERAND_CONST) {
                    pl_u32 group = (pl_u32)(descriptor.value >> 8u) & 7u;
                    int carry_input = group == 2u || group == 4u;
                    int preserves_carry = !!(descriptor.value & (1ull << 11u));
                    if (!carry_input
                            && (selector == 16u || !preserves_carry))
                        skip_flags = 1;
                }
            }
            if (skip_flags) {
                if (!node->argument_count
                        || node->argument_at > plan->argument_count
                        || node->argument_count
                           > plan->argument_count - node->argument_at)
                    return PL_ERROR_BLOCK;
                pl_u32 dependencies = 0u;
                for (pl_u32 slot = 1u; slot < node->argument_count; ++slot) {
                    pl_u32 argument_mask = 0u;
                    int status = operand_input_mask(
                        plan, plan->arguments[node->argument_at + slot],
                        node_input, (pl_u32)source - 1u,
                        local_count, &argument_mask);
                    if (status) return status;
                    dependencies |= argument_mask;
                }
                *mask = dependencies;
                return 0;
            }
        }
        *mask = node_input[source - 1u];
        return 0;
    }
    return PL_ERROR_BLOCK;
}

int pl_x86_block_live_transfer(
    const pl_x86_block *block, pl_arena *arena,
    pl_u32 *mandatory, pl_u32 dependency[PL_X86_LOCAL_COUNT])
{
    if (!block || !arena || !mandatory || !dependency
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->plan.node_count > 0xffffffffu / sizeof(pl_u32))
        return PL_ERROR_BLOCK;
    pl_u32 count = block->plan.node_count;
    pl_u32 *node_input = pl_arena_take(
        arena, (count ? count : 1u) * (pl_u32)sizeof *node_input);
    if (!node_input) return PL_ERROR_ARENA;
    for (pl_u32 node = 0u; node < count; ++node) {
        const pl_node *current = &block->plan.nodes[node];
        if (current->argument_at > block->plan.argument_count
                || current->argument_count
                   > block->plan.argument_count - current->argument_at)
            return PL_ERROR_BLOCK;
        pl_u32 dependencies = 0u;
        for (pl_u32 slot = 0u; slot < current->argument_count; ++slot) {
            pl_u32 argument_mask = 0u;
            int status = operand_input_mask(
                &block->plan,
                block->plan.arguments[current->argument_at + slot],
                node_input, node, block->plan.local_count, &argument_mask);
            if (status) return status;
            dependencies |= argument_mask;
        }
        node_input[node] = dependencies;
    }

    pl_u32 required = 0u;
    for (pl_u32 node = 0u; node < count; ++node)
        if (pl_opcode_is_memory(block->plan.nodes[node].opcode)
                || pl_opcode_traps(block->plan.nodes[node].opcode))
            required |= node_input[node];
    for (pl_u32 local = 0u; local < block->plan.local_count; ++local) {
        int status = operand_input_mask(
            &block->plan,
            block->plan.locals[local], node_input, count,
            block->plan.local_count, &dependency[local]);
        if (status) return status;
    }
    for (pl_u32 local = 0u; local < block->plan.local_count; ++local)
        if (block->machine_inputs & (1u << local))
            required |= dependency[local];

    pl_operand terminal[4];
    pl_u32 terminal_count = 0u;
    if (block->dynamic_target) terminal[terminal_count++] = block->target;
    if (block->has_predicate)
        terminal[terminal_count++] = block->predicate;
    if (block->has_fault_predicate)
        terminal[terminal_count++] = block->fault_predicate;
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        terminal[terminal_count++] = block->machine_value;
    for (pl_u32 index = 0u; index < terminal_count; ++index) {
        pl_u32 observation = 0u;
        int status = operand_input_mask(
            &block->plan,
            terminal[index], node_input, count,
            block->plan.local_count, &observation);
        if (status) return status;
        required |= observation;
    }
    *mandatory = required;
    return 0;
}

int pl_x86_block_live_inputs(const pl_x86_block *block,
                             pl_u32 live_output_mask,
                             pl_arena *arena, pl_u32 *input_mask)
{
    if (!block || !arena || !input_mask
            || (live_output_mask >> PL_X86_LOCAL_COUNT))
        return PL_ERROR_BLOCK;
    pl_u32 mandatory = 0u;
    pl_u32 dependency[PL_X86_LOCAL_COUNT];
    int status = pl_x86_block_live_transfer(
        block, arena, &mandatory, dependency);
    if (status) return status;
    pl_u32 required = mandatory;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
        if (live_output_mask & (1u << local))
            required |= dependency[local];
    *input_mask = required;
    return 0;
}

int pl_x86_block_direct(const pl_x86_block *block,
                        const pl_u32 successor_rank[2],
                        pl_direct_block *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->successor_count > 2u
            || (block->successor_count && !successor_rank))
        return PL_ERROR_BLOCK;
    out->plan = &block->plan;
    out->next_rip = block->successor_count
                  ? block->successor[0] : block->end;
    int primary_resolve = block->dynamic_target
                       || (block->successor_count
                           && successor_rank[0]
                              == PL_X86_BLOCK_RESOLVE_RANK);
    out->result_kind = primary_resolve
                     ? PL_DIRECT_RESOLVE : PL_DIRECT_FUNCTION;
    out->result_payload = primary_resolve || !block->successor_count
                        ? 0u : successor_rank[0];
    out->next_rip_operand = block->target;
    out->branch_predicate = block->predicate;
    out->alternate_rip = 0u;
    out->alternate_result_kind = PL_DIRECT_FUNCTION;
    out->alternate_result_payload = 0u;
    out->next_rip_relative = 0u;
    out->alternate_rip_relative = 0u;
    out->has_dynamic_rip = block->dynamic_target;
    out->has_branch_predicate = 0u;
    if (block->machine_operation == PL_X86_MACHINE_HALT) {
        if (block->dynamic_target || block->has_predicate
                || block->successor_count != 1u)
            return PL_ERROR_BLOCK;
        out->result_kind = PL_DIRECT_HALT;
        out->result_payload = successor_rank[0];
    } else if (block->has_predicate) {
        if (block->successor_count != 2u || block->dynamic_target)
            return PL_ERROR_BLOCK;
        out->alternate_rip = block->successor[1];
        if (successor_rank[1] == PL_X86_BLOCK_RESOLVE_RANK) {
            out->alternate_result_kind = PL_DIRECT_RESOLVE;
            out->alternate_result_payload = 0u;
        } else {
            out->alternate_result_kind = PL_DIRECT_FUNCTION;
            out->alternate_result_payload = successor_rank[1];
        }
        out->has_branch_predicate = 1u;
    } else if (!block->dynamic_target && block->successor_count != 1u) {
        return PL_ERROR_BLOCK;
    }
    if (!block->dynamic_target && block->successor_count) {
        out->next_rip = block->successor[0] - block->start;
        out->next_rip_relative = 1u;
        if (block->has_predicate) {
            out->alternate_rip = block->successor[1] - block->start;
            out->alternate_rip_relative = 1u;
        }
    }
    out->fault_predicate = block->fault_predicate;
    out->machine_value = block->machine_value;
    out->has_fault_predicate = block->has_fault_predicate;
    out->fault_vector = block->trap_vector;
    out->recurrence_local = 0u;
    out->recurrence_bits = 0u;
    out->recurrence_source_instructions = 0u;
    out->machine_operation = block->machine_operation;
    out->machine_argument = block->machine_argument;
    return 0;
}

int pl_x86_block_terminal_direct(const pl_x86_instruction *instruction,
                                 const pl_x86_block *block,
                                 pl_direct_block *out)
{
    if (!instruction || !block || !out
            || (block->kind != PL_X86_BLOCK_FAULT
                && block->kind != PL_X86_BLOCK_MACHINE_BARRIER))
        return PL_ERROR_BLOCK;
    out->plan = &block->plan;
    out->next_rip = block->kind == PL_X86_BLOCK_FAULT
                  && !(instruction->flags & PL_X86_INSTRUCTION_TRAP_AFTER)
                  ? instruction->rip : block->end;
    out->result_kind = block->kind == PL_X86_BLOCK_FAULT
                     ? PL_DIRECT_FAULT : PL_DIRECT_BARRIER;
    out->result_payload = block->kind == PL_X86_BLOCK_FAULT
                        ? block->trap_vector : 0u;
    out->next_rip_operand.kind = PL_OPERAND_CONST;
    out->next_rip_operand.value = out->next_rip;
    out->branch_predicate.kind = PL_OPERAND_CONST;
    out->branch_predicate.value = 1u;
    out->alternate_rip = 0u;
    out->alternate_result_kind = PL_DIRECT_FUNCTION;
    out->alternate_result_payload = 0u;
    out->next_rip_relative = 0u;
    out->alternate_rip_relative = 0u;
    out->has_dynamic_rip = 0u;
    out->has_branch_predicate = 0u;
    out->fault_predicate.kind = PL_OPERAND_CONST;
    out->fault_predicate.value = 0u;
    out->machine_value.kind = PL_OPERAND_CONST;
    out->machine_value.value = 0u;
    out->has_fault_predicate = 0u;
    out->fault_vector = block->trap_vector;
    out->recurrence_local = 0u;
    out->recurrence_bits = 0u;
    out->recurrence_source_instructions = 0u;
    out->machine_operation = instruction->machine_operation;
    out->machine_argument = instruction->machine_argument;
    return 0;
}

static pl_u64 mix(pl_u64 hash, pl_u64 value)
{
    hash ^= value + 0x9e3779b97f4a7c15ull + (hash << 6u) + (hash >> 2u);
    return hash;
}

static pl_u64 hash_operand(pl_u64 hash, pl_operand operand)
{
    hash = mix(hash, operand.kind);
    return mix(hash, operand.value);
}

static int same_operand(pl_operand left, pl_operand right)
{
    return left.kind == right.kind && left.value == right.value;
}

static int plan_shape(const pl_plan *plan)
{
    if (!plan || (plan->node_count && !plan->nodes)
            || (plan->argument_count && !plan->arguments)
            || (plan->local_count && !plan->locals)
            || plan->stack_count)
        return 0;
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        const pl_node *node = &plan->nodes[index];
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            return 0;
    }
    return 1;
}

static pl_u64 hash_plan(pl_u64 hash, const pl_plan *plan)
{
    hash = mix(hash, plan->stack_inputs);
    hash = mix(hash, plan->node_count);
    hash = mix(hash, plan->argument_count);
    hash = mix(hash, plan->local_count);
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        hash = mix(hash, plan->nodes[index].opcode);
        hash = mix(hash, plan->nodes[index].argument_at);
        hash = mix(hash, plan->nodes[index].argument_count);
    }
    for (pl_u32 index = 0u; index < plan->argument_count; ++index)
        hash = hash_operand(hash, plan->arguments[index]);
    for (pl_u32 index = 0u; index < plan->local_count; ++index)
        hash = hash_operand(hash, plan->locals[index]);
    return hash;
}

static int same_plan(const pl_plan *left, const pl_plan *right)
{
    if (!plan_shape(left) || !plan_shape(right)
            || left->stack_inputs != right->stack_inputs
            || left->node_count != right->node_count
            || left->argument_count != right->argument_count
            || left->local_count != right->local_count)
        return 0;
    for (pl_u32 index = 0u; index < left->node_count; ++index)
        if (left->nodes[index].opcode != right->nodes[index].opcode
                || left->nodes[index].argument_at
                   != right->nodes[index].argument_at
                || left->nodes[index].argument_count
                   != right->nodes[index].argument_count)
            return 0;
    for (pl_u32 index = 0u; index < left->argument_count; ++index)
        if (!same_operand(left->arguments[index], right->arguments[index]))
            return 0;
    for (pl_u32 index = 0u; index < left->local_count; ++index)
        if (!same_operand(left->locals[index], right->locals[index]))
            return 0;
    return 1;
}

static int block_instruction(const pl_x86_frontend *frontend,
                             const pl_x86_block *block,
                             pl_x86_instruction *instruction)
{
    return pl_x86_frontend_decode(frontend, block->start, instruction);
}

static int block_retains_exact_transfer(const pl_x86_block *block)
{
    return block->kind == PL_X86_BLOCK_MACHINE_BARRIER
        || block->machine_operation == PL_X86_MACHINE_EXTENSION;
}

static int block_hash(const pl_x86_frontend *frontend,
                      const pl_x86_block *block,
                      pl_u32 closed_successors,
                      int exact_external_successors,
                      pl_u64 *out)
{
    if (!frontend || !block || !out || !plan_shape(&block->plan))
        return PL_ERROR_BLOCK;
    pl_u64 hash = 0xcbf29ce484222325ull;
    hash = mix(hash, block->kind);
    hash = mix(hash, block->flow);
    hash = mix(hash, block->dynamic_target);
    hash = mix(hash, block->has_predicate);
    hash = mix(hash, block->has_fault_predicate);
    hash = mix(hash, block->trap_vector);
    hash = mix(hash, block->machine_operation);
    hash = mix(hash, block->machine_argument);
    hash = mix(hash, block->successor_count);
    hash = mix(hash, closed_successors);
    for (pl_u32 index = 0u; index < block->successor_count; ++index)
        if (!(closed_successors & (1u << index))) {
            pl_u64 successor = exact_external_successors
                             ? block->successor[index]
                             : block->successor[index] - block->start;
            hash = mix(hash, successor);
        }
    hash = hash_plan(hash, &block->plan);
    if (block->dynamic_target) hash = hash_operand(hash, block->target);
    if (block->has_predicate) hash = hash_operand(hash, block->predicate);
    if (block->has_fault_predicate)
        hash = hash_operand(hash, block->fault_predicate);
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        hash = hash_operand(hash, block->machine_value);
    if (block_retains_exact_transfer(block)) {
        pl_x86_instruction instruction;
        int status = block_instruction(frontend, block, &instruction);
        if (status) return status;
        hash = mix(hash, pl_x86_transfer_hash(&instruction));
    }
    *out = hash;
    return 0;
}

static int same_block(const pl_x86_frontend *frontend,
                      const pl_x86_block *left,
                      const pl_x86_block *right,
                      pl_u32 closed_successors,
                      int exact_external_successors,
                      int *equal)
{
    *equal = 0;
    if (left->kind != right->kind || left->flow != right->flow
            || left->dynamic_target != right->dynamic_target
            || left->has_predicate != right->has_predicate
            || left->has_fault_predicate != right->has_fault_predicate
            || left->trap_vector != right->trap_vector
            || left->machine_operation != right->machine_operation
            || left->machine_argument != right->machine_argument
            || left->successor_count != right->successor_count
            || !same_plan(&left->plan, &right->plan)
            || (left->dynamic_target
                && !same_operand(left->target, right->target))
            || (left->has_predicate
                && !same_operand(left->predicate, right->predicate))
            || (left->has_fault_predicate
                && !same_operand(left->fault_predicate,
                                 right->fault_predicate))
            || (left->machine_operation != PL_X86_MACHINE_NONE
                && !same_operand(left->machine_value,
                                 right->machine_value)))
        return 0;
    for (pl_u32 index = 0u; index < left->successor_count; ++index)
        if (!(closed_successors & (1u << index))) {
            pl_u64 left_successor = exact_external_successors
                                  ? left->successor[index]
                                  : left->successor[index] - left->start;
            pl_u64 right_successor = exact_external_successors
                                   ? right->successor[index]
                                   : right->successor[index] - right->start;
            if (left_successor != right_successor)
                return 0;
        }
    if (block_retains_exact_transfer(left)) {
        pl_x86_instruction left_instruction, right_instruction;
        int status = block_instruction(frontend, left, &left_instruction);
        if (!status)
            status = block_instruction(frontend, right, &right_instruction);
        if (status) return status;
        if (!pl_x86_transfer_equal(&left_instruction, &right_instruction))
            return 0;
    }
    *equal = 1;
    return 0;
}

typedef struct {
    pl_u8 *target;
    pl_u32 capacity;
    pl_u32 used;
    int status;
} block_observation_writer;

static void block_observation_u8(block_observation_writer *writer,
                                 pl_u32 value)
{
    if (writer->status) return;
    if (writer->used == 0xffffffffu
            || (writer->target && writer->used >= writer->capacity)) {
        writer->status = PL_ERROR_BLOCK_LIMIT;
        return;
    }
    if (writer->target) writer->target[writer->used] = (pl_u8)value;
    ++writer->used;
}

static void block_observation_u32(block_observation_writer *writer,
                                  pl_u32 value)
{
    for (pl_u32 shift = 0u; shift < 32u; shift += 8u)
        block_observation_u8(writer, value >> shift);
}

static void block_observation_u64(block_observation_writer *writer,
                                  pl_u64 value)
{
    block_observation_u32(writer, (pl_u32)value);
    block_observation_u32(writer, (pl_u32)(value >> 32u));
}

static void block_observation_operand(block_observation_writer *writer,
                                      pl_operand operand)
{
    block_observation_u8(writer, operand.kind);
    block_observation_u64(writer, operand.value);
}

static void block_observation_transfer(
    block_observation_writer *writer,
    const pl_x86_instruction *instruction)
{
    if (writer->status) return;
    pl_u32 bytes = 0u;
    int status = pl_x86_transfer_measure(instruction, &bytes);
    if (status || bytes > 0xffffffffu - writer->used
            || (writer->target && bytes > writer->capacity - writer->used)) {
        writer->status = status ? status : PL_ERROR_BLOCK_LIMIT;
        return;
    }
    if (writer->target) {
        pl_u32 written = 0u;
        status = pl_x86_transfer_write(
            instruction, writer->target + writer->used,
            writer->capacity - writer->used, &written);
        if (status || written != bytes) {
            writer->status = status ? status : PL_ERROR_BLOCK;
            return;
        }
    }
    writer->used += bytes;
}

static int block_observation_spelling(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u8 *target, pl_u32 capacity,
    pl_u32 *written)
{
    if (!frontend || !frontend->image || !block || !written
            || !plan_shape(&block->plan) || block->successor_count > 2u
            || closed_successors
               & ~((1u << block->successor_count) - 1u))
        return PL_ERROR_BLOCK;
    block_observation_writer writer = {
        target, capacity, 0u, 0,
    };
    block_observation_u8(&writer, 'X');
    block_observation_u8(&writer, '8');
    block_observation_u8(&writer, '6');
    block_observation_u8(&writer, 'B');
    block_observation_u8(&writer, 1u);
    block_observation_u8(&writer, block->kind);
    block_observation_u8(&writer, block->flow);
    block_observation_u8(&writer, block->dynamic_target);
    block_observation_u8(&writer, block->has_predicate);
    block_observation_u8(&writer, block->has_fault_predicate);
    block_observation_u8(&writer, block->trap_vector);
    block_observation_u8(&writer, block->machine_operation);
    block_observation_u64(&writer, block->machine_argument);
    block_observation_u8(&writer, block->successor_count);
    block_observation_u8(&writer, closed_successors);
    for (pl_u32 arm = 0u; arm < block->successor_count; ++arm)
        if (!(closed_successors & (1u << arm)))
            block_observation_u64(&writer, block->successor[arm]);

    block_observation_u32(&writer, block->plan.stack_inputs);
    block_observation_u32(&writer, block->plan.node_count);
    block_observation_u32(&writer, block->plan.argument_count);
    block_observation_u32(&writer, block->plan.local_count);
    for (pl_u32 index = 0u; index < block->plan.node_count; ++index) {
        block_observation_u32(&writer, block->plan.nodes[index].opcode);
        block_observation_u32(
            &writer, block->plan.nodes[index].argument_at);
        block_observation_u32(
            &writer, block->plan.nodes[index].argument_count);
    }
    for (pl_u32 index = 0u; index < block->plan.argument_count; ++index)
        block_observation_operand(&writer, block->plan.arguments[index]);
    for (pl_u32 index = 0u; index < block->plan.local_count; ++index)
        block_observation_operand(&writer, block->plan.locals[index]);
    if (block->dynamic_target)
        block_observation_operand(&writer, block->target);
    if (block->has_predicate)
        block_observation_operand(&writer, block->predicate);
    if (block->has_fault_predicate)
        block_observation_operand(&writer, block->fault_predicate);
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        block_observation_operand(&writer, block->machine_value);
    if (block_retains_exact_transfer(block)) {
        pl_x86_instruction instruction;
        int status = block_instruction(frontend, block, &instruction);
        if (status) return status;
        block_observation_transfer(&writer, &instruction);
    }
    if (writer.status) return writer.status;
    *written = writer.used;
    return 0;
}

int pl_x86_block_observation_measure(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u32 *bytes)
{
    return block_observation_spelling(
        frontend, block, closed_successors, 0, 0u, bytes);
}

int pl_x86_block_observation_write(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u8 *target, pl_u32 capacity,
    pl_u32 *written)
{
    if (!target) return PL_ERROR_BLOCK;
    return block_observation_spelling(
        frontend, block, closed_successors,
        target, capacity, written);
}

static int block_control_spelling(
    const pl_x86_block *block, pl_u32 closed_successors,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!block || !written || !plan_shape(&block->plan)
            || block->successor_count > 2u
            || closed_successors
               & ~((1u << block->successor_count) - 1u))
        return PL_ERROR_BLOCK;
    block_observation_writer writer = { target, capacity, 0u, 0 };
    block_observation_u8(&writer, 'X');
    block_observation_u8(&writer, '8');
    block_observation_u8(&writer, '6');
    block_observation_u8(&writer, 'C');
    block_observation_u8(&writer, 1u);
    block_observation_u8(&writer, block->kind);
    block_observation_u8(&writer, block->flow);
    block_observation_u8(&writer, block->dynamic_target);
    block_observation_u8(&writer, block->has_predicate);
    block_observation_u8(&writer, block->has_fault_predicate);
    block_observation_u8(&writer, block->trap_vector);
    block_observation_u8(&writer, block->machine_operation);
    block_observation_u64(&writer, block->machine_argument);
    block_observation_u8(&writer, block->successor_count);
    block_observation_u8(&writer, closed_successors);
    for (pl_u32 arm = 0u; arm < block->successor_count; ++arm)
        if (!(closed_successors & (1u << arm)))
            block_observation_u64(&writer, block->successor[arm]);
    if (block->dynamic_target)
        block_observation_operand(&writer, block->target);
    if (block->has_predicate)
        block_observation_operand(&writer, block->predicate);
    if (block->has_fault_predicate)
        block_observation_operand(&writer, block->fault_predicate);
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        block_observation_operand(&writer, block->machine_value);
    if (writer.status) return writer.status;
    *written = writer.used;
    return 0;
}

int pl_x86_block_control_measure(const pl_x86_block *block,
                                 pl_u32 closed_successors, pl_u32 *bytes)
{
    return block_control_spelling(
        block, closed_successors, 0, 0u, bytes);
}

int pl_x86_block_control_write(const pl_x86_block *block,
                               pl_u32 closed_successors,
                               pl_u8 *target, pl_u32 capacity,
                               pl_u32 *written)
{
    if (!target) return PL_ERROR_BLOCK;
    return block_control_spelling(
        block, closed_successors, target, capacity, written);
}

static void block_law_operand(block_observation_writer *writer,
                              pl_operand operand)
{
    block_observation_u8(writer, operand.kind);
    if (PL_OPERAND_STAYS(operand.kind))
        block_observation_u64(writer, operand.value);
}

static void block_binding_operand(block_observation_writer *writer,
                                  pl_operand operand)
{
    if (!PL_OPERAND_STAYS(operand.kind))
        block_observation_u64(writer, operand.value);
}

static int normal_block_shape(const pl_x86_block *block,
                              pl_u32 closed_successors)
{
    return block && plan_shape(&block->plan)
        && block->successor_count <= 2u
        && !(closed_successors
             & ~((1u << block->successor_count) - 1u));
}

static int block_control_law_spelling(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u8 *target, pl_u32 capacity,
    pl_u32 *written)
{
    if (!frontend || !written
            || !normal_block_shape(block, closed_successors))
        return PL_ERROR_BLOCK;
    block_observation_writer writer = { target, capacity, 0u, 0 };
    block_observation_u8(&writer, 'X');
    block_observation_u8(&writer, '8');
    block_observation_u8(&writer, '6');
    block_observation_u8(&writer, 'C');
    block_observation_u8(&writer, 2u);
    block_observation_u8(&writer, block->kind);
    block_observation_u8(&writer, block->flow);
    block_observation_u8(&writer, block->dynamic_target);
    block_observation_u8(&writer, block->has_predicate);
    block_observation_u8(&writer, block->has_fault_predicate);
    block_observation_u8(&writer, block->trap_vector);
    block_observation_u8(&writer, block->machine_operation);
    block_observation_u8(&writer, block->successor_count);
    block_observation_u8(&writer, closed_successors);
    if (block->dynamic_target)
        block_law_operand(&writer, block->target);
    if (block->has_predicate)
        block_law_operand(&writer, block->predicate);
    if (block->has_fault_predicate)
        block_law_operand(&writer, block->fault_predicate);
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        block_law_operand(&writer, block->machine_value);
    if (block_retains_exact_transfer(block)) {
        pl_x86_instruction instruction;
        int status = block_instruction(frontend, block, &instruction);
        if (status) return status;
        block_observation_transfer(&writer, &instruction);
    }
    if (writer.status) return writer.status;
    *written = writer.used;
    return 0;
}

static int block_control_bindings_spelling(
    const pl_x86_block *block, pl_u32 closed_successors,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!written || !normal_block_shape(block, closed_successors))
        return PL_ERROR_BLOCK;
    block_observation_writer writer = { target, capacity, 0u, 0 };
    block_observation_u8(&writer, 'X');
    block_observation_u8(&writer, '8');
    block_observation_u8(&writer, '6');
    block_observation_u8(&writer, 'R');
    block_observation_u8(&writer, 1u);
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        block_observation_u64(&writer, block->machine_argument);
    for (pl_u32 arm = 0u; arm < block->successor_count; ++arm)
        if (!(closed_successors & (1u << arm)))
            block_observation_u64(&writer, block->successor[arm]);
    if (block->dynamic_target)
        block_binding_operand(&writer, block->target);
    if (block->has_predicate)
        block_binding_operand(&writer, block->predicate);
    if (block->has_fault_predicate)
        block_binding_operand(&writer, block->fault_predicate);
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        block_binding_operand(&writer, block->machine_value);
    if (writer.status) return writer.status;
    *written = writer.used;
    return 0;
}

static int block_law_spelling(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u8 *target, pl_u32 capacity,
    pl_u32 *written)
{
    if (!written) return PL_ERROR_BLOCK;
    pl_u32 control_bytes = 0u, topology_bytes = 0u;
    int status = block_control_law_spelling(
        frontend, block, closed_successors, 0, 0u, &control_bytes);
    if (!status)
        status = pl_plan_topology_measure(&block->plan, &topology_bytes);
    if (status || control_bytes > 0xffffffffu - topology_bytes
            || control_bytes + topology_bytes > 0xffffffffu - 13u)
        return status ? status : PL_ERROR_BLOCK_LIMIT;
    pl_u32 total = 13u + control_bytes + topology_bytes;
    *written = total;
    if (!target) return 0;
    if (capacity < total) return PL_ERROR_BLOCK_LIMIT;
    block_observation_writer writer = { target, capacity, 0u, 0 };
    block_observation_u8(&writer, 'X');
    block_observation_u8(&writer, '8');
    block_observation_u8(&writer, '6');
    block_observation_u8(&writer, 'L');
    block_observation_u8(&writer, 1u);
    block_observation_u32(&writer, control_bytes);
    block_observation_u32(&writer, topology_bytes);
    if (writer.status) return writer.status;
    pl_u32 component = 0u;
    status = block_control_law_spelling(
        frontend, block, closed_successors,
        target + writer.used, capacity - writer.used, &component);
    if (status || component != control_bytes)
        return status ? status : PL_ERROR_BLOCK;
    writer.used += component;
    status = pl_plan_topology_write(
        &block->plan, target + writer.used,
        capacity - writer.used, &component);
    if (status || component != topology_bytes)
        return status ? status : PL_ERROR_BLOCK;
    writer.used += component;
    return writer.used == total ? 0 : PL_ERROR_BLOCK;
}

static int block_bindings_spelling(
    const pl_x86_block *block, pl_u32 closed_successors,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!written) return PL_ERROR_BLOCK;
    pl_u32 control_bytes = 0u, parameter_bytes = 0u;
    int status = block_control_bindings_spelling(
        block, closed_successors, 0, 0u, &control_bytes);
    if (!status)
        status = pl_plan_parameters_measure(
            &block->plan, &parameter_bytes);
    if (status || control_bytes > 0xffffffffu - parameter_bytes
            || control_bytes + parameter_bytes > 0xffffffffu - 13u)
        return status ? status : PL_ERROR_BLOCK_LIMIT;
    pl_u32 total = 13u + control_bytes + parameter_bytes;
    *written = total;
    if (!target) return 0;
    if (capacity < total) return PL_ERROR_BLOCK_LIMIT;
    block_observation_writer writer = { target, capacity, 0u, 0 };
    block_observation_u8(&writer, 'X');
    block_observation_u8(&writer, '8');
    block_observation_u8(&writer, '6');
    block_observation_u8(&writer, 'B');
    block_observation_u8(&writer, 2u);
    block_observation_u32(&writer, control_bytes);
    block_observation_u32(&writer, parameter_bytes);
    if (writer.status) return writer.status;
    pl_u32 component = 0u;
    status = block_control_bindings_spelling(
        block, closed_successors, target + writer.used,
        capacity - writer.used, &component);
    if (status || component != control_bytes)
        return status ? status : PL_ERROR_BLOCK;
    writer.used += component;
    status = pl_plan_parameters_write(
        &block->plan, target + writer.used,
        capacity - writer.used, &component);
    if (status || component != parameter_bytes)
        return status ? status : PL_ERROR_BLOCK;
    writer.used += component;
    return writer.used == total ? 0 : PL_ERROR_BLOCK;
}

int pl_x86_block_law_measure(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u32 *bytes)
{
    return block_law_spelling(
        frontend, block, closed_successors, 0, 0u, bytes);
}

int pl_x86_block_law_write(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u8 *target, pl_u32 capacity,
    pl_u32 *written)
{
    if (!target) return PL_ERROR_BLOCK;
    return block_law_spelling(
        frontend, block, closed_successors,
        target, capacity, written);
}

int pl_x86_block_bindings_measure(
    const pl_x86_block *block, pl_u32 closed_successors, pl_u32 *bytes)
{
    return block_bindings_spelling(
        block, closed_successors, 0, 0u, bytes);
}

int pl_x86_block_bindings_write(
    const pl_x86_block *block, pl_u32 closed_successors,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!target) return PL_ERROR_BLOCK;
    return block_bindings_spelling(
        block, closed_successors, target, capacity, written);
}

static int instruction_law_spelling(
    const pl_x86_frontend *frontend, pl_u64 rip,
    const pl_x86_block_workspace *workspace,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!frontend || !workspace || !written) return PL_ERROR_BLOCK;
    pl_x86_instruction instruction;
    int status = pl_x86_frontend_decode(frontend, rip, &instruction);
    if (status) return status;
    pl_u64 end = instruction.fallthrough > rip
               ? instruction.fallthrough : rip + instruction.source_bytes;
    if (end <= rip) return PL_ERROR_BLOCK;
    pl_x86_block block;
    status = pl_x86_block_lower_until(
        frontend, rip, end, workspace, &block);
    if (status) return status;
    if (block.instruction_count != 1u || block.end != end)
        return PL_ERROR_BLOCK;
    pl_u32 closed = block.successor_count
                  ? (1u << block.successor_count) - 1u : 0u;
    return target
         ? pl_x86_block_law_write(
             frontend, &block, closed, target, capacity, written)
         : pl_x86_block_law_measure(
             frontend, &block, closed, written);
}

int pl_x86_instruction_law_measure(
    const pl_x86_frontend *frontend, pl_u64 rip,
    const pl_x86_block_workspace *workspace, pl_u32 *bytes)
{
    return instruction_law_spelling(
        frontend, rip, workspace, 0, 0u, bytes);
}

int pl_x86_instruction_law_write(
    const pl_x86_frontend *frontend, pl_u64 rip,
    const pl_x86_block_workspace *workspace,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!target) return PL_ERROR_BLOCK;
    return instruction_law_spelling(
        frontend, rip, workspace, target, capacity, written);
}

static int power_of_two(pl_u32 value)
{
    return value && !(value & (value - 1u));
}

int pl_x86_block_builder_open(
    pl_x86_block_builder *builder, const pl_x86_image *image,
    const pl_x86_block_workspace *formation,
    const pl_x86_block_workspace *comparison,
    pl_x86_block_identity *identities, pl_u32 identity_capacity,
    pl_u32 *hash_slots, pl_u32 hash_slot_count)
{
    if (!builder || !image || !formation || !comparison || !identities
            || !identity_capacity || !hash_slots
            || hash_slot_count <= identity_capacity
            || !power_of_two(hash_slot_count))
        return PL_ERROR_BLOCK;
    int status = pl_x86_frontend_open(image, &builder->frontend);
    if (status) return status;
    builder->formation = *formation;
    builder->comparison = *comparison;
    builder->identities = identities;
    builder->identity_capacity = identity_capacity;
    builder->identity_count = 0u;
    builder->hash_slots = hash_slots;
    builder->hash_slot_count = hash_slot_count;
    builder->admissions = 0u;
    builder->shared = 0u;
    builder->probes = 0u;
    builder->maximum_probe = 0u;
    builder->formation_limit = 0u;
    builder->failure_rip = 0u;
    builder->failure_status = 0;
    builder->identity_mode = 0u;
    for (pl_u32 index = 0u; index < hash_slot_count; ++index)
        hash_slots[index] = 0u;
    return 0;
}

static int block_intern(pl_x86_block_builder *builder,
                        const pl_x86_block *block, pl_u32 *rank,
                        pl_u32 closed_successors, pl_u8 mode)
{
    if (!builder || !block || !rank || !builder->identities
            || !builder->hash_slots)
        return PL_ERROR_BLOCK;
    if (closed_successors & ~((1u << block->successor_count) - 1u))
        return PL_ERROR_BLOCK;
    if (builder->identity_mode && builder->identity_mode != mode)
        return PL_ERROR_BLOCK;
    builder->identity_mode = mode;
    pl_u64 hash = 0u;
    int status = block_hash(
        &builder->frontend, block, closed_successors, mode == 2u, &hash);
    if (status) return status;
    pl_u32 mask = builder->hash_slot_count - 1u;
    pl_u32 slot = (pl_u32)(hash ^ (hash >> 32u)) & mask;
    for (pl_u32 probe = 1u; probe <= builder->hash_slot_count; ++probe) {
        ++builder->probes;
        if (probe > builder->maximum_probe) builder->maximum_probe = probe;
        pl_u32 encoded = builder->hash_slots[slot];
        if (!encoded) {
            if (builder->identity_count >= builder->identity_capacity)
                return PL_ERROR_BLOCK_LIMIT;
            pl_u64 limit_bytes = 0u;
            if (builder->formation_limit) {
                if (builder->formation_limit < block->start)
                    return PL_ERROR_BLOCK;
                limit_bytes = builder->formation_limit - block->start;
                if (limit_bytes > 0xffffffffu)
                    return PL_ERROR_BLOCK_LIMIT;
            }
            pl_u32 fresh = builder->identity_count++;
            builder->identities[fresh].hash = hash;
            builder->identities[fresh].representative = block->start;
            builder->identities[fresh].limit_bytes = (pl_u32)limit_bytes;
            builder->identities[fresh].closed_successors =
                closed_successors;
            builder->hash_slots[slot] = fresh + 1u;
            ++builder->admissions;
            *rank = fresh;
            return 0;
        }
        pl_u32 candidate = encoded - 1u;
        if (candidate >= builder->identity_count) return PL_ERROR_BLOCK;
        const pl_x86_block_identity *identity =
            &builder->identities[candidate];
        if (identity->hash == hash
                && identity->closed_successors == closed_successors) {
            pl_x86_block representative;
            status = identity->limit_bytes
                   ? pl_x86_block_lower_until(
                         &builder->frontend, identity->representative,
                         identity->representative
                             + identity->limit_bytes,
                         &builder->comparison, &representative)
                   : pl_x86_block_lower(
                         &builder->frontend, identity->representative,
                         &builder->comparison, &representative);
            if (status) return status;
            int equal = 0;
            status = same_block(
                &builder->frontend, block, &representative,
                closed_successors, mode == 2u, &equal);
            if (status) return status;
            if (equal) {
                ++builder->admissions;
                ++builder->shared;
                *rank = candidate;
                return 0;
            }
        }
        slot = (slot + 1u) & mask;
    }
    return PL_ERROR_BLOCK_LIMIT;
}

int pl_x86_block_intern(pl_x86_block_builder *builder,
                        const pl_x86_block *block, pl_u32 *rank)
{
    return block_intern(builder, block, rank, 0u, 1u);
}

int pl_x86_block_observation_intern(pl_x86_block_builder *builder,
                                    const pl_x86_block *block,
                                    pl_u32 closed_successors,
                                    pl_u32 *rank)
{
    return block_intern(
        builder, block, rank, closed_successors, 2u);
}

int pl_x86_block_rank_instruction(const pl_x86_instruction *instruction,
                                  void *context, pl_u32 *rank)
{
    pl_x86_block_builder *builder = context;
    if (!instruction || !builder || !rank) return PL_ERROR_BLOCK;
    pl_x86_block block;
    int status = builder->formation_limit
               ? pl_x86_block_lower_until(
                     &builder->frontend, instruction->rip,
                     builder->formation_limit, &builder->formation, &block)
               : pl_x86_block_lower(
                     &builder->frontend, instruction->rip,
                     &builder->formation, &block);
    if (!status) status = pl_x86_block_intern(builder, &block, rank);
    if (status && !builder->failure_status) {
        builder->failure_rip = instruction->rip;
        builder->failure_status = status;
    }
    return status;
}
