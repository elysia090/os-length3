#include "cut-internal.h"
enum { CW=26,SW,TAG,TOP,PUSH,SIG,SE,EXP_SIG,EXP_SE,RAISED,SUPPRESS,FULL,EMPTY,FIRST=40 };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local,int store)
{cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);}
static void lane(cut_lowering *c,pl_u32 index,pl_u32 offset,pl_u32 local,pl_u32 shift,int store)
{cut_get(c,0u);cut_get(c,index);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);if(store)cut_get(c,local);
 cut_op(c,shift==3u?(store?0x37u:0x29u):(store?0x3du:0x33u));wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);}
static void empty(cut_lowering *c,pl_u32 index)
{cut_get(c,TAG);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);}
static void publish_tag(cut_lowering *c,pl_u32 index,pl_u32 shift)
{cut_get(c,TAG);cut_const(c,3u);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
 cut_get(c,RAISED);cut_const(c,shift);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,TAG);}
void cut_lower_x87_extract(cut_lowering *c,const pl_x86_instruction *i)
{
    if(!pl_x86_x87_extract_supported(i)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,CW,SW);word(c,offsetof(machine_state,x87_tag),TAG,0);
    cut_get(c,SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,TOP);
    cut_get(c,TOP);cut_const(c,7u);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,PUSH);
    empty(c,TOP);cut_set(c,EMPTY);empty(c,PUSH);cut_op(c,0x50u);cut_op(c,0xadu);cut_set(c,FULL);
    lane(c,TOP,offsetof(machine_state,x87_significand),SIG,3u,0);lane(c,TOP,offsetof(machine_state,x87_sign_exponent),SE,1u,0);
    _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_extract_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 input[]={SIG,SE,CW,EMPTY,FULL,0u},output[]={SIG,SE,EXP_SIG,EXP_SE,RAISED,SUPPRESS};
    cut_emit_scalar_projection(c,&pure,input,FIRST,output,6u);
    cut_get(c,SW);cut_const(c,~0x200ull);cut_op(c,0x83u);cut_get(c,RAISED);cut_const(c,0x27fu);cut_op(c,0x83u);cut_op(c,0x84u);cut_set(c,SW);
    cut_get(c,SUPPRESS);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,SW);cut_const(c,0x1f4u);cut_set(c,CUT_VALUE);
    word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);cut_op(c,0x05u);
    lane(c,TOP,offsetof(machine_state,x87_significand),EXP_SIG,3u,1);lane(c,TOP,offsetof(machine_state,x87_sign_exponent),EXP_SE,1u,1);
    lane(c,PUSH,offsetof(machine_state,x87_significand),SIG,3u,1);lane(c,PUSH,offsetof(machine_state,x87_sign_exponent),SE,1u,1);
    publish_tag(c,TOP,20u);publish_tag(c,PUSH,18u);word(c,offsetof(machine_state,x87_tag),TAG,1);
    cut_get(c,SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_get(c,PUSH);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,SW);cut_op(c,0x0bu);
    word(c,offsetof(machine_state,x87_status),SW,1);cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
