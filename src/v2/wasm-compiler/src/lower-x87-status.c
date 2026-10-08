#include "cut-internal.h"
enum { SC_SW=26,SC_CW,SC_TOP,SC_TAG,SC_A,SC_SA,SC_B,SC_SB,SC_EMPTY,SC_REL,SC_RAISED,SC_UNMASKED,SC_FIRST };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local)
{cut_get(c,0u);cut_op(c,0x33u);wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);cut_set(c,local);}
static void payload(cut_lowering *c,pl_u32 index,pl_u32 offset,pl_u32 shift,pl_u32 local)
{
    cut_get(c,0u);cut_get(c,index);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    cut_op(c,shift==3u?0x29u:0x33u);wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);cut_set(c,local);
}
static void empty(cut_lowering *c,pl_u32 index)
{
    cut_get(c,SC_TAG);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_const(c,3u);cut_op(c,0x51u);
}
void cut_lower_x87_status_compare(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_status_compare law;if(!pl_x86_x87_status_compare_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    int status=law.memory?pl_x86_x87_memory_relation_plan(law.bytes*8u,law.integer,&arena,&pure):
        law.zero?pl_x86_x87_zero_relation_plan(&arena,&pure):pl_x86_x87_relation_plan(law.ordered,!law.source,&arena,&pure);
    if(status){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,SC_CW,SC_SW);
    if(law.memory){const pl_x86_memory *address=&i->operands[0].value.memory;
        cut_effective_address(c,i,address);cut_set(c,CUT_ADDRESS);
        c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(address);cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);
        cut_access_value(c);cut_set(c,SC_B);cut_const(c,0u);cut_set(c,SC_SB);}
    word(c,offsetof(machine_state,x87_tag),SC_TAG);
    cut_get(c,SC_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,SC_TOP);
    payload(c,SC_TOP,offsetof(machine_state,x87_significand),3u,SC_A);
    payload(c,SC_TOP,offsetof(machine_state,x87_sign_exponent),1u,SC_SA);
    if(!law.memory&&!law.zero){cut_get(c,SC_TOP);cut_const(c,law.source);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,CUT_VALUE);
        payload(c,CUT_VALUE,offsetof(machine_state,x87_significand),3u,SC_B);
        payload(c,CUT_VALUE,offsetof(machine_state,x87_sign_exponent),1u,SC_SB);}
    empty(c,SC_TOP);
    if(!law.memory&&!law.zero){empty(c,CUT_VALUE);cut_op(c,0x72u);}
    cut_op(c,0xadu);cut_set(c,SC_EMPTY);
    const pl_u32 inputs[]={SC_A,SC_SA,SC_B,SC_SB,SC_EMPTY},outputs[]={SC_REL,SC_RAISED,SC_EMPTY};
    cut_emit_scalar_plan(c,&pure,inputs,SC_FIRST,outputs);
    const cut_x87_comparison view={SC_TOP,SC_TAG,SC_SW,SC_CW,SC_REL,SC_RAISED,SC_EMPTY,SC_UNMASKED,law.opcode,law.pop,law.memory,1u};
    cut_publish_x87_comparison(c,i,&view);
}
