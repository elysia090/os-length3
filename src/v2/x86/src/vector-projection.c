/* Static vector permutations are one coordinate substitution. */
#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_mmx_shuffle_lower(const pl_x86_instruction *i,pl_x86_mmx_shuffle *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_X87||(i->machine_argument&255u)!=38u||i->opcode!=0x70u
        ||i->visible_operand_count!=3u||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u
        ||i->source_bytes!=i->length||i->fallthrough-i->rip!=i->length
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u,*c=d+2u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY;
    if(d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=64u||d->value.reg.class_id!=PL_X86_REGISTER_MMX||d->value.reg.bits!=64u||d->value.reg.flags||d->value.reg.index>=8u
        ||s->bits!=64u||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_MMX||s->value.reg.bits!=64u||s->value.reg.flags||s->value.reg.index>=8u))
        ||c->kind!=PL_X86_OPERAND_IMMEDIATE||c->bits!=8u||c->value.immediate>255u||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u64 expected=38u|((pl_u64)(memory?8u:0u)<<8u)|(i->machine_argument&(0x7ffull<<16u))
        |((pl_u64)(memory?0u:s->value.reg.index)<<32u)|((pl_u64)d->value.reg.index<<36u)|(c->value.immediate<<48u);
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_mmx_shuffle){(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index,(pl_u8)c->value.immediate};return 1;
}
int pl_x86_mmx_shuffle_plan(pl_u32 control,pl_arena *arena,pl_plan *out)
{
    if(control>255u||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,24u,72u,0u,1u))return PL_ERROR_ARENA;
    pl_operand input={PL_OPERAND_LOCAL,0u},value=constant(0u);
    pl_x86_vector_projection p={2u,0u,(pl_u8)control,1u,0u,0u,0u,0u};
    if(control==0xe4u)value=input;
    else for(pl_u32 word=0u;word<4u;++word){pl_u32 selected=pl_x86_vector_project_byte(&p,word*2u)*8u;
        pl_operand lane=shift(&e,input,selected);lane=bit_and(&e,lane,constant(65535u));
        if(word)lane=binary(&e,PL_OPCODE_LANE64_SHL,lane,constant(word*16u));
        value=bit_or(&e,value,lane);}
    raw.locals[0]=value;if(e.failed)return PL_ERROR_ARENA;const pl_u8 live[]={1u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_vector_shift_lower(const pl_x86_instruction *i,pl_x86_vector_shift *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=PL_X86_VECTOR_PACKED_SHIFT
        ||i->visible_operand_count!=2u||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u
        ||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 mmx=(pl_u32)(i->machine_argument>>25u)&1u,width=mmx?64u:128u;
    pl_u32 bits=(pl_u32)(i->machine_argument>>32u)&255u,left=(pl_u32)(i->machine_argument>>28u)&1u,arithmetic=(pl_u32)(i->machine_argument>>27u)&1u;
    pl_u32 immediate=s->kind==PL_X86_OPERAND_IMMEDIATE,memory=s->kind==PL_X86_OPERAND_MEMORY,cls=mmx?PL_X86_REGISTER_MMX:PL_X86_REGISTER_VECTOR;
    if((bits!=16u&&bits!=32u&&bits!=64u)||(arithmetic&&(left||bits==64u))||d->kind!=PL_X86_OPERAND_REGISTER
        ||d->bits!=width||d->value.reg.class_id!=cls||d->value.reg.bits!=width||d->value.reg.flags||d->value.reg.index>=(mmx?8u:16u)
        ||(immediate?(s->bits!=8u||s->value.immediate>255u):s->bits!=width
            ||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=cls||s->value.reg.bits!=width||s->value.reg.flags||s->value.reg.index>=(mmx?8u:16u))))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u32 opcode=immediate?bits==16u?0x71u:bits==32u?0x72u:0x73u:
        arithmetic?bits==16u?0xe1u:0xe2u:(left?0xf0u:0xd0u)+(bits==16u?1u:bits==32u?2u:3u);
    pl_u64 expected=PL_X86_VECTOR_PACKED_SHIFT|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(!memory&&!immediate?s->value.reg.index:0u)<<16u)
        |((pl_u64)memory<<24u)|((pl_u64)mmx<<25u)|((pl_u64)immediate<<26u)|((pl_u64)arithmetic<<27u)|((pl_u64)left<<28u)
        |((pl_u64)bits<<32u)|((pl_u64)(immediate?s->value.immediate:0u)<<40u);
    if(i->machine_argument!=expected||i->opcode!=opcode)return 0;
    *out=(pl_x86_vector_shift){(pl_u8)(width/8u),(pl_u8)bits,(pl_u8)left,(pl_u8)arithmetic,(pl_u8)immediate,
        (pl_u8)(immediate?s->value.immediate:0u),(pl_u8)memory,(pl_u8)(!memory&&!immediate?s->value.reg.index:0u),d->value.reg.index};return 1;
}

