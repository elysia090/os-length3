/* Straight-line block formation.  See include/postlink/block.h. */

#include <postlink/block.h>

#define TERMINAL_OBSERVATIONS 4u

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
    out->instruction_count = 0u;
    out->successor_count = 0u;
    out->kind = PL_X86_BLOCK_DIRECT;
    out->flow = PL_X86_FLOW_NEXT;
    out->dynamic_target = 0u;
    out->has_predicate = 0u;
    out->has_fault_predicate = 0u;
    out->trap_vector = 0u;
    out->machine_operation = PL_X86_MACHINE_NONE;
    out->reserved = 0u;
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
    if (instruction->flags & PL_X86_INSTRUCTION_TRAP_AFTER)
        out->plan.instructions = 1u;
    out->end = instruction->fallthrough > instruction->rip
             ? instruction->fallthrough
             : instruction->rip + instruction->source_bytes;
    return 0;
}

int pl_x86_block_lower(const pl_x86_frontend *frontend, pl_u64 start,
                       const pl_x86_block_workspace *workspace,
                       pl_x86_block *out)
{
    if (!frontend || !workspace || !out || !workspace->first
            || !workspace->second || !workspace->bytes_each
            || !workspace->maximum_instructions
            || workspace->first == workspace->second)
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
    pl_u32 maximum_instructions = follows_sti(frontend, start)
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
        if (count + 1u == maximum_instructions) break;
    }
    if (!accumulated || !out->instruction_count) return PL_ERROR_BLOCK;

    /* A complete flag overwrite preserves only the architectural bits that
     * no ALU changes.  Rebase those bits to the chain root before liveness;
     * otherwise a long arithmetic block retains a false serial dependency
     * through every intermediate RFLAGS publication. */
    pl_u32 rewrite_owner = owner ^ 1u;
    pl_arena rewrite_arena = arena_at(workspace, rewrite_owner);
    pl_plan rewritten;
    status = pl_rebase_overwritten_flags(
        accumulated, &rewrite_arena, &rewritten);
    if (status) return status;

    /* Close local quotient identities before liveness.  The rebased plan owns
     * all of its storage, so the original accumulation arena can be reused for
     * the forward substitution without retaining a second graph. */
    pl_u32 fold_owner = owner;
    pl_arena fold_arena = arena_at(workspace, fold_owner);
    pl_plan folded;
    status = pl_fold_local_physical(&rewritten, &fold_arena, &folded);
    if (status) return status;

    pl_u32 compact_owner = owner ^ 1u;
    pl_arena compact_arena = arena_at(workspace, compact_owner);
    pl_plan compacted;
    status = pl_compact_once(&folded, &compact_arena, &compacted);
    if (status) return status;
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
    } else {
        out->target = constant(next);
        out->predicate = constant(1u);
        out->successor[0] = next;
        out->successor_count = 1u;
    }
    return 0;
}

