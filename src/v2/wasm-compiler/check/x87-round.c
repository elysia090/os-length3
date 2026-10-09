#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u};unsigned refusals=0u;
    for(unsigned prefix=0u;prefix<6u;++prefix){unsigned n=0u;memset(page,0x90,sizeof page);if(prefixes[prefix])page[n++]=prefixes[prefix];page[n++]=0xd9u;page[n++]=0xfcu;
        pl_x86_instruction i;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_round_supported(&i))return 1;
        pl_u64 bytes=0u;wasm_cut_report report;if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=n||report.memory_bytes||report.flags_written)return 1;
        for(unsigned bad=0u;bad<8u;++bad){pl_x86_instruction changed=i;switch(bad){case 0:changed.machine_argument|=1ull<<63u;break;case 1:changed.visible_operand_count=1u;break;
            case 2:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 3:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 4:changed.opcode=0xd8u;break;
            case 5:++changed.fallthrough;break;case 6:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;default:changed.length=0u;break;}
            if(pl_x86_x87_round_supported(&changed))return 1;
            _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;
        }
    }
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;int s=pl_x86_x87_round_plan(&arena,&plan);
    if(s){printf("FRNDINT plan %d used%llu\n",s,(unsigned long long)arena.used);return 1;}
    const pl_u64 sig[]={0x8000000000000000ull,0xc000000000000000ull,0xa000000000000000ull};const pl_u16 se[]={0x3ffeu,0x3fffu,0x4000u};
    for(unsigned rc=0u;rc<4u;++rc)for(unsigned sign=0u;sign<2u;++sign)for(unsigned row=0u;row<3u;++row){pl_u64 args[]={sig[row],se[row]|(sign<<15u),0u,0u,0x37fu|(rc<<10u),0u},out[3];
        if(check_scalar_plan(&plan,args,out))return 1;
        unsigned base=row==2u?2u:row==1u?1u:0u,increment=rc==0u?row==1u:rc==1u?sign:rc==2u?!sign:0u,value=base+increment;
        pl_u64 expected_sig=value?(pl_u64)value<<(63u-(value>=2u)):0u,expected_se=sign<<15u;if(value)expected_se|=value>=2u?0x4000u:0x3fffu;
        if(out[0]!=expected_sig||out[1]!=expected_se||(out[2]&63u)!=32u)return 1;
    }
    printf("FRNDINT:6 prefix forms/%u malformed,24 exact tie/sign/RC cases; work/span %u/%u; physical observations separate\n",refusals,plan.node_count,plan.span);return 0;
}
