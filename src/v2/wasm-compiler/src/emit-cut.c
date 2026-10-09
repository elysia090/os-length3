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
        pl_u32 summary = plan->flag_frontier[rank];
        pl_u32 writes = summary & 0xfffu, reads = (summary >> 12u) & 0xfffu;
        pl_u32 kills = (summary & (1u << 24u)) ? writes : 0u;
        pl_u32 wanted = live & writes;
        plan->flag_frontier[rank] = wanted << 16u;
        /* A consumer sees the incoming definition, including when the same
         * operation writes flags. Conditional zero-count shifts never kill
         * their predecessor. No future use is confused with a later kill. */
        live = (live & ~kills) | reads;
    }
    return 0;
}

static int remember_flags(cut_plan *plan,pl_u32 rank,const pl_x86_instruction *instruction)
{
    pl_u32 writes=cut_flag_write_mask(instruction),kills=cut_flag_kill_mask(instruction);
    pl_u32 reads=cut_flag_read_mask(instruction);
    /* This grammar either definitely defines its write set or may preserve
     * every incoming flag (register-count shifts). Retain only that relation,
     * not a decoded instruction or a source coordinate to decode again. A
     * future partial-kill/out-of-domain extension must update this projection. */
    if(((writes|kills|reads)&~0xfffu) || (kills && kills!=writes))
        return WASM_COMPILER_ERROR_GRAMMAR;
    plan->flag_frontier[rank]=writes|(reads<<12u)|(kills?1u<<24u:0u);
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
    plan->string_cut = CUT_STRING_NONE;
    plan->indirect_cut = 0u;
    plan->operand_binding_kind = CUT_BIND_NONE;
    plan->fault_vector=0u;
    plan->report.entry = rip;
    for (pl_u32 i = 0u; i < options->maximum_source_instructions; ++i) {
        if (i && (rip >> 12u) != (options->entry >> 12u)) {
            plan->report.boundary = WASM_CUT_LIMIT;
            break;
        }
        pl_x86_instruction instruction;
        if (pl_x86_decode_profile(&plan->image, rip, &instruction)) {
            if (!i) return WASM_COMPILER_ERROR_GRAMMAR;
            plan->report.boundary = WASM_CUT_FAULT;
            plan->report.boundary_operation = PL_X86_OPERATION_FAULT;
            break;
        }
        if (!i && instruction.status == PL_X86_DECODE_FETCH_FAULT)
            return WASM_COMPILER_ERROR_FETCH;
        pl_x86_fault_cut fault;
        if(pl_x86_fault_cut_lower(&instruction,&fault)){
            plan->report.boundary=WASM_CUT_FAULT;plan->report.boundary_operation=PL_X86_OPERATION_FAULT;
            if(!i){
                plan->fault_vector=fault.vector;plan->report.source_instructions=1u;
                plan->report.source_bytes=fault.bytes;plan->flag_frontier[0]=0u;
            }
            break; /* An earlier pure prefix retires before this fault cut. */
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
        int string = cut_string_supported(&instruction);
        int indirect = cut_indirect_supported(&instruction);
        if (system || stack || string || indirect || cut_memory_supported(&instruction)) {
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
                plan->string_cut = (pl_u32)string;
                plan->indirect_cut = (pl_u32)indirect;
                plan->report.source_instructions = 1u;
                plan->report.source_bytes = instruction.length;
                /* One explicit relative address has one signed displacement.
                 * Keep its value in the attestation, not the body.
                 * Pure multi-instruction slices retain their literal values. */
                pl_u32 memory_operands = 0u;
                for (pl_u32 operand = 0u; operand < instruction.visible_operand_count; ++operand) {
                    const pl_x86_operand *value = instruction.operands + operand;
                    if (value->kind != PL_X86_OPERAND_MEMORY) continue;
                    ++memory_operands;
                    const pl_x86_memory *address = &value->value.memory;
                    int relative = (address->base.class_id == PL_X86_REGISTER_IP
                            && address->index.class_id == PL_X86_REGISTER_NONE)
                        || (address->base.class_id == PL_X86_REGISTER_GPR
                            && (address->index.class_id == PL_X86_REGISTER_NONE
                                || address->index.class_id == PL_X86_REGISTER_GPR));
                    if (relative
                            && (instruction.address_width == 32u || instruction.address_width == 64u)
                            && address->displacement >= -2147483647ll - 1ll
                            && address->displacement <= 2147483647ll) {
                        plan->operand_binding_kind = CUT_BIND_MEMORY_DISPLACEMENT;
                        plan->report.operand_binding = (pl_u32)address->displacement;
                    }
                }
                if (memory_operands != 1u) {
                    plan->operand_binding_kind = CUT_BIND_NONE;
                    plan->report.operand_binding = 0u;
                }
                if (stack && instruction.operation==PL_X86_OPERATION_CALL
                        && (instruction.flags&PL_X86_INSTRUCTION_DIRECT_TARGET)) {
                    /* The implicit return-address store depends on entry and
                     * source length, not on the one direct destination.
                     * The latter is an existing signed rel32 attestation. */
                    pl_u64 displacement=instruction.target-instruction.fallthrough;
                    if(displacement<=0x7fffffffull || displacement>=0xffffffff80000000ull) {
                        plan->operand_binding_kind=CUT_BIND_CONTROL_DISPLACEMENT;
                        plan->report.operand_binding=(pl_u32)displacement;
                    }
                }
                if(remember_flags(plan,0u,&instruction))return WASM_COMPILER_ERROR_GRAMMAR;
                if (indirect) plan->report.memory_bytes = instruction.operation == PL_X86_OPERATION_CALL
                    || instruction.operands[0].kind == PL_X86_OPERAND_MEMORY ? 8u : 0u;
                else if (system==CUT_SYSTEM_FXSAVE || system==CUT_SYSTEM_FXRSTOR)
                    plan->report.memory_bytes=instruction.operands[0].bits/8u;
                else if (system==CUT_SYSTEM_MXCSR) plan->report.memory_bytes=4u;
                else if ((system==CUT_SYSTEM_X87_LOAD||system==CUT_SYSTEM_X87_ARITHMETIC||system==CUT_SYSTEM_X87_STORE)&&instruction.operands[0].kind==PL_X86_OPERAND_MEMORY)
                    plan->report.memory_bytes=instruction.operands[0].bits/8u;
                else if (system==CUT_SYSTEM_X87_STATUS_COMPARE&&instruction.visible_operand_count&&instruction.operands[0].kind==PL_X86_OPERAND_MEMORY) plan->report.memory_bytes=instruction.operands[0].bits/8u;
                else if(system==CUT_SYSTEM_STRING_IO)plan->report.memory_bytes=(pl_u32)instruction.machine_argument&255u;
                else if(system==CUT_SYSTEM_VECTOR_INTEGER_FLOAT)plan->report.memory_bytes=instruction.operands[1].kind==PL_X86_OPERAND_MEMORY?instruction.operands[1].bits/8u:0u;
                else if(system==CUT_SYSTEM_VECTOR_FLOAT_INTEGER)plan->report.memory_bytes=instruction.operands[1].kind==PL_X86_OPERAND_MEMORY?instruction.operands[1].bits/8u:0u;
                else if(system==CUT_SYSTEM_FLOAT_COMPARE)plan->report.memory_bytes=instruction.operands[1].kind==PL_X86_OPERAND_MEMORY?instruction.operands[1].bits/8u:0u;
                else if(system==CUT_SYSTEM_FLOAT_ARITHMETIC)plan->report.memory_bytes=instruction.operands[1].kind==PL_X86_OPERAND_MEMORY?instruction.operands[1].bits/8u:0u;
                else if(system==CUT_SYSTEM_SELECTOR_QUERY)plan->report.memory_bytes=instruction.operands[1].kind==PL_X86_OPERAND_MEMORY?2u:0u;
                else if(system==CUT_SYSTEM_FAR_TRANSFER)plan->report.memory_bytes=instruction.operands[0].bits/8u;
                else if (system==CUT_SYSTEM_VECTOR_TRANSFER)
                {pl_x86_vector_binary law;pl_x86_vector_shift shift;pl_x86_vector_unpack unpack;pl_x86_mmx_shuffle shuffle;plan->report.memory_bytes=pl_x86_mmx_shuffle_lower(&instruction,&shuffle)?(shuffle.source_memory?8u:0u):pl_x86_vector_unpack_lower(&instruction,&unpack)?(unpack.source_memory?unpack.source_bytes:0u):pl_x86_vector_shift_lower(&instruction,&shift)?(shift.source_memory?shift.register_bytes:0u):pl_x86_vector_binary_lower(&instruction,&law)?(law.source_memory?law.register_bytes:0u):(instruction.machine_argument&(3ull<<24u))?16u:0u;}
                else if (system==CUT_SYSTEM_VECTOR_SCALAR)
                {pl_x86_mmx_transfer law;pl_x86_scalar_vector_transfer lane;plan->report.memory_bytes=pl_x86_scalar_vector_transfer_lower(&instruction,&lane)?(lane.source_memory||lane.target_memory?lane.bytes:0u):pl_x86_mmx_transfer_lower(&instruction,&law)?(law.source_memory||law.target_memory?law.bytes:0u):
                    (instruction.machine_argument&(3ull<<24u))?(instruction.machine_argument&255u)==9u?4u:8u:0u;}
                else if((system==CUT_SYSTEM_SELECTOR_SNAPSHOT || system==CUT_SYSTEM_X87_SNAPSHOT)
                    && instruction.operands[0].kind==PL_X86_OPERAND_MEMORY)
                    plan->report.memory_bytes=2u;
                else if (system==CUT_SYSTEM_SEGMENT
                        && instruction.operands[instruction.machine_operation==PL_X86_MACHINE_SYSTEM_SELECTOR
                            ?0u:1u].kind==PL_X86_OPERAND_MEMORY)
                    plan->report.memory_bytes=2u;
                else if (!system) {
                    int store = instruction.operands[0].kind == PL_X86_OPERAND_MEMORY;
                    plan->report.memory_bytes = instruction.operation==PL_X86_OPERATION_TRANSLATE_BYTE?1u:stack || string ? instruction.operand_width / 8u
                        : instruction.operands[store ? 0u : 1u].bits / 8u;
                }
                if (stack && (instruction.operation == PL_X86_OPERATION_CALL
                              || instruction.operation == PL_X86_OPERATION_RETURN)) {
                    plan->report.boundary = WASM_CUT_CONTROL;
                    plan->report.branch_target = instruction.target;
                }
                if(system==CUT_SYSTEM_COUNTER_BRANCH){
                    plan->report.branch_target=instruction.target;
                    pl_u64 displacement=instruction.target-instruction.fallthrough;
                    if(displacement<=0x7fffffffull || displacement>=0xffffffff80000000ull){
                        plan->operand_binding_kind=CUT_BIND_CONTROL_DISPLACEMENT;
                        plan->report.operand_binding=(pl_u32)displacement;
                    }
                }
                if (system == CUT_SYSTEM_FAR_RETURN || system == CUT_SYSTEM_INTERRUPT_RETURN || system==CUT_SYSTEM_COUNTER_BRANCH
                        || system == CUT_SYSTEM_SOFTWARE_INTERRUPT || system==CUT_SYSTEM_PRIVILEGE_TRANSFER || system==CUT_SYSTEM_FAR_TRANSFER)
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
        /* A single MOV has one value binding, not a different body for every
         * literal. Do not split a stronger multi-instruction slice to obtain
         * this sharing, or rebind another immediate in that slice. */
        if(i && plan->operand_binding_kind>=CUT_BIND_IMMEDIATE_UNSIGNED){
            plan->operand_binding_kind=CUT_BIND_NONE;plan->report.operand_binding=0u;
        }
        if(!i && instruction.operation==PL_X86_OPERATION_MOVE
                && instruction.visible_operand_count==2u
                && instruction.operands[0].kind==PL_X86_OPERAND_REGISTER
                && cut_gpr(&instruction.operands[0].value.reg)
                && instruction.operands[1].kind==PL_X86_OPERAND_IMMEDIATE){
            pl_u64 value=instruction.operands[1].value.immediate;
            if(instruction.operands[0].bits<64u)value&=(1ull<<instruction.operands[0].bits)-1u;
            if(value<=0xffffffffu || value>=0xffffffff80000000ull){
                plan->operand_binding_kind=value<=0xffffffffu?CUT_BIND_IMMEDIATE_UNSIGNED:CUT_BIND_IMMEDIATE_SIGNED;
                plan->report.operand_binding=(pl_u32)value;
            }
        }
        if(remember_flags(plan,i,&instruction))return WASM_COMPILER_ERROR_GRAMMAR;
        ++plan->report.source_instructions;
        plan->report.source_bytes += instruction.length;
        rip = instruction.fallthrough;
        if (instruction.operation == PL_X86_OPERATION_BRANCH) {
            plan->report.boundary = WASM_CUT_CONTROL;
            plan->report.branch_target = instruction.target;
            /* One final pure branch has one decoded rel8/rel32 displacement.
             * Its prefix (including any LEA literal) is not rebound. Subtract
             * unsigned coordinates to avoid signed overflow at high entries. */
            pl_u64 displacement = instruction.target - instruction.fallthrough;
            if (displacement <= 0x7fffffffull || displacement >= 0xffffffff80000000ull) {
                plan->operand_binding_kind = CUT_BIND_CONTROL_DISPLACEMENT;
                plan->report.operand_binding = (pl_u32)displacement;
            }
            break;
        }
        plan->report.boundary = WASM_CUT_LIMIT;
        if (crossing) break;
    }
    if (!plan->report.source_instructions) return WASM_COMPILER_ERROR_GRAMMAR;
    plan->report.continuation = rip;
    return flag_dependencies(plan);
}

static int prologue(wasm_writer *writer,const cut_plan *plan,cut_lowering *state)
{
    cut_lowering cut = { 0 };
    pl_u64 rip = plan->report.entry;
    cut.writer = writer;
    cut.import_slots=state->import_slots;
    cut.report = plan->report;
    cut.operand_binding_kind = plan->operand_binding_kind;
    cut.has_memory = plan->report.memory_bytes != 0u;
    cut.has_port = cut.has_memory || plan->indirect_cut || plan->fault_vector || (plan->system_cut
        && plan->system_cut != CUT_SYSTEM_CPUID && plan->system_cut != CUT_SYSTEM_SELECTOR_READ
        && plan->system_cut != CUT_SYSTEM_MEMORY_ORDER);
    cut.has_segment = plan->system_cut == CUT_SYSTEM_SEGMENT;
    cut.has_table = plan->system_cut == CUT_SYSTEM_TABLE;
    cut.has_far_return = plan->system_cut == CUT_SYSTEM_FAR_RETURN;
    cut.has_interrupt_return = plan->system_cut == CUT_SYSTEM_INTERRUPT_RETURN;
    cut.has_control_write = plan->system_cut == CUT_SYSTEM_CONTROL_WRITE;
    cut.has_msr = plan->system_cut == CUT_SYSTEM_MSR;
    cut.has_debug = plan->system_cut == CUT_SYSTEM_DEBUG;
    cut.has_repeat = plan->string_cut == CUT_STRING_REPEAT;
    pl_u32 permutation_local=0u;
    if(plan->system_cut==CUT_SYSTEM_VECTOR_TRANSFER) {
        pl_x86_instruction instruction;
        if(pl_x86_decode_profile(&plan->image,rip,&instruction))return WASM_COMPILER_ERROR_GRAMMAR;
        permutation_local=(pl_u32)cut_vector_projection_local(&instruction);
        pl_u32 binary_locals=(pl_u32)cut_vector_binary_local(&instruction);
        if(binary_locals>permutation_local)permutation_local=binary_locals;
        pl_x86_vector_shift shift;if(pl_x86_vector_shift_lower(&instruction,&shift)&&shift.register_bytes==8u)permutation_local=1u;
        pl_x86_vector_unpack unpack;if(pl_x86_vector_unpack_lower(&instruction,&unpack)&&unpack.register_bytes==8u)permutation_local=1u;
        pl_x86_mmx_shuffle shuffle;if(pl_x86_mmx_shuffle_lower(&instruction,&shuffle))permutation_local=1u;
    }
    pl_u32 locals=cut.has_repeat?CUT_REPEAT_LOCALS:cut.has_port?CUT_MEMORY_LOCALS:CUT_LOCAL_COUNT;
    if(plan->system_cut==CUT_SYSTEM_VECTOR_TRANSFER){pl_x86_instruction i;pl_x86_vector_shift law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_vector_shift_lower(&i,&law))locals=28u;}
    if(plan->system_cut==CUT_SYSTEM_VECTOR_TRANSFER){pl_x86_instruction i;pl_x86_vector_unpack law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_vector_unpack_lower(&i,&law)&&law.register_bytes==8u)locals=64u;}
    if(plan->system_cut==CUT_SYSTEM_VECTOR_TRANSFER){pl_x86_instruction i;pl_x86_mmx_shuffle law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_mmx_shuffle_lower(&i,&law))locals=64u;}
    if(plan->system_cut==CUT_SYSTEM_FXSAVE||plan->system_cut==CUT_SYSTEM_FXRSTOR){pl_x86_instruction i;pl_x86_x87_environment law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_x87_environment_lower(&i,&law))locals=48u;}
    if(plan->system_cut==CUT_SYSTEM_VECTOR_INTEGER_FLOAT){pl_x86_instruction i;pl_x86_vector_integer_float law;
        if(pl_x86_decode_profile(&plan->image,rip,&i)||!pl_x86_vector_integer_float_lower(&i,&law))return WASM_COMPILER_ERROR_GRAMMAR;
        if(law.source_class==PL_X86_REGISTER_MMX){permutation_local=5u;locals=26u;}else locals=32u+PL_X86_SIGNED_FLOAT_MAX_NODES;}
    if(plan->system_cut==CUT_SYSTEM_VECTOR_FLOAT_INTEGER){permutation_local=3u;locals=26u;}
    if(plan->system_cut==CUT_SYSTEM_FLOAT_COMPARE)locals=32u+PL_X86_FLOAT_COMPARE_MAX_NODES;
    if(plan->system_cut==CUT_SYSTEM_FLOAT_ARITHMETIC)locals=40u+PL_X86_X87_ARITHMETIC_MAX_NODES;
    if(plan->system_cut==CUT_SYSTEM_SELECTOR_QUERY)locals=32u+PL_X86_SELECTOR_QUERY_MAX_NODES;
    if(plan->system_cut==CUT_SYSTEM_VECTOR_TRANSFER){pl_x86_instruction i;pl_x86_vector_binary law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_vector_binary_lower(&i,&law)&&law.register_bytes==8u)locals=26u;}
    if(plan->system_cut==CUT_SYSTEM_VECTOR_SCALAR){pl_x86_instruction i;pl_x86_mmx_transfer law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_mmx_transfer_lower(&i,&law)){locals=26u;permutation_local=1u;}}
    if(plan->system_cut==CUT_SYSTEM_VECTOR_SCALAR){pl_x86_instruction i;pl_x86_vector_extract law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_vector_extract_lower(&i,&law)&&law.mmx){locals=26u;permutation_local=1u;}}
    pl_u32 checkpoint=0u;
    if(plan->system_cut==CUT_SYSTEM_FAR_TRANSFER){locals=32u;checkpoint=1u;}
    if(plan->system_cut==CUT_SYSTEM_SELECTOR_QUERY){pl_x86_instruction i;pl_x86_selector_query law;
        if(pl_x86_decode_profile(&plan->image,rip,&i)||!pl_x86_selector_query_lower(&i,&law))return WASM_COMPILER_ERROR_GRAMMAR;
        checkpoint=law.source_memory;}
    if(plan->report.boundary_operation==PL_X86_OPERATION_ENTER){locals=CUT_ENTER_LOCALS;checkpoint=1u;}
    if(plan->system_cut==CUT_SYSTEM_STRING_IO){locals=CUT_STRING_IO_LOCALS;checkpoint=1u;}
    if(plan->system_cut==CUT_SYSTEM_X87_COMPARE)locals=CUT_X87_LOCALS;
    if(plan->system_cut==CUT_SYSTEM_X87_EXCHANGE)locals=72u;
    if(plan->system_cut==CUT_SYSTEM_X87_TRANSFER)locals=80u;
    /* Logical slot 1 is the first declared local (engine index 4). */
    if(plan->system_cut==CUT_SYSTEM_X87_STACK)locals=28u+PL_X86_X87_STACK_MAX_NODES;
    if(plan->system_cut==CUT_SYSTEM_X87_LOAD)locals=CUT_X87_LOCALS;
    if(plan->system_cut==CUT_SYSTEM_X87_STORE)locals=38u+PL_X86_X87_FLOAT_STORE_MAX_NODES;
    if(plan->system_cut==CUT_SYSTEM_X87_STORE){pl_x86_instruction i;pl_x86_x87_bcd law;
        if(!pl_x86_decode_profile(&plan->image,rip,&i)&&pl_x86_x87_bcd_lower(&i,&law))locals=38u+PL_X86_X87_BCD_STORE_MAX_NODES;}
    if(plan->system_cut==CUT_SYSTEM_X87_ARITHMETIC)locals=CUT_X87_ARITHMETIC_LOCALS;
    if(plan->system_cut==CUT_SYSTEM_X87_STATUS_COMPARE)locals=CUT_X87_STATUS_LOCALS;
    if(plan->report.boundary_operation==PL_X86_OPERATION_DIVIDE_UNSIGNED||plan->report.boundary_operation==PL_X86_OPERATION_DIVIDE_SIGNED){
        pl_x86_instruction division;
        if(pl_x86_decode_profile(&plan->image,rip,&division))return WASM_COMPILER_ERROR_GRAMMAR;
        if(division.operand_width==64u)locals=192u;
    }
    cut.vector_local = locals + 4u; /* Four typed bindings precede locals. */
    cut.vector_aux=cut.vector_local+1u;cut.vector_result=cut.vector_local+2u;
    wasm_writer_uleb(writer, permutation_local?2u:1u);
    wasm_writer_uleb(writer, locals);
    wasm_writer_byte(writer, 0x7eu);
    if(permutation_local) {wasm_writer_uleb(writer,permutation_local);wasm_writer_byte(writer,0x7bu);}
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
        pl_u32 port_bytes=checkpoint?sizeof(machine_memory_checkpoint_port):plan->system_cut==CUT_SYSTEM_SELECTOR_QUERY?sizeof(machine_memory_pair_port):plan->system_cut==CUT_SYSTEM_FXRSTOR ? sizeof(machine_memory_extent_port)
            : (plan->report.memory_bytes==10u||plan->report.memory_bytes==16u) ? sizeof(machine_memory_pair_port) : sizeof(machine_memory_port);
        cut_const(&cut, port_bytes); cut_op(&cut, 0x7cu);
        cut_op(&cut, 0x3fu); cut_op(&cut, 0u); cut_op(&cut, 0xadu);
        cut_const(&cut, 65536u); cut_op(&cut, 0x7eu); cut_op(&cut, 0x56u); return_if(&cut);
        /* Both ranges have been validated with non-wrapping i64 arithmetic. */
        cut_op(&cut, 0x20u); wasm_writer_uleb(writer, 1u); cut_op(&cut, 0xadu);
        cut_get(&cut, 0u); cut_op(&cut, 0xadu); cut_const(&cut, sizeof(machine_state));
        cut_op(&cut, 0x7cu); cut_op(&cut, 0x54u);
        cut_get(&cut, 0u); cut_op(&cut, 0xadu);
        cut_op(&cut, 0x20u); wasm_writer_uleb(writer, 1u); cut_op(&cut, 0xadu);
        cut_const(&cut, port_bytes); cut_op(&cut, 0x7cu); cut_op(&cut, 0x54u);
        cut_op(&cut, 0x71u); return_if(&cut);
    }
    cut_load(&cut,offsetof(machine_state,system)+(MACHINE_SYSTEM_DR0+7u)*8u);
    cut_const(&cut,255u); cut_op(&cut,0x83u); cut_op(&cut,0x50u); cut_op(&cut,0x45u);
    return_if(&cut);
    cut_load(&cut, (pl_u32)offsetof(machine_state, rip));
    cut_coordinate(&cut, rip); cut_op(&cut, 0x52u); return_if(&cut);
    cut_load(&cut, (pl_u32)offsetof(machine_state, rflags)); cut_set(&cut, CUT_FLAGS);
    cut_get(&cut, CUT_FLAGS); cut_const(&cut, (cut.has_memory || cut.has_table) ? 0x40100u : 0x100u);
    cut_op(&cut, 0x83u); cut_op(&cut, 0x50u); cut_op(&cut, 0x45u); return_if(&cut);
    if(plan->fault_vector){
        /* No register, RIP, RF or retirement is published by a pending fault.
         * Delivery/CR2/frame effects belong to the ordinary C event owner. */
        cut_op(&cut,0x20u);wasm_writer_uleb(writer,1u);cut_coordinate(&cut,rip);
        cut_op(&cut,0x37u);wasm_writer_uleb(writer,3u);wasm_writer_uleb(writer,offsetof(machine_memory_port,fault_address));
        cut_op(&cut,0x20u);wasm_writer_uleb(writer,1u);cut_const(&cut,plan->fault_vector);
        cut_op(&cut,0x37u);wasm_writer_uleb(writer,3u);wasm_writer_uleb(writer,offsetof(machine_memory_port,fault_vector));
        cut_const(&cut,machine_result_make(MACHINE_RESULT_FAULT,plan->fault_vector));cut_op(&cut,0x0bu);
        if(writer->error)return writer->error;
        *state=cut;return 0;
    }
    *state=cut;return writer->error;
}

