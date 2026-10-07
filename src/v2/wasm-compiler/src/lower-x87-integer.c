#include "cut-internal.h"
enum { FI_CW=26,FI_SW,FI_TOP,FI_NEXT,FI_TAG,FI_FULL,FI_UNMASKED,FI_INPUT,FI_SIG,FI_SE,FI_KIND,FI_FIRST=38 };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local,int store)
{
    cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);
    wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);
}
static void payload(cut_lowering *c,pl_u32 offset,pl_u32 local,pl_u32 shift,pl_u32 opcode)
{
    cut_get(c,0u);cut_get(c,FI_NEXT);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    cut_get(c,local);cut_op(c,opcode);wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);
}
void cut_lower_x87_integer(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_integer_load law;if(!pl_x86_x87_integer_load_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_integer_plan(law.bytes*8u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,FI_CW,FI_SW);
    const pl_x86_memory *address=&i->operands[0].value.memory;
    cut_effective_address(c,i,address);cut_set(c,CUT_ADDRESS);
    c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(address);cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);
    cut_access_value(c);cut_set(c,FI_INPUT);
    const pl_u32 input[]={FI_INPUT,FI_INPUT,FI_INPUT,FI_INPUT,FI_INPUT},output[]={FI_SIG,FI_SE,FI_KIND};
    cut_emit_scalar_plan(c,&pure,input,FI_FIRST,output);
    word(c,offsetof(machine_state,x87_tag),FI_TAG,0);
    cut_get(c,FI_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FI_TOP);
    cut_get(c,FI_TOP);cut_const(c,7u);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FI_NEXT);
    cut_get(c,FI_TAG);cut_get(c,FI_NEXT);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_const(c,3u);cut_op(c,0x52u);cut_op(c,0xadu);cut_set(c,FI_FULL);
    cut_get(c,FI_CW);cut_const(c,1u);cut_op(c,0x83u);cut_op(c,0x50u);cut_get(c,FI_FULL);cut_op(c,0xa7u);cut_op(c,0x71u);cut_op(c,0xadu);cut_set(c,FI_UNMASKED);
    // Overflow reports IE/SF/C1. A masked overflow pushes the indefinite;
    // an unmasked overflow keeps TOP/payload/tag and only latches the error.
    cut_get(c,FI_FULL);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,FI_SW);cut_const(c,0x241u);cut_op(c,0x84u);cut_set(c,FI_SW);
    cut_const(c,0xc000000000000000ull);cut_set(c,FI_SIG);cut_const(c,0xffffu);cut_set(c,FI_SE);cut_const(c,2u);cut_set(c,FI_KIND);
    cut_op(c,0x05u);cut_get(c,FI_SW);cut_const(c,~0x200ull);cut_op(c,0x83u);cut_set(c,FI_SW);cut_op(c,0x0bu);
    cut_get(c,FI_UNMASKED);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,FI_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,FI_SW);
    cut_const(c,law.opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);
    cut_store(c,offsetof(machine_state,x87_dp),CUT_ADDRESS);
    cut_op(c,0x05u);
    payload(c,offsetof(machine_state,x87_significand),FI_SIG,3u,0x37u);
    payload(c,offsetof(machine_state,x87_sign_exponent),FI_SE,1u,0x3du);
    cut_get(c,FI_TAG);cut_const(c,3u);cut_get(c,FI_NEXT);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_get(c,FI_KIND);cut_get(c,FI_NEXT);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FI_TAG);
    word(c,offsetof(machine_state,x87_tag),FI_TAG,1);
    cut_get(c,FI_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_get(c,FI_NEXT);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FI_SW);
    cut_op(c,0x0bu);word(c,offsetof(machine_state,x87_status),FI_SW,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
