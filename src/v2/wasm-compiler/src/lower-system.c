/* Precise privileged transfers, compiled before execution. */
#include "cut-internal.h"
#include <x86/profile.h>
#include <machine/msr.h>
#include <machine/exception.h>
#include <machine/system.h>
static int memory_order_supported(const pl_x86_instruction *instruction)
{
    const pl_u32 required=PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    return instruction->status==PL_X86_DECODE_VALID
        && instruction->encoding==PL_X86_ENCODING_LEGACY
        && instruction->machine_operation==PL_X86_MACHINE_MEMORY_ORDER
        && (instruction->machine_argument==0u || instruction->machine_argument==1u
            || instruction->machine_argument==5u)
        && !instruction->visible_operand_count
        && (instruction->flow==PL_X86_FLOW_NEXT || instruction->flow==PL_X86_FLOW_SYSTEM)
        && (instruction->flags&required)==required
        && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER));
}
int cut_system_supported(const pl_x86_instruction *instruction)
{
    if (pl_x86_halt_supported(instruction)) return CUT_SYSTEM_HALT;
    if(instruction->status==PL_X86_DECODE_VALID && instruction->encoding==PL_X86_ENCODING_LEGACY
            && instruction->machine_operation==PL_X86_MACHINE_SYSTEM_TRANSFER
            && instruction->machine_argument<=1u && !instruction->visible_operand_count
            && (instruction->machine_argument==0u || instruction->operand_width==64u)
            && instruction->flow==PL_X86_FLOW_SYSTEM
            && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_PRIVILEGE_TRANSFER;
    if(memory_order_supported(instruction))return CUT_SYSTEM_MEMORY_ORDER;
    int io = cut_io_supported(instruction);
    if (io) return io;
    if (cut_fxsave_supported(instruction)) return CUT_SYSTEM_FXSAVE;
    if (cut_fxrstor_supported(instruction)) return CUT_SYSTEM_FXRSTOR;
    if (cut_mxcsr_supported(instruction)) return CUT_SYSTEM_MXCSR;
    if (cut_vector_supported(instruction)) return CUT_SYSTEM_VECTOR_TRANSFER;
    if (cut_vector_scalar_supported(instruction)) return CUT_SYSTEM_VECTOR_SCALAR;
    if (instruction->status==PL_X86_DECODE_VALID
            && instruction->machine_operation==PL_X86_MACHINE_SOFTWARE_INTERRUPT
            && instruction->machine_argument==MACHINE_EXCEPTION_BREAKPOINT
            && instruction->trap_vector==MACHINE_EXCEPTION_BREAKPOINT
            && !instruction->visible_operand_count && instruction->flow==PL_X86_FLOW_FAULT
            && (instruction->flags&PL_X86_INSTRUCTION_TRAP_AFTER)
            && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED)))
        return CUT_SYSTEM_SOFTWARE_INTERRUPT;
    if (instruction->status==PL_X86_DECODE_VALID
            && instruction->machine_operation==PL_X86_MACHINE_X87
            && instruction->machine_argument==PL_X86_X87_INITIALIZE
            && !instruction->visible_operand_count
            && (instruction->flow==PL_X86_FLOW_NEXT || instruction->flow==PL_X86_FLOW_SYSTEM)
            && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_X87_INIT;
    if (instruction->status==PL_X86_DECODE_VALID
            && instruction->machine_operation==PL_X86_MACHINE_DEBUG_REGISTER
            && instruction->visible_operand_count==2u
            && (instruction->flow==PL_X86_FLOW_NEXT || instruction->flow==PL_X86_FLOW_SYSTEM)
            && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                                     |PL_X86_INSTRUCTION_TRAP_AFTER))) {
        pl_u32 write=(pl_u32)(instruction->machine_argument&1u);
        const pl_x86_operand *debug=&instruction->operands[write ? 0u : 1u];
        const pl_x86_operand *reg=&instruction->operands[write ? 1u : 0u];
        if (debug->kind==PL_X86_OPERAND_REGISTER && debug->value.reg.class_id==PL_X86_REGISTER_DEBUG
                && debug->value.reg.index<8u && reg->kind==PL_X86_OPERAND_REGISTER
                && cut_gpr(&reg->value.reg) && reg->value.reg.bits==64u
                && instruction->machine_argument==(write|((pl_u64)debug->value.reg.index<<8u)
                    |((pl_u64)reg->value.reg.index<<16u))) return CUT_SYSTEM_DEBUG;
    }
    if (cut_divide_supported(instruction)
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER) return CUT_SYSTEM_DIVIDE;
    if (instruction->status==PL_X86_DECODE_VALID
            && instruction->machine_operation==PL_X86_MACHINE_SYSTEM_SELECTOR
            && ((instruction->machine_argument&255u)==2u || (instruction->machine_argument&255u)==3u)
            && instruction->visible_operand_count==1u
            && (instruction->flow==PL_X86_FLOW_NEXT || instruction->flow==PL_X86_FLOW_SYSTEM)
            && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                                     |PL_X86_INSTRUCTION_TRAP_AFTER))) {
        const pl_x86_operand *source=&instruction->operands[0];
        pl_u64 operation=instruction->machine_argument&255u;
        if (source->kind==PL_X86_OPERAND_REGISTER && cut_gpr(&source->value.reg)
                && source->bits==16u && source->value.reg.bits==16u
                && instruction->machine_argument==(operation|((pl_u64)source->value.reg.index<<16u)))
            return CUT_SYSTEM_SEGMENT;
        if (source->kind==PL_X86_OPERAND_MEMORY && source->bits==16u
                && instruction->machine_argument==(operation|256u)
                && (instruction->address_width==32u || instruction->address_width==64u)) {
            const pl_x86_memory *memory=&source->value.memory;
            if ((memory->segment.class_id==PL_X86_REGISTER_NONE
                    || (memory->segment.class_id==PL_X86_REGISTER_SEGMENT && memory->segment.index<6u))
                    && (memory->base.class_id==PL_X86_REGISTER_NONE
                        || memory->base.class_id==PL_X86_REGISTER_IP || cut_gpr(&memory->base))
                    && (memory->index.class_id==PL_X86_REGISTER_NONE || cut_gpr(&memory->index))
                    && (!memory->scale || memory->scale==1u || memory->scale==2u
                        || memory->scale==4u || memory->scale==8u)) return CUT_SYSTEM_SEGMENT;
        }
    }
    if (instruction->status==PL_X86_DECODE_VALID
            && instruction->machine_operation==PL_X86_MACHINE_INVALIDATE_PAGE
            && !instruction->machine_argument && instruction->visible_operand_count==1u
            && instruction->operands[0].kind==PL_X86_OPERAND_MEMORY
            && (instruction->flow==PL_X86_FLOW_NEXT || instruction->flow==PL_X86_FLOW_SYSTEM)
            && (instruction->address_width==32u || instruction->address_width==64u)
            && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                                     |PL_X86_INSTRUCTION_TRAP_AFTER))) {
        const pl_x86_memory *memory=&instruction->operands[0].value.memory;
        if ((memory->segment.class_id==PL_X86_REGISTER_NONE
                || (memory->segment.class_id==PL_X86_REGISTER_SEGMENT && memory->segment.index<6u))
                && (memory->base.class_id==PL_X86_REGISTER_NONE
                    || memory->base.class_id==PL_X86_REGISTER_IP || cut_gpr(&memory->base))
                && (memory->index.class_id==PL_X86_REGISTER_NONE || cut_gpr(&memory->index))
                && (!memory->scale || memory->scale==1u || memory->scale==2u
                    || memory->scale==4u || memory->scale==8u)) return CUT_SYSTEM_INVALIDATE_PAGE;
    }
    if (cut_selector_read_supported(instruction)
            && instruction->operands[0].kind==PL_X86_OPERAND_REGISTER
            && !(instruction->flags&(PL_X86_INSTRUCTION_READS_MEMORY
                |PL_X86_INSTRUCTION_WRITES_MEMORY)))
        return CUT_SYSTEM_SELECTOR_READ;
    if (instruction->status == PL_X86_DECODE_VALID
            && (instruction->machine_operation == PL_X86_MACHINE_READ_MSR
                || instruction->machine_operation == PL_X86_MACHINE_WRITE_MSR
                || instruction->machine_operation == PL_X86_MACHINE_SWAP_GS)
            && !instruction->visible_operand_count
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_MSR;
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_INTERRUPT_RETURN
            && instruction->machine_argument == 64u && instruction->operand_width == 64u
            && instruction->flow == PL_X86_FLOW_RETURN
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_INTERRUPT_RETURN;
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_CPUID
            && !instruction->visible_operand_count
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_CPUID;
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_WRITE_CONTROL
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->visible_operand_count == 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[0].value.reg.class_id == PL_X86_REGISTER_CONTROL
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER
            && cut_gpr(&instruction->operands[1].value.reg)
            && instruction->operands[1].value.reg.bits == 64u
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) {
        pl_u32 rank = instruction->operands[0].value.reg.index;
        if (rank == 0u || rank == 2u || rank == 3u || rank == 4u || rank == 8u)
            return CUT_SYSTEM_CONTROL_WRITE;
    }
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_READ_CONTROL
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->visible_operand_count == 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
            && cut_gpr(&instruction->operands[0].value.reg)
            && instruction->operands[0].value.reg.bits == 64u
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[1].value.reg.class_id == PL_X86_REGISTER_CONTROL
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) {
        pl_u32 rank = instruction->operands[1].value.reg.index;
        if (rank == 0u || rank == 2u || rank == 3u || rank == 4u || rank == 8u)
            return CUT_SYSTEM_CONTROL_READ;
    }
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_FAR_RETURN
            && instruction->flow == PL_X86_FLOW_RETURN && instruction->operand_width == 64u
            && instruction->machine_argument <= 65535u
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_FAR_RETURN;
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_DESCRIPTOR_TABLE
            && instruction->machine_argument <= 3u
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->visible_operand_count == 1u
            && instruction->operands[0].kind == PL_X86_OPERAND_MEMORY
            && (instruction->address_width == 32u || instruction->address_width == 64u)
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) {
        const pl_x86_memory *memory = &instruction->operands[0].value.memory;
        if ((memory->segment.class_id == PL_X86_REGISTER_NONE
                || (memory->segment.class_id == PL_X86_REGISTER_SEGMENT && memory->segment.index < 6u))
                && (memory->base.class_id == PL_X86_REGISTER_NONE
                    || memory->base.class_id == PL_X86_REGISTER_IP || cut_gpr(&memory->base))
                && (memory->index.class_id == PL_X86_REGISTER_NONE || cut_gpr(&memory->index))
                && (!memory->scale || memory->scale == 1u || memory->scale == 2u
                    || memory->scale == 4u || memory->scale == 8u)) return CUT_SYSTEM_TABLE;
    }
    if (instruction->status == PL_X86_DECODE_VALID && instruction->operation == PL_X86_OPERATION_MOVE
            && instruction->machine_operation == PL_X86_MACHINE_WRITE_SEGMENT
            && instruction->flow == PL_X86_FLOW_NEXT && instruction->visible_operand_count == 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[0].value.reg.class_id == PL_X86_REGISTER_SEGMENT
            && instruction->operands[0].value.reg.index < 6u
            && instruction->operands[0].value.reg.index != 1u
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER
            && cut_gpr(&instruction->operands[1].value.reg)
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_SEGMENT;
    return instruction->status == PL_X86_DECODE_VALID
        && instruction->operation == PL_X86_OPERATION_FLAG_CONTROL
        && (instruction->condition == 5u || instruction->condition == 6u) && !instruction->visible_operand_count
        && instruction->machine_operation == PL_X86_MACHINE_INTERRUPT_FLAG
        && instruction->flow == PL_X86_FLOW_NEXT
        && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                   | PL_X86_INSTRUCTION_TRAP_AFTER));
}
static void port_store(cut_lowering *cut, pl_u32 offset, pl_u32 bytes)
{
    /* Value remains on the stack; retain it before pushing the port base. */
    cut_set(cut, CUT_VALUE);
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_get(cut, CUT_VALUE);
    if (bytes == 4u) cut_op(cut, 0xa7u);
    cut_op(cut, bytes == 8u ? 0x37u : 0x36u);
    wasm_writer_uleb(cut->writer, bytes == 8u ? 3u : 2u);
    wasm_writer_uleb(cut->writer, offset);
}
static void require_cpl0(cut_lowering *cut)
{
    cut_get(cut,CUT_FLAGS); cut_const(cut,0x20000u); cut_op(cut,0x83u);
    cut_op(cut,0x50u); cut_op(cut,0x45u);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_const(cut,MACHINE_RESULT_ENTRY_MAP); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
    cut_load(cut,offsetof(machine_state,system)+MACHINE_SYSTEM_CS*8u);
    cut_const(cut,3u); cut_op(cut,0x83u); cut_op(cut,0x50u); cut_op(cut,0x45u);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_load(cut,offsetof(machine_state,rip)); port_store(cut,offsetof(machine_memory_port,fault_address),8u);
    cut_const(cut,13u); port_store(cut,offsetof(machine_memory_port,fault_vector),4u);
    cut_const(cut,0u); port_store(cut,offsetof(machine_memory_port,fault_error),4u);
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,13u)); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
}
static void cpuid_result(cut_lowering *cut, pl_x86_cpuid_result result)
{
    const pl_u32 words[] = {result.eax,result.ecx,result.edx,result.ebx};
    for (pl_u32 reg = 0u; reg < 4u; ++reg) {
        cut_const(cut,words[reg]); cut_set(cut,reg + 1u);
    }
    cut->loaded |= 15u; cut->report.written_registers |= 15u;
}
static void refuse_cpuid_if(cut_lowering *cut)
{
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_const(cut,MACHINE_RESULT_ENTRY_MAP); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
}
static void cpuid_controls(cut_lowering *cut)
{
    /* Compile the same fixed owner invariant as machine_msr_bank_valid.
     * No table scan, host operation import or duplicated control state. */
    cut_load(cut,offsetof(machine_state,msr_count)); cut_mask(cut,32u); cut_set(cut,CUT_RIGHT);
    cut_get(cut,CUT_RIGHT); cut_const(cut,MACHINE_MSR_BANK_COUNT); cut_op(cut,0x56u); refuse_cpuid_if(cut);
    cut_get(cut,CUT_RIGHT); cut_op(cut,0x50u); cut_op(cut,0x45u);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_load(cut,offsetof(machine_state,msr_keys)); cut_const(cut,MACHINE_MSR_KERNEL_GS_BASE);
    cut_op(cut,0x52u); refuse_cpuid_if(cut);
    cut_load(cut,offsetof(machine_state,msr_values)); cut_set(cut,CUT_LEFT);
    cut_get(cut,CUT_LEFT); cut_const(cut,16u); cut_op(cut,0x86u);
    cut_const(cut,16u); cut_op(cut,0x87u); cut_get(cut,CUT_LEFT);
    cut_op(cut,0x52u); refuse_cpuid_if(cut); cut_op(cut,0x0bu);
    cut_const(cut,MACHINE_MISC_RESET); cut_set(cut,CUT_VALUE);
    cut_get(cut,CUT_RIGHT); cut_const(cut,2u); cut_op(cut,0x5au);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_load(cut,offsetof(machine_state,msr_keys)+8u); cut_const(cut,MACHINE_MSR_MISC_ENABLE);
    cut_op(cut,0x52u); refuse_cpuid_if(cut);
    cut_load(cut,offsetof(machine_state,msr_values)+8u); cut_set(cut,CUT_VALUE);
    cut_get(cut,CUT_VALUE); cut_const(cut,~(MACHINE_MISC_WRITABLE|MACHINE_MISC_READ_ONLY)); cut_op(cut,0x83u);
    cut_get(cut,CUT_VALUE); cut_const(cut,MACHINE_MISC_READ_ONLY); cut_op(cut,0x83u);
    cut_const(cut,MACHINE_MISC_READ_ONLY); cut_op(cut,0x85u); cut_op(cut,0x84u);
    cut_op(cut,0x50u); cut_op(cut,0x45u); refuse_cpuid_if(cut);
    cut_get(cut,CUT_VALUE); cut_const(cut,MACHINE_MISC_XD_DISABLE); cut_op(cut,0x83u);
    cut_op(cut,0x50u); cut_op(cut,0x45u);
    cut_load(cut,offsetof(machine_state,efer)); cut_const(cut,0x800u); cut_op(cut,0x83u);
    cut_op(cut,0x50u); cut_op(cut,0x45u); cut_op(cut,0x71u); refuse_cpuid_if(cut);
    cut_op(cut,0x0bu);
    /* Emit the same fixed prefix invariant, not a runtime dictionary scan.
     * Uncounted rank payloads are ignored; CPUID never materializes them. */
    for (pl_u32 rank=2u;rank<MACHINE_MSR_BANK_COUNT;++rank) {
        cut_get(cut,CUT_RIGHT); cut_const(cut,rank); cut_op(cut,0x56u);
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_load(cut,offsetof(machine_state,msr_keys)+rank*8u);
        cut_const(cut,machine_msr_rank_key(rank)); cut_op(cut,0x52u); refuse_cpuid_if(cut);
        if (rank!=4u) {
            cut_load(cut,offsetof(machine_state,msr_values)+rank*8u);
            if (rank==3u) {
                cut_set(cut,CUT_LEFT); cut_get(cut,CUT_LEFT); cut_const(cut,16u); cut_op(cut,0x86u);
                cut_const(cut,16u); cut_op(cut,0x87u); cut_get(cut,CUT_LEFT); cut_op(cut,0x52u);
            } else {
                cut_const(cut,rank==2u ? 0xffffffffu : 0xffffffff00000000ull); cut_op(cut,0x83u);
                cut_op(cut,0x50u); cut_op(cut,0x45u);
            }
            refuse_cpuid_if(cut);
        }
        cut_op(cut,0x0bu);
    }
}
static void lower_cpuid(cut_lowering *cut)
{
    static const pl_u32 leaves[] = {0u,1u,7u,0x80000000u,0x80000001u,0x80000008u};
    /* Snapshot EAX before any of the four architectural outputs overwrite
     * their parents. CPUID is a serializing one-instruction cut, not a host
     * capability callback. Profile constants plus canonical MSR controls
     * implement effective NX/maximum-leaf values after architectural writes. */
    cpuid_controls(cut);
    cut_load(cut,offsetof(machine_state,registers)); cut_mask(cut,32u); cut_set(cut,CUT_LEFT);
    cut->report.read_registers |= 1u;
    pl_u32 nesting = 0u;
    for (pl_u32 rank = 0u; rank < sizeof leaves / sizeof leaves[0]; ++rank) {
        pl_u32 leaf = leaves[rank];
        pl_x86_cpuid_result result = pl_x86_profile_cpuid(leaf,0u);
        if (!(result.eax | result.ebx | result.ecx | result.edx)) continue;
        cut_get(cut,CUT_LEFT); cut_const(cut,leaf); cut_op(cut,0x51u);
        if (leaf == 7u) {
            /* All current structured rows are zero and disappear. If the
             * contract changes, retain its subleaf dependency explicitly. */
            cut_load(cut,offsetof(machine_state,registers) + 8u); cut_mask(cut,32u);
            cut_op(cut,0x50u); cut_op(cut,0x71u); cut->report.read_registers |= 2u;
        }
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cpuid_result(cut,result);
        if (leaf == 0u) {
            cut_const(cut,2u); cut_get(cut,1u);
            cut_get(cut,CUT_VALUE); cut_const(cut,MACHINE_MISC_LIMIT_CPUID); cut_op(cut,0x83u);
            cut_op(cut,0x50u); cut_op(cut,0x45u); cut_op(cut,0x1bu); cut_set(cut,1u);
        } else if (leaf == 0x80000001u) {
            cut_get(cut,3u); cut_const(cut,~(1ull<<20u)); cut_op(cut,0x83u); cut_get(cut,3u);
            cut_get(cut,CUT_VALUE); cut_const(cut,MACHINE_MISC_XD_DISABLE); cut_op(cut,0x83u);
            cut_op(cut,0x50u); cut_op(cut,0x45u); cut_op(cut,0x1bu); cut_set(cut,3u);
        }
        cut_op(cut,0x05u); ++nesting;
    }
    cpuid_result(cut,(pl_x86_cpuid_result){0});
    while (nesting--) cut_op(cut,0x0bu);
}
void cut_lower_system(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    if (pl_x86_halt_supported(instruction)) {
        require_cpl0(cut);
        /* The ordinary successful epilogue advances RIP, clears RF and
         * retires once. HALT then lends control to the machine event owner;
         * it is neither a no-op nor an opcode interpreter callback. */
        return;
    }
    if(instruction->machine_operation==PL_X86_MACHINE_SYSTEM_TRANSFER) {
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,instruction->machine_argument);
        if(instruction->machine_argument==MACHINE_SYSTEM_CALL64)cut_coordinate(cut,instruction->fallthrough);
        else cut_const(cut,0u);
        cut_call(cut,WASM_IMPORT_SYSTEM_TRANSFER);cut_access_status(cut);
        /* The C boundary owns the complete privilege transition. Do not
         * reload and republish the same CPU words in the generated body. */
        cut->report.flags_written=1u;
        if(instruction->machine_argument==MACHINE_SYSTEM_CALL64) {
            cut->report.written_registers|=0x802u;
        } else cut->report.read_registers|=0x802u;
        return;
    }
    if (instruction->machine_operation==PL_X86_MACHINE_SOFTWARE_INTERRUPT) {
        /* C owns descriptor checks and the pinned frame; retirement follows
         * successful delivery. A wait or delivery fault keeps the source RIP. */
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->machine_argument);
        cut_coordinate(cut,instruction->fallthrough);
        cut_call(cut,WASM_IMPORT_SOFTWARE_INTERRUPT); cut_access_status(cut);
        cut_load(cut,offsetof(machine_state,rip)); cut_set(cut,CUT_NEXT);
        cut_load(cut,offsetof(machine_state,rflags)); cut_set(cut,CUT_FLAGS);
        cut->report.flags_written=1u;
        return;
    }
    if (cut_io_supported(instruction)) { cut_lower_io(cut,instruction); return; }
    if (cut_fxsave_supported(instruction)) { cut_lower_fxsave(cut,instruction); return; }
    if (cut_fxrstor_supported(instruction)) { cut_lower_fxrstor(cut,instruction); return; }
    if (cut_mxcsr_supported(instruction)) { cut_lower_mxcsr(cut,instruction); return; }
    if (cut_vector_supported(instruction)) { cut_lower_vector(cut,instruction); return; }
    if (cut_vector_scalar_supported(instruction)) { cut_lower_vector_scalar(cut,instruction); return; }
    if(memory_order_supported(instruction)) {
        _Static_assert((PL_X86_CPUID_1_EDX&((1u<<25u)|(1u<<26u)))==((1u<<25u)|(1u<<26u)),
            "fences require the fixed SSE/SSE2 CPU contract");
        /* At a serialized cut boundary, all preceding synchronous C accesses
         * have completed; there is no store buffer, outstanding guest load or
         * other RAM owner. The required ordering relation already holds.
         * Its value-state action is identity, not an opcode callback or host
         * atomic fence. Keep the separate cut, admission, RF and retirement.
         * CR0.EM/TS and CR4.OSFXSR do not disable these instructions. Adding
         * shared RAM, async accesses or another vCPU changes this contract
         * and requires a different lowering before admitting that projection. */
        return;
    }
    if (instruction->machine_operation==PL_X86_MACHINE_X87
            && instruction->machine_argument==PL_X86_X87_INITIALIZE) {
        /* FNINIT is no-wait: pending x87 exceptions do not become #MF here.
         * CR0.EM/TS still cause precise #NM before any FPU state publication. */
        cut_load(cut,offsetof(machine_state,cr0)); cut_const(cut,12u); cut_op(cut,0x83u);
        cut_op(cut,0x50u); cut_op(cut,0x45u); cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_load(cut,offsetof(machine_state,rip)); port_store(cut,offsetof(machine_memory_port,fault_address),8u);
        cut_const(cut,7u); port_store(cut,offsetof(machine_memory_port,fault_vector),4u);
        cut_const(cut,0u); port_store(cut,offsetof(machine_memory_port,fault_error),4u);
        cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,7u)); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
        _Static_assert(offsetof(machine_state,x87_status)==offsetof(machine_state,x87_control)+2u
            && offsetof(machine_state,x87_tag)==offsetof(machine_state,x87_control)+4u
            && offsetof(machine_state,x87_opcode)==offsetof(machine_state,x87_control)+6u,
            "adjacent x87 control/status/tag/opcode words");
        /* Three stores, no scratch state: physical data registers are left
         * unchanged and tagged empty. XMM and MXCSR are not reset by FNINIT. */
        cut_const(cut,0x0000ffff0000037full); cut_set(cut,CUT_VALUE);
        cut_store(cut,offsetof(machine_state,x87_control),CUT_VALUE);
        cut_const(cut,0u); cut_set(cut,CUT_VALUE);
        cut_store(cut,offsetof(machine_state,x87_ip),CUT_VALUE);
        cut_store(cut,offsetof(machine_state,x87_dp),CUT_VALUE);
        return;
    }
    if (cut_divide_supported(instruction)
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER) {
        cut_lower_divide(cut,instruction); return;
    }
    if (instruction->machine_operation==PL_X86_MACHINE_READ_SELECTOR) {
        cut_read_operand(cut,&instruction->operands[1],16u); cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&instruction->operands[0].value.reg);
        return;
    }
    if (cut->has_msr) {
        int write = instruction->machine_operation == PL_X86_MACHINE_WRITE_MSR;
        int swap = instruction->machine_operation == PL_X86_MACHINE_SWAP_GS;
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,
            swap ? MACHINE_MSR_SWAP_GS : write ? MACHINE_MSR_WRITE : MACHINE_MSR_READ);
        if (swap) { cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,0u); }
        else {
            cut_load(cut,offsetof(machine_state,registers) + 8u); cut_op(cut,0xa7u);
            cut->report.read_registers |= 2u;
        }
        if (write) {
            cut_load(cut,offsetof(machine_state,registers)); cut_mask(cut,32u);
            cut_load(cut,offsetof(machine_state,registers) + 16u); cut_mask(cut,32u);
            cut_const(cut,32u); cut_op(cut,0x86u); cut_op(cut,0x84u);
            cut->report.read_registers |= 5u;
        } else cut_const(cut,0u);
        cut_call(cut,WASM_IMPORT_MSR); cut_access_status(cut);
        if (!write && !swap) {
            cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
            cut_op(cut,0x29u); wasm_writer_uleb(cut->writer,3u);
            wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,value));
            cut_set(cut,CUT_VALUE); cut_get(cut,CUT_VALUE); cut_mask(cut,32u); cut_set(cut,1u);
            cut_get(cut,CUT_VALUE); cut_const(cut,32u); cut_op(cut,0x88u); cut_set(cut,3u);
            cut->loaded |= 5u; cut->report.written_registers |= 5u;
        }
        return;
    }
    if (cut->has_debug) {
        pl_u32 write=(pl_u32)(instruction->machine_argument&1u);
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,write);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,(instruction->machine_argument>>8u)&255u);
        if (write) cut_read_operand(cut,&instruction->operands[1],64u);
        else cut_const(cut,0u);
        cut_call(cut,WASM_IMPORT_DEBUG); cut_access_status(cut);
        if (!write) {
            cut_access_value(cut); cut_set(cut,CUT_VALUE);
            cut_write_register(cut,&instruction->operands[0].value.reg);
        }
        return;
    }
    if (cut->has_interrupt_return) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_call(cut,WASM_IMPORT_IRET); cut_access_status(cut);
        cut_load(cut,offsetof(machine_state,rip)); cut_set(cut,CUT_NEXT);
        cut_load(cut,offsetof(machine_state,rflags)); cut_set(cut,CUT_FLAGS);
        cut->report.flags_written = 1u;
        return;
    }
    if (instruction->machine_operation == PL_X86_MACHINE_CPUID) {
        lower_cpuid(cut); return;
    }
    if (instruction->machine_operation==PL_X86_MACHINE_INVALIDATE_PAGE) {
        require_cpl0(cut);
        /* The current machine ABI retains neither TLB nor paging-structure
         * cache entries: every access and compiled entry fetch walks current
         * guest tables. Invalidating the empty set has no state effect.
         * This is an address-only instruction, never a payload read/#PF;
         * a noncanonical address is also a successful empty invalidation.
         * Introducing translation caching requires replacing this lowering
         * and the corresponding MMU/fetch contract together. The privilege
         * fault, instruction boundary and common retirement remain intact. */
        return;
    }
    if (cut->has_control_write) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->operands[0].value.reg.index);
        cut_read_operand(cut,&instruction->operands[1],64u);
        cut_call(cut,WASM_IMPORT_CONTROL); cut_access_status(cut);
        return;
    }
    if (instruction->machine_operation == PL_X86_MACHINE_READ_CONTROL) {
        require_cpl0(cut);
        pl_u32 rank = instruction->operands[1].value.reg.index;
        pl_u32 offset = rank == 0u ? offsetof(machine_state,cr0)
            : rank == 3u ? offsetof(machine_state,cr3) : rank == 4u ? offsetof(machine_state,cr4)
            : offsetof(machine_state,system) + (rank == 2u ? MACHINE_SYSTEM_CR2 : MACHINE_SYSTEM_CR8) * 8u;
        cut_load(cut,offset); cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&instruction->operands[0].value.reg);
        /* Arithmetic flags are architecturally undefined: preserve their
         * prior values as the chosen representative, not an exact oracle. */
        return;
    }
    if (cut->has_far_return) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->machine_argument);
        cut_call(cut,WASM_IMPORT_FAR_RETURN); cut_access_status(cut);
        cut_load(cut,offsetof(machine_state,rip)); cut_set(cut,CUT_NEXT);
        return;
    }
    if (cut->has_table) {
        const pl_x86_memory *memory = &instruction->operands[0].value.memory;
        cut_effective_address(cut,instruction,memory); cut_set(cut,CUT_ADDRESS);
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_get(cut,CUT_ADDRESS);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->machine_argument & 1u);
        cut_i32_const(cut,
            (instruction->machine_argument & 2u ? MACHINE_MEMORY_WRITE : MACHINE_MEMORY_READ)
            | cut_memory_role(memory));
        cut_call(cut,WASM_IMPORT_TABLE);
        cut_access_status(cut);
        return;
    }
    if (cut->has_segment) {
        int system=instruction->machine_operation==PL_X86_MACHINE_SYSTEM_SELECTOR;
        if (system) {
            require_cpl0(cut); /* Privilege precedes even a memory-source fault. */
            if (cut->has_memory) {
                cut_effective_address(cut,instruction,&instruction->operands[0].value.memory);
                cut_set(cut,CUT_ADDRESS);
                const pl_x86_memory *memory=&instruction->operands[0].value.memory;
                cut->report.memory_access=MACHINE_MEMORY_READ
                    | cut_memory_role(memory);
                cut_const(cut,0u); cut_set(cut,CUT_VALUE); cut_access(cut); cut_access_value(cut);
            } else cut_read_operand(cut,&instruction->operands[0],16u);
            cut_set(cut,CUT_LEFT);
        }
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,system
            ? 4u+(instruction->machine_argument&255u) : instruction->operands[0].value.reg.index);
        if (system) cut_get(cut,CUT_LEFT);
        else cut_read_operand(cut,&instruction->operands[1],16u);
        cut_op(cut,0xa7u);
        cut_call(cut,WASM_IMPORT_SEGMENT);
        cut_set(cut,CUT_STATUS); cut_get(cut,CUT_STATUS); cut_op(cut,0x50u); cut_op(cut,0x45u);
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_get(cut,CUT_STATUS); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
        return;
    }
    /* C owns IF/shadow publication and precise privilege failure. There is
     * no source opcode import or duplicate segment-state pointer in Wasm. */
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->condition == 6u);
    cut_call(cut,WASM_IMPORT_INTERRUPT_FLAG); cut_access_status(cut);
    cut_load(cut,offsetof(machine_state,rflags)); cut_set(cut,CUT_FLAGS);
    cut->report.flags_written=1u;
}
