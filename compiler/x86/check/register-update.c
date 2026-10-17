#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 bytes[16],arena_bytes[65536];
static int parent_select(const pl_plan *plan,pl_u32 reg,pl_u32 argument)
{
    pl_operand value=plan->locals[reg];
    if(value.kind!=PL_OPERAND_NODE || !value.value || value.value>plan->node_count)return 0;
    const pl_node *node=&plan->nodes[value.value-1u];
    if(node->opcode!=PL_OPCODE_LANE64_SELECT || node->argument_count!=3u)return 0;
    pl_operand old=plan->arguments[node->argument_at+argument];
    return old.kind==PL_OPERAND_LOCAL && old.value==reg;
}
int main(void)
{
    pl_x86_map map={bytes,0x400000u,sizeof bytes,sizeof bytes,5u,1u};
    pl_x86_image image={&map,1u,0u,map.address};pl_u32 forms=0u,parents=0u;
    for(pl_u32 compare=0u;compare<2u;++compare)
    for(pl_u32 width=8u;width<=64u;width*=2u)
    for(pl_u32 dst=0u;dst<16u;++dst)for(pl_u32 src=0u;src<16u;++src){
        memset(bytes,0x90,sizeof bytes);pl_u32 n=0u;
        if(width==16u)bytes[n++]=0x66u;
        pl_u32 rex=(width==64u?8u:0u)|(dst>=8u?1u:0u)|(src>=8u?4u:0u);
        if(rex || width==8u)bytes[n++]=(pl_u8)(0x40u|rex);
        bytes[n++]=0x0fu;bytes[n++]=(pl_u8)((compare?0xb0u:0xc0u)+(width!=8u));
        bytes[n++]=(pl_u8)(0xc0u|((src&7u)<<3u)|(dst&7u));
        pl_x86_instruction instruction;pl_x86_semantic semantic;
        pl_arena arena={arena_bytes,sizeof arena_bytes,0u};
        if(pl_x86_decode_profile(&image,image.entry,&instruction)
                || pl_x86_lower(&instruction,&arena,&semantic))return 1;
#ifndef CHECK_PARENT_ONLY
        pl_x86_register_update law;
        if(!pl_x86_register_update_lower(&instruction,&law) || law.bits!=width || law.compare!=compare)return 1;
#endif
        if(compare && dst
#ifdef CHECK_PARENT_ONLY
                && width==32u
#endif
                ){
            if(!parent_select(&semantic.plan,0u,0u) || !parent_select(&semantic.plan,dst,1u)){
                fprintf(stderr,"conditional parent lost width=%u dst=%u src=%u\n",width,dst,src);return 1;
            }
            parents+=2u;
        }
#ifndef CHECK_PARENT_ONLY
        pl_x86_instruction changed=instruction;changed.flags|=PL_X86_INSTRUCTION_LOCKED;
        if(pl_x86_register_update_lower(&changed,&law))return 1;
        changed=instruction;changed.operands[1].value.reg.bits=7u;
        if(pl_x86_register_update_lower(&changed,&law))return 1;
        changed=instruction;changed.encoding=PL_X86_ENCODING_EVEX;
        if(pl_x86_register_update_lower(&changed,&law))return 1;
#endif
        ++forms;
    }
    printf("register update law: %u all-register forms, %u conditional full-parent definitions; native oracle separate\n",forms,parents);
    return 0;
}
