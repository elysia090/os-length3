/* projection: native x86 selection. */
#include "projection.h"
#include "limits.h"
#include "select.h"
#include "source.h"

#define FLAG_LIVE_CARRY        (1u << 0u)
#define FLAG_LIVE_ARITHMETIC   (1u << 1u)
#define FLAG_LIVE_DIRECTION    (1u << 2u)
#define FLAG_LIVE_INTERRUPT    (1u << 3u)
#define FLAG_LIVE_SYSTEM       (1u << 4u)
#define FLAG_LIVE_ARITHMETIC_ALL \
    (FLAG_LIVE_CARRY | FLAG_LIVE_ARITHMETIC)
#define FLAG_LIVE_ALL \
    (FLAG_LIVE_ARITHMETIC_ALL | FLAG_LIVE_DIRECTION \
     | FLAG_LIVE_INTERRUPT | FLAG_LIVE_SYSTEM)
#define NATIVE_COST_OUTPUT_BYTES 2048u
#define NATIVE_COST_ARENA_BYTES  8192u

static int same_operand(pl_operand left, pl_operand right);

static int same_semantic_plan(const pl_plan *left, const pl_plan *right);

static int same_semantic_block(const pl_x86_block *left,
                               const pl_x86_block *right);

static void source_operand_local_mask(pl_operand operand, pl_u32 *mask);

static int instruction_masks(const pl_x86_semantic *semantic,
                             int rebase_complete_flag_write,
                             pl_u32 *reads, pl_u32 *writes);

static int instruction_dependency_masks(
    const pl_x86_semantic *semantic, pl_u32 *reads, pl_u32 *writes);

static int instruction_liveness_masks(
    const pl_x86_semantic *semantic, pl_u32 *reads, pl_u32 *writes);

static pl_u32 instruction_dependency_depth(
    pl_u32 reads, pl_u32 writes, int terminal, int register_copy,
    pl_u32 producer[PL_X86_LOCAL_COUNT]);

static int instruction_is_register_copy(
    const pl_x86_instruction *instruction);

static int source_node_rebases_flag_root(
    const pl_plan *plan, const pl_node *node);

static int semantic_rebases_flag_root(const pl_x86_semantic *semantic);

static void instruction_flag_liveness_masks(
    const pl_x86_instruction *instruction,
    const pl_x86_semantic *semantic,
    pl_u32 architectural_reads, pl_u32 architectural_writes,
    pl_u8 *reads, pl_u8 *writes);

static int same_operand(pl_operand left, pl_operand right)
{
    return left.kind == right.kind && left.value == right.value;
}

/* Normalization has already made the physical SSA dense and deterministic.
 * Source instruction count, dependency depth and wave storage describe how a
 * spelling was obtained; they are not part of its architectural future. */
