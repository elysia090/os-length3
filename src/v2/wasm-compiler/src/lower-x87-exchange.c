#include "cut-internal.h"
enum { X_CW=26,X_SW,X_TAG,X_TOP,X_OTHER,X_EA,X_EB,X_EMPTY,X_A,X_SA,X_B,X_SB,X_RAISED,X_SUPPRESS,X_UNMASKED,X_FIRST };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local,int store)
{
    cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);
    wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);
}
static void lane(cut_lowering *c,pl_u32 index,pl_u32 offset,pl_u32 local,pl_u32 shift,int store)
{
    cut_get(c,0u);cut_get(c,index);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    if(store)cut_get(c,local);
    cut_op(c,shift==3u?(store?0x37u:0x29u):(store?0x3du:0x33u));
    wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);
}
static void tag(cut_lowering *c,pl_u32 index,pl_u32 local)
{
    cut_get(c,X_TAG);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,local);
}
static void replace(cut_lowering *c,pl_u32 index,pl_u32 value)
{
    cut_get(c,X_TAG);cut_const(c,3u);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_get(c,value);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,X_TAG);
}
void cut_lower_x87_exchange(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_exchange law;if(!pl_x86_x87_exchange_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_exchange_plan(!law.source,&arena,&pure)||pure.node_count>32u){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,X_CW,X_SW);word(c,offsetof(machine_state,x87_tag),X_TAG,0);
    cut_get(c,X_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,X_TOP);
    cut_get(c,X_TOP);cut_const(c,law.source);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,X_OTHER);
    tag(c,X_TOP,X_EA);tag(c,X_OTHER,X_EB);
    cut_get(c,X_EA);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);cut_set(c,X_EA);
    cut_get(c,X_EB);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);cut_set(c,X_EB);
    cut_get(c,X_EA);cut_get(c,X_EB);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,X_EMPTY);
    cut_const(c,0u);cut_set(c,X_A);cut_const(c,0u);cut_set(c,X_SA);cut_const(c,0u);cut_set(c,X_B);cut_const(c,0u);cut_set(c,X_SB);
    if(law.source){
        // An unmasked stack fault publishes no data. Empty lanes are constants
        // in the SSA, so none of their latent payload is read either.
        cut_get(c,X_EMPTY);cut_op(c,0x50u);cut_get(c,X_CW);cut_const(c,1u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x72u);
        cut_op(c,0x04u);cut_op(c,0x40u);
        cut_get(c,X_EA);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
        lane(c,X_TOP,offsetof(machine_state,x87_significand),X_A,3u,0);lane(c,X_TOP,offsetof(machine_state,x87_sign_exponent),X_SA,1u,0);cut_op(c,0x0bu);
        cut_get(c,X_EB);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
        lane(c,X_OTHER,offsetof(machine_state,x87_significand),X_B,3u,0);lane(c,X_OTHER,offsetof(machine_state,x87_sign_exponent),X_SB,1u,0);cut_op(c,0x0bu);cut_op(c,0x0bu);
    }
    const pl_u32 inputs[]={X_A,X_SA,law.source?X_B:X_A,law.source?X_SB:X_SA,X_CW,X_EMPTY},outputs[]={X_RAISED,X_SUPPRESS,X_A,X_SA,X_B,X_SB};
    cut_emit_scalar_projection(c,&pure,inputs,X_FIRST,outputs,law.source?6u:4u);
    cut_get(c,X_SW);cut_const(c,~0x200ull);cut_op(c,0x83u);cut_get(c,X_RAISED);cut_op(c,0x84u);cut_set(c,X_SW);
    cut_get(c,X_SUPPRESS);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,X_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,X_SW);
    cut_const(c,law.opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);cut_op(c,0x0bu);
    cut_get(c,X_SUPPRESS);cut_op(c,0x50u);
    if(!law.source){cut_get(c,X_EMPTY);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x71u);}
    cut_op(c,0x04u);cut_op(c,0x40u);
    lane(c,X_TOP,offsetof(machine_state,x87_significand),X_A,3u,1);lane(c,X_TOP,offsetof(machine_state,x87_sign_exponent),X_SA,1u,1);
    if(law.source){lane(c,X_OTHER,offsetof(machine_state,x87_significand),X_B,3u,1);lane(c,X_OTHER,offsetof(machine_state,x87_sign_exponent),X_SB,1u,1);}
    // Capture BOTH old tags before either replacement, including overlap.
    tag(c,X_TOP,X_A);tag(c,X_OTHER,X_B);
    cut_get(c,X_A);cut_const(c,2u);cut_get(c,X_EA);cut_op(c,0x50u);cut_op(c,0x1bu);cut_set(c,X_A);
    cut_get(c,X_B);cut_const(c,2u);cut_get(c,X_EB);cut_op(c,0x50u);cut_op(c,0x1bu);cut_set(c,X_B);
    replace(c,X_TOP,X_B);if(law.source)replace(c,X_OTHER,X_A);word(c,offsetof(machine_state,x87_tag),X_TAG,1);cut_op(c,0x0bu);
    word(c,offsetof(machine_state,x87_status),X_SW,1);cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
