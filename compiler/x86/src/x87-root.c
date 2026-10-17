#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_root_supported(const pl_x86_instruction *i)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    return i&&i->status==PL_X86_DECODE_VALID&&i->encoding==PL_X86_ENCODING_LEGACY
        &&i->machine_operation==PL_X86_MACHINE_X87&&i->machine_argument==(52u|(0x1faull<<16u))&&i->opcode==0xd9u
        &&!i->visible_operand_count&&(i->flow==PL_X86_FLOW_NEXT||i->flow==PL_X86_FLOW_SYSTEM)
        &&(i->flags&required)==required&&!(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER))
        &&i->source_bytes&&i->source_bytes<=15u&&i->source_bytes==i->length&&i->fallthrough-i->rip==i->length;
}
int pl_x86_x87_root_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,896u,2560u,0u,6u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},cw={PL_OPERAND_LOCAL,4u},empty={PL_OPERAND_LOCAL,5u};
    pl_operand exponent=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,exponent,constant(0u)),full_exp=equal(&e,exponent,constant(32767u));
    pl_operand zero_sig=equal(&e,a,constant(0u)),zero=bit_and(&e,zero_exp,zero_sig),j=shift(&e,a,63u);
    pl_operand unsupported=bit_and(&e,not(&e,zero_exp),not(&e,j)),fraction=bit_and(&e,a,constant(0x7fffffffffffffffull));
    pl_operand nan=not(&e,equal(&e,fraction,constant(0u)));nan=bit_and(&e,nan,full_exp);
    pl_operand quiet=shift(&e,a,62u);quiet=bit_and(&e,quiet,constant(1u));pl_operand signal=bit_and(&e,nan,not(&e,quiet));
    pl_operand negative=shift(&e,se,15u),bad=bit_and(&e,negative,not(&e,zero));bad=bit_and(&e,bad,not(&e,nan));
    pl_operand indefinite=bit_or(&e,empty,unsupported);indefinite=bit_or(&e,indefinite,bad);pl_operand invalid=bit_or(&e,indefinite,signal);
    pl_operand de=bit_and(&e,zero_exp,not(&e,zero_sig));de=bit_and(&e,de,not(&e,invalid));de=bit_and(&e,de,not(&e,nan));
    pl_operand leading=leading_zeros(&e,a),normalized=binary(&e,PL_OPCODE_LANE64_SHL,a,leading);
    exponent=select(&e,constant(1u),exponent,zero_exp);exponent=binary(&e,96u,exponent,leading);exponent=binary(&e,96u,exponent,constant(16383u));
    pl_operand parity=bit_and(&e,exponent,constant(1u));radical_expression root=unsigned_radical_value(&e,normalized,parity);
    pl_operand pc=shift(&e,cw,8u);pc=bit_and(&e,pc,constant(3u));pl_operand pc24=equal(&e,pc,constant(0u)),pc53=equal(&e,pc,constant(2u));
    pl_operand drop=select(&e,constant(11u),constant(0u),pc53);drop=select(&e,constant(40u),drop,pc24);
    pl_operand unit=binary(&e,PL_OPCODE_LANE64_SHL,constant(1u),drop),mask=binary(&e,96u,unit,constant(1u));
    pl_operand discarded=bit_and(&e,root.root,mask),not_exact=not(&e,root.exact),inexact=not(&e,equal(&e,discarded,constant(0u)));inexact=bit_or(&e,inexact,not_exact);
    pl_operand half=shift(&e,unit,1u),over_half=compare(&e,half,discarded,2u),tie=equal(&e,half,discarded);
    pl_operand odd=binary(&e,PL_OPCODE_LANE64_SHR,root.root,drop);odd=bit_and(&e,odd,constant(1u));
    pl_operand tie_up=bit_or(&e,odd,not_exact);tie_up=bit_and(&e,tie_up,tie);pl_operand nearest=bit_or(&e,over_half,tie_up);
    pl_operand full_precision=equal(&e,drop,constant(0u));nearest=select(&e,root.above_half,nearest,full_precision);
    pl_operand rc=shift(&e,cw,10u);rc=bit_and(&e,rc,constant(3u));pl_operand rn=equal(&e,rc,constant(0u)),rp=equal(&e,rc,constant(2u));
    rp=bit_and(&e,rp,inexact);pl_operand increment=select(&e,nearest,rp,rn),keep=binary(&e,86u,mask,constant(~0ull));
    pl_operand base=bit_and(&e,root.root,keep),delta=binary(&e,PL_OPCODE_LANE64_SHL,increment,drop),result_sig=binary(&e,89u,base,delta);
    pl_operand carry=compare(&e,result_sig,base,2u);result_sig=select(&e,constant(0x8000000000000000ull),result_sig,carry);
    exponent=binary(&e,PL_OPCODE_LANE64_SAR,exponent,constant(1u));exponent=binary(&e,89u,exponent,constant(16383u));exponent=binary(&e,89u,exponent,carry);
    pl_operand result_se=exponent,special=bit_or(&e,full_exp,zero);special=bit_or(&e,special,indefinite);
    result_sig=select(&e,a,result_sig,full_exp);pl_operand quiet_nan=bit_or(&e,a,constant(0x4000000000000000ull));result_sig=select(&e,quiet_nan,result_sig,nan);
    result_se=select(&e,se,result_se,full_exp);pl_operand sign_zero=bit_and(&e,se,constant(32768u));
    result_sig=select(&e,constant(0u),result_sig,zero);result_se=select(&e,sign_zero,result_se,zero);
    result_sig=select(&e,constant(0xc000000000000000ull),result_sig,indefinite);result_se=select(&e,constant(65535u),result_se,indefinite);
    inexact=select(&e,constant(0u),inexact,special);increment=select(&e,constant(0u),increment,special);
    pl_operand im=bit_and(&e,cw,constant(1u)),dm=bit_and(&e,shift(&e,cw,1u),constant(1u));
    pl_operand suppress_i=bit_and(&e,invalid,not(&e,im)),suppress_d=bit_and(&e,de,not(&e,dm)),suppress=bit_or(&e,suppress_i,suppress_d);
    inexact=select(&e,constant(0u),inexact,suppress);increment=select(&e,constant(0u),increment,suppress);
    pl_operand raised=bit_or(&e,invalid,binary(&e,PL_OPCODE_LANE64_SHL,de,constant(1u)));
    pl_operand precision=binary(&e,PL_OPCODE_LANE64_SHL,inexact,constant(5u));raised=bit_or(&e,raised,precision);
    pl_operand sf=binary(&e,PL_OPCODE_LANE64_SHL,empty,constant(6u));raised=bit_or(&e,raised,sf);
    pl_operand tag=select(&e,constant(2u),constant(0u),special);tag=select(&e,constant(1u),tag,zero);tag=select(&e,constant(2u),tag,indefinite);
    pl_operand c1=binary(&e,PL_OPCODE_LANE64_SHL,increment,constant(9u)),no_write=binary(&e,PL_OPCODE_LANE64_SHL,suppress,constant(16u));
    pl_operand outcome=bit_or(&e,raised,c1);outcome=bit_or(&e,outcome,no_write);pl_operand tag_word=binary(&e,PL_OPCODE_LANE64_SHL,tag,constant(18u));outcome=bit_or(&e,outcome,tag_word);
    raw.locals[0]=result_sig;raw.locals[1]=result_se;raw.locals[2]=outcome;for(pl_u32 n=3u;n<6u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
