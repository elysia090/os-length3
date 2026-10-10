#include "cut-internal.h"
enum { FA_CW=26,FA_SW,FA_TOP,FA_TAG,FA_A,FA_SE,FA_INPUT,FA_EMPTY,FA_SIG,FA_OUT_SE,FA_OUTCOME,FA_UNMASKED,
       FA_B_SE,FA_DEST,FA_SOURCE,FA_FIRST };
enum { FA_OTHER_SIG=42,FA_OTHER_SE,FA_OTHER_OUTCOME,FA_HIGH,FA_LOW,FA_PUSH,FA_FULL,FA_TRIG_FIRST=60 };
enum { FA_U_HIGH=50,FA_U_LOW,FA_BASE_HIGH,FA_BASE_LOW,FA_RATIO_HIGH,FA_RATIO_LOW,FA_DISTANCE,FA_ANGLE_FLAGS,FA_ANGLE_PACK,FA_ANGLE_FIRST=80 };
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
static void publish(cut_lowering *c,pl_u32 destination,pl_u32 sig,pl_u32 se,pl_u32 outcome)
{
    payload(c,destination,offsetof(machine_state,x87_significand),sig,3u,1);
    payload(c,destination,offsetof(machine_state,x87_sign_exponent),se,1u,1);
    cut_get(c,FA_TAG);cut_const(c,3u);cut_get(c,destination);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);
    cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_get(c,outcome);cut_const(c,18u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);
    cut_get(c,destination);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_TAG);
}
void cut_lower_x87_arithmetic(cut_lowering *c,const pl_x86_instruction *i)
{
    int round=pl_x86_x87_round_supported(i);
    int root=pl_x86_x87_root_supported(i),trig=pl_x86_x87_trig_supported(i),exponential=pl_x86_x87_exponential_supported(i),logarithm_one=pl_x86_x87_logarithm_one_supported(i),logarithm=logarithm_one||pl_x86_x87_logarithm_supported(i),arctangent=pl_x86_x87_arctangent_supported(i),unary=round||root||trig||exponential,scale=pl_x86_x87_scale_supported(i),remainder=pl_x86_x87_remainder_supported(i);
    pl_x86_x87_register_arithmetic reg={0};int registers=arctangent||logarithm||unary||scale||remainder||pl_x86_x87_register_arithmetic_lower(i,&reg);
    if(unary)reg.opcode=(pl_u16)(trig||exponential?((i->machine_argument>>16u)&0x7ffu):root?0x1fau:0x1fcu);
    if(scale)reg=(pl_x86_x87_register_arithmetic){1u,0u,6u,0u,0x1fdu};
    if(logarithm)reg=(pl_x86_x87_register_arithmetic){0u,1u,0u,1u,(pl_u16)(logarithm_one?0x1f9u:0x1f1u)};
    if(arctangent)reg=(pl_x86_x87_register_arithmetic){0u,1u,0u,1u,0x1f3u};
    if(remainder){pl_u32 nearest=(pl_u32)(i->machine_argument>>44u)&1u;reg=(pl_x86_x87_register_arithmetic){1u,0u,(pl_u8)(7u+nearest),0u,(pl_u16)(nearest?0x1f5u:0x1f8u)};}
    pl_x86_x87_integer_arithmetic law={0};int integer=pl_x86_x87_integer_arithmetic_lower(i,&law);
    if(!registers&&!integer&&!pl_x86_x87_memory_arithmetic_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[196608];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    int status=trig||exponential||logarithm||arctangent?0:root?pl_x86_x87_root_plan(&arena,&pure):round?pl_x86_x87_round_plan(&arena,&pure):registers?pl_x86_x87_register_arithmetic_plan(reg.operation,&arena,&pure)
        :integer?pl_x86_x87_integer_arithmetic_plan(law.bytes*8u,law.operation,&arena,&pure)
        :pl_x86_x87_memory_arithmetic_plan(law.bytes*8u,law.operation,&arena,&pure);
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
    if(registers&&!unary){index(c,reg.source,FA_SOURCE);empty(c,FA_SOURCE);cut_op(c,0x84u);}
    cut_set(c,FA_EMPTY);
    pl_u32 variant=(pl_u32)(i->machine_argument>>44u),push=trig&&variant>=2u;
    if(exponential)variant=4u;
    if(logarithm)variant=5u;
    if(arctangent)variant=6u;
    if(trig){cut_const(c,0u);cut_set(c,FA_SOURCE);}
    if(push){index(c,7u,FA_PUSH);empty(c,FA_PUSH);cut_op(c,0x50u);cut_op(c,0xadu);cut_set(c,FA_FULL);}
    if(registers&&!unary){payload(c,FA_SOURCE,offsetof(machine_state,x87_significand),FA_INPUT,3u,0);
        payload(c,FA_SOURCE,offsetof(machine_state,x87_sign_exponent),FA_B_SE,1u,0);}
    pl_u32 input[]={FA_A,FA_SE,FA_INPUT,FA_B_SE,FA_CW,FA_EMPTY};
    if(!registers){input[3]=FA_CW;input[4]=FA_EMPTY;}
    const pl_u32 output[]={FA_SIG,FA_OUT_SE,FA_OUTCOME};
    if(trig||exponential||logarithm||arctangent){
        pl_u32 cosine=variant==0u,first=arctangent?FA_ANGLE_FIRST:FA_TRIG_FIRST;
        const pl_u32 numeric_input[]={logarithm?FA_INPUT:FA_A,logarithm?FA_B_SE:FA_SE,FA_A,FA_SE},numeric_output[]={FA_SIG,FA_OUT_SE,FA_OTHER_SE};
        if(arctangent){
            const pl_u32 angle_input[]={FA_INPUT,FA_B_SE,FA_A,FA_SE},prepared[]={FA_U_HIGH,FA_U_LOW,FA_BASE_HIGH,FA_BASE_LOW,FA_RATIO_HIGH,FA_RATIO_LOW,FA_DISTANCE,FA_ANGLE_FLAGS};
            if(pl_x86_x87_arctangent_prepare_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
            cut_emit_scalar_projection(c,&pure,angle_input,first,prepared,8u);arena.used=0u;
            if(pl_x86_x87_arctangent_value_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
            cut_emit_scalar_projection(c,&pure,prepared,first,numeric_output,2u);arena.used=0u;
            cut_const(c,0u);cut_get(c,FA_DISTANCE);cut_op(c,0x7du);cut_get(c,FA_ANGLE_FLAGS);cut_const(c,16u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_ANGLE_PACK);
            if(pl_x86_x87_arctangent_finish_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
            const pl_u32 finished[]={FA_SIG,FA_OUT_SE,FA_INPUT,FA_B_SE,FA_A,FA_SE,FA_RATIO_HIGH,FA_RATIO_LOW,FA_ANGLE_PACK};
            cut_emit_scalar_projection(c,&pure,finished,first,numeric_output,3u);arena.used=0u;
        }else{
            if(logarithm_one?pl_x86_x87_logarithm_one_value_plan(&arena,&pure):logarithm?pl_x86_x87_logarithm_value_plan(&arena,&pure):exponential?pl_x86_x87_exponential_value_plan(&arena,&pure):pl_x86_x87_trig_value_plan(cosine,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
            cut_emit_scalar_projection(c,&pure,numeric_input,first,numeric_output,exponential||logarithm?3u:2u);arena.used=0u;
        }
        if(push){
            cut_get(c,FA_SIG);cut_set(c,FA_HIGH);cut_get(c,FA_OUT_SE);cut_set(c,FA_LOW);
            if(pl_x86_x87_trig_value_plan(1u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
            cut_emit_scalar_projection(c,&pure,numeric_input,first,numeric_output,2u);arena.used=0u;
            if(variant==3u){
                if(pl_x86_compensated_divide_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
                const pl_u32 divided[]={FA_HIGH,FA_LOW,FA_SIG,FA_OUT_SE};cut_emit_scalar_projection(c,&pure,divided,first,numeric_output,2u);arena.used=0u;
            }else{
                if(pl_x86_compensated_round_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
                const pl_u32 rounded[]={FA_HIGH,FA_LOW,FA_SOURCE,FA_CW,0u},other_output[]={FA_OTHER_SIG,FA_OTHER_SE,FA_OTHER_OUTCOME};
                cut_emit_scalar_plan(c,&pure,rounded,first,other_output);arena.used=0u;
                if(pl_x86_x87_trig_result_plan(0u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
                const pl_u32 classified[]={FA_A,FA_SE,FA_CW,FA_EMPTY,FA_FULL,FA_OTHER_SIG,FA_OTHER_SE,FA_OTHER_OUTCOME};
                cut_emit_scalar_plan(c,&pure,classified,first,other_output);arena.used=0u;cosine=1u;
            }
        }
        if(pl_x86_compensated_round_plan(&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        const pl_u32 round_input[]={FA_SIG,FA_OUT_SE,exponential||logarithm||arctangent?FA_OTHER_SE:FA_SOURCE,FA_CW,0u};cut_emit_scalar_plan(c,&pure,round_input,first,output);arena.used=0u;
        if(arctangent?pl_x86_x87_arctangent_result_plan(&arena,&pure):logarithm_one?pl_x86_x87_logarithm_one_result_plan(&arena,&pure):logarithm?pl_x86_x87_logarithm_result_plan(&arena,&pure):exponential?pl_x86_x87_exponential_result_plan(&arena,&pure):pl_x86_x87_trig_result_plan(cosine,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        const pl_u32 classify_input[]={FA_A,FA_SE,FA_CW,FA_EMPTY,push?FA_FULL:0u,FA_SIG,FA_OUT_SE,FA_OUTCOME};
        // Logical local zero is the state pointer, not an integer zero.
        if(!push){cut_const(c,0u);cut_set(c,FA_FULL);}
        pl_u32 classified[8];for(pl_u32 n=0u;n<8u;++n)classified[n]=classify_input[n];classified[4]=FA_FULL;
        const pl_u32 logarithm_input[]={FA_INPUT,FA_B_SE,FA_A,FA_SE,FA_CW,FA_EMPTY,FA_SIG,FA_OUT_SE,FA_OUTCOME};
        cut_emit_scalar_plan(c,&pure,logarithm||arctangent?logarithm_input:classified,first,output);
        if(variant==3u){
            cut_get(c,FA_SIG);cut_set(c,FA_OTHER_SIG);cut_get(c,FA_OUT_SE);cut_set(c,FA_OTHER_SE);cut_get(c,FA_OUTCOME);cut_set(c,FA_OTHER_OUTCOME);
            cut_get(c,FA_OUT_SE);cut_const(c,32767u);cut_op(c,0x83u);cut_const(c,32767u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x40u);
            cut_op(c,0x05u);cut_const(c,0x8000000000000000ull);cut_set(c,FA_SIG);cut_const(c,16383u);cut_set(c,FA_OUT_SE);
            cut_get(c,FA_OUTCOME);cut_const(c,~(3ull<<18u));cut_op(c,0x83u);cut_set(c,FA_OUTCOME);cut_op(c,0x0bu);
        }else if(variant==2u){cut_get(c,FA_OUTCOME);cut_get(c,FA_OTHER_OUTCOME);cut_const(c,63u);cut_op(c,0x83u);cut_op(c,0x84u);cut_set(c,FA_OUTCOME);}
    }else cut_emit_scalar_plan(c,&pure,input,FA_FIRST,output);
    // IE/DE can suppress the payload. OE/UE/PE publish the common plan's
    // selected rounded/scaled result even while a deferred error is pending.
    cut_get(c,FA_OUTCOME);cut_const(c,1u<<16u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    if(push){publish(c,FA_DEST,FA_OTHER_SIG,FA_OTHER_SE,FA_OTHER_OUTCOME);publish(c,FA_PUSH,FA_SIG,FA_OUT_SE,FA_OUTCOME);
        cut_get(c,FA_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_get(c,FA_PUSH);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_SW);
    }else publish(c,FA_DEST,FA_SIG,FA_OUT_SE,FA_OUTCOME);
    if(registers&&reg.pop){
        cut_get(c,FA_TAG);cut_const(c,3u);cut_get(c,FA_TOP);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_TAG);
        cut_get(c,FA_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);cut_get(c,FA_TOP);cut_const(c,1u);cut_op(c,0x7cu);
        cut_const(c,7u);cut_op(c,0x83u);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,FA_SW);}
    word(c,offsetof(machine_state,x87_tag),FA_TAG,1);cut_op(c,0x0bu);
    cut_get(c,FA_OUTCOME);cut_get(c,FA_CW);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);cut_const(c,63u);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,FA_UNMASKED);
    cut_get(c,FA_SW);cut_get(c,FA_OUTCOME);cut_const(c,32u);cut_op(c,0x88u);cut_const(c,0x200u);cut_op(c,0x84u);
    cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);cut_get(c,FA_OUTCOME);cut_const(c,0x477fu);cut_op(c,0x83u);cut_op(c,0x84u);cut_set(c,FA_SW);
    cut_get(c,FA_UNMASKED);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,FA_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,FA_SW);
    cut_const(c,registers?reg.opcode:law.opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);
    if(!registers)cut_store(c,offsetof(machine_state,x87_dp),CUT_ADDRESS);
    cut_op(c,0x0bu);
    word(c,offsetof(machine_state,x87_status),FA_SW,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
