#include "cut-internal.h"
enum { E_CW=26,E_SW,E_TAG,E_TOP,E_FIRST,E_SECOND,E_LENGTH,E_VALUE,E_HIGH,E_KIND,E_FIRST_NODE };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local,int store)
{cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);wasm_writer_uleb(c->writer,1u);
 wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);}
static void port(cut_lowering *c,pl_u32 offset,pl_u32 local)
{cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offset);cut_set(c,local);}
static void load_at(cut_lowering *c,pl_u32 offset,pl_u32 bytes,int second)
{cut_get(c,second?E_SECOND:E_FIRST);cut_const(c,offset);cut_op(c,0x7cu);if(second){cut_get(c,E_LENGTH);cut_op(c,0x7du);}
 cut_op(c,0xa7u);cut_op(c,bytes==8u?0x29u:bytes==4u?0x35u:bytes==2u?0x33u:0x31u);
 wasm_writer_uleb(c->writer,bytes==8u?3u:bytes==4u?2u:bytes==2u?1u:0u);wasm_writer_uleb(c->writer,0u);}
static void input(cut_lowering *c,pl_u32 offset,pl_u32 bytes)
{
    // A field is loaded directly from its one selected fragment. Only an
    // actually straddling field needs a byte expression; no image is gathered.
    cut_get(c,E_LENGTH);cut_const(c,offset+bytes);cut_op(c,0x5au);cut_op(c,0x04u);cut_op(c,0x7eu);load_at(c,offset,bytes,0);
    cut_op(c,0x05u);cut_get(c,E_LENGTH);cut_const(c,offset);cut_op(c,0x58u);cut_op(c,0x04u);cut_op(c,0x7eu);load_at(c,offset,bytes,1);
    cut_op(c,0x05u);
    for(pl_u32 b=0u;b<bytes;++b){cut_get(c,E_LENGTH);cut_const(c,offset+b);cut_op(c,0x56u);cut_op(c,0x04u);cut_op(c,0x7eu);
        load_at(c,offset+b,1u,0);cut_op(c,0x05u);load_at(c,offset+b,1u,1);cut_op(c,0x0bu);
        if(b){cut_const(c,b*8u);cut_op(c,0x86u);cut_op(c,0x84u);}}
    cut_op(c,0x0bu);cut_op(c,0x0bu);
}
static void output(cut_lowering *c,pl_u32 offset,pl_u32 bytes)
{cut_set(c,E_VALUE);cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,offset);cut_i32_const(c,bytes);
 cut_get(c,E_VALUE);cut_call(c,WASM_IMPORT_WRITE_WORD);cut_access_status(c);}
static void physical(cut_lowering *c,pl_u32 rank)
{cut_get(c,E_TOP);cut_const(c,rank);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);}
static void lane(cut_lowering *c,pl_u32 rank,pl_u32 offset,pl_u32 shift,pl_u32 local,int store)
{cut_get(c,0u);physical(c,rank);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
 if(store)cut_get(c,local);
 cut_op(c,shift==3u?(store?0x37u:0x29u):(store?0x3du:0x33u));
 wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);}
