#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_float_compare_lower(const pl_x86_instruction *i,pl_x86_float_compare *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||i->visible_operand_count!=2u||(i->flags&required)!=required
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 bytes=d->bits/8u,memory=s->kind==PL_X86_OPERAND_MEMORY;
    pl_u32 op=(pl_u32)(i->machine_argument>>32u)&255u;
    if((op!=PL_X86_SCALAR_FLOAT_COMPARE_ORDERED&&op!=PL_X86_SCALAR_FLOAT_COMPARE_UNORDERED)
        ||(bytes!=4u&&bytes!=8u)||d->bits!=bytes*8u||s->bits!=d->bits||d->kind!=PL_X86_OPERAND_REGISTER
        ||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags
        ||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory||i->opcode!=(op==PL_X86_SCALAR_FLOAT_COMPARE_ORDERED?0x2fu:0x2eu)
        ||i->machine_argument!=(PL_X86_VECTOR_SCALAR_FLOAT|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)
            |((pl_u64)memory<<24u)|((pl_u64)op<<32u)|((pl_u64)bytes<<40u)|((pl_u64)bytes<<48u)))return 0;
    *out=(pl_x86_float_compare){(pl_u8)bytes,(pl_u8)(op==PL_X86_SCALAR_FLOAT_COMPARE_ORDERED),(pl_u8)memory,
        (pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index,(pl_u8)(!memory&&s->value.reg.index==d->value.reg.index)};return 1;
}
typedef struct {pl_operand mag,sign,nan,signal,denormal;} operand_view;
static operand_view view(expression *e,pl_u32 bits,pl_operand raw,pl_operand daz)
{
    pl_u64 mag_mask=bits==32u?0x7fffffffu:0x7fffffffffffffffull,exp_mask=bits==32u?0x7f800000u:0x7ff0000000000000ull;
    pl_u64 fraction_mask=mag_mask^exp_mask,quiet=bits==32u?0x00400000u:0x0008000000000000ull;
    pl_operand mag=bit_and(e,raw,constant(mag_mask)),exp=bit_and(e,mag,constant(exp_mask)),fraction=bit_and(e,mag,constant(fraction_mask));
    pl_operand fraction_zero=equal(e,fraction,constant(0u)),nonzero=not(e,fraction_zero),zero_exp=equal(e,exp,constant(0u));
    pl_operand full_exp=equal(e,exp,constant(exp_mask)),nan=bit_and(e,full_exp,nonzero),denormal=bit_and(e,zero_exp,nonzero);
    pl_operand quiet_bit=bit_and(e,fraction,constant(quiet)),signal=equal(e,quiet_bit,constant(0u));signal=bit_and(e,signal,nan);
    pl_operand flush=bit_and(e,daz,denormal);mag=select(e,constant(0u),mag,flush);
    pl_operand sign=shift(e,raw,bits-1u);sign=bit_and(e,sign,constant(1u));return(operand_view){mag,sign,nan,signal,denormal};
}
int pl_x86_float_compare_plan(pl_u32 bits,pl_u32 ordered,pl_u32 alias,pl_arena *arena,pl_plan *out)
{
    if((bits!=32u&&bits!=64u)||ordered>1u||alias>1u||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,128u,512u,0u,5u))return PL_ERROR_ARENA;
    pl_operand av={PL_OPERAND_LOCAL,0u},bv={PL_OPERAND_LOCAL,alias?0u:1u},mxcsr={PL_OPERAND_LOCAL,2u};
    pl_operand daz=bit_and(&e,mxcsr,constant(64u));daz=equal(&e,daz,constant(0u));daz=not(&e,daz);
    operand_view a=view(&e,bits,av,daz),b=alias?a:view(&e,bits,bv,daz);
    pl_operand both_zero=bit_or(&e,a.mag,b.mag);both_zero=equal(&e,both_zero,constant(0u));
    pl_operand sign_equal=equal(&e,a.sign,b.sign),mag_equal=equal(&e,a.mag,b.mag),eq=bit_and(&e,sign_equal,mag_equal);eq=bit_or(&e,eq,both_zero);
    pl_operand up=compare(&e,a.mag,b.mag,2u),down=compare(&e,b.mag,a.mag,2u),less=select(&e,down,up,a.sign);
    less=select(&e,less,a.sign,sign_equal);pl_operand nonzero=not(&e,both_zero);less=bit_and(&e,less,nonzero);
    pl_operand unordered=bit_or(&e,a.nan,b.nan),invalid=ordered?unordered:bit_or(&e,a.signal,b.signal);
    pl_operand cf=bit_or(&e,unordered,less),zf=bit_or(&e,unordered,eq),pf=binary(&e,PL_OPCODE_LANE64_SHL,unordered,constant(2u));
    zf=binary(&e,PL_OPCODE_LANE64_SHL,zf,constant(6u));pl_operand flags=bit_or(&e,cf,pf);flags=bit_or(&e,flags,zf);
    pl_operand denormal=bit_or(&e,a.denormal,b.denormal),daz_off=not(&e,daz);denormal=bit_and(&e,denormal,daz_off);
    // NaN establishes unordered before a denormal from the other operand,
    // including quiet UCOMI NaNs that do not themselves raise invalid.
    pl_operand ordered_operands=not(&e,unordered);denormal=bit_and(&e,denormal,ordered_operands);
    pl_operand de=binary(&e,PL_OPCODE_LANE64_SHL,denormal,constant(1u)),raised=bit_or(&e,invalid,de);
    raw.locals[0]=flags;raw.locals[1]=raised;for(pl_u32 n=2u;n<5u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,0u,0u,0u};int status=pl_compact_projected(&raw,live,arena,out);
    return status?status:out->node_count>PL_X86_FLOAT_COMPARE_MAX_NODES?PL_ERROR_PLAN:0;
}
