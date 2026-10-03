#include "cut-internal.h"

static int binary_arithmetic(pl_u32 operation)
{
    return operation == PL_X86_OPERATION_ADD || operation == PL_X86_OPERATION_SUBTRACT
        || operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_OR
        || operation == PL_X86_OPERATION_XOR;
}

static int unary_arithmetic(pl_u32 operation)
{
    return operation == PL_X86_OPERATION_INCREMENT || operation == PL_X86_OPERATION_DECREMENT
        || operation == PL_X86_OPERATION_NEGATE || operation == PL_X86_OPERATION_COMPLEMENT;
}

static void unary_value(cut_lowering *cut, pl_u32 operation, pl_u32 width)
{
    if (operation == PL_X86_OPERATION_NEGATE) {
        cut_get(cut,CUT_LEFT); cut_set(cut,CUT_RIGHT);
        cut_const(cut,0u); cut_set(cut,CUT_LEFT);
    } else { cut_const(cut,1u); cut_set(cut,CUT_RIGHT); }
    cut_get(cut,CUT_LEFT);
    if (operation == PL_X86_OPERATION_COMPLEMENT) {
        cut_const(cut,~0ull); cut_op(cut,0x85u);
    } else {
        cut_get(cut,CUT_RIGHT); cut_op(cut,operation == PL_X86_OPERATION_INCREMENT ? 0x7cu : 0x7du);
    }
    cut_mask(cut,width); cut_set(cut,CUT_VALUE);
    /* INC/DEC never redefine CF; NOT never defines any flag. Flags stay
     * local SSA until the existing memory commit has succeeded. */
    if (operation != PL_X86_OPERATION_COMPLEMENT)
        cut_arithmetic_flags(cut,width,operation != PL_X86_OPERATION_INCREMENT,0,
            operation == PL_X86_OPERATION_NEGATE ? CUT_CARRY_NORMAL : CUT_CARRY_PRESERVE);
}

static void arithmetic(cut_lowering *cut, pl_u32 operation, pl_u32 width)
{
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT);
    cut_op(cut,operation == PL_X86_OPERATION_ADD ? 0x7cu
        : operation == PL_X86_OPERATION_SUBTRACT || operation == PL_X86_OPERATION_COMPARE ? 0x7du
        : operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_TEST ? 0x83u
        : operation == PL_X86_OPERATION_OR ? 0x84u : 0x85u);
    cut_mask(cut,width); cut_set(cut,CUT_VALUE);
    cut_arithmetic_flags(cut,width,
        operation == PL_X86_OPERATION_SUBTRACT || operation == PL_X86_OPERATION_COMPARE,
        operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_OR
            || operation == PL_X86_OPERATION_XOR || operation == PL_X86_OPERATION_TEST,0);
}

static void bit_value(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    cut_const(cut,1u); cut_get(cut,CUT_RIGHT); cut_const(cut,instruction->operands[0].bits-1u);
    cut_op(cut,0x83u); cut_op(cut,0x86u); cut_set(cut,CUT_RIGHT);
    /* CF observes the original bit. Undefined flags keep their incoming
     * representative; ZF and every defined non-arithmetic flag are unchanged. */
    cut_get(cut,CUT_FLAGS); cut_const(cut,~1ull); cut_op(cut,0x83u);
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x83u);
    cut_op(cut,0x50u); cut_op(cut,0x45u); cut_op(cut,0xadu); cut_op(cut,0x84u);
    cut_set(cut,CUT_FLAGS); cut->report.flags_written=1u;
    if (instruction->condition) {
        cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT);
        if (instruction->condition == 2u) { cut_const(cut,~0ull); cut_op(cut,0x85u); }
        cut_op(cut,instruction->condition == 1u ? 0x84u : instruction->condition == 2u ? 0x83u : 0x85u);
        cut_mask(cut,instruction->operands[0].bits); cut_set(cut,CUT_VALUE);
    }
}

