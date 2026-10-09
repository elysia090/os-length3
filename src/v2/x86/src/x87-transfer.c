#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_control_load_supported(const pl_x86_instruction *i)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_READS_MEMORY;
    return i&&i->status==PL_X86_DECODE_VALID&&i->encoding==PL_X86_ENCODING_LEGACY&&i->machine_operation==PL_X86_MACHINE_X87
        &&i->machine_argument==(30u|(2ull<<8u))&&i->opcode==0xd9u&&i->visible_operand_count==1u
        &&i->operands[0].kind==PL_X86_OPERAND_MEMORY&&i->operands[0].bits==16u
        &&(i->flow==PL_X86_FLOW_NEXT||i->flow==PL_X86_FLOW_SYSTEM)&&(i->flags&required)==required
        &&!(i->flags&(PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER))
        &&i->source_bytes&&i->source_bytes<=15u&&i->length==i->source_bytes&&i->fallthrough-i->rip==i->source_bytes;
}
int pl_x86_x87_environment_lower(const pl_x86_instruction *i,pl_x86_x87_environment *out)
{
    if(!i||!out)return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,width=(pl_u32)(i->machine_argument>>8u),restore=kind&1u,full=kind>=34u;
    pl_u32 env=width-(full?80u:0u),required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER
        |(restore?PL_X86_INSTRUCTION_READS_MEMORY:PL_X86_INSTRUCTION_WRITES_MEMORY);
    if(kind<32u||kind>35u||(env!=14u&&env!=28u)||i->machine_argument!=(kind|((pl_u64)width<<8u))
        ||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->machine_operation!=PL_X86_MACHINE_X87
        ||i->opcode!=(full?0xddu:0xd9u)||i->visible_operand_count!=1u||i->operands[0].kind!=PL_X86_OPERAND_MEMORY
        ||i->operands[0].bits!=width*8u||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&((restore?PL_X86_INSTRUCTION_WRITES_MEMORY:PL_X86_INSTRUCTION_READS_MEMORY)|PL_X86_INSTRUCTION_LOCKED
            |PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER))
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes)return 0;
    *out=(pl_x86_x87_environment){(pl_u8)env,(pl_u8)width,(pl_u8)restore,(pl_u8)full};return 1;
}
int pl_x86_x87_control_load_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,32u,96u,0u,2u))return PL_ERROR_ARENA;
    pl_operand cw={PL_OPERAND_LOCAL,0u},sw={PL_OPERAND_LOCAL,1u};
    // Only the incoming six mask bits determine ES/B. Substitute them before
    // canonicalizing unrelated CW fields, so both output chains run in parallel.
    pl_operand inverse=binary(&e,86u,cw,constant(~0ull)),pending=bit_and(&e,inverse,sw);pending=bit_and(&e,pending,constant(63u));
    cw=bit_and(&e,cw,constant(0x1f3fu));cw=bit_or(&e,cw,constant(0x40u));
    pending=not(&e,pending);pl_operand summary=select(&e,constant(0u),constant(0x8080u),pending);
    sw=bit_and(&e,sw,constant(0x7f7fu));sw=bit_or(&e,sw,summary);raw.locals[0]=cw;raw.locals[1]=sw;
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_transfer_lower(const pl_x86_instruction *i,pl_x86_x87_transfer *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||(i->flags&required)!=required
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)
        ||(i->flags&(PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_LOCKED
            |PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER))
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes)return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,op=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    if(kind==36u){
        if(i->visible_operand_count!=2u||(i->opcode!=0xdau&&i->opcode!=0xdbu))return 0;
        for(pl_u32 n=0u;n<2u;++n){const pl_x86_operand *o=i->operands+n;
            if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||o->value.reg.class_id!=PL_X86_REGISTER_X87
                ||o->value.reg.bits!=80u||o->value.reg.flags||o->value.reg.index>7u||(!n&&o->value.reg.index))return 0;}
        pl_u32 source=i->operands[1].value.reg.index,cc=(pl_u32)(i->machine_argument>>44u);
        const pl_u8 conditions[]={2u,4u,6u,10u};pl_u32 group=(op>>3u)&3u;
        if(cc!=(conditions[group]|(i->opcode==0xdbu))||op!=((i->opcode&7u)<<8u|0xc0u|group*8u|source)
            ||i->machine_argument!=(36u|((pl_u64)op<<16u)|((pl_u64)source<<32u)|((pl_u64)cc<<44u)))return 0;
        *out=(pl_x86_x87_transfer){PL_X86_X87_TRANSFER_CONDITIONAL,(pl_u8)source,(pl_u8)cc,0u,(pl_u16)op};return 1;
    }
    if(i->visible_operand_count||i->opcode!=0xd9u)return 0;
    if(kind==54u){pl_u32 absolute=(pl_u32)(i->machine_argument>>44u);
        if(absolute>1u||op!=0x1e0u+absolute||i->machine_argument!=(54u|((pl_u64)op<<16u)|((pl_u64)absolute<<44u)))return 0;
        *out=(pl_x86_x87_transfer){(pl_u8)(absolute?PL_X86_X87_TRANSFER_ABSOLUTE:PL_X86_X87_TRANSFER_NEGATE),0u,0u,0u,(pl_u16)op};return 1;
    }
    if(kind==42u){pl_u32 rank=(pl_u32)(i->machine_argument>>32u);
        if(rank>=7u||op!=0x1e8u+rank||i->machine_argument!=(42u|((pl_u64)op<<16u)|((pl_u64)rank<<32u)))return 0;
        *out=(pl_x86_x87_transfer){PL_X86_X87_TRANSFER_CONSTANT,0u,0u,(pl_u8)rank,(pl_u16)op};return 1;
    }
    return 0;
}
int pl_x86_x87_transfer_plan(const pl_x86_x87_transfer *law,pl_arena *arena,pl_plan *out)
{
    if(!law||!arena||!out||law->kind>PL_X86_X87_TRANSFER_CONSTANT||law->source>=8u||law->constant>=7u
        ||(law->kind==PL_X86_X87_TRANSFER_CONDITIONAL
            ?(law->condition!=2u&&law->condition!=3u&&law->condition!=4u&&law->condition!=5u&&law->condition!=6u&&law->condition!=7u&&law->condition!=10u&&law->condition!=11u)
            :law->source||law->condition||(law->kind!=PL_X86_X87_TRANSFER_CONSTANT&&law->constant)))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,32u,96u,0u,6u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},tag_a={PL_OPERAND_LOCAL,2u},tag_b={PL_OPERAND_LOCAL,3u},
        cw={PL_OPERAND_LOCAL,4u},flags={PL_OPERAND_LOCAL,5u};
    pl_operand fault=equal(&e,tag_a,constant(3u)),tag=tag_a,write=constant(1u);
    if(law->kind==PL_X86_X87_TRANSFER_CONSTANT){
        // Fixed positive extended constants: floor significand and RN increment.
        // RC rounds the specified constant; PC and inexact status are irrelevant.
        static const pl_u64 floor[]={0x8000000000000000ull,0xd49a784bcd1b8afeull,0xb8aa3b295c17f0bbull,
            0xc90fdaa22168c234ull,0x9a209a84fbcff798ull,0xb17217f7d1cf79abull,0u};
        static const pl_u16 exponents[]={0x3fffu,0x4000u,0x3fffu,0x4000u,0x3ffdu,0x3ffeu,0u};
        pl_operand increment=constant(0u);
        if(law->constant>0u&&law->constant<6u){pl_operand rc=shift(&e,cw,10u);rc=bit_and(&e,rc,constant(3u));
            increment=equal(&e,rc,constant(2u));
            if(law->constant!=1u){pl_operand nearest=equal(&e,rc,constant(0u));increment=bit_or(&e,increment,nearest);}}
        sig=binary(&e,89u,constant(floor[law->constant]),increment);se=constant(exponents[law->constant]);tag=constant(law->constant==6u);
        fault=not(&e,fault);
    }else if(law->kind==PL_X86_X87_TRANSFER_CONDITIONAL){
        pl_operand other=law->source?equal(&e,tag_b,constant(3u)):fault;fault=bit_or(&e,fault,other);
        pl_u32 cc=law->condition&~1u;pl_operand predicate=bit_and(&e,flags,constant(cc==2u?1u:cc==4u?64u:cc==6u?65u:4u));
        predicate=not(&e,predicate);if(!(law->condition&1u))predicate=not(&e,predicate);
        write=law->source?predicate:constant(0u);tag=tag_b;
    }else{sig=constant(0u);se=law->kind==PL_X86_X87_TRANSFER_ABSOLUTE?bit_and(&e,se,constant(0x7fffu)):binary(&e,86u,se,constant(0x8000u));}
    sig=select(&e,constant(0xc000000000000000ull),sig,fault);se=select(&e,constant(0xffffu),se,fault);tag=select(&e,constant(2u),tag,fault);
    pl_operand raised=select(&e,constant(law->kind==PL_X86_X87_TRANSFER_CONSTANT?0x241u:0x41u),constant(0u),fault);
    pl_operand im=bit_and(&e,cw,constant(1u)),unmasked=not(&e,im),suppress=bit_and(&e,fault,unmasked);
    write=bit_or(&e,write,fault);pl_operand allowed=not(&e,suppress);write=bit_and(&e,write,allowed);
    raw.locals[0]=sig;raw.locals[1]=se;raw.locals[2]=tag;raw.locals[3]=raised;raw.locals[4]=suppress;raw.locals[5]=write;
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,1u,1u,1u};return pl_compact_projected(&raw,live,arena,out);
}
