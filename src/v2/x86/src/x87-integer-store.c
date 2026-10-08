#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_integer_store_lower(const pl_x86_instruction *i,pl_x86_x87_integer_store *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_WRITES_MEMORY;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=1u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_READS_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *m=i->operands;pl_u32 width=m->bits/8u,kind=(pl_u32)i->machine_argument&255u;
    if(m->kind!=PL_X86_OPERAND_MEMORY||(m->bits!=16u&&m->bits!=32u&&m->bits!=64u)||kind<2u||kind>4u||(width==8u&&kind==4u))return 0;
    pl_u32 fop=(pl_u32)(i->machine_argument>>16u)&0x7ffu,primary=kind==2u?(width==8u?5u:width==4u?3u:7u):width==4u?3u:7u;
    pl_u32 group=kind==2u?1u:width==8u?7u:kind==3u?3u:2u;
    if((fop>>8u)!=primary||((fop>>3u)&7u)!=group||(fop&0xc0u)==0xc0u
        ||i->machine_argument!=(kind|((pl_u64)width<<8u)|((pl_u64)fop<<16u)))return 0;
    *out=(pl_x86_x87_integer_store){(pl_u8)width,(pl_u8)(kind!=4u),(pl_u8)(kind==2u),(pl_u16)fop};return 1;
}
static pl_operand add(expression *e,pl_operand a,pl_operand b){return binary(e,89u,a,b);}
static pl_operand sub(expression *e,pl_operand a,pl_operand b){return binary(e,96u,a,b);}
static pl_operand shl(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_LANE64_SHL,a,b);}
static pl_operand shr(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_LANE64_SHR,a,b);}
static pl_operand nz(expression *e,pl_operand a){pl_operand zero=equal(e,a,constant(0u));return not(e,zero);}
static pl_operand less(expression *e,pl_operand a,pl_operand b){return compare(e,a,b,2u);}
int pl_x86_x87_integer_store_plan(pl_u32 bits,pl_u32 truncate,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits!=16u&&bits!=32u&&bits!=64u)||truncate>1u)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,128u,512u,0u,5u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},cw={PL_OPERAND_LOCAL,2u},empty={PL_OPERAND_LOCAL,3u};
    pl_operand exp=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,exp,constant(0u)),effective=select(&e,constant(1u),exp,zero_exp);
    pl_operand sign=shift(&e,se,15u),small=less(&e,effective,constant(16446u)),distance=sub(&e,constant(16446u),effective);
    pl_operand narrow=less(&e,distance,constant(64u)),right=shr(&e,sig,distance);right=select(&e,right,constant(0u),narrow);
    pl_operand left_shift=sub(&e,effective,constant(16446u)),left=shl(&e,sig,left_shift),integral=select(&e,right,left,small);
    pl_operand mask=shl(&e,constant(1u),distance);mask=sub(&e,mask,constant(1u));pl_operand residue=bit_and(&e,sig,mask);
    residue=select(&e,residue,sig,narrow);pl_operand inexact=nz(&e,residue);inexact=bit_and(&e,inexact,small);
    pl_operand half_shift=sub(&e,distance,constant(1u)),half=shl(&e,constant(1u),half_shift);
    pl_operand above=less(&e,half,residue),tie=equal(&e,half,residue),at_most64=less(&e,distance,constant(65u));
    above=bit_and(&e,above,at_most64);tie=bit_and(&e,tie,at_most64);
    pl_operand odd=bit_and(&e,integral,constant(1u));tie=bit_and(&e,tie,odd);pl_operand nearest=bit_or(&e,above,tie);
    pl_operand rc=truncate?constant(3u):shift(&e,cw,10u);rc=bit_and(&e,rc,constant(3u));
    pl_operand down=equal(&e,rc,constant(1u)),up=equal(&e,rc,constant(2u)),positive=not(&e,sign);
    down=bit_and(&e,down,sign);up=bit_and(&e,up,positive);pl_operand directed=bit_or(&e,down,up);
    pl_operand near=equal(&e,rc,constant(0u)),increment=select(&e,nearest,directed,near);increment=bit_and(&e,increment,inexact);
    pl_operand magnitude=add(&e,integral,increment),carry=less(&e,magnitude,integral);
    pl_operand limit=add(&e,constant((1ull<<(bits-1u))-1u),sign),out_of_range=less(&e,limit,magnitude);
    pl_operand huge=less(&e,constant(16383u+bits-1u),effective);out_of_range=bit_or(&e,out_of_range,huge);out_of_range=bit_or(&e,out_of_range,carry);
    pl_operand j=shift(&e,sig,63u),missing_j=not(&e,j),nonzero_exp=not(&e,zero_exp),unsupported=bit_and(&e,nonzero_exp,missing_j);
    pl_operand full_exp=equal(&e,exp,constant(32767u)),invalid=bit_or(&e,unsupported,full_exp);invalid=bit_or(&e,invalid,empty);invalid=bit_or(&e,invalid,out_of_range);
    pl_operand negative=sub(&e,constant(0u),magnitude),value=select(&e,negative,magnitude,sign);value=select(&e,constant(1ull<<(bits-1u)),value,invalid);
    if(bits<64u)value=bit_and(&e,value,constant((1ull<<bits)-1u));
    pl_operand valid=not(&e,invalid),precision=bit_and(&e,valid,inexact);increment=bit_and(&e,increment,valid);
    pl_operand raised=shl(&e,precision,constant(5u)),ie=invalid,sf=shl(&e,empty,constant(6u)),c1=shl(&e,increment,constant(9u));
    raised=bit_or(&e,raised,ie);raised=bit_or(&e,raised,sf);raised=bit_or(&e,raised,c1);
    // Unmasked invalid suppresses store/pop. Unmasked precision still
    // publishes the rounded integer and pop, while latching deferred #MF.
    pl_operand im=bit_and(&e,cw,constant(1u)),unmask_i=not(&e,im);pl_operand suppress=bit_and(&e,unmask_i,invalid);
    raw.locals[0]=value;raw.locals[1]=raised;raw.locals[2]=suppress;raw.locals[3]=empty;raw.locals[4]=(pl_operand){PL_OPERAND_LOCAL,4u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