static int xmm(const pl_x86_operand *operand)
{
    return operand->kind == PL_X86_OPERAND_REGISTER
        && operand->bits == 128u
        && operand->value.reg.class_id == PL_X86_REGISTER_VECTOR
        && operand->value.reg.bits == 128u
        && operand->value.reg.index < 16u && !operand->value.reg.flags;
}

int pl_x86_vector_project(const pl_x86_instruction *instruction,
                           pl_x86_vector_projection *out)
{
    if (!instruction || !out
            || instruction->status != PL_X86_DECODE_VALID
            || instruction->flow != PL_X86_FLOW_NEXT
            || instruction->machine_operation != PL_X86_MACHINE_VECTOR
            || (instruction->flags & (PL_X86_INSTRUCTION_LOCKED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)))
        return 0;
    pl_u32 kind = (pl_u32)instruction->machine_argument & 255u;
    if(kind==PL_X86_VECTOR_ALIGN_RIGHT){
        const pl_x86_operand *d=instruction->operands,*s=d+1u,*a=d+2u;
        pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY;
        const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
        if(instruction->encoding!=PL_X86_ENCODING_LEGACY||instruction->opcode!=0x0fu||instruction->visible_operand_count!=3u
            ||(instruction->flags&required)!=required||!instruction->source_bytes||instruction->source_bytes>15u||instruction->length!=instruction->source_bytes
            ||instruction->fallthrough-instruction->rip!=instruction->length||!xmm(d)||(memory?s->bits!=128u:!xmm(s))
            ||a->kind!=PL_X86_OPERAND_IMMEDIATE||a->bits!=8u||a->value.immediate>255u
            ||(instruction->flags&(PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED))
            ||!!(instruction->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory
            ||instruction->machine_argument!=(kind|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)
                |((pl_u64)memory<<24u)|((pl_u64)memory<<26u)|(a->value.immediate<<32u)))return 0;
        pl_u32 count=a->value.immediate>32u?32u:(pl_u32)a->value.immediate;
        int alias=!memory&&d->value.reg.index==s->value.reg.index;
        pl_u32 inputs=count>=32u?0u:(!count||(count<16u&&alias))?1u:2u;
        *out=(pl_x86_vector_projection){1u,(pl_u8)count,2u,(pl_u8)inputs,
            (pl_u8)(!count&&!memory?s->value.reg.index:d->value.reg.index),(pl_u8)(memory?0u:s->value.reg.index),(pl_u8)memory,
            (pl_u8)(!memory&&(count==16u||(!count&&alias)))};return 1;
    }
    if (kind == 23u) {
        const pl_x86_operand *target=instruction->operands,*amount=target+1u;
        if(instruction->visible_operand_count!=2u || !xmm(target)
                || amount->kind!=PL_X86_OPERAND_IMMEDIATE || amount->bits!=8u
                || amount->value.immediate>255u)return 0;
        pl_u32 count=(pl_u32)(amount->value.immediate>15u?16u:amount->value.immediate);
        pl_u64 left=(instruction->machine_argument>>37u)&1u;
        pl_u64 descriptor=23u|((pl_u64)target->value.reg.index<<8u)
            |((pl_u64)target->value.reg.index<<16u)|((count|(left<<5u))<<32u);
        if(instruction->machine_argument!=descriptor)return 0;
        *out=(pl_x86_vector_projection){1u,(pl_u8)count,(pl_u8)left,
            (pl_u8)(count==16u?0u:count?2u:1u),target->value.reg.index,0u,0u,(pl_u8)!count};
        return 1;
    }
    int fixed = kind == PL_X86_VECTOR_FIXED_DWORD_SHUFFLE;
    int doubles=kind==40u;
    if (kind != 7u && kind != 8u && kind != 27u && !doubles
            && kind != PL_X86_VECTOR_SHUFFLE_LOW_WORDS && !fixed)
        return 0;
    if (instruction->visible_operand_count != (fixed ? 2u : 3u))
        return 0;
    const pl_x86_operand *target = instruction->operands;
    const pl_x86_operand *source = instruction->operands + 1u;
    int memory = source->kind == PL_X86_OPERAND_MEMORY;
    if (!xmm(target) || (memory ? source->bits != 128u : !xmm(source)))
        return 0;
    pl_u64 control = instruction->machine_argument >> 32u;
    if (control > (doubles?3u:255u) || (fixed && control != 0xa0u && control != 0xf5u))
        return 0;
    if (!fixed && (instruction->operands[2].kind != PL_X86_OPERAND_IMMEDIATE
            || instruction->operands[2].bits != 8u
            || instruction->operands[2].value.immediate>255u
            || (doubles?(instruction->operands[2].value.immediate&3u):instruction->operands[2].value.immediate) != control))
        return 0;
    pl_u64 descriptor = kind
        | ((pl_u64)target->value.reg.index << 8u)
        | ((pl_u64)(memory ? 0u : source->value.reg.index) << 16u)
        | ((pl_u64)memory << 24u) | ((pl_u64)memory << 26u)
        | (control << 32u);
    if (instruction->machine_argument != descriptor) return 0;
    int paired = kind == 8u||doubles;
    /* A qword selector is two adjacent dword coordinates. The common byte
     * projection therefore needs neither a new executor nor a new format. */
    if(doubles){pl_u32 lo=((pl_u32)control&1u)*2u,hi=(((pl_u32)control>>1u)&1u)*2u;
        control=lo|((lo+1u)<<2u)|(hi<<4u)|((hi+1u)<<6u);}
    int alias = !memory && source->value.reg.index == target->value.reg.index;
    *out = (pl_x86_vector_projection){
        (pl_u8)((kind == 27u || kind == PL_X86_VECTOR_SHUFFLE_LOW_WORDS) ? 2u : 4u),
        (pl_u8)(kind == 27u ? 8u : 0u), (pl_u8)control,
        (pl_u8)(paired && !alias ? 2u : 1u),
        (pl_u8)(paired ? target->value.reg.index : memory ? 0u : source->value.reg.index),
        (pl_u8)(memory ? 0u : source->value.reg.index),
        (pl_u8)memory, 0u
    };
    /* Substitution of equal input coordinates also removes the two-source
     * distinction. Identity is proved from the full selection, not a special
     * instruction mnemonic or a guessed immediate. */
    out->identity = (pl_u8)!memory;
    for (pl_u32 byte = 0u; byte < 16u; ++byte)
        if (pl_x86_vector_project_byte(out, byte) != byte) out->identity = 0u;
    out->identity = (pl_u8)(out->identity && alias);
    return 1;
}

