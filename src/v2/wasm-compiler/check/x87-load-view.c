#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u,0xf2u,0xf3u};
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,8u,sizeof module};unsigned load_work=0u,load_span=0u,swap_work=0u,swap_span=0u;
    for(unsigned form=0u;form<33u;++form)for(unsigned p=0u;p<8u;++p){
        memset(page,0x90,sizeof page);unsigned n=0u;if(p)page[n++]=prefixes[p];
        unsigned memory=!form,exchange=form>=9u,index=form<9u?(form?form-1u:0u):(form-9u)&7u;
        page[n++]=memory?0xdbu:!exchange?0xd9u:form<17u?0xd9u:form<25u?0xddu:0xdfu;
        page[n++]=memory?0x2fu:(pl_u8)((exchange?0xc8u:0xc0u)|index);
        pl_x86_instruction i;pl_x86_x87_raw_load raw;pl_x86_x87_exchange swap;
        if(pl_x86_decode_profile(&image,map.address,&i)||(exchange?!pl_x86_x87_exchange_lower(&i,&swap):!pl_x86_x87_raw_load_lower(&i,&raw)))return 1;
        _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
        int status=exchange?pl_x86_x87_exchange_plan(!index,&arena,&pure):pl_x86_x87_load_plan(80u,2u,&arena,&pure);
        if(status)return 1;
        if(exchange){if(pure.node_count>swap_work)swap_work=pure.node_count;if(pure.span>swap_span)swap_span=pure.span;}
        else {if(pure.node_count>load_work)load_work=pure.node_count;if(pure.span>load_span)load_span=pure.span;}
        pl_u64 size=0u;wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)||!size
            ||report.source_instructions!=1u||report.source_bytes!=n||report.flags_written||report.memory_bytes!=(memory?10u:0u))return 1;
        for(unsigned bad=0u;bad<14u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.machine_argument^=1ull<<26u;break;
            case 2:changed.flow=PL_X86_FLOW_FAULT;break;case 3:changed.visible_operand_count=0u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.opcode=0x90u;break;case 11:changed.encoding=PL_X86_ENCODING_VEX;break;
            case 12:changed.source_bytes=0u;break;default:++changed.length;break;}
            if(exchange){pl_x86_x87_exchange value,old;memset(&old,0xa5,sizeof old);value=old;
                if(pl_x86_x87_exchange_lower(&changed,&value)||memcmp(&value,&old,sizeof value))return 1;}
            else {pl_x86_x87_raw_load value,old;memset(&old,0xa5,sizeof old);value=old;
                if(pl_x86_x87_raw_load_lower(&changed,&value)||memcmp(&value,&old,sizeof value))return 1;}
            arena.used=0u;pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
        }
    }
    page[0]=0xf0u;page[1]=0xdbu;page[2]=0x2fu;if(check_fault_admission(&image,&options,6u))return 1;
    printf("Raw load/FXCH: 264 forms,3696 malformed controls; pure maximum load %u/%u exchange %u/%u work/span; hardware separate\n",load_work,load_span,swap_work,swap_span);return 0;
}
