#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    unsigned forms=0u,bad_forms=0u;
    for(unsigned wide=0u;wide<2u;++wide)for(unsigned family=0u;family<8u;++family)
    for(unsigned role=0u;role<3u;++role)for(unsigned count=0u;count<(role==0u?256u:1u);++count){
        unsigned n=0u,width=family<3u?16u:family<6u?32u:64u,left=family==0u||family==3u||family==6u,arithmetic=family==2u||family==5u;
        memset(page,0x90,sizeof page);if(wide)page[n++]=0x66u;page[n++]=0x0fu;
        if(role==0u){page[n++]=(pl_u8)(width==16u?0x71u:width==32u?0x72u:0x73u);page[n++]=(pl_u8)(0xc0u|((left?6u:arithmetic?4u:2u)<<3u)|1u);page[n++]=(pl_u8)count;}
        else{page[n++]=(pl_u8)(arithmetic?width==16u?0xe1u:0xe2u:(left?0xf0u:0xd0u)+(width==16u?1u:width==32u?2u:3u));page[n++]=(pl_u8)((role==1u?0xc0u:0u)|8u);}
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_vector_shift law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_shift_lower(&i,&law)||law.register_bytes!=(wide?16u:8u)
            ||law.lane_bits!=width||law.left!=left||law.arithmetic!=arithmetic||law.immediate!=(role==0u)||law.source_memory!=(role==2u)){
            fprintf(stderr,"packed shift decode %u/%u/%u/%u arg=%llx\n",wide,family,role,count,(unsigned long long)i.machine_argument);return 1;}
        _Alignas(8) pl_u8 positive_scratch[8192];
        pl_arena positive_arena={positive_scratch,sizeof positive_scratch,0u};
        pl_x86_semantic positive_semantic;
        if(pl_x86_lower(&i,&positive_arena,&positive_semantic)){
            fprintf(stderr,"packed shift common ABI %u/%u/%u/%u\n",wide,family,role,count);return 1;}
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 size;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)||!size||report.source_bytes!=n
            ||report.source_instructions!=1u||report.memory_bytes!=(role==2u?(wide?16u:8u):0u)||report.flags_written)return 1;
        for(unsigned bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=32u;break;
            case 2:changed.flow=PL_X86_FLOW_JUMP;break;case 3:changed.visible_operand_count=3u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.operands[0].value.reg.index=16u;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.opcode=0x90u;break;default:++changed.length;break;}
            pl_x86_vector_shift old,value;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_vector_shift_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++bad_forms;
        }++forms;
    }
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    page[0]=0xf0u;page[1]=0x66u;page[2]=0x0fu;page[3]=0x72u;page[4]=0xe1u;page[5]=31u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("packed shift: %u width/class/count-source forms/%u malformed; saturating unsigned counts; hardware separate\n",forms,bad_forms);return 0;
}