pl_u32 pl_x86_vector_project_byte(const pl_x86_vector_projection *projection,
                                  pl_u32 byte)
{
    if(projection&&projection->lane_bytes==1u&&projection->control==2u&&byte<16u&&projection->start<=32u){
        pl_u32 count=projection->start;
        if(projection->inputs==0u)return count==32u?16u:32u;
        if(projection->inputs==1u){if(!count)return byte;if(count>=16u)return 32u;return(byte+count)&15u;}
        if(projection->inputs!=2u)return 32u;
        if(count<16u)return byte+count<16u?16u+byte+count:byte+count-16u;
        return byte+count<32u?byte+count-16u:16u;
    }
    if(projection && projection->lane_bytes==1u && byte<16u
            && projection->start<=16u && projection->control<=1u) {
        pl_u32 count=projection->start;
        if(projection->inputs!=(count==16u?0u:count?2u:1u))return 32u;
        if(projection->control)return byte<count?16u:byte-count;
        return byte+count<16u?byte+count:16u;
    }
    if (!projection || byte >= 16u
            || (projection->lane_bytes != 2u && projection->lane_bytes != 4u)
            || (projection->inputs != 1u && projection->inputs != 2u)
            || (projection->lane_bytes == 4u ? projection->start != 0u
                : projection->start != 0u && projection->start != 8u)
            || (projection->inputs == 2u && projection->lane_bytes != 4u))
        return 32u;
    pl_u32 bytes = projection->lane_bytes, start = projection->start;
    if (bytes == 2u && (byte < start || byte >= start + 8u)) return byte;
    pl_u32 lane = (byte - start) / bytes;
    pl_u32 selected = (projection->control >> (lane * 2u)) & 3u;
    pl_u32 second = projection->inputs == 2u && lane >= 2u ? 16u : 0u;
    return second + start + bytes * selected + (byte - start) % bytes;
}