static void bit_address(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_u32 width=instruction->operands[0].bits;
    /* floor(signed index / width) * (width/8) equals
     * (sign_extend(index) >> 3) & -(width/8). Arithmetic shift handles
     * negative indexes without division or a materialized bit string. */
    cut_get(cut,CUT_ADDRESS); cut_get(cut,CUT_RIGHT);
    if (width<64u) {
        cut_const(cut,64u-width); cut_op(cut,0x86u);
        cut_const(cut,64u-width); cut_op(cut,0x87u);
    }
    cut_const(cut,3u); cut_op(cut,0x87u);
    cut_const(cut,0u-(pl_u64)(width/8u)); cut_op(cut,0x83u);
    cut_op(cut,0x7cu); cut_mask(cut,instruction->address_width); cut_set(cut,CUT_ADDRESS);
}

static pl_x86_operand accumulator(pl_u32 width)
{
    pl_x86_operand result = {0};
    result.kind = PL_X86_OPERAND_REGISTER; result.bits = (pl_u16)width;
    result.value.reg.class_id = PL_X86_REGISTER_GPR;
    result.value.reg.bits = (pl_u16)width;
    return result;
}
static void exchange_value(cut_lowering *cut,pl_u32 width)
{
    /* Snapshot SRC and old DEST before the implicit accumulator can change.
     * Flags observe accumulator - old DEST, not SRC - DEST. */
    cut_get(cut,CUT_RIGHT); cut_set(cut,CUT_NEXT);
    cut_get(cut,CUT_LEFT); cut_set(cut,CUT_RIGHT);
    pl_x86_operand acc = accumulator(width);
    cut_read_operand(cut,&acc,width); cut_set(cut,CUT_LEFT);
    arithmetic(cut,PL_X86_OPERATION_COMPARE,width);
    cut_get(cut,CUT_NEXT); cut_get(cut,CUT_RIGHT);
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x51u);
    cut_op(cut,0x1bu); cut_set(cut,CUT_VALUE);
}