static int instruction_fragment(wasm_writer *writer,const cut_plan *plan,pl_u32 rank,
    pl_u64 *rip,cut_lowering *state)
{
    cut_lowering cut=*state;cut.writer=writer;pl_x86_instruction instruction;
    if(pl_x86_decode_profile(&plan->image,*rip,&instruction))return WASM_COMPILER_ERROR_GRAMMAR;
    cut.wanted_flags=plan->flag_frontier[rank]>>16u;
    if(plan->system_cut)cut_lower_system(&cut,&instruction);
    else if(plan->indirect_cut)cut_lower_indirect(&cut,&instruction);
    else if(plan->string_cut)cut_lower_string(&cut,&instruction);
    else if(cut.has_memory && cut_stack_supported(&instruction))cut_lower_stack(&cut,&instruction);
    else if(cut.has_memory)cut_lower_memory(&cut,&instruction);
    else cut_lower_instruction(&cut,&instruction);
    *rip=instruction.fallthrough;*state=cut;return writer->error;
}

static int epilogue(wasm_writer *writer,const cut_plan *plan,pl_u64 rip,cut_lowering *state)
{
    cut_lowering cut=*state;cut.writer=writer;
    if (cut.report.boundary != WASM_CUT_CONTROL) {
        cut_coordinate(&cut, rip); cut_set(&cut, CUT_NEXT);
    }
    if (plan->system_cut != CUT_SYSTEM_PRIVILEGE_TRANSFER) {
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
    }
    cut_load(&cut, (pl_u32)offsetof(machine_state, retired));
    cut_const(&cut, cut.report.source_instructions); cut_op(&cut, 0x7cu);
    cut_set(&cut, CUT_VALUE);
    cut_store(&cut, (pl_u32)offsetof(machine_state, retired), CUT_VALUE);
    cut_const(&cut, machine_result_make(plan->system_cut == CUT_SYSTEM_HALT
        ? MACHINE_RESULT_HALT : MACHINE_RESULT_RESOLVE_RIP, 0u)); cut_op(&cut, 0x0bu);
    if (writer->error) return writer->error;
    *state=cut;return 0;
}

