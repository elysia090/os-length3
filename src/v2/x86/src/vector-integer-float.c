#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_vector_integer_float_lower(const pl_x86_instruction *i,pl_x86_vector_integer_float *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||i->visible_operand_count!=2u||(i->flags&required)!=required
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes||i->opcode!=0x2au
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER
            |PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY,kind=(pl_u32)i->machine_argument&255u;
    pl_u32 source_class,source_bytes,target_bytes;
    pl_u64 argument=kind|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u);
    if(kind==30u){source_class=PL_X86_REGISTER_MMX;source_bytes=8u;target_bytes=4u;if(d->bits!=64u)return 0;}
    else if(kind==PL_X86_VECTOR_SCALAR_FLOAT){source_class=PL_X86_REGISTER_GPR;source_bytes=s->bits/8u;target_bytes=d->bits/8u;
        if((source_bytes!=4u&&source_bytes!=8u)||(target_bytes!=4u&&target_bytes!=8u))return 0;
        argument|=(memory?0u:PL_X86_SCALAR_FLOAT_SOURCE_GPR)
            |((pl_u64)PL_X86_SCALAR_FLOAT_INTEGER_TO_FLOAT<<PL_X86_SCALAR_FLOAT_OPERATION_SHIFT)
            |((pl_u64)target_bytes<<PL_X86_SCALAR_FLOAT_TARGET_BYTES_SHIFT)|((pl_u64)source_bytes<<PL_X86_SCALAR_FLOAT_SOURCE_BYTES_SHIFT);
    }else return 0;
    if(d->kind!=PL_X86_OPERAND_REGISTER||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR
        ||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags||s->bits!=source_bytes*8u
        ||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=source_class
            ||s->value.reg.bits!=s->bits||s->value.reg.index>=(source_class==PL_X86_REGISTER_MMX?8u:16u)||s->value.reg.flags))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory
        ||i->machine_argument!=argument)return 0;
    *out=(pl_x86_vector_integer_float){(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),(pl_u8)d->value.reg.index,
        (pl_u8)source_class,(pl_u8)source_bytes,(pl_u8)target_bytes};return 1;
}
int pl_x86_signed_float_plan(pl_u32 input_bits,pl_u32 output_bits,pl_arena *arena,pl_plan *out)
{
    if((input_bits!=32u&&input_bits!=64u)||(output_bits!=32u&&output_bits!=64u)||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,96u,384u,0u,5u))return PL_ERROR_ARENA;
    pl_operand input={PL_OPERAND_LOCAL,0u},mode={PL_OPERAND_LOCAL,1u};
    integer_expression x=integer_value(&e,input_bits,input);
    pl_u32 f=output_bits==32u?23u:52u,drop=63u-f,bias=output_bits==32u?127u:1023u;
    pl_u64 mask=(1ull<<drop)-1u;
    // Consume the normalization fields directly. Packing an extended value
    // only to unpack its sign/exponent would create an avoidable live chain.
    pl_operand sig=x.sig,exponent=binary(&e,96u,constant(63u),x.leading),sign=x.sign;
    pl_operand inexact=constant(0u);
    if(!(input_bits==32u&&output_bits==64u)){
        pl_operand remainder=bit_and(&e,sig,constant(mask)),zero=equal(&e,remainder,constant(0u));inexact=not(&e,zero);
        pl_operand above=compare(&e,constant(1ull<<(drop-1u)),remainder,2u),tie=equal(&e,remainder,constant(1ull<<(drop-1u)));
        pl_operand odd=shift(&e,sig,drop);odd=bit_and(&e,odd,constant(1u));tie=bit_and(&e,tie,odd);pl_operand nearest=bit_or(&e,above,tie);
        mode=bit_and(&e,mode,constant(3u));pl_operand rn=equal(&e,mode,constant(0u)),down=equal(&e,mode,constant(1u)),up=equal(&e,mode,constant(2u));
        pl_operand positive=not(&e,sign);down=bit_and(&e,down,sign);up=bit_and(&e,up,positive);
        pl_operand directed=bit_or(&e,down,up),increment=select(&e,nearest,directed,rn);increment=bit_and(&e,increment,inexact);
        pl_operand step=binary(&e,PL_OPCODE_LANE64_SHL,increment,constant(drop)),integral=bit_and(&e,sig,constant(~mask));
        pl_operand rounded=binary(&e,89u,integral,step),carry=compare(&e,rounded,integral,2u);sig=select(&e,constant(0x8000000000000000ull),rounded,carry);
        exponent=binary(&e,89u,exponent,carry);
    }
    exponent=binary(&e,89u,exponent,constant(bias));exponent=binary(&e,PL_OPCODE_LANE64_SHL,exponent,constant(f));
    pl_operand fraction=shift(&e,sig,drop);fraction=bit_and(&e,fraction,constant((1ull<<f)-1u));
    pl_operand bits=bit_or(&e,exponent,fraction),sign_bits=binary(&e,PL_OPCODE_LANE64_SHL,sign,constant(output_bits-1u));bits=bit_or(&e,bits,sign_bits);
    bits=select(&e,constant(0u),bits,x.zero);raw.locals[0]=bits;raw.locals[1]=inexact;
    for(pl_u32 n=2u;n<5u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,0u,0u,0u};int status=pl_compact_projected(&raw,live,arena,out);
    return status?status:out->node_count>PL_X86_SIGNED_FLOAT_MAX_NODES?PL_ERROR_PLAN:0;
}
