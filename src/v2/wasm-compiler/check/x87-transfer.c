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
    wasm_cut_options options={map.address,1u,sizeof module};unsigned maximum=0u,span=0u,models=0u;
    for(unsigned form=0u;form<73u;++form)for(unsigned p=0u;p<8u;++p){
        memset(page,0x90,sizeof page);unsigned length=0u;if(p)page[length++]=prefixes[p];
        page[length++]=(pl_u8)(form<64u?form<32u?0xdau:0xdbu:0xd9u);
        page[length++]=(pl_u8)(form<64u?0xc0u+((form>>3u)&3u)*8u+(form&7u):form<66u?0xe0u+(form-64u):0xe8u+(form-66u));
        pl_x86_instruction i;pl_x86_x87_transfer law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_transfer_lower(&i,&law)){fprintf(stderr,"transfer decode %u/%u arg=%llx\n",form,p,(unsigned long long)i.machine_argument);return 1;}
        _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_transfer_plan(&law,&arena,&plan)||plan.node_count>PL_X86_X87_TRANSFER_MAX_NODES){fprintf(stderr,"transfer plan %u/%u nodes=%u\n",form,p,plan.node_count);return 1;}
        if(plan.node_count>maximum)maximum=plan.node_count;
        if(plan.span>span)span=plan.span;
        if(!p)for(unsigned row=0u;row<512u;++row){
            pl_u64 cw=(row>>4u)&1u,ta=row&3u,tb=law.source?(row>>2u)&3u:ta,flags=((row>>5u)&1u)|(((row>>6u)&1u)<<6u)|(((row>>7u)&1u)<<2u);
            pl_u64 input[]={0x8123456789abcdefull,0x8fffu,ta,tb,cw|((pl_u64)((row>>7u)&3u)<<10u),flags},v[6];
            if(check_scalar_projection(&plan,input,v,6u))return 1;
            unsigned fault=law.kind==PL_X86_X87_TRANSFER_CONSTANT?ta!=3u:ta==3u||(law.kind==PL_X86_X87_TRANSFER_CONDITIONAL&&tb==3u),suppress=fault&&!cw;
            unsigned write=1u;
            if(law.kind==PL_X86_X87_TRANSFER_CONDITIONAL){unsigned cc=law.condition&~1u;pl_u64 mask=cc==2u?1u:cc==4u?64u:cc==6u?65u:4u;
                write=law.source&&(((flags&mask)!=0u)^((law.condition&1u)!=0u));}
            write=(write||fault)&&!suppress;
            if(v[3]!=(fault?(law.kind==PL_X86_X87_TRANSFER_CONSTANT?0x241u:0x41u):0u)||v[4]!=suppress||v[5]!=write){fprintf(stderr,"transfer pure %u/%u row=%u raised=%llx suppress=%llu write=%llu expected=%u/%u\n",form,p,row,(unsigned long long)v[3],(unsigned long long)v[4],(unsigned long long)v[5],suppress,write);return 1;}
            if(fault&&(v[0]!=0xc000000000000000ull||v[1]!=65535u||v[2]!=2u))return 1;
            if(!fault&&law.kind==PL_X86_X87_TRANSFER_CONDITIONAL&&(v[0]!=input[0]||v[1]!=input[1]||v[2]!=tb))return 1;
            ++models;
        }
        pl_u64 size=0u;wasm_cut_report report;if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)
            ||!size||report.source_bytes!=length||report.source_instructions!=1u||report.memory_bytes||report.flags_written)return 1;
        for(unsigned bad=0u;bad<14u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.machine_argument^=1ull<<16u;break;
            case 2:changed.flow=PL_X86_FLOW_JUMP;break;case 3:changed.visible_operand_count=3u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.opcode=0x90u;break;case 11:changed.encoding=PL_X86_ENCODING_VEX;break;
            case 12:changed.source_bytes=0u;break;default:++changed.length;break;}
            pl_x86_x87_transfer untouched,value;memset(&untouched,0xa5,sizeof untouched);value=untouched;
            if(pl_x86_x87_transfer_lower(&changed,&value)||memcmp(&untouched,&value,sizeof value)){fprintf(stderr,"transfer refusal %u/%u/%u\n",form,p,bad);return 1;}
            arena.used=0u;pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC){fprintf(stderr,"transfer common refusal %u/%u/%u\n",form,p,bad);return 1;}
        }
    }
    page[0]=0xf0u;page[1]=0xdau;page[2]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("x87 transfer: 584 common forms/8176 malformed, %u pure controls; maximum graph work/span %u/%u; physical oracle separate\n",models,maximum,span);return 0;
}
