/* Backend spelling of the common lane law. No scalar lane reconstruction. */
#include "cut-internal.h"

static void simd(cut_lowering *cut, pl_u32 opcode)
{ cut_op(cut, 0xfdu); wasm_writer_uleb(cut->writer, opcode); }

static void load_vector(cut_lowering *cut, pl_u32 index,pl_u32 bytes)
{
    if(bytes==8u){cut_load(cut,offsetof(machine_state,x87_significand)+index*8u);simd(cut,0x12u);return;}
    cut_get(cut, 0u); simd(cut, 0x00u);
    wasm_writer_uleb(cut->writer, 4u);
    wasm_writer_uleb(cut->writer, offsetof(machine_state, xmm) + index * 16u);
}

static void source(cut_lowering *cut, const pl_x86_instruction *instruction,
                    const pl_x86_vector_binary *law)
{
    if (!law->source_memory) { load_vector(cut, instruction->operands[1].value.reg.index,law->register_bytes); return; }
    cut_access_value(cut); simd(cut, 0x12u);
    if(law->register_bytes==8u)return;
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_op(cut, 0x29u); wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_pair_port, high));
    simd(cut, 0x1eu); cut_op(cut, 1u);
}
static pl_u32 operation(const pl_x86_vector_binary *law)
{
    const pl_u32 bitwise[]={0x4eu,0x50u,0x51u,0x4fu},add[]={0x6eu,0x8eu,0xaeu,0xceu},eq[]={0x23u,0x2du,0x37u,0xd6u};
    const pl_u32 sub[]={0x71u,0x91u,0xb1u,0xd1u},gt[]={0x27u,0x31u,0x3bu,0xd9u};
    const pl_u32 min[]={0x76u,0x96u,0xb6u},max[]={0x78u,0x98u,0xb8u};
    pl_u32 lane=law->lane_bytes==1u?0u:law->lane_bytes==2u?1u:law->lane_bytes==4u?2u:3u;
    switch(law->operation){
    case PL_X86_VECTOR_BINARY_AND:case PL_X86_VECTOR_BINARY_OR:case PL_X86_VECTOR_BINARY_XOR:case PL_X86_VECTOR_BINARY_AND_NOT:return bitwise[law->operation];
    case PL_X86_VECTOR_BINARY_ADD:return add[lane];case PL_X86_VECTOR_BINARY_EQUAL:return eq[lane];
    case PL_X86_VECTOR_BINARY_SUBTRACT:return sub[lane];case PL_X86_VECTOR_BINARY_GREATER:return gt[lane];
    case PL_X86_VECTOR_BINARY_ADD_SAT:return (lane?0x8fu:0x6fu)+(law->signed_lanes?0u:1u);
    case PL_X86_VECTOR_BINARY_SUBTRACT_SAT:return (lane?0x92u:0x72u)+(law->signed_lanes?0u:1u);
    case PL_X86_VECTOR_BINARY_MINIMUM:return min[lane]+(law->signed_lanes?0u:1u);
    case PL_X86_VECTOR_BINARY_MAXIMUM:return max[lane]+(law->signed_lanes?0u:1u);
    case PL_X86_VECTOR_BINARY_AVERAGE:return lane?0x9bu:0x7bu;
    case PL_X86_VECTOR_BINARY_MULTIPLY:return lane==2u?0xb5u:0x95u;
    case PL_X86_VECTOR_BINARY_MULTIPLY_ADD:return 0xbau;
    case PL_X86_VECTOR_BINARY_NARROW:return law->lane_bytes==4u?(law->signed_lanes?0x85u:0x86u):law->signed_lanes?0x65u:0x66u;
    case PL_X86_VECTOR_BINARY_ABSOLUTE:return lane==0u?0x60u:lane==1u?0x80u:0xa0u;
    default:return ~0u;
    }
}
static void get_vector(cut_lowering *c,pl_u32 local)
{cut_op(c,0x20u);wasm_writer_uleb(c->writer,local);}
static void set_vector(cut_lowering *c,pl_u32 local)
{cut_op(c,0x21u);wasm_writer_uleb(c->writer,local);}
static void shuffle(cut_lowering *c,const pl_u8 bytes[16])
{simd(c,0x0du);for(pl_u32 i=0u;i<16u;++i)cut_op(c,bytes[i]);}
static void compact_narrow_mmx(cut_lowering *c)
{
    const pl_u8 select[]={0,1,2,3,8,9,10,11,0,1,2,3,8,9,10,11};
    set_vector(c,c->vector_result);get_vector(c,c->vector_result);get_vector(c,c->vector_result);shuffle(c,select);
}
static void even_dwords(cut_lowering *c,pl_u32 local)
{
    const pl_u8 select[]={0,1,2,3,8,9,10,11,0,1,2,3,8,9,10,11};
    get_vector(c,local);get_vector(c,local);shuffle(c,select);
}
static void product_half(cut_lowering *c,const pl_x86_vector_binary *law,pl_u32 high)
{
    get_vector(c,c->vector_local);get_vector(c,c->vector_aux);
    simd(c,(law->signed_lanes?0xbcu:0xbeu)+high);
    if(law->operation==PL_X86_VECTOR_BINARY_MULTIPLY_ROUND){cut_i32_const(c,0x4000u);simd(c,0x11u);simd(c,0xaeu);}
    cut_i32_const(c,law->operation==PL_X86_VECTOR_BINARY_MULTIPLY_ROUND?15u:16u);simd(c,law->signed_lanes?0xacu:0xadu);
}
static void composite(cut_lowering *c,const pl_x86_vector_binary *law)
{
    switch(law->operation){
    case PL_X86_VECTOR_BINARY_MULTIPLY_HIGH:case PL_X86_VECTOR_BINARY_MULTIPLY_ROUND:{
        const pl_u8 select[]={0,1,4,5,8,9,12,13,16,17,20,21,24,25,28,29};
        product_half(c,law,0u);set_vector(c,c->vector_result);get_vector(c,c->vector_result);
        if(law->register_bytes==16u)product_half(c,law,1u);else get_vector(c,c->vector_result);
        // Truncate, do not saturate: -32768 * -32768 rounds to 0x8000
        // for PMULHRSW, unlike Wasm's saturating q15 multiplication.
        shuffle(c,select);return;
    }
    case PL_X86_VECTOR_BINARY_MULTIPLY_EVEN:
        even_dwords(c,c->vector_local);even_dwords(c,c->vector_aux);simd(c,law->signed_lanes?0xdcu:0xdeu);return;
    case PL_X86_VECTOR_BINARY_SUM_ABSOLUTE:{
        const pl_u8 neighbor[]={4,5,6,7,0,1,2,3,12,13,14,15,8,9,10,11};
        get_vector(c,c->vector_local);get_vector(c,c->vector_aux);simd(c,0x79u);
        get_vector(c,c->vector_local);get_vector(c,c->vector_aux);simd(c,0x77u);simd(c,0x71u);
        simd(c,0x7du);simd(c,0x7fu);set_vector(c,c->vector_result);
        get_vector(c,c->vector_result);get_vector(c,c->vector_result);get_vector(c,c->vector_result);shuffle(c,neighbor);simd(c,0xaeu);
        set_vector(c,c->vector_result);even_dwords(c,c->vector_result);simd(c,0xc9u);return;
    }
    default:c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;
    }
}
void cut_mmx_publish(cut_lowering *cut,pl_u32 index)
{
    if(index<8u){
    cut_get(cut,0u);cut_const(cut,0xffffu);cut_op(cut,0x3du);wasm_writer_uleb(cut->writer,1u);
    wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_sign_exponent)+index*2u);
    }
    // The saved full tag is an observation of payload classes, not FXSAVE's
    // occupancy bitmap. All eight slots are now occupied; form the two class
    // bitmaps directly from physical columns, without a lane/state array.
    cut_const(cut,0u);cut_set(cut,CUT_NEXT);cut_const(cut,0u);cut_set(cut,CUT_ADDRESS);
    for(pl_u32 pair=0u;pair<4u;++pair){
        cut_get(cut,CUT_NEXT);cut_get(cut,0u);simd(cut,0x00u);wasm_writer_uleb(cut->writer,3u);
        wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_significand)+pair*16u);
        cut_op(cut,0x22u);wasm_writer_uleb(cut->writer,cut->vector_local);simd(cut,0xc4u);cut_op(cut,0xadu);
        if(pair){cut_const(cut,pair*2u);cut_op(cut,0x86u);}cut_op(cut,0x84u);cut_set(cut,CUT_NEXT);
        cut_get(cut,CUT_ADDRESS);cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,cut->vector_local);
        cut_const(cut,0u);simd(cut,0x12u);simd(cut,0xd6u);simd(cut,0xc4u);cut_op(cut,0xadu);
        if(pair){cut_const(cut,pair*2u);cut_op(cut,0x86u);}cut_op(cut,0x84u);cut_set(cut,CUT_ADDRESS);
    }
    cut_get(cut,0u);simd(cut,0x00u);wasm_writer_uleb(cut->writer,1u);wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_sign_exponent));
    cut_i32_const(cut,32767u);simd(cut,0x10u);simd(cut,0x4eu);cut_op(cut,0x22u);wasm_writer_uleb(cut->writer,cut->vector_local);
    cut_const(cut,0u);simd(cut,0x12u);simd(cut,0x2du);simd(cut,0x84u);cut_op(cut,0xadu);cut_set(cut,CUT_STATUS);
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,cut->vector_local);cut_i32_const(cut,32767u);simd(cut,0x10u);simd(cut,0x2du);simd(cut,0x84u);cut_op(cut,0xadu);
    cut_get(cut,CUT_STATUS);cut_op(cut,0x84u);cut_get(cut,CUT_NEXT);cut_const(cut,~0ull);cut_op(cut,0x85u);cut_const(cut,255u);cut_op(cut,0x83u);cut_op(cut,0x84u);
    cut_get(cut,CUT_STATUS);cut_get(cut,CUT_ADDRESS);cut_op(cut,0x83u);cut_set(cut,CUT_STATUS);
    cut_get(cut,CUT_STATUS);cut_const(cut,~0ull);cut_op(cut,0x85u);cut_op(cut,0x83u);cut_set(cut,CUT_REPEAT_BUDGET);
    for(pl_u32 field=CUT_STATUS;field<=CUT_REPEAT_BUDGET;++field){
        const pl_u32 shifts[]={4u,2u,1u};const pl_u64 masks[]={0x0f0fu,0x3333u,0x5555u};
        for(pl_u32 stage=0u;stage<3u;++stage){cut_get(cut,field);cut_get(cut,field);cut_const(cut,shifts[stage]);cut_op(cut,0x86u);cut_op(cut,0x84u);
            cut_const(cut,masks[stage]);cut_op(cut,0x83u);cut_set(cut,field);}
    }
    cut_get(cut,0u);cut_get(cut,CUT_STATUS);cut_get(cut,CUT_REPEAT_BUDGET);cut_const(cut,1u);cut_op(cut,0x86u);cut_op(cut,0x84u);
    cut_op(cut,0x3du);wasm_writer_uleb(cut->writer,1u);wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_tag));
    cut_get(cut,0u);cut_get(cut,CUT_RIGHT);cut_const(cut,~0x3800ull);cut_op(cut,0x83u);cut_op(cut,0x3du);
    wasm_writer_uleb(cut->writer,1u);wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_status));
}

