#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_float_store_lower(const pl_x86_instruction *i,pl_x86_x87_float_store *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=1u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_READS_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED))
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes)return 0;
    const pl_x86_operand *o=i->operands;pl_u32 op=(pl_u32)(i->machine_argument>>16u)&0x7ffu,pop=(pl_u32)(i->machine_argument>>40u)&1u;
    if(o->kind==PL_X86_OPERAND_MEMORY){pl_u32 width=o->bits/8u,group=width==10u?7u:pop?3u:2u,primary=width==4u?1u:width==8u?5u:3u;
        if((o->bits!=32u&&o->bits!=64u&&o->bits!=80u)||(width==10u&&!pop)
            ||!(i->flags&PL_X86_INSTRUCTION_WRITES_MEMORY)||i->opcode!=0xd8u+primary
            ||(op>>8u)!=primary||((op>>3u)&7u)!=group||(op&0xc0u)==0xc0u
            ||i->machine_argument!=(14u|((pl_u64)width<<8u)|((pl_u64)op<<16u)|((pl_u64)pop<<40u)))return 0;
        *out=(pl_x86_x87_float_store){(pl_u8)width,1u,0u,(pl_u8)pop,0u,(pl_u16)op};return 1;
    }
    if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||o->value.reg.class_id!=PL_X86_REGISTER_X87
        ||o->value.reg.bits!=80u||o->value.reg.index>=8u||o->value.reg.flags||(i->flags&PL_X86_INSTRUCTION_WRITES_MEMORY))return 0;
    pl_u32 reg=o->value.reg.index,primary=(op>>8u),second=op&255u;
    pl_u32 pop_group=primary==5u?pop:!!(second&8u);
    if((primary!=5u&&!(primary==7u&&pop)&&!(primary==1u&&pop&&pop_group))||i->opcode!=0xd8u+primary
        ||second!=(0xd0u|(pop_group?8u:0u)|reg)
        ||i->machine_argument!=(14u|((pl_u64)op<<16u)|((pl_u64)reg<<36u)|((pl_u64)pop<<40u)))return 0;
    *out=(pl_x86_x87_float_store){10u,0u,(pl_u8)reg,(pl_u8)pop,(pl_u8)(primary==1u),(pl_u16)op};return 1;
}
static pl_operand add(expression *e,pl_operand a,pl_operand b){return binary(e,89u,a,b);}
static pl_operand sub(expression *e,pl_operand a,pl_operand b){return binary(e,96u,a,b);}
static pl_operand shl(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_LANE64_SHL,a,b);}
static pl_operand shr(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_LANE64_SHR,a,b);}
static pl_operand nz(expression *e,pl_operand a){pl_operand z=equal(e,a,constant(0u));return not(e,z);}
static pl_operand less(expression *e,pl_operand a,pl_operand b){return compare(e,a,b,2u);}
int pl_x86_x87_float_store_plan(pl_u32 bits,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits!=32u&&bits!=64u&&bits!=80u))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,PL_X86_X87_FLOAT_STORE_MAX_NODES,768u,0u,5u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},cw={PL_OPERAND_LOCAL,2u},empty={PL_OPERAND_LOCAL,3u};
    pl_operand value=sig,high=se,invalid=empty,raised=constant(0u),suppress;
    if(bits!=80u){
        pl_u32 f=bits==32u?23u:52u,bias=bits==32u?127u:1023u,min=16384u-bias,drop=63u-f;
        pl_u64 full=bits==32u?255u:2047u,fraction_mask=(1ull<<f)-1u;
        pl_operand exponent=bit_and(&e,se,constant(32767u)),exp_zero=equal(&e,exponent,constant(0u));
        pl_operand effective=select(&e,constant(1u),exponent,exp_zero),sign=shift(&e,se,15u);
        pl_operand exp_full=equal(&e,exponent,constant(32767u)),fraction=bit_and(&e,sig,constant(0x7fffffffffffffffull));
        pl_operand has_fraction=nz(&e,fraction),nan=bit_and(&e,exp_full,has_fraction),quiet=shift(&e,sig,62u);quiet=bit_and(&e,quiet,constant(1u));
        pl_operand signaling=not(&e,quiet);signaling=bit_and(&e,signaling,nan);
        pl_operand j=shift(&e,sig,63u),no_j=not(&e,j),nonzero_exp=not(&e,exp_zero),unsupported=bit_and(&e,no_j,nonzero_exp);
        invalid=bit_or(&e,empty,unsupported);invalid=bit_or(&e,invalid,signaling);
        pl_operand bad=bit_or(&e,empty,unsupported),finite=not(&e,exp_full);finite=bit_and(&e,finite,not(&e,bad));
        pl_operand below=less(&e,effective,constant(min)),extra=sub(&e,constant(min),effective);extra=select(&e,extra,constant(0u),below);
        pl_operand distance=add(&e,extra,constant(drop)),narrow=less(&e,distance,constant(64u)),integral=shr(&e,sig,distance);
        integral=select(&e,integral,constant(0u),narrow);
        pl_operand mask=shl(&e,constant(1u),distance);mask=sub(&e,mask,constant(1u));
        pl_operand residue=bit_and(&e,sig,mask);residue=select(&e,residue,sig,narrow);pl_operand inexact=nz(&e,residue);
        pl_operand half_shift=sub(&e,distance,constant(1u)),half=shl(&e,constant(1u),half_shift);
        pl_operand above=less(&e,half,residue),tie=equal(&e,half,residue),odd=bit_and(&e,integral,constant(1u));tie=bit_and(&e,tie,odd);
        pl_operand nearest=bit_or(&e,above,tie),at_most64=less(&e,distance,constant(65u));nearest=bit_and(&e,nearest,at_most64);
        pl_operand rc=shift(&e,cw,10u);rc=bit_and(&e,rc,constant(3u));pl_operand rn=equal(&e,rc,constant(0u));
        pl_operand down=equal(&e,rc,constant(1u)),up=equal(&e,rc,constant(2u)),positive=not(&e,sign);
        down=bit_and(&e,down,sign);up=bit_and(&e,up,positive);pl_operand directed=bit_or(&e,down,up);
        pl_operand increment=select(&e,nearest,directed,rn);increment=bit_and(&e,increment,inexact);
        pl_operand rounded=add(&e,integral,increment),carry=equal(&e,rounded,constant(1ull<<(f+1u)));
        pl_operand normal_exp=sub(&e,effective,constant(16383u-bias));normal_exp=add(&e,normal_exp,carry);
        pl_operand sub_normal=less(&e,rounded,constant(1ull<<f));sub_normal=not(&e,sub_normal);
        pl_operand stored_exp=select(&e,sub_normal,normal_exp,below),rounded_half=shift(&e,rounded,1u);rounded=select(&e,rounded_half,rounded,carry);
        pl_operand overflow=less(&e,constant(full-1u),stored_exp);overflow=bit_and(&e,overflow,finite);
        pl_operand tiny=equal(&e,stored_exp,constant(0u)),nonzero=nz(&e,sig);tiny=bit_and(&e,tiny,nonzero);tiny=bit_and(&e,tiny,finite);
        pl_operand om=bit_and(&e,cw,constant(8u)),um=bit_and(&e,cw,constant(16u)),unmask_o=not(&e,om),unmask_u=not(&e,um);
        pl_operand u_active=bit_or(&e,inexact,unmask_u),underflow=bit_and(&e,tiny,u_active);
        pl_operand suppress_o=bit_and(&e,overflow,unmask_o),suppress_u=bit_and(&e,underflow,unmask_u),critical=bit_or(&e,suppress_o,suppress_u);
        pl_operand precision=bit_or(&e,inexact,overflow);precision=bit_and(&e,precision,finite);precision=bit_and(&e,precision,not(&e,critical));
        pl_operand to_infinity=bit_or(&e,rn,directed),overflow_bits=select(&e,constant(full<<f),constant(((full-1u)<<f)|fraction_mask),to_infinity);
        pl_operand exponent_bits=shl(&e,stored_exp,constant(f)),fraction_bits=bit_and(&e,rounded,constant(fraction_mask));value=bit_or(&e,exponent_bits,fraction_bits);
        value=select(&e,overflow_bits,value,overflow);pl_operand sign_bits=shl(&e,sign,constant(bits-1u));value=bit_or(&e,value,sign_bits);
        pl_operand special_fraction=shift(&e,sig,drop);special_fraction=bit_and(&e,special_fraction,constant(fraction_mask));
        pl_operand quiet_bit=select(&e,constant(1ull<<(f-1u)),constant(0u),nan);special_fraction=bit_or(&e,special_fraction,quiet_bit);
        pl_operand special=bit_or(&e,special_fraction,constant(full<<f));special=bit_or(&e,special,sign_bits);value=select(&e,special,value,exp_full);
        value=select(&e,constant((1ull<<(bits-1u))|(full<<f)|(1ull<<(f-1u))),value,bad);high=constant(0u);
        pl_operand rounded_up=select(&e,to_infinity,increment,overflow);rounded_up=bit_and(&e,rounded_up,finite);rounded_up=bit_and(&e,rounded_up,not(&e,critical));
        raised=shl(&e,overflow,constant(3u));pl_operand ue=shl(&e,underflow,constant(4u));raised=bit_or(&e,raised,ue);
        pl_operand pe=shl(&e,precision,constant(5u)),c1=shl(&e,rounded_up,constant(9u));raised=bit_or(&e,raised,pe);raised=bit_or(&e,raised,c1);
        raised=select(&e,constant(0u),raised,invalid);
        suppress=critical;
    }else{value=select(&e,constant(0xc000000000000000ull),sig,empty);high=select(&e,constant(0xffffu),se,empty);suppress=constant(0u);}
    raised=bit_or(&e,raised,invalid);pl_operand sf=shl(&e,empty,constant(6u));raised=bit_or(&e,raised,sf);
    pl_operand im=bit_and(&e,cw,constant(1u)),unmask_i=not(&e,im),suppress_i=bit_and(&e,invalid,unmask_i);suppress=bit_or(&e,suppress,suppress_i);
    raw.locals[0]=value;raw.locals[1]=high;raw.locals[2]=raised;raw.locals[3]=suppress;raw.locals[4]=(pl_operand){PL_OPERAND_LOCAL,4u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,1u,0u};return pl_compact_projected(&raw,live,arena,out);
}
