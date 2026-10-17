#include <x86/decode.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
int main(void)
{
    const pl_u8 prefixes[]={0u,0x48u,0x67u,0x64u,0x65u,0x66u,0xf2u,0xf3u};
    const pl_u32 allocations[]={0u,1u,16u,4095u,4096u,0x8949u,65535u};pl_u32 forms=0u,refusals=0u;
    for(pl_u32 p=0u;p<8u;++p)for(pl_u32 nesting=0u;nesting<256u;++nesting)for(pl_u32 a=0u;a<7u;++a){
        pl_u8 page[4096]={0};pl_u32 n=0u;if(prefixes[p])page[n++]=prefixes[p];page[n++]=0xc8u;
        page[n++]=(pl_u8)allocations[a];page[n++]=(pl_u8)(allocations[a]>>8u);page[n++]=(pl_u8)nesting;
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_enter law;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_enter_lower(&i,&law)
            ||law.allocation!=allocations[a]||law.level!=(nesting&31u)||law.bytes!=(prefixes[p]==0x66u?2u:8u))return 1;
        for(pl_u32 rank=0u;rank<law.steps;++rank){pl_x86_enter_step_info step;if(!pl_x86_enter_step(&law,rank,&step))return 1;
            if(rank==0u&&(step.kind!=PL_X86_ENTER_OLD_BASE||step.subtract!=law.bytes))return 1;
            if(rank+1u==law.steps&&(step.kind!=PL_X86_ENTER_PROBE||step.subtract!=law.allocation+law.bytes*(law.level?law.level+1u:1u)))return 1;}
        for(pl_u32 bad=0u;bad<8u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.operands[0].value.immediate=65536u;break;case 1:changed.operands[1].value.immediate=256u;break;
            case 2:changed.operands[0].bits=32u;break;case 3:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 4:changed.operand_width=32u;break;case 5:changed.flow=PL_X86_FLOW_RETURN;break;
            case 6:changed.operands[0].flags|=PL_X86_OPERAND_SIGNED;break;default:changed.visible_operand_count=0u;break;}
            pl_x86_enter out,old;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_enter_lower(&changed,&out)||memcmp(&old,&out,sizeof old))return 1;
            ++refusals;}
        ++forms;
    }
    printf("ENTER shared law: %u prefix/allocate/raw-nesting forms, %u malformed refusals, bounded ordered construction\n",forms,refusals);return 0;
}
