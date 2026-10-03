#include "cut-internal.h"

static void return_if(cut_lowering *cut)
{
    cut_op(cut, 0x04u); cut_op(cut, 0x40u); /* if, empty block type */
    cut_const(cut, machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u));
    cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
}

static int flag_dependencies(cut_plan *plan)
{
    pl_u32 live = 0xfffu; /* The cut's outgoing architectural flags are observable. */
    for (pl_u32 rank = (pl_u32)plan->report.source_instructions; rank; ) {
        --rank;
        pl_u32 offset = plan->flag_frontier[rank];
        pl_x86_instruction instruction;
        if (pl_x86_decode(&plan->image, plan->report.entry + offset, &instruction))
            return WASM_COMPILER_ERROR_GRAMMAR;
        pl_u32 wanted = live & cut_flag_write_mask(&instruction);
        plan->flag_frontier[rank] = offset | (wanted << 16u);
        /* A consumer sees the incoming definition, including when the same
         * operation writes flags. Conditional zero-count shifts never kill
         * their predecessor. No future use is confused with a later kill. */
        live = (live & ~cut_flag_kill_mask(&instruction)) | cut_flag_read_mask(&instruction);
    }
    return 0;
}

int cut_prepare(const wasm_compiler *compiler, const wasm_cut_options *options,
                 cut_plan *plan)
{
    pl_elf_image elf;
    plan->image = (pl_x86_image){ 0 };
    if (pl_elf_open(compiler->image.bytes, compiler->image.length, &elf))
        return WASM_COMPILER_ERROR_PROOF;
    pl_u32 count = 0u;
    if (pl_x86_elf_map_count(&elf, &count)) return WASM_COMPILER_ERROR_PROOF;
    if (count > 64u) return WASM_COMPILER_ERROR_CAPACITY;
    if (pl_x86_image_from_elf(&elf, 0u, 1u, plan->maps, 64u, &plan->image)
            || !pl_x86_image_contains(&plan->image, options->entry)) return WASM_COMPILER_ERROR_INPUT;
    return cut_prepare_image(&plan->image, options, plan);
}

