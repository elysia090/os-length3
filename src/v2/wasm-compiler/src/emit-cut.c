#include "cut-internal.h"

static void return_if(cut_lowering *cut)
{
    cut_op(cut, 0x04u); cut_op(cut, 0x40u); /* if, empty block type */
    cut_const(cut, machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u));
    cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
}

int cut_prepare(const wasm_compiler *compiler, const wasm_cut_options *options,
                 cut_plan *plan)
{
    pl_elf_image elf;
    pl_u64 rip = options->entry;
    plan->report = (wasm_cut_report){ 0 };
    plan->image = (pl_x86_image){ 0 };
    for (pl_u32 bit = 0u; bit < 12u; ++bit) plan->last_flag_writer[bit] = ~0u;
    if (pl_elf_open(compiler->image.bytes, compiler->image.length, &elf))
        return WASM_COMPILER_ERROR_PROOF;
    pl_u32 count = 0u;
    if (pl_x86_elf_map_count(&elf, &count)) return WASM_COMPILER_ERROR_PROOF;
    if (count > 64u) return WASM_COMPILER_ERROR_CAPACITY;
    if (pl_x86_image_from_elf(&elf, 0u, 1u, plan->maps, 64u, &plan->image)
            || !pl_x86_image_contains(&plan->image, rip)) return WASM_COMPILER_ERROR_INPUT;
    plan->report.entry = rip;
    for (pl_u32 i = 0u; i < options->maximum_source_instructions; ++i) {
        pl_x86_instruction instruction;
        if (pl_x86_decode(&plan->image, rip, &instruction)) return WASM_COMPILER_ERROR_GRAMMAR;
        if (cut_memory_supported(&instruction)) {
            plan->report.boundary = WASM_CUT_MEMORY;
            plan->report.boundary_operation = instruction.operation;
            /* Commit the preceding pure slice before this possibly faulting
             * transfer. A memory cut starts at the transfer and contains no
             * earlier architectural writes to roll back. */
            if (!i) {
                plan->report.source_instructions = 1u;
                plan->report.source_bytes = instruction.length;
                int store = instruction.operands[0].kind == PL_X86_OPERAND_MEMORY;
                plan->report.memory_bytes = instruction.operands[store ? 0u : 1u].bits / 8u;
                rip = instruction.fallthrough;
            }
            break;
        }
        if (!cut_instruction_supported(&instruction)) {
            plan->report.boundary = instruction.flow == PL_X86_FLOW_FAULT
                                 ? WASM_CUT_FAULT : WASM_CUT_UNSUPPORTED;
            plan->report.boundary_operation = instruction.operation;
            break;
        }
        /* Accepted nonterminal transfers never consume arithmetic flags.
         * INC/DEC retain CF, and the terminating branch observes the final
         * definitions. Thus one last writer per bit is the complete frontier.
         * Adding ADC/CMOV or an interior flag consumer requires extending this
         * dependency proof, not treating it as another independent writer. */
        pl_u32 flags = cut_flag_write_mask(&instruction);
        for (pl_u32 bit = 0u; bit < 12u; ++bit)
            if (flags & (1u << bit)) plan->last_flag_writer[bit] = i;
        ++plan->report.source_instructions;
        plan->report.source_bytes += instruction.length;
        rip = instruction.fallthrough;
        if (instruction.operation == PL_X86_OPERATION_BRANCH) {
            plan->report.boundary = WASM_CUT_CONTROL;
            plan->report.branch_target = instruction.target;
            break;
        }
        plan->report.boundary = WASM_CUT_LIMIT;
    }
    if (!plan->report.source_instructions) return WASM_COMPILER_ERROR_GRAMMAR;
    plan->report.continuation = rip;
    return 0;
}

