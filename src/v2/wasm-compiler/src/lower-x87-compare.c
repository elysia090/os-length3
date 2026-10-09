#include "cut-internal.h"
enum { FP_TOP=26,FP_OTHER,FP_TAG,FP_SW,FP_CW,FP_A,FP_SA,FP_B,FP_SB,FP_EMPTY,
       FP_FIRST,FP_REL=132,FP_RAISED,FP_UNMASKED };
static void load16(cut_lowering *c,pl_u32 offset,pl_u32 local)
{cut_get(c,0u);cut_op(c,0x33u);wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);cut_set(c,local);}
static void store16(cut_lowering *c,pl_u32 offset,pl_u32 local)
{cut_get(c,0u);cut_get(c,local);cut_op(c,0x3du);wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);}
static void fault_if(cut_lowering *c,pl_u32 vector)
{
    cut_op(c,0x04u);cut_op(c,0x40u);cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_load(c,offsetof(machine_state,rip));
    cut_op(c,0x37u);wasm_writer_uleb(c->writer,3u);wasm_writer_uleb(c->writer,offsetof(machine_memory_port,fault_address));
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,vector);cut_op(c,0x36u);
    wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_memory_port,fault_vector));
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,0u);cut_op(c,0x36u);
    wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_memory_port,fault_error));
    cut_const(c,machine_result_make(MACHINE_RESULT_FAULT,vector));cut_op(c,0x0fu);cut_op(c,0x0bu);
}
static void register_load(cut_lowering *c,pl_u32 index,pl_u32 offset,pl_u32 shift,pl_u32 opcode,pl_u32 local)
{
    cut_get(c,0u);cut_get(c,index);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    cut_op(c,opcode);wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);cut_set(c,local);
}
void cut_x87_pending_guard(cut_lowering *c,pl_u32 cw,pl_u32 sw)
{
    load16(c,offsetof(machine_state,x87_control),cw);load16(c,offsetof(machine_state,x87_status),sw);
    cut_get(c,cw);cut_const(c,~0ull);cut_op(c,0x85u);cut_get(c,sw);cut_op(c,0x83u);cut_const(c,63u);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_load(c,offsetof(machine_state,cr0));cut_const(c,32u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x45u);fault_if(c,16u);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_call(c,WASM_IMPORT_FLOATING_WAIT);cut_op(c,0x0fu);cut_op(c,0x0bu);
}
void cut_x87_device_guard(cut_lowering *c)
{
    cut_load(c,offsetof(machine_state,cr0));cut_const(c,12u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x45u);fault_if(c,7u);
}
void cut_x87_wait_guard(cut_lowering *c,pl_u32 cw,pl_u32 sw)
{
    cut_x87_device_guard(c);
    cut_x87_pending_guard(c,cw,sw);
}
void cut_lower_x87_wait(cut_lowering *c)
{
    /* FWAIT ignores EM. MP && TS raises #NM before pending #MF/FERR. No
     * numeric state, instruction pointer or opcode is published on success. */
    cut_load(c,offsetof(machine_state,cr0));cut_const(c,10u);cut_op(c,0x83u);
    cut_const(c,10u);cut_op(c,0x51u);fault_if(c,7u);
    cut_x87_pending_guard(c,CUT_LEFT,CUT_RIGHT);
}
void cut_lower_x87_compare(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_compare law;if(!pl_x86_x87_compare_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_relation_plan(law.ordered,!law.source,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    // Native #MF is deferred to this waiting operation. Legacy FERR goes to
    // the C device/interrupt owner; neither path starts numeric publication.
    cut_x87_wait_guard(c,FP_CW,FP_SW);
    load16(c,offsetof(machine_state,x87_tag),FP_TAG);
    cut_get(c,FP_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FP_TOP);
    cut_get(c,FP_TOP);cut_const(c,law.source);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FP_OTHER);
    register_load(c,FP_TOP,offsetof(machine_state,x87_significand),3u,0x29u,FP_A);
    register_load(c,FP_TOP,offsetof(machine_state,x87_sign_exponent),1u,0x33u,FP_SA);
    register_load(c,FP_OTHER,offsetof(machine_state,x87_significand),3u,0x29u,FP_B);
    register_load(c,FP_OTHER,offsetof(machine_state,x87_sign_exponent),1u,0x33u,FP_SB);
    cut_get(c,FP_TAG);cut_get(c,FP_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_const(c,3u);cut_op(c,0x51u);
    cut_get(c,FP_TAG);cut_get(c,FP_OTHER);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_const(c,3u);cut_op(c,0x51u);
    cut_op(c,0x72u);cut_op(c,0xadu);cut_set(c,FP_EMPTY);
    const pl_u32 inputs[]={FP_A,FP_SA,FP_B,FP_SB,FP_EMPTY},outputs[]={FP_REL,FP_RAISED,FP_EMPTY};
    cut_emit_scalar_plan(c,&pure,inputs,FP_FIRST,outputs);
    const cut_x87_comparison view={FP_TOP,FP_TAG,FP_SW,FP_CW,FP_REL,FP_RAISED,FP_EMPTY,FP_UNMASKED,law.opcode,law.pop,0u,0u};
    cut_publish_x87_comparison(c,i,&view);
}
void cut_publish_x87_comparison(cut_lowering *c,const pl_x86_instruction *i,const cut_x87_comparison *p)
{
    cut_get(c,p->raised);cut_get(c,p->cw);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);cut_const(c,63u);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,p->unmasked);
    cut_get(c,p->sw);cut_const(c,~0x200ull);cut_op(c,0x83u);
    if(!p->status){cut_get(c,p->sw);cut_get(c,p->empty);cut_op(c,0xa7u);cut_op(c,0x1bu);}
    cut_set(c,p->sw);cut_get(c,p->sw);cut_get(c,p->raised);cut_op(c,0x84u);cut_set(c,p->sw);
    if(p->status){cut_get(c,p->sw);cut_const(c,~0x4500ull);cut_op(c,0x83u);
        cut_get(c,p->relation);cut_const(c,8u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,p->sw);}
    cut_get(c,p->unmasked);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,p->sw);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,p->sw);
    cut_const(c,p->opcode);cut_set(c,CUT_VALUE);store16(c,offsetof(machine_state,x87_opcode),CUT_VALUE);
    if(p->memory)cut_store(c,offsetof(machine_state,x87_dp),CUT_ADDRESS);
    cut_op(c,0x0bu);
    if(p->pop){cut_get(c,p->unmasked);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
        for(pl_u32 n=0u;n<p->pop;++n){cut_get(c,p->tag);cut_const(c,3u);cut_get(c,p->top);
            if(n){cut_const(c,n);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);}
            cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,p->tag);}
        store16(c,offsetof(machine_state,x87_tag),p->tag);
        cut_get(c,p->sw);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_get(c,p->top);cut_const(c,p->pop);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);
        cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,p->sw);cut_op(c,0x0bu);}
    store16(c,offsetof(machine_state,x87_status),p->sw);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
    if(!p->status){cut_get(c,CUT_FLAGS);cut_const(c,~0x8d5ull);cut_op(c,0x83u);cut_get(c,p->relation);cut_op(c,0x84u);cut_set(c,CUT_FLAGS);c->report.flags_written=1u;}
}