static int same_semantic_plan(const pl_plan *left, const pl_plan *right)
{
    if (!left || !right
            || left->node_count != right->node_count
            || left->argument_count != right->argument_count
            || left->stack_count != right->stack_count
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
    for (pl_u32 index = 0u; index < left->stack_count; ++index)
        if (!same_operand(left->stack[index], right->stack[index]))
            return 0;
    for (pl_u32 index = 0u; index < left->local_count; ++index)
        if (!same_operand(left->locals[index], right->locals[index]))
            return 0;
    return 1;
}

static int same_semantic_block(const pl_x86_block *left,
                               const pl_x86_block *right)
{
    if (!left || !right || left->end != right->end
            || left->kind != right->kind || left->flow != right->flow
            || left->dynamic_target != right->dynamic_target
            || left->has_predicate != right->has_predicate
            || left->has_fault_predicate != right->has_fault_predicate
            || left->trap_vector != right->trap_vector
            || left->machine_operation != right->machine_operation
            || left->machine_argument != right->machine_argument
            || left->successor_count != right->successor_count
            || !same_semantic_plan(&left->plan, &right->plan)
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
        if (left->successor[index] != right->successor[index]) return 0;
    return 1;
}

static void source_operand_local_mask(pl_operand operand, pl_u32 *mask)
{
    if (operand.kind == PL_OPERAND_LOCAL
            && operand.value < PL_X86_LOCAL_COUNT)
        *mask |= 1u << (pl_u32)operand.value;
}

/* Derive the dependency cut from the same one-instruction semantic law which
 * is later emitted.  This is deliberately independent of the whole-block
 * grammar production which happened to find the spelling: a production may
 * choose bytes, but it may not invent a separate work/span certificate. */
static int instruction_masks(const pl_x86_semantic *semantic,
                             int rebase_complete_flag_write,
                             pl_u32 *reads, pl_u32 *writes)
{
    if (!semantic || !reads || !writes) return PL_ERROR_X86_SELECT;
    *reads = semantic->machine_inputs;
    *writes = 0u;
    for (pl_u32 node = 0u; node < semantic->plan.node_count; ++node) {
        const pl_node *operation = &semantic->plan.nodes[node];
        int rebase_flags =
            source_node_rebases_flag_root(&semantic->plan, operation);
        for (pl_u32 slot = 0u; slot < operation->argument_count; ++slot) {
            /* A complete flag overwrite reads its preserved lanes from the
             * persistent cut, not from an overwritten intermediate flag
             * producer.  This is the same substitution used by the SSA
             * normalizer and prevents a false serial edge. */
            if (!slot && rebase_complete_flag_write && rebase_flags)
                continue;
            source_operand_local_mask(
                semantic->plan.arguments[operation->argument_at + slot],
                reads);
        }
    }
    for (pl_u32 local = 0u; local < semantic->plan.local_count; ++local) {
        pl_operand value = semantic->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        *writes |= 1u << local;
        source_operand_local_mask(value, reads);
    }
    source_operand_local_mask(semantic->target, reads);
    source_operand_local_mask(semantic->predicate, reads);
    source_operand_local_mask(semantic->fault_predicate, reads);
    source_operand_local_mask(semantic->machine_value, reads);
    return 0;
}

static int instruction_dependency_masks(
    const pl_x86_semantic *semantic, pl_u32 *reads, pl_u32 *writes)
{
    return instruction_masks(semantic, 1, reads, writes);
}

/* Backward DCE needs exact architectural liveness, including flag lanes
 * preserved by an otherwise complete arithmetic update.  Dependency-depth
 * accounting may rebase those lanes to the persistent cut, but doing that
 * here would incorrectly erase producers such as CLD before CMP. */
static int instruction_liveness_masks(
    const pl_x86_semantic *semantic, pl_u32 *reads, pl_u32 *writes)
{
    return instruction_masks(semantic, 0, reads, writes);
}

static pl_u32 instruction_dependency_depth(
    pl_u32 reads, pl_u32 writes, int terminal, int register_copy,
    pl_u32 producer[PL_X86_LOCAL_COUNT])
{
    pl_u32 depth = register_copy ? 0u : 1u;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
        if (!(reads & (1u << local))) continue;
        pl_u32 candidate = producer[local]
                         + (register_copy ? 0u : 1u);
        if (candidate > depth) depth = candidate;
    }
    /* A copy of an entry coordinate is still one publication wave even
     * though it introduces no new data-dependency edge. */
    if (!depth) depth = 1u;
    /* A terminal transfer publishes the complete architectural frame before
     * its successor may begin.  Direct control has no data operand naming
     * those publications, so make that real cut explicit rather than letting
     * an unconditional branch appear parallel with the writes it commits. */
    if (terminal)
        for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
            if (producer[local] >= depth) depth = producer[local] + 1u;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
        if (writes & (1u << local)) producer[local] = depth;
    return depth;
}

static int instruction_is_register_copy(
    const pl_x86_instruction *instruction)
{
    if (!instruction || instruction->operation != PL_X86_OPERATION_MOVE
            || instruction->flow != PL_X86_FLOW_NEXT
            || instruction->visible_operand_count < 2u)
        return 0;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    return destination->kind == PL_X86_OPERAND_REGISTER
        && source->kind == PL_X86_OPERAND_REGISTER
        && destination->value.reg.class_id == PL_X86_REGISTER_GPR
        && source->value.reg.class_id == PL_X86_REGISTER_GPR;
}

static int source_node_rebases_flag_root(
    const pl_plan *plan, const pl_node *node)
{
    if (!plan || !node) return 0;
    if (node->opcode == PL_OPCODE_X86_COMPARE
            || node->opcode == PL_OPCODE_X86_TEST)
        return 1;
    if (node->opcode == PL_OPCODE_X86_SHIFT_FLAGS) {
        if (node->argument_count != 5u) return 0;
        const pl_operand *amount =
            &plan->arguments[node->argument_at + 3u];
        const pl_operand *word =
            &plan->arguments[node->argument_at + 4u];
        if (amount->kind != PL_OPERAND_CONST
                || word->kind != PL_OPERAND_CONST)
            return 0;
        pl_u64 width = word->value & 0x7full;
        pl_u64 group = (word->value >> 8u) & 7u;
        return (width == 8u || width == 16u
                || width == 32u || width == 64u)
            && (amount->value & (width - 1u)) != 0u
            && group >= 4u && group <= 7u;
    }
    pl_u32 descriptor_at;
    if (node->opcode == PL_OPCODE_X86_FLAGS) descriptor_at = 4u;
    else if (node->opcode == PL_OPCODE_X86_ALU) descriptor_at = 3u;
    else if (node->opcode == PL_OPCODE_X86_AFFINE_ALU)
        descriptor_at = 4u;
    else return 0;
    if (node->argument_count <= descriptor_at) return 0;
    const pl_operand *word =
        &plan->arguments[node->argument_at + descriptor_at];
    if (word->kind != PL_OPERAND_CONST) return 0;
    pl_u64 group = (word->value >> 8u) & 7u;
    return group != 2u && group != 4u
        && !(word->value & (1ull << 11u));
}

static int semantic_rebases_flag_root(const pl_x86_semantic *semantic)
{
    if (!semantic) return 0;
    for (pl_u32 node = 0u; node < semantic->plan.node_count; ++node)
        if (source_node_rebases_flag_root(
                &semantic->plan, &semantic->plan.nodes[node]))
            return 1;
    return 0;
}

static void instruction_flag_liveness_masks(
    const pl_x86_instruction *instruction,
    const pl_x86_semantic *semantic,
    pl_u32 architectural_reads, pl_u32 architectural_writes,
    pl_u8 *reads, pl_u8 *writes)
{
    const pl_u32 flag_bit = 1u << PL_X86_RFLAGS_LOCAL;
    *reads = (architectural_reads & flag_bit)
           ? (pl_u8)FLAG_LIVE_ALL : 0u;
    *writes = (architectural_writes & flag_bit)
            ? (pl_u8)FLAG_LIVE_ALL : 0u;

    if (instruction->operation == PL_X86_OPERATION_FLAG_CONTROL) {
        switch (instruction->condition) {
        case 0u: /* CLC */
        case 1u: /* STC */
            *reads = 0u;
            *writes = (pl_u8)FLAG_LIVE_CARRY;
            return;
        case 2u: /* CMC */
            *reads = (pl_u8)FLAG_LIVE_CARRY;
            *writes = (pl_u8)FLAG_LIVE_CARRY;
            return;
        case 3u: /* CLD */
        case 4u: /* STD */
            *reads = 0u;
            *writes = (pl_u8)FLAG_LIVE_DIRECTION;
            return;
        case 5u: /* CLI */
        case 6u: /* STI */
            *reads = 0u;
            *writes = (pl_u8)FLAG_LIVE_INTERRUPT;
            return;
        default:
            return;
        }
    }

    /* A complete arithmetic producer has no carry input.  The old RFLAGS
     * operand in its semantic law supplies only lanes which x86 preserves;
     * those lanes flow through because they are absent from writes. */
    if (*writes && semantic_rebases_flag_root(semantic)) {
        *reads = 0u;
        *writes = (pl_u8)FLAG_LIVE_ARITHMETIC_ALL;
    }
}

int pl_select_derive_emitted_candidate_cost(
    const pl_x86_frontend *source_frontend,
    const pl_x86_block *source_block,
    pl_x86_native_selection *selection)
{
    if (!source_frontend || !source_block || !selection
            || !selection->supported
            || selection->output_bytes > NATIVE_COST_OUTPUT_BYTES)
        return PL_ERROR_X86_SELECT;
    if (!selection->output_bytes) {
        selection->output_instructions = 0u;
        selection->output_work = 0u;
        selection->output_span = 0u;
        return 0;
    }

    pl_u8 bytes[NATIVE_COST_OUTPUT_BYTES];
    pl_u32 written = 0u;
    int status = pl_x86_select_write_measured(
        source_frontend, source_block, selection,
        bytes, sizeof bytes, &written);
    if (status || written != selection->output_bytes)
        return status ? status : PL_ERROR_X86_SELECT;

    const pl_u64 base = 0x100000000ull;
    pl_x86_map map = {
        bytes, base, written, written,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, base };
    pl_x86_frontend frontend;
    status = pl_x86_frontend_open(&image, &frontend);
    if (status) return status;

    pl_u32 reads[NATIVE_COST_OUTPUT_BYTES];
    pl_u32 writes[NATIVE_COST_OUTPUT_BYTES];
    pl_u8 terminal[NATIVE_COST_OUTPUT_BYTES];
    pl_u8 register_copy[NATIVE_COST_OUTPUT_BYTES];
    pl_u8 complete_flags[NATIVE_COST_OUTPUT_BYTES];
    pl_u32 instruction_count = 0u;
    pl_u64 rip = base;
    while (rip < base + written) {
        if (instruction_count >= NATIVE_COST_OUTPUT_BYTES)
            return PL_ERROR_X86_SELECT;
        pl_x86_instruction instruction;
        status = pl_x86_frontend_decode(&frontend, rip, &instruction);
        if (status || !instruction.source_bytes
                || instruction.fallthrough <= rip
                || instruction.fallthrough > base + written)
            return status ? status : PL_ERROR_X86_SELECT;
        pl_u8 arena_bytes[NATIVE_COST_ARENA_BYTES];
        pl_arena arena = { arena_bytes, sizeof arena_bytes, 0u };
        pl_x86_semantic semantic;
        status = pl_x86_lower(&instruction, &arena, &semantic);
        if (status) return status;
        status = instruction_dependency_masks(
            &semantic, &reads[instruction_count],
            &writes[instruction_count]);
        if (status) return status;
        terminal[instruction_count] =
            (pl_u8)(instruction.flow != PL_X86_FLOW_NEXT);
        register_copy[instruction_count] =
            (pl_u8)instruction_is_register_copy(&instruction);
        complete_flags[instruction_count] =
            (pl_u8)semantic_rebases_flag_root(&semantic);
        ++instruction_count;
        rip = instruction.fallthrough;
    }
    if (rip != base + written || !instruction_count)
        return PL_ERROR_X86_SELECT;

    /* A partial flag update reads the lanes it preserves, but those lanes are
     * not a dependency when this instruction's complete RFLAGS publication
     * is dead before the accepted future.  Perform the same backward cut as
     * whole-block SSA before calculating physical instruction depth. */
    const pl_u32 flag_bit = 1u << PL_X86_RFLAGS_LOCAL;
    int flags_live = (source_block->live_output_mask & flag_bit) != 0u;
    for (pl_u32 index = instruction_count; index-- > 0u;) {
        if (writes[index] & flag_bit) {
            if (!flags_live) {
                reads[index] &= ~flag_bit;
                writes[index] &= ~flag_bit;
            } else if (complete_flags[index]) {
                flags_live = 0;
            }
        }
        if (reads[index] & flag_bit) flags_live = 1;
    }

    pl_u32 producer[PL_X86_LOCAL_COUNT] = { 0u };
    pl_u32 maximum = 0u;
    for (pl_u32 index = 0u; index < instruction_count; ++index) {
        pl_u32 depth = instruction_dependency_depth(
            reads[index], writes[index], terminal[index],
            register_copy[index], producer);
        if (depth > maximum) maximum = depth;
    }
    if (!maximum) return PL_ERROR_X86_SELECT;
    selection->output_instructions = instruction_count;
    selection->output_work = instruction_count;
    selection->output_span = maximum;
    return 0;
}

/* Work backward once from the accepted residual state.  The old probe formed
 * every source suffix independently; an m-instruction block therefore paid
 * m + (m - 1) + ... lowerings before selection.  Per-instruction source laws
 * already provide the exact architectural read/write cut.  Reverse liveness
 * finds the only prefix whose publications have no path to the accepted
 * future in O(m), then one normalized re-formation proves that the proposed
 * suffix has the complete same future.  The proof, rather than this cheap
 * candidate discovery, remains authoritative. */
int pl_select_equivalent_suffix_bytes(
    const pl_x86_frontend *frontend,
    const pl_x86_block_workspace *scratch,
    const pl_x86_block *block, pl_u32 *bytes)
{
    pl_u64 starts[PL_X86_NATIVE_MAX_FIXUPS];
    pl_u32 reads[PL_X86_NATIVE_MAX_FIXUPS];
    pl_u32 writes[PL_X86_NATIVE_MAX_FIXUPS];
    pl_u8 mandatory[PL_X86_NATIVE_MAX_FIXUPS];
    if (!frontend || !scratch || !block || !bytes
            || !block->instruction_count)
        return PL_ERROR_X86_SELECT;
    *bytes = 0u;
    /* Suffix discovery is a byte-size optimization, not part of semantic
     * closure.  Fixup capacity bounds the retained relocation bindings of a
     * selected spelling; it must never become an unrelated limit on source
     * block length.  The small backward probe currently uses that bounded
     * transient array, so a larger block keeps its complete exact source
     * representative.  Normalized grammar productions remain available and
     * the selector therefore stays total while this optional probe remains
     * allocation-free. */
    if (block->instruction_count > PL_X86_NATIVE_MAX_FIXUPS)
        return 0;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        starts[index] = rip;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        pl_arena arena = {
            scratch->first, scratch->bytes_each, 0u,
        };
        pl_x86_semantic semantic;
        status = pl_x86_lower(&instruction, &arena, &semantic);
        if (status) return status;
        status = instruction_dependency_masks(
            &semantic, &reads[index], &writes[index]);
        if (status) return status;
        mandatory[index] = (pl_u8)(
            instruction.flow != PL_X86_FLOW_NEXT
            || (instruction.flags & (PL_X86_INSTRUCTION_BARRIER
                                   | PL_X86_INSTRUCTION_MAY_TRAP))
            || semantic.has_fault_predicate
            || semantic.machine_operation != PL_X86_MACHINE_NONE
            || pl_select_plan_has_memory(&semantic.plan));
        rip = instruction.fallthrough;
    }
    if (rip != block->end) return PL_ERROR_X86_SELECT;

    pl_u32 live = block->live_output_mask;
    pl_u32 first = block->instruction_count;
    for (pl_u32 index = block->instruction_count; index-- > 0u;) {
        if (!mandatory[index] && !(writes[index] & live)) continue;
        first = index;
        live = (live & ~writes[index]) | reads[index];
    }
    if (!first || first == block->instruction_count) return 0;

    pl_u64 start = starts[first];
    pl_x86_block candidate;
    int status = pl_x86_block_lower_projected_suffix_until(
        frontend, start, block->end, block->live_output_mask,
        scratch, &candidate);
    if (status) return status;
    if (!same_semantic_block(block, &candidate)) return 0;
    if (start - block->start > U32_MAX_VALUE)
        return PL_ERROR_X86_SELECT;
    *bytes = (pl_u32)(start - block->start);
    return 0;
}

