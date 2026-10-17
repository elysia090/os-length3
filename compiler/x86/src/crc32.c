#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_crc32_plan(pl_u32 bits,pl_arena *arena,pl_plan *out)
{
    if((bits!=8u&&bits!=16u&&bits!=32u&&bits!=64u)||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    pl_u32 nodes=bits*5u+4u;
    if(pl_builder_open(&e.builder,&raw,arena,nodes,nodes*2u+4u,0u,2u))return PL_ERROR_ARENA;
    pl_operand residual=bit_and(&e,(pl_operand){PL_OPERAND_LOCAL,0u},constant(0xffffffffu));
    pl_operand data=(pl_operand){PL_OPERAND_LOCAL,1u};
    if(bits<64u)data=bit_and(&e,data,constant((1ull<<bits)-1u));
    pl_operand value=binary(&e,86u,residual,data);
    for(pl_u32 i=0u;i<bits;++i){
        pl_operand bit=bit_and(&e,value,constant(1u));
        pl_operand mask=binary(&e,96u,constant(0u),bit);
        pl_operand feedback=bit_and(&e,mask,constant(0x82f63b78u));
        pl_operand advanced=shift(&e,value,1u);value=binary(&e,86u,advanced,feedback);
    }
    raw.locals[0]=bit_and(&e,value,constant(0xffffffffu));
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,0u};return pl_compact_projected(&raw,live,arena,out);
}
