#include "cut-internal.h"
enum { FI_CW=26,FI_SW,FI_TOP,FI_NEXT,FI_TAG,FI_FULL,FI_SUPPRESS,FI_INPUT,FI_SIG,FI_SE,FI_KIND,FI_PENDING,FI_SOURCE,FI_EMPTY,FI_HIGH,FI_FIRST };
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
static void read_register(cut_lowering *c,pl_u32 offset,pl_u32 local,pl_u32 shift)
{
    cut_get(c,0u);cut_get(c,FI_SOURCE);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    cut_op(c,shift==3u?0x29u:0x33u);wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);cut_set(c,local);
}
void cut_lower_x87_load(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_integer_load law;pl_x86_x87_raw_load raw;pl_x86_x87_bcd decimal;
    int bcd=pl_x86_x87_bcd_lower(i,&decimal)&&!decimal.store;
    int integer=pl_x86_x87_integer_load_lower(i,&law),extended=0;
    if(!bcd&&!integer&&!pl_x86_x87_memory_load_lower(i,&law)){
        if(!pl_x86_x87_raw_load_lower(i,&raw)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}extended=1;}
    pl_u32 bytes=bcd?10u:extended?raw.bytes:law.bytes,memory=!extended||raw.memory,opcode=bcd?decimal.opcode:extended?raw.opcode:law.opcode;
    _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_load_plan(bytes*8u,bcd?3u:extended?2u:(pl_u32)integer,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,FI_CW,FI_SW);
    word(c,offsetof(machine_state,x87_tag),FI_TAG,0);
    cut_get(c,FI_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FI_TOP);
    cut_get(c,FI_TOP);cut_const(c,7u);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FI_NEXT);
    cut_get(c,FI_TAG);cut_get(c,FI_NEXT);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_const(c,3u);cut_op(c,0x52u);cut_op(c,0xadu);cut_set(c,FI_FULL);
    cut_const(c,0u);cut_set(c,FI_EMPTY);
    if(memory){const pl_x86_memory *address=&i->operands[0].value.memory;
        cut_effective_address(c,i,address);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(address);
        if(extended||bcd){cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,bytes);cut_i32_const(c,c->report.memory_access);
            cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);
            cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));cut_set(c,FI_HIGH);
        }else{cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);}
        cut_access_value(c);cut_set(c,FI_INPUT);
    }else{
        cut_get(c,FI_TOP);cut_const(c,raw.source);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FI_SOURCE);
        cut_get(c,FI_TAG);cut_get(c,FI_SOURCE);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);cut_set(c,FI_EMPTY);
        cut_const(c,0u);cut_set(c,FI_INPUT);cut_const(c,0u);cut_set(c,FI_HIGH);
        cut_get(c,FI_EMPTY);cut_get(c,FI_FULL);cut_op(c,0x84u);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
        read_register(c,offsetof(machine_state,x87_significand),FI_INPUT,3u);read_register(c,offsetof(machine_state,x87_sign_exponent),FI_HIGH,1u);cut_op(c,0x0bu);
    }
    const pl_u32 input[]={FI_INPUT,FI_CW,FI_FULL,extended||bcd?FI_HIGH:FI_INPUT,FI_EMPTY},output[]={FI_SIG,FI_SE,FI_KIND};
    cut_emit_scalar_plan(c,&pure,input,FI_FIRST,output);
    cut_get(c,FI_KIND);cut_const(c,16u);cut_op(c,0x88u);cut_const(c,1u);cut_op(c,0x83u);cut_set(c,FI_SUPPRESS);
    cut_get(c,FI_SW);cut_const(c,~0x200ull);cut_op(c,0x83u);cut_get(c,FI_KIND);cut_const(c,0x27fu);cut_op(c,0x83u);cut_op(c,0x84u);cut_set(c,FI_SW);
    cut_get(c,FI_KIND);cut_get(c,FI_CW);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);cut_const(c,63u);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,FI_PENDING);
    cut_get(c,FI_PENDING);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,FI_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,FI_SW);
    cut_const(c,opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);
    if(memory)cut_store(c,offsetof(machine_state,x87_dp),CUT_ADDRESS);
    cut_op(c,0x0bu);cut_get(c,FI_SUPPRESS);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    payload(c,offsetof(machine_state,x87_significand),FI_SIG,3u,0x37u);
    payload(c,offsetof(machine_state,x87_sign_exponent),FI_SE,1u,0x3du);
    cut_get(c,FI_TAG);cut_const(c,3u);cut_get(c,FI_NEXT);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_get(c,FI_KIND);cut_const(c,18u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_get(c,FI_NEXT);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FI_TAG);
    word(c,offsetof(machine_state,x87_tag),FI_TAG,1);
    cut_get(c,FI_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_get(c,FI_NEXT);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FI_SW);
    cut_op(c,0x0bu);word(c,offsetof(machine_state,x87_status),FI_SW,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
