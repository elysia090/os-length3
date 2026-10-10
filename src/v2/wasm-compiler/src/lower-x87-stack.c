#include "cut-internal.h"
enum { FS_CW=26,FS_SW,FS_TAG,FS_FIRST };
static void word(cut_lowering *c,pl_u32 at,pl_u32 local,int store)
{
    cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);
    wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,at);if(!store)cut_set(c,local);
}
void cut_lower_x87_stack(cut_lowering *c,const pl_x86_instruction *i)
{
    if(pl_x86_x87_examine_supported(i)){
        enum { TAG=28u,SIG=29u,SE=30u,INDEX=31u,EMPTY=32u,FIRST=34u };
        cut_x87_wait_guard(c,FS_CW,FS_SW);word(c,offsetof(machine_state,x87_tag),TAG,0);
        cut_get(c,FS_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,INDEX);
        cut_get(c,TAG);cut_get(c,INDEX);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
        cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);cut_set(c,EMPTY);
        cut_get(c,0u);cut_get(c,INDEX);cut_const(c,3u);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
        cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);wasm_writer_uleb(c->writer,offsetof(machine_state,x87_significand));cut_set(c,SIG);
        cut_get(c,0u);cut_get(c,INDEX);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
        cut_op(c,0x33u);wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offsetof(machine_state,x87_sign_exponent));cut_set(c,SE);
        _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
        if(pl_x86_x87_examine_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        const pl_u32 input[]={SIG,SE,FS_SW,EMPTY},output[]={FS_SW};cut_emit_scalar_projection(c,&pure,input,FIRST,output,1u);
        word(c,offsetof(machine_state,x87_status),FS_SW,1);cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);return;
    }
    pl_x86_x87_stack law;if(!pl_x86_x87_stack_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_stack_plan(&law,&arena,&pure)||pure.node_count>PL_X86_X87_STACK_MAX_NODES){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,FS_CW,FS_SW);word(c,offsetof(machine_state,x87_tag),FS_TAG,0);
    const pl_u32 inputs[]={FS_SW,FS_TAG,FS_CW,FS_SW,FS_TAG},outputs[]={FS_SW,FS_TAG};
    cut_emit_scalar_projection(c,&pure,inputs,FS_FIRST,outputs,2u);
    word(c,offsetof(machine_state,x87_status),FS_SW,1);
    if(law.free_register)word(c,offsetof(machine_state,x87_tag),FS_TAG,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
    /* No new numeric exception: FOP/DP and all payload lanes remain untouched. */
}
