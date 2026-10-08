#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    pl_u32 forms=0u,refusals=0u;
    for(pl_u32 kind=0u;kind<10u;++kind)for(pl_u32 mm=0u;mm<8u;++mm)
    for(pl_u32 gp=0u;gp<(kind<4u?16u:kind==4u?8u:1u);++gp)for(pl_u32 address=0u;address<2u;++address){
        memset(page,0x90,sizeof page);pl_u32 n=0u,memory=kind>=5u,width=kind==0u||kind==1u||kind==7u||kind==8u?4u:8u;
        if(address)page[n++]=0x67u;
        pl_u32 rex=(kind==2u||kind==3u?8u:0u)|(kind<4u&&gp>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0x0fu;page[n++]=(pl_u8)(kind==0u||kind==2u||kind==7u?0x6eu:kind==1u||kind==3u||kind==8u?0x7eu:kind==6u?0x7fu:kind==9u?0xe7u:0x6fu);
        page[n++]=(pl_u8)((memory?0u:0xc0u)|(mm<<3u)|(memory?7u:gp&7u));
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_mmx_transfer law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_mmx_transfer_lower(&i,&law)||law.bytes!=width)return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
            ||report.source_bytes!=n||report.memory_bytes!=(memory?width:0u)||report.source_instructions!=1u||report.flags_written)return 1;
        for(pl_u32 bad=0u;bad<8u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument|=1ull<<63u;break;case 1:changed.visible_operand_count=1u;break;
            case 2:changed.operands[0].kind=PL_X86_OPERAND_NONE;break;case 3:changed.status=PL_X86_DECODE_INVALID;break;
            case 4:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 5:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
            case 6:changed.flow=PL_X86_FLOW_RETURN;break;default:changed.machine_argument^=1ull<<36u;changed.operands[0].bits=8u;break;}
            pl_x86_mmx_transfer out,old;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_mmx_transfer_lower(&changed,&out)||memcmp(&out,&old,sizeof out))return 1;
            ++refusals;
        }
        ++forms;
    }
    printf("MMX transfer: %u native/common lane/address forms, %u unchanged malformed refusals\n",forms,refusals);return 0;
}
