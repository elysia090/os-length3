#include "cut-internal.h"
enum { FA_CW=26,FA_SW,FA_TOP,FA_TAG,FA_A,FA_SE,FA_INPUT,FA_EMPTY,FA_SIG,FA_OUT_SE,FA_OUTCOME,FA_UNMASKED,
       FA_B_SE,FA_DEST,FA_SOURCE,FA_FIRST };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local,int store)
{
    cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);
    wasm_writer_uleb(c->writer,1u);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);
}
static void payload(cut_lowering *c,pl_u32 index,pl_u32 offset,pl_u32 local,pl_u32 shift,int store)
{
    cut_get(c,0u);cut_get(c,index);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
    if(store)cut_get(c,local);
    cut_op(c,store?(shift==3u?0x37u:0x3du):(shift==3u?0x29u:0x33u));
    wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);
}
static void index(cut_lowering *c,pl_u32 logical,pl_u32 local)
{cut_get(c,FA_TOP);cut_const(c,logical);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,local);}
static void empty(cut_lowering *c,pl_u32 local)
{
    cut_get(c,FA_TAG);cut_get(c,local);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0xadu);
}
void cut_lower_x87_arithmetic(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_register_arithmetic reg={0};int registers=pl_x86_x87_register_arithmetic_lower(i,&reg);
    pl_x86_x87_integer_arithmetic law={0};if(!registers&&!pl_x86_x87_integer_arithmetic_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    int status=registers?pl_x86_x87_register_arithmetic_plan(reg.operation,&arena,&pure)
        :pl_x86_x87_integer_arithmetic_plan(law.bytes*8u,law.operation,&arena,&pure);
    if(status){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,FA_CW,FA_SW);
    if(!registers){const pl_x86_memory *address=&i->operands[0].value.memory;
        cut_effective_address(c,i,address);cut_set(c,CUT_ADDRESS);
        c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(address);cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);
        cut_access_value(c);cut_set(c,FA_INPUT);}
    word(c,offsetof(machine_state,x87_tag),FA_TAG,0);
    cut_get(c,FA_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,FA_TOP);
    index(c,registers?reg.destination:0u,FA_DEST);
    payload(c,FA_DEST,offsetof(machine_state,x87_significand),FA_A,3u,0);
    payload(c,FA_DEST,offsetof(machine_state,x87_sign_exponent),FA_SE,1u,0);
    empty(c,FA_DEST);
    if(registers){index(c,reg.source,FA_SOURCE);empty(c,FA_SOURCE);cut_op(c,0x84u);}
    cut_set(c,FA_EMPTY);
    if(registers){payload(c,FA_SOURCE,offsetof(machine_state,x87_significand),FA_INPUT,3u,0);
        payload(c,FA_SOURCE,offsetof(machine_state,x87_sign_exponent),FA_B_SE,1u,0);}
    pl_u32 input[]={FA_A,FA_SE,FA_INPUT,FA_B_SE,FA_CW,FA_EMPTY};
    if(!registers){input[3]=FA_CW;input[4]=FA_EMPTY;}
    const pl_u32 output[]={FA_SIG,FA_OUT_SE,FA_OUTCOME};
    cut_emit_scalar_plan(c,&pure,input,FA_FIRST,output);
    // IE/DE can suppress the payload. OE/UE/PE publish the common plan's
    // selected rounded/scaled result even while a deferred error is pending.
    cut_get(c,FA_OUTCOME);cut_const(c,1u<<16u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    payload(c,FA_DEST,offsetof(machine_state,x87_significand),FA_SIG,3u,1);
    payload(c,FA_DEST,offsetof(machine_state,x87_sign_exponent),FA_OUT_SE,1u,1);
    cut_get(c,FA_TAG);cut_const(c,3u);cut_get(c,FA_DEST);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);
    cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_get(c,FA_OUTCOME);cut_const(c,18u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_get(c,FA_DEST);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_TAG);
    if(registers&&reg.pop){
        cut_get(c,FA_TAG);cut_const(c,3u);cut_get(c,FA_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_TAG);
        cut_get(c,FA_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_get(c,FA_TOP);cut_const(c,1u);cut_op(c,0x7cu);
        cut_const(c,7u);cut_op(c,0x83u);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_SW);}
    word(c,offsetof(machine_state,x87_tag),FA_TAG,1);cut_op(c,0x0bu);
    cut_get(c,FA_OUTCOME);cut_get(c,FA_CW);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);cut_const(c,63u);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,FA_UNMASKED);
    cut_get(c,FA_SW);cut_const(c,~0x200ull);cut_op(c,0x83u);cut_get(c,FA_OUTCOME);cut_const(c,0x27fu);cut_op(c,0x83u);cut_op(c,0x84u);cut_set(c,FA_SW);
    cut_get(c,FA_UNMASKED);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,FA_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,FA_SW);
    cut_const(c,registers?reg.opcode:law.opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);
    if(!registers)cut_store(c,offsetof(machine_state,x87_dp),CUT_ADDRESS);
    cut_op(c,0x0bu);
    word(c,offsetof(machine_state,x87_status),FA_SW,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
