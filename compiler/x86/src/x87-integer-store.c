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
static pl_operand divide_constant(expression *e,pl_operand value,pl_u64 divisor)
{
    pl_operand args[]={constant(0u),value,constant(divisor),constant(64u)},q=node(e,PL_OPCODE_X86_DIVIDE,args,4u);
    return(pl_operand){PL_OPERAND_PROJECTION,q.value<<8u};
}
static void bcd_payload(expression *e,pl_operand magnitude,pl_operand sign,pl_operand *low,pl_operand *high)
{
    pl_operand q[10];q[0]=magnitude;pl_u64 divisor=100u;
    for(pl_u32 n=1u;n<9u;++n){q[n]=divide_constant(e,magnitude,divisor);divisor*=100u;}q[9]=constant(0u);
    *low=constant(0u);*high=shl(e,sign,constant(15u));
    for(pl_u32 n=0u;n<9u;++n){pl_operand rest=binary(e,PL_OPCODE_MULR,q[n+1u],constant(100u));rest=sub(e,q[n],rest);
        pl_operand tens=divide_constant(e,rest,10u),ten=binary(e,PL_OPCODE_MULR,tens,constant(10u)),ones=sub(e,rest,ten);
        tens=shl(e,tens,constant(4u));pl_operand packed=bit_or(e,ones,tens);
        if(n<8u){packed=shl(e,packed,constant(n*8u));*low=bit_or(e,*low,packed);}else *high=bit_or(e,*high,packed);
    }
}
typedef struct {pl_operand magnitude,carry,inexact,increment;} integral_expression;
static integral_expression round_integral(expression *e,pl_operand sig,pl_operand effective,pl_operand sign,pl_operand cw,pl_u32 truncate)
{
    pl_operand small=less(e,effective,constant(16446u)),distance=sub(e,constant(16446u),effective);
    pl_operand narrow=less(e,distance,constant(64u)),right=shr(e,sig,distance);right=select(e,right,constant(0u),narrow);
    pl_operand left_shift=sub(e,effective,constant(16446u)),left=shl(e,sig,left_shift),integral=select(e,right,left,small);
    pl_operand mask=shl(e,constant(1u),distance);mask=sub(e,mask,constant(1u));pl_operand residue=bit_and(e,sig,mask);
    residue=select(e,residue,sig,narrow);pl_operand inexact=nz(e,residue);inexact=bit_and(e,inexact,small);
    pl_operand half_shift=sub(e,distance,constant(1u)),half=shl(e,constant(1u),half_shift);
    pl_operand above=less(e,half,residue),tie=equal(e,half,residue),at_most64=less(e,distance,constant(65u));
    above=bit_and(e,above,at_most64);tie=bit_and(e,tie,at_most64);
    pl_operand odd=bit_and(e,integral,constant(1u));tie=bit_and(e,tie,odd);pl_operand nearest=bit_or(e,above,tie);
    pl_operand rc=truncate?constant(3u):shift(e,cw,10u);rc=bit_and(e,rc,constant(3u));
    pl_operand down=equal(e,rc,constant(1u)),up=equal(e,rc,constant(2u)),positive=not(e,sign);
    down=bit_and(e,down,sign);up=bit_and(e,up,positive);pl_operand directed=bit_or(e,down,up);
    pl_operand near=equal(e,rc,constant(0u)),increment=select(e,nearest,directed,near);increment=bit_and(e,increment,inexact);
    pl_operand magnitude=add(e,integral,increment),carry=less(e,magnitude,integral);
    return(integral_expression){magnitude,carry,inexact,increment};
}
static int store_plan(pl_u32 bits,pl_u32 truncate,pl_u32 decimal,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits!=16u&&bits!=32u&&bits!=64u)||truncate>1u)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,decimal?PL_X86_X87_BCD_STORE_MAX_NODES:128u,decimal?768u:512u,0u,5u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},cw={PL_OPERAND_LOCAL,2u},empty={PL_OPERAND_LOCAL,3u};
    pl_operand exp=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,exp,constant(0u)),effective=select(&e,constant(1u),exp,zero_exp),sign=shift(&e,se,15u);
    integral_expression rounded=round_integral(&e,sig,effective,sign,cw,truncate);
    pl_operand magnitude=rounded.magnitude,carry=rounded.carry,inexact=rounded.inexact,increment=rounded.increment;
    pl_operand limit=decimal?constant(999999999999999999ull):add(&e,constant((1ull<<(bits-1u))-1u),sign),out_of_range=less(&e,limit,magnitude);
    pl_operand huge=less(&e,constant(16383u+(decimal?59u:bits-1u)),effective);out_of_range=bit_or(&e,out_of_range,huge);out_of_range=bit_or(&e,out_of_range,carry);
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
    if(decimal){pl_operand safe=select(&e,magnitude,constant(0u),valid),low,high;bcd_payload(&e,safe,sign,&low,&high);
        low=select(&e,constant(0xc000000000000000ull),low,invalid);high=select(&e,constant(65535u),high,invalid);
        raw.locals[0]=low;raw.locals[1]=high;raw.locals[2]=raised;raw.locals[3]=suppress;
    }else{raw.locals[0]=value;raw.locals[1]=raised;raw.locals[2]=suppress;raw.locals[3]=empty;}
    raw.locals[4]=(pl_operand){PL_OPERAND_LOCAL,4u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,(pl_u8)decimal,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_integer_store_plan(pl_u32 bits,pl_u32 truncate,pl_arena *arena,pl_plan *out)
{return store_plan(bits,truncate,0u,arena,out);}
int pl_x86_x87_bcd_store_plan(pl_arena *arena,pl_plan *out)
{return store_plan(64u,0u,1u,arena,out);}
int pl_x86_x87_round_supported(const pl_x86_instruction *i)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    return i&&i->status==PL_X86_DECODE_VALID&&i->encoding==PL_X86_ENCODING_LEGACY&&i->machine_operation==PL_X86_MACHINE_X87
        &&i->machine_argument==(49u|(0x1fcull<<16u))&&i->opcode==0xd9u&&!i->visible_operand_count
        &&(i->flow==PL_X86_FLOW_NEXT||i->flow==PL_X86_FLOW_SYSTEM)&&(i->flags&required)==required
        &&i->source_bytes&&i->source_bytes<=15u&&i->length==i->source_bytes&&i->fallthrough-i->rip==i->length
        &&!(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY));
}
int pl_x86_x87_round_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,128u,512u,0u,6u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},cw={PL_OPERAND_LOCAL,4u},empty={PL_OPERAND_LOCAL,5u};
    pl_operand exp=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,exp,constant(0u)),effective=select(&e,constant(1u),exp,zero_exp),sign=shift(&e,se,15u);
    integral_expression rounded=round_integral(&e,sig,effective,sign,cw,0u);integer_expression integer=integer_value(&e,64u,rounded.magnitude);
    pl_operand sign_word=bit_and(&e,se,constant(32768u)),integer_se=bit_and(&e,integer.se,constant(32767u));integer_se=bit_or(&e,integer_se,sign_word);
    pl_operand small=less(&e,effective,constant(16446u)),result=select(&e,integer.sig,sig,small),result_se=select(&e,integer_se,se,small);
    pl_operand full=equal(&e,exp,constant(32767u)),fraction=bit_and(&e,sig,constant(0x7fffffffffffffffull)),nan=bit_and(&e,full,nz(&e,fraction));
    pl_operand quiet=shift(&e,sig,62u);quiet=bit_and(&e,quiet,constant(1u));pl_operand signaling=bit_and(&e,nan,not(&e,quiet));
    pl_operand j=shift(&e,sig,63u),nonzero_exp=not(&e,zero_exp),missing_j=not(&e,j),unsupported=bit_and(&e,nonzero_exp,missing_j),bad=bit_or(&e,empty,unsupported),invalid=bit_or(&e,bad,signaling);
    result=select(&e,sig,result,full);result_se=select(&e,se,result_se,full);pl_operand nan_sig=bit_or(&e,sig,constant(0x4000000000000000ull));result=select(&e,nan_sig,result,nan);
    result=select(&e,constant(0xc000000000000000ull),result,bad);result_se=select(&e,constant(65535u),result_se,bad);
    pl_operand denormal=bit_and(&e,zero_exp,nz(&e,sig));denormal=bit_and(&e,denormal,not(&e,invalid));
    pl_operand unmask_i=bit_and(&e,invalid,not(&e,bit_and(&e,cw,constant(1u)))),unmask_d=bit_and(&e,denormal,not(&e,bit_and(&e,cw,constant(2u))));
    pl_operand suppress=bit_or(&e,unmask_i,unmask_d),valid=not(&e,invalid);valid=bit_and(&e,valid,not(&e,full));valid=bit_and(&e,valid,not(&e,suppress));
    pl_operand precision=bit_and(&e,rounded.inexact,valid),increment=bit_and(&e,rounded.increment,valid);
    pl_operand raised=bit_or(&e,invalid,shl(&e,denormal,constant(1u)));raised=bit_or(&e,raised,shl(&e,empty,constant(6u)));raised=bit_or(&e,raised,shl(&e,precision,constant(5u)));
    pl_operand output_exp=bit_and(&e,result_se,constant(32767u)),zero_output_exp=equal(&e,output_exp,constant(0u)),zero_sig=equal(&e,result,constant(0u)),result_zero=bit_and(&e,zero_output_exp,zero_sig);
    pl_operand tag=select(&e,constant(2u),constant(0u),full);tag=select(&e,constant(2u),tag,bad);tag=select(&e,constant(1u),tag,result_zero);
    pl_operand outcome=bit_or(&e,raised,shl(&e,increment,constant(9u)));outcome=bit_or(&e,outcome,shl(&e,suppress,constant(16u)));outcome=bit_or(&e,outcome,shl(&e,tag,constant(18u)));
    raw.locals[0]=result;raw.locals[1]=result_se;raw.locals[2]=outcome;for(pl_u32 n=3u;n<6u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
