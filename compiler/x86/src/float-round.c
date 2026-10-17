#include <x86/semantics.h>
#include "x87-expression.h"

int pl_x86_float_round_lower(const pl_x86_instruction *i,pl_x86_float_round *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->flow!=PL_X86_FLOW_NEXT||i->machine_operation!=PL_X86_MACHINE_VECTOR
        ||(i->machine_argument&255u)!=PL_X86_VECTOR_FLOAT_ROUND||i->visible_operand_count!=3u
        ||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes
        ||i->fallthrough-i->rip!=i->length||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u,*a=d+2u;
    pl_u32 bytes=(pl_u32)(i->machine_argument>>40u)&255u,scalar=(pl_u32)(i->machine_argument>>48u)&255u;
    pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY,width=scalar?bytes*8u:128u;
    if((bytes!=4u&&bytes!=8u)||scalar>1u||d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=width
        ||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags
        ||s->bits!=width||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR
            ||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||a->kind!=PL_X86_OPERAND_IMMEDIATE||a->bits!=8u||a->value.immediate>255u
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory||i->opcode!=(scalar?(bytes==8u?0x0bu:0x0au):(bytes==8u?0x09u:0x08u)))return 0;
    pl_u32 control=(pl_u32)a->value.immediate&15u;
    pl_u64 expected=PL_X86_VECTOR_FLOAT_ROUND|((pl_u64)d->value.reg.index<<8u)
        |((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u)
        |((pl_u64)control<<32u)|((pl_u64)bytes<<40u)|((pl_u64)scalar<<48u);
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_float_round){(pl_u8)bytes,(pl_u8)(scalar?1u:16u/bytes),(pl_u8)control,
        (pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index};return 1;
}

int pl_x86_float_round_plan(pl_u32 bits,pl_u32 control,pl_arena *arena,pl_plan *out)
{
    if((bits!=32u&&bits!=64u)||control>255u||!arena||!out)return PL_ERROR_PLAN;
    control&=15u;pl_u32 f=bits==32u?23u:52u,bias=bits==32u?127u:1023u;
    pl_u64 sign_bit=1ull<<(bits-1u),exp_mask=bits==32u?0x7f800000u:0x7ff0000000000000ull;
    pl_u64 fraction_mask=(1ull<<f)-1u,quiet=1ull<<(f-1u),one=(pl_u64)bias<<f;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,160u,512u,0u,2u))return PL_ERROR_ARENA;
    pl_operand input={PL_OPERAND_LOCAL,0u},csr={PL_OPERAND_LOCAL,1u};
    pl_operand sign=bit_and(&e,input,constant(sign_bit)),negative=not(&e,equal(&e,sign,constant(0u)));
    pl_operand mag=bit_and(&e,input,constant(sign_bit-1u)),exp=bit_and(&e,mag,constant(exp_mask));
    pl_operand fraction=bit_and(&e,mag,constant(fraction_mask)),fraction_nonzero=not(&e,equal(&e,fraction,constant(0u)));
    pl_operand full_exp=equal(&e,exp,constant(exp_mask)),nan=bit_and(&e,full_exp,fraction_nonzero);
    pl_operand signal=equal(&e,bit_and(&e,fraction,constant(quiet)),constant(0u));signal=bit_and(&e,signal,nan);
    pl_operand denormal=equal(&e,exp,constant(0u));denormal=bit_and(&e,denormal,fraction_nonzero);
    pl_operand daz=not(&e,equal(&e,bit_and(&e,csr,constant(64u)),constant(0u))),flush=bit_and(&e,daz,denormal);
    mag=select(&e,constant(0u),mag,flush);
    pl_operand nonzero=not(&e,equal(&e,mag,constant(0u))),exponent=shift(&e,exp,f);
    pl_operand small=compare(&e,exponent,constant(bias),2u),large=not(&e,compare(&e,exponent,constant(bias+f),2u));
    pl_operand rc=control&4u?bit_and(&e,shift(&e,csr,13u),constant(3u)):constant(control&3u);
    pl_operand down=equal(&e,rc,constant(1u)),up=equal(&e,rc,constant(2u)),nearest=equal(&e,rc,constant(0u));
    pl_operand directed=bit_and(&e,down,negative),positive=not(&e,negative),up_positive=bit_and(&e,up,positive);
    directed=bit_or(&e,directed,up_positive);
    pl_operand greater_half=compare(&e,constant((pl_u64)(bias-1u)<<f),mag,2u);
    pl_operand small_up=bit_and(&e,nearest,greater_half),directed_nonzero=bit_and(&e,directed,nonzero);
    small_up=bit_or(&e,small_up,directed_nonzero);pl_operand small_result=select(&e,constant(one),constant(0u),small_up);
    // Clamp the discarded-bit coordinate before shifting: every SSA operand
    // is total even when a later select proves this regular case unreachable.
    pl_operand k=binary(&e,96u,constant(bias+f),exponent);k=select(&e,constant(f),k,small);k=select(&e,constant(0u),k,large);
    pl_operand unit=binary(&e,PL_OPCODE_LANE64_SHL,constant(1u),k),mask=binary(&e,96u,unit,constant(1u));
    pl_operand discarded=bit_and(&e,mag,mask),base=bit_and(&e,mag,binary(&e,86u,mask,constant(~0ull)));
    pl_operand half=shift(&e,unit,1u),over=compare(&e,half,discarded,2u),tie=equal(&e,discarded,half);
    pl_operand odd=binary(&e,PL_OPCODE_LANE64_SHR,base,k);odd=bit_and(&e,odd,constant(1u));
    pl_operand tie_odd=bit_and(&e,tie,odd),round_up=bit_or(&e,over,tie_odd);round_up=bit_and(&e,round_up,nearest);
    pl_operand inexact=not(&e,equal(&e,discarded,constant(0u))),directed_inexact=bit_and(&e,directed,inexact);
    round_up=bit_or(&e,round_up,directed_inexact);pl_operand increment=select(&e,unit,constant(0u),round_up);
    pl_operand regular=binary(&e,89u,base,increment),result=select(&e,small_result,regular,small);
    result=select(&e,mag,result,large);result=bit_or(&e,result,sign);
    pl_operand quiet_nan=bit_or(&e,input,constant(quiet));result=select(&e,quiet_nan,result,nan);
    inexact=select(&e,nonzero,inexact,small);inexact=select(&e,constant(0u),inexact,large);
    pl_operand raised=signal;
    if(!(control&8u)){pl_operand precision=binary(&e,PL_OPCODE_LANE64_SHL,inexact,constant(5u));raised=bit_or(&e,raised,precision);}
    raw.locals[0]=result;raw.locals[1]=raised;if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u};int status=pl_compact_projected(&raw,live,arena,out);
    return status?status:out->node_count>PL_X86_FLOAT_ROUND_MAX_NODES?PL_ERROR_PLAN:0;
}