int cut_memory_supported(const pl_x86_instruction *instruction)
{
    int unary = unary_arithmetic(instruction->operation);
    int set = instruction->operation == PL_X86_OPERATION_CONDITIONAL_SET;
    int exchange = instruction->operation == PL_X86_OPERATION_COMPARE_EXCHANGE;
    int selector = cut_selector_read_supported(instruction);
    int multiply = instruction->operation == PL_X86_OPERATION_MULTIPLY_SIGNED
        || instruction->operation == PL_X86_OPERATION_MULTIPLY_UNSIGNED;
    int implicit = multiply && instruction->visible_operand_count == 1u;
    if (instruction->status != PL_X86_DECODE_VALID || instruction->flow != PL_X86_FLOW_NEXT
            || (instruction->machine_operation != PL_X86_MACHINE_NONE
                && !selector && !(exchange && instruction->machine_operation == PL_X86_MACHINE_ATOMIC))
            || (multiply ? !cut_multiply_supported(instruction)
                : instruction->visible_operand_count != (unary || set ? 1u : 2u))
            || ((instruction->flags & PL_X86_INSTRUCTION_LOCKED)
                && !(exchange && instruction->machine_operation == PL_X86_MACHINE_ATOMIC))
            || instruction->flags & (PL_X86_INSTRUCTION_PRIVILEGED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)
            || (instruction->address_width != 32u && instruction->address_width != 64u)) return 0;
    const pl_x86_operand *operands = instruction->operands;
    int first = operands[0].kind == PL_X86_OPERAND_MEMORY;
    if ((unary || set) && !first) return 0;
    if (set && (instruction->condition >= 16u || operands[0].bits != 8u)) return 0;
    int conditional = instruction->operation == PL_X86_OPERATION_CONDITIONAL_MOVE;
    if (exchange && (!first || operands[1].kind != PL_X86_OPERAND_REGISTER
            || !cut_gpr(&operands[1].value.reg) || operands[0].bits != operands[1].bits)) return 0;
    /* The accepted native descriptor retains this precise transaction as a
     * typed machine effect. This ordinary, non-shared-memory projection has
     * one serialized owner: reserve/commit is synchronous, with no intervening
     * guest writer, event or await. That closes LOCK too, not SMP/shared RAM.
     * Both forms specialize to SSA, never an atomic-op runtime callback. */
    if (exchange && instruction->machine_operation == PL_X86_MACHINE_ATOMIC
            && instruction->machine_argument != (2u | ((pl_u64)(operands[1].bits/8u)<<8u)
                | ((pl_u64)operands[1].value.reg.index<<16u)
                | ((pl_u64)!!(operands[1].value.reg.flags&PL_X86_REGISTER_HIGH8)<<24u))) return 0;
    if (conditional && (first || instruction->condition >= 16u
            || operands[0].bits < 16u || operands[0].bits != operands[1].bits)) return 0;
    int observe = instruction->operation == PL_X86_OPERATION_COMPARE
               || instruction->operation == PL_X86_OPERATION_TEST;
    int bit = instruction->operation == PL_X86_OPERATION_BIT_TEST;
    if (bit && (!first || instruction->condition >= 4u || operands[0].bits < 16u
            || (operands[1].kind != PL_X86_OPERAND_IMMEDIATE
                && (operands[1].kind != PL_X86_OPERAND_REGISTER
                    || !cut_gpr(&operands[1].value.reg) || operands[1].bits != operands[0].bits)))) return 0;
    const pl_x86_operand *memory = &operands[first ? 0u : 1u];
    if (memory->kind != PL_X86_OPERAND_MEMORY || (memory->bits != 8u
            && memory->bits != 16u && memory->bits != 32u && memory->bits != 64u)) return 0;
    if (observe) {
        const pl_x86_operand *other = &operands[first ? 1u : 0u];
        if ((other->kind != PL_X86_OPERAND_REGISTER || !cut_gpr(&other->value.reg))
                && !(first && other->kind == PL_X86_OPERAND_IMMEDIATE)) return 0;
    } else if (first && !unary && !set && !implicit) {
        if ((instruction->operation != PL_X86_OPERATION_MOVE && !binary_arithmetic(instruction->operation) && !bit && !exchange)
                || (operands[1].kind != PL_X86_OPERAND_IMMEDIATE
                    && (operands[1].kind != PL_X86_OPERAND_REGISTER
                        || (!selector && !cut_gpr(&operands[1].value.reg))))) return 0;
    } else if (!first && ((instruction->operation != PL_X86_OPERATION_MOVE && !binary_arithmetic(instruction->operation)
                 && !conditional && !multiply
                 && instruction->operation != PL_X86_OPERATION_MOVE_ZERO_EXTEND
                 && instruction->operation != PL_X86_OPERATION_MOVE_SIGN_EXTEND)
            || operands[0].kind != PL_X86_OPERAND_REGISTER
            || !cut_gpr(&operands[0].value.reg))) return 0;
    const pl_x86_memory *address = &memory->value.memory;
    return (address->segment.class_id == PL_X86_REGISTER_NONE
            || (address->segment.class_id == PL_X86_REGISTER_SEGMENT && address->segment.index < 4u))
        && (address->base.class_id == PL_X86_REGISTER_NONE
            || address->base.class_id == PL_X86_REGISTER_IP || cut_gpr(&address->base))
        && (address->index.class_id == PL_X86_REGISTER_NONE || cut_gpr(&address->index))
        && (address->scale == 0u || address->scale == 1u || address->scale == 2u
            || address->scale == 4u || address->scale == 8u)
        && ((instruction->rip >> 47u) == 0u || (instruction->rip >> 47u) == 0x1ffffu)
        && ((instruction->fallthrough >> 47u) == 0u || (instruction->fallthrough >> 47u) == 0x1ffffu);
}

