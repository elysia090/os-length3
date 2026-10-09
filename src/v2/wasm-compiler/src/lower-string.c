#include "cut-internal.h"

static const pl_x86_memory *source_address(const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operand=pl_x86_string_memory(instruction,6u);
    return operand?&operand->value.memory:NULL;
}

int cut_string_supported(const pl_x86_instruction *instruction)
{
    pl_x86_string law;
    if(!pl_x86_string_lower(instruction,&law)
            || !(instruction->rip >> 47u == 0u || instruction->rip >> 47u == 0x1ffffu)
            || !(instruction->fallthrough >> 47u == 0u || instruction->fallthrough >> 47u == 0x1ffffu))return CUT_STRING_NONE;
    if(law.reads_source){
        const pl_x86_memory *source=source_address(instruction);
        if(!source || !cut_memory_address_supported(instruction,source))return CUT_STRING_NONE;
    }
    return law.repeated?CUT_STRING_REPEAT:CUT_STRING_SINGLE;
}

void cut_repeat_frontier(cut_lowering *cut)
{
    const pl_u32 registers[] = {0u,1u,6u,7u};
    for (pl_u32 rank = 0u; rank < 4u; ++rank)
        if (cut->report.written_registers & (1u << registers[rank]))
            cut_store(cut,offsetof(machine_state,registers) + registers[rank] * 8u,registers[rank] + 1u);
    if(cut->report.flags_written){
        /* A barrier exposes the completed comparison frontier; a pending
         * fault keeps this call's original flags. Cross-call rollback belongs
         * to the C instruction owner, which retains only six flag bits. */
        cut_get(cut,CUT_STATUS);cut_const(cut,7u);cut_op(cut,0x83u);cut_const(cut,MACHINE_RESULT_FAULT);
        cut_op(cut,0x52u);cut_op(cut,0x04u);cut_op(cut,0x40u);
        cut_store(cut,offsetof(machine_state,rflags),CUT_FLAGS);cut_op(cut,0x0bu);
    }
}

static void pattern_count(cut_lowering *c,pl_u32 bytes)
{
    pl_u32 shift=bytes==8u?3u:bytes==4u?2u:bytes==2u?1u:0u;
    cut_get(c,CUT_ADDRESS);cut_const(c,4095u);cut_op(c,0x83u);cut_const(c,shift);cut_op(c,0x88u);cut_const(c,1u);cut_op(c,0x7cu);
    cut_const(c,4096u);cut_get(c,CUT_ADDRESS);cut_const(c,4095u);cut_op(c,0x83u);cut_op(c,0x7du);cut_const(c,shift);cut_op(c,0x88u);
    cut_get(c,CUT_FLAGS);cut_const(c,0x400u);cut_op(c,0x83u);cut_op(c,0xa7u);cut_op(c,0x1bu);cut_set(c,CUT_NEXT);
    /* A word crossing the page is exactly one ordinary scalar transaction. */
    cut_const(c,1u);cut_get(c,CUT_NEXT);cut_get(c,CUT_NEXT);cut_op(c,0x50u);cut_op(c,0x1bu);cut_set(c,CUT_NEXT);
    cut_const(c,1u);cut_get(c,CUT_NEXT);cut_get(c,CUT_ADDRESS);cut_const(c,4095u);cut_op(c,0x83u);
    cut_const(c,4096u-bytes);cut_op(c,0x56u);cut_op(c,0x1bu);cut_set(c,CUT_NEXT);
    for(pl_u32 i=0u;i<2u;++i){pl_u32 limit=i?CUT_REPEAT_BUDGET:2u;
        cut_get(c,CUT_NEXT);cut_get(c,limit);cut_get(c,CUT_NEXT);cut_get(c,limit);cut_op(c,0x54u);cut_op(c,0x1bu);cut_set(c,CUT_NEXT);}
}

static void pattern_access(cut_lowering *c,pl_u32 bytes)
{
    pl_u32 shift=bytes==8u?3u:bytes==4u?2u:bytes==2u?1u:0u;
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);
    cut_get(c,CUT_NEXT);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);
    cut_get(c,CUT_FLAGS);cut_const(c,0x400u);cut_op(c,0x83u);cut_const(c,2u);cut_op(c,0x86u);
    cut_const(c,MACHINE_MEMORY_WRITE|MACHINE_MEMORY_PATTERN|(shift<<10u));cut_op(c,0x84u);cut_op(c,0xa7u);
    cut_get(c,CUT_LEFT);cut_call(c,WASM_IMPORT_ACCESS);cut_access_status(c);
    cut_access_value(c);cut_set(c,CUT_NEXT);
}

