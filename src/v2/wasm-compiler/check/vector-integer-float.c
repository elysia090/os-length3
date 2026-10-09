#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x67u,0x48u,0x64u,0x65u};unsigned forms=0u,bad_forms=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<9u;++src)for(unsigned p=0u;p<5u;++p){
        unsigned memory=src==8u,n=0u;memset(page,0x90,sizeof page);
        if(prefixes[p]&&prefixes[p]!=0x48u)page[n++]=prefixes[p];
        unsigned rex=(p==2u?8u:0u)|(dst>=8u?4u:0u);
        if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0x0fu;page[n++]=0x2au;
        page[n++]=(pl_u8)((memory?0u:0xc0u)|((dst&7u)<<3u)|(memory?7u:src));
        pl_x86_instruction i;pl_x86_vector_integer_float law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_integer_float_lower(&i,&law)
            ||law.source_memory!=memory||law.target!=dst||(!memory&&law.source!=src))return 1;
        pl_u64 bytes=0u;wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes
            ||report.memory_bytes!=(memory?8u:0u)||report.source_instructions!=1u||report.source_bytes!=n||report.flags_written)return 1;
        for(unsigned bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=32u;break;
            case 2:changed.operands[1].bits=128u;break;case 3:changed.visible_operand_count=1u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.status=PL_X86_DECODE_INVALID;break;default:changed.flow=PL_X86_FLOW_FAULT;break;}
            pl_x86_vector_integer_float value,old;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_vector_integer_float_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++bad_forms;
        }
        ++forms;
    }
    unsigned scalar_forms=0u,scalar_bad=0u,work=0u,span=0u;
    for(unsigned input=4u;input<=8u;input+=4u)for(unsigned output=4u;output<=8u;output+=4u){
        _Alignas(8) pl_u8 scratch[24576];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_signed_float_plan(input*8u,output*8u,&arena,&plan))return 1;
        if(plan.node_count>work)work=plan.node_count;
        if(plan.span>span)span=plan.span;
        for(unsigned rc=0u;rc<4u;++rc)for(unsigned sign=0u;sign<2u;++sign){
            pl_u64 args[]={sign?~0ull:1u,rc,0u,0u,0u},out[2];
            if(check_scalar_projection(&plan,args,out,2u)||out[0]!=(output==4u?(sign?0xbf800000u:0x3f800000u):(sign?0xbff0000000000000ull:0x3ff0000000000000ull))||out[1])return 1;}
        for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<17u;++src)for(unsigned p=0u;p<4u;++p){
            unsigned memory=src==16u,n=0u;memset(page,0x90,sizeof page);
            if(p)page[n++]=(pl_u8)(p==1u?0x67u:p==2u?0x64u:0x65u);
            page[n++]=(pl_u8)(output==4u?0xf3u:0xf2u);
            unsigned rex=(input==8u?8u:0u)|(dst>=8u?4u:0u)|(!memory&&src>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
            page[n++]=0x0fu;page[n++]=0x2au;page[n++]=(pl_u8)((memory?0u:0xc0u)|((dst&7u)<<3u)|(memory?7u:src&7u));
            pl_x86_instruction i;pl_x86_vector_integer_float law;
            if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_integer_float_lower(&i,&law)||law.source_class!=PL_X86_REGISTER_GPR
                ||law.source_bytes!=input||law.target_bytes!=output||law.source_memory!=memory||law.target!=dst||(!memory&&law.source!=src))return 1;
            pl_u64 bytes=0u;wasm_cut_report report;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes
                ||report.memory_bytes!=(memory?input:0u)||report.source_instructions!=1u||report.source_bytes!=n||report.flags_written)return 1;
            for(unsigned bad=0u;bad<16u;++bad){pl_x86_instruction changed=i;
                switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=16u;break;case 2:changed.operands[1].bits=128u;break;
                case 3:changed.visible_operand_count=1u;break;case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
                case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;
                case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
                case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 10:changed.status=PL_X86_DECODE_INVALID;break;
                case 11:changed.flow=PL_X86_FLOW_FAULT;break;case 12:changed.source_bytes=0u;break;case 13:--changed.length;break;
                case 14:++changed.fallthrough;break;default:changed.opcode=0u;break;}
                pl_x86_vector_integer_float old,value;memset(&old,0xa5,sizeof old);value=old;
                if(pl_x86_vector_integer_float_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
                arena.used=0u;pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;++scalar_bad;}
            ++scalar_forms;
        }
    }
    page[0]=0xf0u;page[1]=0x0fu;page[2]=0x2au;page[3]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("CVTPI2PS: %u forms/%u malformed; scalar CVTSI2SS/SD: %u forms/%u malformed; SSA upper bound %u/%u; execution separate\n",forms,bad_forms,scalar_forms,scalar_bad,work,span);return 0;
}