int pl_x86_block_wasm(const pl_x86_block *block,
                      const pl_u32 successor_rank[2],
                      pl_wasm_block *out)
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
    out->result_kind = primary_resolve ? PL_VM_RESOLVE_RIP : PL_VM_DIRECT;
    out->result_payload = primary_resolve || !block->successor_count
                        ? 0u : successor_rank[0];
    out->next_rip_operand = block->target;
    out->branch_predicate = block->predicate;
    out->alternate_rip = 0u;
    out->alternate_result_kind = PL_VM_DIRECT;
    out->alternate_result_payload = 0u;
    out->next_rip_relative = 0u;
    out->alternate_rip_relative = 0u;
    out->has_dynamic_rip = block->dynamic_target;
    out->has_branch_predicate = 0u;
    if (block->has_predicate) {
        if (block->successor_count != 2u || block->dynamic_target)
            return PL_ERROR_BLOCK;
        out->alternate_rip = block->successor[1];
        if (successor_rank[1] == PL_X86_BLOCK_RESOLVE_RANK) {
            out->alternate_result_kind = PL_VM_RESOLVE_RIP;
            out->alternate_result_payload = 0u;
        } else {
            out->alternate_result_kind = PL_VM_DIRECT;
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

int pl_x86_block_kernel_wasm(const pl_x86_block *block, pl_wasm_block *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->successor_count > 2u)
        return PL_ERROR_BLOCK;
    if (block->dynamic_target) {
        const pl_u32 resolve[2] = {
            PL_X86_BLOCK_RESOLVE_RANK, PL_X86_BLOCK_RESOLVE_RANK,
        };
        return pl_x86_block_wasm(block, resolve, out);
    }
    if ((!block->has_predicate && block->successor_count != 1u)
            || (block->has_predicate && block->successor_count != 2u))
        return PL_ERROR_BLOCK;
    out->plan = &block->plan;
    out->next_rip = 0u;
    out->result_kind = PL_VM_TRANSITION;
    out->result_payload = 0u;
    out->next_rip_operand = block->target;
    out->branch_predicate = block->predicate;
    out->alternate_rip = 0u;
    out->alternate_result_kind = PL_VM_TRANSITION;
    out->alternate_result_payload = 1u;
    out->next_rip_relative = 0u;
    out->alternate_rip_relative = 0u;
    out->has_dynamic_rip = 0u;
    out->has_branch_predicate = block->has_predicate;
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
    hash = mix(hash, plan->instructions);
    hash = mix(hash, plan->stack_inputs);
    hash = mix(hash, plan->span);
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
            || left->instructions != right->instructions
            || left->stack_inputs != right->stack_inputs
            || left->span != right->span
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

static int block_hash(const pl_x86_frontend *frontend,
                      const pl_x86_block *block, pl_u64 *out)
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
    hash = mix(hash, block->instruction_count);
    hash = mix(hash, block->successor_count);
    for (pl_u32 index = 0u; index < block->successor_count; ++index)
        hash = mix(hash, block->successor[index] - block->start);
    hash = hash_plan(hash, &block->plan);
    if (block->dynamic_target) hash = hash_operand(hash, block->target);
    if (block->has_predicate) hash = hash_operand(hash, block->predicate);
    if (block->has_fault_predicate)
        hash = hash_operand(hash, block->fault_predicate);
    if (block->machine_operation != PL_X86_MACHINE_NONE)
        hash = hash_operand(hash, block->machine_value);
    if (block->kind == PL_X86_BLOCK_MACHINE_BARRIER) {
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
                      const pl_x86_block *right, int *equal)
{
    *equal = 0;
    if (left->kind != right->kind || left->flow != right->flow
            || left->dynamic_target != right->dynamic_target
            || left->has_predicate != right->has_predicate
            || left->has_fault_predicate != right->has_fault_predicate
            || left->trap_vector != right->trap_vector
            || left->machine_operation != right->machine_operation
            || left->machine_argument != right->machine_argument
            || left->instruction_count != right->instruction_count
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
        if (left->successor[index] - left->start
                != right->successor[index] - right->start)
            return 0;
    if (left->kind == PL_X86_BLOCK_MACHINE_BARRIER) {
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
    for (pl_u32 index = 0u; index < hash_slot_count; ++index)
        hash_slots[index] = 0u;
    return 0;
}

int pl_x86_block_intern(pl_x86_block_builder *builder,
                        const pl_x86_block *block, pl_u32 *rank)
{
    if (!builder || !block || !rank || !builder->identities
            || !builder->hash_slots)
        return PL_ERROR_BLOCK;
    pl_u64 hash = 0u;
    int status = block_hash(&builder->frontend, block, &hash);
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
            pl_u32 fresh = builder->identity_count++;
            builder->identities[fresh].hash = hash;
            builder->identities[fresh].representative = block->start;
            builder->hash_slots[slot] = fresh + 1u;
            ++builder->admissions;
            *rank = fresh;
            return 0;
        }
        pl_u32 candidate = encoded - 1u;
        if (candidate >= builder->identity_count) return PL_ERROR_BLOCK;
        const pl_x86_block_identity *identity =
            &builder->identities[candidate];
        if (identity->hash == hash) {
            pl_x86_block representative;
            status = pl_x86_block_lower(
                &builder->frontend, identity->representative,
                &builder->comparison, &representative);
            if (status) return status;
            int equal = 0;
            status = same_block(
                &builder->frontend, block, &representative, &equal);
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

int pl_x86_block_rank_instruction(const pl_x86_instruction *instruction,
                                  void *context, pl_u32 *rank)
{
    pl_x86_block_builder *builder = context;
    if (!instruction || !builder || !rank) return PL_ERROR_BLOCK;
    pl_x86_block block;
    int status = pl_x86_block_lower(
        &builder->frontend, instruction->rip, &builder->formation, &block);
    return status ? status : pl_x86_block_intern(builder, &block, rank);
}
