#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_extract_supported(const pl_x86_instruction *i)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    return i&&i->status==PL_X86_DECODE_VALID&&i->encoding==PL_X86_ENCODING_LEGACY
        &&i->machine_operation==PL_X86_MACHINE_X87&&i->machine_argument==(57u|(0x1f4ull<<16u))&&i->opcode==0xd9u
        &&!i->visible_operand_count&&(i->flow==PL_X86_FLOW_NEXT||i->flow==PL_X86_FLOW_SYSTEM)
        &&(i->flags&required)==required&&!(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER))
        &&i->source_bytes&&i->source_bytes<=15u&&i->source_bytes==i->length&&i->fallthrough-i->rip==i->length;
}
int pl_x86_x87_extract_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,128u,384u,0u,6u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},cw={PL_OPERAND_LOCAL,2u},empty={PL_OPERAND_LOCAL,3u},full={PL_OPERAND_LOCAL,4u};
    pl_operand exponent=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,exponent,constant(0u)),full_exp=equal(&e,exponent,constant(32767u));
    pl_operand zero_sig=equal(&e,a,constant(0u)),zero=bit_and(&e,zero_exp,zero_sig),j=shift(&e,a,63u);
    pl_operand unsupported=bit_and(&e,not(&e,zero_exp),not(&e,j)),fraction=bit_and(&e,a,constant(0x7fffffffffffffffull));
    pl_operand nan=not(&e,equal(&e,fraction,constant(0u)));nan=bit_and(&e,nan,full_exp);
    pl_operand quiet=shift(&e,a,62u);quiet=bit_and(&e,quiet,constant(1u));pl_operand signal=bit_and(&e,nan,not(&e,quiet));
    pl_operand stack_fault=bit_or(&e,empty,full),indefinite=bit_or(&e,stack_fault,unsupported),invalid=bit_or(&e,indefinite,signal);
    pl_operand priority=bit_or(&e,invalid,nan),denormal=bit_and(&e,zero_exp,not(&e,zero_sig));denormal=bit_and(&e,denormal,not(&e,priority));
    pl_operand ze=bit_and(&e,zero,not(&e,priority));
    pl_operand leading=leading_zeros(&e,a),sign=bit_and(&e,se,constant(32768u)),significand=binary(&e,PL_OPCODE_LANE64_SHL,a,leading);
    pl_operand sig_se=bit_or(&e,sign,constant(16383u)),effective=select(&e,constant(1u),exponent,zero_exp);
    pl_operand power=binary(&e,96u,effective,constant(16383u));power=binary(&e,96u,power,leading);integer_expression integral=integer_value(&e,64u,power);
    pl_operand exp_sig=integral.sig,exp_se=integral.se,nan_sig=bit_or(&e,a,constant(0x4000000000000000ull));
    significand=select(&e,a,significand,full_exp);sig_se=select(&e,se,sig_se,full_exp);
    significand=select(&e,nan_sig,significand,nan);sig_se=select(&e,se,sig_se,nan);
    exp_sig=select(&e,constant(0x8000000000000000ull),exp_sig,full_exp);exp_se=select(&e,constant(32767u),exp_se,full_exp);
    exp_sig=select(&e,nan_sig,exp_sig,nan);exp_se=select(&e,se,exp_se,nan);
    significand=select(&e,constant(0u),significand,zero);sig_se=select(&e,sign,sig_se,zero);
    exp_sig=select(&e,constant(0x8000000000000000ull),exp_sig,zero);exp_se=select(&e,constant(65535u),exp_se,zero);
    significand=select(&e,constant(0xc000000000000000ull),significand,indefinite);sig_se=select(&e,constant(65535u),sig_se,indefinite);
    exp_sig=select(&e,constant(0xc000000000000000ull),exp_sig,indefinite);exp_se=select(&e,constant(65535u),exp_se,indefinite);
    pl_operand unmasked=bit_and(&e,cw,constant(7u));unmasked=binary(&e,86u,unmasked,constant(7u));
    pl_operand de_bit=binary(&e,PL_OPCODE_LANE64_SHL,denormal,constant(1u)),ze_bit=binary(&e,PL_OPCODE_LANE64_SHL,ze,constant(2u));
    pl_operand raised=bit_or(&e,invalid,de_bit);raised=bit_or(&e,raised,ze_bit);pl_operand suppress=bit_and(&e,raised,unmasked);suppress=not(&e,equal(&e,suppress,constant(0u)));
    pl_operand sf=binary(&e,PL_OPCODE_LANE64_SHL,stack_fault,constant(6u)),c1=binary(&e,PL_OPCODE_LANE64_SHL,full,constant(9u));raised=bit_or(&e,raised,sf);raised=bit_or(&e,raised,c1);
    pl_operand special=bit_or(&e,full_exp,indefinite),sig_tag=select(&e,constant(1u),constant(0u),zero);sig_tag=select(&e,constant(2u),sig_tag,special);
    pl_operand exp_tag=select(&e,constant(1u),constant(0u),integral.zero);special=bit_or(&e,special,zero);exp_tag=select(&e,constant(2u),exp_tag,special);
    pl_operand tag_a=binary(&e,PL_OPCODE_LANE64_SHL,sig_tag,constant(18u)),tag_b=binary(&e,PL_OPCODE_LANE64_SHL,exp_tag,constant(20u));
    raised=bit_or(&e,raised,tag_a);raised=bit_or(&e,raised,tag_b);
    raw.locals[0]=significand;raw.locals[1]=sig_se;raw.locals[2]=exp_sig;raw.locals[3]=exp_se;raw.locals[4]=raised;raw.locals[5]=suppress;
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,1u,1u,1u};return pl_compact_projected(&raw,live,arena,out);
}