int cut_vector_binary_local(const pl_x86_instruction *instruction)
{
    pl_x86_vector_binary law;
    if(!pl_x86_vector_binary_lower(instruction,&law))return 0;
    if(law.result==PL_X86_VECTOR_BINARY_VALUE&&(law.operation==PL_X86_VECTOR_BINARY_MULTIPLY_HIGH
        ||law.operation==PL_X86_VECTOR_BINARY_MULTIPLY_EVEN||law.operation==PL_X86_VECTOR_BINARY_MULTIPLY_ROUND
        ||law.operation==PL_X86_VECTOR_BINARY_SUM_ABSOLUTE||law.operation==PL_X86_VECTOR_BINARY_NARROW))return 3;
    return law.register_bytes==8u||(law.alias&&law.result==PL_X86_VECTOR_BINARY_VALUE);
}

void cut_emit_vector_binary(cut_lowering *cut, const pl_x86_instruction *instruction,
                             const pl_x86_vector_binary *law)
{
    pl_u32 index=instruction->operands[0].value.reg.index,mmx=law->register_bytes==8u;
    if(law->result==PL_X86_VECTOR_BINARY_IDENTITY){if(mmx)cut_mmx_publish(cut,index);return;}
    cut_get(cut, 0u);
    if (law->result != PL_X86_VECTOR_BINARY_VALUE) {
        cut_const(cut, law->result == PL_X86_VECTOR_BINARY_ONES ? ~0ull : 0u);
        simd(cut, 0x12u);
    } else if(law->operation==PL_X86_VECTOR_BINARY_ABSOLUTE){
        source(cut,instruction,law);simd(cut,operation(law));
    } else {
        int expanded=law->operation==PL_X86_VECTOR_BINARY_MULTIPLY_HIGH||law->operation==PL_X86_VECTOR_BINARY_MULTIPLY_EVEN
            ||law->operation==PL_X86_VECTOR_BINARY_MULTIPLY_ROUND||law->operation==PL_X86_VECTOR_BINARY_SUM_ABSOLUTE;
        if(expanded){
            load_vector(cut,index,law->register_bytes);set_vector(cut,cut->vector_local);
            if(law->alias)get_vector(cut,cut->vector_local);else source(cut,instruction,law);set_vector(cut,cut->vector_aux);
            composite(cut,law);
        }else{
        if (law->reverse) source(cut, instruction, law);
        load_vector(cut, instruction->operands[0].value.reg.index,law->register_bytes);
        if (law->alias) {
            cut_op(cut, 0x22u); wasm_writer_uleb(cut->writer, cut->vector_local);
            cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, cut->vector_local);
        } else if (!law->reverse) source(cut, instruction, law);
        pl_u32 op=operation(law);if(op==~0u){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}simd(cut,op);
        if(mmx&&law->operation==PL_X86_VECTOR_BINARY_NARROW)compact_narrow_mmx(cut);
        }
    }
    if(mmx){simd(cut,0x1du);cut_op(cut,0u);cut_op(cut,0x37u);wasm_writer_uleb(cut->writer,3u);
        wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_significand)+index*8u);cut_mmx_publish(cut,index);}
    else{simd(cut,0x0bu);wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+index*16u);}
}
