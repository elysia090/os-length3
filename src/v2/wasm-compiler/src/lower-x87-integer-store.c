#include "cut-internal.h"
enum { IS_CW=26,IS_SW,IS_TOP,IS_TAG,IS_SIG,IS_SE,IS_EMPTY,IS_VALUE,IS_RAISED,IS_SUPPRESS,IS_UNMASKED,IS_FIRST };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local,int store)
{
    cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);
    wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);
}
static void payload(cut_lowering *c,pl_u32 offset,pl_u32 local,pl_u32 shift)
{
    cut_get(c,0u);cut_get(c,IS_TOP);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    cut_op(c,shift==3u?0x29u:0x33u);wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);cut_set(c,local);
}
void cut_lower_x87_integer_store(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_integer_store law;if(!pl_x86_x87_integer_store_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_integer_store_plan(law.bytes*8u,law.truncate,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,IS_CW,IS_SW);word(c,offsetof(machine_state,x87_tag),IS_TAG,0);
    cut_get(c,IS_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,IS_TOP);
    payload(c,offsetof(machine_state,x87_significand),IS_SIG,3u);payload(c,offsetof(machine_state,x87_sign_exponent),IS_SE,1u);
    cut_get(c,IS_TAG);cut_get(c,IS_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);cut_set(c,IS_EMPTY);
    const pl_u32 input[]={IS_SIG,IS_SE,IS_CW,IS_EMPTY,IS_EMPTY},output[]={IS_VALUE,IS_RAISED,IS_SUPPRESS};
    cut_emit_scalar_plan(c,&pure,input,IS_FIRST,output);
    const pl_x86_memory *address=&i->operands[0].value.memory;cut_effective_address(c,i,address);cut_set(c,CUT_ADDRESS);
    c->report.memory_access=MACHINE_MEMORY_WRITE|cut_memory_role(address);
    // Unmasked invalid never touches the destination, even a protected page.
    // Every other result uses write-only preflight before any FPU publication;
    // no destination load/RMW or dummy write can escape this boundary.
    cut_get(c,IS_SUPPRESS);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,law.bytes);cut_i32_const(c,c->report.memory_access);
    cut_call(c,WASM_IMPORT_WRITE_BEGIN);cut_access_status(c);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,0u);cut_i32_const(c,law.bytes);cut_get(c,IS_VALUE);
    cut_call(c,WASM_IMPORT_WRITE_WORD);cut_access_status(c);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_call(c,WASM_IMPORT_WRITE_END);cut_access_status(c);cut_op(c,0x0bu);
    cut_get(c,IS_SW);cut_const(c,~0x200ull);cut_op(c,0x83u);cut_get(c,IS_RAISED);cut_op(c,0x84u);cut_set(c,IS_SW);
    cut_get(c,IS_RAISED);cut_get(c,IS_CW);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);cut_const(c,63u);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,IS_UNMASKED);
    cut_get(c,IS_UNMASKED);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,IS_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,IS_SW);
    cut_const(c,law.opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);cut_store(c,offsetof(machine_state,x87_dp),CUT_ADDRESS);
    cut_op(c,0x0bu);
    if(law.pop){cut_get(c,IS_SUPPRESS);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
        cut_get(c,IS_TAG);cut_const(c,3u);cut_get(c,IS_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,IS_TAG);
        word(c,offsetof(machine_state,x87_tag),IS_TAG,1);
        cut_get(c,IS_TOP);cut_const(c,1u);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_const(c,11u);cut_op(c,0x86u);
        cut_get(c,IS_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_op(c,0x84u);cut_set(c,IS_SW);cut_op(c,0x0bu);}
    word(c,offsetof(machine_state,x87_status),IS_SW,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
