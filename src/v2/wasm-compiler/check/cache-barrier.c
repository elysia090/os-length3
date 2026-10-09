#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0xf2u,0x64u,0x65u};unsigned forms=0u,refusals=0u;
    pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned op=8u;op<10u;++op)for(unsigned prefix=0u;prefix<7u;++prefix){unsigned n=0u;memset(page,0x90,sizeof page);
        if(prefix)page[n++]=prefixes[prefix];
        page[n++]=0x0fu;page[n++]=(pl_u8)op;
        pl_x86_instruction i;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_cache_barrier_supported(&i)){fprintf(stderr,"cache source op/prefix=%u/%u flow=%u flags=%x arg=%llx\n",op,prefix,i.flow,i.flags,(unsigned long long)i.machine_argument);return 1;}
        pl_u64 bytes;wasm_cut_report report;if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=n
            ||report.memory_bytes||report.written_registers||report.flags_written){fprintf(stderr,"cache emission %u/%u\n",op,prefix);return 1;}
        for(unsigned bad=0u;bad<8u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.flags&=~PL_X86_INSTRUCTION_PRIVILEGED;break;case 1:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
            case 2:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 3:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 4:changed.machine_argument|=1ull<<63u;break;case 5:changed.opcode=6u;break;case 6:changed.visible_operand_count=1u;break;default:++changed.length;break;}
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_cache_barrier_supported(&changed)||pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC){fprintf(stderr,"cache malformed %u/%u/%u\n",op,prefix,bad);return 1;}
            ++refusals;
        }++forms;
    }
    page[0]=0xf0u;page[1]=0x0fu;page[2]=9u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("cache barriers: %u prefix/source forms, %u malformed; synchronous empty CPU-cache action; privilege separate\n",forms,refusals);return 0;
}
