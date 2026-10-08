#include "cut-internal.h"
enum {EN_CURSOR=26,EN_VALUE,EN_NEXT};
static void checkpoint(cut_lowering *c,pl_u32 operation,pl_u32 next,pl_u32 keep)
{
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,operation);cut_const(c,next);
    if(keep)cut_get(c,EN_VALUE);else cut_const(c,0u);
    cut_call(c,WASM_IMPORT_CHECKPOINT);cut_access_status(c);
}
void cut_lower_enter(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_enter law;if(!pl_x86_enter_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_x86_register sp={PL_X86_REGISTER_GPR,4u,64u,0u},bp={PL_X86_REGISTER_GPR,5u,64u,0u};
    const pl_x86_operand sp_operand={.kind=PL_X86_OPERAND_REGISTER,.bits=64u,.value.reg=sp},bp_operand={.kind=PL_X86_OPERAND_REGISTER,.bits=64u,.value.reg=bp};
    cut_read_operand(c,&sp_operand,64u);cut_set(c,5u);cut_read_operand(c,&bp_operand,64u);cut_set(c,6u);
    checkpoint(c,MACHINE_CHECKPOINT_GET,0u,0u);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
    wasm_writer_uleb(c->writer,offsetof(machine_memory_checkpoint_port,cursor));cut_set(c,EN_CURSOR);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
    wasm_writer_uleb(c->writer,offsetof(machine_memory_checkpoint_port,frontier));cut_set(c,EN_VALUE);
    cut_get(c,EN_CURSOR);cut_const(c,law.steps);cut_op(c,0x5au);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_const(c,MACHINE_RESULT_ENTRY_MAP);cut_op(c,0x0fu);cut_op(c,0x0bu);
    for(pl_u32 rank=0u;rank<law.steps;++rank){pl_x86_enter_step_info step;
        if(!pl_x86_enter_step(&law,rank,&step)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        cut_get(c,EN_CURSOR);cut_const(c,rank);cut_op(c,0x58u);cut_op(c,0x04u);cut_op(c,0x40u); /* cursor <= rank */
        cut_get(c,step.kind==PL_X86_ENTER_READ?6u:5u);cut_const(c,step.subtract);cut_op(c,0x7du);cut_set(c,CUT_ADDRESS);
        c->report.memory_bytes=law.bytes;
        if(step.kind==PL_X86_ENTER_PROBE){
            cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,law.bytes);
            cut_i32_const(c,MACHINE_MEMORY_WRITE|MACHINE_MEMORY_STACK);cut_call(c,WASM_IMPORT_WRITE_BEGIN);cut_access_status(c);
            cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_call(c,WASM_IMPORT_WRITE_END);cut_access_status(c);
        }else{
            c->report.memory_access=MACHINE_MEMORY_STACK|(step.kind==PL_X86_ENTER_READ?MACHINE_MEMORY_READ:MACHINE_MEMORY_WRITE);
            if(step.kind==PL_X86_ENTER_OLD_BASE)cut_get(c,6u);
            else if(step.kind==PL_X86_ENTER_COPY)cut_get(c,EN_VALUE);
            else if(step.kind==PL_X86_ENTER_FRAME){cut_get(c,5u);cut_const(c,law.bytes);cut_op(c,0x7du);}
            else cut_const(c,0u);
            cut_set(c,CUT_VALUE);cut_access(c);
            if(step.kind==PL_X86_ENTER_READ){cut_access_value(c);cut_set(c,EN_VALUE);}
        }
        checkpoint(c,MACHINE_CHECKPOINT_SET,rank+1u,step.kind==PL_X86_ENTER_READ);
        cut_op(c,0x0bu);
    }
    checkpoint(c,MACHINE_CHECKPOINT_CLEAR,0u,0u);
    cut_get(c,5u);cut_const(c,law.bytes);cut_op(c,0x7du);cut_set(c,EN_NEXT);
    cut_get(c,5u);cut_const(c,law.bytes*(law.level?law.level+1u:1u)+law.allocation);cut_op(c,0x7du);cut_set(c,CUT_VALUE);cut_write_register(c,&sp);
    pl_x86_register destination=bp;destination.bits=(pl_u16)(law.bytes*8u);
    cut_get(c,EN_NEXT);cut_mask(c,law.bytes*8u);cut_set(c,CUT_VALUE);cut_write_register(c,&destination);
    c->report.memory_access=MACHINE_MEMORY_STACK|MACHINE_MEMORY_WRITE|(law.level>1u?MACHINE_MEMORY_READ:0u);
}
