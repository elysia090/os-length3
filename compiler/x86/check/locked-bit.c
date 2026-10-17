#include <x86/decode.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    pl_u8 bytes[16];
    pl_x86_map map={bytes,0x400000u,sizeof bytes,sizeof bytes,5u,1u};
    pl_x86_image image={&map,1u,0u,0x400000u};
    pl_u32 cases=0u;
    for(pl_u32 operation=0u;operation<3u;++operation)
    for(pl_u32 width=16u;width<=64u;width*=2u)
    for(pl_u32 index=0u;index<256u;++index){
        pl_u32 at=0u;memset(bytes,0xcc,sizeof bytes);bytes[at++]=0xf0u;
        if(width==16u)bytes[at++]=0x66u;
        if(width==64u)bytes[at++]=0x48u;
        bytes[at++]=0x0fu;bytes[at++]=0xbau;
        bytes[at++]=(pl_u8)(0x28u+operation*8u);bytes[at++]=(pl_u8)index;
        const pl_u64 expected=(14u+operation)|((pl_u64)(width/8u)<<8u)
            |(1ull<<25u)|((pl_u64)index<<32u);
        for(pl_u32 profile=0u;profile<2u;++profile){
            pl_x86_instruction instruction;
            int status=profile?pl_x86_decode_profile(&image,image.entry,&instruction)
                :pl_x86_decode(&image,image.entry,&instruction);
            const pl_u32 effects=PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_PRECISE_CUT
                |PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_MAY_TRAP
                |PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY;
            if(status||instruction.status!=PL_X86_DECODE_VALID||instruction.length!=at
                    ||instruction.operation!=PL_X86_OPERATION_BIT_TEST
                    ||instruction.condition!=operation+1u
                    ||instruction.machine_operation!=PL_X86_MACHINE_ATOMIC
                    ||instruction.machine_argument!=expected
                    ||(instruction.flags&effects)!=effects
                    ||instruction.visible_operand_count!=2u
                    ||instruction.operands[0].kind!=PL_X86_OPERAND_MEMORY
                    ||instruction.operands[0].bits!=width
                    ||instruction.operands[1].kind!=PL_X86_OPERAND_IMMEDIATE
                    ||instruction.operands[1].bits!=8u
                    ||instruction.operands[1].flags&PL_X86_OPERAND_SIGNED
                    ||instruction.operands[1].value.immediate!=index
                    ||memcmp(bytes,instruction.source,at)){
                fprintf(stderr,"locked bit descriptor: width %u operation %u index %u profile %u\n",
                    width,operation,index,profile);return 1;
            }
            ++cases;
        }
    }
    printf("Locked immediate bit descriptor: %u native/profile decodes, exact typed effects\n",cases);
    return 0;
}
