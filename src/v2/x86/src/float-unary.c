#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_float_unary_lower(const pl_x86_instruction *i,pl_x86_float_unary *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||i->visible_operand_count!=2u
        ||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes
        ||i->fallthrough-i->rip!=i->length||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,scalar=kind==PL_X86_VECTOR_SCALAR_FLOAT;
    pl_u32 scalar_op=(pl_u32)(i->machine_argument>>32u)&255u;
    pl_u32 operation=kind==37u||(scalar&&scalar_op==PL_X86_SCALAR_FLOAT_RECIPROCAL)?1u:
        kind==38u||(scalar&&scalar_op==PL_X86_SCALAR_FLOAT_RECIPROCAL_ROOT)?2u:0u;
    if(kind!=18u&&kind!=37u&&kind!=38u&&kind!=PL_X86_VECTOR_FLOAT_SQRT64&&!scalar)return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 bytes=scalar?d->bits/8u:kind==18u||kind==37u||kind==38u?4u:8u;
    pl_u32 width=scalar?bytes*8u:128u,memory=s->kind==PL_X86_OPERAND_MEMORY;
    if((bytes!=4u&&bytes!=8u)||(operation&&bytes!=4u)||i->opcode!=(operation==1u?0x53u:operation==2u?0x52u:0x51u)
        ||d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=width||s->bits!=width
        ||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags
        ||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR
            ||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u64 expected=kind|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u);
    if(scalar)expected|=((pl_u64)(operation==1u?PL_X86_SCALAR_FLOAT_RECIPROCAL:operation==2u?PL_X86_SCALAR_FLOAT_RECIPROCAL_ROOT:PL_X86_SCALAR_FLOAT_SQUARE_ROOT)<<32u)|((pl_u64)bytes<<40u)|((pl_u64)bytes<<48u);
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_float_unary){(pl_u8)bytes,(pl_u8)(scalar?1u:16u/bytes),(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index,(pl_u8)operation};return 1;
}
int pl_x86_float_sqrt_plan(pl_u32 bits,pl_arena *arena,pl_plan *out)
{
    if((bits!=32u&&bits!=64u)||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,896u,2560u,0u,2u))return PL_ERROR_ARENA;
    pl_operand input={PL_OPERAND_LOCAL,0u},csr={PL_OPERAND_LOCAL,1u};ieee_expression x=ieee_value(&e,bits,input);
    pl_operand denormal=bit_and(&e,x.classes,constant(1u)),daz=bit_and(&e,csr,constant(64u));daz=not(&e,equal(&e,daz,constant(0u)));
    pl_operand flush=bit_and(&e,denormal,daz),sig=select(&e,constant(0u),x.sig,flush);
    pl_operand zero=equal(&e,sig,constant(0u)),negative=shift(&e,x.se,15u),exponent=bit_and(&e,x.se,constant(32767u));
    pl_operand full=equal(&e,exponent,constant(32767u)),fraction=bit_and(&e,x.sig,constant(0x7fffffffffffffffull));
    pl_operand nan=not(&e,equal(&e,fraction,constant(0u)));nan=bit_and(&e,nan,full);
    pl_operand signal=shift(&e,x.classes,1u);signal=bit_and(&e,signal,constant(1u));
    exponent=binary(&e,96u,exponent,constant(16383u));pl_operand parity=bit_and(&e,exponent,constant(1u));
    radical_expression radical=unsigned_radical_value(&e,sig,parity);pl_operand q=radical.root,exact=radical.exact;
    pl_u32 f=bits==32u?23u:52u,bias=bits==32u?127u:1023u,drop=63u-f;pl_u64 unit=1ull<<drop,mask=unit-1u;
    pl_operand discarded=bit_and(&e,q,constant(mask)),inexact=not(&e,exact),discard_nonzero=not(&e,equal(&e,discarded,constant(0u)));
    inexact=bit_or(&e,inexact,discard_nonzero);pl_operand over_half=compare(&e,constant(unit/2u),discarded,2u),tie=equal(&e,discarded,constant(unit/2u));
    pl_operand odd=shift(&e,q,drop);odd=bit_and(&e,odd,constant(1u));pl_operand tie_up=not(&e,exact);tie_up=bit_or(&e,tie_up,odd);tie_up=bit_and(&e,tie_up,tie);
    pl_operand nearest=bit_or(&e,over_half,tie_up),rc=shift(&e,csr,13u);rc=bit_and(&e,rc,constant(3u));
    pl_operand rn=equal(&e,rc,constant(0u)),rp=equal(&e,rc,constant(2u));rp=bit_and(&e,rp,inexact);
    pl_operand increment=select(&e,nearest,rp,rn),base=bit_and(&e,q,constant(~mask)),delta=binary(&e,PL_OPCODE_LANE64_SHL,increment,constant(drop));
    pl_operand rounded=binary(&e,89u,base,delta),carry=compare(&e,rounded,base,2u);rounded=select(&e,constant(0x8000000000000000ull),rounded,carry);
    exponent=binary(&e,PL_OPCODE_LANE64_SAR,exponent,constant(1u));exponent=binary(&e,89u,exponent,constant(bias));exponent=binary(&e,89u,exponent,carry);
    pl_operand payload=shift(&e,rounded,drop);payload=bit_and(&e,payload,constant((1ull<<f)-1u));
    pl_operand exp_bits=binary(&e,PL_OPCODE_LANE64_SHL,exponent,constant(f));payload=bit_or(&e,payload,exp_bits);
    pl_operand bad=bit_and(&e,negative,not(&e,zero));bad=bit_and(&e,bad,not(&e,nan));pl_operand invalid=bit_or(&e,bad,signal);
    pl_u64 quiet=1ull<<(f-1u),exp_mask=bits==32u?0x7f800000u:0x7ff0000000000000ull;
    pl_operand signed_zero=bit_and(&e,input,constant(1ull<<(bits-1u)));payload=select(&e,signed_zero,payload,zero);
    payload=select(&e,input,payload,full);pl_operand quiet_nan=bit_or(&e,input,constant(quiet));payload=select(&e,quiet_nan,payload,nan);
    payload=select(&e,constant((1ull<<(bits-1u))|exp_mask|quiet),payload,bad);
    pl_operand de=bit_and(&e,denormal,not(&e,daz));de=bit_and(&e,de,not(&e,bad));
    pl_operand pre=bit_or(&e,full,zero);pre=bit_or(&e,pre,bad);pl_operand numeric=not(&e,pre);inexact=bit_and(&e,inexact,numeric);
    pl_operand dm=bit_and(&e,csr,constant(256u));dm=equal(&e,dm,constant(0u));pl_operand blocked=bit_and(&e,de,dm);
    inexact=bit_and(&e,inexact,not(&e,blocked));pl_operand precision=binary(&e,PL_OPCODE_LANE64_SHL,inexact,constant(5u));
    pl_operand de_bit=binary(&e,PL_OPCODE_LANE64_SHL,de,constant(1u)),raised=bit_or(&e,invalid,de_bit);raised=bit_or(&e,raised,precision);
    raw.locals[0]=payload;raw.locals[1]=raised;if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u};int status=pl_compact_projected(&raw,live,arena,out);
    return status?status:out->node_count>PL_X86_SCALAR_PLAN_MAX_NODES?PL_ERROR_PLAN:0;
}
