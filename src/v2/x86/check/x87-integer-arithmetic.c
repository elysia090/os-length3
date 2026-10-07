#include <x86/decode.h>
#include <stdio.h>
#include <string.h>
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0xf2u,0xf3u,0x64u,0x65u};
    pl_u8 page[4096];pl_u32 forms=0u;
    for(pl_u32 p=0u;p<sizeof prefixes;++p)for(pl_u32 w=0u;w<2u;++w)for(pl_u32 op=0u;op<3u;++op){
        pl_u32 width=w?4u:2u,group=op==0u?0u:op==1u?4u:5u,n=0u;
        memset(page,0x90,sizeof page);if(prefixes[p])page[n++]=prefixes[p];
        page[n++]=(pl_u8)(w?0xdau:0xdeu);page[n++]=(pl_u8)((group<<3u)|7u);
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};pl_x86_instruction i={0};
        pl_u64 fop=((pl_u64)(page[n-2u]&7u)<<8u)|page[n-1u],options=op==0u?0u:op==1u?2u:3u;
        pl_u64 expected=12u|((pl_u64)width<<8u)|(fop<<16u)|(options<<36u);
        if(pl_x86_decode_profile(&image,map.address,&i)||i.status!=PL_X86_DECODE_VALID
            ||i.source_bytes!=n||i.machine_operation!=PL_X86_MACHINE_X87||i.machine_argument!=expected
            ||i.visible_operand_count!=1u||i.operands[0].kind!=PL_X86_OPERAND_MEMORY||i.operands[0].bits!=width*8u){
            fprintf(stderr,"integer arithmetic descriptor prefix=%02x width=%u operation=%u FOP expected=%llx actual=%llx\n",
                prefixes[p],width,op,(unsigned long long)expected,(unsigned long long)i.machine_argument);return 1;}
        ++forms;
    }
    printf("Integer arithmetic descriptor: %u forms preserve decoded FOP across prefixes; not a Wasm arithmetic claim\n",forms);return 0;
}
