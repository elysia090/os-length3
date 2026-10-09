#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    unsigned forms=0u,refusals=0u,values=0u;
    for(unsigned store=0u;store<2u;++store)for(unsigned prefix=0u;prefix<4u;++prefix)for(unsigned base=0u;base<8u;++base){
        memset(page,0x90,sizeof page);unsigned n=0u;if(prefix&1u)page[n++]=0x66u;if(prefix&2u)page[n++]=0x67u;
        page[n++]=0xdfu;page[n++]=(pl_u8)((store?0x70u:0x60u)|base);if(base==4u)page[n++]=0x24u;page[n++]=0x10u;
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_x87_bcd law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_bcd_lower(&i,&law)||law.store!=store){fprintf(stderr,"BCD decode %u/%u/%u arg=%llx\n",store,prefix,base,(unsigned long long)i.machine_argument);return 1;}
        _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
        if(pl_x86_lower(&i,&arena,&semantic)){fprintf(stderr,"FBLD shared ABI %u/%u\n",prefix,base);return 1;}
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=n||report.memory_bytes!=10u){fprintf(stderr,"FBLD emission %u/%u\n",prefix,base);return 1;}
        for(unsigned bad=0u;bad<8u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument|=1ull<<63u;break;case 1:changed.operands[0].bits=64u;break;
            case 2:changed.opcode=0xd9u;break;case 3:changed.flags|=store?PL_X86_INSTRUCTION_READS_MEMORY:PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.visible_operand_count=2u;break;
            case 6:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;default:++changed.length;break;}
            if(pl_x86_x87_bcd_lower(&changed,&law))return 1;
            arena.used=0u;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;
        }++forms;
    }
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
    if(pl_x86_x87_load_plan(80u,3u,&arena,&plan))return 1;
    const pl_u64 samples[]={0u,1u,9u,10u,99u,100u,9999u,10000u,99999999u,100000000u,999999999999999999ull};
    for(unsigned sign=0u;sign<2u;++sign)for(unsigned sample=0u;sample<sizeof samples/sizeof samples[0];++sample){
        pl_u64 low=0u,high=sign?0x8000u:0u,x=samples[sample];
        for(unsigned digit=0u;digit<18u;++digit){pl_u64 d=x%10u;x/=10u;if(digit<16u)low|=d<<(digit*4u);else high|=d<<((digit-16u)*4u);}
        pl_u64 input[]={low,0x37fu,0u,high,0u},out[3];
        if(check_scalar_projection(&plan,input,out,3u))return 1;
        pl_u64 sig=0u,se=sign?0x8000u:0u;
        if(samples[sample]){unsigned leading=(unsigned)__builtin_clzll(samples[sample]);sig=samples[sample]<<leading;se|=16383u+63u-leading;}
        if(out[0]!=sig||out[1]!=se||out[2]!=(samples[sample]?0u:1ull<<18u)){fprintf(stderr,"FBLD value %u/%u actual=%llx/%llx/%llx\n",sign,sample,(unsigned long long)out[0],(unsigned long long)out[1],(unsigned long long)out[2]);return 1;}
        ++values;
    }
    arena.used=0u;pl_plan stored;int store_status=pl_x86_x87_bcd_store_plan(&arena,&stored);
    if(store_status){fprintf(stderr,"BCD store plan %d arena=%u\n",store_status,arena.used);return 1;}
    if(stored.node_count>PL_X86_X87_BCD_STORE_MAX_NODES)return 1;
    for(unsigned sign=0u;sign<2u;++sign)for(unsigned sample=0u;sample<sizeof samples/sizeof samples[0];++sample){
        pl_u64 sig=0u,se=sign?0x8000u:0u,x=samples[sample],low=0u,high=sign?0x8000u:0u;
        if(x){unsigned leading=(unsigned)__builtin_clzll(x);sig=x<<leading;se|=16383u+63u-leading;}
        for(unsigned digit=0u;digit<18u;++digit){pl_u64 d=x%10u;x/=10u;if(digit<16u)low|=d<<(digit*4u);else high|=d<<((digit-16u)*4u);}
        pl_u64 input[]={sig,se,0x37fu,0u,0u},out[4];if(check_scalar_projection(&stored,input,out,4u))return 1;
        if(out[0]!=low||out[1]!=high||out[2]||out[3]){fprintf(stderr,"BCD store value %u/%u actual=%llx/%llx/%llx/%llx\n",sign,sample,
            (unsigned long long)out[0],(unsigned long long)out[1],(unsigned long long)out[2],(unsigned long long)out[3]);return 1;}
        ++values;
    }
    printf("BCD: %u prefix/address forms, %u malformed; %u exact18-digit/negative-zero models; store graph=%u/%u; physical observations separate\n",forms,refusals,values,stored.node_count,stored.span);return 0;
}
