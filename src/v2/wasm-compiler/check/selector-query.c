#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x67u,0x64u,0x65u};unsigned forms=0u,refusals=0u,states=0u,work=0u,span=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned limit=0u;limit<2u;++limit){
    for(unsigned bits=16u;bits<=64u;bits*=2u){_Alignas(8) pl_u8 scratch[24576];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
        if(pl_x86_selector_query_plan(limit,bits,&arena,&pure))return 1;
        if(pure.node_count>work)work=pure.node_count;
        if(pure.span>span)span=pure.span;
        for(unsigned type=0u;type<32u;++type)for(unsigned dpl=0u;dpl<4u;++dpl)for(unsigned cpl=0u;cpl<4u;++cpl)for(unsigned rpl=0u;rpl<4u;++rpl)
        for(unsigned present=0u;present<2u;++present)for(unsigned g=0u;g<2u;++g)for(unsigned available=0u;available<2u;++available){
            pl_u64 descriptor=0x005a12345678bcdeull|((pl_u64)(type|(dpl<<5u)|(present<<7u))<<40u)|((pl_u64)g<<55u);
            descriptor&=~((pl_u64)(0xffu^(type|(dpl<<5u)|(present<<7u)))<<40u);if(!g)descriptor&=~(1ull<<55u);
            pl_u64 old=0xabcdef0123456789ull,args[]={descriptor,available,cpl,rpl,old},out[2];
            unsigned segment=type>>4u,kind=type&15u,mask=limit?0xa04u:0x1a04u;
            unsigned valid=available&&(segment||((mask>>kind)&1u))&&((segment&&(kind&12u)==12u)||(cpl<=dpl&&rpl<=dpl));
            pl_u64 raw=(descriptor&65535u)|((descriptor>>32u)&0xf0000u),expected=limit?(g?(raw<<12u)|4095u:raw):(descriptor>>32u)&0xf0ff00u;
            if(bits==16u)expected=(old&~65535ull)|(expected&65535u);
            if(!valid)expected=old;
            if(check_scalar_projection(&pure,args,out,2u)||out[0]!=expected||out[1]!=valid)return 1;
            ++states;
        }}
        for(unsigned width=2u;width<=8u;width*=2u)for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<17u;++src)for(unsigned p=0u;p<4u;++p){
            unsigned memory=src==16u,n=0u;memset(page,0x90,sizeof page);if(p)page[n++]=prefixes[p];if(width==2u)page[n++]=0x66u;
            unsigned rex=(width==8u?8u:0u)|(dst>=8u?4u:0u)|(!memory&&src>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
            page[n++]=0x0fu;page[n++]=(pl_u8)(limit?3u:2u);page[n++]=(pl_u8)((memory?0u:0xc0u)|((dst&7u)<<3u)|(memory?7u:src&7u));
            pl_x86_instruction i;pl_x86_selector_query law;int decoded=pl_x86_decode_profile(&image,map.address,&i);
            if(decoded||!pl_x86_selector_query_lower(&i,&law)||law.bytes!=width||law.limit!=limit||law.target!=dst||law.source_memory!=memory||(!memory&&law.source!=src)){
                fprintf(stderr,"selector law limit=%u width=%u dst=%u src=%u prefix=%u decode=%d flow=%u flags=%x opcode=%x machine=%u arg=%llx operand=%u/%u regbits=%u/%u\n",
                    limit,width,dst,src,p,decoded,i.flow,i.flags,i.opcode,i.machine_operation,(unsigned long long)i.machine_argument,i.operands[0].bits,i.operands[1].bits,i.operands[0].value.reg.bits,i.operands[1].value.reg.bits);return 1;}
            pl_u64 bytes=0u;wasm_cut_report report;int emitted=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if(emitted||!bytes||report.source_bytes!=n||report.source_instructions!=1u||report.memory_bytes!=(memory?2u:0u)||!report.flags_written){
                fprintf(stderr,"selector emit limit=%u width=%u dst=%u src=%u prefix=%u status=%d\n",limit,width,dst,src,p,emitted);return 1;}
            for(unsigned bad=0u;bad<16u;++bad){pl_x86_instruction changed=i;
                switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=8u;break;case 2:changed.operands[1].bits=128u;break;
                case 3:changed.visible_operand_count=1u;break;case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
                case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
                case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 10:changed.status=PL_X86_DECODE_INVALID;break;case 11:changed.flow=PL_X86_FLOW_JUMP;break;
                case 12:changed.source_bytes=0u;break;case 13:--changed.length;break;case 14:++changed.fallthrough;break;default:changed.opcode=0u;break;}
                pl_x86_selector_query old,value;memset(&old,0xa5,sizeof old);value=old;
                if(pl_x86_selector_query_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
                _Alignas(8) pl_u8 bad_scratch[8192];pl_arena bad_arena={bad_scratch,sizeof bad_scratch,0u};pl_x86_semantic semantic;
                if(pl_x86_lower(&changed,&bad_arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
                ++refusals;
            }++forms;
        }
    }
    page[0]=0xf0u;page[1]=0x0fu;page[2]=2u;page[3]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("LAR/LSL: %u constructors/%u malformed, %u complete long-mode type/privilege/limit models; graph upper bound %u/%u\n",forms,refusals,states,work,span);return 0;
}