void cut_body_open(const cut_plan *plan,const pl_u32 *import_slots,cut_body_cursor *cursor)
{
    *cursor=(cut_body_cursor){.plan=plan,.rip=plan->report.entry};
    cursor->cut.import_slots=import_slots;
}

int cut_body_next(cut_body_cursor *cursor,wasm_writer *writer)
{
    if(cursor->phase==3u)return 0;
    int status;
    if(!cursor->phase){
        status=prologue(writer,cursor->plan,&cursor->cut);
        cursor->phase=cursor->plan->fault_vector?3u:1u;
    }else if(cursor->phase==1u){
        status=instruction_fragment(writer,cursor->plan,cursor->instruction,&cursor->rip,&cursor->cut);
        if(++cursor->instruction==cursor->plan->report.source_instructions)cursor->phase=2u;
    }else{
        status=epilogue(writer,cursor->plan,cursor->rip,&cursor->cut);cursor->phase=3u;
    }
    return status?status:1;
}

static int body(wasm_writer *writer,const cut_plan *plan,wasm_cut_report *report,
    const pl_u32 *import_slots,pl_u32 *imports)
{
    cut_body_cursor cursor;cut_body_open(plan,import_slots,&cursor);int status;
    while((status=cut_body_next(&cursor,writer))>0){}
    if(status)return status;
    if(imports)*imports=cursor.cut.imports_used;
    *report=cursor.cut.report;return 0;
}
int cut_measure_body(wasm_writer *writer,const cut_plan *plan,wasm_cut_report *report,pl_u32 *imports)
{
    if(!writer || writer->bytes || !imports)return WASM_COMPILER_ERROR_INPUT;
    return body(writer,plan,report,0,imports);
}
int cut_emit_body(wasm_writer *writer,const cut_plan *plan,wasm_cut_report *report,pl_u32 imports)
{
    if(imports&~WASM_IMPORT_MASK)return WASM_COMPILER_ERROR_INPUT;
    pl_u32 slots[WASM_IMPORT_COUNT],used=0u;wasm_import_map(imports,slots);
    int status=body(writer,plan,report,slots,&used);
    if(!status && used!=plan->imports)return WASM_COMPILER_ERROR_GRAMMAR;
    return status;
}
