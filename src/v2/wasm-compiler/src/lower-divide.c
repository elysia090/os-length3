/* Division with an architectural fault cut, not a Wasm trap. */
#include "cut-internal.h"

int cut_divide_supported(const pl_x86_instruction *instruction)
{
    return instruction->status == PL_X86_DECODE_VALID
        && (instruction->operation == PL_X86_OPERATION_DIVIDE_UNSIGNED
            || instruction->operation == PL_X86_OPERATION_DIVIDE_SIGNED)
        && instruction->machine_operation == PL_X86_MACHINE_NONE
        && instruction->flow == PL_X86_FLOW_NEXT && instruction->visible_operand_count == 1u
        && (instruction->operands[0].kind == PL_X86_OPERAND_MEMORY
            || (instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
                && cut_gpr(&instruction->operands[0].value.reg)
                && !(instruction->flags & PL_X86_INSTRUCTION_READS_MEMORY)))
        && instruction->operands[0].bits == instruction->operand_width
        && (instruction->operand_width == 8u || instruction->operand_width == 16u
            || instruction->operand_width == 32u || instruction->operand_width == 64u)
        && !(instruction->flags & (PL_X86_INSTRUCTION_WRITES_MEMORY
            | PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER
            | PL_X86_INSTRUCTION_PRIVILEGED | PL_X86_INSTRUCTION_BARRIER));
}
static void fault_if(cut_lowering *cut,pl_u64 rip)
{
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    static const pl_u32 offsets[]={offsetof(machine_memory_port,fault_address),
        offsetof(machine_memory_port,fault_vector),offsetof(machine_memory_port,fault_error)};
    for (pl_u32 rank=0u;rank<3u;++rank) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        if (!rank) cut_coordinate(cut,rip);
        else { cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,0u); }
        cut_op(cut,rank ? 0x36u : 0x37u); wasm_writer_uleb(cut->writer,rank ? 2u : 3u);
        wasm_writer_uleb(cut->writer,offsets[rank]);
    }
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,0u)); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
}
static void sign_bit(cut_lowering *cut, pl_u32 bit)
{
    cut_get(cut,CUT_ADDRESS); cut_const(cut,1ull<<bit); cut_op(cut,0x83u);
    cut_op(cut,0x50u); cut_op(cut,0x45u);
}
static void wide_divide(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    int signed_divide=instruction->operation==PL_X86_OPERATION_DIVIDE_SIGNED;
    pl_x86_operand accumulator={0}; accumulator.kind=PL_X86_OPERAND_REGISTER;
    accumulator.value.reg.class_id=PL_X86_REGISTER_GPR; accumulator.value.reg.bits=64u;
    /* RIGHT was captured before either aliased dividend register is written.
     * LEFT/NEXT hold low/high, then quotient/remainder; only six i64 locals
     * and the existing fault port are needed for the entire 128/64 domain. */
    cut_read_operand(cut,&accumulator,64u); cut_set(cut,CUT_LEFT);
    accumulator.value.reg.index=2u;
    cut_read_operand(cut,&accumulator,64u); cut_set(cut,CUT_NEXT);
    if (signed_divide) {
        /* ADDRESS packs numerator sign and quotient sign before magnitude
         * normalization. Negating (H,L) gives (-L,~H+[-L==0]); all operations
         * are modular, including the minimum signed 128-bit numerator. */
        cut_get(cut,CUT_NEXT); cut_const(cut,63u); cut_op(cut,0x88u);
        cut_get(cut,CUT_NEXT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x85u);
        cut_const(cut,63u); cut_op(cut,0x88u); cut_const(cut,1u); cut_op(cut,0x86u);
        cut_op(cut,0x84u); cut_set(cut,CUT_ADDRESS);
        cut_get(cut,CUT_RIGHT); cut_const(cut,63u); cut_op(cut,0x87u); cut_set(cut,CUT_VALUE);
        cut_get(cut,CUT_RIGHT); cut_get(cut,CUT_VALUE); cut_op(cut,0x85u);
        cut_get(cut,CUT_VALUE); cut_op(cut,0x7du); cut_set(cut,CUT_RIGHT);
        sign_bit(cut,0u); cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_const(cut,0u); cut_get(cut,CUT_LEFT); cut_op(cut,0x7du); cut_set(cut,CUT_LEFT);
        cut_get(cut,CUT_NEXT); cut_const(cut,~0ull); cut_op(cut,0x85u);
        cut_get(cut,CUT_LEFT); cut_op(cut,0x50u); cut_op(cut,0xadu); cut_op(cut,0x7cu);
        cut_set(cut,CUT_NEXT); cut_op(cut,0x0bu);
    }
    /* A 128/64 unsigned quotient fits u64 iff H<D (D is already nonzero).
     * This guard also rejects every signed magnitude too large to fit u64. */
    cut_get(cut,CUT_NEXT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x5au);
    fault_if(cut,instruction->rip);
    cut_get(cut,CUT_NEXT); cut_op(cut,0x50u); cut_op(cut,0x04u); cut_op(cut,0x40u);
    /* The common H==0 case is one engine division/remainder, not 64 steps.
     * Unsigned division has no signed MIN/-1 Wasm overflow trap. */
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x80u); cut_set(cut,CUT_VALUE);
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x82u); cut_set(cut,CUT_NEXT);
    cut_get(cut,CUT_VALUE); cut_set(cut,CUT_LEFT);
    cut_op(cut,0x05u);
    /* Shared exact quotient SSA: no second bit-serial evaluator in the
     * backend. The same fragment can feed floating significand arithmetic. */
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan quotient;
    if(pl_x86_unsigned_divide_plan(&arena,&quotient)){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 input[]={CUT_NEXT,CUT_LEFT,CUT_RIGHT,0u,0u},output[]={CUT_LEFT,CUT_NEXT,CUT_STATUS};
    cut_emit_scalar_plan(cut,&quotient,input,26u,output);cut_op(cut,0x0bu);
    if (signed_divide) {
        /* Negative quotients permit magnitude 2^63; positive ones do not.
         * Remainder has numerator's sign. No publication precedes this #DE. */
        cut_get(cut,CUT_LEFT); cut_const(cut,0x7fffffffffffffffull);
        cut_get(cut,CUT_ADDRESS); cut_const(cut,1u); cut_op(cut,0x88u); cut_op(cut,0x7cu);
        cut_op(cut,0x56u); fault_if(cut,instruction->rip);
        sign_bit(cut,1u); cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_const(cut,0u); cut_get(cut,CUT_LEFT); cut_op(cut,0x7du); cut_set(cut,CUT_LEFT); cut_op(cut,0x0bu);
        sign_bit(cut,0u); cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_const(cut,0u); cut_get(cut,CUT_NEXT); cut_op(cut,0x7du); cut_set(cut,CUT_NEXT); cut_op(cut,0x0bu);
    }
    accumulator.value.reg.index=0u;
    cut_get(cut,CUT_LEFT); cut_set(cut,CUT_VALUE); cut_write_register(cut,&accumulator.value.reg);
    accumulator.value.reg.index=2u;
    cut_get(cut,CUT_NEXT); cut_set(cut,CUT_VALUE); cut_write_register(cut,&accumulator.value.reg);
}
void cut_divide_value(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_u32 width=instruction->operand_width;
    int signed_divide=instruction->operation == PL_X86_OPERATION_DIVIDE_SIGNED;
    /* Consume the captured raw divisor on the stack. Memory source has
     * already passed the C read/fault boundary, before any #DE guard.
     * Up to 32-bit operands, the complete dividend fits one i64. */
    if (signed_divide && width<64u) cut_op(cut,width == 8u ? 0xc2u : width == 16u ? 0xc3u : 0xc4u);
    cut_set(cut,CUT_RIGHT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x50u); fault_if(cut,instruction->rip);
    if (width==64u) { wide_divide(cut,instruction); return; }
    pl_x86_operand accumulator={0}; accumulator.kind=PL_X86_OPERAND_REGISTER;
    accumulator.value.reg.class_id=PL_X86_REGISTER_GPR; accumulator.value.reg.bits=(pl_u16)(width == 8u ? 16u : width);
    cut_read_operand(cut,&accumulator,width == 8u ? 16u : width);
    if (width != 8u) {
        pl_x86_operand high=accumulator; high.value.reg.index=2u;
        cut_read_operand(cut,&high,width); cut_const(cut,width); cut_op(cut,0x86u); cut_op(cut,0x84u);
    }
    if (signed_divide && width < 32u) cut_op(cut,width == 8u ? 0xc3u : 0xc4u);
    cut_set(cut,CUT_LEFT);
    if (signed_divide && width == 32u) {
        /* Wasm's one signed i64 overflow is also necessarily x86 #DE.
         * Guard it before i64.div_s; no engine trap may escape. */
        cut_get(cut,CUT_LEFT); cut_const(cut,1ull << 63u); cut_op(cut,0x51u);
        cut_get(cut,CUT_RIGHT); cut_const(cut,~0ull); cut_op(cut,0x51u); cut_op(cut,0x71u);
        fault_if(cut,instruction->rip);
    }
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,signed_divide ? 0x7fu : 0x80u); cut_set(cut,CUT_NEXT);
    if (signed_divide) {
        cut_get(cut,CUT_NEXT); cut_const(cut,0ull-(1ull << (width-1u))); cut_op(cut,0x53u);
        cut_get(cut,CUT_NEXT); cut_const(cut,(1ull << (width-1u))-1u); cut_op(cut,0x55u); cut_op(cut,0x72u);
    } else { cut_get(cut,CUT_NEXT); cut_const(cut,(1ull << width)-1u); cut_op(cut,0x56u); }
    fault_if(cut,instruction->rip);
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,signed_divide ? 0x81u : 0x82u);
    cut_mask(cut,width); cut_set(cut,CUT_LEFT);
    cut_get(cut,CUT_NEXT); cut_mask(cut,width);
    if (width == 8u) {
        cut_get(cut,CUT_LEFT); cut_const(cut,8u); cut_op(cut,0x86u); cut_op(cut,0x84u);
        accumulator.value.reg.bits=16u;
    }
    cut_set(cut,CUT_VALUE); cut_write_register(cut,&accumulator.value.reg);
    if (width != 8u) {
        accumulator.value.reg.index=2u; cut_get(cut,CUT_LEFT); cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&accumulator.value.reg);
    }
    /* CF/OF/SF/ZF/AF/PF are undefined. Keep their incoming representative;
     * RF is cleared only by the common successful-retirement epilogue. */
}

void cut_lower_divide(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    /* Snapshot the register source before either implicit publication. */
    cut_read_operand(cut,&instruction->operands[0],instruction->operand_width);
    cut_divide_value(cut,instruction);
}
