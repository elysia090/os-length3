#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 opcodes[]={0x60,0x61,0x62,0x68,0x69,0x6a,0x6c,0x6d};
    unsigned forms=0u,refusals=0u;
    for(unsigned wide=0;wide<2;++wide)for(unsigned family=0;family<(wide?8u:6u);++family)
    for(unsigned dst=0;dst<(wide?16u:8u);++dst)for(unsigned src=0;src<(wide?17u:9u);++src){
        unsigned memory=src==(wide?16u:8u),n=0u;memset(page,0x90,sizeof page);
        if(wide)page[n++]=0x66u;
        if(dst>=8u||(!memory&&src>=8u))page[n++]=(pl_u8)(0x40u|(dst>=8u?4u:0u)|(!memory&&src>=8u?1u:0u));
        page[n++]=0x0fu;page[n++]=opcodes[family];page[n++]=(pl_u8)((memory?0u:0xc0u)|((dst&7u)<<3u)|(memory?0u:src&7u));
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_vector_unpack law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_unpack_lower(&i,&law)){
            fprintf(stderr,"unpack constructor %u/%u/%u/%u argument=%llx\n",wide,family,dst,src,(unsigned long long)i.machine_argument);return 1;}
        _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
        int status=pl_x86_lower(&i,&arena,&semantic);
        if(status){fprintf(stderr,"unpack common ABI %u/%u/%u/%u: %d\n",wide,family,dst,src,status);return 1;}
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes
            ||report.source_bytes!=n||report.source_instructions!=1u||report.memory_bytes!=(memory?law.source_bytes:0u)||report.flags_written){
            fprintf(stderr,"unpack emission %u/%u/%u/%u\n",wide,family,dst,src);return 1;}
        for(unsigned bad=0;bad<10u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument|=1ull<<63u;break;case 1:changed.operands[0].bits=32u;break;
            case 2:changed.operands[0].value.reg.index=32u;break;case 3:changed.visible_operand_count=1u;break;
            case 4:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 5:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 6:changed.flow=PL_X86_FLOW_RETURN;break;case 7:changed.status=PL_X86_DECODE_INVALID;break;
            case 8:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;default:changed.opcode=0x90u;break;}
            pl_x86_vector_unpack old,value;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_vector_unpack_lower(&changed,&value)||memcmp(&old,&value,sizeof value)){fprintf(stderr,"unpack refusal law %u/%u/%u/%u bad=%u\n",wide,family,dst,src,bad);return 1;}
            arena.used=0u;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC){fprintf(stderr,"unpack refusal ABI %u/%u/%u/%u bad=%u\n",wide,family,dst,src,bad);return 1;}++refusals;
        }++forms;
    }
    printf("unpack: %u MMX/XMM register/alias/memory forms, %u malformed refusals\n",forms,refusals);
    unsigned shuffles=0u;
    for(unsigned control=0;control<256u;++control)for(unsigned dst=0;dst<8u;++dst)for(unsigned src=0;src<9u;++src){
        unsigned memory=src==8u;memset(page,0x90,sizeof page);page[0]=0x0f;page[1]=0x70;page[2]=(pl_u8)((memory?0u:0xc0u)|(dst<<3u)|(memory?0u:src));page[3]=(pl_u8)control;
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_mmx_shuffle law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_mmx_shuffle_lower(&i,&law)||law.control!=control||law.source_memory!=memory)return 1;
        _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
        if(pl_x86_lower(&i,&arena,&semantic))return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=4u||report.memory_bytes!=(memory?8u:0u))return 1;
        for(unsigned bad=0;bad<4u;++bad){pl_x86_instruction changed=i;
            if(bad==0u)changed.machine_argument|=1ull<<63u;else if(bad==1u)changed.opcode=0x90u;
            else if(bad==2u)changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;else changed.operands[2].value.immediate=256u;
            arena.used=0u;if(pl_x86_mmx_shuffle_lower(&changed,&law)||pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
        }++shuffles;
    }
    printf("shuffle: %u MMX immediate/register/alias/memory forms; 4 malformed controls each\n",shuffles);return 0;
}
