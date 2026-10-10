#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};unsigned forms=0u;
    const pl_u8 opcodes[]={0x0c,0x0d,0x0e,0x21},lanes[]={4u,8u,2u,4u};
    for(unsigned family=0u;family<4u;++family)for(unsigned control=0u;control<256u;++control)
    for(unsigned d=0u;d<16u;++d)for(unsigned s=0u;s<17u;++s){
        unsigned memory=s==16u,n=0u;memset(page,0x90,sizeof page);page[n++]=0x66u;
        if(d>=8u||(!memory&&s>=8u))page[n++]=(pl_u8)(0x40u|(d>=8u?4u:0u)|(!memory&&s>=8u?1u:0u));
        page[n++]=0x0fu;page[n++]=0x3au;page[n++]=opcodes[family];page[n++]=(pl_u8)((memory?0u:0xc0u)|((d&7u)<<3u)|(memory?0u:s&7u));page[n++]=(pl_u8)control;
        pl_x86_instruction i;pl_x86_vector_projection p;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_project(&i,&p))return 1;
        if(p.lane_bytes!=lanes[family]||pl_x86_vector_projection_extent(&p)!=(memory?(family==3u?4u:16u):0u))return 1;
        for(pl_u32 b=0u;b<16u;++b){pl_u32 expected;
            if(family<3u)expected=b+(p.inputs==2u&&((control>>(b/lanes[family]))&1u)?16u:0u);
            else expected=(control&(1u<<(b/4u)))||b/4u!=((control>>4u)&3u)?b:
                (p.inputs==2u?16u:0u)+(memory?0u:control>>6u)*4u+b%4u;
            if(pl_x86_vector_project_byte(&p,b)!=expected)return 1;
        }
        if(d==9u&&s==3u&&(control<16u||control==255u)){pl_u64 bytes;wasm_cut_report report;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes
                ||report.source_bytes!=n||report.source_instructions!=1u||report.flags_written)return 1;}
        ++forms;
    }
    printf("Vector selection/insertion: %u all-immediate/register/alias/memory coordinate laws; physical execution separate\n",forms);return 0;
}
