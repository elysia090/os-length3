#include "cut-internal.h"
enum { IS_CW=26,IS_SW,IS_TOP,IS_TAG,IS_SIG,IS_SE,IS_EMPTY,IS_VALUE,IS_HIGH,IS_RAISED,IS_SUPPRESS,IS_UNMASKED,IS_DST,IS_FIRST };
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
static void write_payload(cut_lowering *c,pl_u32 offset,pl_u32 local,pl_u32 shift)
{
    cut_get(c,0u);cut_get(c,IS_DST);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    cut_get(c,local);cut_op(c,shift==3u?0x37u:0x3du);wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);
}
void cut_lower_x87_store(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_integer_store integer;pl_x86_x87_float_store floating;
    int integral=pl_x86_x87_integer_store_lower(i,&integer);
    if(!integral&&!pl_x86_x87_float_store_lower(i,&floating)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    pl_u32 bytes=integral?integer.bytes:floating.bytes,pop=integral?integer.pop:floating.pop,
        opcode=integral?integer.opcode:floating.opcode,memory=integral||floating.memory,no_check=!integral&&floating.no_check;
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(!no_check){int status=integral?pl_x86_x87_integer_store_plan(bytes*8u,integer.truncate,&arena,&pure):pl_x86_x87_float_store_plan(bytes*8u,&arena,&pure);
        if(status||pure.node_count>PL_X86_X87_FLOAT_STORE_MAX_NODES){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}}
    cut_x87_wait_guard(c,IS_CW,IS_SW);word(c,offsetof(machine_state,x87_tag),IS_TAG,0);
    cut_get(c,IS_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,IS_TOP);
    cut_get(c,IS_TAG);cut_get(c,IS_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);cut_set(c,IS_EMPTY);
    const pl_u32 input[]={IS_SIG,IS_SE,IS_CW,IS_EMPTY,IS_EMPTY},integer_output[]={IS_VALUE,IS_RAISED,IS_SUPPRESS},
        float_output[]={IS_VALUE,IS_HIGH,IS_RAISED,IS_SUPPRESS};
    if(no_check){cut_const(c,0u);cut_set(c,IS_RAISED);cut_const(c,0u);cut_set(c,IS_SUPPRESS);}
    else{payload(c,offsetof(machine_state,x87_significand),IS_SIG,3u);payload(c,offsetof(machine_state,x87_sign_exponent),IS_SE,1u);
        cut_emit_scalar_projection(c,&pure,input,IS_FIRST,integral?integer_output:float_output,integral?3u:4u);}
    if(memory){const pl_x86_memory *address=&i->operands[0].value.memory;
        cut_effective_address(c,i,address);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_WRITE|cut_memory_role(address);}
    // Suppressed invalid/format-overflow/underflow never touch a destination.
    // Every published memory result uses write-only preflight before any FPU publication;
    // no destination load/RMW or dummy write can escape this boundary.
    cut_get(c,IS_SUPPRESS);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    if(memory){
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,bytes);cut_i32_const(c,c->report.memory_access);
    cut_call(c,WASM_IMPORT_WRITE_BEGIN);cut_access_status(c);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,0u);cut_i32_const(c,bytes==10u?8u:bytes);cut_get(c,IS_VALUE);
    cut_call(c,WASM_IMPORT_WRITE_WORD);cut_access_status(c);
    if(bytes==10u){cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,8u);cut_i32_const(c,2u);cut_get(c,IS_HIGH);
        cut_call(c,WASM_IMPORT_WRITE_WORD);cut_access_status(c);}
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_call(c,WASM_IMPORT_WRITE_END);cut_access_status(c);
    }else{
        /* FSTPNCE transfers only a nonempty source; an empty source causes
         * no payload read, copy or exception, but the later pop still occurs. */
        if(no_check){cut_get(c,IS_EMPTY);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
            payload(c,offsetof(machine_state,x87_significand),IS_VALUE,3u);payload(c,offsetof(machine_state,x87_sign_exponent),IS_HIGH,1u);}
        cut_get(c,IS_TOP);cut_const(c,floating.destination);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,IS_DST);
        write_payload(c,offsetof(machine_state,x87_significand),IS_VALUE,3u);write_payload(c,offsetof(machine_state,x87_sign_exponent),IS_HIGH,1u);
        cut_get(c,IS_TAG);cut_get(c,IS_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
        cut_const(c,2u);cut_get(c,IS_EMPTY);cut_op(c,0x50u);cut_op(c,0x1bu);cut_set(c,IS_VALUE);
        cut_get(c,IS_TAG);cut_const(c,3u);cut_get(c,IS_DST);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);
        cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
        cut_get(c,IS_VALUE);cut_get(c,IS_DST);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,IS_TAG);
        if(no_check)cut_op(c,0x0bu);
    }
    cut_op(c,0x0bu);
    cut_get(c,IS_SW);cut_const(c,~0x200ull);cut_op(c,0x83u);cut_get(c,IS_RAISED);cut_op(c,0x84u);cut_set(c,IS_SW);
    cut_get(c,IS_RAISED);cut_get(c,IS_CW);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);cut_const(c,63u);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,IS_UNMASKED);
    cut_get(c,IS_UNMASKED);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,IS_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,IS_SW);
    cut_const(c,opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);
    if(memory)cut_store(c,offsetof(machine_state,x87_dp),CUT_ADDRESS);
    cut_op(c,0x0bu);
    if(pop||!memory){cut_get(c,IS_SUPPRESS);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
        if(pop){
        cut_get(c,IS_TAG);cut_const(c,3u);cut_get(c,IS_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,IS_TAG);
        cut_get(c,IS_TOP);cut_const(c,1u);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_const(c,11u);cut_op(c,0x86u);
        cut_get(c,IS_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_op(c,0x84u);cut_set(c,IS_SW);}
        word(c,offsetof(machine_state,x87_tag),IS_TAG,1);cut_op(c,0x0bu);}
    word(c,offsetof(machine_state,x87_status),IS_SW,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