int cut_emit_body(wasm_writer *writer, const cut_plan *plan, wasm_cut_report *report)
{
    cut_lowering cut = { 0 };
    pl_u64 rip = plan->report.entry;
    cut.writer = writer;
    cut.report = plan->report;
    cut.extra_parameter = plan->report.memory_bytes != 0u;
    wasm_writer_uleb(writer, 1u);
    wasm_writer_uleb(writer, cut.extra_parameter ? CUT_MEMORY_LOCALS : CUT_LOCAL_COUNT);
    wasm_writer_byte(writer, 0x7eu);
    cut_get(&cut, 0u); cut_op(&cut, 0x41u); wasm_writer_uleb(writer, 7u);
    cut_op(&cut, 0x71u); return_if(&cut);
    /* Validate the whole state reservation before any access. i64 arithmetic
     * prevents wasm32 offset wrapping at the top of linear memory. */
    cut_get(&cut, 0u); cut_op(&cut, 0xadu);
    cut_const(&cut, sizeof(machine_state)); cut_op(&cut, 0x7cu);
    cut_op(&cut, 0x3fu); cut_op(&cut, 0u); cut_op(&cut, 0xadu);
    cut_const(&cut, 65536u); cut_op(&cut, 0x7eu);
    cut_op(&cut, 0x56u); return_if(&cut);
    if (cut.extra_parameter) {
        cut_op(&cut, 0x20u); wasm_writer_uleb(writer, 1u);
        cut_op(&cut, 0x41u); wasm_writer_uleb(writer, 7u); cut_op(&cut, 0x71u); return_if(&cut);
        cut_op(&cut, 0x20u); wasm_writer_uleb(writer, 1u); cut_op(&cut, 0xadu);
        cut_const(&cut, sizeof(machine_memory_port)); cut_op(&cut, 0x7cu);
        cut_op(&cut, 0x3fu); cut_op(&cut, 0u); cut_op(&cut, 0xadu);
        cut_const(&cut, 65536u); cut_op(&cut, 0x7eu); cut_op(&cut, 0x56u); return_if(&cut);
        /* Both ranges have been validated with non-wrapping i64 arithmetic. */
        cut_op(&cut, 0x20u); wasm_writer_uleb(writer, 1u); cut_op(&cut, 0xadu);
        cut_get(&cut, 0u); cut_op(&cut, 0xadu); cut_const(&cut, sizeof(machine_state));
        cut_op(&cut, 0x7cu); cut_op(&cut, 0x54u);
        cut_get(&cut, 0u); cut_op(&cut, 0xadu);
        cut_op(&cut, 0x20u); wasm_writer_uleb(writer, 1u); cut_op(&cut, 0xadu);
        cut_const(&cut, sizeof(machine_memory_port)); cut_op(&cut, 0x7cu); cut_op(&cut, 0x54u);
        cut_op(&cut, 0x71u); return_if(&cut);
    }
    cut_load(&cut, (pl_u32)offsetof(machine_state, rip));
    cut_const(&cut, rip); cut_op(&cut, 0x52u); return_if(&cut);
    cut_load(&cut, (pl_u32)offsetof(machine_state, rflags)); cut_set(&cut, CUT_FLAGS);
    cut_get(&cut, CUT_FLAGS); cut_const(&cut, cut.extra_parameter ? 0x50100u : 0x10100u);
    cut_op(&cut, 0x83u); cut_op(&cut, 0x50u); cut_op(&cut, 0x45u); return_if(&cut);
    for (pl_u32 i = 0u; i < plan->report.source_instructions; ++i) {
        pl_x86_instruction instruction;
        if (pl_x86_decode(&plan->image, rip, &instruction)) return WASM_COMPILER_ERROR_GRAMMAR;
        cut.wanted_flags = 0u;
        for (pl_u32 bit = 0u; bit < 12u; ++bit)
            if (plan->last_flag_writer[bit] == i) cut.wanted_flags |= 1u << bit;
        if (cut.extra_parameter) cut_lower_memory(&cut, &instruction);
        else cut_lower_instruction(&cut, &instruction);
        rip = instruction.fallthrough;
    }
    if (cut.report.boundary != WASM_CUT_CONTROL) {
        cut_const(&cut, rip); cut_set(&cut, CUT_NEXT);
    }
    for (pl_u32 i = 0u; i < MACHINE_X86_REGISTER_COUNT; ++i)
        if (cut.report.written_registers & (1u << i))
            cut_store(&cut, (pl_u32)offsetof(machine_state, registers) + i * 8u, i + 1u);
    if (cut.report.flags_written)
        cut_store(&cut, (pl_u32)offsetof(machine_state, rflags), CUT_FLAGS);
    cut_store(&cut, (pl_u32)offsetof(machine_state, rip), CUT_NEXT);
    cut_load(&cut, (pl_u32)offsetof(machine_state, retired));
    cut_const(&cut, cut.report.source_instructions); cut_op(&cut, 0x7cu);
    cut_set(&cut, CUT_VALUE);
    cut_store(&cut, (pl_u32)offsetof(machine_state, retired), CUT_VALUE);
    cut_const(&cut, machine_result_make(MACHINE_RESULT_RESOLVE_RIP, 0u)); cut_op(&cut, 0x0bu);
    if (writer->error) return writer->error;
    *report = cut.report;
    return 0;
}