/* Project the complete future through the source instruction laws once and
 * emit only the instructions whose publications reach that future.  Unlike
 * the old suffix-only probe, this removes dead work between live operations.
 * The retained bytes are ordinary x86 selected by their already-normalized C
 * semantics; the mask is compiler workspace and never becomes an output
 * format or runtime route.  Memory, faults, machine operations and control
 * are mandatory cuts and therefore cannot disappear through this production.
 */
int pl_select_measure_direct_live_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->source_identity
            || block->instruction_count < 2u
            || block->instruction_count > 64u)
        return 0;

    pl_u32 reads[64u];
    pl_u32 writes[64u];
    pl_u8 flag_reads[64u];
    pl_u8 flag_writes[64u];
    pl_u8 mandatory[64u];
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        pl_u8 arena_bytes[NATIVE_COST_ARENA_BYTES];
        pl_arena arena = { arena_bytes, sizeof arena_bytes, 0u };
        pl_x86_semantic semantic;
        status = pl_x86_lower(&instruction, &arena, &semantic);
        if (status) return status;
        status = instruction_liveness_masks(
            &semantic, &reads[index], &writes[index]);
        if (status) return status;
        instruction_flag_liveness_masks(
            &instruction, &semantic, reads[index], writes[index],
            &flag_reads[index], &flag_writes[index]);
        reads[index] &= ~(1u << PL_X86_RFLAGS_LOCAL);
        writes[index] &= ~(1u << PL_X86_RFLAGS_LOCAL);
        mandatory[index] = (pl_u8)(
            instruction.flow != PL_X86_FLOW_NEXT
            || (instruction.flags & (PL_X86_INSTRUCTION_BARRIER
                                   | PL_X86_INSTRUCTION_MAY_TRAP))
            || semantic.has_fault_predicate
            || semantic.machine_operation != PL_X86_MACHINE_NONE
            || pl_select_plan_has_memory(&semantic.plan));
        rip = instruction.fallthrough;
    }
    if (rip != block->end) return PL_ERROR_X86_SELECT;

    const pl_u32 flag_bit = 1u << PL_X86_RFLAGS_LOCAL;
    pl_u32 live = block->live_output_mask & ~flag_bit;
    pl_u8 live_flags = (block->live_output_mask & flag_bit)
                     ? (pl_u8)FLAG_LIVE_ALL : 0u;
    pl_u64 retained = 0u;
    for (pl_u32 index = block->instruction_count; index-- > 0u;) {
        int observed = (writes[index] & live) != 0u
                    || (flag_writes[index] & live_flags) != 0u;
        if (!mandatory[index] && !observed) continue;
        retained |= 1ull << index;
        live = (live & ~writes[index]) | reads[index];
        live_flags = (pl_u8)(
            (live_flags & (pl_u8)~flag_writes[index])
            | flag_reads[index]);
    }
    pl_u64 complete = block->instruction_count == 64u
                    ? U64_MAX_VALUE
                    : (1ull << block->instruction_count) - 1ull;
    if (!retained || retained == complete) return 0;

    pl_u32 output_at = 0u;
    rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (retained & (1ull << index)) {
            int final = index + 1u == block->instruction_count;
            if (final && pl_select_source_terminal(&instruction)
                    && (instruction.flags
                        & PL_X86_INSTRUCTION_DIRECT_TARGET)) {
                int selected = pl_select_direct_control(
                    &instruction, output_at,
                    block->relax_short_control, selection);
                if (selected <= 0) return selected;
                output_at = selection->output_bytes;
            } else {
                int relocatable = pl_select_inspect_copied_instruction(
                    &instruction, output_at, selection);
                if (relocatable <= 0) return relocatable;
                if (output_at > U32_MAX_VALUE - instruction.source_bytes)
                    return PL_ERROR_X86_SELECT;
                output_at += instruction.source_bytes;
            }
        }
        rip = instruction.fallthrough;
    }
    if (!output_at) return 0;
    selection->source_bytes = (pl_u32)(block->end - block->start);
    selection->output_bytes = output_at;
    selection->projected_instruction_mask = retained;
    selection->supported = 1u;
    selection->copied_source = 0u;
    selection->direct_frame = 1u;
    selection->direct_live_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}
