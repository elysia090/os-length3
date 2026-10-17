/* Decoded string laws are shared by native SSA and the independent backend. */
#include <x86/semantics.h>
#include <stdio.h>
static pl_u32 failures, laws, refusals;
#define EXPECT(x) do { if(!(x)){fprintf(stderr,"string law: line %u\n",(unsigned)__LINE__);++failures;} } while(0)
static void reject(const pl_x86_instruction *instruction)
{
    pl_x86_string law;
    EXPECT(!pl_x86_string_lower(instruction,&law));++refusals;
}
int main(void)
{
    static const pl_u8 opcode[]={0xa4u,0xaau,0xacu,0xa6u,0xaeu};
    static const pl_u8 prefix[]={0u,0x3eu,0x64u,0x65u,0x36u};
    pl_x86_string law;
    EXPECT(!pl_x86_string_lower(NULL,&law));
    for(pl_u32 kind=0u;kind<5u;++kind)for(pl_u32 bits=8u;bits<=64u;bits*=2u)
    for(pl_u32 address=32u;address<=64u;address+=32u)
    for(pl_u32 repeat=0u;repeat<3u;++repeat)for(pl_u32 segment=0u;segment<5u;++segment){
        pl_u8 bytes[15]={0};pl_u32 n=0u;
        if(prefix[segment])bytes[n++]=prefix[segment];
        if(address==32u)bytes[n++]=0x67u;
        if(bits==16u)bytes[n++]=0x66u;
        if(repeat)bytes[n++]=(pl_u8)(repeat==1u?0xf3u:0xf2u);
        if(bits==64u)bytes[n++]=0x48u;
        bytes[n++]=(pl_u8)(opcode[kind]+(bits!=8u));
        pl_x86_map map={bytes,0x400000u,n,n,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};pl_x86_instruction instruction,changed;
        EXPECT(!pl_x86_decode_profile(&image,map.address,&instruction));
        EXPECT(pl_x86_string_lower(&instruction,&law));++laws;
        EXPECT(law.kind==kind && law.bits==bits && law.address_bits==address && law.repeated==!!repeat
            && law.not_equal==(kind>=3u && repeat==2u)
            && law.reads_source==(kind==0u || kind==2u || kind==3u)
            && law.reads_target==(kind>=3u) && law.writes_target==(kind<2u)
            && law.reads_accumulator==(kind==1u || kind==4u) && law.writes_accumulator==(kind==2u));
        if(law.reads_source)EXPECT(law.source_segment==(segment==2u?4u:segment==3u?5u:3u));
        EXPECT(!pl_x86_string_lower(&instruction,NULL));
        changed=instruction;changed.operation=PL_X86_OPERATION_MOVE;reject(&changed);
        changed=instruction;changed.condition=5u;reject(&changed);
        changed=instruction;changed.address_width=16u;reject(&changed);
        changed=instruction;changed.operand_width=128u;reject(&changed);
        changed=instruction;changed.flags|=PL_X86_INSTRUCTION_LOCKED;reject(&changed);
        changed=instruction;changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;reject(&changed);
        changed=instruction;changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;reject(&changed);
        changed=instruction;changed.flow=PL_X86_FLOW_RETURN;reject(&changed);
        changed=instruction;changed.machine_argument^=1u;reject(&changed);
        changed=instruction;changed.operand_count=PL_X86_MAX_OPERANDS+1u;reject(&changed);
        for(pl_u32 i=0u;i<instruction.operand_count;++i){
            if(instruction.operands[i].kind!=PL_X86_OPERAND_MEMORY)continue;
            changed=instruction;changed.operands[i].bits=128u;reject(&changed);
            changed=instruction;changed.operands[i].value.memory.base.bits=16u;reject(&changed);
            changed=instruction;changed.operands[i].value.memory.base.flags=1u;reject(&changed);
            changed=instruction;changed.operands[i].value.memory.has_displacement=1u;reject(&changed);
            changed=instruction;changed.operands[i].value.memory.index.class_id=PL_X86_REGISTER_GPR;reject(&changed);
            changed=instruction;changed.operands[i].value.memory.segment.class_id=PL_X86_REGISTER_SEGMENT;
            changed.operands[i].value.memory.segment.index=6u;reject(&changed);
        }
    }
    if(!failures)printf("Shared string laws: %u forms, %u malformed descriptor refusals (not execution)\n",laws,refusals);
    return failures?1:0;
}
