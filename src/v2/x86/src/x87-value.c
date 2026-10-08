#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_compare_lower(const pl_x86_instruction *i,pl_x86_x87_compare *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=2u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_READS_MEMORY
            |PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u;
    if(kind!=5u&&kind!=6u&&kind!=19u&&kind!=20u)return 0;
    const pl_x86_operand *a=i->operands,*b=a+1u;
    if(a->kind!=PL_X86_OPERAND_REGISTER||b->kind!=PL_X86_OPERAND_REGISTER
        ||a->value.reg.class_id!=PL_X86_REGISTER_X87||b->value.reg.class_id!=PL_X86_REGISTER_X87
        ||a->value.reg.index||b->value.reg.index>=8u||a->bits!=80u||b->bits!=80u
        ||a->value.reg.flags||b->value.reg.flags)return 0;
    pl_u32 opcode=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    pl_u32 pop=kind==5u||kind==19u,ordered=kind>=19u;
    pl_u32 expected=((pop?7u:3u)<<8u)|(ordered?0xf0u:0xe8u)|b->value.reg.index;
    if(opcode!=expected||i->machine_argument!=(kind|((pl_u64)expected<<16u)|((pl_u64)b->value.reg.index<<32u)))return 0;
    *out=(pl_x86_x87_compare){b->value.reg.index,(pl_u8)ordered,(pl_u8)pop,(pl_u16)opcode};return 1;
}
int pl_x86_x87_integer_load_lower(const pl_x86_instruction *i,pl_x86_x87_integer_load *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_READS_MEMORY;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=1u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_WRITES_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *m=i->operands;pl_u32 width=m->bits/8u;
    if(m->kind!=PL_X86_OPERAND_MEMORY||(m->bits!=16u&&m->bits!=32u&&m->bits!=64u))return 0;
    pl_u32 fop=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    if((fop>>8u)!=(width==4u?3u:7u)||((fop>>3u)&7u)!=(width==8u?5u:0u)||(fop&0xc0u)==0xc0u
        ||i->machine_argument!=(1u|((pl_u64)width<<8u)|((pl_u64)fop<<16u)))return 0;
    *out=(pl_x86_x87_integer_load){(pl_u8)width,(pl_u16)fop};return 1;
}
int pl_x86_x87_relation_plan(pl_u32 ordered,pl_u32 alias,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||ordered>1u||alias>1u)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,PL_X86_X87_RELATION_MAX_NODES,320u,0u,5u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},sa={PL_OPERAND_LOCAL,1u},b={PL_OPERAND_LOCAL,alias?0u:2u},sb={PL_OPERAND_LOCAL,alias?1u:3u},empty={PL_OPERAND_LOCAL,4u};
    pl_operand ea=bit_and(&e,sa,constant(0x7fffu)),eb=bit_and(&e,sb,constant(0x7fffu));
    pl_operand za=equal(&e,ea,constant(0u)),zb=equal(&e,eb,constant(0u));
    pl_operand aq=equal(&e,a,constant(0u)),bq=equal(&e,b,constant(0u));
    // Each builder call is a sequenced construction event. Nested calls as
    // C function arguments made native/cold node order compiler-dependent.
    pl_operand nonzero_ea=not(&e,za),nonzero_eb=not(&e,zb);
    pl_operand int_a=shift(&e,a,63u),int_b=shift(&e,b,63u);
    pl_operand no_int_a=not(&e,int_a),no_int_b=not(&e,int_b);
    pl_operand bad_a=bit_and(&e,nonzero_ea,no_int_a),bad_b=bit_and(&e,nonzero_eb,no_int_b);
    pl_operand all_ea=equal(&e,ea,constant(0x7fffu)),all_eb=equal(&e,eb,constant(0x7fffu));
    pl_operand fraction_a=bit_and(&e,a,constant(0x7fffffffffffffffull)),fraction_b=bit_and(&e,b,constant(0x7fffffffffffffffull));
    pl_operand no_fraction_a=equal(&e,fraction_a,constant(0u)),no_fraction_b=equal(&e,fraction_b,constant(0u));
    pl_operand has_fraction_a=not(&e,no_fraction_a),has_fraction_b=not(&e,no_fraction_b);
    pl_operand nan_a=bit_and(&e,all_ea,has_fraction_a),nan_b=bit_and(&e,all_eb,has_fraction_b);
    pl_operand bad=bit_or(&e,bad_a,bad_b),invalid=bit_or(&e,empty,bad);
    pl_operand quiet_a=shift(&e,a,62u),quiet_b=shift(&e,b,62u);
    quiet_a=bit_and(&e,quiet_a,constant(1u));quiet_b=bit_and(&e,quiet_b,constant(1u));
    pl_operand signal_a=not(&e,quiet_a),signal_b=not(&e,quiet_b);
    pl_operand invalid_nan_a=ordered?nan_a:bit_and(&e,nan_a,signal_a);
    pl_operand invalid_nan_b=ordered?nan_b:bit_and(&e,nan_b,signal_b);
    pl_operand invalid_nans=bit_or(&e,invalid_nan_a,invalid_nan_b);invalid=bit_or(&e,invalid,invalid_nans);
    pl_operand nans=bit_or(&e,nan_a,nan_b),unordered=bit_or(&e,invalid,nans);
    // A pseudo-denormal compares at exponent one, but still raises DE.
    pl_operand nonzero_a=not(&e,aq),nonzero_b=not(&e,bq);
    pl_operand denormal_a=bit_and(&e,za,nonzero_a),denormal_b=bit_and(&e,zb,nonzero_b);
    pl_operand denormal=bit_or(&e,denormal_a,denormal_b);
    pl_operand raised_de=select(&e,constant(2u),constant(0u),denormal);
    pl_operand no_unordered_de=select(&e,constant(0u),raised_de,unordered);
    pl_operand raised=select(&e,constant(1u),no_unordered_de,invalid);
    pl_operand stack_fault=binary(&e,PL_OPCODE_LANE64_SHL,empty,constant(6u));raised=bit_or(&e,raised,stack_fault);
    pl_operand ma=select(&e,constant(1u),ea,za),mb=select(&e,constant(1u),eb,zb);
    pl_operand sign_a=shift(&e,sa,15u),sign_b=shift(&e,sb,15u);
    pl_operand zero_a=bit_and(&e,za,aq),zero_b=bit_and(&e,zb,bq),both_zero=bit_and(&e,zero_a,zero_b);
    pl_operand exponents_equal=equal(&e,ma,mb);
    pl_operand exponent_less=compare(&e,ma,mb,2u),significand_less=compare(&e,a,b,2u);
    pl_operand same_exp_less=bit_and(&e,exponents_equal,significand_less),magnitude_less=bit_or(&e,exponent_less,same_exp_less);
    pl_operand exponent_more=compare(&e,mb,ma,2u),significand_more=compare(&e,b,a,2u);
    pl_operand same_exp_more=bit_and(&e,exponents_equal,significand_more),magnitude_more=bit_or(&e,exponent_more,same_exp_more);
    pl_operand signs_equal=equal(&e,sign_a,sign_b);
    pl_operand same_sign_less=select(&e,magnitude_more,magnitude_less,sign_a),less=select(&e,same_sign_less,sign_a,signs_equal);
    pl_operand significands_equal=equal(&e,a,b),magnitudes_equal=bit_and(&e,exponents_equal,significands_equal);
    pl_operand signed_equal=bit_and(&e,signs_equal,magnitudes_equal),eq=bit_or(&e,both_zero,signed_equal);
    pl_operand equal_flags=select(&e,constant(64u),constant(0u),eq);
    pl_operand nonzero_flags=select(&e,constant(1u),equal_flags,less);
    pl_operand zero_flags=select(&e,constant(64u),nonzero_flags,both_zero);
    pl_operand relation=select(&e,constant(69u),zero_flags,unordered);
    raw.locals[0]=relation;raw.locals[1]=raised;raw.locals[2]=empty;
    raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};raw.locals[4]=empty;
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_integer_plan(pl_u32 bits,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits!=16u&&bits!=32u&&bits!=64u))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,32u,96u,0u,5u))return PL_ERROR_ARENA;
    integer_expression integer=integer_value(&e,bits,(pl_operand){PL_OPERAND_LOCAL,0u});
    raw.locals[0]=integer.sig;raw.locals[1]=integer.se;raw.locals[2]=integer.zero;
    raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};raw.locals[4]=(pl_operand){PL_OPERAND_LOCAL,4u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
