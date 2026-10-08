#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x67u,0xf2u,0xf3u,0x64u,0x65u,0x40u};
    const pl_u16 drops[]={0u,1u,7u,8u,65535u};pl_u32 forms=0u,refusals=0u;
    for(pl_u32 p=0u;p<7u;++p)for(pl_u32 bytes=2u;bytes<=8u;bytes*=2u)for(pl_u32 kind=0u;kind<3u;++kind)
    for(pl_u32 d=0u;d<(kind==1u?5u:1u);++d){
        memset(page,0x90,sizeof page);pl_u32 n=0u;if(prefixes[p])page[n++]=prefixes[p];
        if(bytes!=4u)page[n++]=(pl_u8)(bytes==2u?0x66u:0x48u);
        page[n++]=(pl_u8)(kind==0u?0xcbu:kind==1u?0xcau:0xcfu);
        if(kind==1u){page[n++]=(pl_u8)drops[d];page[n++]=(pl_u8)(drops[d]>>8u);}
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_return law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_return_lower(&i,&law)
            ||law.bytes!=bytes||law.interrupt!=(kind==2u)||law.discard!=(kind==1u?drops[d]:0u))return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 length=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&length,&report)
            ||report.source_bytes!=n||report.source_instructions!=1u||report.boundary!=WASM_CUT_CONTROL||report.flags_written!=(kind==2u))return 1;
        for(pl_u32 bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<60u;break;case 1:changed.operand_width=128u;break;
            case 2:changed.encoding=PL_X86_ENCODING_EVEX;break;case 3:changed.visible_operand_count++;break;
            case 4:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 5:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 6:changed.flags&=~PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
            case 8:changed.flow=PL_X86_FLOW_SYSTEM;break;case 9:changed.status=PL_X86_DECODE_INVALID;break;
            case 10:changed.opcode^=1u;break;default:changed.machine_argument^=1u;break;}
            pl_x86_return out,old;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_return_lower(&changed,&out)||memcmp(&out,&old,sizeof out))return 1;
            pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;
        }
        ++forms;
    }
    printf("Return constructors: %u native/common width/parameter/prefix forms, %u malformed descriptor refusals\n",forms,refusals);return 0;
}
