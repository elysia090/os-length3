#include <x86/decode.h>
#include <x86/profile.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    pl_u8 bytes[16];
    pl_x86_map map={bytes,0x400000u,sizeof bytes,sizeof bytes,5u,1u};
    pl_x86_image image={&map,1u,0u,0x400000u};
    pl_u32 cases=0u,failed=0u;
    for (pl_u32 reverse=0u;reverse<2u;++reverse)
    for (pl_u32 prefix=0u;prefix<2u;++prefix)
    for (pl_u32 memory=0u;memory<2u;++memory)
    for (pl_u32 width=16u;width<=64u;width*=2u) {
        pl_u32 at=0u;
        memset(bytes,0x90,sizeof bytes);
        if (prefix) bytes[at++]=0xf3u;
        if (width==16u) bytes[at++]=0x66u;
        if (width==64u) bytes[at++]=0x48u;
        bytes[at++]=0x0fu; bytes[at++]=reverse ? 0xbdu : 0xbcu;
        bytes[at++]=memory ? 0x07u : 0xc7u;
        pl_x86_instruction instruction;
        pl_u32 extension=reverse ? !!(PL_X86_CPUID_80000001_ECX&(1u<<5u))
                                : !!(PL_X86_CPUID_7_0_EBX&(1u<<3u));
        pl_u32 expected=extension && prefix ? (reverse ? 3u : 2u) : (reverse ? 0u : 1u);
        if (pl_x86_decode_profile(&image,image.entry,&instruction)
                || instruction.status!=PL_X86_DECODE_VALID
                || instruction.operation!=PL_X86_OPERATION_BIT_SUMMARY
                || instruction.condition!=expected || instruction.length!=at
                || instruction.source_bytes!=at || memcmp(bytes,instruction.source,at)
                || instruction.visible_operand_count!=2u
                || instruction.operands[0].bits!=width || instruction.operands[1].bits!=width
                || instruction.operands[1].kind!=(memory ? PL_X86_OPERAND_MEMORY : PL_X86_OPERAND_REGISTER)) {
            fprintf(stderr,"profile scan decode: RED (reverse=%u prefix=%u memory=%u width=%u)\n",
                reverse,prefix,memory,width); ++failed;
        }
        /* Linked-x86 analysis must not narrow native extensions on superset
         * CPUs just because their delivery projection uses a smaller ISA. */
        pl_u32 native_condition=prefix ? (reverse ? 3u : 2u) : (reverse ? 0u : 1u);
        if (pl_x86_decode(&image,image.entry,&instruction)
                || instruction.operation!=PL_X86_OPERATION_BIT_SUMMARY
                || instruction.condition!=native_condition) {
            fprintf(stderr,"native extension decode: RED\n"); ++failed;
        }
        ++cases;
    }
    /* Absent features fault in the fixed machine, while native postlinking
     * retains their source on superset hosts. No operand is accessed at #UD. */
    static const pl_u8 absent[][6]={{0xc5,0xf8,0x10,0x07},
        {0x66,0x0f,0x38,0xdc,0x07},{0x0f,0xae,0x27}};
    static const pl_u8 lengths[]={4u,5u,3u};
    for(pl_u32 i=0u;i<sizeof lengths;++i){
        memset(bytes,0x90,sizeof bytes);memcpy(bytes,absent[i],lengths[i]);
        pl_x86_instruction instruction;pl_x86_fault_cut law;
        if(pl_x86_decode_profile(&image,image.entry,&instruction)
                || !pl_x86_fault_cut_lower(&instruction,&law) || law.vector!=6u || law.bytes!=lengths[i])++failed;
        if(pl_x86_decode(&image,image.entry,&instruction)
                || instruction.flow==PL_X86_FLOW_FAULT || instruction.machine_operation!=PL_X86_MACHINE_EXTENSION)++failed;
        ++cases;
    }
    if (failed) return 1;
    printf("Profile-dependent legacy/count scan decode: green (%u cases; profile unchanged)\n",cases);
    return 0;
}