static void restore(cut_lowering *c,const pl_x86_x87_environment *law)
{
    pl_u32 step=law->environment_bytes==14u?2u:4u;
    input(c,0u,2u);cut_set(c,E_CW);input(c,step,2u);cut_set(c,E_SW);input(c,step*2u,2u);cut_set(c,E_TAG);
    _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_control_load_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 inputs[]={E_CW,E_SW},outputs[]={E_CW,E_SW};cut_emit_scalar_projection(c,&pure,inputs,E_FIRST_NODE,outputs,2u);
    word(c,offsetof(machine_state,x87_control),E_CW,1);word(c,offsetof(machine_state,x87_status),E_SW,1);
    input(c,step*3u,step);cut_set(c,E_VALUE);cut_store(c,offsetof(machine_state,x87_ip),E_VALUE);
    input(c,step*5u,step);cut_set(c,E_VALUE);cut_store(c,offsetof(machine_state,x87_dp),E_VALUE);
    if(step==4u){input(c,18u,2u);cut_const(c,0x7ffu);cut_op(c,0x83u);}else cut_const(c,0u);
    cut_set(c,E_VALUE);word(c,offsetof(machine_state,x87_opcode),E_VALUE,1);
    cut_get(c,E_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,E_TOP);
    cut_const(c,0u);cut_set(c,E_CW);
    for(pl_u32 rank=0u;rank<8u;++rank){
        if(law->registers){input(c,law->environment_bytes+rank*10u,8u);cut_set(c,E_VALUE);
            input(c,law->environment_bytes+rank*10u+8u,2u);cut_set(c,E_HIGH);
            lane(c,rank,offsetof(machine_state,x87_significand),3u,E_VALUE,1);lane(c,rank,offsetof(machine_state,x87_sign_exponent),1u,E_HIGH,1);}
        // Only empty is authoritative in the incoming tag. Present fields are
        // classified from their physical raw value, just as full-tag reporting.
        cut_get(c,E_TAG);physical(c,rank);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,E_KIND);
        cut_get(c,E_KIND);cut_const(c,3u);cut_op(c,0x52u);cut_op(c,0x04u);cut_op(c,0x40u);
        if(!law->registers){lane(c,rank,offsetof(machine_state,x87_significand),3u,E_VALUE,0);lane(c,rank,offsetof(machine_state,x87_sign_exponent),1u,E_HIGH,0);}
        cut_get(c,E_HIGH);cut_const(c,0x7fffu);cut_op(c,0x83u);cut_set(c,E_HIGH);
        cut_const(c,1u);cut_const(c,2u);cut_const(c,0u);
        cut_get(c,E_HIGH);cut_op(c,0x50u);cut_get(c,E_HIGH);cut_const(c,0x7fffu);cut_op(c,0x51u);cut_op(c,0x72u);
        cut_get(c,E_VALUE);cut_const(c,63u);cut_op(c,0x88u);cut_op(c,0x50u);cut_op(c,0x72u);cut_op(c,0x1bu);
        cut_get(c,E_HIGH);cut_op(c,0x50u);cut_get(c,E_VALUE);cut_op(c,0x50u);cut_op(c,0x71u);cut_op(c,0x1bu);cut_set(c,E_KIND);cut_op(c,0x0bu);
        cut_get(c,E_CW);cut_get(c,E_KIND);physical(c,rank);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,E_CW);
    }
    word(c,offsetof(machine_state,x87_tag),E_CW,1);
}
static void save(cut_lowering *c,const pl_x86_x87_environment *law)
{
    pl_u32 step=law->environment_bytes==14u?2u:4u;
    for(pl_u32 n=0u;n<3u;++n){word(c,n==0u?offsetof(machine_state,x87_control):n==1u?offsetof(machine_state,x87_status):offsetof(machine_state,x87_tag),E_VALUE,0);
        cut_get(c,E_VALUE);if(step==4u){cut_const(c,0xffff0000u);cut_op(c,0x84u);}output(c,n*step,step);}
    cut_load(c,offsetof(machine_state,x87_ip));output(c,step*3u,step);
    if(step==4u){word(c,offsetof(machine_state,x87_opcode),E_VALUE,0);cut_get(c,E_VALUE);cut_const(c,16u);cut_op(c,0x86u);}
    else cut_const(c,0u);
    output(c,step*4u,step);
    cut_load(c,offsetof(machine_state,x87_dp));output(c,step*5u,step);
    cut_const(c,step==4u?0xffff0000u:0u);output(c,step*6u,step);
    if(law->registers){word(c,offsetof(machine_state,x87_status),E_SW,0);cut_get(c,E_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,E_TOP);
        for(pl_u32 rank=0u;rank<8u;++rank){lane(c,rank,offsetof(machine_state,x87_significand),3u,E_VALUE,0);cut_get(c,E_VALUE);output(c,law->environment_bytes+rank*10u,8u);
            lane(c,rank,offsetof(machine_state,x87_sign_exponent),1u,E_VALUE,0);cut_get(c,E_VALUE);output(c,law->environment_bytes+rank*10u+8u,2u);}}
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_call(c,WASM_IMPORT_WRITE_END);cut_access_status(c);
    if(law->registers){cut_const(c,0x37fu);cut_set(c,E_CW);word(c,offsetof(machine_state,x87_control),E_CW,1);
        cut_const(c,0u);cut_set(c,E_VALUE);word(c,offsetof(machine_state,x87_status),E_VALUE,1);word(c,offsetof(machine_state,x87_opcode),E_VALUE,1);
        cut_store(c,offsetof(machine_state,x87_ip),E_VALUE);cut_store(c,offsetof(machine_state,x87_dp),E_VALUE);
        cut_const(c,65535u);cut_set(c,E_TAG);word(c,offsetof(machine_state,x87_tag),E_TAG,1);
    }else{word(c,offsetof(machine_state,x87_control),E_CW,0);cut_get(c,E_CW);cut_const(c,63u);cut_op(c,0x84u);cut_set(c,E_CW);word(c,offsetof(machine_state,x87_control),E_CW,1);}
}
void cut_lower_x87_environment(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_environment law;if(!pl_x86_x87_environment_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    if(law.restore)cut_x87_wait_guard(c,E_CW,E_SW);else cut_x87_device_guard(c);
    const pl_x86_memory *m=&i->operands[0].value.memory;cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);
    c->report.memory_access=(law.restore?MACHINE_MEMORY_READ:MACHINE_MEMORY_WRITE)|cut_memory_role(m);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,law.bytes);cut_i32_const(c,c->report.memory_access);
    cut_call(c,law.restore?WASM_IMPORT_READ_EXTENT:WASM_IMPORT_WRITE_BEGIN);cut_access_status(c);
    if(law.restore){port(c,offsetof(machine_memory_extent_port,offsets),E_FIRST);port(c,offsetof(machine_memory_extent_port,offsets)+4u,E_SECOND);
        port(c,offsetof(machine_memory_extent_port,lengths),E_LENGTH);restore(c,&law);}else save(c,&law);
}