int cut_prepare_image(const pl_x86_image *image, const wasm_cut_options *options,
                       cut_plan *plan)
{
    pl_u64 rip = options->entry;
    plan->image = *image;
    plan->report = (wasm_cut_report){ 0 };
    plan->system_cut = 0u;
    plan->repeat_cut = 0u;
    plan->indirect_cut = 0u;
    plan->report.entry = rip;
    for (pl_u32 i = 0u; i < options->maximum_source_instructions; ++i) {
        if (i && (rip >> 12u) != (options->entry >> 12u)) {
            plan->report.boundary = WASM_CUT_LIMIT;
            break;
        }
        pl_x86_instruction instruction;
        if (pl_x86_decode(&plan->image, rip, &instruction)) {
            if (!i) return WASM_COMPILER_ERROR_GRAMMAR;
            plan->report.boundary = WASM_CUT_FAULT;
            plan->report.boundary_operation = PL_X86_OPERATION_FAULT;
            break;
        }
        /* Later instruction fetch must not fault ahead of an already retired
         * prefix. Only the first instruction may cross its executable page;
         * it then occupies a separate one-instruction cut. */
        int crossing = (instruction.rip >> 12u) != ((instruction.fallthrough - 1u) >> 12u);
        if (i && ((instruction.rip >> 12u) != (options->entry >> 12u) || crossing)) {
            plan->report.boundary = WASM_CUT_LIMIT;
            break;
        }
        int stack = cut_stack_supported(&instruction);
        int system = cut_system_supported(&instruction);
        int repeat = cut_repeat_supported(&instruction);
        int indirect = cut_indirect_supported(&instruction);
        if (system || stack || repeat || indirect || cut_memory_supported(&instruction)) {
            /* CONTROL describes a branch actually emitted in this cut,
             * never the possibly faulting successor of a pure prefix. */
            plan->report.boundary = indirect ? (i ? WASM_CUT_LIMIT : WASM_CUT_CONTROL)
                                            : system ? WASM_CUT_SYSTEM : WASM_CUT_MEMORY;
            plan->report.boundary_operation = instruction.operation;
            /* Commit the preceding pure slice before this possibly faulting
             * transfer. A memory cut starts at the transfer and contains no
             * earlier architectural writes to roll back. */
            if (!i) {
                plan->system_cut = (pl_u32)system;
                plan->repeat_cut = (pl_u32)repeat;
                plan->indirect_cut = (pl_u32)indirect;
                plan->report.source_instructions = 1u;
                plan->report.source_bytes = instruction.length;
                plan->flag_frontier[0] = 0u;
                if (indirect) plan->report.memory_bytes = instruction.operation == PL_X86_OPERATION_CALL
                    || instruction.operands[0].kind == PL_X86_OPERAND_MEMORY ? 8u : 0u;
                else if (!system) {
                    int store = instruction.operands[0].kind == PL_X86_OPERAND_MEMORY;
                    plan->report.memory_bytes = stack || repeat ? instruction.operand_width / 8u
                        : instruction.operands[store ? 0u : 1u].bits / 8u;
                }
                if (stack && (instruction.operation == PL_X86_OPERATION_CALL
                              || instruction.operation == PL_X86_OPERATION_RETURN)) {
                    plan->report.boundary = WASM_CUT_CONTROL;
                    plan->report.branch_target = instruction.target;
                }
                if (system == CUT_SYSTEM_FAR_RETURN || system == CUT_SYSTEM_INTERRUPT_RETURN)
                    plan->report.boundary = WASM_CUT_CONTROL;
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
        /* Only source coordinates are kept for the reverse dependency pass.
         * Later instructions stay in the entry page; a crossing first
         * instruction stands alone. Therefore this offset fits sixteen bits. */
        plan->flag_frontier[i] = (pl_u32)(rip - options->entry);
        ++plan->report.source_instructions;
        plan->report.source_bytes += instruction.length;
        rip = instruction.fallthrough;
        if (instruction.operation == PL_X86_OPERATION_BRANCH) {
            plan->report.boundary = WASM_CUT_CONTROL;
            plan->report.branch_target = instruction.target;
            break;
        }
        plan->report.boundary = WASM_CUT_LIMIT;
        if (crossing) break;
    }
    if (!plan->report.source_instructions) return WASM_COMPILER_ERROR_GRAMMAR;
    plan->report.continuation = rip;
    return flag_dependencies(plan);
}

int cut_emit_body(wasm_writer *writer, const cut_plan *plan, wasm_cut_report *report)
{
    cut_lowering cut = { 0 };
    pl_u64 rip = plan->report.entry;
    cut.writer = writer;
    cut.report = plan->report;
    cut.has_memory = plan->report.memory_bytes != 0u;
    cut.has_port = cut.has_memory || plan->indirect_cut || (plan->system_cut && plan->system_cut != CUT_SYSTEM_CPUID);
    cut.has_segment = plan->system_cut == CUT_SYSTEM_SEGMENT;
    cut.has_table = plan->system_cut == CUT_SYSTEM_TABLE;
    cut.has_far_return = plan->system_cut == CUT_SYSTEM_FAR_RETURN;
    cut.has_interrupt_return = plan->system_cut == CUT_SYSTEM_INTERRUPT_RETURN;
    cut.has_control_write = plan->system_cut == CUT_SYSTEM_CONTROL_WRITE;
    cut.has_msr = plan->system_cut == CUT_SYSTEM_MSR;
    cut.has_repeat = plan->repeat_cut;
    wasm_writer_uleb(writer, 1u);
    wasm_writer_uleb(writer, cut.has_repeat ? CUT_REPEAT_LOCALS
                           : cut.has_port ? CUT_MEMORY_LOCALS : CUT_LOCAL_COUNT);
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
    if (cut.has_port) {
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
    cut_get(&cut, CUT_FLAGS); cut_const(&cut, (cut.has_memory || cut.has_table) ? 0x40100u : 0x100u);
    cut_op(&cut, 0x83u); cut_op(&cut, 0x50u); cut_op(&cut, 0x45u); return_if(&cut);
    for (pl_u32 i = 0u; i < plan->report.source_instructions; ++i) {
        pl_x86_instruction instruction;
        if (pl_x86_decode(&plan->image, rip, &instruction)) return WASM_COMPILER_ERROR_GRAMMAR;
        cut.wanted_flags = plan->flag_frontier[i] >> 16u;
        if (plan->system_cut) cut_lower_system(&cut, &instruction);
        else if (plan->indirect_cut) cut_lower_indirect(&cut, &instruction);
        else if (cut.has_repeat) cut_lower_repeat(&cut, &instruction);
        else if (cut.has_memory && cut_stack_supported(&instruction)) cut_lower_stack(&cut, &instruction);
        else if (cut.has_memory) cut_lower_memory(&cut, &instruction);
        else cut_lower_instruction(&cut, &instruction);
        rip = instruction.fallthrough;
    }
    if (cut.report.boundary != WASM_CUT_CONTROL) {
        cut_const(&cut, rip); cut_set(&cut, CUT_NEXT);
    }
    for (pl_u32 i = 0u; i < MACHINE_X86_REGISTER_COUNT; ++i)
        if (cut.report.written_registers & (1u << i))
            cut_store(&cut, (pl_u32)offsetof(machine_state, registers) + i * 8u, i + 1u);
    /* RF is restored by IRETQ, and otherwise cleared only on successful
     * retirement. A pending fault or residency wait returns before here. */
    if (!cut.has_interrupt_return) {
        cut_get(&cut,CUT_FLAGS); cut_const(&cut,~0x10000ull); cut_op(&cut,0x83u);
        cut_set(&cut,CUT_FLAGS);
    }
    if (cut.report.flags_written || !cut.has_interrupt_return)
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