void cut_lower_string(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    pl_x86_string law;
    if(!pl_x86_string_lower(instruction,&law)){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    int store=law.kind==1u,compare=law.kind>=3u,repeated=law.repeated,pattern=store&&repeated;
    /* The exact frontier is known before the first possible partial return.
     * A store neither reads nor narrows/publishes RSI or RAX. */
    cut->report.written_registers|=(law.reads_source?0x40u:0u)|((law.reads_target||law.writes_target)?0x80u:0u)
        |(law.writes_accumulator?1u:0u)|(repeated?2u:0u);
    cut->report.flags_written|=(pl_u32)compare;
    const pl_u32 registers[] = {1u,6u,7u};
    for (pl_u32 rank = 0u; rank < 3u; ++rank) {
        if (!(cut->report.written_registers & (1u<<registers[rank]))) continue;
        pl_x86_operand operand = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
            .value.reg = {PL_X86_REGISTER_GPR, (pl_u8)registers[rank], 64u, 0u} };
        cut_read_operand(cut,&operand,64u); cut_op(cut,0x1au);
        /* The count parent is narrowed on entry. MOVS/STOS also publish
         * their used index parents there; LODS/CMPS/SCAS publish them only
         * after a successful element. Non-REP faults preserve every parent. */
        if (repeated && instruction->address_width == 32u
                && (registers[rank]==1u || law.kind<=1u)) {
            cut_get(cut,registers[rank] + 1u); cut_mask(cut,32u); cut_set(cut,registers[rank] + 1u);
        }
    }
    if(law.reads_accumulator || (law.writes_accumulator && repeated)){
        const pl_x86_operand accumulator = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
            .value.reg = {PL_X86_REGISTER_GPR,0u,64u,0u} };
        cut_read_operand(cut,&accumulator,64u);cut_mask(cut,law.bits);cut_set(cut,CUT_LEFT);
    }
    pl_u32 bytes = instruction->operand_width / 8u, width = instruction->address_width;
    pl_u32 stride=compare?CUT_NEXT:CUT_RIGHT;
    cut_const(cut,0u - (pl_u64)bytes); cut_const(cut,bytes);
    cut_get(cut,CUT_FLAGS); cut_const(cut,0x400u); cut_op(cut,0x83u); cut_op(cut,0xa7u);
    cut_op(cut,0x1bu);cut_set(cut,stride); /* DF ? -bytes : bytes */
    if (repeated) {
        cut_const(cut,MACHINE_REPEAT_MAX_ELEMENTS); cut_set(cut,CUT_REPEAT_BUDGET);
        cut_op(cut,0x02u); cut_op(cut,0x40u); /* block */
        cut_op(cut,0x03u); cut_op(cut,0x40u); /* loop */
        cut_get(cut,2u); cut_mask(cut,width); cut_op(cut,0x50u);
        cut_op(cut,0x0du); wasm_writer_uleb(cut->writer,1u);
        cut_get(cut,CUT_REPEAT_BUDGET); cut_op(cut,0x50u);
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_repeat_frontier(cut);
        cut_const(cut,machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_QUANTUM));
        cut_op(cut,0x0fu); cut_op(cut,0x0bu);
    }
    if (store) { cut_get(cut,CUT_LEFT); cut_set(cut,CUT_VALUE); }
    if(law.reads_source){
        cut_get(cut,7u); cut_mask(cut,width); cut_set(cut,CUT_ADDRESS);
        cut_const(cut,0u); cut_set(cut,CUT_VALUE);
        const pl_x86_memory *source=source_address(instruction);
        cut->report.memory_access = MACHINE_MEMORY_READ;
        cut->report.memory_access|=cut_memory_role(source);
        cut_access(cut);
        cut_access_value(cut); cut_set(cut,CUT_VALUE);
    }
    if(compare && law.reads_source){cut_get(cut,CUT_VALUE);cut_set(cut,CUT_LEFT);}
    if(law.reads_target || law.writes_target){
        cut_get(cut,8u);cut_mask(cut,width);cut_set(cut,CUT_ADDRESS);
        cut->report.memory_access=law.writes_target?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ;
        if(pattern){pattern_count(cut,bytes);pattern_access(cut,bytes);}else cut_access(cut);
        if(compare){
            cut_access_value(cut);cut_set(cut,CUT_RIGHT);
            cut_get(cut,CUT_LEFT);cut_get(cut,CUT_RIGHT);cut_op(cut,0x7du);cut_mask(cut,law.bits);cut_set(cut,CUT_VALUE);
            cut_arithmetic_flags(cut,law.bits,1,0,CUT_CARRY_NORMAL);
        }
    }
    if(law.writes_accumulator){
        pl_x86_register accumulator={.class_id=PL_X86_REGISTER_GPR,.bits=law.bits};
        cut_write_register(cut,&accumulator);
    }
    /* A fault/miss commits no part of this element. Only REP publishes a
     * completed-element frontier on partial return. Without REP, RCX is
     * neither read nor written and faulting 32-bit pointers keep their old
     * parent values. Successful publication zero-extends the new pointers. */
    if (repeated) {
        cut_get(cut,2u);if(pattern)cut_get(cut,CUT_NEXT);else cut_const(cut,1u);
        cut_op(cut,0x7du); cut_mask(cut,width); cut_set(cut,2u);
    }
    for(pl_u32 local=7u;local<=8u;++local){
        if(!(cut->report.written_registers&(1u<<(local-1u))))continue;
        cut_get(cut,local);cut_get(cut,stride);if(pattern){cut_get(cut,CUT_NEXT);cut_op(cut,0x7eu);}cut_op(cut,0x7cu);
        cut_mask(cut,width); cut_set(cut,local);
    }
    if (repeated) {
        if(compare){
            cut_get(cut,CUT_FLAGS);cut_const(cut,0x40u);cut_op(cut,0x83u);cut_op(cut,0x50u);
            if(law.not_equal)cut_op(cut,0x45u);
            cut_op(cut,0x0du);wasm_writer_uleb(cut->writer,1u);
        }
        cut_get(cut,CUT_REPEAT_BUDGET);if(pattern)cut_get(cut,CUT_NEXT);else cut_const(cut,1u);
        cut_op(cut,0x7du); cut_set(cut,CUT_REPEAT_BUDGET);
        cut_op(cut,0x0cu); wasm_writer_uleb(cut->writer,0u);
        cut_op(cut,0x0bu); cut_op(cut,0x0bu);
    }
    cut->report.memory_access=law.kind==0u?MACHINE_MEMORY_READ|MACHINE_MEMORY_WRITE:store?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ;
    if(law.reads_source)cut->report.memory_access|=cut_memory_role(source_address(instruction));
}