void cut_lower_memory(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    int first = operands[0].kind == PL_X86_OPERAND_MEMORY;
    int unary = unary_arithmetic(instruction->operation);
    int set = instruction->operation == PL_X86_OPERATION_CONDITIONAL_SET;
    int exchange = instruction->operation == PL_X86_OPERATION_COMPARE_EXCHANGE;
    int bit = instruction->operation == PL_X86_OPERATION_BIT_TEST;
    int observe = instruction->operation == PL_X86_OPERATION_COMPARE
               || instruction->operation == PL_X86_OPERATION_TEST || (bit && !instruction->condition);
    int implicit = instruction->visible_operand_count == 1u
        && (instruction->operation == PL_X86_OPERATION_MULTIPLY_SIGNED
            || instruction->operation == PL_X86_OPERATION_MULTIPLY_UNSIGNED);
    int store = first && !observe && !implicit;
    int rmw = store && instruction->operation != PL_X86_OPERATION_MOVE && !set;
    int load_arithmetic = !first && binary_arithmetic(instruction->operation);
    int multiply = instruction->operation == PL_X86_OPERATION_MULTIPLY_SIGNED;
    const pl_x86_operand *memory = &operands[first ? 0u : 1u];
    cut_effective_address(cut, instruction, &memory->value.memory);
    cut_set(cut, CUT_ADDRESS);
    if (set) { cut_condition(cut,instruction->condition); cut_op(cut,0xadu); }
    else if (bit) cut_read_operand(cut,&operands[1],memory->bits);
    else if (store && !unary) cut_read_operand(cut, &operands[1], memory->bits);
    else cut_const(cut, 0u);
    cut_set(cut, rmw || bit ? CUT_RIGHT : CUT_VALUE);
    if (bit && operands[1].kind == PL_X86_OPERAND_REGISTER) bit_address(cut,instruction);
    cut->report.memory_bytes = memory->bits / 8u;
    cut->report.memory_access = store ? MACHINE_MEMORY_WRITE : MACHINE_MEMORY_READ;
    if (rmw) cut->report.memory_access |= MACHINE_MEMORY_READ;
    if (memory->value.memory.segment.class_id == PL_X86_REGISTER_SEGMENT
            && memory->value.memory.segment.index == 2u)
        cut->report.memory_access |= MACHINE_MEMORY_STACK;
    if (load_arithmetic || (multiply && instruction->visible_operand_count == 2u)) {
        // Capture the destination before loading through its aliased address.
        // A failed C read leaves both the parent register and flags untouched.
        cut_read_operand(cut,&operands[0],memory->bits); cut_set(cut,CUT_LEFT);
    }
    if (observe) {
        if (!bit) {
            cut_read_operand(cut,&operands[first ? 1u : 0u],memory->bits);
            cut_set(cut,first ? CUT_RIGHT : CUT_LEFT);
        }
        cut_access(cut); /* READ only, even when the first operand is memory. */
        cut_access_value(cut); cut_set(cut,first ? CUT_LEFT : CUT_RIGHT);
        if (bit) bit_value(cut,instruction);
        else arithmetic(cut,instruction->operation,memory->bits);
        return; /* No GPR/payload store; a failed load never commits flags. */
    }
    if (rmw) {
        /* Only the translation/reservation lives in C. The arithmetic and
         * live flags remain ordinary compiled SSA, not an operation callback. */
        cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
        cut_get(cut, CUT_ADDRESS);
        cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_bytes);
        cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_access);
        cut_op(cut, 0x10u); wasm_writer_uleb(cut->writer, 0u);
        cut_access_status(cut);
        cut_access_value(cut); cut_set(cut, CUT_LEFT);
        if (unary) unary_value(cut,instruction->operation,memory->bits);
        else if (bit) bit_value(cut,instruction);
        else if (exchange) exchange_value(cut,memory->bits);
        else arithmetic(cut,instruction->operation,memory->bits);
        cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
        cut_get(cut, CUT_VALUE);
        cut_op(cut, 0x10u); wasm_writer_uleb(cut->writer, 1u);
        cut_access_status(cut);
        if (exchange) {
            /* Both arms committed a memory write. Only mismatch writes the
             * accumulator; successful dword CMPXCHG preserves RAX[63:32]. */
            cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x52u);
            cut_op(cut,0x04u); cut_op(cut,0x40u);
            cut_get(cut,CUT_RIGHT); cut_set(cut,CUT_VALUE);
            pl_x86_operand acc = accumulator(memory->bits);
            cut_write_register(cut,&acc.value.reg); cut_op(cut,0x0bu);
        }
    } else cut_access(cut);
    if (!store) {
        cut_access_value(cut);
        if (implicit) {
            cut_set(cut,CUT_RIGHT);
            pl_x86_operand acc=accumulator(memory->bits);
            cut_read_operand(cut,&acc,memory->bits); cut_set(cut,CUT_LEFT);
            cut_implicit_multiply_value(cut,memory->bits,
                instruction->operation == PL_X86_OPERATION_MULTIPLY_SIGNED);
            return;
        }
        if (instruction->operation == PL_X86_OPERATION_CONDITIONAL_MOVE) {
            /* The temporary source load precedes the condition check, even
             * when false. A fault returns before any parent/RIP publication.
             * The common register write also zeroes a false 32-bit parent. */
            cut_read_operand(cut,&operands[0],memory->bits);
            cut_condition(cut,instruction->condition); cut_op(cut,0x1bu);
            cut_set(cut,CUT_VALUE);
        } else if (load_arithmetic) {
            cut_set(cut,CUT_RIGHT); arithmetic(cut,instruction->operation,memory->bits);
        } else if (multiply) {
            /* EA and the old two-operand destination are local before the
             * precise load. Even IMUL by zero must fault/wait on that load.
             * One shared product/overflow SSA serves register and memory
             * sources; no multiply opcode crosses the memory boundary. */
            cut_set(cut,instruction->visible_operand_count == 2u ? CUT_RIGHT : CUT_LEFT);
            if (instruction->visible_operand_count == 3u) {
                cut_read_operand(cut,&operands[2],memory->bits); cut_set(cut,CUT_RIGHT);
            }
            cut_multiply_value(cut,memory->bits);
        } else {
            if (instruction->operation == PL_X86_OPERATION_MOVE_SIGN_EXTEND) {
                cut_const(cut, 64u - memory->bits); cut_op(cut, 0x86u);
                cut_const(cut, 64u - memory->bits); cut_op(cut, 0x87u);
            }
            cut_mask(cut, operands[0].value.reg.bits); cut_set(cut, CUT_VALUE);
        }
        cut_write_register(cut, &operands[0].value.reg);
    }
}

void cut_access(cut_lowering *cut)
{
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u); /* private port parameter */
    cut_get(cut, CUT_ADDRESS);
    cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_bytes);
    cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_access);
    cut_get(cut, CUT_VALUE);
    cut_op(cut, 0x10u); wasm_writer_uleb(cut->writer, 0u); /* C RAM boundary */
    cut_access_status(cut);
}

void cut_access_status(cut_lowering *cut)
{
    cut_set(cut, CUT_STATUS);
    cut_get(cut, CUT_STATUS); cut_op(cut, 0x50u); cut_op(cut, 0x45u);
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    if (cut->has_repeat) {
        /* Architectural fault/residency wait starts the instruction. Entry
         * refusal or a stale port does not acquire that authority. */
        cut_get(cut,CUT_STATUS); cut_const(cut,6u); cut_op(cut,0x83u);
        cut_const(cut,2u); cut_op(cut,0x51u);
        cut_op(cut,0x04u); cut_op(cut,0x40u); cut_repeat_frontier(cut); cut_op(cut,0x0bu);
    }
    cut_get(cut, CUT_STATUS); cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
}

void cut_access_value(cut_lowering *cut)
{
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_op(cut, 0x29u); wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_port, value));
}
