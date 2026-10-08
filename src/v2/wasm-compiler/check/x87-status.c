#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0xf2u,0xf3u,0x64u,0x65u};pl_u32 forms=0u,refusals=0u;
    for(pl_u32 p=0u;p<8u;++p)for(pl_u32 family=0u;family<43u;++family){
        pl_u32 n=0u,memory=family<8u,width=0u;memset(page,0x90,sizeof page);if(prefixes[p])page[n++]=prefixes[p];
        if(memory){pl_u32 integer=family>=4u,pop=!(family&1u);width=integer?(family<6u?2u:4u):(family<2u?4u:8u);
            page[n++]=(pl_u8)(integer?(width==2u?0xdeu:0xdau):(width==4u?0xd8u:0xdcu));page[n++]=(pl_u8)(((pop?3u:2u)<<3u)|7u);
        }else if(family<40u){pl_u32 mode=(family-8u)/8u,index=(family-8u)&7u,ordered=mode<2u,pop=!(mode&1u);
            page[n++]=(pl_u8)(ordered?0xd8u:0xddu);page[n++]=(pl_u8)((ordered?0xd0u:0xe0u)|(pop?8u:0u)|index);
        }else{page[n++]=(pl_u8)(family==40u?0xdeu:family==41u?0xdau:0xd9u);page[n++]=(pl_u8)(family==40u?0xd9u:family==41u?0xe9u:0xe4u);}
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_x87_status_compare law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_status_compare_lower(&i,&law)||law.memory!=memory||law.bytes!=width)return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
            ||report.source_bytes!=n||report.memory_bytes!=width||report.flags_written||report.source_instructions!=1u)return 1;
        if(argc==2){char key[33],path[4096];for(pl_u32 k=0u;k<n;++k)snprintf(key+k*2u,3u,"%02x",page[k]);
            int length=snprintf(path,sizeof path,"%s/%s.wasm",argv[1],key);if(length<1||(size_t)length>=sizeof path)return 2;
            FILE *file=fopen(path,"wbx");if(!file)return 2;int bad=fwrite(module,1u,(size_t)bytes,file)!=(size_t)bytes;if(fclose(file))bad=1;if(bad)return 2;}
        for(pl_u32 bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<60u;break;case 1:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 2:changed.encoding=PL_X86_ENCODING_VEX;break;case 3:changed.visible_operand_count=3u;break;
            case 4:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 5:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
            case 8:changed.flow=PL_X86_FLOW_FAULT;break;case 9:changed.status=PL_X86_DECODE_INVALID;break;
            case 10:changed.machine_argument^=1ull<<24u;break;default:changed.machine_argument^=1ull<<48u;break;}
            pl_x86_x87_status_compare out,old;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_x87_status_compare_lower(&changed,&out)||memcmp(&out,&old,sizeof out)){
                fprintf(stderr,"status law refusal failed family=%u prefix=%02x mutation=%u\n",family,prefixes[p],bad);return 1;}
            pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;}
        memset(module,0xa5,sizeof module);bytes=77u;memset(&report,0xa5,sizeof report);wasm_cut_report old=report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,1u,&bytes,&report)!=WASM_COMPILER_ERROR_CAPACITY
            ||bytes!=77u||memcmp(&report,&old,sizeof old))return 1;
        for(pl_u32 k=0u;k<sizeof module;++k)if(module[k]!=0xa5u)return 1;
        ++forms;
    }
    printf("x87 status comparisons: %u prefix/family forms, %u common/native malformed laws; no-clobber capacities\n",forms,refusals);return 0;
}
