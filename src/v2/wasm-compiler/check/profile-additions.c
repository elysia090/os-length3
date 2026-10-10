#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536],scratch[65536];
typedef struct {pl_u8 prefix,map,opcode,immediate,memory_only;} encoding;
int main(void)
{
    const encoding families[]={
        {0xf2u,0u,0x7cu,0u,0u},{0x66u,0u,0x7cu,0u,0u},{0xf2u,0u,0x7du,0u,0u},{0x66u,0u,0x7du,0u,0u},
        {0xf2u,0u,0xd0u,0u,0u},{0x66u,0u,0xd0u,0u,0u},
        {0x66u,0x3au,0x08u,1u,0u},{0x66u,0x3au,0x09u,1u,0u},{0x66u,0x3au,0x0au,1u,0u},{0x66u,0x3au,0x0bu,1u,0u},
        {0x66u,0x3au,0x40u,1u,0u},{0x66u,0x3au,0x41u,1u,0u},{0xf2u,0u,0x12u,0u,0u},{0x66u,0x38u,0x2au,0u,1u},
        {0x66u,0x3au,0x42u,1u,0u},{0x66u,0x3au,0x60u,1u,0u},{0x66u,0x3au,0x61u,1u,0u},
        {0x66u,0x3au,0x62u,1u,0u},{0x66u,0x3au,0x63u,1u,0u},
        {0xf3u,0u,0x5au,0u,0u},{0xf2u,0u,0x5au,0u,0u},{0u,0u,0x5au,0u,0u},{0x66u,0u,0x5au,0u,0u}};
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};pl_u32 forms=0u,emitted=0u;
    for(pl_u32 family=0u;family<sizeof families/sizeof families[0];++family){const encoding *p=families+family;
        for(pl_u32 target=0u;target<16u;++target)for(pl_u32 source=p->memory_only?16u:0u;source<17u;++source)
        for(pl_u32 immediate=0u;immediate<(p->immediate?256u:1u);++immediate){pl_u32 n=0u,memory=source==16u;
            memset(page,0x90,sizeof page);if(p->prefix)page[n++]=p->prefix;
            pl_u32 rex=(target>=8u?4u:0u)|(!memory&&source>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
            page[n++]=0x0fu;if(p->map)page[n++]=p->map;page[n++]=p->opcode;
            page[n++]=(pl_u8)((memory?0u:0xc0u)|((target&7u)<<3u)|(memory?7u:source&7u));
            if(p->immediate)page[n++]=(pl_u8)immediate;
            pl_x86_instruction i;
            if(pl_x86_decode_profile(&image,map.address,&i)||i.status!=PL_X86_DECODE_VALID||!i.machine_operation){
                printf("decode red family%u target%u source%u imm%u\n",family,target,source,immediate);return 1;}
            pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&i,&arena,&semantic)){printf("semantic red family%u target%u source%u imm%u\n",family,target,source,immediate);return 1;}
            if(target==9u&&(source==9u||source==7u||memory)){pl_u64 size=0u;wasm_cut_report report;
                int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report);
                if(status||!size||report.source_bytes!=n||report.source_instructions!=1u||report.boundary_operation==PL_X86_OPERATION_FAULT){
                    printf("cut red family%u source%u imm%u status%d\n",family,source,immediate,status);return 1;}++emitted;}
            ++forms;
        }
    }
    const pl_u8 trig_opcodes[]={0xfeu,0xffu,0xfbu,0xf2u,0xf0u,0xf1u,0xf9u,0xf3u},prefixes[]={0u,0x66u,0x67u,0x48u};
    for(pl_u32 op=0u;op<8u;++op)for(pl_u32 prefix=0u;prefix<4u;++prefix){pl_u32 n=0u;memset(page,0x90,sizeof page);
        if(prefixes[prefix])page[n++]=prefixes[prefix];
        page[n++]=0xd9u;page[n++]=trig_opcodes[op];pl_x86_instruction i;
        if(pl_x86_decode_profile(&image,map.address,&i))return 1;
        int (*supported)(const pl_x86_instruction *)=op<4u?pl_x86_x87_trig_supported:op==4u?pl_x86_x87_exponential_supported:op==5u?pl_x86_x87_logarithm_supported:
            op==6u?pl_x86_x87_logarithm_one_supported:pl_x86_x87_arctangent_supported;
        if(!supported(&i))return 1;
        pl_u64 size=0u;wasm_cut_report report;int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report);
        if(status||!size||report.source_bytes!=n||report.boundary_operation==PL_X86_OPERATION_FAULT)return 1;
        ++forms;++emitted;
        const pl_u32 bad_flags[]={PL_X86_INSTRUCTION_LOCKED,PL_X86_INSTRUCTION_REPEATED,PL_X86_INSTRUCTION_PRIVILEGED,
            PL_X86_INSTRUCTION_READS_MEMORY,PL_X86_INSTRUCTION_WRITES_MEMORY,PL_X86_INSTRUCTION_TRAP_AFTER};
        for(pl_u32 bit=0u;bit<6u;++bit){pl_x86_instruction bad=i;bad.flags|=bad_flags[bit];if(supported(&bad))return 1;}
        pl_x86_instruction bad=i;bad.machine_argument^=1ull<<16u;if(supported(&bad))return 1;
    }
    printf("profile additions: %u shared C constructors, %u emitted cut/extent checks; numeric/fault execution separate\n",forms,emitted);return 0;
}
