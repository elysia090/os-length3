#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    static const pl_u8 opcode[] = {0xefu,0xdbu,0xebu,0xdfu,0xfcu,0xfdu,0xfeu,0xd4u,0x74u,0x75u,0x76u};
    static const pl_u8 operation[] = {PL_X86_VECTOR_BINARY_XOR,PL_X86_VECTOR_BINARY_AND,
        PL_X86_VECTOR_BINARY_OR,PL_X86_VECTOR_BINARY_AND_NOT,
        PL_X86_VECTOR_BINARY_ADD,PL_X86_VECTOR_BINARY_ADD,PL_X86_VECTOR_BINARY_ADD,
        PL_X86_VECTOR_BINARY_ADD,PL_X86_VECTOR_BINARY_EQUAL,PL_X86_VECTOR_BINARY_EQUAL,
        PL_X86_VECTOR_BINARY_EQUAL};
    static const pl_u8 bytes[] = {0u,0u,0u,0u,1u,2u,4u,8u,1u,2u,4u};
    pl_u32 cases=0u,refusals=0u,alternatives=0u;
    for (pl_u32 family=0u;family<11u;++family)
        for (pl_u32 target=0u;target<16u;++target)
            for (pl_u32 source=0u;source<17u;++source) {
                int memory=source==16u;
                pl_u8 code[16]={0};pl_u32 at=0u;code[at++]=0x66u;
                if(target>=8u || (!memory&&source>=8u))
                    code[at++]=(pl_u8)(0x40u|(target>=8u?4u:0u)|(!memory&&source>=8u?1u:0u));
                code[at++]=0x0fu;code[at++]=opcode[family];
                code[at++]=(pl_u8)((memory?0u:0xc0u)|((target&7u)<<3u)|(memory?0u:source&7u));
                pl_x86_map map={code,0x400000u,at,at,PL_ELF_FLAG_EXECUTE,1u};
                pl_x86_image image={&map,1u,0u,map.address};
                pl_x86_instruction instruction;pl_x86_vector_binary law;
                if(pl_x86_decode_profile(&image,map.address,&instruction)
                        || !pl_x86_vector_binary_lower(&instruction,&law))return 1;
                pl_u32 alias=!memory&&source==target,result=PL_X86_VECTOR_BINARY_VALUE;
                if(alias)result=family==0u||family==3u?PL_X86_VECTOR_BINARY_ZERO
                    :family==1u||family==2u?PL_X86_VECTOR_BINARY_IDENTITY
                    :family>=8u?PL_X86_VECTOR_BINARY_ONES:PL_X86_VECTOR_BINARY_VALUE;
                if(law.operation!=operation[family] || law.lane_bytes!=bytes[family]
                        || law.source_memory!=(pl_u8)memory || law.alias!=alias
                        || law.reverse!=(family==3u) || law.result!=result)return 1;
                _Alignas(8) pl_u8 workspace[8192];pl_arena arena={workspace,sizeof workspace,0u};
                pl_x86_semantic semantic;
                if(pl_x86_lower(&instruction,&arena,&semantic))return 1;
                for(pl_u32 bit=0u;bit<64u;++bit) {
                    pl_x86_instruction changed=instruction;changed.machine_argument^=1ull<<bit;
                    if(pl_x86_vector_binary_lower(&changed,&law))++alternatives;else ++refusals;
                }
                ++cases;
            }
    printf("shared vector binary: %u decoded laws, %u descriptor refusals, %u distinct valid operator alternatives\n",
        cases,refusals,alternatives);
    return 0;
}
