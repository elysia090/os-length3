#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u,0xf2u,0xf3u};
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,8u,sizeof module};unsigned maximum=0u,span=0u;
    for(unsigned form=0u;form<18u;++form)for(unsigned p=0u;p<8u;++p){
        memset(page,0x90,sizeof page);unsigned length=0u;if(p)page[length++]=prefixes[p];
        page[length++]=(pl_u8)(form<8u?0xddu:form<16u?0xdfu:0xd9u);
        page[length++]=(pl_u8)(form<16u?0xc0u+(form&7u):form==16u?0xf6u:0xf7u);
        pl_x86_instruction i;pl_x86_x87_stack law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_stack_lower(&i,&law))return 1;
        _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_stack_plan(&law,&arena,&plan)||plan.node_count>PL_X86_X87_STACK_MAX_NODES)return 1;
        if(plan.node_count>maximum)maximum=plan.node_count;
        if(plan.span>span)span=plan.span;
        if(!p)for(pl_u32 sw=0u;sw<65536u;++sw){
            pl_u64 tag=(sw*40503u+12345u)&65535u,input[]={sw,tag,0u,0u,0u},value[3];
            pl_u32 top=(sw>>11u)&7u,next=(top+law.step)&7u;
            pl_u64 expected=tag;
            if(law.free_register)expected|=3ull<<(((top+law.source)&7u)*2u);
            if(law.free_register&&law.step)expected|=3ull<<(top*2u);
            if(check_scalar_plan(&plan,input,value)||value[0]!=((sw&0xc5ffu)|(next<<11u))||value[1]!=expected)return 1;
        }
        pl_u64 size=0u;wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)||!size
            ||report.source_bytes!=length||report.source_instructions!=1u||report.continuation!=map.address+length
            ||report.memory_bytes||report.flags_written||report.read_registers||report.written_registers)return 1;
        for(unsigned bad=0u;bad<14u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.machine_argument^=1ull<<16u;break;
            case 2:changed.flow=PL_X86_FLOW_JUMP;break;case 3:changed.visible_operand_count=2u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.opcode=0x90u;break;case 11:changed.encoding=PL_X86_ENCODING_VEX;break;
            case 12:changed.source_bytes=0u;break;default:++changed.length;break;}
            pl_x86_x87_stack untouched,value;memset(&untouched,0xa5,sizeof untouched);value=untouched;
            if(pl_x86_x87_stack_lower(&changed,&value)||memcmp(&untouched,&value,sizeof value))return 1;
            arena.used=0u;pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
        }
    }
    page[0]=0xf0u;page[1]=0xddu;page[2]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("x87 stack: 144 common forms,2016 malformed laws,1179648 pure state-word checks; maximum work/span %u/%u; hardware oracle separate\n",maximum,span);return 0;
}
