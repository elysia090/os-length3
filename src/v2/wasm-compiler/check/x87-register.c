#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0xf2u,0xf3u,0x64u,0x65u};pl_u32 forms=0u,refusals=0u;
    for(pl_u32 p=0u;p<8u;++p)for(pl_u32 encoding=0u;encoding<3u;++encoding)for(pl_u32 op=0u;op<6u;++op)for(pl_u32 reg=0u;reg<8u;++reg){
        pl_u32 n=0u;memset(page,0x90,sizeof page);if(prefixes[p])page[n++]=prefixes[p];
        pl_u8 primary=(pl_u8)(encoding==0u?0xd8u:encoding==1u?0xdcu:0xdeu);
        pl_u8 second=(pl_u8)((op==5u?0xc8u:op==0u?0xc0u:op==1u?(encoding?0xe8u:0xe0u):op==2u?(encoding?0xe0u:0xe8u)
            :op==3u?(encoding?0xf8u:0xf0u):(encoding?0xf0u:0xf8u))|reg);
        page[n++]=primary;page[n++]=second;
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_x87_register_arithmetic law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_register_arithmetic_lower(&i,&law)
            ||law.operation!=(op==5u?1u:op==0u?0u:op==1u?2u:op==2u?3u:op+1u)||law.pop!=(encoding==2u)
            ||law.destination!=(encoding?reg:0u)||law.source!=(encoding?0u:reg)
            ||law.opcode!=(((primary&7u)<<8u)|second))return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
            ||report.source_bytes!=n||report.memory_bytes||report.flags_written||report.source_instructions!=1u)return 1;
        if(argc==2){char key[33],path[4096];for(pl_u32 k=0u;k<n;++k)snprintf(key+k*2u,3u,"%02x",page[k]);
            int length=snprintf(path,sizeof path,"%s/%s.wasm",argv[1],key);if(length<1||(size_t)length>=sizeof path)return 2;
            FILE *file=fopen(path,"wbx");if(!file)return 2;int bad=fwrite(module,1u,(size_t)bytes,file)!= (size_t)bytes;if(fclose(file))bad=1;if(bad)return 2;}
        for(pl_u32 bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<60u;break;case 1:changed.operands[0].bits=64u;break;
            case 2:changed.operands[1].kind=PL_X86_OPERAND_MEMORY;break;case 3:changed.visible_operand_count=0u;break;
            case 4:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;case 5:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 6:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 7:changed.operands[1].value.reg.index=8u;break;
            case 8:changed.flow=PL_X86_FLOW_FAULT;break;case 9:changed.status=PL_X86_DECODE_INVALID;break;
            case 10:changed.machine_argument^=1ull<<19u;break;default:changed.machine_argument^=1ull<<36u;break;}
            pl_x86_x87_register_arithmetic out,old;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_x87_register_arithmetic_lower(&changed,&out)||memcmp(&out,&old,sizeof out))return 1;
            pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;}
        memset(module,0xa5,sizeof module);bytes=77u;memset(&report,0xa5,sizeof report);wasm_cut_report old=report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,1u,&bytes,&report)!=WASM_COMPILER_ERROR_CAPACITY
            ||bytes!=77u||memcmp(&report,&old,sizeof old))return 1;
        for(pl_u32 k=0u;k<sizeof module;++k)if(module[k]!=0xa5u)return 1;
        ++forms;
    }
    printf("Register arithmetic: %u prefix/source/destination/pop forms, %u malformed laws; no-clobber capacities\n",forms,refusals);return 0;
}
